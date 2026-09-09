import type { EngineConfigField, EngineValidationResult } from "../types.ts";
import type { RelevanceConfig } from "../../types.ts";
import { DEFAULT_RELEVANCE_CONFIG } from "../../types.ts";

export const RELEVANCE_SCHEMA: EngineConfigField[] = [
  {
    key: "enabled",
    type: "boolean",
    label: "Enabled",
    defaultValue: false,
  },
  {
    key: "overlapThreshold",
    type: "number",
    label: "Overlap threshold",
    description: "Sentences with Jaccard overlap below this are candidates for removal.",
    defaultValue: 0.1,
    min: 0,
    max: 1,
  },
  {
    key: "budgetPercent",
    type: "number",
    label: "Budget percent",
    description: "Target fraction of original character count to retain (0–1).",
    defaultValue: 0.5,
    min: 0.1,
    max: 1,
  },
  {
    key: "boilerplateWeight",
    type: "number",
    label: "Boilerplate weight",
    description: "Weight applied to boilerplate penalty when scoring sentences.",
    defaultValue: DEFAULT_RELEVANCE_CONFIG.boilerplateWeight,
    min: 0,
    max: 1,
  },
  {
    key: "scorer",
    type: "select",
    label: "Scorer",
    description: "jaccard (legacy overlap) or bm25 (dep-free BM25, normalized to 0–1).",
    defaultValue: DEFAULT_RELEVANCE_CONFIG.scorer,
    options: [
      { value: "jaccard", label: "Jaccard (default)" },
      { value: "bm25", label: "BM25" },
    ],
  },
  {
    key: "bm25K1",
    type: "number",
    label: "BM25 k1",
    description: "Term-frequency saturation (standard 1.2). Only used when scorer is bm25.",
    defaultValue: DEFAULT_RELEVANCE_CONFIG.bm25K1,
    min: 0.1,
    max: 3,
  },
  {
    key: "bm25B",
    type: "number",
    label: "BM25 b",
    description: "Length normalization (standard 0.75). Only used when scorer is bm25.",
    defaultValue: DEFAULT_RELEVANCE_CONFIG.bm25B,
    min: 0,
    max: 1,
  },
];

export function validateRelevanceConfig(config: Record<string, unknown>): EngineValidationResult {
  const errors: string[] = [];
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    errors.push("enabled must be a boolean");
  }
  if (config.scorer !== undefined && config.scorer !== "jaccard" && config.scorer !== "bm25") {
    errors.push('scorer must be "jaccard" or "bm25"');
  }
  if (config.bm25K1 !== undefined) {
    const v = config.bm25K1;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 3) {
      errors.push("bm25K1 must be a number between 0 (exclusive) and 3");
    }
  }
  if (config.bm25B !== undefined) {
    const v = config.bm25B;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      errors.push("bm25B must be a number between 0 and 1");
    }
  }
  for (const key of ["overlapThreshold", "budgetPercent", "boilerplateWeight"]) {
    if (config[key] !== undefined) {
      const v = config[key];
      if (typeof v !== "number" || v < 0 || v > 1) {
        errors.push(`${key} must be a number between 0 and 1`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function resolveRelevanceConfig(stepConfig: Record<string, unknown>): RelevanceConfig {
  return {
    enabled:
      typeof stepConfig.enabled === "boolean"
        ? stepConfig.enabled
        : DEFAULT_RELEVANCE_CONFIG.enabled,
    overlapThreshold:
      typeof stepConfig.overlapThreshold === "number"
        ? stepConfig.overlapThreshold
        : DEFAULT_RELEVANCE_CONFIG.overlapThreshold!,
    budgetPercent:
      typeof stepConfig.budgetPercent === "number"
        ? stepConfig.budgetPercent
        : DEFAULT_RELEVANCE_CONFIG.budgetPercent!,
    boilerplateWeight:
      typeof stepConfig.boilerplateWeight === "number"
        ? stepConfig.boilerplateWeight
        : DEFAULT_RELEVANCE_CONFIG.boilerplateWeight!,
    scorer: stepConfig.scorer === "bm25" ? "bm25" : "jaccard",
    bm25K1:
      typeof stepConfig.bm25K1 === "number" ? stepConfig.bm25K1 : DEFAULT_RELEVANCE_CONFIG.bm25K1,
    bm25B: typeof stepConfig.bm25B === "number" ? stepConfig.bm25B : DEFAULT_RELEVANCE_CONFIG.bm25B,
  };
}
