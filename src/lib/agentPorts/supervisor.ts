/**
 * Agent Ports — listener supervisor.
 * Plain node:http listeners inside the existing server process; registry on
 * globalThis (webpack/standalone chunk singletons). Per-port strict auth:
 * the assigned api_key row is re-read FRESH from SQLite on EVERY request
 * (no Redis/TTL lag), fail-closed 401 when missing/disabled/revoked/expired/
 * banned or when the presented key is not EXACTLY the assigned key.
 * Only literal /v1/* paths are proxied (query preserved, traversal forbidden).
 * Upstream is STRICTLY the local main API port (getRuntimePorts().apiPort);
 * no arbitrary URL config (SSRF-safe). Actual server.listen() is authoritative.
 * Revocation reconciler: ONE bounded unref'd timer + CRUD hook stop listeners
 * on key disable/delete and destroy tracked active upstream streams.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { getDbInstance } from "@/lib/db/core";
import { getRuntimePorts } from "@/lib/runtime/ports";
import { getApiBridgeTimeoutConfig } from "@/shared/utils/runtimeTimeouts";
import { getEndpoint, setEndpointStatus, listEndpoints, updateEndpoint, type AgentEndpoint } from "./store";
import { validateName, validatePort } from "./ports";
import { timingSafeCompare } from "@/shared/utils/timingSafeCompare";

// Shared timeout policy (same as the API bridge server): the agent-port proxy
// adds NO stricter inference ceiling than the normal API lane. Proxy timeout
// follows API_BRIDGE_PROXY_TIMEOUT_MS / REQUEST_TIMEOUT_MS (default 600s);
// server request timeout inherits the bridge's derived value.
const AGENT_PORT_TIMEOUTS = getApiBridgeTimeoutConfig(process.env);

// ---- globalThis singleton registry (never bare module scope) ----
const REGISTRY_KEY = Symbol.for("omniroute.agentPorts");

type UpstreamStream = { clientRes: ServerResponse; upstreamReq: import("node:http").ClientRequest };

type Registry = {
  listeners: Map<string, Server>;
  pendingStarts: Map<string, Promise<void>>;
  activeStreams: Map<string, Set<UpstreamStream>>;
  keyResolver:
    | ((apiKeyId: string) => Promise<{ id: string; keyHash: string | null; key?: string | null } | null>)
    | null;
  upstreamPortOverride: number | null; // test seam ONLY — port number, never a URL
  reconcileTimer: NodeJS.Timeout | null;
};

function reg(): Registry {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = {
      listeners: new Map(),
      pendingStarts: new Map(),
      activeStreams: new Map(),
      keyResolver: null,
      upstreamPortOverride: null,
      reconcileTimer: null,
    } satisfies Registry;
  }
  return g[REGISTRY_KEY] as Registry;
}

/** Test seam: override the api_key_id → (id, keyHash|legacy key) row source. Production uses fresh SQLite. */
export function setAgentPortsKeyResolver(
  resolver: Registry["keyResolver"],
): void {
  reg().keyResolver = resolver;
}

/** Test seam ONLY: point the proxy at this localhost port (a number — arbitrary URLs are rejected by design). */
export function setAgentPortsUpstreamPort(port: number): void {
  reg().upstreamPortOverride = port;
}

export function listRunningListeners(): Array<{ id: string; port: number; status: string }> {
  const out: Array<{ id: string; port: number; status: string }> = [];
  for (const [id, srv] of reg().listeners) {
    const addr = srv.address();
    out.push({
      id,
      port: addr && typeof addr === "object" ? addr.port : -1,
      status: srv.listening ? "running" : "stopped",
    });
  }
  return out;
}

/** Reserved ports (policy: main + conditional bridge/test ports). */
export function reservedAgentPortSet(): Set<number> {
  const { apiPort, dashboardPort } = getRuntimePorts();
  return new Set([apiPort, dashboardPort, 20128, 20129, 20130].filter((p) => p > 0));
}

function upstreamBase(): string {
  const override = reg().upstreamPortOverride;
  const port = override ?? getRuntimePorts().apiPort;
  return `http://127.0.0.1:${port}`;
}

// ---- path handling: literal /v1 only, decode-normalized, traversal forbidden, query preserved ----
export function normalizeProxyTarget(
  rawUrl: string,
): { path: string; search: string } | null {
  let pathname: string;
  let search: string;
  try {
    const u = new URL(rawUrl, "http://localhost");
    pathname = u.pathname;
    search = u.search;
    if (u.username || u.password || u.host !== "localhost") return null; // absolute-form SSRF guard
  } catch {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || /(?:^|\/)\.\.(?:$|\/)/.test(decoded) || decoded.includes("//")) {
    return null;
  }
  if (!(decoded === "/v1" || decoded.startsWith("/v1/"))) return null;
  return { path: decoded, search };
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailer", "transfer-encoding", "upgrade", "host", "via",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-real-ip", "forwarded",
]);

const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key"]);

function buildUpstreamHeaders(req: IncomingMessage, presentedKey: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || CREDENTIAL_HEADERS.has(lower) || value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  // canonical credential: ONLY the validated assigned key, as Bearer (no alternate-channel injection)
  headers["authorization"] = `Bearer ${presentedKey}`;
  headers["connection"] = "keep-alive"; // canonical (stripped client value; node adds its own otherwise)
  return headers;
}

// ---- fresh per-request auth row (no Redis/TTL) ----
type KeyRow = {
  id: string;
  key_hash: string | null;
  key: string | null; // legacy plaintext column — real repo auth falls back to it
  is_active: number;
  revoked_at: string | null;
  expires_at: string | null;
  is_banned: number;
};

function freshAssignedKeyRow(apiKeyId: string): KeyRow | null {
  let db: ReturnType<typeof getDbInstance>;
  try {
    db = getDbInstance();
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(
        `SELECT id, key_hash, key, is_active, revoked_at, expires_at, is_banned
         FROM api_keys WHERE id = ?`,
      )
      .get(apiKeyId) as KeyRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function keyUsable(row: KeyRow): boolean {
  if (!row.is_active) return false;
  if (row.revoked_at) return false;
  if (row.is_banned) return false;
  if (row.expires_at) {
    const t = new Date(row.expires_at).getTime();
    if (!Number.isFinite(t) || t <= Date.now()) return false; // invalid/expired date → fail closed
  }
  return true;
}

function presentedKeyMatches(row: { keyHash: string | null; key?: string | null }, presented: string): boolean {
  if (row.keyHash) return timingSafeCompare(createHash("sha256").update(presented).digest("hex"), row.keyHash);
  if (row.key) return timingSafeCompare(presented, row.key); // legacy plaintext fallback (existing repo auth behavior)
  return false;
}

function extractPresentedKey(req: IncomingMessage): { key: string; ambiguous: boolean } | null {
  const auth = req.headers.authorization;
  const xapi = req.headers["x-api-key"];
  const goog = req.headers["x-goog-api-key"];
  const channels = [auth, xapi, goog].filter((v) => typeof v === "string" && String(v).trim()).length;
  if (channels > 1) return { key: "", ambiguous: true };
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const k = auth.slice(7).trim();
    return k ? { key: k, ambiguous: false } : null;
  }
  if (typeof xapi === "string" && xapi.trim()) return { key: xapi.trim(), ambiguous: false };
  if (typeof goog === "string" && goog.trim()) return { key: goog.trim(), ambiguous: false };
  return null;
}

function sendText(res: ServerResponse, status: number, code: string, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
  }
  res.end(JSON.stringify({ error: { message, code, type: code } }));
}

async function proxyToUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  target: { path: string; search: string },
  presentedKey: string,
  endpointId: string,
): Promise<void> {
  const url = new URL(target.path + target.search, upstreamBase());
  const headers = buildUpstreamHeaders(req, presentedKey);
  const streams = reg().activeStreams.get(endpointId);

  await new Promise<void>((resolve) => {
    const upstreamReq = httpRequest(
      url,
      { method: req.method, headers },
      (upstreamRes) => {
        const respHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (HOP_BY_HOP.has(name.toLowerCase())) continue;
          respHeaders[name] = value as string | string[];
        }
        res.writeHead(upstreamRes.statusCode ?? 502, respHeaders);
        upstreamRes.on("error", () => res.destroy()); // upstream RST → destroy client side, never hang
        upstreamRes.pipe(res);
        upstreamRes.on("end", resolve);
      },
    );
    // bounded by the SHARED bridge policy (proxyTimeoutMs, default 600s) — never a
    // stricter inference ceiling than the normal API lane
    upstreamReq.setTimeout(AGENT_PORT_TIMEOUTS.proxyTimeoutMs, () =>
      upstreamReq.destroy(new Error("upstream idle timeout")),
    );
    upstreamReq.on("error", () => {
      if (!res.headersSent) sendText(res, 502, "UPSTREAM_ERROR", "Upstream request failed");
      else res.destroy();
      resolve();
    });
    const stream: UpstreamStream = { clientRes: res, upstreamReq };
    streams?.add(stream);
    const cleanup = () => {
      streams?.delete(stream);
      resolve();
    };
    res.on("close", () => {
      upstreamReq.destroy(); // client cancel propagation
      cleanup();
    });
    req.pipe(upstreamReq);
  });
}

async function handleAgentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: AgentEndpoint,
): Promise<void> {
  const target = normalizeProxyTarget(req.url ?? "/");
  if (!target) {
    sendText(res, 404, "NOT_FOUND", "Not found (agent ports proxy /v1 only)");
    return;
  }

  const presented = extractPresentedKey(req);
  if (!presented) {
    sendText(res, 401, "UNAUTHORIZED", "Unauthorized: API key required on this agent port");
    return;
  }
  if (presented.ambiguous) {
    sendText(res, 401, "UNAUTHORIZED", "Unauthorized: multiple credential channels (ambiguous)");
    return;
  }

  const r = reg();
  const assigned = r.keyResolver
    ? await r.keyResolver(endpoint.apiKeyId)
    : (() => {
        const row = freshAssignedKeyRow(endpoint.apiKeyId);
        return row ? { id: row.id, keyHash: row.key_hash, key: row.key } : null;
      })();
  if (!assigned) {
    sendText(res, 401, "UNAUTHORIZED", "Unauthorized: assigned API key is unavailable (fail closed)");
    return;
  }
  if (!presentedKeyMatches(assigned, presented.key)) {
    sendText(res, 401, "UNAUTHORIZED", "Unauthorized: this API key is not assigned to this agent port");
    return;
  }
  if (!r.keyResolver) {
    const row = freshAssignedKeyRow(endpoint.apiKeyId);
    if (!row || !keyUsable(row)) {
      sendText(res, 401, "UNAUTHORIZED", "Unauthorized: assigned API key is disabled, revoked, or expired");
      return;
    }
  }

  await proxyToUpstream(req, res, target, presented.key, endpoint.id);
}

// ---- lifecycle ----
export class StartBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartBlockedError";
  }
}

/**
 * Start-time gate (C5): the assigned key must exist AND be usable (fresh row)
 * BEFORE binding — otherwise a start would create a listener that can only 401.
 */
export async function assertEndpointStartable(endpointId: string): Promise<void> {
  const endpoint = await getEndpoint(endpointId);
  if (!endpoint) throw new Error(`Agent endpoint ${endpointId} not found`);
  const r = reg();
  const assigned = r.keyResolver
    ? await r.keyResolver(endpoint.apiKeyId)
    : (() => {
        const row = freshAssignedKeyRow(endpoint.apiKeyId);
        return row ? { id: row.id, keyHash: row.key_hash, key: row.key } : null;
      })();
  if (!assigned) {
    throw new StartBlockedError("Assigned API key does not exist (fix the assignment first)");
  }
  if (!r.keyResolver) {
    const row = freshAssignedKeyRow(endpoint.apiKeyId);
    if (!row || !keyUsable(row)) {
      throw new StartBlockedError("Assigned API key is disabled, revoked, expired, or banned");
    }
  }
}

/** C1: desired-state follows action — persisted so reboot autostart matches the last action. */
export async function assertEnabledMatchesAction(endpointId: string, enabled: boolean): Promise<void> {
  await updateEndpoint(endpointId, { enabled });
}

/**
 * C2/C3/C4/C7: single serialized control mutation. Validates the COMPLETE
 * payload strictly BEFORE any apply (no partial mutation), stops the old
 * listener, persists desired state, restarts if the endpoint remains enabled.
 */
const mutationQueues = globalThis as unknown as Record<symbol, Map<string, Promise<unknown>>>;
const MUTATION_QUEUE_KEY = Symbol.for("omniroute.agentPorts.mutations");

function enqueueMutation<T>(endpointId: string, fn: () => Promise<T>): Promise<T> {
  let queues = mutationQueues[MUTATION_QUEUE_KEY];
  if (!queues) {
    queues = new Map();
    mutationQueues[MUTATION_QUEUE_KEY] = queues;
  }
  const prev = queues.get(endpointId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(endpointId, next.catch(() => {}));
  return next;
}

export type EndpointMutation = {
  name?: unknown;
  port?: unknown;
  apiKeyId?: unknown;
  enabled?: unknown;
};

function validateMutation(m: EndpointMutation): Required<Pick<EndpointMutation, "name" | "port" | "apiKeyId" | "enabled">> | null {
  let saw = false;
  let name: string | undefined;
  let port: number | undefined;
  let apiKeyId: string | undefined;
  let enabled: boolean | undefined;
  if (m.name !== undefined) {
    saw = true;
    if (typeof m.name !== "string") throw new Error("name must be a string");
    name = validateName(m.name);
  }
  if (m.port !== undefined) {
    saw = true;
    if (typeof m.port !== "number" || !Number.isInteger(m.port)) throw new Error("Invalid port");
    port = validatePort(m.port, reservedAgentPortSet());
  }
  if (m.apiKeyId !== undefined) {
    saw = true;
    if (typeof m.apiKeyId !== "string" || !m.apiKeyId.trim()) throw new Error("apiKeyId must be a non-empty string");
    apiKeyId = m.apiKeyId.trim();
  }
  if (m.enabled !== undefined) {
    saw = true;
    if (typeof m.enabled !== "boolean") throw new Error("enabled must be a boolean");
    enabled = m.enabled;
  }
  return saw ? { name, port, apiKeyId, enabled } : null;
}

export async function applyEndpointMutation(endpointId: string, mutation: EndpointMutation): Promise<AgentEndpoint> {
  return enqueueMutation(endpointId, async () => {
    const validated = validateMutation(mutation); // strict validation FIRST (throws → nothing applied)
    const existing = await getEndpoint(endpointId);
    if (!existing) throw new Error(`Agent endpoint ${endpointId} not found`);

    const willBeEnabled = validated?.enabled ?? existing.enabled;
    const wasRunning = reg().listeners.has(endpointId);
    if (wasRunning) await stopAgentListener(endpointId); // C2: old bind + old key must go

    await updateEndpoint(endpointId, (validated ?? {}) as { name?: string; port?: number; apiKeyId?: string; enabled?: boolean });

    if (willBeEnabled) {
      await assertEndpointStartable(endpointId); // C5: fresh key gate before bind
      await startAgentListener(endpointId);
    }
    const updated = await getEndpoint(endpointId);
    if (!updated) throw new Error(`Agent endpoint ${endpointId} not found`);
    return updated;
  });
}

/** C5-public: single source of truth for status mapping — error is NEVER overwritten. */
export function toPublicEndpoint(ep: AgentEndpoint, running: boolean): {
  id: string; name: string; port: number; apiKeyId: string; enabled: boolean;
  status: string; statusDetail: string | null; baseUrl: string; createdAt: string; updatedAt: string;
} {
  let status: string;
  if (ep.status === "error") status = "error"; // preserve actual error + detail
  else if (running) status = "running";
  else status = ep.enabled ? "stopped" : "disabled";
  return {
    id: ep.id,
    name: ep.name,
    port: ep.port,
    apiKeyId: ep.apiKeyId,
    enabled: ep.enabled,
    status,
    statusDetail: ep.statusDetail,
    baseUrl: `http://127.0.0.1:${ep.port}/v1`,
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
  };
}

export async function startAgentListener(endpointId: string): Promise<void> {
  const r = reg();
  const pending = r.pendingStarts.get(endpointId);
  if (pending) return pending; // concurrent start → same promise (no race)

  const run = (async () => {
    if (r.listeners.has(endpointId)) {
      throw new Error(`Agent endpoint ${endpointId} already has a running listener`);
    }
    const endpoint = await getEndpoint(endpointId);
    if (!endpoint) throw new Error(`Agent endpoint ${endpointId} not found`);
    await assertEndpointStartable(endpointId); // C5: pre-bind key gate (fresh row)

    const srv = createServer((req, res) => {
      handleAgentRequest(req, res, endpoint).catch(() => {
        if (!res.headersSent) sendText(res, 500, "HANDLER_ERROR", "Agent port handler failure");
      });
    });
    srv.keepAliveTimeout = AGENT_PORT_TIMEOUTS.serverKeepAliveTimeoutMs;
    srv.requestTimeout = AGENT_PORT_TIMEOUTS.serverRequestTimeoutMs;
    srv.headersTimeout = AGENT_PORT_TIMEOUTS.serverHeadersTimeoutMs;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          srv.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          srv.removeListener("error", onError);
          resolve();
        };
        srv.once("error", onError);
        srv.once("listening", onListening);
        // ACTUAL BIND — authoritative; OS errors (EADDRINUSE/EACCES) surface here
        srv.listen({ port: endpoint.port, host: "127.0.0.1" });
      });
    } catch (err) {
      const msg = err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? ""} ${err.message}`.trim() : String(err);
      await setEndpointStatus(endpointId, "error", msg);
      throw err;
    }

    try {
      const os = await import("node:os");
      const nets = os.networkInterfaces();
      const hasV6 = Object.values(nets).some((arr) => (arr ?? []).some((n) => n.family === "IPv6"));
      await setEndpointStatus(
        endpointId,
        "running",
        hasV6 ? "running (IPv4 loopback bind; IPv6 present on host)" : "running (IPv4 loopback bind)",
      );
    } catch {
      await setEndpointStatus(endpointId, "running", "running");
    }
    r.activeStreams.set(endpointId, new Set());
    r.listeners.set(endpointId, srv);
  })();

  r.pendingStarts.set(endpointId, run);
  try {
    await run;
  } finally {
    r.pendingStarts.delete(endpointId);
  }
}

export async function stopAgentListener(endpointId: string): Promise<void> {
  const r = reg();
  const srv = r.listeners.get(endpointId);
  if (!srv) return;
  r.listeners.delete(endpointId);
  // destroy tracked active upstream streams (SSE included) FIRST
  const streams = r.activeStreams.get(endpointId);
  if (streams) {
    for (const s of streams) {
      s.upstreamReq.destroy();
      s.clientRes.destroy();
    }
    streams.clear();
    r.activeStreams.delete(endpointId);
  }
  // kick keepalives BEFORE awaiting close so close can't hang on active bodies
  srv.closeAllConnections?.();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

export async function stopAllAgentListeners(): Promise<void> {
  const ids = [...reg().listeners.keys()];
  await Promise.all(ids.map((id) => stopAgentListener(id)));
}

export async function startEnabledAgentListeners(): Promise<void> {
  const endpoints = await listEndpoints();
  for (const ep of endpoints) {
    if (!ep.enabled) continue;
    try {
      await startAgentListener(ep.id);
    } catch {
      // start fail recorded as status=error with OS detail (DB keeps desired state)
    }
  }
}

/** Bounded reconcile: ONE unref'd timer. Stops listeners whose key died; never creates listeners. */
export function startAgentPortsReconciler(intervalMs = 30_000): void {
  const r = reg();
  if (r.reconcileTimer) return;
  const tick = async (): Promise<void> => {
    try {
      const endpoints = await listEndpoints();
      for (const ep of endpoints) {
        if (!r.listeners.has(ep.id)) continue;
        const row = freshAssignedKeyRow(ep.apiKeyId);
        if (!row || !keyUsable(row)) {
          await stopAgentListener(ep.id);
          await setEndpointStatus(ep.id, "stopped", "stopped: assigned API key disabled/deleted/revoked (fail closed)");
        }
      }
    } catch {
      // bounded: swallow, next tick retries
    }
    schedule();
  };
  const schedule = () => {
    r.reconcileTimer = setTimeout(tick, intervalMs);
    r.reconcileTimer.unref?.();
  };
  schedule();
}

export function stopAgentPortsReconciler(): void {
  const r = reg();
  if (r.reconcileTimer) {
    clearTimeout(r.reconcileTimer);
    r.reconcileTimer = null;
  }
}

/** CRUD hook: immediately fail-closed affected listeners when a key changes state. */
export async function onApiKeyStateChanged(apiKeyId: string): Promise<void> {
  const r = reg();
  const endpoints = await listEndpoints();
  for (const ep of endpoints) {
    if (ep.apiKeyId !== apiKeyId || !r.listeners.has(ep.id)) continue;
    const row = freshAssignedKeyRow(ep.apiKeyId);
    if (!row || !keyUsable(row)) {
      await stopAgentListener(ep.id);
      await setEndpointStatus(ep.id, "stopped", "stopped: assigned API key disabled/deleted/revoked (fail closed)");
    }
  }
}

/** Boot hook (runtime only — never during build/static phase). */
export async function bootAgentPorts(): Promise<void> {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.OMNIROUTE_BUILD_BACKEND_ONLY === "1") return;
  try {
    await startEnabledAgentListeners();
    startAgentPortsReconciler();
    const n = listRunningListeners().length;
    if (n > 0) console.log(`[STARTUP] Agent Ports: ${n} listener(s) started`);
  } catch (err) {
    console.warn("[AGENT-PORTS] boot skipped:", err instanceof Error ? err.message : err);
  }
}

