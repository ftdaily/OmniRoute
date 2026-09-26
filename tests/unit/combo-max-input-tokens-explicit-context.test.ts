import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-max-input-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= "combo-max-input-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Regression: a combo whose operator set an explicit `context_length` advertised that value as
 * `context_length` but silently dropped `max_input_tokens` whenever its target's own input limit
 * was unsourced (a gateway model absent from the static registry, e.g. CodeBuddy CN's
 * `deepseek-v4.1-flash`). Clients that read `max_input_tokens` for the input budget then fell back
 * to a provider default (128k) even though the combo declared a 1M window.
 */
test("explicit combo context_length also advertises max_input_tokens for an unsourced target", async () => {
  await providersDb.createProviderConnection({
    provider: "codebuddy-cn",
    authType: "oauth",
    name: "cbcn-combo-max-input-test",
    accessToken: "cbcn-test-token",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  await combosDb.createCombo({
    name: "[CodeBuddyCN]_Deepseek_V4.1_Flash",
    strategy: "auto",
    models: ["codebuddy-cn/deepseek-v4.1-flash"],
    context_length: 1000000,
  });

  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  const combo = body.data.find((item) => item.id === "[CodeBuddyCN]_Deepseek_V4.1_Flash");

  assert.equal(response.status, 200);
  assert.ok(combo, "the combo must be listed");
  assert.equal(combo.context_length, 1000000);
  assert.equal(
    combo.max_input_tokens,
    1000000,
    "an unsourced target limit must not erase the operator-declared input window"
  );
});

/**
 * The bound: when a target *does* publish a smaller known input limit, the combo must still
 * advertise that smaller value rather than the optimistic explicit window.
 */
test("explicit combo context_length stays bounded by a smaller known target limit", async () => {
  const modelId = "gpt-5.6-terra-bounded";
  const contextOverrides = await import("../../src/lib/db/modelContextOverrides.ts");
  assert.equal(contextOverrides.setModelContextOverride("codex", modelId, 500000), true);

  try {
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "codex-bounded-max-input-test",
      accessToken: "codex-test-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    await combosDb.createCombo({
      name: "bounded-context-combo",
      strategy: "auto",
      models: [`codex/${modelId}`],
      context_length: 1000000,
    });

    const response = await catalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    const combo = body.data.find((item) => item.id === "bounded-context-combo");

    assert.ok(combo);
    assert.equal(combo.context_length, 1000000);
    assert.equal(
      combo.max_input_tokens,
      500000,
      "the effective input window is the smallest known target limit"
    );
  } finally {
    contextOverrides.removeModelContextOverride("codex", modelId);
  }
});
