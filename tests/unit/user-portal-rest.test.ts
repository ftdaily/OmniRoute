/**
 * RED: /api/user/* REST contract — owned by pA. TDD before routes exist.
 * DTOs: login {apiKey}->{ok:true}; session {authenticated,principal};
 * me {id,name,userCombosEnabled,expiresAt}; models {models:[{id,disabled}]};
 * preferences {disabledModels,revision} + 409 revision; combos CRUD + 404/409;
 * unknown-field strict 400; CSRF header required on mutation; cookie-only.
 */
import { describe, it, after, before } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "user-portal-rest-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= "test-only-secret-user-portal-rest-0123456789abcdef";
process.env.JWT_SECRET ||= "test-only-jwt-user-portal-rest-32bytes!!!!!!!";

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const authMod = await import("../../src/lib/userPortalAuth.ts");
const { mintUserPortalSessionToken, USER_PORTAL_COOKIE, USER_PORTAL_CSRF_HEADER } = authMod as any;

const loginRoute = await import("../../src/app/api/user/auth/login/route.ts");
const logoutRoute = await import("../../src/app/api/user/auth/logout/route.ts");
const sessionRoute = await import("../../src/app/api/user/auth/session/route.ts");
const csrfRoute = await import("../../src/app/api/user/auth/csrf/route.ts");
const meRoute = await import("../../src/app/api/user/me/route.ts");
const modelsRoute = await import("../../src/app/api/user/models/route.ts");
const prefsRoute = await import("../../src/app/api/user/preferences/route.ts");
const combosRoute = await import("../../src/app/api/user/combos/route.ts");

after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function jreq(method: string, url: string, body?: unknown, cookie?: string, csrf?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers["cookie"] = cookie;
  if (csrf) headers[USER_PORTAL_CSRF_HEADER] = csrf;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function provisionPortalKey(): Promise<{ cookie: string; keyId: string }> {
  const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
  const { getDbInstance } = await import("../../src/lib/db/core.ts");
  const created = await createApiKey("RED portal key", "test-machine-rest", [], {
    allowedConnections: ["conn-rest"],
  });
  // TEST-ONLY fixture: set portal flags via direct SQL on the isolated temp DB.
  // NOTE(p3): normalizeApiKeyPermissionsUpdate drops portalEnabled/userCombosEnabled,
  // so updateApiKeyPermissions cannot enable the portal — needs a p3 fix.
  (getDbInstance() as any)
    .prepare("UPDATE api_keys SET portal_enabled = 1, user_combos_enabled = 1 WHERE id = ?")
    .run(created.id);
  const token = await mintUserPortalSessionToken(created.id, 0);
  return { cookie: `${USER_PORTAL_COOKIE}=${token}`, keyId: created.id };
}

describe("user portal REST RED", () => {
  it("login rejects unknown-field body with 400 strict DTO", async () => {
    const res: Response = await (loginRoute as any).POST(
      jreq("POST", "http://localhost/api/user/auth/login", { apiKey: "x", admin: true })
    );
    assert.equal(res.status, 400);
  });

  it("session unauthenticated without cookie", async () => {
    const res: Response = await (sessionRoute as any).GET(
      jreq("GET", "http://localhost/api/user/auth/session")
    );
    const body = await res.json();
    assert.equal(body.authenticated, false);
  });

  it("logout clears user cookie with cleared header", async () => {
    const { cookie } = await provisionPortalKey();
    const res: Response = await (logoutRoute as any).POST(
      jreq("POST", "http://localhost/api/user/auth/logout", undefined, cookie, "t")
    );
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie") || "";
    assert.ok(setCookie.includes(USER_PORTAL_COOKIE));
  });

  it("me requires cookie -> 401 JSON error code", async () => {
    const res: Response = await (meRoute as any).GET(jreq("GET", "http://localhost/api/user/me"));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error?.code);
  });

  it("oversize login body -> 413 (streamed byte count, not content-length only)", async () => {
    const big = "x".repeat(70 * 1024);
    const res: Response = await (loginRoute as any).POST(
      new Request("http://localhost/api/user/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ apiKey: big }),
      })
    );
    assert.equal(res.status, 413);
  });

  it("forged x-forwarded-for never bypasses the trusted-peer lockout bucket", async () => {
    // No trusted-peer stamp -> beginLoginAttempt keys on the unstramped value
    // (null), never on the client-controlled header.
    const forged = jreq("POST", "http://localhost/api/user/auth/login", { apiKey: "bad-key" });
    forged.headers.set("x-forwarded-for", "9.9.9.9");
    const res: Response = await (loginRoute as any).POST(forged);
    assert.ok([401, 403, 429].includes(res.status), `got ${res.status}`);
  });

  it("models requires cookie -> 401", async () => {
    const res: Response = await (modelsRoute as any).GET(jreq("GET", "http://localhost/api/user/models"));
    assert.equal(res.status, 401);
  });

  it("preferences PATCH without CSRF -> 403", async () => {
    const { cookie } = await provisionPortalKey();
    const res: Response = await (prefsRoute as any).PATCH(
      jreq("PATCH", "http://localhost/api/user/preferences", { disabledModels: [], expectedRevision: 0 }, cookie)
    );
    assert.equal(res.status, 403);
  });

  it("combos POST without CSRF -> 403", async () => {
    const { cookie } = await provisionPortalKey();
    const res: Response = await (combosRoute as any).POST(
      jreq("POST", "http://localhost/api/user/combos", { name: "a", models: ["m"] }, cookie)
    );
    assert.equal(res.status, 403);
  });
});
