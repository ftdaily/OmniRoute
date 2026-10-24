/**
 * pA-owned: user-portal shared helpers — DTO guard, JSON errors, user CSRF.
 * Own header/context, own helper module; does not touch admin csrf.ts.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { USER_PORTAL_CSRF_HEADER } from "./userPortalAuth";
import { validateBrowserMutationOrigin } from "@/server/origin/publicOrigin";

const TOKEN_TTL_SECONDS = 10 * 60;
const TOKEN_CONTEXT = "omniroute-user-portal-csrf-v1";

export function jsonErr(status: number, code: string): Response {
  return Response.json({ error: { code, message: code } }, { status });
}

/** Strict DTO: every key must be in allowed, else null. Unknown privileged fields -> null. */
export function strictBody<T extends Record<string, unknown>>(
  raw: unknown,
  allowed: ReadonlyArray<string>
): T | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!allowed.includes(key)) return null;
  }
  return rec as T;
}

function userSessionHash(userToken: string): string {
  return createHash("sha256").update(userToken).digest("base64url");
}

function userCsrfMac(secret: Uint8Array, expiresAtSeconds: number, userToken: string): Buffer {
  return createHmac("sha256", secret)
    .update(TOKEN_CONTEXT)
    .update("\n")
    .update(String(expiresAtSeconds))
    .update("\n")
    .update(userSessionHash(userToken))
    .digest();
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || request.headers.get("Cookie");
  if (!header) return null;
  for (const segment of header.split(";")) {
    const [rawKey, ...rawValue] = segment.split("=");
    if (!rawKey || rawValue.length === 0) continue;
    if (rawKey.trim() === name) return rawValue.join("=").trim() || null;
  }
  return null;
}

export async function issueUserCsrfToken(
  request: Request,
  userCookieName: string,
  nowMs: number = Date.now()
): Promise<string | null> {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) return null;
  const userToken = getCookie(request, userCookieName);
  if (!userToken) return null;
  const expiresAt = Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS;
  const mac = userCsrfMac(Buffer.from(secret, "utf8"), expiresAt, userToken);
  return `v1.${expiresAt}.${mac.toString("base64url")}`;
}

export function validateUserCsrfToken(request: Request, userCookieName: string): boolean {
  if (!validateBrowserMutationOrigin(request).ok) return false;
  const secret = process.env.JWT_SECRET?.trim();
  const headerToken = request.headers.get(USER_PORTAL_CSRF_HEADER);
  const userToken = getCookie(request, userCookieName);
  if (!secret || !headerToken || !userToken) return false;
  const parts = headerToken.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;
  let presented: Buffer;
  try {
    presented = Buffer.from(parts[2], "base64url");
  } catch {
    return false;
  }
  const expected = userCsrfMac(Buffer.from(secret, "utf8"), expiresAt, userToken);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
