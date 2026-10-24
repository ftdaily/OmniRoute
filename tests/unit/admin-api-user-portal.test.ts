/**
 * pA-owned: admin PATCH /api/keys/[id] portal flags — real positive/negative.
 * Uses the shared management-session test helper (dashboard session JWT);
 * runs against the isolated temp DATA_DIR. Admin DTO path:
 * createApiKey -> PATCH {portalEnabled, userCombosEnabled, allowedConnections}
 * -> getApiKeyById flags. No raw key in responses.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-api-user-portal-"));
const ORIGINAL = {
  DATA_DIR: process.env.DATA_DIR,
  API_KEY_SECRET: process.env.API_KEY_SECRET,
  JWT_SECRET: process.env.JWT_SECRET,
  INITIAL_PASSWORD: process.env.INITIAL_PASSWORD,
  DISABLE_SQLITE_AUTO_BACKUP: process.env.DISABLE_SQLITE_AUTO_BACKUP,
};
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "admin-portal-api-key-secret";
process.env.JWT_SECRET = "admin-portal-jwt-secret";
process.env.INITIAL_PASSWORD = "admin-portal-password";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { makeManagementSessionRequest } = await import("../helpers/managementSession.ts");
const keysRoute = await import("../../src/app/api/keys/[id]/route.ts");

after(() => {
  core.resetDbInstance();
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function patchReq(id: string, body: unknown, headers?: Headers) {
  return makeManagementSessionRequest(`http://localhost/api/keys/${id}`, {
    method: "PATCH",
    headers,
    body: body as Record<string, unknown>,
  });
}

async function provisionKey() {
  const created = await apiKeysDb.createApiKey("admin-portal-key", "machine-admin-portal", [], {
    allowedConnections: ["11111111-1111-4111-8111-111111111111"],
  });
  return created;
}

describe("admin PATCH portal flags", () => {
  it("enables portal with a real connection row, persists flags on GET DTO", async () => {
    const providersDb = await import("../../src/lib/db/providers.ts");
    const conn = await providersDb.createProviderConnection({
      provider: "test-provider",
      authType: "apikey",
      name: "admin-portal-conn",
      apiKey: "sk-test-admin-portal-00000000",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    const connId = String((conn as { id: unknown }).id);
    const key = await provisionKey();
    const res = await keysRoute.PATCH(await patchReq(key.id, {
      portalEnabled: true,
      userCombosEnabled: true,
      allowedConnections: [connId],
    }), { params: Promise.resolve({ id: key.id }) });
    assert.equal(res.status, 200);
    const getRes = await keysRoute.GET(
      await makeManagementSessionRequest(`http://localhost/api/keys/${key.id}`, { method: "GET" }),
      { params: Promise.resolve({ id: key.id }) }
    );
    assert.equal(getRes.status, 200);
    const dto = (await getRes.json()) as Record<string, unknown>;
    assert.equal(dto.portalEnabled, true);
    assert.equal(dto.userCombosEnabled, true);
    assert.deepEqual(dto.allowedConnections, [connId]);
    assert.ok(!("key" in dto) || typeof dto.key === "string", "GET masks raw key");
    if (typeof dto.key === "string") assert.match(dto.key, /\*\*\*\*/);
  });

  it("rejects unknown connection ids and empty-grant enable (atomic, flags stay off)", async () => {
    const key = await provisionKey();
    // Grant references a connection id with no provider_connections row -> 400.
    const res = await keysRoute.PATCH(await patchReq(key.id, {
      portalEnabled: true,
      userCombosEnabled: true,
      allowedConnections: ["22222222-2222-4222-8222-222222222222"],
    }), { params: Promise.resolve({ id: key.id }) });
    assert.equal(res.status, 400, "unknown connection id must 400");
    const bodyText = await res.text();
    assert.match(bodyText, /unknown connection/i);
    // Empty grant + enable -> 400 atomic, flags stay off.
    const res2 = await keysRoute.PATCH(await patchReq(key.id, {
      portalEnabled: true,
      allowedConnections: [],
    }), { params: Promise.resolve({ id: key.id }) });
    assert.equal(res2.status, 400);
    const after = await apiKeysDb.getApiKeyById(key.id);
    assert.equal((after as { portalEnabled?: boolean }).portalEnabled, false);
  });

  it("PATCH response never reveals the raw key", async () => {
    const key = await provisionKey();
    const res = await keysRoute.PATCH(await patchReq(key.id, {
      userCombosEnabled: false,
    }), { params: Promise.resolve({ id: key.id }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(!("key" in (body as Record<string, unknown>)) || (body as { key?: unknown }).key !== key.key);
  });
});
