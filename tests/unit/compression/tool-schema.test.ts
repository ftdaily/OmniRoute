import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolSchemaEngine } from "../../../open-sse/services/compression/engines/tool-schema/index.ts";

function bodyWithTools(tools: unknown) {
  return { messages: [{ role: "user", content: "hi" }], tools };
}

const BLOATED_TOOL = {
  type: "function",
  function: {
    name: "search_files",
    description:
      "Search the codebase for files matching a pattern. This is a very long description that explains in great detail how the search works, including many usage examples, edge cases, performance notes, and historical background that far exceeds what the model needs to select and call the tool correctly in most situations.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search query string used to match against file contents. Supports full regular expression syntax with many elaborate details about escaping, flags, multiline handling, performance characteristics, and illustrative examples that bloat the schema well beyond necessity.",
          examples: ["foo.*bar", "TODO|FIXME", "class \\w+"],
          "x-extra": "drop me",
        },
        limit: {
          type: "number",
          description: "Max results.",
          default: 50,
          minimum: 1,
          maximum: 1000,
        },
        mode: { type: "string", enum: ["fast", "deep"], default: "fast" },
      },
      required: ["query"],
    },
  },
};

describe("tool-schema engine", () => {
  it("trims annotation bloat but preserves selection surface", () => {
    const body = bodyWithTools([BLOATED_TOOL]);
    const before = JSON.stringify(body).length;
    const result = toolSchemaEngine.apply(body, { stepConfig: { enabled: true } });
    assert.equal(result.compressed, true);
    const after = JSON.stringify(result.body).length;
    assert.ok(after < before, `expected smaller: ${before} -> ${after}`);
    const tool = (result.body.tools as Array<any>)[0].function;
    assert.equal(tool.name, "search_files");
    assert.deepEqual(tool.parameters.required, ["query"]);
    assert.equal(tool.parameters.properties.mode.enum.join(","), "fast,deep");
    assert.equal(tool.parameters.properties.limit.default, 50);
    assert.ok(String(tool.parameters.properties.query.description ?? "").length <= 120);
  });

  it("fail-open: invalid tool entries pass through untouched", () => {
    const body = bodyWithTools([{ broken: true }]);
    const result = toolSchemaEngine.apply(body, { stepConfig: { enabled: true } });
    assert.equal(result.compressed, false);
    assert.deepEqual(result.body, body);
  });

  it("skips bodies without tools", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const result = toolSchemaEngine.apply(body, { stepConfig: { enabled: true } });
    assert.equal(result.compressed, false);
  });
});

describe("tool-schema stacked wiring", () => {
  it("registers as a builtin engine with catalog + schema parity", async () => {
    const { registerBuiltinCompressionEngines } = await import(
      "../../../open-sse/services/compression/engines/index.ts"
    );
    const { listCompressionEngines } = await import(
      "../../../open-sse/services/compression/engines/registry.ts"
    );
    const { ENGINE_IDS, engineMeta } = await import(
      "../../../open-sse/services/compression/engineCatalog.ts"
    );
    const { stackedPipelineStepSchema, STACKED_PIPELINE_ENGINE_INTENSITIES } = await import(
      "../../../src/shared/validation/compressionConfigSchemas.ts"
    );
    registerBuiltinCompressionEngines();
    const ids = listCompressionEngines().map((e) => e.id);
    assert.ok(ids.includes("tool-schema"), "engine registered");
    assert.ok(ENGINE_IDS.includes("tool-schema"), "catalog lists tool-schema");
    assert.equal(engineMeta("tool-schema").isSingleMode, false);
    assert.equal(stackedPipelineStepSchema.safeParse({ engine: "tool-schema" }).success, true);
    assert.ok("tool-schema" in STACKED_PIPELINE_ENGINE_INTENSITIES);
  });

  it("derives into a stacked plan when toggled on", async () => {
    const { deriveDefaultPlan } = await import(
      "../../../open-sse/services/compression/deriveDefaultPlan.ts"
    );
    const plan = deriveDefaultPlan(
      { "tool-schema": { enabled: true }, lite: { enabled: true } } as never,
      true
    );
    assert.equal(plan.mode, "stacked");
    const ids = plan.stackedPipeline.map((s: { engine: string }) => s.engine);
    assert.ok(ids.includes("tool-schema"));
  });

  it("stacked run compresses tools via the pipeline path", async () => {
    const { applyStackedCompression } = await import(
      "../../../open-sse/services/compression/strategySelector.ts"
    );
    const { DEFAULT_COMPRESSION_CONFIG } = await import(
      "../../../open-sse/services/compression/types.ts"
    );
    const body = {
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          function: {
            name: "t",
            description: "d".repeat(300),
            parameters: { type: "object", properties: { a: { type: "string" } } },
          },
        },
      ],
    };
    const result = applyStackedCompression(body, [{ engine: "tool-schema" }], {
      config: {
        ...DEFAULT_COMPRESSION_CONFIG,
        toolSchema: { enabled: true, maxDescriptionChars: 120, dropExamples: true, dropVendorExtensions: true },
      },
    } as never);
    assert.equal(result.compressed, true);
    assert.ok(
      JSON.stringify(result.body).length < JSON.stringify(body).length,
      "stacked path shrinks tools"
    );
  });

  it("preserves $ref / const / nested required through a full trim", () => {
    const schema = {
      type: "object",
      $defs: {
        id: { type: "string", const: "fixed", description: "x".repeat(300) },
      },
      properties: {
        item: {
          $ref: "#/$defs/id",
          description: "y".repeat(300),
          examples: ["a"],
          "x-vendor": 1,
        },
        list: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      },
      required: ["item"],
    };
    const body = {
      messages: [{ role: "user", content: "go" }],
      tools: [{ type: "function", function: { name: "t", description: "d".repeat(300), parameters: schema } }],
    };
    const result = toolSchemaEngine.apply(body, { stepConfig: { enabled: true } });
    assert.equal(result.compressed, true);
    const params = (result.body.tools as Array<any>)[0].function.parameters;
    assert.equal(params.$defs.id.const, "fixed");
    assert.equal(params.properties.item.$ref, "#/$defs/id");
    assert.deepEqual(params.required, ["item"]);
    assert.deepEqual(params.properties.list.items.enum, ["a", "b"]);
    assert.ok(!("x-vendor" in params.properties.item));
    assert.ok(!("examples" in params.properties.item));
  });
});
