/**
 * Agent Ports — bind-host RED tests.
 * AGENT_PORTS_BIND_HOST: default 127.0.0.1; ONLY 127.0.0.1 | 0.0.0.0 allowed;
 * any other value → fail-closed error at listener start; runtime listener must
 * actually bind the explicit host.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { getFreePort } from "./agent-ports-freeport";

process.env.API_KEY_SECRET ||= "test-only-secret-agent-ports-0123456789abcdef";

describe("agentPorts bind-host (deployment compat)", () => {
  let upstream: Server | undefined;
  const prev = process.env.AGENT_PORTS_BIND_HOST;

  afterEach(async () => {
    const sup = await import("@/lib/agentPorts/supervisor");
    await sup.stopAllAgentListeners();
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    upstream = undefined;
    if (prev === undefined) delete process.env.AGENT_PORTS_BIND_HOST;
    else process.env.AGENT_PORTS_BIND_HOST = prev;
  });

  test("default bind host is 127.0.0.1 (loopback)", async () => {
    const { resolveBindHost } = await import("@/lib/agentPorts/ports");
    delete process.env.AGENT_PORTS_BIND_HOST;
    assert.equal(resolveBindHost(), "127.0.0.1");
  });

  test("explicit 127.0.0.1 and 0.0.0.0 allowed", async () => {
    const { resolveBindHost } = await import("@/lib/agentPorts/ports");
    process.env.AGENT_PORTS_BIND_HOST = "127.0.0.1";
    assert.equal(resolveBindHost(), "127.0.0.1");
    process.env.AGENT_PORTS_BIND_HOST = "0.0.0.0";
    assert.equal(resolveBindHost(), "0.0.0.0");
  });

  test("any other value → fail-closed (padded, wildcard-ish, garbage; empty = default not reject)", async () => {
    const { resolveBindHost } = await import("@/lib/agentPorts/ports");
    // empty string = default (semantics fix)
    process.env.AGENT_PORTS_BIND_HOST = "";
    assert.equal(resolveBindHost(), "127.0.0.1");
    // padded / wrong values reject (no trim)
    for (const bad of [" 0.0.0.0", "0.0.0.0 ", "127.0.0.1\n", "::", "[::]", "192.168.1.5", "localhost", "0.0.0.00"]) {
      process.env.AGENT_PORTS_BIND_HOST = bad;
      assert.throws(() => resolveBindHost(), /AGENT_PORTS_BIND_HOST/, `reject ${JSON.stringify(bad)}`);
    }
  });

  test("runtime listener actually binds the explicit host (0.0.0.0 reachable via non-loopback addr? loopback still works)", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();
    process.env.AGENT_PORTS_BIND_HOST = "0.0.0.0";
    const { getDbInstance } = await import("@/lib/db/core");
    const { createApiKey } = await import("@/lib/db/apiKeys");
    const key = await createApiKey("bindhost-key", "test-machine-bh");
    const raw = (key as { key?: string }).key!;
    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "bh", port: p, apiKeyId: key.id });
    upstream = createServer((_q, r) => { r.writeHead(200); r.end("{}"); });
    await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", r));
    sup.setAgentPortsUpstreamPort((upstream!.address() as { port: number }).port);
    await sup.startAgentListener(id);
    // loopback request works on 0.0.0.0 bind
    const res = await fetch(`http://127.0.0.1:${p}/v1/models`, { headers: { authorization: `Bearer ${raw}` } });
    assert.equal(res.status, 200);
    // verify actual bind address is 0.0.0.0
    assert.equal(sup.getListenerBindHost(id), "0.0.0.0");
  });

  test("bad env → start fails closed, no listener bound, endpoint error status", async () => {
    const store = await import("@/lib/agentPorts/store");
    const sup = await import("@/lib/agentPorts/supervisor");
    await store.ensureAgentEndpointsTable();
    process.env.AGENT_PORTS_BIND_HOST = "192.168.1.5";
    const p = await getFreePort();
    const id = await store.createEndpoint({ name: "bhbad", port: p, apiKeyId: "k-x" });
    await sup.setAgentPortsKeyResolver(async () => ({ id: "k-x", keyHash: createHash("sha256").update("sk-x").digest("hex") }));
    await assert.rejects(() => sup.startAgentListener(id), /AGENT_PORTS_BIND_HOST/);
    assert.equal(sup.listRunningListeners().some((l) => l.id === id), false);
  });
});
