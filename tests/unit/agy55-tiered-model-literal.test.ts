/**
 * #agy55 — Antigravity CLI/IDE (`agy` / `antigravity`) tiered 5.5 model ids
 * must stay LITERAL on the wire.
 *
 * Root cause (2026-10-04, native MITM capture agy 1.2.16): the upstream
 * backend serves `claude-opus-5-5-{low,medium,high}` and
 * `claude-sonnet-5-5-{low,medium,high}` as DISTINCT models (sent verbatim on
 * the wire, HTTP 200), while the bare `claude-opus-5-5` 404s. The Claude
 * effort-variant normalizer was stripping the tier suffix for these lanes and
 * dispatching the nonexistent bare id.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyClaudeEffortVariant } from "../../open-sse/handlers/chatCore/claudeEffortVariant.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

const OBSERVED_NATIVE_55 = [
  "claude-opus-5-5-low",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-low",
  "claude-sonnet-5-5-medium",
  "claude-sonnet-5-5-high",
] as const;

test("agy/antigravity keep observed native 5.5 tiered ids literal (no strip, no effort rewrite)", () => {
  for (const provider of ["agy", "antigravity"]) {
    for (const model of OBSERVED_NATIVE_55) {
      const body: Record<string, unknown> = { model, messages: [] };
      const result = applyClaudeEffortVariant({
        provider,
        effectiveModel: model,
        body,
        sourceFormat: FORMATS.OPENAI,
      });
      assert.equal(
        result.effectiveModel,
        model,
        `${provider}: effectiveModel must stay literal for ${model}`
      );
      assert.equal(body.model, model, `${provider}: body.model must stay literal for ${model}`);
      assert.equal(
        body.reasoning_effort,
        undefined,
        `${provider}: must not rewrite reasoning_effort for ${model}`
      );
    }
  }
});

test("provider-qualified id stays literal on agy lane", () => {
  const model = "agy/claude-opus-5-5-medium";
  const body: Record<string, unknown> = { model, messages: [] };
  const result = applyClaudeEffortVariant({
    provider: "agy",
    effectiveModel: model,
    body,
    sourceFormat: FORMATS.OPENAI,
  });
  assert.equal(result.effectiveModel, model);
  assert.equal(body.reasoning_effort, undefined);
});

test("direct claude lane still strips the effort suffix (invariant)", () => {
  const body: Record<string, unknown> = { model: "claude-opus-5-5-medium", messages: [] };
  const result = applyClaudeEffortVariant({
    provider: "claude",
    effectiveModel: "claude-opus-5-5-medium",
    body,
    sourceFormat: FORMATS.OPENAI,
  });
  assert.equal(result.effectiveModel, "claude-opus-5-5");
  assert.equal(body.reasoning_effort, "medium");
});

test("legacy no-suffix and gemini ids untouched on agy lane (invariant)", () => {
  for (const model of ["claude-opus-4-6-thinking", "gemini-3.7-flash-high", "claude-opus-5-5"]) {
    const body: Record<string, unknown> = { model, messages: [] };
    const result = applyClaudeEffortVariant({
      provider: "agy",
      effectiveModel: model,
      body,
      sourceFormat: FORMATS.OPENAI,
    });
    assert.equal(result.effectiveModel, model);
    assert.equal(body.reasoning_effort, undefined);
  }
});
