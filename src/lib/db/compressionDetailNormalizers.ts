// Normalizers for the compression engine DETAIL settings sub-objects that persist to a
// single key_value row each (settings.sessionDedup / settings.ccr). Extracted out of
// src/lib/db/compression.ts (frozen at cap by file-size-baseline.json — see
// scripts/check/check-file-size.mjs) rather than growing that file inline.
//
// #8388: session-dedup and ccr detail fields (minBlockChars/fuzzy, minChars/
// retrievalRampFactor) were editable on the EngineConfigPage detail form but had no
// persisted sub-object — mirrors the #8056 headroom/minRows fix (normalizeHeadroomConfig
// in compression.ts), extended to the two engines #8056 left uncovered.
import {
  DEFAULT_CCR_CONFIG,
  DEFAULT_IONIZER_CONFIG,
  DEFAULT_LLM_COMPRESSOR_CONFIG,
  DEFAULT_LLMLINGUA_CONFIG,
  DEFAULT_RELEVANCE_CONFIG,
  DEFAULT_SESSION_DEDUP_CONFIG,
  DEFAULT_TOOL_SCHEMA_CONFIG,
  LITE_PASS_IDS,
  type CcrConfig,
  type CompressionConfig,
  type IonizerConfig,
  type LiteConfig,
  type LitePasses,
  type LlmCompressorConfig,
  type LlmlinguaConfig,
  type RelevanceConfig,
  type SessionDedupConfig,
  type ToolSchemaConfig,
} from "@omniroute/open-sse/services/compression/types.ts";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function boundedDescChars(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(2000, Math.max(10, Math.floor(value)));
}

/** Matches SESSION_DEDUP_SCHEMA bounds (engines/session-dedup/index.ts). */
export function normalizeSessionDedupConfig(value: unknown): SessionDedupConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_SESSION_DEDUP_CONFIG,
    minBlockChars: boundedInt(
      record.minBlockChars,
      DEFAULT_SESSION_DEDUP_CONFIG.minBlockChars,
      1,
      100000
    ),
    fuzzy: typeof record.fuzzy === "boolean" ? record.fuzzy : DEFAULT_SESSION_DEDUP_CONFIG.fuzzy,
  };
}

/** Matches CCR_SCHEMA bounds (engines/ccr/index.ts). */
export function normalizeCcrConfig(value: unknown): CcrConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_CCR_CONFIG,
    minChars: boundedInt(record.minChars, DEFAULT_CCR_CONFIG.minChars, 100, 1_000_000),
    retrievalRampFactor: boundedInt(
      record.retrievalRampFactor,
      DEFAULT_CCR_CONFIG.retrievalRampFactor,
      1,
      100
    ),
  };
}

/** Matches LITE_SCHEMA bounds (engines/cavemanAdapter.ts liteEngine). Absent
 *  repeatedLinesEnabled / passes.repeated-lines means OFF (legacy default). */
export function normalizeLiteSubobject(value: unknown): LiteConfig {
  const record = toRecord(value);
  const passesRaw = toRecord(record.passes);
  const passes: LitePasses = {};
  for (const id of LITE_PASS_IDS) {
    const v = passesRaw[id];
    if (typeof v === "boolean") passes[id] = v;
  }
  const rawMaxTokens = record.maxToolTokens;
  return {
    compressToolResults: record.compressToolResults !== false,
    ...(Object.keys(passes).length > 0 ? { passes } : {}),
    ...(typeof record.repeatedLinesEnabled === "boolean"
      ? { repeatedLinesEnabled: record.repeatedLinesEnabled }
      : {}),
    ...(typeof record.repeatedLineThreshold === "number" &&
    Number.isFinite(record.repeatedLineThreshold)
      ? {
          repeatedLineThreshold: Math.min(
            100,
            Math.max(2, Math.floor(record.repeatedLineThreshold))
          ),
        }
      : {}),
    ...(typeof rawMaxTokens === "number" && Number.isFinite(rawMaxTokens) && rawMaxTokens > 0
      ? { maxToolTokens: Math.min(32768, Math.max(16, Math.floor(rawMaxTokens))) }
      : {}),
  };
}

/** Default sub-objects spread into getCompressionSettings' seed config. */
export function buildDetailConfigDefaults(): Pick<
  CompressionConfig,
  "sessionDedup" | "ccr" | "toolSchema" | "relevance"
> {
  return {
    sessionDedup: normalizeSessionDedupConfig(undefined),
    ccr: normalizeCcrConfig(undefined),
    toolSchema: normalizeToolSchemaConfig(undefined),
    relevance: normalizeRelevanceConfig(undefined),
  };
}

/** Matches RELEVANCE_SCHEMA bounds (engines/relevance/configSchema.ts). */
export function normalizeRelevanceConfig(value: unknown): RelevanceConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_RELEVANCE_CONFIG,
    overlapThreshold: boundedRate(
      record.overlapThreshold,
      DEFAULT_RELEVANCE_CONFIG.overlapThreshold,
      0,
      1
    ),
    budgetPercent: boundedRate(record.budgetPercent, DEFAULT_RELEVANCE_CONFIG.budgetPercent, 0, 1),
    boilerplateWeight: boundedRate(
      record.boilerplateWeight,
      DEFAULT_RELEVANCE_CONFIG.boilerplateWeight,
      0,
      1
    ),
  };
}

/** Matches LLMLINGUA_SCHEMA bounds (engines/llmlingua/index.ts). */
export function normalizeLlmlinguaConfig(value: unknown): LlmlinguaConfig {
  const record = toRecord(value);
  const model =
    typeof record.model === "string" && record.model.trim()
      ? record.model.trim()
      : DEFAULT_LLMLINGUA_CONFIG.model;
  const modelPath = typeof record.modelPath === "string" ? record.modelPath : "";
  return {
    ...DEFAULT_LLMLINGUA_CONFIG,
    model,
    minTokens: boundedInt(record.minTokens, DEFAULT_LLMLINGUA_CONFIG.minTokens, 0, 100000),
    compressionRate: boundedRate(
      record.compressionRate,
      DEFAULT_LLMLINGUA_CONFIG.compressionRate,
      0.1,
      0.9
    ),
    modelPath,
  };
}

/** Matches IONIZER_SCHEMA bounds (engines/ionizer/index.ts). */
export function normalizeIonizerConfig(value: unknown): IonizerConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_IONIZER_CONFIG,
    threshold: boundedInt(record.threshold, DEFAULT_IONIZER_CONFIG.threshold, 2, 1000000),
    targetRows: boundedInt(record.targetRows, DEFAULT_IONIZER_CONFIG.targetRows, 1, 100000),
  };
}

/** Matches LLM_COMPRESSOR_SCHEMA bounds (engines/llm/index.ts). */
export function normalizeLlmCompressorConfig(value: unknown): LlmCompressorConfig {
  const record = toRecord(value);
  const model = typeof record.model === "string" ? record.model : "";
  return {
    ...DEFAULT_LLM_COMPRESSOR_CONFIG,
    model,
    minTokens: boundedInt(record.minTokens, DEFAULT_LLM_COMPRESSOR_CONFIG.minTokens, 0, 100000),
    compressionRate: boundedRate(
      record.compressionRate,
      DEFAULT_LLM_COMPRESSOR_CONFIG.compressionRate,
      0.1,
      0.9
    ),
  };
}

/** Default sub-objects spread into getCompressionSettings' seed config. */
export function buildDetailConfigDefaults(): Pick<
  CompressionConfig,
  "sessionDedup" | "ccr" | "toolSchema" | "relevance" | "relevanceConfig" | "llmlingua" | "ionizer" | "llm"
> {
  return {
    sessionDedup: normalizeSessionDedupConfig(undefined),
    ccr: normalizeCcrConfig(undefined),
    toolSchema: normalizeToolSchemaConfig(undefined),
    relevance: normalizeRelevanceConfig(undefined),
    relevanceConfig: normalizeRelevanceConfig(undefined),
    llmlingua: normalizeLlmlinguaConfig(undefined),
    ionizer: normalizeIonizerConfig(undefined),
    llm: normalizeLlmCompressorConfig(undefined),
  };
}

/** Applies a stored detail row onto config during getCompressionSettings' row scan. */
export function applyDetailConfigUpdate(
  config: CompressionConfig,
  key:
    | "sessionDedup"
    | "ccr"
    | "toolSchema"
    | "relevance"
    | "relevanceConfig"
    | "llmlingua"
    | "ionizer"
    | "llm",
  parsed: unknown
): void {
  if (key === "sessionDedup") config.sessionDedup = normalizeSessionDedupConfig(parsed);
  else if (key === "toolSchema") config.toolSchema = normalizeToolSchemaConfig(parsed);
  else if (key === "ccr") config.ccr = normalizeCcrConfig(parsed);
  else if (key === "relevanceConfig") config.relevanceConfig = normalizeRelevanceConfig(parsed);
  else if (key === "llmlingua") config.llmlingua = normalizeLlmlinguaConfig(parsed);
  else if (key === "ionizer") config.ionizer = normalizeIonizerConfig(parsed);
  else if (key === "llm") config.llm = normalizeLlmCompressorConfig(parsed);
  else config.relevance = normalizeRelevanceConfig(parsed);
}

/** Matches TOOL_SCHEMA_SCHEMA bounds (engines/tool-schema/index.ts). */
export function normalizeToolSchemaConfig(value: unknown): ToolSchemaConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_TOOL_SCHEMA_CONFIG,
    maxDescriptionChars: boundedDescChars(
      record.maxDescriptionChars,
      DEFAULT_TOOL_SCHEMA_CONFIG.maxDescriptionChars
    ),
    dropExamples:
      typeof record.dropExamples === "boolean"
        ? record.dropExamples
        : DEFAULT_TOOL_SCHEMA_CONFIG.dropExamples,
    dropVendorExtensions:
      typeof record.dropVendorExtensions === "boolean"
        ? record.dropVendorExtensions
        : DEFAULT_TOOL_SCHEMA_CONFIG.dropVendorExtensions,
  };
}

/** Matches RELEVANCE_SCHEMA bounds (engines/relevance/configSchema.ts).
 *  scorer falls back to "jaccard" so legacy/unknown values keep the old behavior. */
export function normalizeRelevanceConfig(value: unknown): RelevanceConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_RELEVANCE_CONFIG,
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : DEFAULT_RELEVANCE_CONFIG.enabled,
    overlapThreshold: boundedNumber(
      record.overlapThreshold,
      DEFAULT_RELEVANCE_CONFIG.overlapThreshold!,
      0,
      1
    ),
    budgetPercent: boundedNumber(
      record.budgetPercent,
      DEFAULT_RELEVANCE_CONFIG.budgetPercent!,
      0.1,
      1
    ),
    boilerplateWeight: boundedNumber(
      record.boilerplateWeight,
      DEFAULT_RELEVANCE_CONFIG.boilerplateWeight!,
      0,
      1
    ),
    scorer: record.scorer === "bm25" ? "bm25" : "jaccard",
    bm25K1: boundedNumber(record.bm25K1, DEFAULT_RELEVANCE_CONFIG.bm25K1!, 0.1, 3),
    bm25B: boundedNumber(record.bm25B, DEFAULT_RELEVANCE_CONFIG.bm25B!, 0, 1),
  };
}
