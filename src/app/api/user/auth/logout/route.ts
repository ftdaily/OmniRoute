import { NextResponse } from "next/server";
import { requireUserSession, USER_PORTAL_COOKIE } from "@/lib/userPortalAuth";
import { jsonErr } from "@/lib/userPortalHttp";

/**
 * POST /api/user/auth/logout — clears the user cookie and bumps the
 * portal session revision so ALL portal sessions end (MVP single-revision).
 */
export async function POST(request: Request) {
  const session = await requireUserSession(request);
  if (session instanceof Response) return session;
  try {
    const { bumpPortalSessionRevision } = await import("@/lib/db/userPortal");
    await bumpPortalSessionRevision(session.keyId);
  } catch {
    return jsonErr(503, "unavailable");
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(USER_PORTAL_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
