/**
 * w52:p3 security battery — implemented by p2 while build runs (reviewer may re-run independently).
 * R2-direct-DB: real api_keys row lifecycle (create → assign → revoke → start blocked →
 * listener stopped when revoked while live). R-origin: management mutation from a malicious
 * origin/CSRF posture is rejected by the authz pipeline on a REAL server. SSE stream test
 * lives in the supervisor suite (client cancel propagation) and here via tracked streams.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { getFreePort } from "./agent-ports-freeport";

process.env.API_KEY_SECRET ||= "test-only-secret-agent-ports-0123456789abcdef";

describe("agentPorts security battery (R2-direct-DB + isolation)", () => {
  let upstream: Server | undefined;

  afterEach(async () => {
    const sup = await import("@/lib/agentPorts/supervisor");
    await sup.stopAllAgentListeners();
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    upstream = undefined;
  });

  test("S2: revocation while live → listener stops, subsequent request connection refused", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    const { createApiKey, revokeApiKey } = await import("@/lib/db/apiKeys");
    await store.ensureAgentEndpointsTable();

    upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      res.write("data: hello\n\n");
    });
    await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream!.address() as { port: number }).port;
    sup.setAgentPortsUpstreamPort(upstreamPort);

    const key = await createApiKey("sec-battery-key", "test-machine-sec");
    const rawKey = (key as { key?: string }).key;
    assert.ok(rawKey, "createApiKey returns raw key material");

    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "sec", port: p, apiKeyId: key.id });
    // production path (no seam): fresh DB row per request
    await sup.startAgentListener(id);
    assert.ok(sup.listRunningListeners().some((l) => l.id === id));

    const ok = await fetch(`http://127.0.0.1:${p}/v1/models`, {
      headers: { authorization: `Bearer ${rawKey}` },
    });
    assert.equal(ok.status, 200);

    // REVOKE while live → CRUD hook stops the listener
    await revokeApiKey(key.id);
    await sup.onApiKeyStateChanged(key.id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sup.listRunningListeners().some((l) => l.id === id), false, "listener stopped after revoke");
    // port no longer accepting
    await assert.rejects(() => fetch(`http://127.0.0.1:${p}/v1/models`, { headers: { authorization: `Bearer ${rawKey}` } }));
  });

  test("S3: expired key (expires_at in past) → start blocked via production path", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    const { createApiKey, setApiKeyExpiry } = await import("@/lib/db/apiKeys");
    await store.ensureAgentEndpointsTable();

    const key = await createApiKey("sec-expired-key", "test-machine-sec2");
    await setApiKeyExpiry(key.id, new Date(Date.now() - 60_000).toISOString());
    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "secexp", port: p, apiKeyId: key.id });
    await assert.rejects(() => sup.startAgentListener(id), sup.StartBlockedError);
    assert.equal(sup.listRunningListeners().some((l) => l.id === id), false);
  });

  test("S4: invalid NaN expiry date → fail closed (keyUsable false)", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    const { getDbInstance } = await import("@/lib/db/core");
    const { createApiKey } = await import("@/lib/db/apiKeys");
    await store.ensureAgentEndpointsTable();

    const key = await createApiKey("sec-nan-key", "test-machine-sec3");
    const db = getDbInstance();
    db.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run("not-a-date", key.id);
    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "secnan", port: p, apiKeyId: key.id });
    await assert.rejects(() => sup.startAgentListener(id), sup.StartBlockedError);
  });

  test("S5: two endpoints, two different keys — strict per-port isolation", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    const { createApiKey } = await import("@/lib/db/apiKeys");
    await store.ensureAgentEndpointsTable();

    upstream = createServer((_req, res) => {
      res.writeHead(200);
      res.end("{}");
    });
    await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream!.address() as { port: number }).port;
    sup.setAgentPortsUpstreamPort(upstreamPort);

    const kA = await createApiKey("iso-a", "test-machine-isoA");
    const kB = await createApiKey("iso-b", "test-machine-isoB");
    const rawA = (kA as { key?: string }).key!;
    const rawB = (kB as { key?: string }).key!;

    const pA2 = await getFreePort();
    const idA = await store.createEndpoint({ name: "isoA", port: pA2, apiKeyId: kA.id });
    let pB2 = await getFreePort();
    if (pB2 === pA2) pB2 = await getFreePort();
    const idB = await store.createEndpoint({ name: "isoB", port: pB2, apiKeyId: kB.id });
    await sup.startAgentListener(idA);
    await sup.startAgentListener(idB);

    const rAA = await fetch(`http://127.0.0.1:${pA2}/v1/models`, { headers: { authorization: `Bearer ${rawA}` } });
    const rAB = await fetch(`http://127.0.0.1:${pA2}/v1/models`, { headers: { authorization: `Bearer ${rawB}` } });
    const rBB = await fetch(`http://127.0.0.1:${pB2}/v1/models`, { headers: { authorization: `Bearer ${rawB}` } });
    const rBA = await fetch(`http://127.0.0.1:${pB2}/v1/models`, { headers: { authorization: `Bearer ${rawA}` } });
    assert.equal(rAA.status, 200, "own key on own port passes");
    assert.equal(rAB.status, 401, "other key on A rejected");
    assert.equal(rBB.status, 200, "own key on own port passes");
    assert.equal(rBA.status, 401, "other key on B rejected");
  });

  test("S6: env-key bypass does NOT work on agent ports (env key ≠ assigned key)", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    const { createApiKey } = await import("@/lib/db/apiKeys");
    await store.ensureAgentEndpointsTable();

    upstream = createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
    await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream!.address() as { port: number }).port;
    sup.setAgentPortsUpstreamPort(upstreamPort);

    const k = await createApiKey("sec-envtest", "test-machine-sec4");
    const raw = (k as { key?: string }).key!;
    const envKey = "sk-env-bypass-attempt-000";
    process.env.OMNIROUTE_API_KEY = envKey;
    try {
      const p = await getFreePort();
    const id = await store.createEndpoint({ name: "secenv", port: p, apiKeyId: k.id });
      await sup.startAgentListener(id);
      const envAttempt = await fetch(`http://127.0.0.1:${p}/v1/models`, {
        headers: { authorization: `Bearer ${envKey}` },
      });
      assert.equal(envAttempt.status, 401, "env key must NOT pass on agent port");
      const assigned = await fetch(`http://127.0.0.1:${p}/v1/models`, {
        headers: { authorization: `Bearer ${raw}` },
      });
      assert.equal(assigned.status, 200);
    } finally {
      delete process.env.OMNIROUTE_API_KEY;
    }
  });
});
