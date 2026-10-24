import test from "node:test";
import assert from "node:assert/strict";
process.env.API_KEY_SECRET ||= "portal-catalog-test-secret";
const keys=await import("../../src/lib/db/apiKeys.ts");
const store=await import("../../src/lib/db/userPortal.ts");
const {getDbInstance}=await import("../../src/lib/db/core.ts");
const {getPortalModelsForKey}=await import("../../src/lib/userPortalPolicy.ts");
test("disabled catalog entry remains visible and reenable immediately clears a cached model denial",async()=>{
 const k=await keys.createApiKey("catalog-review","test");
 getDbInstance().prepare("UPDATE api_keys SET portal_enabled=1,allowed_connections=?,model_access_mode='all' WHERE id=?").run(JSON.stringify(["catalog-connection"]),k.id);
 keys.clearApiKeyCaches();
 assert.equal(await keys.isModelAllowedForKey(k.key,"openai/gpt-4o-mini"),true);
 await store.updateKeyPreferences(k.id,["openai/gpt-4o-mini"],0);
 assert.equal(await keys.isModelAllowedForKey(k.key,"openai/gpt-4o-mini"),false);
 const rows=await getPortalModelsForKey(k.id,k.key,["openai/gpt-4o-mini"]);
 assert.deepEqual(rows,[{id:"openai/gpt-4o-mini",disabled:true}]);
 await store.updateKeyPreferences(k.id,[],1);
 assert.equal(await keys.isModelAllowedForKey(k.key,"openai/gpt-4o-mini"),true);
});
