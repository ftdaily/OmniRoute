import test from "node:test";
import assert from "node:assert/strict";
import { issueUserCsrfToken, validateUserCsrfToken } from "../../src/lib/userPortalHttp.ts";
process.env.JWT_SECRET = "user-csrf-origin-synthetic-secret";
test("valid session CSRF still rejects an evil Origin", async () => {
 const cookie="user_auth_token=synthetic-session";
 const issued=await issueUserCsrfToken(new Request("http://localhost:20129/api/user/auth/csrf",{headers:{cookie}}),"user_auth_token");
 assert.ok(issued);
 const headers={cookie,"x-omniroute-user-csrf":issued};
 assert.equal(validateUserCsrfToken(new Request("http://localhost:20129/api/user/preferences",{method:"PATCH",headers:{...headers,Origin:"https://evil.example"}}),"user_auth_token"),false);
 assert.equal(validateUserCsrfToken(new Request("http://localhost:20129/api/user/preferences",{method:"PATCH",headers:{...headers,Origin:"http://localhost:20129"}}),"user_auth_token"),true);
});
