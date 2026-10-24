import test from "node:test";
import assert from "node:assert/strict";
process.env.API_KEY_SECRET ||= "portal-cross-bundle-test-secret";
const keys=await import("../../src/lib/db/apiKeys.ts");
const {getDbInstance}=await import("../../src/lib/db/core.ts");
test("warm auth and metadata do not survive a key-hash rotation performed by another bundle",async()=>{
 const k=await keys.createApiKey("cross-bundle-rotation","test");
 assert.equal(await keys.validateApiKey(k.key),true);
 assert.equal((await keys.getApiKeyMetadata(k.key))?.id,k.id);
 getDbInstance().prepare("UPDATE api_keys SET key_hash=? WHERE id=?").run('cross-bundle-new-hash',k.id);
 assert.equal(await keys.validateApiKey(k.key),false);
 assert.equal(await keys.getApiKeyMetadata(k.key),null);
});
test("warm model allow does not survive another bundle reducing admin policy",async()=>{
 const k=await keys.createApiKey("cross-bundle-policy","test");
 assert.equal(await keys.isModelAllowedForKey(k.key,"openai/gpt-4o-mini"),true);
 getDbInstance().prepare("UPDATE api_keys SET model_access_mode='restricted', allowed_models='[]' WHERE id=?").run(k.id);
 assert.equal(await keys.isModelAllowedForKey(k.key,"openai/gpt-4o-mini"),false);
});
