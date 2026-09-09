import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.ts";
import { getAllToolDefinitions } from "../toolSearch/catalog.ts";
import {
  compressionControlTools,
  handleListCompressionEngines,
  handleGetCompressionEngine,
  handleUpdateCompressionEngine,
  handleListCompressionRules,
  handleListCompressionLanguagePacks,
  handleCompressionPreview,
  handleCompressionCompare,
} from "../tools/compressionControls.ts";

vi.mock("../audit.ts", () => ({
  logToolCall: vi.fn().mockResolvedValue(undefined),
  closeAuditDb: vi.fn(),
}));

export const NEW_COMPRESSION_CONTROL_TOOLS = [
  "omniroute_list_compression_engines",
  "omniroute_get_compression_engine",
  "omniroute_update_compression_engine",
  "omniroute_list_compression_rules",
  "omniroute_list_compression_language_packs",
  "omniroute_compression_preview",
  "omniroute_compression_compare",
] as const;

describe("compression controls registration", () => {
  it("registers all seven tools in compressionControlTools with the handler contract", () => {
    for (const name of NEW_COMPRESSION_CONTROL_TOOLS) {
      const toolDef = (compressionControlTools as Record<string, any>)[name];
      expect(toolDef, name).toBeDefined();
      expect(toolDef.name).toBe(name);
      expect(typeof toolDef.description).toBe("string");
      expect(toolDef.description.length).toBeGreaterThan(0);
      expect(typeof toolDef.inputSchema.parse).toBe("function");
      expect(typeof toolDef.handler).toBe("function");
      expect(Array.isArray(toolDef.scopes)).toBe(true);
    }
  });

  it("uses read:compression for listing/getting/preview/compare, write:compression for engine update", () => {
    const readTools = [
      "omniroute_list_compression_engines",
      "omniroute_get_compression_engine",
      "omniroute_list_compression_rules",
      "omniroute_list_compression_language_packs",
      "omniroute_compression_preview",
      "omniroute_compression_compare",
    ];
    for (const name of readTools) {
      expect((compressionControlTools as Record<string, any>)[name].scopes).toContain(
        "read:compression"
      );
    }
    expect(
      (compressionControlTools as Record<string, any>)["omniroute_update_compression_engine"].scopes
    ).toContain("write:compression");
  });

  it("appears exactly once in the unified tool catalog", () => {
    const all = getAllToolDefinitions();
    for (const name of NEW_COMPRESSION_CONTROL_TOOLS) {
      expect(all.filter((t) => t.name === name)).toHaveLength(1);
    }
    const names = all.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("validates input schemas", () => {
    const tools = compressionControlTools as Record<string, any>;
    expect(tools.omniroute_list_compression_engines.inputSchema.safeParse({}).success).toBe(true);
    expect(
      tools.omniroute_get_compression_engine.inputSchema.safeParse({ engineId: "caveman" }).success
    ).toBe(true);
    expect(tools.omniroute_get_compression_engine.inputSchema.safeParse({}).success).toBe(false);
    expect(
      tools.omniroute_update_compression_engine.inputSchema.safeParse({
        engineId: "caveman",
        enabled: false,
      }).success
    ).toBe(true);
    expect(
      tools.omniroute_compression_preview.inputSchema.safeParse({ text: "hello" }).success
    ).toBe(true);
    expect(tools.omniroute_compression_preview.inputSchema.safeParse({}).success).toBe(false);
    expect(tools.omniroute_compression_compare.inputSchema.safeParse({ text: "x" }).success).toBe(
      true
    );
  });
});

describe("compression controls live registration", () => {
  let client: Client;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverTransport);
    client = new Client({ name: "compression-controls-test", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
  });

  it("announces the new tools via tools/list", async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const name of NEW_COMPRESSION_CONTROL_TOOLS) {
      expect(names.has(name), name).toBe(true);
    }
  });
});

describe("compression engine handlers", () => {
  it("lists builtin engines with config schemas", async () => {
    const { engines } = await handleListCompressionEngines({});
    expect(engines.length).toBeGreaterThanOrEqual(8);
    const ids = engines.map((e: { id: string }) => e.id);
    for (const id of ["lite", "caveman", "rtk", "ccr"]) {
      expect(ids).toContain(id);
    }
    for (const engine of engines) {
      expect(typeof engine.id).toBe("string");
      expect(typeof engine.name).toBe("string");
      expect(Array.isArray(engine.configSchema)).toBe(true);
      expect(typeof engine.enabled).toBe("boolean");
    }
  });

  it("gets a single engine with runtime config", async () => {
    const engine = await handleGetCompressionEngine({ engineId: "caveman" });
    expect(engine.id).toBe("caveman");
    expect(typeof engine.enabled).toBe("boolean");
    expect(typeof engine.config).toBe("object");
    expect(Array.isArray(engine.configSchema)).toBe(true);
  });

  it("rejects unknown engine ids on get", async () => {
    await expect(handleGetCompressionEngine({ engineId: "nope" })).rejects.toThrow(
      /Unknown compression engine/
    );
  });

  it("updates an engine config with validation and restores it", async () => {
    const before = await handleGetCompressionEngine({ engineId: "lite" });
    const result = await handleUpdateCompressionEngine({
      engineId: "lite",
      config: { compressToolResults: true },
    });
    expect(result.success).toBe(true);
    expect(result.engineId).toBe("lite");
    await handleUpdateCompressionEngine({
      engineId: "lite",
      config: before.config as Record<string, unknown>,
      enabled: before.enabled,
    });
  });

  it("rejects unknown engine ids and invalid configs on update", async () => {
    await expect(handleUpdateCompressionEngine({ engineId: "nope", config: {} })).rejects.toThrow(
      /Unknown compression engine/
    );
    await expect(
      handleUpdateCompressionEngine({ engineId: "lite", config: { compressToolResults: "yes" } })
    ).rejects.toThrow();
  });
});

describe("compression rules / language-pack handlers", () => {
  it("lists caveman rule metadata", async () => {
    const { rules } = await handleListCompressionRules({});
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules.slice(0, 5)) {
      expect(typeof rule.name).toBe("string");
      expect(typeof rule.minIntensity).toBe("string");
    }
  });

  it("filters rules by intensity", async () => {
    const all = await handleListCompressionRules({});
    const lite = await handleListCompressionRules({ intensity: "lite" });
    expect(lite.rules.length).toBeGreaterThan(0);
    expect(lite.rules.length).toBeLessThanOrEqual(all.rules.length);
  });

  it("lists supported languages and rule packs", async () => {
    const { languages, packs } = await handleListCompressionLanguagePacks({});
    expect(languages).toContain("en");
    expect(Array.isArray(packs)).toBe(true);
  });
});

describe("compression studio handlers", () => {
  const FILLER_TEXT =
    "Sure! I would be happy to help you with that. Basically, the issue is just that the database connection is really slow because of the fact that there are too many connections. ";

  it("previews compression for filler-heavy text", async () => {
    const result = await handleCompressionPreview({ text: FILLER_TEXT.repeat(8) });
    expect(result.originalTokens).toBeGreaterThan(0);
    expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
    expect(result.tokensSaved).toBe(result.originalTokens - result.compressedTokens);
    expect(typeof result.compressedText).toBe("string");
    expect(result.compressedText.length).toBeGreaterThan(0);
    expect(Array.isArray(result.techniquesUsed)).toBe(true);
  });

  it("preview returns the same text it token-counts (all messages joined, CCR-safe)", async () => {
    // CCR prepends a [CCR protocol] system message on first replace: the returned
    // text must include it (identical to the token-counted text), not skip to the
    // last non-system message. (The joined text can token-count slightly ABOVE the
    // bare input — the protocol instruction is new bytes — so only identity is
    // asserted here, not savings.)
    const big = "lorem ipsum dolor sit amet ".repeat(60);
    const result = await handleCompressionPreview({ text: big, engineId: "ccr" });
    const { estimateCompressionTokens } = await import(
      "../../services/compression/stats.ts"
    );
    expect(estimateCompressionTokens(result.compressedText)).toBe(result.compressedTokens);
    expect(result.compressedText).toContain("user:");
  });

  it("previews a single-engine run", async () => {
    const result = await handleCompressionPreview({
      text: FILLER_TEXT.repeat(8),
      engineId: "lite",
    });
    expect(result.mode).toBe("stacked");
    expect(result.originalTokens).toBeGreaterThan(0);
  });

  it("rejects unknown preview engines", async () => {
    await expect(
      handleCompressionPreview({ text: "hello world", engineId: "nope" })
    ).rejects.toThrow(/Unknown compression engine/);
  });

  it("compares engines best-first", async () => {
    const { rows } = await handleCompressionCompare({
      text: FILLER_TEXT.repeat(8),
      engineIds: ["lite", "caveman"],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].meanSavingsPercent).toBeGreaterThanOrEqual(rows[1].meanSavingsPercent);
    for (const row of rows) {
      expect(typeof row.engine).toBe("string");
      expect(typeof row.meanRetention).toBe("number");
    }
  });
});

describe("compression engine update persistence (BLOCKER)", () => {
  it("persists lite detail to SQLite and reads back the exact stored state", async () => {
    const { getCompressionSettings } = await import("../../../src/lib/db/compression.ts");
    const before = await getCompressionSettings();
    const target = !before.lite?.compressToolResults;
    const result = await handleUpdateCompressionEngine({
      engineId: "lite",
      config: { compressToolResults: target },
    });
    expect(result.success).toBe(true);
    const reread = await getCompressionSettings();
    expect(reread.lite?.compressToolResults).toBe(target);
    expect(result.config).toMatchObject({ compressToolResults: target });
    // Restore original so the suite leaves no residue.
    await handleUpdateCompressionEngine({
      engineId: "lite",
      config: { compressToolResults: before.lite?.compressToolResults ?? true },
      enabled: before.engines?.["lite"]?.enabled,
    });
  });

  it("persists the enabled toggle to the engines map (survives registry clear = restart)", async () => {
    const { getCompressionSettings } = await import("../../../src/lib/db/compression.ts");
    const { clearCompressionEngineRegistry } =
      await import("../../services/compression/engines/registry.ts");
    const { registerBuiltinCompressionEngines } =
      await import("../../services/compression/engines/index.ts");
    const { applyStackedCompression } =
      await import("../../services/compression/strategySelector.ts");
    const before = await getCompressionSettings();
    const targetEnabled = !(before.engines?.["session-dedup"]?.enabled ?? false);

    await handleUpdateCompressionEngine({ engineId: "session-dedup", enabled: targetEnabled });

    // Simulate a process restart: drop the in-memory registry, rebuild from builtins,
    // re-apply persisted settings — the toggle must come back from SQLite, not memory.
    clearCompressionEngineRegistry();
    registerBuiltinCompressionEngines();
    const persisted = await getCompressionSettings();
    expect(persisted.engines?.["session-dedup"]?.enabled).toBe(targetEnabled);

    // And the persisted toggle must actually gate stacked dispatch (suffix blocks
    // need ≥3 lines and ≥80 chars — build qualifying duplicate content).
    const dupBlock = [
      "alpha line one with enough characters to pass the gate",
      "beta line two with enough characters to pass the gate",
      "gamma line three with enough characters to pass the gate",
    ].join("\n");
    const body = {
      messages: [
        { role: "user", content: `intro first message\n${dupBlock}` },
        { role: "user", content: `intro second message\n${dupBlock}` },
      ],
    };
    const out = applyStackedCompression(body, [{ engine: "session-dedup" }], {
      config: persisted,
    } as never);
    expect(out.compressed).toBe(targetEnabled);

    // Restore original toggle.
    await handleUpdateCompressionEngine({
      engineId: "session-dedup",
      enabled: before.engines?.["session-dedup"]?.enabled ?? false,
    });
  });

  it("carries the write:compression scope (update is a write, not a read)", () => {
    const toolDef = (compressionControlTools as Record<string, { scopes: string[] }>)[
      "omniroute_update_compression_engine"
    ];
    expect(toolDef.scopes).toContain("write:compression");
    expect(toolDef.scopes).not.toContain("read:compression");
  });

  it("persists EVERY catalog engine detail or rejects it explicitly (no silent drops)", async () => {
    const { getCompressionSettings } = await import("../../../src/lib/db/compression.ts");
    const { ENGINE_IDS } = await import(
      "../../services/compression/engineCatalog.ts"
    );
    // One representative detail field per engine with a canonical sub-object.
    // Engines whose config surface is toggle-only are covered by the restart test.
    const detailCases: Array<{ engineId: string; config: Record<string, unknown>; check: (s: never) => unknown; expected: unknown }> = [
      {
        engineId: "relevance",
        config: { overlapThreshold: 0.42 },
        check: (s) => (s as { relevanceConfig?: { overlapThreshold?: number } }).relevanceConfig?.overlapThreshold,
        expected: 0.42,
      },
      {
        engineId: "llmlingua",
        config: { minTokens: 4321 },
        check: (s) => (s as { llmlingua?: { minTokens?: number } }).llmlingua?.minTokens,
        expected: 4321,
      },
      {
        engineId: "rtk",
        config: { maxLinesPerResult: 4321 },
        check: (s) => (s as { rtkConfig?: { maxLinesPerResult?: number } }).rtkConfig?.maxLinesPerResult,
        expected: 4321,
      },
      {
        engineId: "caveman",
        config: { minMessageLength: 4321 },
        check: (s) => (s as { cavemanConfig?: { minMessageLength?: number } }).cavemanConfig?.minMessageLength,
        expected: 4321,
      },
      {
        engineId: "aggressive",
        config: { maxTokensPerMessage: 4321 },
        check: (s) => (s as { aggressive?: { maxTokensPerMessage?: number } }).aggressive?.maxTokensPerMessage,
        expected: 4321,
      },
      {
        engineId: "ultra",
        config: { maxTokensPerMessage: 4321 },
        check: (s) => (s as { ultra?: { maxTokensPerMessage?: number } }).ultra?.maxTokensPerMessage,
        expected: 4321,
      },
      {
        engineId: "omniglyph",
        config: { profile: "balanced" },
        check: (s) => (s as { omniglyph?: { profile?: string } }).omniglyph?.profile,
        expected: "balanced",
      },
      {
        engineId: "headroom",
        config: { minRows: 7 },
        check: (s) => (s as { headroom?: { minRows?: number } }).headroom?.minRows,
        expected: 7,
      },
    ];
    const before = await getCompressionSettings();
    for (const c of detailCases) {
      if (!ENGINE_IDS.includes(c.engineId)) continue;
      const result = await handleUpdateCompressionEngine({ engineId: c.engineId, config: c.config });
      expect(result.success).toBe(true);
      const reread = await getCompressionSettings();
      expect(
        c.check(reread as never),
        `${c.engineId} detail must persist to SQLite (or the update must reject)`
      ).toBe(c.expected);
    }
    // Restore originals.
    const b = before as unknown as Record<string, Record<string, unknown> | undefined>;
    await handleUpdateCompressionEngine({ engineId: "relevance", config: { overlapThreshold: (b["relevanceConfig"] as Record<string, unknown> | undefined)?.["overlapThreshold"] ?? 0.1 } });
    await handleUpdateCompressionEngine({ engineId: "llmlingua", config: { minTokens: (b["llmlingua"] as Record<string, unknown> | undefined)?.["minTokens"] ?? 2000 } });
    await handleUpdateCompressionEngine({ engineId: "rtk", config: { maxLinesPerResult: (b["rtkConfig"] as Record<string, unknown> | undefined)?.["maxLinesPerResult"] ?? 40 } });
    await handleUpdateCompressionEngine({ engineId: "caveman", config: { minMessageLength: (b["cavemanConfig"] as Record<string, unknown> | undefined)?.["minMessageLength"] ?? 50 } });
    await handleUpdateCompressionEngine({ engineId: "aggressive", config: { maxTokensPerMessage: (b["aggressive"] as Record<string, unknown> | undefined)?.["maxTokensPerMessage"] ?? 4000 } });
    await handleUpdateCompressionEngine({ engineId: "ultra", config: { maxTokensPerMessage: (b["ultra"] as Record<string, unknown> | undefined)?.["maxTokensPerMessage"] ?? 4000 } });
    await handleUpdateCompressionEngine({ engineId: "omniglyph", config: { profile: (b["omniglyph"] as Record<string, unknown> | undefined)?.["profile"] ?? "aggressive" } });
    await handleUpdateCompressionEngine({ engineId: "headroom", config: { minRows: (b["headroom"] as Record<string, unknown> | undefined)?.["minRows"] ?? 8 } });
  });

  it("rejects detail config for read-lifecycle (no persistable sub-object)", async () => {
    // read-lifecycle is registered but has no canonical settings row: accepting its
    // config with success:true would be a silent drop. caveman/rtk/aggressive/ultra/
    // omniglyph/relevance/llmlingua/ionizer/llm all have rows now (see map above).
    await expect(
      handleUpdateCompressionEngine({ engineId: "read-lifecycle", config: { enabled: true } })
    ).rejects.toThrow(/no persistable/i);
    // Toggle-only updates still work for it.
    const r = await handleUpdateCompressionEngine({ engineId: "read-lifecycle", enabled: true });
    expect(r.success).toBe(true);
    await handleUpdateCompressionEngine({ engineId: "read-lifecycle", enabled: false });
  });
});
