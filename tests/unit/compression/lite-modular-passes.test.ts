import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LITE_PASS_IDS,
  collapseRepeatedLines,
  isLitePassEnabled,
  type LitePassId,
} from "../../../open-sse/services/compression/litePasses.ts";
import {
  applyLiteCompression,
  compressToolResults,
} from "../../../open-sse/services/compression/lite.ts";
import { liteEngine } from "../../../open-sse/services/compression/engines/cavemanAdapter.ts";
import { liteConfigSchema } from "../../../src/shared/validation/compressionConfigSchemas.ts";

const repeatedFixture = ["alpha", "beta", "beta", "beta", "beta", "gamma"].join("\n");

describe("litePasses.collapseRepeatedLines", () => {
  it("collapses runs >= threshold, keeping the first line plus a count marker", () => {
    const out = collapseRepeatedLines(repeatedFixture, 3);
    assert.ok(out.applied);
    assert.equal(out.text, ["alpha", "beta", "[repeated 3x]", "gamma"].join("\n"));
  });

  it("leaves runs below threshold untouched", () => {
    const out = collapseRepeatedLines("a\nb\nb\nc", 3);
    assert.equal(out.applied, false);
    assert.equal(out.text, "a\nb\nb\nc");
  });

  it("never collapses blank-line runs (whitespace pass owns those)", () => {
    const out = collapseRepeatedLines("a\n\n\n\nb", 2);
    assert.equal(out.applied, false);
    assert.equal(out.text, "a\n\n\n\nb");
  });

  it("skips fenced code blocks so repeated code lines survive verbatim", () => {
    const text = ["```", "x", "x", "x", "x", "```"].join("\n");
    const out = collapseRepeatedLines(text, 2);
    assert.equal(out.applied, false);
    assert.equal(out.text, text);
  });

  it("clamps threshold below 2 up to 2", () => {
    const out = collapseRepeatedLines("a\nb\nb\nc", 0);
    assert.equal(out.applied, true);
    assert.ok(out.text.includes("[repeated 1x]"));
  });
});

describe("lite pass registry", () => {
  it("declares the five legacy passes plus repeated-lines", () => {
    const ids = [...LITE_PASS_IDS] as LitePassId[];
    for (const id of [
      "whitespace",
      "system-dedup",
      "tool-truncate",
      "redundant-remove",
      "image-placeholder",
      "repeated-lines",
    ] as LitePassId[]) {
      assert.ok(ids.includes(id), `missing pass ${id}`);
    }
  });

  it("defaults legacy passes to enabled and repeated-lines to disabled", () => {
    assert.equal(isLitePassEnabled(undefined, "whitespace"), true);
    assert.equal(isLitePassEnabled({}, "repeated-lines"), false);
    assert.equal(isLitePassEnabled({ whitespace: false }, "whitespace"), false);
    assert.equal(isLitePassEnabled({ whitespace: false }, "tool-truncate"), true);
    assert.equal(isLitePassEnabled({ "repeated-lines": true }, "repeated-lines"), true);
  });
});

describe("applyLiteCompression modular passes", () => {
  it("leaves repeated lines untouched by default (opt-in pass, legacy behavior unchanged)", () => {
    const body = { messages: [{ role: "user", content: repeatedFixture }] };
    const result = applyLiteCompression(body);
    const content = (result.body as { messages: Array<{ content: string }> }).messages[0].content;
    assert.ok(!content.includes("[repeated"), "RLE must not run unless enabled");
  });

  it("collapses repeated lines when explicitly enabled via passes", () => {
    const body = { messages: [{ role: "user", content: repeatedFixture }] };
    const result = applyLiteCompression(body, { passes: { "repeated-lines": true } });
    const content = (result.body as { messages: Array<{ content: string }> }).messages[0].content;
    assert.ok(content.includes("[repeated 3x]"));
  });

  it("collapses repeated lines when enabled via repeatedLinesEnabled alias", () => {
    const body = { messages: [{ role: "user", content: repeatedFixture }] };
    const result = applyLiteCompression(body, {
      passes: { "repeated-lines": true },
      repeatedLineThreshold: 3,
    });
    const content = (result.body as { messages: Array<{ content: string }> }).messages[0].content;
    assert.ok(content.includes("[repeated 3x]"));
  });

  it("skips repeated-lines when disabled via passes, keeping other passes active", () => {
    const body = {
      messages: [{ role: "user", content: `${repeatedFixture}\n\n\n\ntail   ` }],
    };
    const result = applyLiteCompression(body, { passes: { "repeated-lines": false } });
    const content = (result.body as { messages: Array<{ content: string }> }).messages[0].content;
    assert.ok(!content.includes("[repeated"), "repeated-lines pass must be off");
    assert.ok(!content.includes("\n\n\n"), "whitespace pass must still run");
    assert.ok(!content.endsWith("   "), "trailing-space trim must still run");
  });

  it("skips whitespace when disabled via passes, with repeated-lines explicitly on", () => {
    const body = { messages: [{ role: "user", content: "a\n\n\n\nb\nb\nb\nb" }] };
    const result = applyLiteCompression(body, {
      passes: { whitespace: false, "repeated-lines": true },
    });
    const content = (result.body as { messages: Array<{ content: string }> }).messages[0].content;
    assert.ok(content.includes("\n\n\n"), "whitespace pass must be off");
    assert.ok(content.includes("[repeated 3x]"), "repeated-lines pass must still run");
  });

  it("honors a custom repeated-line threshold when the pass is enabled", () => {
    const body = { messages: [{ role: "user", content: "a\nb\nb\nc" }] };
    const collapsed = applyLiteCompression(body, {
      passes: { "repeated-lines": true },
      repeatedLineThreshold: 2,
    });
    const kept = applyLiteCompression(body, {
      passes: { "repeated-lines": true },
      repeatedLineThreshold: 3,
    });
    const textOf = (r: typeof collapsed) =>
      (r.body as { messages: Array<{ content: string }> }).messages[0].content;
    assert.ok(textOf(collapsed).includes("[repeated 1x]"));
    assert.ok(!textOf(kept).includes("[repeated"));
  });
});

describe("compressToolResults token budget", () => {
  it("keeps the legacy 2000-char cut when no budget is set", () => {
    const body = { messages: [{ role: "tool", content: "x".repeat(3000) }] };
    const result = compressToolResults(body);
    assert.equal(result.applied, true);
    const content = result.body.messages![0].content as string;
    assert.ok(content.length < 3000 && content.length >= 2000);
  });

  it("cuts at maxToolTokens * 4 chars when a token budget is set", () => {
    const body = { messages: [{ role: "tool", content: "y".repeat(500) }] };
    const result = compressToolResults(body, { maxToolTokens: 50 });
    assert.equal(result.applied, true);
    const content = result.body.messages![0].content as string;
    assert.ok(content.startsWith("y".repeat(200)));
    assert.ok(content.includes("[truncated]"));
  });
});

describe("liteEngine wiring", () => {
  const body = { messages: [{ role: "user", content: repeatedFixture }] };

  it("compress() honors passes from step config", () => {
    const off = liteEngine.compress(body, { passes: { "repeated-lines": false } });
    const legacyDefault = liteEngine.compress(body, {});
    const on = liteEngine.compress(body, { passes: { "repeated-lines": true } });
    assert.ok(
      !String((off.body as { messages: Array<{ content: unknown }> }).messages[0].content).includes(
        "[repeated"
      )
    );
    assert.ok(
      !String(
        (legacyDefault.body as { messages: Array<{ content: unknown }> }).messages[0].content
      ).includes("[repeated"),
      "absent pass switch must leave legacy output untouched"
    );
    assert.ok(
      String((on.body as { messages: Array<{ content: unknown }> }).messages[0].content).includes(
        "[repeated 3x]"
      )
    );
  });

  it("validateConfig accepts the new keys and rejects an out-of-range threshold", () => {
    assert.equal(
      liteEngine.validateConfig({
        compressToolResults: true,
        repeatedLinesEnabled: false,
        repeatedLineThreshold: 5,
        maxToolTokens: 500,
      }).valid,
      true
    );
    const bad = liteEngine.validateConfig({ repeatedLineThreshold: 500 });
    assert.equal(bad.valid, false);
    assert.match(bad.errors.join(" "), /repeatedLineThreshold/);
  });

  it("step config overrides the persisted global (step wins, #8056 pattern)", () => {
    const longRun = { messages: [{ role: "user", content: "a\nb\nb\nc" }] };
    const enable = { compressToolResults: true, passes: { "repeated-lines": true } };
    const off = liteEngine.apply(longRun, {
      config: { lite: { ...enable, repeatedLineThreshold: 2 } },
      stepConfig: { ...enable, repeatedLineThreshold: 3 },
    });
    const on = liteEngine.apply(longRun, {
      config: { lite: { ...enable, repeatedLineThreshold: 3 } },
      stepConfig: { ...enable, repeatedLineThreshold: 2 },
    });
    const textOf = (r: typeof off) =>
      String((r.body as { messages: Array<{ content: unknown }> }).messages[0].content);
    assert.ok(!textOf(off).includes("[repeated"), "step threshold 3 keeps run of 2");
    assert.ok(textOf(on).includes("[repeated 1x]"), "step threshold 2 collapses run of 2");
  });
});

describe("liteConfigSchema", () => {
  it("parses the new optional keys and still rejects unknown keys (strict)", () => {
    const parsed = liteConfigSchema.safeParse({
      compressToolResults: false,
      repeatedLinesEnabled: true,
      repeatedLineThreshold: 4,
      maxToolTokens: 500,
      passes: { whitespace: false },
    });
    assert.equal(parsed.success, true);
    assert.equal(liteConfigSchema.safeParse({ bogus: 1 }).success, false);
  });
});
