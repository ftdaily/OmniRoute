/**
 * Fork P2 (2.3): token health-check interval honours OMNIROUTE_TOKEN_HEALTH_CHECK_INTERVAL_MS.
 * Default unchanged (60 s); invalid values fall back to default.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { registerTokenHealthCheck } from "@/lib/jobs/tokenHealthCheckJob";

interface Captured {
  id: string;
  intervalMs?: number;
}

function capture() {
  const defs: Captured[] = [];
  const registry = {
    register(def: { id: string; intervalMs?: number }) {
      defs.push({ id: def.id, intervalMs: def.intervalMs });
    },
  };
  return { defs, registry };
}

test("token health check: default interval is 60s when env is unset", () => {
  delete process.env.OMNIROUTE_TOKEN_HEALTH_CHECK_INTERVAL_MS;
  const { defs, registry } = capture();
  registerTokenHealthCheck(registry as never);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].id, "token_health_check");
  assert.equal(defs[0].intervalMs, 60_000);
});

test("token health check: env overrides the interval", () => {
  process.env.OMNIROUTE_TOKEN_HEALTH_CHECK_INTERVAL_MS = "300000";
  try {
    const { defs, registry } = capture();
    registerTokenHealthCheck(registry as never);
    assert.equal(defs[0].intervalMs, 300_000);
  } finally {
    delete process.env.OMNIROUTE_TOKEN_HEALTH_CHECK_INTERVAL_MS;
  }
});

test("token health check: invalid env falls back to 60s", () => {
  process.env.OMNIROUTE_TOKEN_HEALTH_CHECK_INTERVAL_MS = "banana";
  try {
    const { defs, registry } = capture();
    registerTokenHealthCheck(registry as never);
    assert.equal(defs[0].intervalMs, 60_000);
  } finally {
    delete process.env.OMNIROUTE_TOKEN_HEALTH_CHECK_INTERVAL_MS;
  }
});
