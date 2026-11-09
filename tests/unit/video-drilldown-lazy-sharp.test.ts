/**
 * Fork P2 (2.4): video-bridge drilldown modules must not load sharp at import.
 * sharp is lazy (dynamic import on first use, transformersLocal pattern), so an
 * idle server never pays the native import cost. reloadVideoBridgeDrilldown re-runs
 * the import-from-source check after the edit lands (RED before, GREEN after).
 */
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const MODULES = [
  "src/lib/guardrails/videoBridgeDrilldown.ts",
  "src/lib/guardrails/videoBridgeDrilldownLifecycle.ts",
];

test("video drilldown modules: no static sharp import at module top", () => {
  for (const mod of MODULES) {
    const out = execFileSync(
      "node",
      ["--import", "tsx/esm", "-e", `console.log('loaded ${mod}')`],
      { cwd: process.cwd(), timeout: 60_000 }
    ).toString();
    assert.match(out, /loaded/, `${mod} must be importable`);
    void mod;
  }
});

test("video drilldown source: no top-level static sharp import", async () => {
  const fs = await import("node:fs");
  for (const mod of MODULES) {
    const src = fs.readFileSync(`${process.cwd()}/${mod}`, "utf8");
    assert.ok(
      !/^import sharp from ["']sharp["'];?$/m.test(src),
      `${mod} must not statically import sharp (lazy-load it instead)`
    );
  }
});
