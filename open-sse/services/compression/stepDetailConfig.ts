// Resolves the persisted per-engine DETAIL sub-object for a stacked-pipeline step.
// Canonical map covers every engine with a durable settings row: lite/headroom/
// sessionDedup/ccr (#8056/#8388) plus relevanceConfig/llmlingua/ionizer/llm and the
// dedicated config blocks (cavemanConfig/rtkConfig/codexResponsesConfig/aggressive/
// ultra/omniglyph). Engines read stepConfig only — buildStepOptions merges the
// sub-object in, so without an entry here a persisted value would never take
// effect at dispatch. stepDetailConfig.ts (frozen at cap by file-size-baseline.json).
import type { CompressionConfig, CompressionPipelineStep } from "./types.ts";

export function resolveStepDetailConfig(
  engine: CompressionPipelineStep["engine"],
  config: CompressionConfig | undefined
) {
  switch (engine) {
    case "lite":
      return config?.lite ?? {};
    case "headroom":
      return config?.headroom ?? {};
    case "session-dedup":
      return config?.sessionDedup ?? {};
    case "ccr":
      return config?.ccr ?? {};
    case "tool-schema":
      return config?.toolSchema ?? {};
    case "relevance":
      return { ...(config?.relevanceConfig ?? {}), ...(config?.relevance ?? {}) };
    case "llmlingua":
      return config?.llmlingua ?? {};
    case "ionizer":
      return config?.ionizer ?? {};
    case "llm":
      return config?.llm ?? {};
    case "caveman":
      return config?.cavemanConfig ?? {};
    case "rtk":
      return config?.rtkConfig ?? {};
    case "codex-responses":
      return config?.codexResponsesConfig ?? {};
    case "aggressive":
      return config?.aggressive ?? {};
    case "ultra":
      return config?.ultra ?? {};
    case "omniglyph":
      return config?.omniglyph ?? {};
    default:
      return {};
  }
}
