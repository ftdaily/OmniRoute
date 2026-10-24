import { NextResponse } from "next/server";
import { requireUserSession } from "@/lib/userPortalAuth";
import { strictBody, validateUserCsrfToken, jsonErr } from "@/lib/userPortalHttp";
import { USER_PORTAL_COOKIE } from "@/lib/userPortalAuth";

/**
 * GET /api/user/combos/[id] — owner-scoped single combo, 404 foreign.
 * PATCH body { name?, models?, enabled?, expectedRevision }; 409 stale.
 * DELETE body? { expectedRevision? }; 404 foreign. CSRF on PATCH/DELETE.
 */
function wireToId(wireId: string): string | null {
  return wireId.startsWith("user-combo/") && wireId.length > 11 ? wireId.slice(11) : null;
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireUserSession(request);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const rowId = wireToId(id);
  if (!rowId) return jsonErr(404, "not_found");
  try {
    const { resolveUserComboForKey } = await import("@/lib/userPortalPolicy");
    const combo = await resolveUserComboForKey(session.keyId, id);
    if (!combo) return jsonErr(404, "not_found");
    return NextResponse.json(combo);
  } catch {
    return jsonErr(503, "unavailable");
  }
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireUserSession(request);
  if (session instanceof Response) return session;
  if (!validateUserCsrfToken(request, USER_PORTAL_COOKIE)) return jsonErr(403, "forbidden");
  const { id } = await ctx.params;
  const rowId = wireToId(id);
  if (!rowId) return jsonErr(404, "not_found");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonErr(400, "invalid_body");
  }
  const body = strictBody<{ name?: unknown; models?: unknown; enabled?: unknown; expectedRevision?: unknown }>(
    raw,
    ["name", "models", "enabled", "expectedRevision"]
  );
  if (!body || typeof body.expectedRevision !== "number") return jsonErr(400, "invalid_body");
  if (body.name !== undefined && typeof body.name !== "string") return jsonErr(400, "invalid_body");
  if (body.models !== undefined && !Array.isArray(body.models)) return jsonErr(400, "invalid_body");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return jsonErr(400, "invalid_body");
  try {
    const { getEffectiveUserPortalPolicy, validateUserComboModels } = await import(
      "@/lib/userPortalPolicy"
    );
    const { updateUserCombo } = await import("@/lib/db/userPortal");
    const policy = await getEffectiveUserPortalPolicy(session.keyId);
    if (!policy.portalEnabled) return jsonErr(403, "portal_disabled");
    if (!policy.userCombosEnabled) return jsonErr(403, "combos_disabled");
    if (body.models !== undefined) {
      const maybeHelper = (await import("@/lib/db/apiKeys/userPortalPersonal").catch(
        () => ({})
      )) as { isModelAllowedForKeyById?: (id: string, m: string) => Promise<boolean> };
      if (!maybeHelper.isModelAllowedForKeyById) return jsonErr(503, "unavailable");
      try {
        await validateUserComboModels((m) => maybeHelper.isModelAllowedForKeyById!(session.keyId, m), policy, body.models as string[]);
      } catch {
        return jsonErr(403, "model_not_allowed");
      }
    }
    const updated = await updateUserCombo(session.keyId, rowId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.models !== undefined ? { models: body.models as string[] } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      expectedRevision: body.expectedRevision,
    });
    return NextResponse.json({ ...updated, id: `user-combo/${updated.id}` });
  } catch (err) {
    if (err instanceof Error && /revision conflict/i.test(err.message)) return jsonErr(409, "conflict");
    if (err instanceof Error && /not found/i.test(err.message)) return jsonErr(404, "not_found");
    if (err instanceof Error && /already exists/i.test(err.message)) return jsonErr(409, "conflict");
    if (err instanceof Error && /combo|name|model|enabled/i.test(err.message))
      return jsonErr(400, "invalid_body");
    return jsonErr(503, "unavailable");
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireUserSession(request);
  if (session instanceof Response) return session;
  if (!validateUserCsrfToken(request, USER_PORTAL_COOKIE)) return jsonErr(403, "forbidden");
  const { id } = await ctx.params;
  const rowId = wireToId(id);
  if (!rowId) return jsonErr(404, "not_found");
  let expectedRevision: number | undefined;
  try {
    const text = await request.text();
    if (text) {
      const raw: unknown = JSON.parse(text);
      const body = strictBody<{ expectedRevision?: unknown }>(raw, ["expectedRevision"]);
      if (!body) return jsonErr(400, "invalid_body");
      if (body.expectedRevision !== undefined && typeof body.expectedRevision !== "number")
        return jsonErr(400, "invalid_body");
      expectedRevision = body.expectedRevision;
    }
  } catch {
    return jsonErr(400, "invalid_body");
  }
  try {
    const { deleteUserCombo } = await import("@/lib/db/userPortal");
    await deleteUserCombo(session.keyId, rowId, expectedRevision);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && /revision conflict/i.test(err.message)) return jsonErr(409, "conflict");
    if (err instanceof Error && /not found/i.test(err.message)) return jsonErr(404, "not_found");
    return jsonErr(503, "unavailable");
  }
}
