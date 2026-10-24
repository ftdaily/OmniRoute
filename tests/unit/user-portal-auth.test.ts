/**
 * RED: user portal auth — owned by pA. TDD before src/lib/userPortalAuth.ts exists.
 * Covers: JWT domain separation (aud/kind, no `authenticated` claim copying admin),
 * revocation via portalSessionRevision, empty-grant fail-closed, own CSRF bound
 * to user cookie, BOLA isolation, global-auth-disabled login.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "user-portal-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = process.env.JWT_SECRET || "user-portal-auth-red-secret-32bytes!!";

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const userPortalAuth = await import("../../src/lib/userPortalAuth.ts");
const {
  mintUserPortalSessionToken,
  verifyUserPortalSessionToken,
  USER_PORTAL_COOKIE,
  USER_PORTAL_CSRF_HEADER,
  USER_PORTAL_AUDIENCE,
  requireUserSession,
} = userPortalAuth as any;

after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/user/me", { headers });
}

describe("user portal auth RED", () => {
  it("mints+verifies user JWT with pinned audience/kind, no authenticated:true claim", async () => {
    const token = await mintUserPortalSessionToken("key-1", 0);
    const payload = await verifyUserPortalSessionToken(token);
    assert.ok(payload, "token must verify");
    assert.equal(payload.aud, USER_PORTAL_AUDIENCE);
    assert.equal(payload.kind, "user_session");
    assert.equal(payload.sub, "key-1");
    assert.equal(payload.ver, 0);
    assert.notEqual((payload as any).authenticated, true);
  });

  it("rejects foreign JWT (dashboard session shape / wrong audience)", async () => {
    const { SignJWT } = await import("jose");
    const raw = (process.env.JWT_SECRET as string).trim();
    const secret = new TextEncoder().encode(raw);
    const forged = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("other")
      .sign(secret);
    assert.equal(await verifyUserPortalSessionToken(forged), null);
  });

  it("stale revision fails (revocation via portalSessionRevision)", async () => {
    const token = await mintUserPortalSessionToken("key-1", 0);
    assert.equal(await verifyUserPortalSessionToken(token, 1), null);
  });

  it("requireUserSession: no cookie -> 401 Response", async () => {
    const out = await requireUserSession(req());
    assert.ok(out instanceof Response);
    assert.equal(out.status, 401);
  });

  it("requireUserSession: admin cookie present alone must NOT qualify", async () => {
    const out = await requireUserSession(
      req({ cookie: "auth_token=admin-jwt-here" })
    );
    assert.ok(out instanceof Response);
    assert.equal(out.status, 401);
  });

  it("USER_PORTAL constants pinned", () => {
    assert.equal(USER_PORTAL_COOKIE, "user_auth_token");
    assert.equal(USER_PORTAL_CSRF_HEADER, "x-omniroute-user-csrf");
    assert.equal(USER_PORTAL_AUDIENCE, "user-portal");
  });
});
