/**
 * pA-owned: retired(rotated)-key regression. Warm valid chat -> regenerate ->
 * old raw key must 401 on chat with NO upstream dispatch; new raw key 200s.
 * Synthetic env / local-anonymous paths unchanged. Real pipeline + call-log
 * evidence, isolated temp DATA_DIR.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "user-portal-retired-key-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "retired-key-api-key-secret";
process.env.JWT_SECRET = "retired-key-jwt-secret";
process.env.INITIAL_PASSWORD = "retired-key-password";
delete process.env.ALLOW_API_KEY_REVEAL;

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const callLogsDb = await import("../../src/lib/usage/callLogs.ts");
const { handleChat } = await import("../../src/sse/handlers/chat.ts");

const PROVIDER = "openai";
const MODEL = "openai/gpt-4o-mini";

function installRecordingFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any = {}) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    void url;
    void body;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  return () => {
    globalThis.fetch = original;
  };
}

async function createConnection(name: string): Promise<string> {
  const conn = await providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name,
    apiKey: `sk-${Math.random().toString(36).slice(2, 10)}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  return String(conn.id);
}

async function countUpstream(connectionId: string): Promise<number> {
  const rows = await callLogsDb.getCallLogs({ limit: 200 });
  if (!Array.isArray(rows)) return 0;
  return rows.filter((row: { connectionId?: string | null }) => row?.connectionId === connectionId)
    .length;
}

function chatReq(rawKey: string | null, model: string = MODEL) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (rawKey) headers["authorization"] = `Bearer ${rawKey}`;
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
}

test("retired key: warm chat -> regenerate -> old 401s silent, new 200s", async (t) => {
  const restore = installRecordingFetch();
  t.after(() => {
    restore();
    resetDb();
  });
  const resetDb = () => core.resetDbInstance();

  const conn = await createConnection("retired-conn");
  const created = (await apiKeysDb.createApiKey("retired-key", "machine-test")) as {
    id: string;
    key: string;
  };
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    allowedConnections: [conn],
    allowedModels: [MODEL],
    allowedCombos: ["combo/*"],
    portalEnabled: true,
    userCombosEnabled: true,
  });
  const full0 = await apiKeysDb.getApiKeyById(created.id);
  const oldRaw = (full0 as unknown as { key: string }).key;
  assert.ok(oldRaw);

  // Warm: valid chat dispatches exactly once.
  const warm = await handleChat(chatReq(oldRaw));
  assert.equal(warm.status, 200);
  assert.equal(await countUpstream(conn), 1);

  // Rotate: same id, new secret.
  const rotated = await apiKeysDb.regenerateApiKey(created.id);
  assert.ok(rotated);
  assert.equal(rotated.id, created.id);
  const full1 = await apiKeysDb.getApiKeyById(created.id);
  const newRaw = (full1 as unknown as { key: string }).key;
  assert.ok(newRaw && newRaw !== oldRaw);

  // Tombstone assertion: rotated-out hash recorded, new hash not retired.
  const tombDb = core.getDbInstance();
  assert.equal(
    apiKeysDb.isRetiredApiKeyHash(tombDb, await apiKeysDb.hashKey(oldRaw)),
    true,
    "rotated-out hash must be tombstoned"
  );
  assert.equal(
    apiKeysDb.isRetiredApiKeyHash(tombDb, await apiKeysDb.hashKey(newRaw)),
    false,
    "live hash must not be tombstoned"
  );

  // Old key: 401 immediately, no new upstream dispatch.
  const retired = await handleChat(chatReq(oldRaw));
  assert.equal(retired.status, 401);
  assert.equal(await countUpstream(conn), 1, "retired key must not dispatch upstream");

  // REQUIRE_API_KEY=false: retired key still 401, never anonymous.
  process.env.REQUIRE_API_KEY = "false";
  try {
    const retiredAnon = await handleChat(chatReq(oldRaw));
    assert.equal(retiredAnon.status, 401, "retired key must 401 even with REQUIRE_API_KEY=false");
  } finally {
    delete process.env.REQUIRE_API_KEY;
  }

  // New key: 200 + dispatch.
  const fresh = await handleChat(chatReq(newRaw));
  assert.equal(fresh.status, 200);
  assert.equal(await countUpstream(conn), 2);
});

test("rotation rolls back when the tombstone write fails (no lost trace)", async (t) => {
  const restore = installRecordingFetch();
  t.after(() => {
    restore();
    core.resetDbInstance();
  });
  const conn = await createConnection("rollback-conn");
  const created = (await apiKeysDb.createApiKey("rollback-key", "machine-test")) as {
    id: string;
    key: string;
  };
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    allowedConnections: [conn],
    allowedModels: [MODEL],
    allowedCombos: ["combo/*"],
  });
  const before = (await apiKeysDb.getApiKeyById(created.id)) as unknown as { key: string };
  assert.ok(before?.key);

  // Fault-inject the tombstone INSERT only: every other statement passes.
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => { run: (...a: unknown[]) => unknown };
  };
  const realPrepare = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = ((sql: string) => {
    const stmt = realPrepare(sql);
    if (typeof sql === "string" && sql.includes("retired_api_key_hashes")) {
      return {
        ...stmt,
        run: () => {
          throw new Error("injected tombstone failure");
        },
      };
    }
    return stmt;
  }) as typeof db.prepare;
  let threw = false;
  try {
    await apiKeysDb.regenerateApiKey(created.id);
  } catch (e) {
    threw = true;
    assert.match(String(e), /injected tombstone failure/);
  } finally {
    (db as { prepare: unknown }).prepare = realPrepare;
  }
  assert.equal(threw, true, "rotation must throw when the tombstone write fails");

  // Rollback proof: live secret unchanged, old secret validates, no tombstone.
  const after = (await apiKeysDb.getApiKeyById(created.id)) as unknown as { key: string };
  assert.equal(after.key, before.key, "failed rotation must leave the live secret unchanged");
  assert.equal(
    await apiKeysDb.validateApiKey(before.key),
    true,
    "pre-rotation secret must still validate"
  );
  assert.equal(
    apiKeysDb.isRetiredApiKeyHash(core.getDbInstance(), await apiKeysDb.hashKey(before.key)),
    false,
    "no tombstone may exist for a rotation that rolled back"
  );
});

test("tombstone lookup failure → 503, never anonymous (REQUIRE_API_KEY=false)", async (t) => {
  const restore = installRecordingFetch();
  t.after(() => {
    restore();
    core.resetDbInstance();
  });
  const conn = await createConnection("scope503-conn");
  const created = (await apiKeysDb.createApiKey("scope503-key", "machine-test")) as {
    id: string;
    key: string;
  };
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    allowedConnections: [conn],
    allowedModels: [MODEL],
    allowedCombos: ["combo/*"],
  });
  const full = (await apiKeysDb.getApiKeyById(created.id)) as unknown as { key: string };
  const oldRaw = full.key;
  await apiKeysDb.regenerateApiKey(created.id);

  // Break the tombstone lookup: getApiKeyMetadata(old) → null, then the
  // tombstone SELECT throws → enforceApiKeyPolicy must map to 503 (its catch),
  // never anonymous, even with REQUIRE_API_KEY=false.
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => { get: (...a: unknown[]) => unknown };
  };
  const realPrepare = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = ((sql: string) => {
    const stmt = realPrepare(sql);
    if (typeof sql === "string" && sql.includes("retired_api_key_hashes")) {
      return {
        ...stmt,
        get: () => {
          throw new Error("injected tombstone read failure");
        },
      };
    }
    return stmt;
  }) as typeof db.prepare;
  process.env.REQUIRE_API_KEY = "false";
  try {
    const res = await handleChat(chatReq(oldRaw));
    assert.equal(res.status, 503, "tombstone lookup failure must 503, never anonymous");
  } finally {
    delete process.env.REQUIRE_API_KEY;
    (db as { prepare: unknown }).prepare = realPrepare;
  }
});

test("local anonymous (no key) still reaches local/session path unchanged", async (t) => {
  const restore = installRecordingFetch();
  t.after(() => {
    restore();
    core.resetDbInstance();
  });
  // No Authorization header: enforceApiKeyPolicy must take the local/session
  // branch, never the 401-for-explicit-invalid-key path.
  const res = await handleChat(chatReq(null));
  assert.ok([200, 400, 403, 404].includes(res.status), `anonymous must not 500, got ${res.status}`);
  assert.notEqual(res.status, 401, "anonymous local mode is not an invalid-key 401");
});
