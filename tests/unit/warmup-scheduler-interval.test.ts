/**
 * Fork P2 (2.3): warmup scheduler tick honours OMNIROUTE_WARMUP_TICK_INTERVAL_MS.
 * Default unchanged (60 s); invalid values fall back to default.
 * Module-level: only asserts on source wiring (scheduler auto-manages its timer).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), "src/lib/warmupScheduler.ts"),
    "utf8"
  );
}

test("warmup scheduler: tick period reads OMNIROUTE_WARMUP_TICK_INTERVAL_MS with 60s default", () => {
  const src = readSource();
  assert.match(src, /OMNIROUTE_WARMUP_TICK_INTERVAL_MS/);
  assert.match(src, /60_000/);
  assert.match(src, /\.unref\(\)/, "tick timer must stay unref'd");
});
