/**
 * Fork P2 (2.5): hook rate-limit map is bounded (cap 500). After firing one
 * event from more than 500 distinct plugins, the map holds at most 500 entries
 * and the newest plugin still rate-limits at 100/window.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  __rateLimitMapSizeForTesting,
  emitHook,
  registerHook,
  resetHooks,
} from "@/lib/plugins/hooks";

test("rateLimitMap: bounded at cap, newest plugin still limited", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  resetHooks();
  try {
    const N = 600;
    for (let i = 0; i < N; i++) {
      registerHook("evt", `p${i}`, () => {});
    }
    await emitHook("evt", {});
    const size = __rateLimitMapSizeForTesting();
    assert.ok(size <= 500, `map holds ${size}, expected <= 500`);
    assert.ok(size > 0, "map must retain recent entries");
    // Newest plugin still rate-limits: 150 emits in one window -> <= 100 calls.
    let calls = 0;
    resetHooks();
    registerHook("evt", "solo", () => {
      calls++;
    });
    for (let i = 0; i < 150; i++) {
      await emitHook("evt", {});
    }
    assert.ok(calls <= 100, `expected <=100 calls, got ${calls}`);
    assert.ok(calls > 0, "limiter must not swallow everything");
  } finally {
    resetHooks();
    t.mock.timers.reset();
  }
});
