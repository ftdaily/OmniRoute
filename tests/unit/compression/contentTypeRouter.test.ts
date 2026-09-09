/**
 * TDD for the content-type router (Claw Cortex-inspired, clean-room implementation).
 * Run: node --import tsx/esm --test tests/unit/compression/contentTypeRouter.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectContentType,
  contentTypeApplies,
  resolveContentTypeRouter,
} from "../../../open-sse/services/compression/contentTypeRouter.ts";

describe("detectContentType", () => {
  it("classifies markdown fences as code", () => {
    const r = detectContentType("here is the fix:\n```ts\nconst x = 1;\n```");
    assert.equal(r.contentType, "code");
    assert.ok(r.confidence >= 0.7);
  });

  it("classifies unified diffs as diff", () => {
    const r = detectContentType("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n");
    assert.equal(r.contentType, "diff");
    assert.ok(r.confidence >= 0.7);
  });

  it("classifies JSON objects/arrays as json", () => {
    const r = detectContentType('{"rows": [1, 2, 3], "ok": true}');
    assert.equal(r.contentType, "json");
    assert.ok(r.confidence >= 0.7);
  });

  it("classifies timestamped log runs as log", () => {
    const r = detectContentType(
      "2026-01-01 10:00:00 INFO starting\n2026-01-01 10:00:01 ERROR boom\n2026-01-01 10:00:02 WARN slow\n"
    );
    assert.equal(r.contentType, "log");
    assert.ok(r.confidence >= 0.7);
  });

  it("falls back to text on plain prose (low confidence — never gates)", () => {
    const r = detectContentType("Hello, could you please summarize this paragraph for me?");
    assert.equal(r.contentType, "text");
    assert.ok(r.confidence < 0.7);
  });

  it("falls back to text on empty input", () => {
    const r = detectContentType("   ");
    assert.equal(r.contentType, "text");
  });
});

describe("contentTypeApplies", () => {
  it("rtk applies to log/diff/search but not json/code", () => {
    assert.equal(contentTypeApplies("log", "rtk"), true);
    assert.equal(contentTypeApplies("diff", "rtk"), true);
    assert.equal(contentTypeApplies("search", "rtk"), true);
    assert.equal(contentTypeApplies("json", "rtk"), false);
  });

  it("ionizer/headroom apply to json only; caveman/llmlingua to text only", () => {
    assert.equal(contentTypeApplies("json", "ionizer"), true);
    assert.equal(contentTypeApplies("text", "ionizer"), false);
    assert.equal(contentTypeApplies("json", "headroom"), true);
    assert.equal(contentTypeApplies("text", "caveman"), true);
    assert.equal(contentTypeApplies("json", "caveman"), false);
  });

  it("unknown engines fail open", () => {
    assert.equal(contentTypeApplies("json", "some-future-engine"), true);
    assert.equal(contentTypeApplies("text", "some-future-engine"), true);
  });
});

describe("resolveContentTypeRouter", () => {
  it("returns undefined unless explicitly enabled", () => {
    assert.equal(resolveContentTypeRouter(undefined), undefined);
    assert.equal(resolveContentTypeRouter({}), undefined);
    assert.equal(resolveContentTypeRouter({ contentTypeRouter: { enabled: false } }), undefined);
  });

  it("explicit option wins over config", () => {
    const r = resolveContentTypeRouter({
      contentTypeRouter: { enabled: true },
      config: { contentTypeRouter: { enabled: false } },
    });
    assert.equal(r?.enabled, true);
  });

  it("falls back to config when no explicit option", () => {
    const r = resolveContentTypeRouter({
      config: { contentTypeRouter: { enabled: true } },
    });
    assert.equal(r?.enabled, true);
  });
});
