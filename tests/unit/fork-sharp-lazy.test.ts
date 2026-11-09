import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const G = (p: string) => readFileSync(join(ROOT, p), "utf8");

// P2-SHARP: every startup-reachable sharp use goes through ONE shared lazy
// loader. No module in the instrumentation graph may import "sharp" at top
// level (static or uncached dynamic), or the .node lands in every boot.
const STARTUP_REACHABLE = [
  "src/lib/guardrails/sharpLoader.ts", // the single loader itself
  "src/lib/guardrails/videoBridgeHelpers.ts",
  "src/lib/guardrails/videoBridgeContactSheet.ts",
  "src/lib/guardrails/videoBridgeDrilldown.ts",
  "src/lib/guardrails/videoBridgeDrilldownLifecycle.ts",
  "src/lib/guardrails/videoBridge.ts",
  "src/lib/guardrails/videoBridgePipeline.ts",
  "src/lib/guardrails/audioBridge.ts",
  "src/lib/guardrails/audioBridgeHelpers.ts",
  "src/lib/guardrails/registry.ts",
];

test("sharp loads lazily through one shared loader, never at module top", () => {
  const loader = G("src/lib/guardrails/sharpLoader.ts");
  assert.ok(loader.includes("loadSharp"), "shared loader must export loadSharp");
  const dynamicSites = (loader.match(/=\s*\(?\s*await\s+import\(|=\s*import\(/g) ?? []).length;
  assert.equal(dynamicSites, 1, `single dynamic import site, found ${dynamicSites}`);
  for (const f of STARTUP_REACHABLE.slice(1)) {
    const body = G(f);
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*")) continue;
      assert.ok(
        !/^import\s+.*from\s+["']sharp["']/.test(t) &&
          !/require\(\s*["']sharp["']\s*\)/.test(t),
        `${f} has a top-level sharp import: ${t.slice(0, 80)}`
      );
    }
    // No private loader copies: every dynamic sharp import lives in sharpLoader.
    assert.ok(
      !/import\(\s*(?:\/\*.*?\*\/\s*)?(?:"sharp"|'sharp'|specifier)/.test(body),
      `${f} has its own dynamic sharp import; use loadSharp from sharpLoader`
    );
    assert.ok(!/function loadSharp|const loadSharp/.test(body), `${f} duplicates loadSharp`);
  }
});
