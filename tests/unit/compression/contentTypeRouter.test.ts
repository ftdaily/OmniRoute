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
  it("rtk applies to log/diff/search/json/code (structuredTable + code-fence paths)", () => {
    assert.equal(contentTypeApplies("log", "rtk"), true);
    assert.equal(contentTypeApplies("diff", "rtk"), true);
    assert.equal(contentTypeApplies("search", "rtk"), true);
    assert.equal(contentTypeApplies("json", "rtk"), true);
    assert.equal(contentTypeApplies("code", "rtk"), true);
    assert.equal(contentTypeApplies("text", "rtk"), false);
  });

  it("ionizer stays json-only (whole-string JSON.parse; fenced code is a no-op inside)", () => {
    assert.equal(contentTypeApplies("json", "ionizer"), true);
    assert.equal(contentTypeApplies("text", "ionizer"), false);
    assert.equal(contentTypeApplies("code", "ionizer"), false);
  });

  it("headroom applies to json + code (scans ```json fenced blocks)", () => {
    assert.equal(contentTypeApplies("json", "headroom"), true);
    assert.equal(contentTypeApplies("code", "headroom"), true);
    assert.equal(contentTypeApplies("text", "headroom"), false);
  });

  it("caveman/llmlingua apply to text only", () => {
    assert.equal(contentTypeApplies("text", "caveman"), true);
    assert.equal(contentTypeApplies("json", "caveman"), false);
    assert.equal(contentTypeApplies("text", "llmlingua"), true);
    assert.equal(contentTypeApplies("json", "llmlingua"), false);
  });

  it("codex-responses applies to code/diff/log/search (SEARCH_LINE_RE + BUILD_RE)", () => {
    assert.equal(contentTypeApplies("code", "codex-responses"), true);
    assert.equal(contentTypeApplies("diff", "codex-responses"), true);
    assert.equal(contentTypeApplies("log", "codex-responses"), true);
    assert.equal(contentTypeApplies("search", "codex-responses"), true);
    assert.equal(contentTypeApplies("json", "codex-responses"), false);
  });

  it("type-agnostic engines apply everywhere (explicit ALL, not implicit fail-open)", () => {
    for (const engine of [
      "relevance",
      "llm",
      "read-lifecycle",
      "omniglyph",
      "session-dedup",
      "ccr",
      "lite",
      "ultra",
      "aggressive",
    ]) {
      for (const type of ["code", "json", "log", "diff", "search", "text"] as const) {
        assert.equal(contentTypeApplies(type, engine), true, `${engine}/${type}`);
      }
    }
  });

  it("tool-schema stays unmapped (reads body.tools, classifier-blind) → fail-open", () => {
    assert.equal(contentTypeApplies("json", "tool-schema"), true);
    assert.equal(contentTypeApplies("text", "tool-schema"), true);
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
