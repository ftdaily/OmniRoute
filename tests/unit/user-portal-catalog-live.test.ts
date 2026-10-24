import test from "node:test";
import assert from "node:assert/strict";
process.env.API_KEY_SECRET ||= "portal-catalog-live-test-secret";
test("portal catalog uses granted connection models and the public node prefix",async()=>{
 const {createApiKey}=await import("../../src/lib/db/apiKeys.ts");
 const {createProviderNode,createProviderConnection}=await import("../../src/lib/db/providers.ts");
 const {getDbInstance}=await import("../../src/lib/db/core.ts");
 const {getPortalModelsForKey}=await import("../../src/lib/userPortalPolicy.ts");
 const node=await createProviderNode({id:"openai-compatible-portal-test",type:"openai-compatible",name:"Portal test",prefix:"portaltest",apiType:"chat",baseUrl:"http://127.0.0.1:1/v1"});
 const a=await createProviderConnection({provider:node.id,name:"Granted",apiKey:"synthetic-a",isActive:true});
 const b=await createProviderConnection({provider:node.id,name:"Ungranted",apiKey:"synthetic-b",isActive:true});
 const db=getDbInstance();
 for(const [c,models]of [[a,[{id:"gpt-4o-mini"}]],[b,[{id:"ungranted-only"}]]]as const){db.prepare("INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES('syncedAvailableModels',?,?)").run(`${node.id}:${c.id}`,JSON.stringify(models));}
 const key=await createApiKey("Iskandar","test");
 db.prepare("UPDATE api_keys SET portal_enabled=1,allowed_connections=?,model_access_mode='all' WHERE id=?").run(JSON.stringify([a.id]),key.id);
 assert.deepEqual(await getPortalModelsForKey(key.id),[{id:"portaltest/gpt-4o-mini",disabled:false}]);
});
