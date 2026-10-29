import { NextResponse } from "next/server";
import {
  deleteApiKey,
  getApiKeyById,
  updateApiKeyPermissions,
  ApiKeyPolicyInvariantError,
} from "@/lib/db/apiKeys";
import { isCloudEnabled } from "@/lib/db/settings";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";
import { updateKeyPermissionsSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  requireCredentialForManagementScopedKey,
  requireManagementAuth,
} from "@/lib/api/requireManagementAuth";
import * as log from "@/sse/utils/logger";
import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";

// GET /api/keys/[id] - Get single API key
export async function GET(request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const key = await getApiKeyById(id);

    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    // Mask the key value
    const keyValue = typeof key.key === "string" ? key.key : null;
    return NextResponse.json({
      ...key,
      key: keyValue ? keyValue.slice(0, 8) + "****" + keyValue.slice(-4) : null,
    });
  } catch (error) {
    log.error("keys", "Error fetching key", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PATCH /api/keys/[id] - Update API key permissions/privacy controls
export async function PATCH(request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const { id } = await params;
    const validation = validateBody(updateKeyPermissionsSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const {
      name,
      modelAccessMode,
      connectionAccessMode,
      allowedModels,
      blockedModels,
      allowedCombos,
      allowedConnections,
      preferredConnections,
      noLog,
      autoResolve,
      isActive,
      throttleDelayMs,
      isBanned,
      expiresAt,
      maxSessions,
      accessSchedule,
      rateLimits,
      scopes,
      allowedEndpoints,
      streamDefaultMode,
      compressionEnabled,
      allowAutoCombos,
      allowCcDiscoveryAliases,
      catalogScope,
      forcedModel,
      cacheDefaultMode,
      codexServiceMode,
      disableNonPublicModels,
      allowUsageCommand,
      usageLimitEnabled,
      dailyUsageLimitUsd,
      weeklyUsageLimitUsd,
      chaosModeEnabled,
      portalEnabled,
      userCombosEnabled,
    } = validation.data;

    const scopeAuthError = await requireCredentialForManagementScopedKey(request, scopes);
    if (scopeAuthError) return scopeAuthError;

    const payload: Parameters<typeof updateApiKeyPermissions>[1] = {};
    if (name !== undefined) payload.name = name;
    if (modelAccessMode !== undefined) payload.modelAccessMode = modelAccessMode;
    if (allowedModels !== undefined) payload.allowedModels = allowedModels;
    if (blockedModels !== undefined) payload.blockedModels = blockedModels;
    if (allowedCombos !== undefined) payload.allowedCombos = allowedCombos;
    if (connectionAccessMode === "all") {
      payload.allowedConnections = [];
    } else if (allowedConnections !== undefined) {
      payload.allowedConnections = allowedConnections;
    }
    if (preferredConnections !== undefined) payload.preferredConnections = preferredConnections;
    if (noLog !== undefined) payload.noLog = noLog;
    if (autoResolve !== undefined) payload.autoResolve = autoResolve;
    if (isActive !== undefined) payload.isActive = isActive;
    if (throttleDelayMs !== undefined) payload.throttleDelayMs = throttleDelayMs;
    if (isBanned !== undefined) payload.isBanned = isBanned;
    if (expiresAt !== undefined) payload.expiresAt = expiresAt;
    if (maxSessions !== undefined) payload.maxSessions = maxSessions;
    if (accessSchedule !== undefined) payload.accessSchedule = accessSchedule;
    if (rateLimits !== undefined) payload.rateLimits = rateLimits;
    if (scopes !== undefined) payload.scopes = scopes;
    if (allowedEndpoints !== undefined) payload.allowedEndpoints = allowedEndpoints;
    if (streamDefaultMode !== undefined) payload.streamDefaultMode = streamDefaultMode;
    if (compressionEnabled !== undefined) payload.compressionEnabled = compressionEnabled;
    if (codexServiceMode !== undefined) payload.codexServiceMode = codexServiceMode;
    if (allowAutoCombos !== undefined) payload.allowAutoCombos = allowAutoCombos;
    if (allowCcDiscoveryAliases !== undefined)
      payload.allowCcDiscoveryAliases = allowCcDiscoveryAliases;
    if (catalogScope !== undefined) payload.catalogScope = catalogScope;
    if (forcedModel !== undefined) payload.forcedModel = forcedModel;
    if (cacheDefaultMode !== undefined) payload.cacheDefaultMode = cacheDefaultMode;
    if (disableNonPublicModels !== undefined)
      payload.disableNonPublicModels = disableNonPublicModels;
    if (allowUsageCommand !== undefined) payload.allowUsageCommand = allowUsageCommand;
    if (usageLimitEnabled !== undefined) payload.usageLimitEnabled = usageLimitEnabled;
    if (dailyUsageLimitUsd !== undefined) payload.dailyUsageLimitUsd = dailyUsageLimitUsd;
    if (weeklyUsageLimitUsd !== undefined) payload.weeklyUsageLimitUsd = weeklyUsageLimitUsd;
    if (chaosModeEnabled !== undefined) payload.chaosModeEnabled = chaosModeEnabled;
    // Scoped user portal (pA-owned): portal flags pass through the same admin
    // management auth as every other permission field above.
    if (portalEnabled !== undefined) payload.portalEnabled = portalEnabled;
    if (userCombosEnabled !== undefined) payload.userCombosEnabled = userCombosEnabled;

    // Portal enable requires a nonempty explicit connection grant whose ids all
    // resolve in provider_connections (existing lookup helper, no raw SQL).
    // Clearing the grant while enabled, nonexistent ids, or enabling with an
    // empty grant => 400 atomic (no partial write — validated before update).
    const wantsPortalOn =
      portalEnabled === true || (portalEnabled === undefined && userCombosEnabled === true);
    const grantAfter =
      connectionAccessMode === "all"
        ? []
        : allowedConnections !== undefined
          ? allowedConnections
          : undefined;
    if (wantsPortalOn || (grantAfter !== undefined && grantAfter.length === 0)) {
      const { getProviderConnectionById } = await import("@/lib/db/providers");
      const { getApiKeyById } = await import("@/lib/db/apiKeys");
      const current = await getApiKeyById(id);
      if (!current) {
        return NextResponse.json({ error: "Key not found" }, { status: 404 });
      }
      const effectiveGrant =
        grantAfter !== undefined ? grantAfter : (current.allowedConnections ?? []);
      const effectivePortal =
        portalEnabled !== undefined
          ? portalEnabled
          : (current as { portalEnabled?: boolean }).portalEnabled === true;
      if (effectivePortal) {
        if (!Array.isArray(effectiveGrant) || effectiveGrant.length === 0) {
          return NextResponse.json(
            { error: "portalEnabled requires a nonempty allowedConnections grant" },
            { status: 400 }
          );
        }
        for (const connId of effectiveGrant) {
          if (!(await getProviderConnectionById(connId))) {
            return NextResponse.json({ error: `unknown connection: ${connId}` }, { status: 400 });
          }
        }
      }
    }

    const updated = await updateApiKeyPermissions(id, payload);
    if (!updated) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    // Auto sync to Cloud if enabled
    await syncKeysToCloudIfEnabled();

    return NextResponse.json({
      message: "API key settings updated successfully",
      ...(name !== undefined && { name }),
      ...(modelAccessMode !== undefined && { modelAccessMode }),
      ...(allowedModels !== undefined && { allowedModels }),
      ...(blockedModels !== undefined && { blockedModels }),
      ...(allowedCombos !== undefined && { allowedCombos }),
      ...(allowedConnections !== undefined && { allowedConnections }),
      ...(preferredConnections !== undefined && { preferredConnections }),
      ...(noLog !== undefined && { noLog }),
      ...(autoResolve !== undefined && { autoResolve }),
      ...(isActive !== undefined && { isActive }),
      ...(throttleDelayMs !== undefined && { throttleDelayMs }),
      ...(isBanned !== undefined && { isBanned }),
      ...(expiresAt !== undefined && { expiresAt }),
      ...(maxSessions !== undefined && { maxSessions }),
      ...(accessSchedule !== undefined && { accessSchedule }),
      ...(rateLimits !== undefined && { rateLimits }),
      ...(scopes !== undefined && { scopes }),
      ...(allowedEndpoints !== undefined && { allowedEndpoints }),
      ...(streamDefaultMode !== undefined && { streamDefaultMode }),
      ...(compressionEnabled !== undefined && { compressionEnabled }),
      ...(allowCcDiscoveryAliases !== undefined && { allowCcDiscoveryAliases }),
      ...(cacheDefaultMode !== undefined && { cacheDefaultMode }),
      ...(codexServiceMode !== undefined && { codexServiceMode }),
      ...(forcedModel !== undefined && { forcedModel }),
      ...(disableNonPublicModels !== undefined && { disableNonPublicModels }),
      ...(allowUsageCommand !== undefined && { allowUsageCommand }),
      ...(usageLimitEnabled !== undefined && { usageLimitEnabled }),
      ...(dailyUsageLimitUsd !== undefined && { dailyUsageLimitUsd }),
      ...(weeklyUsageLimitUsd !== undefined && { weeklyUsageLimitUsd }),
      ...(chaosModeEnabled !== undefined && { chaosModeEnabled }),
    });
  } catch (error) {
    if (
      error instanceof ApiKeyPolicyInvariantError ||
      (error instanceof Error && (error as { code?: string }).code === "LEASE_KEY_POLICY_INVALID")
    ) {
      const err = error as Error & { code?: string };
      return NextResponse.json(
        buildErrorBody(400, err.message, null, {
          type: "lease_error",
          code: err.code || "LEASE_KEY_POLICY_INVALID",
        }),
        { status: 400 }
      );
    }
    log.error("keys", "Error updating key permissions", error);
    return NextResponse.json({ error: "Failed to update permissions" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    // Auto sync to Cloud if enabled
    await syncKeysToCloudIfEnabled();

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    log.error("keys", "Error deleting key", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}

/**
 * Sync API keys to Cloud if enabled
 */
async function syncKeysToCloudIfEnabled() {
  try {
    const cloudEnabled = await isCloudEnabled();
    if (!cloudEnabled) return;

    const machineId = await getConsistentMachineId();
    await syncToCloud(machineId);
  } catch (error) {
    log.error("keys", "Error syncing keys to cloud", error);
  }
}
