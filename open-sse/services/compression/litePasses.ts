// Lite passes — per-pass switches + RLE + token-aware tool truncation.
//
// Every lite sub-transformation is one named, independently switchable pass.
// The registry (LITE_PASS_IDS) is the single source of truth consumed by:
// - applyLiteCompression (new `passes` + threshold/token-budget options)
// - the lite engine's config schema (Compression Studio per-engine form)
// - stackedPipelineStepSchema (per-step `{ engine: "lite", config }` overrides)
//
// Safety contract (unchanged from legacy lite): all passes are pure,
// deterministic, fail-open string transforms. Structural engines stay lossless:
// repeated-line runs keep their first line plus a count marker; tool truncation
// keeps a word boundary and appends `...[truncated]`; nothing here summarizes,
// drops, or rewrites semantics.
import type { LitePassId, LitePasses } from "./types.ts";

export type { LitePassId, LitePasses };
export { LITE_PASS_IDS } from "./types.ts";

/**
 * The five legacy passes default ON (pre-existing lite behavior).
 * `repeated-lines` is the new RLE pass and defaults OFF, so existing
 * behavior stays byte-identical unless the operator explicitly enables it
 * (Studio toggle, persisted `repeatedLinesEnabled: true`, or pass switch).
 */
export const LITE_PASS_DEFAULTS: Record<LitePassId, boolean> = {
  whitespace: true,
  "system-dedup": true,
  "tool-truncate": true,
  "redundant-remove": true,
  "image-placeholder": true,
  "repeated-lines": false,
};

export function isLitePassEnabled(
  passes: LitePasses | undefined,
  id: LitePassId,
  defaults: Partial<Record<LitePassId, boolean>> = LITE_PASS_DEFAULTS
): boolean {
  const explicit = passes?.[id];
  if (typeof explicit === "boolean") return explicit;
  const fallback = defaults[id];
  if (typeof fallback === "boolean") return fallback;
  return id !== "repeated-lines";
}

/** RLE: collapse runs of identical consecutive lines (threshold >= 2). */
export const DEFAULT_REPEATED_LINE_THRESHOLD = 3;
export const MIN_REPEATED_LINE_THRESHOLD = 2;
export const MAX_REPEATED_LINE_THRESHOLD = 100;

function clampThreshold(threshold: number | undefined): number {
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    return DEFAULT_REPEATED_LINE_THRESHOLD;
  }
  return Math.min(
    MAX_REPEATED_LINE_THRESHOLD,
    Math.max(MIN_REPEATED_LINE_THRESHOLD, Math.floor(threshold))
  );
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

export function collapseRepeatedLines(
  text: string,
  threshold: number | undefined = DEFAULT_REPEATED_LINE_THRESHOLD
): { text: string; applied: boolean } {
  const minRun = clampThreshold(threshold);
  const lines = text.split("\n");
  const out: string[] = [];
  let applied = false;
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (inFence || !line.trim()) {
      out.push(line);
      i++;
      continue;
    }
    let run = 1;
    while (i + run < lines.length && lines[i + run] === line) run++;
    if (run >= minRun) {
      out.push(line, `[repeated ${run - 1}x]`);
      applied = true;
      i += run;
    } else {
      out.push(line);
      i++;
    }
  }
  return { text: out.join("\n"), applied };
}

/**
 * Token-aware cut: maxToolTokens tokens ≈ maxToolTokens * 4 chars.
 * Char estimate (not exact tokenizer) — truncation is a budget guard, and the
 * exact js-tiktoken encoder is near-quadratic on large inputs (#7847 class).
 */
export const MIN_TOOL_TOKENS = 16;
export const MAX_TOOL_TOKENS = 32768;
export const CHARS_PER_TOOL_TOKEN = 4;

export function toolCharBudget(maxToolTokens: number | undefined): number | null {
  if (maxToolTokens === undefined) return null;
  if (
    typeof maxToolTokens !== "number" ||
    !Number.isFinite(maxToolTokens) ||
    maxToolTokens < MIN_TOOL_TOKENS ||
    maxToolTokens > MAX_TOOL_TOKENS
  ) {
    return null;
  }
  return Math.floor(maxToolTokens) * CHARS_PER_TOOL_TOKEN;
}
