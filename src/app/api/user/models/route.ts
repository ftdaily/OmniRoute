import { NextResponse } from "next/server";
import { requireUserSession } from "@/lib/userPortalAuth";
import { jsonErr } from "@/lib/userPortalHttp";

/**
 * GET /api/user/models — { models: [{ id, disabled }] }.
 * p4 getPortalModelsForKey (admin catalog ∩ grants, minus personal disabled).
 */
export async function GET(request: Request) {
  const session = await requireUserSession(request);
  if (session instanceof Response) return session;
  try {
    const { getPortalModelsForKey } = await import("@/lib/userPortalPolicy");
    const models = await getPortalModelsForKey(session.keyId);
    return NextResponse.json({ models });
  } catch {
    return jsonErr(503, "unavailable");
  }
}
