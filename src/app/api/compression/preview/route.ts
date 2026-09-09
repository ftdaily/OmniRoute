import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { compressionPreviewConfigSchema } from "@/shared/validation/compressionConfigSchemas";
import {
  applyCompression,
  applyCompressionAsync,
} from "@omniroute/open-sse/services/compression/strategySelector";
import type {
  CompressionConfig,
  CompressionMode,
} from "@omniroute/open-sse/services/compression/types";
import {
  buildCompressionPreviewDiff,
  type HeatmapMode,
} from "@omniroute/open-sse/services/compression/diffHelper";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { countTextTokens } from "@/shared/utils/tiktokenCounter";
import {
  ensureEngineBreakdown,
  reconcileSingleEngineTokens,
} from "@omniroute/open-sse/services/compression/engineBreakdown";
import { summarizeEncoderCandidates } from "@omniroute/open-sse/services/compression/engines/headroom/encoderComparison";
import { contentTypeOfBody } from "@omniroute/open-sse/services/compression/contentTypeGate";
import { DEFAULT_MIN_ROWS } from "@omniroute/open-sse/services/compression/engines/headroom/smartcrusher";

export const PreviewCompressionConfigSchema = compressionPreviewConfigSchema;

export const PreviewRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.string(),
        content: z.union([z.string(), z.array(z.unknown())]),
      })
    )
    .min(1),
  // tool-schema operates on body.tools / body.functions, not message text.
  // Optional so the Studio detail page can preview unsaved trim knobs against
  // a sample tool definition; other engines ignore it.
  tools: z.array(z.unknown()).optional(),
  functions: z.array(z.unknown()).optional(),
  mode: z
    .enum(["off", "lite", "standard", "aggressive", "ultra", "rtk", "stacked", "caveman"])
    .optional()
    .default("stacked"),
  engineId: z.string().optional(),
  pipeline: z.array(z.string()).min(1).optional(),
  config: PreviewCompressionConfigSchema.optional(),
  // Playground fidelity-gate toggle. Only `enabled` is exposed on the API surface on purpose:
  // the advanced thresholds (minTokenSurvivalPercent / minJsonKeyPercent / checkNumericIntegrity
  // / checkDiffHunks on FidelityGateConfig) use their conservative defaults until the studio gets
  // a config panel for them.
  fidelityGate: z.object({ enabled: z.boolean() }).optional(),
  // Playground risk-gate toggle → masks high-risk spans (secrets/keys) before compression and
  // restores them verbatim after, so they pass through byte-identical. Reported via
  // result.stats.riskGate (spansProtected + per-category counts).
  riskGate: z.object({ enabled: z.boolean() }).optional(),
  // Playground fuzzy near-duplicate toggle → injects `{ fuzzy: { enabled: true } }` into the
  // session-dedup step config (see buildStep).
  fuzzyDedup: z.object({ enabled: z.boolean() }).optional(),
  // Playground QuantumLock toggle. The studio is a dry-run, so when enabled we force a caching
  // context (provider: "anthropic") so the operator can SEE what would be stabilized; real
  // cache-hit gains only show in production provider telemetry.
  quantumLock: z.object({ enabled: z.boolean() }).optional(),
  contentTypeRouter: z.object({ enabled: z.boolean() }).optional(),
  // Saliency heatmap mode. When set, the response includes a per-token heatmap.
  // "ultra" uses scoreToken (0–1); "universal" uses kept/removed from the diff.
  // Omit to skip heatmap computation (normal preview path — no extra cost).
  heatmap: z.enum(["ultra", "universal"]).optional(),
});

function countTokens(text: string): number {
  return countTextTokens(text);
}

function riskGateStatsOf(result: { stats?: { riskGate?: unknown } }): unknown {
  return result.stats?.riskGate ?? null;
}

function quantumLockStatsOf(result: { stats?: { quantumLock?: unknown } | null }): unknown {
  return result.stats?.quantumLock ?? null;
}

function contentTypeStatsOfRequest(
  requestBody: Record<string, unknown>,
  gate?: { enabled: boolean } | undefined
): unknown {
  if (!gate?.enabled) return null;
  const r = contentTypeOfBody(requestBody);
  return { type: r.contentType, confidence: r.confidence };
}

function quantumExtras(quantumLock?: { enabled: boolean }) {
  return quantumLock?.enabled
    ? {
        configPatch: { quantumLock: { enabled: true } },
        applyOpts: { cachingContext: { provider: "anthropic" } },
      }
    : { configPatch: {}, applyOpts: {} };
}

function messagesToText(messages: Array<{ role: string; content: unknown }>): string {
  return messages
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${m.role}: ${content}`;
    })
    .join("\n");
}

function buildStep(
  engine: string,
  fuzzy?: { enabled: boolean },
  /** Optional detail bag (e.g. headroom.minRows from saved settings). */
  detail?: Record<string, unknown>
) {
  const config: Record<string, unknown> = { ...(detail ?? {}) };
  if (engine === "session-dedup" && fuzzy?.enabled) {
    config.fuzzy = { enabled: true };
  }
  return Object.keys(config).length > 0 ? { engine, config } : { engine };
}

function headroomParticipates(
  engineId: string | undefined,
  pipeline: string[] | undefined,
  mode: CompressionMode
): boolean {
  // An explicit single-engine or pipeline override decides on its own terms:
  // headroom only participates if it is the engine / is named in the pipeline.
  // (effectiveMode is forced to "stacked" whenever engineId/pipeline is set, so we
  // must not fall through to the mode check for those — e.g. engineId:"lite".)
  if (engineId) return engineId === "headroom";
  if (pipeline) return pipeline.includes("headroom");
  return mode === "stacked";
}

/**
 * Resolve the optional headroom detail (minRows) from a synthesized compression config.
 * Extracted from dispatchCompression to keep that dispatcher under the complexity gate (#8056/#8058).
 */
function resolveHeadroomDetail(config: unknown): {
  headroomDetail: CompressionConfig["headroom"] | undefined;
  headroomStepDetail: { minRows: number } | undefined;
} {
  const headroomDetail =
    config && typeof config === "object" && config !== null
      ? (config as CompressionConfig).headroom
      : undefined;
  const headroomStepDetail =
    headroomDetail && typeof headroomDetail.minRows === "number"
      ? { minRows: headroomDetail.minRows }
      : undefined;
  return { headroomDetail, headroomStepDetail };
}

/**
 * Resolve the optional tool-schema detail (maxDescriptionChars/dropExamples/
 * dropVendorExtensions) from a synthesized compression config. Mirrors
 * resolveHeadroomDetail: the EngineConfigPage detail form persists to
 * settings.toolSchema, and the stacked runner merges it via
 * resolveStepDetailConfig — but the preview route builds single-engine/pipeline
 * steps directly, so it must thread the detail into buildStep the same way.
 * `enabled` is deliberately NOT forwarded here: selecting the engine in an
 * explicit preview pipeline is itself the enablement signal (buildStepOptions
 * forces it, mirroring codex-responses), so unsaved form values for the trim
 * knobs apply without requiring the saved on/off toggle.
 */
function resolveToolSchemaDetail(config: unknown): {
  toolSchemaDetail: CompressionConfig["toolSchema"] | undefined;
  toolSchemaStepDetail: Record<string, unknown> | undefined;
} {
  const toolSchemaDetail =
    config && typeof config === "object" && config !== null
      ? (config as CompressionConfig).toolSchema
      : undefined;
  if (!toolSchemaDetail || typeof toolSchemaDetail !== "object") {
    return { toolSchemaDetail: undefined, toolSchemaStepDetail: undefined };
  }
  const stepDetail: Record<string, unknown> = {};
  for (const key of ["maxDescriptionChars", "dropExamples", "dropVendorExtensions"] as const) {
    const v = (toolSchemaDetail as Record<string, unknown>)[key];
    if (v !== undefined) stepDetail[key] = v;
  }
  return {
    toolSchemaDetail,
    toolSchemaStepDetail: Object.keys(stepDetail).length > 0 ? stepDetail : undefined,
  };
}

/**
 * Resolve the optional relevance detail (scorer/bm25K1/bm25B + thresholds) from
 * a synthesized compression config. Mirrors resolveHeadroomDetail: the EngineConfigPage
 * detail form persists to settings.relevance, and the stacked runner merges it via
 * resolveStepDetailConfig — but the preview route builds single-engine/pipeline steps
 * directly, so it must thread the detail into buildStep the same way.
 */
function resolveRelevanceDetail(config: unknown): {
  relevanceDetail: CompressionConfig["relevance"] | undefined;
  relevanceStepDetail: Record<string, unknown> | undefined;
} {
  const relevanceDetail =
    config && typeof config === "object" && config !== null
      ? (config as CompressionConfig).relevance
      : undefined;
  if (!relevanceDetail || typeof relevanceDetail !== "object") {
    return { relevanceDetail: undefined, relevanceStepDetail: undefined };
  }
  const stepDetail: Record<string, unknown> = {};
  for (const key of [
    "scorer",
    "bm25K1",
    "bm25B",
    "overlapThreshold",
    "budgetPercent",
    "boilerplateWeight",
  ] as const) {
    const v = (relevanceDetail as Record<string, unknown>)[key];
    if (v !== undefined) stepDetail[key] = v;
  }
  return {
    relevanceDetail,
    relevanceStepDetail: Object.keys(stepDetail).length > 0 ? stepDetail : undefined,
  };
}

/**
 * Resolve the optional lite detail (passes / thresholds / token budget) from a
 * synthesized compression config. Mirrors resolveHeadroomDetail: the studio sends
 * `{ lite: {...} }` so unsaved per-engine edits are honored in preview, and
 * buildStepOptions merges the persisted global into the lite stepConfig.
 */
function resolveLiteDetail(config: unknown): {
  liteDetail: CompressionConfig["lite"] | undefined;
  liteStepDetail: Record<string, unknown> | undefined;
} {
  const liteDetail =
    config && typeof config === "object" && config !== null
      ? (config as CompressionConfig).lite
      : undefined;
  const liteStepDetail =
    liteDetail && typeof liteDetail === "object" ? { ...(liteDetail as object) } : undefined;
  return { liteDetail, liteStepDetail };
}

async function dispatchCompression(
  requestBody: Record<string, unknown>,
  opts: {
    engineId?: string;
    pipeline?: string[];
    effectiveMode: CompressionMode;
    config?: unknown;
    fidelityGate?: { enabled: boolean };
    fuzzyDedup?: { enabled: boolean };
    riskGate?: { enabled: boolean };
    quantumLock?: { enabled: boolean };
    contentTypeRouter?: { enabled: boolean };
  }
) {
  // resolveRiskGate reads `options.riskGate ?? options.config.riskGate`. applyCompressionAsync
  // does not surface a top-level `riskGate` option, so thread it through the synthesized config
  // (CompressionConfig.riskGate) — uniform across all three branches and type-safe.
  // QuantumLock uses the same pattern: when enabled the studio forces cachingContext so the dry-run
  // badge shows what WOULD be stabilized in production (real caching gains show in telemetry only).
  // When the client/settings carry a headroom detail sub-object, thread it so
  // buildStepOptions can merge minRows into the headroom engine stepConfig (#8056).
  const { headroomDetail, headroomStepDetail } = resolveHeadroomDetail(opts.config);
  const { toolSchemaDetail, toolSchemaStepDetail } = resolveToolSchemaDetail(opts.config);
  const { relevanceDetail, relevanceStepDetail } = resolveRelevanceDetail(opts.config);
  const { liteDetail, liteStepDetail } = resolveLiteDetail(opts.config);

  if (opts.engineId) {
    const q = quantumExtras(opts.quantumLock);
    return applyCompressionAsync(requestBody, "stacked", {
      config: {
        stackedPipeline: [
          buildStep(
            opts.engineId,
            opts.fuzzyDedup,
            opts.engineId === "headroom"
              ? headroomStepDetail
              : opts.engineId === "tool-schema"
                ? toolSchemaStepDetail
                : opts.engineId === "relevance"
                  ? relevanceStepDetail
                  : opts.engineId === "lite"
                    ? liteStepDetail
                    : undefined
          ),
        ],
        ...(headroomDetail ? { headroom: headroomDetail } : {}),
        ...(toolSchemaDetail ? { toolSchema: toolSchemaDetail } : {}),
        ...(relevanceDetail ? { relevance: relevanceDetail } : {}),
        ...(liteDetail ? { lite: liteDetail } : {}),
        ...(opts.fidelityGate ? { fidelityGate: opts.fidelityGate } : {}),
        ...(opts.riskGate ? { riskGate: opts.riskGate } : {}),
        ...(opts.contentTypeRouter ? { contentTypeRouter: opts.contentTypeRouter } : {}),
        ...q.configPatch,
      } as CompressionConfig,
      ...q.applyOpts,
    });
  }
  if (opts.pipeline) {
    const q = quantumExtras(opts.quantumLock);
    return applyCompressionAsync(requestBody, "stacked", {
      config: {
        stackedPipeline: opts.pipeline.map((engine) =>
          buildStep(
            engine,
            opts.fuzzyDedup,
            engine === "headroom"
              ? headroomStepDetail
              : engine === "tool-schema"
                ? toolSchemaStepDetail
                : engine === "relevance"
                  ? relevanceStepDetail
                  : engine === "lite"
                    ? liteStepDetail
                    : undefined
          )
        ),
        ...(headroomDetail ? { headroom: headroomDetail } : {}),
        ...(toolSchemaDetail ? { toolSchema: toolSchemaDetail } : {}),
        ...(relevanceDetail ? { relevance: relevanceDetail } : {}),
        ...(liteDetail ? { lite: liteDetail } : {}),
        ...(opts.fidelityGate ? { fidelityGate: opts.fidelityGate } : {}),
        ...(opts.riskGate ? { riskGate: opts.riskGate } : {}),
        ...(opts.contentTypeRouter ? { contentTypeRouter: opts.contentTypeRouter } : {}),
        ...q.configPatch,
      } as CompressionConfig,
      ...q.applyOpts,
    });
  }
  const q = quantumExtras(opts.quantumLock);
  return applyCompression(requestBody, opts.effectiveMode, {
    config: {
      ...(opts.config as CompressionConfig | undefined),
      ...(opts.fidelityGate ? { fidelityGate: opts.fidelityGate } : {}),
      ...(opts.riskGate ? { riskGate: opts.riskGate } : {}),
      ...(opts.contentTypeRouter ? { contentTypeRouter: opts.contentTypeRouter } : {}),
      ...q.configPatch,
    } as CompressionConfig | undefined,
    ...q.applyOpts,
  });
}

export async function POST(req: Request) {
  const authError = await requireManagementAuth(req);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const {
    messages,
    tools,
    functions,
    mode,
    engineId: rawEngineId,
    pipeline,
    config,
    fidelityGate,
    fuzzyDedup,
    riskGate,
    quantumLock,
    contentTypeRouter,
    heatmap: heatmapMode,
  } = parsed.data;
  // Alias: `mode: "caveman"` is a synonym for `engineId: "caveman"` (single-engine stacked run).
  // The caveman engine is not a top-level CompressionMode, but it IS a registered engine.
  const engineId = mode === "caveman" && !rawEngineId ? "caveman" : rawEngineId;
  const effectiveMode: CompressionMode =
    engineId || pipeline ? "stacked" : (mode as CompressionMode);
  const originalText = messagesToText(messages);
  const originalTokens = countTokens(originalText);

  try {
    const start = Date.now();
    // tool-schema reads body.tools / body.functions; message-only engines ignore them.
    const requestBody = {
      messages,
      ...(tools !== undefined ? { tools } : {}),
      ...(functions !== undefined ? { functions } : {}),
    };
    const result = await dispatchCompression(requestBody as Record<string, unknown>, {
      engineId,
      pipeline,
      effectiveMode,
      config,
      fidelityGate,
      fuzzyDedup,
      riskGate,
      quantumLock,
      contentTypeRouter,
    });
    const durationMs = Date.now() - start;

    const compressedMessages = (result.body.messages ?? messages) as Array<{
      role: string;
      content: unknown;
    }>;
    const compressedText = messagesToText(compressedMessages);
    const compressedTokens = countTokens(compressedText);
    const tokensSaved = Math.max(0, originalTokens - compressedTokens);
    const savingsPct = originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0;
    const techniquesUsed: string[] = result.stats?.techniquesUsed ?? [];
    const engineBreakdown = result.stats
      ? reconcileSingleEngineTokens(
          ensureEngineBreakdown(result.stats),
          originalTokens,
          compressedTokens,
          savingsPct
        )
      : [];
    const diff = buildCompressionPreviewDiff(
      originalText,
      compressedText,
      result.stats,
      {},
      heatmapMode as HeatmapMode | undefined
    );

    const headroomMinRows =
      typeof config?.headroom?.minRows === "number" && Number.isFinite(config.headroom.minRows)
        ? config.headroom.minRows
        : DEFAULT_MIN_ROWS;
    const encoderComparison = headroomParticipates(engineId, pipeline, effectiveMode)
      ? summarizeEncoderCandidates(messages, headroomMinRows, countTextTokens)
      : null;

    // #6461: when fallbackApplied=true, synthesize a deduped reason list from data the
    // pipeline already produces on result.stats (engineBreakdown[].rejectReason,
    // validationErrors, and inflation-guard entries in validationWarnings). Non-fallback
    // runs return []/null — zero change on the happy path.
    const fallbackReasons: string[] = [];
    if (diff.fallbackApplied) {
      const seen = new Set<string>();
      const push = (s: unknown) => {
        if (typeof s === "string" && s.length > 0 && !seen.has(s)) {
          seen.add(s);
          fallbackReasons.push(s);
        }
      };
      for (const step of engineBreakdown) {
        if ((step as { rejected?: boolean }).rejected === true) {
          push((step as { rejectReason?: string }).rejectReason);
        }
      }
      for (const err of diff.validationErrors ?? []) push(err);
      for (const warn of diff.validationWarnings ?? []) {
        if (typeof warn === "string" && warn.startsWith("pipeline-inflation-guard:")) push(warn);
      }
    }
    const fallbackReason = fallbackReasons[0] ?? null;

    return NextResponse.json({
      encoderComparison,
      original: originalText,
      compressed: compressedText,
      originalTokens,
      compressedTokens,
      tokensSaved,
      savingsPct,
      techniquesUsed,
      engineBreakdown,
      // tool-schema compresses body.tools / body.functions, which the message-text
      // counters above cannot see (its savings would read as zero). Echo the trimmed
      // definitions + a JSON-size delta so the Studio detail page shows real evidence.
      ...(result.body.tools !== undefined ? { tools: result.body.tools } : {}),
      ...(result.body.functions !== undefined ? { functions: result.body.functions } : {}),
      ...(() => {
        const beforeTools = JSON.stringify({ tools, functions }).length;
        const afterTools = JSON.stringify({
          tools: result.body.tools ?? tools,
          functions: result.body.functions ?? functions,
        }).length;
        const toolBytesSaved = Math.max(0, beforeTools - afterTools);
        return toolBytesSaved > 0 ? { toolBytesSaved } : {};
      })(),
      riskGate: riskGateStatsOf(result),
      quantumLock: quantumLockStatsOf(result),
      contentType: contentTypeStatsOfRequest(requestBody, contentTypeRouter),
      durationMs,
      mode: effectiveMode,
      intensity: null,
      outputMode: null,
      skippedReasons: fallbackReasons,
      diff: diff.segments,
      preservedBlocks: diff.preservedBlocks,
      ruleRemovals: diff.ruleRemovals,
      rulesApplied: diff.ruleRemovals,
      validation: {
        valid: diff.validationErrors.length === 0,
        errors: diff.validationErrors,
        warnings: diff.validationWarnings,
        fallbackApplied: diff.fallbackApplied,
        ...(diff.fallbackReason && { fallbackReason: diff.fallbackReason }),
      },
      validationWarnings: diff.validationWarnings,
      validationErrors: diff.validationErrors,
      fallbackApplied: diff.fallbackApplied,
      // Prefer the pipeline's canonical `diff.fallbackReason`; fall back to the
      // first synthesized reason (#6461) when the pipeline did not set one.
      fallbackReason: diff.fallbackReason ?? fallbackReason,
      fallbackReasons,
      ...(diff.heatmap ? { heatmap: diff.heatmap } : {}),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/compression/preview]", msg);
    return NextResponse.json(
      { error: "Compression failed", details: sanitizeErrorMessage(msg) },
      { status: 500 }
    );
  }
}
