import { NextResponse } from "next/server";
import { requireUserSession, USER_PORTAL_COOKIE } from "@/lib/userPortalAuth";
import { issueUserCsrfToken, jsonErr } from "@/lib/userPortalHttp";

/**
 * GET /api/user/auth/csrf — issues a session-bound user CSRF token.
 * Requires the user session (no anonymous issuance); own token context
 * bound to the user cookie — never the admin CRSF context.
 */
export async function GET(request: Request) {
  const session = await requireUserSession(request);
  if (session instanceof Response) return session;
  const token = await issueUserCsrfToken(request, USER_PORTAL_COOKIE);
  if (!token) return jsonErr(503, "unavailable");
  return NextResponse.json({ token });
}
