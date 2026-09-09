import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyCompressionAsync } from "../../../open-sse/services/compression/index.ts";
import { registerBuiltinCompressionEngines } from "../../../open-sse/services/compression/engines/index.ts";
import { setEngineEnabled } from "../../../open-sse/services/compression/engines/registry.ts";

// Regression: explicit pipeline selection is itself the enablement signal.
// Every explicit stacked selection forces `enabled: true` after global detail
// merges. Only that step's own `{ enabled: false }` is an opt-out.
//
// Real blocker (Integration ba6feca6d): a selected codex-responses stacked
// step was disabled by persisted codexResponsesConfig.enabled=false merged
// through resolveStepDetailConfig → buildStepOptions, because the
// selection-default only fired when stepConfig.enabled was undefined
// (but the merged global had already set it to false).

function codexInput() {
  const output = JSON.stringify(
    { data: Array.from({ length: 20 }, (_, i) => ({ id: i, status: "ok" })) },
    null,
    2
  );
  return [
    { type: "function_call", call_id: "run-1", name: "run_command", arguments: "{}" },
    { type: "function_call_output", call_id: "run-1", output },
  ];
}

describe("generic stacked pipeline selection overrides persisted enabled:false", () => {
  it("codex-responses runs when selected despite codexResponsesConfig.enabled=false", async () => {
    const stacked = await applyCompressionAsync({ input: codexInput() }, "stacked", {
      config: {
        codexResponsesConfig: { enabled: false },
        stackedPipeline: [{ engine: "codex-responses" as const }],
      },
    });
    assert.equal(stacked.compressed, true);
  });

  it("codex-responses runs when explicitly selected despite registry disabled", async () => {
    registerBuiltinCompressionEngines();
    setEngineEnabled("codex-responses", false);
    try {
      const stacked = await applyCompressionAsync({ input: codexInput() }, "stacked", {
        config: { stackedPipeline: [{ engine: "codex-responses" as const }] } as never,
      });
      assert.equal(stacked.compressed, true);
    } finally {
      setEngineEnabled("codex-responses", true);
    }
  });

  it("codex-responses still honors an explicit per-step enabled:false opt-out", async () => {
    const stacked = await applyCompressionAsync({ input: codexInput() }, "stacked", {
      config: {
        stackedPipeline: [{ engine: "codex-responses", config: { enabled: false } }],
      },
    });
    assert.equal(stacked.compressed, false);
  });

  it("tool-schema runs when selected despite persisted toolSchema.enabled=false", async () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "search_files",
          description: "d".repeat(300),
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "q".repeat(100) } },
            required: ["query"],
          },
        },
      },
    ];
    const stacked = await applyCompressionAsync(
      { messages: [{ role: "user", content: "go" }], tools },
      "stacked",
      {
        config: {
          toolSchema: { enabled: false },
          stackedPipeline: [{ engine: "tool-schema" as const }],
        },
      }
    );
    assert.equal(stacked.compressed, true);
  });

  it("tool-schema still honors an explicit per-step enabled:false opt-out", async () => {
    const stacked = await applyCompressionAsync(
      { messages: [{ role: "user", content: "go" }] },
      "stacked",
      {
        config: {
          stackedPipeline: [{ engine: "tool-schema", config: { enabled: false } }],
        },
      }
    );
    assert.equal(stacked.compressed, false);
  });
});
