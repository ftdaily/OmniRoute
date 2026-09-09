/**
 * OmniRoute MCP Compression Controls — listing/get/update for the modular
 * compression engine registry, caveman rule/language-pack metadata, and
 * Compression Studio dry-run capabilities (preview + compare).
 *
 * Every handler reuses the same services as the REST routes:
 *   - engines  → GET /api/compression/engines (registry.ts + engines/index.ts)
 *   - rules    → GET /api/compression/rules (cavemanRules.ts)
 *   - packs    → GET /api/compression/language-packs (ruleLoader.ts)
 *   - preview  → POST /api/compression/preview (strategySelector.ts dispatch)
 *   - compare  → POST /api/compression/compare (harness/benchmark.ts)
 *
 * Record-only collection spread into `compressionTools` (same pattern as the
 * pre-existing RTK entries in that record): server.ts registration, the
 * toolSearch catalog, TOTAL_MCP_TOOL_COUNT, and scope enforcement pick the
 * new tools up with zero further wiring — the canonical schemas/tools.ts
 * McpToolDefinition entries are NOT needed (CCR/RTK precedent).
 */

import { z } from "zod";
import { logToolCall } from "../audit.ts";
import {
  registerBuiltinCompressionEngines,
} from "../../services/compression/engines/index.ts";
import {
  getCompressionEngine,
  getEngineEntry,
  listEngines,
  setEngineEnabled,
  updateEngineConfig,
} from "../../services/compression/engines/registry.ts";
import { getCavemanRuleMetadata } from "../../services/compression/cavemanRules.ts";
import { listCavemanRulePacks } from "../../services/compression/ruleLoader.ts";
import { listSupportedCompressionLanguages } from "../../services/compression/languageDetector.ts";
import { applyCompressionAsync } from "../../services/compression/strategySelector.ts";
import {
  benchmarkEngines,
  compareReports,
  DEFAULT_BENCHMARK_ENGINES,
} from "../../services/compression/harness/benchmark.ts";
import { estimateCompressionTokens } from "../../services/compression/stats.ts";
import type { CompressionConfig } from "../../services/compression/types.ts";

// ── engines ────────────────────────────────────────────────────────────────

export const listCompressionEnginesInput = z.object({}).describe("No parameters required");

function engineShape(entry: ReturnType<typeof listEngines>[number]) {
  const e = entry.engine;
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    icon: e.icon,
    stackable: e.stackable,
    stackPriority: e.stackPriority,
    enabled: entry.enabled,
    config: entry.config,
    metadata: e.metadata,
    configSchema: e.getConfigSchema(),
  };
}

export async function handleListCompressionEngines(_args: z.infer<typeof listCompressionEnginesInput>) {
  const start = Date.now();
  registerBuiltinCompressionEngines();
  const engines = listEngines().map(engineShape);
  const result = { engines };
  await logToolCall("omniroute_list_compression_engines", _args, { count: engines.length }, Date.now() - start, true);
  return result;
}

export const getCompressionEngineInput = z.object({
  engineId: z.string().min(1).describe("Engine id, e.g. lite, caveman, rtk, ccr"),
});

export async function handleGetCompressionEngine(args: z.infer<typeof getCompressionEngineInput>) {
  const start = Date.now();
  registerBuiltinCompressionEngines();
  const entry = getEngineEntry(args.engineId);
  if (!entry) throw new Error(`Unknown compression engine: "${args.engineId}"`);
  const result = engineShape(entry);
  await logToolCall("omniroute_get_compression_engine", args, { id: result.id }, Date.now() - start, true);
  return result;
}

export const updateCompressionEngineInput = z.object({
  engineId: z.string().min(1).describe("Engine id to update"),
  enabled: z.boolean().optional().describe("Flip the registry enabled flag (respected by stacked dispatch)"),
  config: z.record(z.string(), z.unknown()).optional().describe("Partial engine config; validated by the engine"),
});

export async function handleUpdateCompressionEngine(
  args: z.infer<typeof updateCompressionEngineInput>
) {
  const start = Date.now();
  registerBuiltinCompressionEngines();
  if (!getCompressionEngine(args.engineId)) {
    throw new Error(`Unknown compression engine: "${args.engineId}"`);
  }
  let enabled = getEngineEntry(args.engineId)?.enabled ?? true;
  if (args.enabled !== undefined) {
    if (!setEngineEnabled(args.engineId, args.enabled)) {
      throw new Error(`Unknown compression engine: "${args.engineId}"`);
    }
    enabled = args.enabled;
  }
  if (args.config !== undefined) {
    const validation = updateEngineConfig(args.engineId, args.config as Record<string, unknown>);
    if (!validation.valid) {
      throw new Error(`Invalid config for engine "${args.engineId}": ${validation.errors.join("; ")}`);
    }
  }
  const result = {
    success: true,
    engineId: args.engineId,
    enabled,
    config: getEngineEntry(args.engineId)?.config ?? {},
  };
  await logToolCall("omniroute_update_compression_engine", args, { engineId: args.engineId }, Date.now() - start, true);
  return result;
}

// ── rules / language packs ─────────────────────────────────────────────────

export const listCompressionRulesInput = z.object({
  intensity: z.enum(["lite", "full", "ultra"]).optional().describe("Only rules active at this intensity"),
});

export async function handleListCompressionRules(args: z.infer<typeof listCompressionRulesInput>) {
  const start = Date.now();
  const rules = getCavemanRuleMetadata();
  const filtered = args.intensity
    ? rules.filter((r) => (r.intensities as readonly string[]).includes(args.intensity as string))
    : rules;
  const result = { rules: filtered };
  await logToolCall(
    "omniroute_list_compression_rules",
    args,
    { count: filtered.length },
    Date.now() - start,
    true
  );
  return result;
}

export const listCompressionLanguagePacksInput = z.object({}).describe("No parameters required");

export async function handleListCompressionLanguagePacks(
  _args: z.infer<typeof listCompressionLanguagePacksInput>
) {
  const start = Date.now();
  const result = {
    languages: listSupportedCompressionLanguages(),
    packs: listCavemanRulePacks(),
  };
  await logToolCall(
    "omniroute_list_compression_language_packs",
    _args,
    { languages: result.languages.length, packs: result.packs.length },
    Date.now() - start,
    true
  );
  return result;
}

// ── studio: preview / compare ──────────────────────────────────────────────

const PREVIEW_INTENSITIES = ["lite", "full", "ultra", "minimal", "standard", "aggressive"] as const;

export const compressionPreviewInput = z.object({
  text: z.string().min(1).max(500_000).describe("Text to dry-run compression on"),
  engineId: z.string().min(1).optional().describe("Single engine id (runs as a one-step stacked pipeline)"),
  pipeline: z.array(z.string().min(1)).min(1).max(16).optional().describe("Ordered engine ids for a stacked run"),
  intensity: z.enum(PREVIEW_INTENSITIES).optional().describe("Step intensity override"),
});

function extractCompressedText(body: Record<string, unknown>, fallback: string): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (typeof m?.content === "string" && m.role !== "system") return m.content;
    }
    const first = messages.map((m) => m?.content).find((c) => typeof c === "string");
    if (typeof first === "string") return first;
  }
  return fallback;
}

export async function handleCompressionPreview(args: z.infer<typeof compressionPreviewInput>) {
  const start = Date.now();
  registerBuiltinCompressionEngines();
  for (const id of [...(args.engineId ? [args.engineId] : []), ...(args.pipeline ?? [])]) {
    if (!getCompressionEngine(id)) throw new Error(`Unknown compression engine: "${id}"`);
  }
  const body = { messages: [{ role: "user", content: args.text }] };
  const stepIntensity = args.intensity as
    | import("../../services/compression/types.ts").CavemanIntensity
    | import("../../services/compression/types.ts").RtkIntensity
    | undefined;
  let result;
  if (args.engineId) {
    result = await applyCompressionAsync(body as Record<string, unknown>, "stacked", {
      config: {
        stackedPipeline: [
          args.intensity
            ? { engine: args.engineId, intensity: stepIntensity }
            : { engine: args.engineId },
        ],
      } as CompressionConfig,
    });
  } else if (args.pipeline) {
    result = await applyCompressionAsync(body as Record<string, unknown>, "stacked", {
      config: {
        stackedPipeline: args.pipeline.map((engine) =>
          args.intensity ? { engine, intensity: stepIntensity } : { engine }
        ),
      } as unknown as CompressionConfig,
    });
  } else {
    result = await applyCompressionAsync(body as Record<string, unknown>, "stacked");
  }
  const originalTokens = estimateCompressionTokens(args.text);
  const compressedText = extractCompressedText(
    result.body as Record<string, unknown>,
    args.text
  );
  const compressedTokens = estimateCompressionTokens(compressedText);
  const tokensSaved = Math.max(0, originalTokens - compressedTokens);
  const output = {
    mode: "stacked" as const,
    ...(args.engineId ? { engineId: args.engineId } : {}),
    ...(args.pipeline ? { pipeline: args.pipeline } : {}),
    originalTokens,
    compressedTokens,
    tokensSaved,
    savingsPct: originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0,
    techniquesUsed: result.stats?.techniquesUsed ?? [],
    rulesApplied: result.stats?.rulesApplied ?? [],
    compressedText,
  };
  await logToolCall(
    "omniroute_compression_preview",
    { ...args, text: `[${args.text.length} chars]` },
    { ...output, compressedText: `[${compressedText.length} chars]` },
    Date.now() - start,
    true
  );
  return output;
}

export const compressionCompareInput = z.object({
  text: z.string().min(1).max(500_000).describe("Text to benchmark engines on"),
  engineIds: z
    .array(z.string().min(1))
    .min(1)
    .max(16)
    .optional()
    .describe("Engines to compare (default: sandbox A/B set)"),
});

export async function handleCompressionCompare(args: z.infer<typeof compressionCompareInput>) {
  const start = Date.now();
  registerBuiltinCompressionEngines();
  const ids = args.engineIds ?? DEFAULT_BENCHMARK_ENGINES;
  const reports = await benchmarkEngines([{ id: "input", input: args.text }], ids);
  const rows = compareReports(reports);
  const result = { rows };
  await logToolCall(
    "omniroute_compression_compare",
    { ...args, text: `[${args.text.length} chars]` },
    { engines: rows.map((r) => r.engine) },
    Date.now() - start,
    true
  );
  return result;
}

// ── record ─────────────────────────────────────────────────────────────────

export const compressionControlTools = {
  omniroute_list_compression_engines: {
    name: "omniroute_list_compression_engines",
    description:
      "List all registered compression engines with their config schemas and runtime enabled/config state. Mirrors GET /api/compression/engines.",
    scopes: ["read:compression"],
    inputSchema: listCompressionEnginesInput,
    handler: (args: z.infer<typeof listCompressionEnginesInput>) =>
      handleListCompressionEngines(args),
  },
  omniroute_get_compression_engine: {
    name: "omniroute_get_compression_engine",
    description:
      "Get a single compression engine's metadata, config schema, and runtime enabled/config state.",
    scopes: ["read:compression"],
    inputSchema: getCompressionEngineInput,
    handler: (args: z.infer<typeof getCompressionEngineInput>) => handleGetCompressionEngine(args),
  },
  omniroute_update_compression_engine: {
    name: "omniroute_update_compression_engine",
    description:
      "Update a compression engine at runtime: flip its registry enabled flag and/or merge validated config. Invalid configs are rejected with the engine's errors.",
    scopes: ["write:compression"],
    inputSchema: updateCompressionEngineInput,
    handler: (args: z.infer<typeof updateCompressionEngineInput>) =>
      handleUpdateCompressionEngine(args),
  },
  omniroute_list_compression_rules: {
    name: "omniroute_list_compression_rules",
    description:
      "List caveman rule metadata (name, context, category, intensities), optionally filtered by intensity. Mirrors GET /api/compression/rules.",
    scopes: ["read:compression"],
    inputSchema: listCompressionRulesInput,
    handler: (args: z.infer<typeof listCompressionRulesInput>) => handleListCompressionRules(args),
  },
  omniroute_list_compression_language_packs: {
    name: "omniroute_list_compression_language_packs",
    description:
      "List supported compression languages and installed caveman rule packs. Mirrors GET /api/compression/language-packs.",
    scopes: ["read:compression"],
    inputSchema: listCompressionLanguagePacksInput,
    handler: (args: z.infer<typeof listCompressionLanguagePacksInput>) =>
      handleListCompressionLanguagePacks(args),
  },
  omniroute_compression_preview: {
    name: "omniroute_compression_preview",
    description:
      "Dry-run compression on text (Compression Studio play view): single engine, pipeline, or default stacked plan. Returns token counts, savings, techniques, and compressed text. Read-only.",
    scopes: ["read:compression"],
    inputSchema: compressionPreviewInput,
    handler: (args: z.infer<typeof compressionPreviewInput>) => handleCompressionPreview(args),
  },
  omniroute_compression_compare: {
    name: "omniroute_compression_compare",
    description:
      "A/B-compare compression engines on text (Compression Studio compare view): returns the best-first summary table. Read-only, deterministic.",
    scopes: ["read:compression"],
    inputSchema: compressionCompareInput,
    handler: (args: z.infer<typeof compressionCompareInput>) => handleCompressionCompare(args),
  },
};
