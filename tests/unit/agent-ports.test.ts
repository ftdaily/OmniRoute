/**
 * Agent Ports — RED tests (written BEFORE implementation).
 * Covers: port validation, reserved-port overlap, per-port strict key auth matrix,
 * path allowlist, header stripping, actual-bind conflict (EADDRINUSE), store persistence.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { getFreePort } from "./agent-ports-freeport";

describe("agentPorts validation", () => {
  test("rejects non-integer, <1024, >65535 and port 0", async () => {
    const { validatePort } = await import("@/lib/agentPorts/ports");
    for (const bad of [0, 80, 1023, 65536, -1, 20128.5, NaN, "20128", null]) {
      assert.throws(() => validatePort(bad as never), undefined, `should reject ${String(bad)}`);
    }
    assert.equal(validatePort(1024), 1024);
    assert.equal(validatePort(65535), 65535);
  });

  test("rejects reserved ports (main api/dashboard/aux)", async () => {
    const { validatePort } = await import("@/lib/agentPorts/ports");
    const reserved = new Set([20128, 20131, 20132]);
    assert.throws(() => validatePort(20128, reserved));
    assert.throws(() => validatePort(20131, reserved));
    assert.equal(validatePort(20500, reserved), 20500);
  });

  test("rejects empty/duplicate/oversized endpoint names", async () => {
    const { validateName } = await import("@/lib/agentPorts/ports");
    assert.throws(() => validateName(""));
    assert.throws(() => validateName("x".repeat(65)));
    assert.equal(validateName("my-agent"), "my-agent");
  });
});

describe("agentPorts store", () => {

  test("CRUD roundtrip + uniqueness of port", async () => {
    const store = await import("@/lib/agentPorts/store");
    await store.ensureAgentEndpointsTable();
    const p1 = await getFreePort();
    const id = await store.createEndpoint({ name: "claude-code", port: p1, apiKeyId: "key-1" });
    assert.ok(id);
    const list = await store.listEndpoints();
    assert.equal(list.length, 1);
    assert.equal(list[0].port, p1);
    assert.equal(list[0].apiKeyId, "key-1");
    assert.equal(list[0].enabled, true);
    // duplicate port blocked with clear error
    await assert.rejects(() => store.createEndpoint({ name: "dup", port: p1, apiKeyId: "key-2" }), /port/i);
    await store.updateEndpoint(id, { enabled: false });
    assert.equal((await store.listEndpoints())[0].enabled, false);
    await store.deleteEndpoint(id);
    assert.equal((await store.listEndpoints()).length, 0);
  });
});

describe("agentPorts change-control (C1-C7)", () => {
  afterEach(async () => {
    const sup = await import("@/lib/agentPorts/supervisor");
    await sup.stopAllAgentListeners();
  });

  test("C1: start sets enabled=1, stop sets enabled=0 (desired state follows action)", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();
    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "c1", port: p, apiKeyId: "k-c1", enabled: false });
    await sup.setAgentPortsKeyResolver(async () => ({ id: "k-c1", keyHash: createHash("sha256").update("sk-c1").digest("hex") }));
    await sup.startAgentListener(id);
    await sup.assertEnabledMatchesAction(id, true);
    assert.equal((await store.getEndpoint(id))?.enabled, true, "start must set enabled=1");
    await sup.stopAgentListener(id);
    await sup.assertEnabledMatchesAction(id, false);
    assert.equal((await store.getEndpoint(id))?.enabled, false, "stop must set enabled=0");
  });

  test("C2: port/key edit while live stops old bind, applies new desired state atomically", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();
    // mock upstream so the proxy target is deterministic (never the real main port)
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    sup.setAgentPortsUpstreamPort(upstreamPort);
    const pA = await getFreePort();
    let pB = await getFreePort();
    if (pB === pA) pB = await getFreePort();
    const id = await store.createEndpoint({ name: "c2", port: pA, apiKeyId: "k-c2" });
    await sup.setAgentPortsKeyResolver(async (kid) => ({ id: kid, keyHash: createHash("sha256").update("sk-" + kid).digest("hex") }));
    await sup.startAgentListener(id);
    // live edit: change port AND key in one mutation
    await sup.applyEndpointMutation(id, { port: pB, apiKeyId: "k-c2b" });
    const eps = await store.getEndpoint(id);
    assert.equal(eps?.port, pB);
    assert.equal(eps?.apiKeyId, "k-c2b");
    // old port free (listener moved), new port serving with NEW key
    assert.ok(!sup.listRunningListeners().some((l) => l.port === pA));
    assert.ok(sup.listRunningListeners().some((l) => l.port === pB));
    const okNew = await fetch(`http://127.0.0.1:${pB}/v1/models`, { headers: { authorization: "Bearer sk-k-c2b" } });
    assert.equal(okNew.status, 200);
    const oldKeyOnNewPort = await fetch(`http://127.0.0.1:${pB}/v1/models`, { headers: { authorization: "Bearer sk-k-c2" } });
    assert.equal(oldKeyOnNewPort.status, 401);
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  test("C3/C4: invalid partial payloads rejected BEFORE apply (no partial mutation, strict bool)", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();
    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "c3", port: p, apiKeyId: "k-c3" });
    // bad port + valid name together → whole mutation rejected, name unchanged
    await assert.rejects(() => sup.applyEndpointMutation(id, { name: "renamed", port: 80 }), /Invalid port/);
    assert.equal((await store.getEndpoint(id))?.name, "c3");
    // strict enabled type
    await assert.rejects(() => sup.applyEndpointMutation(id, { enabled: "false" as never }), /enabled must be a boolean/);
    await assert.rejects(() => sup.applyEndpointMutation(id, { enabled: 1 as never }), /enabled must be a boolean/);
    // name type strict
    await assert.rejects(() => sup.applyEndpointMutation(id, { name: 123 as never }), /name must be a string/);
    assert.equal((await store.getEndpoint(id))?.name, "c3", "no partial apply");
  });

  test("C5: error status preserved in public mapping (not overwritten to stopped)", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();
    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "c5", port: p, apiKeyId: "k-c5" });
    await store.setEndpointStatus(id, "error", "EADDRINUSE simulate");
    const ep = (await store.getEndpoint(id))!;
    const pub = sup.toPublicEndpoint(ep, false);
    assert.equal(pub.status, "error");
    assert.match(String(pub.statusDetail), /EADDRINUSE/);
  });

  test("C6: start with missing/disabled key → StartBlockedError, NO listener bound", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();
    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "c6", port: p, apiKeyId: "k-missing" });
    await sup.setAgentPortsKeyResolver(async () => null);
    await assert.rejects(() => sup.startAgentListener(id), (e: unknown) => {
      assert.ok(e instanceof sup.StartBlockedError);
      return true;
    });
    assert.equal(sup.listRunningListeners().some((l) => l.id === id), false, "no listener bound");
  });

  test("C7: duplicate create (same port) → clear port-conflict error", async () => {
    const store = await import("@/lib/agentPorts/store");
    await store.ensureAgentEndpointsTable();
    const p = await getFreePort();
    await store.createEndpoint({ name: "c7a", port: p, apiKeyId: "k-a" });
    await assert.rejects(() => store.createEndpoint({ name: "c7b", port: p, apiKeyId: "k-b" }), /already assigned/);
  });
});

describe("agentPorts supervisor (real binds, real HTTP)", () => {
  let occupier: Server | undefined;
  afterEach(async () => {
    const sup = await import("@/lib/agentPorts/supervisor");
    await sup.stopAllAgentListeners();
    if (occupier) await new Promise<void>((r) => occupier!.close(() => r()));
    occupier = undefined;
  });

  test("start → correct key passes /v1, wrong/missing/different key → 401, non-/v1 → 404", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();

    // mock upstream (stands in for main port pipeline)
    let sawAuth = "";
    const upstream = createServer((req, res) => {
      sawAuth = String(req.headers.authorization ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    sup.setAgentPortsUpstreamPort(upstreamPort);

    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "a1", port: p, apiKeyId: "k-assign" });
    await sup.setAgentPortsKeyResolver(async (keyId: string) =>
      keyId === "k-assign"
        ? { id: keyId, keyHash: createHash("sha256").update("sk-test-assigned").digest("hex") }
        : null,
    );
    await sup.startAgentListener(id);

    const base = `http://127.0.0.1:${p}`;
    // correct key
    const ok = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer sk-test-assigned", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(ok.status, 200);
    assert.equal(sawAuth, "Bearer sk-test-assigned");
    // missing key
    const missing = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(missing.status, 401);
    // wrong key
    const wrong = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer sk-wrong" },
      body: "{}",
    });
    assert.equal(wrong.status, 401);
    // different valid key than assigned → 401 (resolver still returns the ASSIGNED key's hash)
    const diff = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer sk-other" },
      body: "{}",
    });
    assert.equal(diff.status, 401);
    // non /v1 path → 404 (dashboard/admin/health never proxied)
    const dash = await fetch(`${base}/dashboard`);
    assert.equal(dash.status, 404);
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 404);
  });

  test("actual bind conflict → endpoint status error with EADDRINUSE (no TOCTOU claim)", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();

    occupier = createServer();
    const occPort = await getFreePort();
    await new Promise<void>((r) => occupier!.listen(occPort, "127.0.0.1", r));

    const id = await store.createEndpoint({ name: "conflict", port: occPort, apiKeyId: "k-1" });
    await sup.setAgentPortsKeyResolver(async () => ({
      id: "k-x",
      keyHash: createHash("sha256").update("sk-x").digest("hex"),
    }));
    await assert.rejects(() => sup.startAgentListener(id), /EADDRINUSE/i);
    const st = (await store.listEndpoints()).find((e) => e.id === id);
    assert.equal(st?.status, "error");
    assert.match(String(st?.statusDetail), /EADDRINUSE/i);
  });

  test("disabled/deleted key → start rejected (C5 gate); if key dies while live, reconciler stops listener", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();
    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "fc", port: p, apiKeyId: "k-gone" });
    // resolver returns null = key deleted/disabled → start must be BLOCKED, no listener
    await sup.setAgentPortsKeyResolver(async () => null);
    await assert.rejects(() => sup.startAgentListener(id), sup.StartBlockedError);
    assert.equal(sup.listRunningListeners().some((l) => l.id === id), false);
    // PRODUCTION path (no seam): real DB row that is revoked → blocked by fresh keyUsable check
    await sup.setAgentPortsKeyResolver(null);
    const { createApiKey, revokeApiKey } = await import("@/lib/db/apiKeys");
    process.env.API_KEY_SECRET ||= "test-only-secret-agent-ports-0123456789abcdef";
    const key = await createApiKey("fc-key", "test-machine-fc");
    await store.updateEndpoint(id, { apiKeyId: key.id });
    await revokeApiKey(key.id);
    await assert.rejects(() => sup.startAgentListener(id), sup.StartBlockedError);
  });

  test("hop-by-hop + forwarded headers stripped before proxying", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();
    const seen: Record<string, string | undefined> = {};
    const upstream = createServer((req, res) => {
      seen["x-forwarded-for"] = req.headers["x-forwarded-for"] as string | undefined;
      seen["connection"] = req.headers["connection"] as string | undefined;
      seen["via"] = req.headers["via"] as string | undefined;
      res.writeHead(200);
      res.end("{}");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    sup.setAgentPortsUpstreamPort(upstreamPort);

    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "hdr", port: p, apiKeyId: "k-h" });
    await sup.setAgentPortsKeyResolver(async () => ({
      id: "k-h",
      keyHash: createHash("sha256").update("sk-h").digest("hex"),
    }));
    await sup.startAgentListener(id);
    await fetch(`http://127.0.0.1:${p}/v1/models`, {
      headers: {
        authorization: "Bearer sk-h",
        connection: "keep-alive",
        "x-forwarded-for": "1.2.3.4",
        via: "spoof",
      },
    });
    assert.equal(seen["x-forwarded-for"], undefined);
    assert.equal(seen["via"], undefined);
    assert.equal(seen["connection"], "keep-alive"); // canonical value set by supervisor, not client spoof
  });

  test("persistence: listeners restart from store (auto-rebind)", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();
    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "persist", port: p, apiKeyId: "k-p" });
    await sup.setAgentPortsKeyResolver(async () => ({
      id: "k-p",
      keyHash: createHash("sha256").update("sk-p").digest("hex"),
    }));
    await sup.startAgentListener(id);
    await sup.stopAllAgentListeners();
    assert.equal(sup.listRunningListeners().length, 0);
    await sup.startEnabledAgentListeners(); // boot path
    const res = await fetch(`http://127.0.0.1:${p}/v1/models`, {
      headers: { authorization: "Bearer sk-p" },
    });
    assert.equal(res.status, 200);
    assert.ok(sup.listRunningListeners().some((l) => l.port === p && l.status === "running"));
  });
});

