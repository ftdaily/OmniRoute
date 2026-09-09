/**
 * Content-type gate — stacked-loop wrapper around the content-type router.
 *
 * Classifies the stacked request body once per run (join of message text via
 * extractTextContent, capped at 32KB), then answers per-engine skip decisions.
 * Gate-off (no config, `enabled: false`, or below-threshold confidence)
 * returns "do not skip" so legacy runs are byte-identical.
 */

import { detectContentType, contentTypeApplies, DEFAULT_CONTENT_TYPE_THRESHOLD } from "./contentTypeRouter.ts";
import type { ContentType, ContentTypeResult, ContentTypeRouterConfig } from "./contentTypeRouter.ts";
import { extractTextContent, type ChatMessageLike } from "./messageContent.ts";

/** Max chars scanned for classification — bounds regex/parse cost on huge bodies. */
export const CONTENT_TYPE_SCAN_CAP = 32 * 1024;

/** Join the text of every message in the body; empty body ⇒ empty string. */
export function bodyTextOf(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg !== null && typeof msg === "object") {
      parts.push(extractTextContent((msg as ChatMessageLike).content));
    }
  }
  return parts.join("\n").slice(0, CONTENT_TYPE_SCAN_CAP);
}

/** Classify a stacked request body once per run. */
export function contentTypeOfBody(body: Record<string, unknown>): ContentTypeResult {
  return detectContentType(bodyTextOf(body));
}

export interface ContentTypeSkipConfig extends ContentTypeRouterConfig {
  /** Override for the confidence threshold (falls back to config then default). */
  threshold?: number;
}

/**
 * True when `engine` should be skipped for this content type.
 * Returns false when the gate is off/absent or confidence is below threshold.
 */
export function shouldSkipEngineForContentType(
  engine: string,
  contentType: ContentType,
  confidence: number,
  cfg?: ContentTypeSkipConfig
): boolean {
  if (!cfg?.enabled) return false;
  const threshold = cfg.threshold ?? cfg.confidenceThreshold ?? DEFAULT_CONTENT_TYPE_THRESHOLD;
  if (confidence < threshold) return false;
  return !contentTypeApplies(contentType, engine);
}

/** Small telemetry helper: the classified type + engine applicability for one engine. */
export function contentTypeStatsOf(
  result: ContentTypeResult,
  engine: string
): { type: ContentType; confidence: number; applies: boolean } {
  return {
    type: result.contentType,
    confidence: result.confidence,
    applies: contentTypeApplies(result.contentType, engine),
  };
}
