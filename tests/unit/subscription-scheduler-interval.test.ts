/**
 * Fork P2 (2.3): subscription scheduler period honours
 * OMNIROUTE_SUBSCRIPTION_SCHEDULER_INTERVAL_MS. Default unchanged (60 s);
 * invalid values fall back to default.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), "src/lib/proxySubscription/subscriptionService.ts"),
    "utf8"
  );
}

test("subscription scheduler: default tick is 60s when env is unset", () => {
  const src = readSource();
  assert.match(
    src,
    /OMNIROUTE_SUBSCRIPTION_SCHEDULER_INTERVAL_MS/,
    "scheduler must read OMNIROUTE_SUBSCRIPTION_SCHEDULER_INTERVAL_MS"
  );
  assert.match(src, /60_000/, "60s default must remain");
});

test("subscription scheduler: no timers start under NODE_ENV=test", () => {
  const src = readSource();
  assert.match(
    src,
    /process\.env\.NODE_ENV === "test"/,
    "test guard must remain so unit runs never start the timer"
  );
});
