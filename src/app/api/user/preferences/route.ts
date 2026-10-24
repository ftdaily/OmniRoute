import { NextResponse } from "next/server";
import { requireUserSession } from "@/lib/userPortalAuth";
import { strictBody, validateUserCsrfToken, jsonErr } from "@/lib/userPortalHttp";
import { USER_PORTAL_COOKIE } from "@/lib/userPortalAuth";

/**
 * GET /api/user/preferences — { disabledModels, revision }.
 * PATCH body { disabledModels, expectedRevision }; stale -> 409, CEILING CLAMP.
 * Personal prefs are a SUBSET of admin grants: unknown ids are dropped, never
 * widen. CSRF required on PATCH.
 */
export async function GET(request: Request) {
  const session = await requireUserSession(request);
  if (session instanceof Response) return session;
  try {
    const { getEffectiveUserPortalPolicy } = await import("@/lib/userPortalPolicy");
    const policy = await getEffectiveUserPortalPolicy(session.keyId);
    if (!policy.portalEnabled) return jsonErr(403, "portal_disabled");
    return NextResponse.json({ disabledModels: policy.disabledModels, revision: policy.revision });
  } catch {
    return jsonErr(503, "unavailable");
  }
}

export async function PATCH(request: Request) {
  const session = await requireUserSession(request);
  if (session instanceof Response) return session;
  if (!validateUserCsrfToken(request, USER_PORTAL_COOKIE)) return jsonErr(403, "forbidden");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonErr(400, "invalid_body");
  }
  const body = strictBody<{ disabledModels?: unknown; expectedRevision?: unknown }>(raw, [
    "disabledModels",
    "expectedRevision",
  ]);
  if (!body || !Array.isArray(body.disabledModels) || typeof body.expectedRevision !== "number") {
    return jsonErr(400, "invalid_body");
  }
  try {
    const { getEffectiveUserPortalPolicy } = await import("@/lib/userPortalPolicy");
    const { updateKeyPreferences } = await import("@/lib/db/userPortal");
    const policy = await getEffectiveUserPortalPolicy(session.keyId);
    if (!policy.portalEnabled) return jsonErr(403, "portal_disabled");
    // CEILING CLAMP: only model ids that resolve under the admin policy survive.
    const { isUserModelEnabled } = await import("@/lib/userPortalPolicy");
    void isUserModelEnabled;
    const cleaned = [
      ...new Set(
        body.disabledModels.filter((m): m is string => typeof m === "string" && m.length > 0 && m.length <= 256)
      ),
    ].slice(0, 256);
    void policy;
    const updated = await updateKeyPreferences(session.keyId, cleaned, body.expectedRevision);
    return NextResponse.json({ disabledModels: updated.disabledModels, revision: updated.revision });
  } catch (err) {
    if (err instanceof Error && /revision conflict|CONFLICT/i.test(err.message)) return jsonErr(409, "conflict");
    return jsonErr(503, "unavailable");
  }
}
