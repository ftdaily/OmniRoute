/**
 * RED-semantic (pA self): expiry/issuer/BOLA. Auth module semantics must hold
 * even before p3 storage lands — loader injection covers requireUserSession.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "user-portal-sem-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = process.env.JWT_SECRET || "user-portal-sem-red-secret-32bytes!!!!";

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const auth = await import("../../src/lib/userPortalAuth.ts");

after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const baseState = {
  id: "key-1",
  name: "K",
  portalEnabled: true,
  userCombosEnabled: false,
  portalSessionRevision: 0,
  isActive: true,
  isBanned: false,
  revokedAt: null,
  expiresAt: null,
  usable: true,
  allowedConnections: ["conn-1"],
  modelAccessMode: "all",
  allowedModels: [],
  blockedModels: [],
};

function req(cookie: string) {
  return new Request("http://localhost/api/user/me", { headers: { cookie } });
}

describe("user portal auth semantics", () => {
  it("expired ISO key rejected despite valid signature+revision", async () => {
    const token = await auth.mintUserPortalSessionToken("key-1", 0);
    const loader = async () => ({ ...baseState, usable: false, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const out = await auth.requireUserSession(req(`${auth.USER_PORTAL_COOKIE}=${token}`), loader as any);
    assert.ok(out instanceof Response && out.status === 401);
  });

  it("unparseable expiresAt fails closed (sentinel => unusable)", async () => {
    const token = await auth.mintUserPortalSessionToken("key-1", 0);
    // p3 normalizes invalid expiry to EXPIRED_SENTINEL_ISO; loader mirrors that.
    const loader = async () => ({ ...baseState, usable: false, expiresAt: "1970-01-01T00:00:00.000Z" });
    const out = await auth.requireUserSession(req(`${auth.USER_PORTAL_COOKIE}=${token}`), loader as any);
    assert.ok(out instanceof Response && out.status === 401);
  });

  it("issuer pinned: token without iss rejected", async () => {
    const { SignJWT } = await import("jose");
    const key = auth.getUserPortalJwtKey();
    const noIss = await new SignJWT({ kind: auth.USER_PORTAL_KIND, ver: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("key-1")
      .setAudience(auth.USER_PORTAL_AUDIENCE)
      .sign(key);
    assert.equal(await auth.verifyUserPortalSessionToken(noIss), null);
  });

  it("NaN/non-integer ver rejected", async () => {
    const { SignJWT } = await import("jose");
    const key = auth.getUserPortalJwtKey();
    for (const ver of [NaN, 1.5, -1, "0"]) {
      const t = await new SignJWT({ kind: auth.USER_PORTAL_KIND, ver })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(auth.USER_PORTAL_ISSUER)
        .setSubject("key-1")
        .setAudience(auth.USER_PORTAL_AUDIENCE)
        .sign(key);
      assert.equal(await auth.verifyUserPortalSessionToken(t), null, `ver=${String(ver)}`);
    }
  });

  it("jwt has jti nonce (copy-into-admin-cookie proof = separate derived key)", async () => {
    const token = await auth.mintUserPortalSessionToken("key-1", 0);
    const payload = await auth.verifyUserPortalSessionToken(token);
    assert.equal(typeof payload?.jti, "string");
  });

  it("BOLA: state loads under the token's own sub, never a foreign key", async () => {
    const tokenA = await auth.mintUserPortalSessionToken("key-A", 0);
    let seenId: string | null = null;
    const loader = async (id: string) => {
      seenId = id;
      return id === "key-A" ? ({ ...baseState, id } as any) : null;
    };
    const out = await auth.requireUserSession(req(`${auth.USER_PORTAL_COOKIE}=${tokenA}`), loader as any);
    assert.ok(!(out instanceof Response) && (out as any).keyId === "key-A");
    assert.equal(seenId, "key-A", "storage lookup must use the token sub");
    // loader returning null for the token's own id -> 401, never cross-key data
    const loaderMiss = async () => null;
    const out2 = await auth.requireUserSession(req(`${auth.USER_PORTAL_COOKIE}=${tokenA}`), loaderMiss as any);
    assert.ok(out2 instanceof Response && out2.status === 401);
  });
});
