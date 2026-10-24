/**
 * pA-owned: user portal session auth. Strict user JWT domain separated from admin.
 *
 * - Signing key HMAC-derived from existing JWT_SECRET (context string), HS256.
 * - Claims: iss pinned, aud=user-portal, kind=user_session, sub=keyId,
 *   ver=portalSessionRevision (integer >= 0), jti nonce. MUST NOT carry admin
 *   `authenticated:true` claim.
 * - Cookie `user_auth_token`, 8h. No raw key in token/logs/storage.
 * - requireUserSession: fresh DB validity (p3 getPortalKeyState) every request,
 *   portal-enabled + nonempty explicit grant; admin cookie NEVER qualifies;
 *   ignores unrelated cookies. expiresAt is ISO string|null (frozen contract):
 *   parsed via Date.parse; unparseable -> fail closed.
 */
import { createHmac, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { PortalKeyState } from "./db/userPortal";

export const USER_PORTAL_COOKIE = "user_auth_token";
export const USER_PORTAL_CSRF_HEADER = "x-omniroute-user-csrf";
export const USER_PORTAL_AUDIENCE = "user-portal";
export const USER_PORTAL_KIND = "user_session";
export const USER_PORTAL_ISSUER = "omniroute-user-portal";
const USER_JWT_CONTEXT = "omniroute-user-portal-session-v1";
const SESSION_TTL = "8h";

const encoder = new TextEncoder();

/** HMAC-derive the user-portal signing key from the existing JWT_SECRET. No fallback hardcode. */
export function getUserPortalJwtKey(): Uint8Array | null {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) return null;
  return createHmac("sha256", encoder.encode(secret))
    .update(USER_JWT_CONTEXT)
    .digest();
}

export interface UserPortalJwtPayload {
  kind: string;
  sub: string;
  ver: number;
}

export async function mintUserPortalSessionToken(
  keyId: string,
  revision: number,
  key?: Uint8Array | null
): Promise<string> {
  const signingKey = key ?? getUserPortalJwtKey();
  if (!signingKey) throw new Error("user portal signing unavailable");
  return new SignJWT({ kind: USER_PORTAL_KIND, ver: revision })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(USER_PORTAL_ISSUER)
    .setSubject(keyId)
    .setAudience(USER_PORTAL_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(signingKey);
}

/** Verify user JWT only. Returns payload or null — never throws, never trusts admin tokens. */
export async function verifyUserPortalSessionToken(
  token: string,
  expectedRevision?: number,
  key?: Uint8Array | null
): Promise<(JWTPayload & UserPortalJwtPayload) | null> {
  if (!token || typeof token !== "string") return null;
  const signingKey = key ?? getUserPortalJwtKey();
  if (!signingKey || signingKey.length === 0) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey, {
      algorithms: ["HS256"],
      issuer: USER_PORTAL_ISSUER,
      audience: USER_PORTAL_AUDIENCE,
    });
    if (payload.kind !== USER_PORTAL_KIND) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    if (!Number.isInteger(payload.ver) || (payload.ver as number) < 0) return null;
    // Admin domain separation: user JWT must never carry the admin session claim.
    if ((payload as Record<string, unknown>).authenticated === true) return null;
    if (expectedRevision !== undefined && payload.ver !== expectedRevision) return null;
    return payload as JWTPayload & UserPortalJwtPayload;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || request.headers.get("Cookie");
  if (!header) return null;
  for (const segment of header.split(";")) {
    const [rawKey, ...rawValue] = segment.split("=");
    if (!rawKey || rawValue.length === 0) continue;
    if (rawKey.trim() === name) return rawValue.join("=").trim() || null;
  }
  return null;
}

export type PortalStateLoader = (keyId: string) => Promise<PortalKeyState | null>;

/**
 * Guard for /api/user/* routes. Returns { keyId, state } or a JSON error Response.
 * Fresh DB state every request via p3 getPortalKeyState — no Redis TTL lag.
 * Admin `auth_token` cookie is ignored: it never qualifies as a user principal.
 * Optional loader param is test-only injection; production path always hits fresh DB.
 */
export async function requireUserSession(
  request: Request,
  loader?: PortalStateLoader
): Promise<{ keyId: string; state: PortalKeyState } | Response> {
  const token = readCookie(request, USER_PORTAL_COOKIE);
  if (!token) return jsonErr(401, "unauthenticated");
  const payload = await verifyUserPortalSessionToken(token);
  if (!payload) return jsonErr(401, "unauthenticated");
  let state: PortalKeyState | null;
  try {
    state = loader
      ? await loader(payload.sub)
      : (await (await import("./db/userPortal")).getPortalKeyState(payload.sub));
  } catch {
    return jsonErr(503, "unavailable");
  }
  // p3 `usable` already folds revoked/banned/inactive/expired(invalid→expired) fail-closed.
  if (!state || !state.usable || !state.portalEnabled) {
    return jsonErr(401, "unauthenticated");
  }
  // Empty-grant fail-closed BEFORE legacy normalizer (portal must not inherit unrestricted).
  if (!Array.isArray(state.allowedConnections) || state.allowedConnections.length === 0) {
    return jsonErr(403, "portal_disabled");
  }
  if (payload.ver !== state.portalSessionRevision) return jsonErr(401, "unauthenticated");
  return { keyId: payload.sub, state };
}

function jsonErr(status: number, code: string): Response {
  return Response.json({ error: { code, message: code } }, { status });
}
