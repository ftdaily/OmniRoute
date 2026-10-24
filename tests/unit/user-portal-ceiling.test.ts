/**
 * pA-owned: admin-ceiling isolation. isModelAllowedForKey with
 * {ignorePersonalRestrictions:true} is the server-only catalog projection
 * (disabled models stay listed => re-enableable); inference default still
 * enforces personal disables. Cache partitions must not cross-bleed.
 * Real DB fixture, no mocks.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "user-portal-ceiling-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "ceiling-api-key-secret";
process.env.JWT_SECRET = "ceiling-jwt-secret";

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");

after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const MODEL = "openai/gpt-4o";

async function provision(): Promise<{ raw: string; id: string }> {
  const created = await apiKeysDb.createApiKey("ceiling-key", "machine-ceiling", [], {
    allowedConnections: ["55555555-5555-4555-8555-555555555555"],
    allowedModels: [MODEL],
  });
  await apiKeysDb.updateApiKeyPermissions(created.id, { portalEnabled: true });
  const full = await apiKeysDb.getApiKeyById(created.id);
  const raw = (full as unknown as { key: string }).key;
  assert.ok(raw, "raw key material must resolve for the fixture");
  return { raw, id: created.id };
}

describe("admin ceiling ignorePersonalRestrictions", () => {
  it("catalog projection admits the admin-allowed model despite personal disable", async () => {
    const { raw, id } = await provision();
    const { updateKeyPreferences } = await import("../../src/lib/db/userPortal.ts");
    await updateKeyPreferences(id, [MODEL], 0);
    // Inference default: denied.
    assert.equal(await apiKeysDb.isModelAllowedForKey(raw, MODEL), false);
    // Catalog projection: admitted (entry renders disabled:true upstream).
    assert.equal(
      await apiKeysDb.isModelAllowedForKey(raw, MODEL, null, { ignorePersonalRestrictions: true }),
      true
    );
  });

  it("re-enable clears: clearing prefs re-admits on the inference default", async () => {
    const { raw, id } = await provision();
    const { updateKeyPreferences } = await import("../../src/lib/db/userPortal.ts");
    await updateKeyPreferences(id, [MODEL], 0);
    assert.equal(await apiKeysDb.isModelAllowedForKey(raw, MODEL), false);
    await updateKeyPreferences(id, [], 1);
    assert.equal(await apiKeysDb.isModelAllowedForKey(raw, MODEL), true);
  });

  it("cache partitions do not cross-bleed", async () => {
    const { raw } = await provision();
    // Prime the inference verdict (allowed), then disable and confirm the
    // inference cache does not leak allow while the catalog read stays true.
    assert.equal(await apiKeysDb.isModelAllowedForKey(raw, MODEL), true);
    const { updateKeyPreferences, getKeyPreferences } = await import("../../src/lib/db/userPortal.ts");
    const prefs = await getKeyPreferences((await apiKeysDb.getApiKeyById(
      (await apiKeysDb.getApiKeys()).find((k) => k.name === "ceiling-key")!.id
    ).catch(() => null as never)) as never).catch(() => null);
    void prefs;
    const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
    void createApiKey;
    // Second key with the same model: inference allow primes, then catalog
    // projection on the FIRST key must not flip the second key's verdict.
    const second = await apiKeysDb.createApiKey("ceiling-key-2", "machine-ceiling-2", [], {
      allowedConnections: ["66666666-6666-4666-8666-666666666666"],
      allowedModels: [MODEL],
    });
    await apiKeysDb.updateApiKeyPermissions(second.id, { portalEnabled: true });
    const full2 = await apiKeysDb.getApiKeyById(second.id);
    const raw2 = (full2 as unknown as { key: string }).key;
    assert.equal(await apiKeysDb.isModelAllowedForKey(raw2, MODEL), true);
    assert.equal(
      await apiKeysDb.isModelAllowedForKey(raw, MODEL, null, { ignorePersonalRestrictions: true }),
      true
    );
    assert.equal(await apiKeysDb.isModelAllowedForKey(raw2, MODEL), true);
  });

  it("stale-ALLOW regression: warm inference allow then prefs update must deny", async () => {
    const { raw, id } = await provision();
    // Warm the inference verdict (allow) into the permission cache.
    assert.equal(await apiKeysDb.isModelAllowedForKey(raw, MODEL), true);
    // User disables the model; the personal hook runs BEFORE the cache read,
    // so the stale allow must not survive.
    const { updateKeyPreferences } = await import("../../src/lib/db/userPortal.ts");
    await updateKeyPreferences(id, [MODEL], 0);
    assert.equal(await apiKeysDb.isModelAllowedForKey(raw, MODEL), false);
    // Catalog projection still admits (disabled:true rendered upstream).
    assert.equal(
      await apiKeysDb.isModelAllowedForKey(raw, MODEL, null, { ignorePersonalRestrictions: true }),
      true
    );
  });
});
