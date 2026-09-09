/**
 * tool-schema compression engine.
 *
 * Clean-room, annotation-only trimming of request tool definitions
 * (`body.tools`, plus legacy `body.functions`): drops vendor extensions (`x-*`), `examples`, `title`,
 * `$comment`, and truncates over-long `description` strings. The selection
 * surface — tool/name, `type`, `properties`, `required`, `enum`, `default`,
 * `const`, `$ref`/`$defs`/`definitions`, and all validation keywords — is
 * preserved verbatim.
 *
 * Conservative guards:
 *   - Only replaces a tool entry when the trimmed form is strictly smaller.
 *   - Entries that are not objects, or that carry no recognizable
 *     name+schema shape (OpenAI `{type:function,function:{...}}` or Anthropic
 *     `{name,input_schema}`), pass through untouched.
 *   - Never touches `messages`, `system`, `input`, or any other body field.
 *   - Fail-open: any unexpected error returns the original body unchanged
 *     (`compressed: false`), never a partial rewrite.
 */

import { createCompressionStats } from "../../stats.ts";
import type {
  CompressionEngine,
  CompressionEngineApplyOptions,
  EngineConfigField,
  EngineValidationResult,
} from "../types.ts";
import type { CompressionResult } from "../../types.ts";

const ENGINE_ID = "tool-schema";

const DEFAULT_MAX_DESCRIPTION_CHARS = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function truncateDesc(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Annotation-only keys: safe to drop without changing tool selection or validation. */
function isAnnotationKey(key: string): boolean {
  return key.startsWith("x-") || key === "examples" || key === "title" || key === "$comment";
}

interface TrimOptions {
  maxDescriptionChars: number;
  dropExamples: boolean;
  dropVendorExtensions: boolean;
}

function trimSchemaNode(node: unknown, opts: TrimOptions): unknown {
  if (Array.isArray(node)) return node.map((item) => trimSchemaNode(item, opts));
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (opts.dropVendorExtensions && key.startsWith("x-")) continue;
    if (key === "examples" && opts.dropExamples) continue;
    if (key === "title" || key === "$comment") continue;
    if (key === "description" && typeof value === "string") {
      out[key] = truncateDesc(value, opts.maxDescriptionChars);
      continue;
    }
    out[key] = trimSchemaNode(value, opts);
  }
  return out;
}

/**
 * Normalizes one tool entry to its { name, description, schema } triple without
 * mutating structure. Returns null for unrecognized shapes (fail-open skip).
 */
function splitToolEntry(entry: unknown): {
  name: unknown;
  rest: Record<string, unknown>;
  schemaKeys: string[];
} | null {
  if (!isRecord(entry)) return null;
  // OpenAI chat shape: { type: "function", function: { name, description, parameters } }
  const fn = entry["function"];
  if (isRecord(fn) && typeof fn["name"] === "string" && fn["parameters"] !== undefined) {
    return { name: fn["name"], rest: entry, schemaKeys: ["function", "parameters"] };
  }
  // Responses-flat shape: { type: "function", name, description?, parameters }.
  // Also matches legacy body.functions entries ({ name, description?, parameters }).
  if (typeof entry["name"] === "string" && entry["parameters"] !== undefined) {
    return { name: entry["name"], rest: entry, schemaKeys: ["parameters"] };
  }
  // Anthropic shape: { name, description?, input_schema }
  if (typeof entry["name"] === "string" && entry["input_schema"] !== undefined) {
    return { name: entry["name"], rest: entry, schemaKeys: ["input_schema"] };
  }
  return null;
}

function trimToolEntry(entry: unknown, opts: TrimOptions): { next: unknown; changed: boolean } {
  const split = splitToolEntry(entry);
  if (!split) return { next: entry, changed: false };
  const before = JSON.stringify(entry).length;
  let next: unknown;
  if (split.schemaKeys[0] === "function") {
    const fn = split.rest["function"] as Record<string, unknown>;
    const trimmedFn: Record<string, unknown> = { ...fn };
    if (typeof trimmedFn["description"] === "string") {
      trimmedFn["description"] = truncateDesc(
        trimmedFn["description"] as string,
        opts.maxDescriptionChars
      );
    }
    delete trimmedFn["title"];
    if (opts.dropExamples) delete trimmedFn["examples"];
    for (const key of Object.keys(trimmedFn)) {
      if (opts.dropVendorExtensions && key.startsWith("x-")) delete trimmedFn[key];
    }
    trimmedFn["parameters"] = trimSchemaNode(fn["parameters"], opts);
    next = { ...split.rest, function: trimmedFn };
  } else if (split.schemaKeys[0] === "input_schema") {
    next = { ...split.rest, input_schema: trimSchemaNode(split.rest["input_schema"], opts) };
    if (typeof (next as Record<string, unknown>)["description"] === "string") {
      (next as Record<string, unknown>)["description"] = truncateDesc(
        (next as Record<string, unknown>)["description"] as string,
        opts.maxDescriptionChars
      );
    }
  } else {
    // Responses-flat / legacy shape: trim top-level description + full parameters schema.
    next = { ...split.rest, parameters: trimSchemaNode(split.rest["parameters"], opts) };
    if (typeof (next as Record<string, unknown>)["description"] === "string") {
      (next as Record<string, unknown>)["description"] = truncateDesc(
        (next as Record<string, unknown>)["description"] as string,
        opts.maxDescriptionChars
      );
    }
    delete (next as Record<string, unknown>)["title"];
    if (opts.dropExamples) delete (next as Record<string, unknown>)["examples"];
    if (opts.dropVendorExtensions) {
      for (const key of Object.keys(next as Record<string, unknown>)) {
        if (key.startsWith("x-")) delete (next as Record<string, unknown>)[key];
      }
    }
  }
  if (JSON.stringify(next).length >= before) return { next: entry, changed: false };
  return { next, changed: true };
}

function mergeConfig(options?: CompressionEngineApplyOptions): TrimOptions & { enabled: boolean } {
  const step = options?.stepConfig ?? {};
  const cfg = (options?.config as unknown as Record<string, unknown> | undefined)?.["toolSchema"];
  const source = isRecord(cfg) ? { ...cfg, ...step } : step;
  const hasExplicitEnabled =
    (isRecord(cfg) && "enabled" in (cfg as Record<string, unknown>)) || "enabled" in step;
  const maxDescriptionChars =
    typeof source["maxDescriptionChars"] === "number" &&
    Number.isFinite(source["maxDescriptionChars"])
      ? Math.min(2000, Math.max(10, Math.floor(source["maxDescriptionChars"] as number)))
      : DEFAULT_MAX_DESCRIPTION_CHARS;
  return {
    // DEFAULT_TOOL_SCHEMA_CONFIG.enabled=false: bare apply()/stepConfig without an
    // explicit `enabled` stays OFF. Selection in an explicit pipeline turns the
    // engine on via the strategySelector default (mirrors codex-responses), but a
    // direct apply() must never compress on an implicit default.
    enabled: hasExplicitEnabled ? source["enabled"] !== false : false,
    maxDescriptionChars,
    dropExamples: source["dropExamples"] !== false,
    dropVendorExtensions: source["dropVendorExtensions"] !== false,
  };
}

const TOOL_SCHEMA_SCHEMA: EngineConfigField[] = [
  { key: "enabled", type: "boolean", label: "Enabled", defaultValue: false },
  {
    key: "maxDescriptionChars",
    type: "number",
    label: "Max description chars",
    description: "Descriptions longer than this are truncated. Selection fields are never touched.",
    defaultValue: DEFAULT_MAX_DESCRIPTION_CHARS,
    min: 10,
    max: 2000,
  },
  {
    key: "dropExamples",
    type: "boolean",
    label: "Drop examples",
    description: "Remove `examples` annotation arrays from tool schemas.",
    defaultValue: true,
  },
  {
    key: "dropVendorExtensions",
    type: "boolean",
    label: "Drop vendor extensions",
    description: "Remove `x-*` vendor extension keys from tool schemas.",
    defaultValue: true,
  },
];

function validateToolSchemaConfig(config: Record<string, unknown>): EngineValidationResult {
  const errors: string[] = [];
  if (config["enabled"] !== undefined && typeof config["enabled"] !== "boolean") {
    errors.push("enabled must be a boolean");
  }
  if (config["maxDescriptionChars"] !== undefined) {
    const v = config["maxDescriptionChars"];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 10 || v > 2000) {
      errors.push("maxDescriptionChars must be a number between 10 and 2000");
    }
  }
  for (const key of ["dropExamples", "dropVendorExtensions"]) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      errors.push(`${key} must be a boolean`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export const toolSchemaEngine: CompressionEngine = {
  id: ENGINE_ID,
  name: "Tool Schema",
  description:
    "Annotation-only trimming of request tool definitions: drops x-* extensions, " +
    "examples, titles, and over-long descriptions while preserving names, types, " +
    "required, enums, defaults, const, and $ref. Fail-open.",
  icon: "build",
  targets: ["messages"],
  stackable: true,
  // stackPriority 6 = right after lite (5), before rtk (10). Disjoint scope
  // (body.tools vs message text) so order vs prose engines is immaterial.
  stackPriority: 6,
  metadata: {
    id: ENGINE_ID,
    name: "Tool Schema",
    description:
      "Trims annotation bloat from tool definitions; selection surface preserved verbatim.",
    inputScope: "messages",
    targetLatencyMs: 1,
    supportsPreview: true,
    stable: true,
  },

  apply(body: Record<string, unknown>, options?: CompressionEngineApplyOptions): CompressionResult {
    const config = mergeConfig(options);
    if (!config.enabled) return { body, compressed: false, stats: null };
    const tools = body["tools"];
    const functions = body["functions"];
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const hasFunctions = Array.isArray(functions) && functions.length > 0;
    if (!hasTools && !hasFunctions) {
      return { body, compressed: false, stats: null };
    }
    try {
      const start = performance.now();
      let changedCount = 0;
      let newBody: Record<string, unknown> = { ...body };
      if (hasTools) {
        const nextTools = (tools as unknown[]).map((entry) => {
          const { next, changed } = trimToolEntry(entry, config);
          if (changed) changedCount++;
          return next;
        });
        newBody = { ...newBody, tools: nextTools };
      }
      if (hasFunctions) {
        const nextFunctions = (functions as unknown[]).map((entry) => {
          const { next, changed } = trimToolEntry(entry, config);
          if (changed) changedCount++;
          return next;
        });
        newBody = { ...newBody, functions: nextFunctions };
      }
      if (changedCount === 0) return { body, compressed: false, stats: null };
      const durationMs = Math.round(performance.now() - start);
      const stats = createCompressionStats(
        body,
        newBody,
        "stacked",
        ["tool-schema-annotation-trim"],
        [`trimmed-${changedCount}-tools`],
        durationMs
      );
      return { body: newBody, compressed: true, stats };
    } catch {
      return { body, compressed: false, stats: null };
    }
  },

  compress(body: Record<string, unknown>, config?: Record<string, unknown>): CompressionResult {
    return this.apply(body, { stepConfig: config ?? {} });
  },

  getConfigSchema(): EngineConfigField[] {
    return TOOL_SCHEMA_SCHEMA;
  },

  validateConfig(config: Record<string, unknown>): EngineValidationResult {
    return validateToolSchemaConfig(config);
  },
};
