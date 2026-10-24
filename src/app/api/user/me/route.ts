import { NextResponse } from "next/server";
import { requireUserSession } from "@/lib/userPortalAuth";

/** GET /api/user/me — { id, name, userCombosEnabled, expiresAt }. */
export async function GET(request: Request) {
  const session = await requireUserSession(request);
  if (session instanceof Response) return session;
  const { state } = session;
  return NextResponse.json({
    id: state.id,
    name: state.name,
    userCombosEnabled: state.userCombosEnabled,
    expiresAt: state.expiresAt,
  });
}
