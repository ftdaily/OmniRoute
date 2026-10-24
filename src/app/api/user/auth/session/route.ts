import { NextResponse } from "next/server";
import { requireUserSession } from "@/lib/userPortalAuth";

/**
 * GET /api/user/auth/session — { authenticated, principal }.
 * principal omits admin claims; cookie-only, no raw key material.
 */
export async function GET(request: Request) {
  const session = await requireUserSession(request);
  if (session instanceof Response) {
    return NextResponse.json({ authenticated: false });
  }
  const { state } = session;
  return NextResponse.json({
    authenticated: true,
    principal: {
      id: state.id,
      name: state.name,
      userCombosEnabled: state.userCombosEnabled,
      expiresAt: state.expiresAt,
    },
  });
}
