/**
 * p3-owned: personal-disable hook for isModelAllowedForKey (BEFORE cache write).
 * Resolves FRESH portal state per call via getPortalKeyState(metadata.id) —
 * never trusts DTO field naming (camel vs snake), no stale-allow. Storage
 * error => DENY (return true = disabled). Scoped to the key's own id only.
 * Dynamic import into userPortal.ts breaks the p3 cycle (userPortal imports
 * clearApiKeyCaches from apiKeys).
 */
import { modelPatternMatches } from "./modelPermissions";

function parseDisabled(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

type KeyIdentity = { id?: unknown };

export async function isModelPersonallyDisabled(
  metadata: KeyIdentity,
  modelId: string,
  resolvedModelId: string | null
): Promise<boolean> {
  const id = metadata.id;
  if (typeof id !== "string" || !id || !modelId) return false;
  try {
    const { getPortalKeyState, getKeyPreferences } = await import("../userPortal");
    const state = await getPortalKeyState(id);
    // Not a portal key, or unusable/empty-grant => personal hook does not apply.
    if (!state || !state.portalEnabled || !state.usable) return false;
    if (!Array.isArray(state.allowedConnections) || state.allowedConnections.length === 0) return false;
    const disabled = parseDisabled((await getKeyPreferences(id)).disabledModels);
    if (disabled.length === 0) return false;
    const candidates = [modelId];
    if (typeof resolvedModelId === "string" && resolvedModelId && resolvedModelId !== modelId) {
      candidates.push(resolvedModelId);
    }
    return disabled.some(
      (entry) => typeof entry === "string" && modelPatternMatches(entry, candidates)
    );
  } catch {
    // Storage backend unhealthy: fail closed (treat as disabled). Portal
    // inference paths must deny rather than admit on unknown state; non-portal
    // keys never reach here with a portal-enabled fresh state.
    return true;
  }
}

/**
 * Raw-key-free admin ceiling for portal REST: resolve the key row by id
 * (getApiKeyById decrypts internally), then run the existing
 * isModelAllowedForKey including the personal hook above. Centralized
 * existing wrapper — no raw-SQL cipher auth invented.
 */
export async function isModelAllowedForKeyById(
  keyId: string,
  modelId: string,
  resolvedModelId?: string | null
): Promise<boolean> {
  if (!keyId || typeof modelId !== "string" || !modelId) return false;
  try {
    const { getApiKeyById, isModelAllowedForKey } = await import("../apiKeys");
    const row = await getApiKeyById(keyId);
    const raw = (row as { key?: unknown } | null)?.key;
    if (typeof raw !== "string" || !raw) return false;
    return await isModelAllowedForKey(raw, modelId, resolvedModelId ?? null);
  } catch {
    return false;
  }
}
