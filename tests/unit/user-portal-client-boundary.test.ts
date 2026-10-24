/**
 * pA-owned: CLIENT_API portal boundary. Portal-enabled keys may only touch the
 * MVP inference surface (chat/completions, responses, models); every other
 * CLIENT_API path (files/batches/queued/unknown) => 403. Legacy keys unchanged.
 * DB error => fail-closed 503. Real DB fixture, no getPortalKeyState mocks.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "user-portal-client-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "client-boundary-api-key-secret";
process.env.JWT_SECRET = "client-boundary-jwt-secret";
process.env.INITIAL_PASSWORD = "client-boundary-password";

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { clientApiPolicy } = await import("../../src/server/authz/policies/clientApi.ts");

after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function provisionPortalKey(): Promise<{ raw: string; id: string }> {
  const created = await apiKeysDb.createApiKey("client-boundary", "machine-client", [], {
    allowedConnections: ["33333333-3333-4333-8333-333333333333"],
  });
  await apiKeysDb.updateApiKeyPermissions(created.id, { portalEnabled: true });
  const full = await apiKeysDb.getApiKeyById(created.id);
  return { raw: (full as unknown as { key: string }).key, id: created.id };
}

function ctx(rawKey: string, normalizedPath: string, method = "POST") {
  return {
    request: {
      method,
      headers: new Headers({ authorization: `Bearer ${rawKey}` }),
      url: `http://localhost${normalizedPath}`,
    },
    classification: { routeClass: "CLIENT_API", reason: "client_api_v1", normalizedPath },
    requestId: "t",
  } as any;
}

describe("clientApi portal boundary RED", () => {
  it("portal key denied on /api/v1/batches, allowed on chat + models", async () => {
    const { raw } = await provisionPortalKey();
    const denied = await clientApiPolicy.evaluate(ctx(raw, "/api/v1/batches"));
    assert.equal(denied.allow, false);
    assert.equal((denied as { status?: number }).status, 403);
    const chat = await clientApiPolicy.evaluate(ctx(raw, "/api/v1/chat/completions"));
    assert.equal(chat.allow, true);
    const models = await clientApiPolicy.evaluate(ctx(raw, "/api/v1/models", "GET"));
    assert.equal(models.allow, true);
  });

  it("stale metadata: cleared grant denies chat after update", async () => {
    const { raw, id } = await provisionPortalKey();
    await apiKeysDb.updateApiKeyPermissions(id, { allowedConnections: [] });
    const chat = await clientApiPolicy.evaluate(ctx(raw, "/api/v1/chat/completions"));
    assert.equal(chat.allow, false);
  });

  it("legacy key unchanged on batches", async () => {
    const created = await apiKeysDb.createApiKey("legacy-client", "machine-legacy", [], {});
    const full = await apiKeysDb.getApiKeyById(created.id);
    const out = await clientApiPolicy.evaluate(
      ctx((full as unknown as { key: string }).key, "/api/v1/batches")
    );
    assert.equal(out.allow, true);
  });
});
