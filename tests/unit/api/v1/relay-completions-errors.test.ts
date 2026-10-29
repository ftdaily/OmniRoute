import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  checkIpRateLimit,
  getClientIp,
  sanitizeForensicHeader,
} from "../../../../src/app/api/v1/relay/chat/completions/relaySecurity.ts";
import { getDbInstance } from "../../../../src/lib/db/core.ts";
import { getRelayLogs } from "../../../../src/lib/db/relayProxies.ts";
import { resetAdaptiveAdmissionRuntimeForTests } from "../../../../open-sse/services/admission/runtime.ts";

// ─── Relay completions route: Bifrost upstream error normalization ──────────
//
// T-issues: (1) a plain-text/HTML non-OK Bifrost response must be normalized
// into a valid OpenAI JSON error instead of leaking raw text (which produces
// client-side "invalid character 'd'" parse failures); (3) upstream 4xx must be
// recorded as analytics "error", never "success".

const ORIGINAL_BIFROST_BASE_URL = process.env.BIFROST_BASE_URL;
const ORIGINAL_BIFROST_API_KEY = process.env.BIFROST_API_KEY;
const ORIGINAL_BIFROST_OMNI_KEY = process.env.OMNIROUTE_BIFROST_KEY;
const ORIGINAL_BIFROST_TIMEOUT = process.env.BIFROST_TIMEOUT_MS;
const ORIGINAL_BIFROST_STREAMING = process.env.BIFROST_STREAMING_ENABLED;
const ORIGINAL_RELAY_BACKEND = process.env.OMNIROUTE_RELAY_BACKEND;
const ORIGINAL_FETCH = globalThis.fetch;

// Warm the route module graph ONCE at load: the first tsx compile+evaluate of
// the relay route takes ~6s and fires background version-check fetches
// (npm/GitHub metadata). Pay that cost here under a network-blocking stub so
// no per-test mock can be stolen or raced by module-init fetches.
globalThis.fetch = async () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
await import("../../../../src/app/api/v1/relay/chat/completions/route.ts?warm=relay-completions-errors");
globalThis.fetch = ORIGINAL_FETCH;

// URL-scoped Bifrost mock: only the Bifrost upstream URL gets the scripted
// status/body; background version/discovery fetches get neutral JSON and can
// never consume or steal the scripted response. Records the Bifrost URL so
// each test asserts the route actually called Bifrost (no false-pass where
// every fetch 404s and the status coincidentally matches).
let lastBifrostUrl: string | null = null;
function mockBifrostFetch(
  status: number,
  body: string,
  contentType: string,
  extraHeaders: Record<string, string> = {}
) {
  const base = process.env.BIFROST_BASE_URL ?? "http://bifrost.test.local:8080";
  lastBifrostUrl = null;
  globalThis.fetch = async (url: unknown) => {
    const u = String(url);
    if (u.startsWith(base)) {
      lastBifrostUrl = u;
      return new Response(body, {
        status,
        headers: { "content-type": contentType, ...extraHeaders },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
function assertBifrostCalled() {
  assert.ok(lastBifrostUrl, "route must call the Bifrost upstream");
  assert.match(lastBifrostUrl!, /\/v1\/chat\/completions$/);
}

function seedRelayToken(rawToken: string) {
  const id = `rl_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const now = Math.floor(Date.now() / 1000);
  getDbInstance()
    .prepare(
      `
      INSERT INTO relay_tokens (id, name, token_hash, token_prefix, description, combo_id,
        allowed_models, max_tokens_per_request, max_requests_per_minute, max_requests_per_day,
        max_cost_per_day, enabled, created_at, updated_at, expires_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `
    )
    .run(
      id,
      "relay-completions-err",
      createHash("sha256").update(rawToken).digest("hex"),
      "rl_test",
      "",
      null,
      JSON.stringify(["*"]),
      128000,
      60,
      10000,
      0,
      now,
      now,
      null,
      "{}"
    );
  return { id, rawToken };
}

function restoreEnv() {
  if (ORIGINAL_BIFROST_BASE_URL === undefined) delete process.env.BIFROST_BASE_URL;
  else process.env.BIFROST_BASE_URL = ORIGINAL_BIFROST_BASE_URL;
  if (ORIGINAL_BIFROST_API_KEY === undefined) delete process.env.BIFROST_API_KEY;
  else process.env.BIFROST_API_KEY = ORIGINAL_BIFROST_API_KEY;
  if (ORIGINAL_BIFROST_OMNI_KEY === undefined) delete process.env.OMNIROUTE_BIFROST_KEY;
  else process.env.OMNIROUTE_BIFROST_KEY = ORIGINAL_BIFROST_OMNI_KEY;
  if (ORIGINAL_BIFROST_TIMEOUT === undefined) delete process.env.BIFROST_TIMEOUT_MS;
  else process.env.BIFROST_TIMEOUT_MS = ORIGINAL_BIFROST_TIMEOUT;
  if (ORIGINAL_BIFROST_STREAMING === undefined) delete process.env.BIFROST_STREAMING_ENABLED;
  else process.env.BIFROST_STREAMING_ENABLED = ORIGINAL_BIFROST_STREAMING;
  if (ORIGINAL_RELAY_BACKEND === undefined) delete process.env.OMNIROUTE_RELAY_BACKEND;
  else process.env.OMNIROUTE_RELAY_BACKEND = ORIGINAL_RELAY_BACKEND;
  globalThis.fetch = ORIGINAL_FETCH;
}

function setupBifrostEnv() {
  process.env.OMNIROUTE_RELAY_BACKEND = "bifrost";
  process.env.BIFROST_BASE_URL = "http://bifrost.test.local:8080";
  process.env.BIFROST_TIMEOUT_MS = "5000";
  delete process.env.BIFROST_API_KEY;
  delete process.env.OMNIROUTE_BIFROST_KEY;
  delete process.env.BIFROST_STREAMING_ENABLED;
}

test("relay route: normalizes plain-text Bifrost 404 into JSON error (Issue #1)", async () => {
  resetAdaptiveAdmissionRuntimeForTests();
  setupBifrostEnv();
  const relayToken = seedRelayToken(`relay_err_${Date.now()}`);

  // Bifrost sidecar returns a raw HTML/plain-text non-OK response — the exact
  // "invalid character 'd'" scenario behind client JSON parse failures.
  // URL-scoped mock: only the Bifrost upstream URL returns the scripted 404;
  // background version/discovery fetches get neutral JSON and cannot steal it.
  mockBifrostFetch(404, "<html><body>404 page not found</body></html>", "text/html");

  const { POST } = await import(
    `../../../../src/app/api/v1/relay/chat/completions/route.ts?case=${Date.now()}-${Math.random()}`
  );

  const req = new Request("http://localhost/api/v1/relay/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${relayToken.rawToken}`,
      "content-type": "application/json",
      "x-request-id": "relay-err-404",
    },
    body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
  });

  const res = await POST(req);
  // Status preserved from upstream (404), but body is valid JSON, not HTML.
  assert.equal(res.status, 404);
  assertBifrostCalled();
  assert.equal(res.headers.get("content-type"), "application/json");
  // The critical fix: the client receives parseable JSON, NOT a raw HTML body
  // (which previously caused "invalid character 'd'" JSON.parse failures).
  const raw = await res.text();
  assert.doesNotMatch(String(raw), /^</, "response body must be JSON, not raw HTML");
  const body = JSON.parse(raw);
  assert.ok(body?.error?.message, "must contain an error message");
  assert.match(String(body?.error?.message), /page not found/);

  restoreEnv();
});

test("relay route: normalizes HTML 502 from Bifrost into JSON error (Issue #1)", async () => {
  setupBifrostEnv();
  const relayToken = seedRelayToken(`relay_err_${Date.now()}`);

  mockBifrostFetch(
    502,
    "<!doctype html><title>502 Bad Gateway</title><pre>invalid character 'd'</pre>",
    "text/html"
  );

  const { POST } = await import(
    `../../../../src/app/api/v1/relay/chat/completions/route.ts?case=${Date.now()}-${Math.random()}`
  );

  const req = new Request("http://localhost/api/v1/relay/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${relayToken.rawToken}`,
      "content-type": "application/json",
      "x-request-id": "relay-err-502",
    },
    body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
  });

  const res = await POST(req);
  assert.equal(res.status, 502);
  assertBifrostCalled();
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = await res.json();
  assert.ok(body?.error?.message);

  // Upstream 4xx/5xx must be recorded as analytics "error" (Issue #3).
  const logs = getRelayLogs(relayToken.id, 10);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, "error");
  assert.equal(logs[0].status_code, 502);

  restoreEnv();
});

test("relay route: strips stale upstream content-length before serializing JSON error body", async () => {
  setupBifrostEnv();
  const relayToken = seedRelayToken(`relay_err_${Date.now()}`);

  // The upstream Response carries an EXPLICIT content-length for its own (HTML)
  // body. Once the route replaces that body with a freshly-serialized JSON error,
  // a stale content-length copied verbatim onto the outgoing Response would
  // mismatch the real byte length of the new body.
  const staleHtml = "<html><body>404 page not found, upstream sidecar unreachable</body></html>";
  mockBifrostFetch(404, staleHtml, "text/html", {
    "content-length": String(Buffer.byteLength(staleHtml)),
    "content-encoding": "gzip",
    "transfer-encoding": "chunked",
  });

  const { POST } = await import(
    `../../../../src/app/api/v1/relay/chat/completions/route.ts?case=${Date.now()}-${Math.random()}`
  );

  const req = new Request("http://localhost/api/v1/relay/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${relayToken.rawToken}`,
      "content-type": "application/json",
      "x-request-id": "relay-err-stale-length",
    },
    body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
  });

  const res = await POST(req);
  assert.equal(res.status, 404);
  assertBifrostCalled();
  assert.equal(
    res.headers.get("content-encoding"),
    null,
    "stale content-encoding must be stripped"
  );
  assert.equal(
    res.headers.get("transfer-encoding"),
    null,
    "stale transfer-encoding must be stripped"
  );

  const raw = await res.text();
  const declaredLength = res.headers.get("content-length");
  if (declaredLength !== null) {
    assert.equal(
      Number(declaredLength),
      Buffer.byteLength(raw),
      "content-length, if present, must match the actual serialized JSON error body"
    );
  }

  restoreEnv();
});

test("relay route: upstream 401 recorded as analytics error not success (Issue #3)", async () => {
  setupBifrostEnv();
  const relayToken = seedRelayToken(`relay_err_${Date.now()}`);

  mockBifrostFetch(401, JSON.stringify({ error: { message: "unauthorized" } }), "application/json");

  const { POST } = await import(
    `../../../../src/app/api/v1/relay/chat/completions/route.ts?case=${Date.now()}-${Math.random()}`
  );

  const req = new Request("http://localhost/api/v1/relay/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${relayToken.rawToken}`,
      "content-type": "application/json",
      "x-request-id": "relay-err-401",
    },
    body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
  });

  const res = await POST(req);
  assert.equal(res.status, 401);
  assertBifrostCalled();

  const logs = getRelayLogs(relayToken.id, 10);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, "error");
  assert.equal(logs[0].status_code, 401);

  restoreEnv();
});
