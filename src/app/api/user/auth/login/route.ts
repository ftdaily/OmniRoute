import { NextResponse } from "next/server";
import { validateApiKey, getApiKeyMetadata } from "@/lib/db/apiKeys";
import { SYNTHETIC_ENV_API_KEY_ID } from "@/shared/constants/apiKeyIdentities";
import { isSelfLoopBearer } from "@/lib/db/apiKeys/selfLoopKey";
import { validateBrowserMutationOrigin } from "@/server/origin/publicOrigin";
import { beginLoginAttempt, endLoginAttempt, recordLoginFailure } from "@/server/auth/loginGuard";
import { AUTHZ_HEADER_TRUSTED_PEER_IP } from "@/server/authz/headers";
import { readRequestBodyWithLimit } from "@/shared/middleware/bodySizeGuard";
import { mintUserPortalSessionToken, USER_PORTAL_COOKIE } from "@/lib/userPortalAuth";
import { strictBody, jsonErr } from "@/lib/userPortalHttp";

/** Login body cap: bounded JSON well above any router key length (64 KB). */
const LOGIN_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * POST /api/user/auth/login — PUBLIC bootstrap. Body {apiKey} only, strict DTO.
 * Uses validateApiKey + getApiKeyMetadata (enc:v1/hash adapter inside apiKeys).
 * Synthetic env-key / self-loop / manage identities lack DB portal flags -> deny.
 * No raw key retention: only {ok:true} + HttpOnly session cookie.
 *
 * Rate-limit key is the pipeline-stamped trusted peer IP ONLY — a forged
 * x-forwarded-for must never select a different bucket or bypass lockout.
 */
export async function POST(request: Request) {
  const origin = validateBrowserMutationOrigin(request);
  if (!origin.ok) return jsonErr(403, "forbidden");

  let raw: unknown;
  try {
    const bytes = await readRequestBodyWithLimit(request, LOGIN_BODY_LIMIT_BYTES);
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    if (err instanceof Error && err.name === "RequestBodyTooLargeError") {
      return jsonErr(413, "body_too_large");
    }
    return jsonErr(400, "invalid_body");
  }
  const body = strictBody<{ apiKey?: unknown }>(raw, ["apiKey"]);
  if (!body || typeof body.apiKey !== "string" || !body.apiKey) {
    return jsonErr(400, "invalid_body");
  }

  // Trusted peer IP ONLY — never fall back to the client-controlled
  // x-forwarded-for (spoofable bucket selection / lockout bypass).
  const peerIp = request.headers.get(AUTHZ_HEADER_TRUSTED_PEER_IP);
  const attempt = beginLoginAttempt(peerIp, { enabled: true });
  if (!attempt.allowed) {
    return NextResponse.json(
      { error: { code: "locked", message: "locked" } },
      { status: 429, headers: { "retry-after": String(attempt.retryAfterSeconds ?? 900) } }
    );
  }
  try {
    const ok = await validateApiKey(body.apiKey);
    if (!ok) {
      recordLoginFailure(peerIp, { enabled: true });
      return jsonErr(401, "invalid_key");
    }
    const meta = await getApiKeyMetadata(body.apiKey);
    // Synthetic identities (env-key/self-loop/manage) have no DB portal row -> deny.
    if (!meta || meta.id === SYNTHETIC_ENV_API_KEY_ID || isSelfLoopBearer(body.apiKey)) {
      recordLoginFailure(peerIp, { enabled: true });
      return jsonErr(401, "invalid_key");
    }
    const { getPortalKeyState } = await import("@/lib/db/userPortal");
    let state: Awaited<ReturnType<typeof getPortalKeyState>>;
    try {
      state = await getPortalKeyState(meta.id);
    } catch {
      recordLoginFailure(peerIp, { enabled: true });
      return jsonErr(503, "unavailable");
    }
    if (!state || !state.portalEnabled) {
      recordLoginFailure(peerIp, { enabled: true });
      return jsonErr(403, "portal_disabled");
    }
    if (!Array.isArray(state.allowedConnections) || state.allowedConnections.length === 0) {
      recordLoginFailure(peerIp, { enabled: true });
      return jsonErr(403, "portal_disabled");
    }
    const token = await mintUserPortalSessionToken(meta.id, state.portalSessionRevision);
    // Dashboard-login parity: explicit override wins, else request protocol.
    // (Rate-limit spoof surface was the XFF bucket key above — now removed.
    // A forged proto only toggles the Secure flag on the attacker's own
    // session cookie, which grants nothing.)
    const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
    const forwardedProto = (request.headers.get("x-forwarded-proto") || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    const isHttps =
      forceSecureCookie ||
      forwardedProto === "https" ||
      new URL(request.url).protocol === "https:";
    const res = NextResponse.json({ ok: true });
    res.cookies.set(USER_PORTAL_COOKIE, token, {
      httpOnly: true,
      secure: isHttps,
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 60 * 60,
    });
    return res;
  } finally {
    endLoginAttempt(peerIp, { enabled: true });
  }
}
