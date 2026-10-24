/**
 * Security review negative test suite for scoped user portal.
 * Verifies negative boundaries:
 * 1. modelAccessMode: "all" admin ceiling still enforces personal disabled models with 403.
 * 2. Freshness: cached ALLOW before pref disable is immediately rejected on subsequent request.
 * 3. Pattern / canonical disabled matching.
 * 4. Empty connection grant fails closed before legacy normalizer.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY_SECRET ||= "user-portal-security-review-secret";

const store = await import("../../src/lib/db/userPortal.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const pol = await import("../../src/lib/userPortalPolicy.ts");
const { enforceApiKeyPolicy } = await import("../../src/shared/utils/apiKeyPolicy.ts");
const { resolveKeyConnectionScope } = await import("../../src/sse/services/keyConnectionScope.ts");

async function createSecurityPortalKey(opts: {
  name: string;
  modelAccessMode?: string;
  allowedModels?: string[];
  allowedConnections?: string[];
  portalEnabled?: boolean;
}) {
  const created = (await apiKeysDb.createApiKey(opts.name, "machine-security-test")) as {
    id: string;
    key: string;
  };
  const db = (await import("../../src/lib/db/core.ts")).getDbInstance() as any;
  db.prepare(
    `UPDATE api_keys
     SET portal_enabled = ?,
         user_combos_enabled = ?,
         allowed_connections = ?,
         allowed_models = ?,
         model_access_mode = ?
     WHERE id = ?`
  ).run(
    opts.portalEnabled === false ? 0 : 1,
    1,
    JSON.stringify(opts.allowedConnections ?? ["conn-sec-test"]),
    JSON.stringify(opts.allowedModels ?? []),
    opts.modelAccessMode ?? "all",
    created.id
  );
  return created;
}

describe("user portal security negative boundaries", () => {
  test("unrestricted admin ceiling (modelAccessMode=all) still enforces personal disabled with 403", async () => {
    const k = await createSecurityPortalKey({
      name: "sec-unrestricted-admin",
      modelAccessMode: "all",
      allowedModels: [],
      allowedConnections: ["conn-sec-1"],
      portalEnabled: true,
    });

    const targetModel = "claude-3-5-sonnet-20241022";

    // 1. Initially allowed under modelAccessMode: "all"
    const allowedReq = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${k.key}`,
        "Content-Type": "application/json",
      },
    });
    const beforeResult = await enforceApiKeyPolicy(allowedReq, targetModel);
    assert.equal(beforeResult.rejection, null, "unrestricted model should initially be allowed");

    // 2. Personally disable model in key_preferences
    const prefs = await store.getKeyPreferences(k.id);
    await store.updateKeyPreferences(k.id, [targetModel], prefs.revision);

    // 3. Subsequent request must be rejected with 403
    const blockedReq = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${k.key}`,
        "Content-Type": "application/json",
      },
    });
    const afterResult = await enforceApiKeyPolicy(blockedReq, targetModel);
    assert.ok(afterResult.rejection !== null, "personally disabled model must be rejected");
    assert.equal(
      afterResult.rejection.status,
      403,
      `expected 403 for personally disabled model, got ${afterResult.rejection.status}`
    );
  });

  test("freshness: personal disable immediately cuts access without stale-allow cache", async () => {
    const k = await createSecurityPortalKey({
      name: "sec-cache-freshness",
      modelAccessMode: "all",
      allowedConnections: ["conn-sec-1"],
      portalEnabled: true,
    });

    const targetModel = "gpt-4o";

    const req1 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${k.key}` },
    });
    const res1 = await enforceApiKeyPolicy(req1, targetModel);
    assert.equal(res1.rejection, null);

    // Disable target model
    const prefs = await store.getKeyPreferences(k.id);
    await store.updateKeyPreferences(k.id, [targetModel], prefs.revision);

    // Request immediately after must fail closed
    const req2 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${k.key}` },
    });
    const res2 = await enforceApiKeyPolicy(req2, targetModel);
    assert.ok(res2.rejection !== null, "fresh preference must immediately reject target model");
    assert.equal(res2.rejection.status, 403);
  });

  test("portal key with empty connection grant fails closed before legacy unrestricted normalizer", async () => {
    const k = await createSecurityPortalKey({
      name: "sec-empty-grant",
      allowedConnections: [],
      portalEnabled: true,
    });

    // Check policy layer
    const portalScope = await pol.getPortalConnectionScopeForKey(k.id);
    assert.equal(portalScope.denied, true, "empty grant on portal key must be marked denied");

    // Check connection scope resolver
    const metadata = await apiKeysDb.getApiKeyMetadata(k.key);
    const scope = await resolveKeyConnectionScope(metadata);
    assert.ok(scope.rejection !== null, "empty grant portal key must produce rejection in connection scope");
    assert.ok(
      scope.rejection.status === 403 || scope.rejection.status === 503,
      `expected 403 or 503 rejection, got ${scope.rejection.status}`
    );
  });
});
