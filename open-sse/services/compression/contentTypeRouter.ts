/**
 * Content-type router — opt-in per-engine skip hints for the stacked pipeline.
 *
 * Concept (inspired by Claw Cortex-style content-aware routing, clean-room
 * implementation): classify the request body once per stacked run into a coarse
 * content type, then skip engines whose strengths do not apply to that type.
 * The gate is conservative by design — low-confidence classifications never
 * skip anything, unknown engines fail open, and the whole feature is disabled
 * unless `enabled: true` is set explicitly. Gate-off runs are byte-identical
 * to legacy runs (no classification, no skips).
 *
 * Pure leaf module: no imports, no side effects, no I/O.
 */

export type ContentType = "code" | "json" | "log" | "diff" | "search" | "text";

export interface ContentTypeRouterConfig {
  enabled: boolean;
  /** Minimum confidence (0-1) before a classification may skip engines. Default 0.7. */
  confidenceThreshold?: number;
}

export interface ContentTypeResult {
  contentType: ContentType;
  confidence: number;
}

/** Default gate threshold — only confident classifications skip engines. */
export const DEFAULT_CONTENT_TYPE_THRESHOLD = 0.7;

/** Floor/ceiling for every confidence value this module returns. */
const MIN_CONFIDENCE = 0.5;
const MAX_CONFIDENCE = 0.95;

/** Markdown fenced block — strong code signal (checked first). */
const FENCE_RE = /```[\s\S]*?```/;
/** VCS diff headers (`diff --git`, hunk `@@`). */
const DIFF_HEADER_RE = /^(diff --git |@@ )/m;
/** Unified-diff file markers, only meaningful alongside hunk lines. */
const DIFF_FILE_MARKER_RE = /^(\+\+\+|---) /m;
const DIFF_HUNK_LINE_RE = /^[+-][^+-]/m;
/** Log-line signals: ISO dates, clock times, levels, bracketed tags. */
const LOG_LINE_RE =
  /(^\d{4}-\d{2}-\d{2})|(^\d{2}:\d{2}:\d{2})|\b(INFO|DEBUG|WARN|WARNING|ERROR|TRACE|FATAL)\b|(^\[\w+\])/;
/** Search-result signals: result headers, numbered links, source lists. */
const SEARCH_MARKER_RES = [
  /search results?/i,
  /^\s*\d+[.)]\s+https?:\/\//m,
  /^sources?:\s*$/im,
  /relevant (sources|results|documents)/i,
];
/** Code-density signals: keywords, arrows, braces/semicolons. */
const CODE_KEYWORD_RE =
  /\b(function|const|let|var|import|export|return|class|def|interface|type|fn|struct|impl|pub|require|from)\b|=>|[{};]/;

function clampConfidence(value: number): number {
  if (value < MIN_CONFIDENCE) return MIN_CONFIDENCE;
  if (value > MAX_CONFIDENCE) return MAX_CONFIDENCE;
  return value;
}

function lineRatio(text: string, test: (line: string) => boolean): number {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return 0;
  const hits = lines.filter(test).length;
  return hits / lines.length;
}

/** True when the trimmed text parses as a JSON object or array. */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

/**
 * Classify text into a coarse content type.
 * Conservative priority: markdown fence → code, diff headers → diff,
 * JSON.parse → json, log-line density → log, search markers → search,
 * code-keyword density → code, else text (low confidence — never gates).
 */
export function detectContentType(text: string): ContentTypeResult {
  if (!text || text.trim().length === 0) {
    return { contentType: "text", confidence: MIN_CONFIDENCE };
  }
  if (FENCE_RE.test(text)) {
    return { contentType: "code", confidence: clampConfidence(0.9) };
  }
  if (
    DIFF_HEADER_RE.test(text) ||
    (DIFF_FILE_MARKER_RE.test(text) && DIFF_HUNK_LINE_RE.test(text))
  ) {
    return { contentType: "diff", confidence: clampConfidence(0.9) };
  }
  if (looksLikeJson(text)) {
    return { contentType: "json", confidence: clampConfidence(0.85) };
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length >= 3 && lineRatio(text, (l) => LOG_LINE_RE.test(l.trim())) >= 0.3) {
    return { contentType: "log", confidence: clampConfidence(0.8) };
  }
  const searchHits = SEARCH_MARKER_RES.filter((re) => re.test(text)).length;
  if (searchHits >= 2 || (searchHits >= 1 && /https?:\/\//.test(text))) {
    return { contentType: "search", confidence: clampConfidence(0.75) };
  }
  if (lines.length >= 3 && lineRatio(text, (l) => CODE_KEYWORD_RE.test(l)) >= 0.25) {
    return { contentType: "code", confidence: clampConfidence(0.7) };
  }
  return { contentType: "text", confidence: MIN_CONFIDENCE };
}

const ALL_TYPES: ContentType[] = ["code", "json", "log", "diff", "search", "text"];

/**
 * Engine applicability map: which content types an engine is good at.
 * General-purpose engines apply to everything; unknown engine ids fail open
 * (return true) so newly registered engines are never gated by accident.
 */
const ENGINE_CONTENT_TYPES: Record<string, ContentType[]> = {
  rtk: ["log", "diff", "search"],
  ionizer: ["json"],
  headroom: ["json"],
  caveman: ["text"],
  llmlingua: ["text"],
  "codex-responses": ["code", "diff", "log"],
  "session-dedup": ALL_TYPES,
  ccr: ALL_TYPES,
  lite: ALL_TYPES,
  ultra: ALL_TYPES,
  aggressive: ALL_TYPES,
};

export function contentTypeApplies(contentType: ContentType, engine: string): boolean {
  const list = ENGINE_CONTENT_TYPES[engine.toLowerCase()];
  if (!list) return true;
  return list.includes(contentType);
}

/**
 * True when NONE of `engines` applies to `contentType` — i.e. the gate would
 * skip the entire pipeline. The Studio calls this client-side (before the
 * run) to warn instead of producing an all-skipped no-op.
 */
export function pipelineFullyGated(contentType: ContentType, engines: readonly string[]): boolean {
  return engines.length > 0 && engines.every((e) => !contentTypeApplies(contentType, e));
}

/** Resolve the effective router config (explicit option wins over config); enabled-gated. */
export function resolveContentTypeRouter(options?: {
  contentTypeRouter?: ContentTypeRouterConfig;
  config?: { contentTypeRouter?: ContentTypeRouterConfig };
}): ContentTypeRouterConfig | undefined {
  const cfg = options?.contentTypeRouter ?? options?.config?.contentTypeRouter;
  return cfg?.enabled ? cfg : undefined;
}
