/**
 * Qoder direct-HTTP service — ported from 9router's qoderModels.js +
 * QoderExecutor.execute() approach. Lets OmniRoute talk to Qoder's
 * COSY-signed inference endpoint directly (api3.qoder.sh) WITHOUT spawning
 * the local qodercli binary. This restores native OpenAI tool-calling
 * (function_calls flow straight through the request body) instead of the
 * CLI-transport's "plain LM reply" restriction.
 *
 * Flow for a PAT (pt-...):
 *   1. Exchange PAT -> short-lived job token (jt-...) at openapi.qoder.sh
 *      (plain JSON POST, cached per-PAT for ~23h).
 *   2. Resolve userId via /api/v1/userinfo (needed for COSY signing).
 *   3. Fetch the live model catalog (/algo/api/v2/model/list, COSY-signed,
 *      cached 1h) — the per-model model_config block must match exactly or
 *      Qoder silently downgrades the model.
 *   4. POST the chat payload to api2.qoder.sh (jt- traffic) or api3.qoder.sh
 *      (dt-/raw), body WAF-encoded (`&Encode=1`), COSY-signed.
 *   5. Unwrap the `{statusCodeValue, body}` SSE envelope back to OpenAI SSE.
 */

import { createHash, randomUUID as cryptoRandomUUID } from "crypto";
import { buildCosyHeaders } from "../shared/qoder/cosy.ts";
import { qoderEncodeBody } from "../shared/qoder/encoding.ts";
import {
  QODER_CHAT_BASE_ALT,
  QODER_CHAT_SIG_PATH,
  QODER_CHAT_URL,
  QODER_CHAT_URL_ENCODED,
  QODER_JOB_TOKEN_EXCHANGE_URL,
  QODER_MODEL_LIST_URL,
  QODER_USERINFO_URL,
} from "../shared/qoder/constants.ts";

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h model catalog TTL

const PAT_PREFIX = "pt-";

// PAT -> job-token cache: job tokens are short-lived (~24h).
const PAT_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const PAT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type PatJobCacheEntry = { accessToken: string; userId: string; expiresAt: number };
const patJobCache = new Map<string, PatJobCacheEntry>();

type CatalogEntry = {
  expiresAt: number;
  models: QoderCatalogModel[];
  rawConfigs: Map<string, Record<string, unknown>>;
};
const catalogCache = new Map<string, CatalogEntry>();
const inflight = new Map<string, Promise<CatalogEntry | null>>();

export type QoderCatalogModel = {
  id: string;
  name: string;
  contextLength: number;
  isVL: boolean;
  isReasoning: boolean;
  maxOutputTokens: number;
  description: string;
};

export function isQoderPat(token: string): boolean {
  return typeof token === "string" && token.startsWith(PAT_PREFIX);
}

type QoderLog = {
  warn?: (comp: string, msg: string) => void;
  error?: (comp: string, msg: string) => void;
};

type ProxyOptions = Record<string, unknown> | null;

/** Exchange a Qoder PAT (pt-...) for a short-lived job token (jt-...). */
async function exchangeJobToken(
  pat: string,
  signal?: AbortSignal | null
): Promise<{ jobToken: string; expiresAt: number }> {
  const res = await fetch(QODER_JOB_TOKEN_EXCHANGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "qodercli/1.0.0",
      "Cosy-Version": "1.0.0",
      "Cosy-ClientType": "5",
    },
    body: JSON.stringify({ personal_token: pat }),
    signal: signal || AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`qoder PAT exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const token = String(data.token || data.job_token || data.jobToken || "").trim();
  if (!token) throw new Error("qoder PAT exchange returned no job token");

  let expiresAt = Date.now() + PAT_DEFAULT_TTL_MS;
  const expiresAtRaw = data.expires_at;
  if (typeof expiresAtRaw === "string") {
    const parsed = Date.parse(expiresAtRaw);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (typeof data.expires_in === "number" && data.expires_in > 0) {
    expiresAt = Date.now() + data.expires_in * 1000;
  }
  return { jobToken: token, expiresAt };
}

/** Resolve the Qoder userId for a job token (needed for COSY signing). */
async function fetchUserIdForJobToken(
  jobToken: string,
  signal?: AbortSignal | null
): Promise<string> {
  try {
    const res = await fetch(QODER_USERINFO_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": "qodercli/1.0.0",
      },
      signal: signal || AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return "";
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return String(data.id || data.userId || data.user_id || "");
  } catch {
    return "";
  }
}

/** Resolve a PAT to a job-token credential, cached per-PAT. */
async function resolvePatCredential(
  pat: string,
  signal?: AbortSignal | null
): Promise<PatJobCacheEntry> {
  const cached = patJobCache.get(pat);
  if (cached && cached.expiresAt - Date.now() > PAT_REFRESH_BUFFER_MS) return cached;

  const { jobToken, expiresAt } = await exchangeJobToken(pat, signal);
  const userId = await fetchUserIdForJobToken(jobToken, signal);
  const resolved = { accessToken: jobToken, userId, expiresAt };
  patJobCache.set(pat, resolved);
  return resolved;
}

/**
 * Resolve connection credentials to COSY-signable form:
 *   - PAT (pt-...) connections -> exchanged to a job token (jt-...) + userId
 *   - everything else -> passed through unchanged
 */
export async function resolveQoderCredentials(
  credentials: Record<string, unknown>,
  signal?: AbortSignal | null
): Promise<Record<string, unknown>> {
  const raw = String(credentials?.apiKey || credentials?.accessToken || "");
  if (isQoderPat(raw)) {
    const resolved = await resolvePatCredential(raw, signal);
    const psd = (credentials?.providerSpecificData as Record<string, unknown>) || {};
    return {
      ...credentials,
      accessToken: resolved.accessToken,
      apiKey: resolved.accessToken,
      providerSpecificData: {
        ...psd,
        authMethod: "pat",
        userId: resolved.userId || String(psd.userId || ""),
        machineId: String(psd.machineId || ""),
      },
    };
  }
  return credentials;
}

/** Stable cache key per credential. */
function cacheKey(credentials: Record<string, unknown>): string {
  const psd = (credentials?.providerSpecificData as Record<string, unknown>) || {};
  const seed = String(
    psd.userId || credentials?.refreshToken || credentials?.accessToken || "anonymous"
  );
  return createHash("sha256").update(`qoder:${seed}`).digest("hex");
}

/** Strip credential -> COSY creds for buildCosyHeaders. */
function cosyCredsFromConnection(credentials: Record<string, unknown>) {
  const psd = (credentials?.providerSpecificData as Record<string, unknown>) || {};
  return {
    userId: String(psd.userId || ""),
    authToken: String(credentials.accessToken || ""),
    name: String(credentials.displayName || ""),
    email: String(credentials.email || ""),
    machineId: String(psd.machineId || ""),
  };
}

/**
 * Fetch the live model list for this credential. Returns
 * `{ models, rawConfigs }` or null on any error.
 */
async function fetchQoderCatalogRaw(
  credentials: Record<string, unknown>,
  signal?: AbortSignal | null
): Promise<{
  models: QoderCatalogModel[];
  rawConfigs: Map<string, Record<string, unknown>>;
} | null> {
  const creds = cosyCredsFromConnection(credentials);
  if (!creds.userId || !creds.authToken) return null;

  // Job-token traffic is rejected by api3 ("Login expired" 403) — serve from api2.
  const modelListUrl = String(creds.authToken).startsWith("jt-")
    ? `${QODER_CHAT_BASE_ALT}/algo/api/v2/model/list`
    : QODER_MODEL_LIST_URL;

  const headers = {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    ...buildCosyHeaders(Buffer.alloc(0), modelListUrl, creds),
  };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  let response: Response;
  try {
    timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        abortListener = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abortListener);
      }
    }
    response = await fetch(modelListUrl, { method: "GET", headers, signal: controller.signal });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }

  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { chat?: unknown[] } | null;
  if (!body || !Array.isArray(body.chat)) return null;

  const models: QoderCatalogModel[] = [];
  const rawConfigs = new Map<string, Record<string, unknown>>();
  for (const entry of body.chat) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const key = String(rec.key || "");
    if (!key) continue;

    // Always cache the config — chat needs model_config even for UI-hidden
    // models (enable:false). Upstream still accepts chat for these keys.
    rawConfigs.set(key, rec);
    if (rec.enable === false) continue;

    const display = String(rec.display_name || key);
    const ctx = Number(rec.max_input_tokens) || 131_072;
    models.push({
      id: key,
      name: display,
      contextLength: ctx,
      isVL: !!rec.is_vl,
      isReasoning: !!rec.is_reasoning,
      maxOutputTokens: Number(rec.max_output_tokens) || 0,
      description: String(rec.description || ""),
    });
  }

  return { models, rawConfigs };
}

/**
 * Resolve the live model catalog + raw configs for a credential. Caches for
 * CACHE_TTL_MS and deduplicates concurrent misses.
 */
export async function resolveQoderModels(
  credentials: Record<string, unknown>,
  options: { signal?: AbortSignal | null; forceRefresh?: boolean; log?: QoderLog } = {}
): Promise<CatalogEntry | null> {
  let resolved: Record<string, unknown>;
  try {
    resolved = await resolveQoderCredentials(credentials, options.signal);
  } catch (error) {
    options.log?.warn?.("QODER", `PAT exchange failed: ${(error as Error).message}`);
    return null;
  }
  if (
    !resolved?.accessToken ||
    !((resolved.providerSpecificData as Record<string, unknown>) || {}).userId
  ) {
    return null;
  }

  const key = cacheKey(resolved);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) return cached;
  }

  const existing = inflight.get(key);
  if (existing && !options.forceRefresh) return existing;

  const fetchPromise = (async () => {
    const fetched = await fetchQoderCatalogRaw(resolved, options.signal);
    if (!fetched) return null;
    const entry: CatalogEntry = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      models: fetched.models,
      rawConfigs: fetched.rawConfigs,
    };
    catalogCache.set(key, entry);
    return entry;
  })();

  inflight.set(key, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    if (inflight.get(key) === fetchPromise) inflight.delete(key);
  }
}

/** Get the cached model_config block for a given model key. */
export async function getQoderModelConfig(
  credentials: Record<string, unknown>,
  modelKey: string,
  options: { signal?: AbortSignal | null; log?: QoderLog } = {}
): Promise<Record<string, unknown> | null> {
  const cached = await resolveQoderModels(credentials, options);
  if (!cached) return null;
  const config = cached.rawConfigs.get(modelKey);
  if (!config) return null;
  return { ...config, key: modelKey };
}

/** Build the exact request body shape Qoder expects. */
export type QoderRequestBody = {
  qoderKey: string;
  payload: Record<string, unknown>;
};

export function buildQoderRequestBody(model: string, body: unknown): QoderRequestBody {
  const qoderKey = String(model || "").replace(/^qoder\//, "");

  const requestBody = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const messages = Array.isArray(requestBody.messages)
    ? (requestBody.messages as Record<string, unknown>[])
    : [];
  const tools = Array.isArray(requestBody.tools) ? requestBody.tools : [];

  // Hoist system messages out (Qoder rejects system in messages).
  const systemParts: string[] = [];
  const outMessages: Record<string, unknown>[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role || "");
    const content = msg.content;
    if (role === "system") {
      const text = extractText(content);
      if (text) systemParts.push(text);
      continue;
    }
    const cloned: Record<string, unknown> = { ...msg };
    cloned.content = extractText(content);
    outMessages.push(cloned);
  }
  const systemText = systemParts.join("\n\n");

  const lastUser = lastUserText(outMessages);
  const maxTokens = resolveMaxTokens(requestBody);

  const sessionId = stableHash("qoder-session", qoderKey);
  const recordId = stableChatRecordId(qoderKey, outMessages, tools, maxTokens);

  return {
    qoderKey,
    payload: {
      request_id: randomUUID(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages: outMessages,
      tools,
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderKey },
          originalContent: lastUser,
        },
        features: [],
        text: lastUser,
      },
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: randomUUID(),
        name: truncate(lastUser, 30),
        begin_at: Date.now(),
      },
    },
  };
}

function randomUUID(): string {
  return crypto.randomUUID();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
        else if (typeof rec.text === "string") parts.push(rec.text);
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function lastUserText(messages: Record<string, unknown>[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

function stableHash(prefix: string, ...parts: (string | number | undefined)[]): string {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function stableChatRecordId(
  model: string,
  messages: Record<string, unknown>[],
  tools: unknown[],
  maxTokens: number
): string {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(String(model));
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) {
      h.update("\0");
      h.update(String(m.role));
    }
    if (typeof m.content === "string" && m.content) {
      h.update("\0");
      h.update(m.content);
    }
  }
  if (tools.length > 0) {
    h.update("\0");
    try {
      h.update(JSON.stringify(tools));
    } catch {
      /* ignore */
    }
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

function resolveMaxTokens(requestBody: Record<string, unknown>): number {
  let maxTokens = 32_768;
  const maxOutputTokens = Number(
    (requestBody.max_tokens as number) || (requestBody.max_completion_tokens as number) || 0
  );
  if (maxOutputTokens > 0 && maxOutputTokens < maxTokens) maxTokens = maxOutputTokens;
  return maxTokens;
}

function truncate(s: string, n: number): string {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Execute a chat request directly against Qoder's COSY-signed endpoint,
 * bypassing the qodercli binary. Returns the raw Response (SSE unwrapped).
 */
export async function executeQoderHttp({
  model,
  body,
  credentials,
  signal,
  log,
}: {
  model: string;
  body: unknown;
  credentials: Record<string, unknown>;
  signal?: AbortSignal | null;
  log?: QoderLog;
}): Promise<{ response: Response; url: string }> {
  // 1. PAT -> job token + userId
  let resolvedCreds = credentials;
  try {
    resolvedCreds = await resolveQoderCredentials(credentials, signal);
  } catch (err) {
    const msg = `qoder PAT exchange failed: ${(err as Error).message}`;
    log?.error?.("QODER", msg);
    return {
      response: new Response(JSON.stringify({ error: { message: msg } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
      url: QODER_CHAT_URL,
    };
  }

  const psd = (resolvedCreds.providerSpecificData as Record<string, unknown>) || {};
  const userId = String(psd.userId || "");
  const accessToken = String(resolvedCreds.accessToken || "");
  if (!userId) {
    const msg = "qoder credential is missing userId; reconnect the account";
    return {
      response: new Response(JSON.stringify({ error: { message: msg } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
      url: QODER_CHAT_URL,
    };
  }
  if (!accessToken) {
    const msg = "qoder credential is missing accessToken; reconnect the account";
    return {
      response: new Response(JSON.stringify({ error: { message: msg } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
      url: QODER_CHAT_URL,
    };
  }

  // 2. Build request body + fetch model_config for the requested model
  let qoderKey: string;
  let payload: Record<string, unknown>;
  try {
    const built = buildQoderRequestBody(model, body);
    qoderKey = built.qoderKey;
    payload = built.payload;
    const modelConfig = await getQoderModelConfig(resolvedCreds, qoderKey, { signal, log });
    if (!modelConfig) {
      throw new Error(
        `qoder: model_config for "${qoderKey}" not yet known (run a model list fetch or check upstream connectivity)`
      );
    }
    payload.model_config = modelConfig;
  } catch (err) {
    const msg = (err as Error).message;
    log?.error?.("QODER", msg);
    return {
      response: new Response(JSON.stringify({ error: { message: msg } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
      url: QODER_CHAT_URL,
    };
  }

  // 3. Encode + COSY sign
  // Job-token (jt-...) traffic must hit api2.qoder.sh — api3 rejects jt-.
  const useAlt = accessToken.startsWith("jt-");
  const url = useAlt
    ? `${QODER_CHAT_BASE_ALT}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
    : QODER_CHAT_URL_ENCODED;

  const plainBody = Buffer.from(JSON.stringify(payload), "utf8");
  const encodedBodyStr = qoderEncodeBody(plainBody);
  const encodedBodyBuf = Buffer.from(encodedBodyStr, "latin1");

  let cosyHeaders: Record<string, string>;
  try {
    cosyHeaders = buildCosyHeaders(encodedBodyBuf, url, {
      userId,
      authToken: accessToken,
      name: String(resolvedCreds.displayName || ""),
      email: String(resolvedCreds.email || ""),
      machineId: String(psd.machineId || ""),
    });
  } catch (err) {
    const msg = `qoder cosy signing failed: ${(err as Error).message}`;
    log?.error?.("QODER", msg);
    return {
      response: new Response(JSON.stringify({ error: { message: msg } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
      url,
    };
  }

  const modelSource =
    (payload.model_config && (payload.model_config as Record<string, unknown>).source) || "system";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Model-Key": qoderKey,
    "X-Model-Source": String(modelSource),
    // gzip triggers signature validation on Qoder's CDN; force identity.
    "Accept-Encoding": "identity",
    ...cosyHeaders,
  };

  // 4. POST
  const connectCtrl = new AbortController();
  const connectTimer = setTimeout(
    () => connectCtrl.abort(new Error("fetch connect timeout")),
    FETCH_TIMEOUT_MS
  );
  const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: encodedBodyBuf,
      signal: mergedSignal,
    });
  } finally {
    clearTimeout(connectTimer);
  }

  // 5. Unwrap SSE envelope
  if (response.ok && response.body) {
    const wrapped = await unwrapQoderEnvelope(response, `qoder/${qoderKey}`);
    return { response: wrapped, url };
  }
  return { response, url };
}

/**
 * Unwrap Qoder's `{statusCodeValue, body}` SSE envelope into plain OpenAI SSE,
 * detecting upstream billing/error blocks inside HTTP-200 envelopes.
 */
async function unwrapQoderEnvelope(response: Response, model: string): Promise<Response> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneEmitted = false;

  const encoder = new TextEncoder();
  const sse = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  const processLine = (line: string, controller: ReadableStreamDefaultController<Uint8Array>) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed || !trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";
    if (statusVal !== 200) {
      const msg = inner || `upstream status ${statusVal}`;
      const errChunk = {
        id: `qoder-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` },
            finish_reason: "stop",
          },
        ],
      };
      controller.enqueue(sse(errChunk));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }
    if (!inner) return;
    if (inner === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }
    // Strip embedded newlines so the SSE frame stays a single event.
    const sanitized = inner.replace(/\r?\n/g, "");
    controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            processLine(line, controller);
            if (doneEmitted) {
              await reader.cancel().catch(() => {});
              controller.close();
              return;
            }
          }
        }
        if (buffer.length > 0) processLine(buffer, controller);
        if (!doneEmitted) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      } catch {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
