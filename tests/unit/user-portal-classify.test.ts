/**
 * Route classification for /api/user/* — narrow explicit allowlist with
 * method gates. Login bootstrap distinguisher: only POST /api/user/auth/login
 * may ride the USER-login path; every other user path needs the user session.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { isPublicApiRoute } from "../../src/shared/constants/publicApiRoutes.ts";
import { userPortalPolicy } from "../../src/server/authz/policies/userPortal.ts";

const GUARDED: Array<[string, string]> = [
  ["/api/user/auth/logout", "POST"],
  ["/api/user/auth/session", "GET"],
  ["/api/user/auth/csrf", "GET"],
  ["/api/user/me", "GET"],
  ["/api/user/models", "GET"],
  ["/api/user/preferences", "GET"],
  ["/api/user/preferences", "PATCH"],
  ["/api/user/combos", "GET"],
  ["/api/user/combos", "POST"],
  ["/api/user/combos/abc", "GET"],
  ["/api/user/combos/abc", "PATCH"],
  ["/api/user/combos/abc", "DELETE"],
];

describe("user portal route classification", () => {
  it("login POST is the USER-login bootstrap (exact, method-gated)", async () => {
    assert.equal(isPublicApiRoute("/api/user/auth/login", "POST"), true);
    assert.equal(isPublicApiRoute("/api/user/auth/login/", "POST"), true);
    assert.equal(isPublicApiRoute("/api/user/auth/login", "OPTIONS"), true);
    assert.equal(isPublicApiRoute("/api/user/auth/login", "GET"), false);
    assert.equal(isPublicApiRoute("/api/user/auth/login/extra", "POST"), false);
    const login = classifyRoute("/api/user/auth/login", "POST");
    assert.equal(login.routeClass, "USER");
    assert.equal(login.reason, "user_portal_login");
  });

  it("guarded user paths are USER (never MANAGEMENT/PUBLIC/anonymous)", async () => {
    for (const [path, method] of GUARDED) {
      assert.equal(isPublicApiRoute(path, method), false, path);
      const c = classifyRoute(path, method);
      assert.equal(c.routeClass, "USER", path);
      assert.equal(c.reason, "user_portal", path);
    }
  });

  it("unknown /api/user/* paths fall through to MANAGEMENT (never anonymous)", async () => {
    assert.equal(classifyRoute("/api/user/admin", "GET").routeClass, "MANAGEMENT");
    assert.equal(classifyRoute("/api/user/combos/a/b", "GET").routeClass, "MANAGEMENT");
  });

  it("USER policy: login POST allows bootstrap, GET login rejects, guarded defers to handler", async () => {
    const loginPost = await userPortalPolicy.evaluate({
      request: { method: "POST", headers: new Headers() },
      classification: { routeClass: "USER", reason: "user_portal_login", normalizedPath: "/api/user/auth/login" },
      requestId: "t",
    });
    assert.equal(loginPost.allow, true);
    const loginGet = await userPortalPolicy.evaluate({
      request: { method: "GET", headers: new Headers() },
      classification: { routeClass: "USER", reason: "user_portal_login", normalizedPath: "/api/user/auth/login" },
      requestId: "t",
    });
    assert.equal(loginGet.allow, false);
  });

  it("case/encoding variants do not widen the pin", async () => {
    assert.equal(isPublicApiRoute("/API/USER/AUTH/LOGIN", "POST"), false);
    assert.equal(isPublicApiRoute("/api/user/auth/login%2f", "POST"), false);
    assert.equal(isPublicApiRoute("/api/user/auth/login/../login", "POST"), false);
  });

  it("source pin: login route uses user key bootstrap, never admin session", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "../..");
    const src = fs.readFileSync(path.join(root, "src/app/api/user/auth/login/route.ts"), "utf8");
    assert.match(src, /validateApiKey|getApiKeyMetadata/, "login must bootstrap from the DB key");
    assert.doesNotMatch(src, /isDashboardSessionAuthenticated|verifyDashboardSessionToken/, "login must not touch admin session");
  });
});
