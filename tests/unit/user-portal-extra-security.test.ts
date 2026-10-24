import test from "node:test";
import assert from "node:assert/strict";
process.env.API_KEY_SECRET ||= "portal-review-test-secret";
const { createApiKey, getApiKeyMetadata, isModelAllowedForKey, clearApiKeyCaches } = await import("../../src/lib/db/apiKeys.ts");
const { getDbInstance } = await import("../../src/lib/db/core.ts");
const { updateKeyPreferences } = await import("../../src/lib/db/userPortal.ts");
const { enforceApiKeyPolicy } = await import("../../src/shared/utils/apiKeyPolicy.ts");
async function fixture() {
  const key = await createApiKey("portal-unrestricted-review", "test");
  getDbInstance().prepare("UPDATE api_keys SET portal_enabled=1,allowed_connections=?,model_access_mode='all' WHERE id=?").run(JSON.stringify(["review-owned-connection"]), key.id);
  clearApiKeyCaches();
  return key;
}
test("personal disable applies even when admin model ceiling is unrestricted and permission cache was warmed", async () => {
  const key = await fixture();
  assert.equal(await isModelAllowedForKey(key.key, "openai/gpt-4o-mini"), true);
  await updateKeyPreferences(key.id, ["openai/gpt-4o-mini"], 0);
  const result = await enforceApiKeyPolicy(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key.key}` } }), "openai/gpt-4o-mini");
  assert.equal(result.rejection?.status, 403);
});
test("unsupported portal API categories fail closed rather than bypass personal preferences", async () => {
  const key = await fixture();
  const result = await enforceApiKeyPolicy(new Request("http://localhost/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${key.key}` } }), "openai/text-embedding-3-small");
  assert.equal(result.rejection?.status, 403);
});
