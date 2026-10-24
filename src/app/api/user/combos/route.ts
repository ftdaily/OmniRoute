import { NextResponse } from "next/server";
import { requireUserSession } from "@/lib/userPortalAuth";
import { strictBody, validateUserCsrfToken, jsonErr } from "@/lib/userPortalHttp";
import { USER_PORTAL_COOKIE } from "@/lib/userPortalAuth";

/**
 * GET /api/user/combos — owner-scoped private combo list.
 * POST body { name, models } strict; 409 on revision/name conflict, 404 absent.
 * CSRF required on POST.
 */
export async function GET(request: Request) {
  const session = await requireUserSession(request);
  if (session instanceof Response) return session;
  try {
    const { listUserCombosForKey, getEffectiveUserPortalPolicy } = await import(
      "@/lib/userPortalPolicy"
    );
    const policy = await getEffectiveUserPortalPolicy(session.keyId);
    if (!policy.portalEnabled) return jsonErr(403, "portal_disabled");
    if (!policy.userCombosEnabled) return jsonErr(403, "combos_disabled");
    const combos = await listUserCombosForKey(session.keyId);
    return NextResponse.json({ combos });
  } catch {
    return jsonErr(503, "unavailable");
  }
}

export async function POST(request: Request) {
  const session = await requireUserSession(request);
  if (session instanceof Response) return session;
  if (!validateUserCsrfToken(request, USER_PORTAL_COOKIE)) return jsonErr(403, "forbidden");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonErr(400, "invalid_body");
  }
  const body = strictBody<{ name?: unknown; models?: unknown }>(raw, ["name", "models"]);
  if (!body || typeof body.name !== "string" || !Array.isArray(body.models)) {
    return jsonErr(400, "invalid_body");
  }
  try {
    const { getEffectiveUserPortalPolicy, validateUserComboModels } = await import(
      "@/lib/userPortalPolicy"
    );
    const { createUserCombo } = await import("@/lib/db/userPortal");
    // Admin-ceiling callback is p4-owned (raw-key-free id-based helper); this
    // import resolves when Gemini lands it — see parent request. Route stays
    // fail-closed (503) until then.
    const maybeHelper = (await import("@/lib/db/apiKeys/userPortalPersonal").catch(
      () => ({})
    )) as { isModelAllowedForKeyById?: (id: string, m: string) => Promise<boolean> };
    const { isModelAllowedForKeyById } = maybeHelper;
    if (!isModelAllowedForKeyById) return jsonErr(503, "unavailable");
    const policy = await getEffectiveUserPortalPolicy(session.keyId);
    if (!policy.portalEnabled) return jsonErr(403, "portal_disabled");
    if (!policy.userCombosEnabled) return jsonErr(403, "combos_disabled");
    try {
      await validateUserComboModels(
        (m) => isModelAllowedForKeyById(session.keyId, m),
        policy,
        body.models as string[]
      );
    } catch {
      return jsonErr(403, "model_not_allowed");
    }
    const combo = await createUserCombo(session.keyId, {
      name: body.name,
      models: body.models as string[],
    });
    return NextResponse.json({ ...combo, id: `user-combo/${combo.id}` }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && /already exists/i.test(err.message)) return jsonErr(409, "conflict");
    if (err instanceof Error && /revision conflict|CONFLICT|combo/i.test(err.message))
      return jsonErr(400, "invalid_body");
    return jsonErr(503, "unavailable");
  }
}
