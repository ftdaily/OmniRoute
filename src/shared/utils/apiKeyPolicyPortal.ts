/**
 * Fork-only API-key policy pieces (scoped user portal + shared policy error
 * envelope), split out of apiKeyPolicy.ts to keep it under the file-size cap.
 * Behaviour is byte-identical to the inlined versions.
 */
import { errorResponse, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { isAnthropicMessagesRequest } from "./anthropicErrorEnvelope";
import type { ApiKeyMetadata, PolicyContext } from "./apiKeyPolicy";

export function policyErrorResponse(
  request: Request,
  statusCode: number,
  message: string,
  anthropicMessage = message,
  anthropicErrorType = "permission_error",
  anthropicStatusCode = statusCode
): Response {
  if (!isAnthropicMessagesRequest(request)) {
    return errorResponse(statusCode, message);
  }

  const safeMessage = sanitizeErrorMessage(anthropicMessage);
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: anthropicErrorType,
        message: safeMessage,
      },
    }),
    {
      status: anthropicStatusCode,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Scoped user portal — ceiling check on the API key itself.
 *
 * Reads the key row FRESH (no cached metadata): the portal flags and the
 * explicit connection grant. A portal-enabled key with an empty grant is
 * denied (403) — the legacy "empty = unrestricted" semantic never applies to
 * a portal key. A non-portal key returns null (legacy behaviour unchanged).
 *
 * A storage failure is fail-closed for a key that LOOKS portal-enabled and
 * fail-open (unchanged) for a key that is not.
 */
export async function validatePortalKeyCeiling(
  request: Request,
  apiKeyInfo: ApiKeyMetadata,
  modelStr?: string | null
): Promise<Response | null> {
  const keyId = typeof apiKeyInfo.id === "string" ? apiKeyInfo.id : null;
  if (!keyId) return null;
  let state: { portalEnabled?: boolean; usable?: boolean; allowedConnections?: string[] } | null =
    null;
  try {
    const { getPortalKeyState } = await import("@/lib/db/userPortal");
    state = await getPortalKeyState(keyId);
  } catch (error) {
    log.error("API_POLICY", "Portal ceiling lookup failed.", { error });
    return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "API key policy unavailable");
  }
  if (!state || !state.portalEnabled) return null;
  const pathname = new URL(request.url).pathname.toLowerCase().replace(/^\/api\//, "/");
  if (
    ![
      "/v1/models",
      "/v1/chat/completions",
      "/v1/responses",
      "/chat/completions",
      "/responses",
      "/models",
    ].includes(pathname)
  ) {
    return errorResponse(HTTP_STATUS.FORBIDDEN, "Endpoint is not enabled for user portal keys");
  }
  if (modelStr && !modelStr.startsWith(USER_COMBO_WIRE_PREFIX)) {
    const { isModelPersonallyDisabled } = await import("@/lib/db/apiKeys/userPortalPersonal");
    if (await isModelPersonallyDisabled(apiKeyInfo, modelStr, null)) {
      return errorResponse(HTTP_STATUS.FORBIDDEN, "Model is personally disabled for this API key");
    }
  }
  if (state.usable === false) {
    return policyErrorResponse(
      request,
      HTTP_STATUS.FORBIDDEN,
      "This API key is not usable",
      "This API key is revoked, banned or expired. Create a new key.",
      "invalid_request_error",
      HTTP_STATUS.BAD_REQUEST
    );
  }
  const grant = Array.isArray(state.allowedConnections) ? state.allowedConnections : [];
  if (grant.filter((id) => typeof id === "string" && id.trim().length > 0).length === 0) {
    return policyErrorResponse(
      request,
      HTTP_STATUS.FORBIDDEN,
      "This API key has no connection grant",
      "This API key's connection grant is empty. An administrator must grant at least one connection before it can be used.",
      "invalid_request_error",
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return null;
}

/**
 * Scoped user portal — private combo wire prefix.
 *
 * A private combo is addressed as `user-combo/<uuid>`. It is owner-scoped:
 * only the key that created it may dispatch it, and it is never a global
 * combo name (see `validatePrivateComboTarget`).
 */
export const USER_COMBO_WIRE_PREFIX = "user-combo/";

/**
 * Authorize a `user-combo/<uuid>` routing target.
 *
 * Authorization is owner-scoped AND ceiling-scoped:
 *   - the private combo row must belong to the calling key;
 *   - every member model must pass the ADMIN allow-list (raw-key-free helper)
 *     and must not be personally disabled;
 *   - the key's portal grant must be a non-empty explicit connection grant.
 *
 * A denial is a POLICY denial (403). There is never a fallback to a global
 * combo or provider for a private-combo target.
 */
export async function validatePrivateComboTarget(context: PolicyContext): Promise<Response | null> {
  const { request, apiKey, apiKeyInfo, modelStr } = context;
  // A private combo can only be authorized for a REAL key: without the raw
  // secret there is no principal to authorize against. Never fall back to a
  // global provider for a `user-combo/*` target.
  if (!apiKey) {
    return policyErrorResponse(
      request,
      HTTP_STATUS.UNAUTHORIZED,
      "Missing API key",
      "A private combo requires an API key.",
      "invalid_request_error",
      HTTP_STATUS.BAD_REQUEST
    );
  }
  const keyId = typeof apiKeyInfo?.id === "string" ? apiKeyInfo.id : null;
  if (!keyId || !modelStr) {
    return policyErrorResponse(
      request,
      HTTP_STATUS.FORBIDDEN,
      `Model "${modelStr}" is not allowed for this API key`,
      `This private combo does not belong to the calling key.`,
      "invalid_request_error",
      HTTP_STATUS.BAD_REQUEST
    );
  }
  try {
    const { authorizePrivateComboForKey } = await import("@/lib/userPortalPolicy");
    const authorized = await authorizePrivateComboForKey(keyId, modelStr);
    if (!authorized) {
      return policyErrorResponse(
        request,
        HTTP_STATUS.FORBIDDEN,
        `Model "${modelStr}" is not allowed for this API key`,
        `This private combo does not belong to the calling key, or its members are not permitted for it.`,
        "invalid_request_error",
        HTTP_STATUS.BAD_REQUEST
      );
    }
    return null;
  } catch (error) {
    log.error("API_POLICY", "Private combo policy check failed. Request blocked.", { error });
    return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "API key policy unavailable");
  }
}
