/**
 * w52:p4 — scoped user-portal policy helpers (empty-grant deny, personal prefs, private combos).
 * Real storage: reads p3's src/lib/db/userPortal.ts + existing admin policy matchers.
 * No cache introduced here — no stale-ALLOW surface (policy re-read per call).
 */
import {
  getPortalKeyState,
  getKeyPreferences,
  getUserCombo,
  listUserCombos,
  isPrivateComboId,
  parseUserComboWireId,
} from "./db/userPortal.ts";
import { modelPatternMatches } from "./db/apiKeys/modelPermissions.ts";
import { isModelAllowedForKey } from "./db/apiKeys.ts";

export type PortalPolicy = {
  portalEnabled: boolean;
  allowedConnections: string[];
  disabledModels: string[];
  userCombosEnabled: boolean;
  revision: number;
  lifecycle: "ok" | "missing" | "disabled" | "revoked" | "expired" | "empty-grant";
};

export type NormalizedUserCombo = {
  id: string;
  name: string;
  models: string[];
  enabled: boolean;
  keyId: string;
  revision: number;
};

export class PortalPolicyDeniedError extends Error {
  readonly reason: PortalPolicy["lifecycle"];
  constructor(reason: PortalPolicy["lifecycle"], message?: string) {
    super(message ?? `portal policy denied: ${reason}`);
    this.name = "PortalPolicyDeniedError";
    this.reason = reason;
  }
}

function deny(reason: PortalPolicy["lifecycle"]): PortalPolicy {
  return {
    portalEnabled: false,
    allowedConnections: [],
    disabledModels: [],
    userCombosEnabled: false,
    revision: 0,
    lifecycle: reason,
  };
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Assert fresh lifecycle state from p3 storage; distinguishes disabled/invalid from legacy-unscoped. */
export async function assertPortalKeyUsable(keyId: string): Promise<PortalPolicy> {
  if (!keyId || typeof keyId !== "string") return deny("missing");
  const state = await getPortalKeyState(keyId);
  if (!state) return deny("missing");
  if (!state.portalEnabled) return deny("disabled");
  if (!state.isActive || state.isBanned) return deny("disabled");
  if (state.revokedAt && state.revokedAt.trim() !== "") return deny("revoked");
  if (state.expiresAt) {
    const t = Date.parse(state.expiresAt);
    if (!Number.isFinite(t) || t <= Date.now()) return deny("expired");
  }
  const grants = state.allowedConnections.filter(isNonEmpty);
  if (grants.length === 0) return deny("empty-grant");
  const prefs = await getKeyPreferences(keyId);
  return {
    portalEnabled: true,
    allowedConnections: grants,
    disabledModels: prefs.disabledModels,
    userCombosEnabled: state.userCombosEnabled && state.portalEnabled,
    revision: prefs.revision,
    lifecycle: "ok",
  };
}

/** Legacy keys unchanged: null grant passes through to legacy unrestricted resolver. */
export async function getEffectiveUserPortalPolicy(keyId: string): Promise<PortalPolicy> {
  return assertPortalKeyUsable(keyId);
}

/** Keyed scope (id + conns), deny explicitly marked; legacy null only when policy is OFF. */
export async function getPortalConnectionScopeForKey(
  keyId: string
): Promise<{ keyId: string; allowedConnections: string[] | null; denied: boolean; reason: PortalPolicy["lifecycle"] }> {
  const policy = await getEffectiveUserPortalPolicy(keyId);
  if (!policy.portalEnabled) {
    return { keyId, allowedConnections: null, denied: true, reason: policy.lifecycle };
  }
  return { keyId, allowedConnections: policy.allowedConnections, denied: false, reason: "ok" };
}

/** Personal disable match — modelPatternMatches over the wire id only. */
export function personalModelDisabled(disabled: string[], modelId: string): boolean {
  if (!modelId) return true;
  const trimmed = modelId.trim();
  if (!trimmed) return true;
  return (disabled ?? []).some(
    (entry) => typeof entry === "string" && modelPatternMatches(entry, [trimmed])
  );
}

/** Admin ceiling check: existing isModelAllowedForKey with the key's RAW material. */
export async function isAdminModelAllowed(rawKey: string | null, modelId: string): Promise<boolean> {
  if (!rawKey || !modelId) return false;
  try {
    return await isModelAllowedForKey(rawKey, modelId);
  } catch {
    return false;
  }
}

/**
 * Gate: admin policy (raw key) THEN personal disabled. Returns the raw secret only to
 * the caller for upstream forwarding — never logged/persisted by this module.
 */
export async function gateUserModel(
  keyId: string,
  rawKey: string | null,
  modelId: string
): Promise<{ allowed: boolean; rawKey: string | null; reason: string }> {
  if (!keyId || !rawKey || !modelId) return { allowed: false, rawKey: null, reason: "deny" };
  const policy = await getEffectiveUserPortalPolicy(keyId);
  if (!policy.portalEnabled) return { allowed: false, rawKey: null, reason: policy.lifecycle };
  if (personalModelDisabled(policy.disabledModels, modelId)) {
    return { allowed: false, rawKey: null, reason: "personal-disabled" };
  }
  if (!(await isAdminModelAllowed(rawKey, modelId))) return { allowed: false, rawKey: null, reason: "admin-policy" };
  return { allowed: true, rawKey, reason: "ok" };
}

export async function isUserModelEnabled(keyId: string, modelId: string): Promise<boolean> {
  if (!keyId || !modelId) return false;
  const policy = await getEffectiveUserPortalPolicy(keyId);
  if (!policy.portalEnabled) return false;
  return !personalModelDisabled(policy.disabledModels, modelId);
}

/** Private combo resolves ONLY owner rows; foreign/other-key ids => null (no global fallback). */
export async function resolveUserComboForKey(
  keyId: string,
  wireId: string
): Promise<NormalizedUserCombo | null> {
  if (!keyId || typeof wireId !== "string" || !isPrivateComboId(wireId)) return null;
  const id = parseUserComboWireId(wireId);
  if (!id) return null;
  const policy = await getEffectiveUserPortalPolicy(keyId);
  if (!policy.portalEnabled || !policy.userCombosEnabled) return null;
  const row = await getUserCombo(keyId, id);
  if (!row || !row.enabled || row.keyId !== keyId) return null;
  return { id: `user-combo/${row.id}`, name: row.name, models: row.models, enabled: true, keyId: row.keyId, revision: row.revision };
}

/**
 * Owner-authorized private combo, shaped for the EXISTING combo executor.
 *
 * The returned object carries the same `models`/`strategy`/`config` shape the
 * global combo rows use, so the ordinary combo path (fan-out, fallback,
 * per-target connection scoping) runs unchanged — no parallel engine.
 *
 * Authorization (all must hold):
 *   - the wire id is a private combo id owned by this key (owner-scoped SQL);
 *   - the key's portal policy is enabled with a non-empty connection grant;
 *   - every member model is admitted by the ADMIN ceiling (raw-key-free
 *     `isModelAllowedForKeyById`) and is not personally disabled.
 *
 * Returns null for every denial — the caller answers 403 and never falls back
 * to a global provider for a `user-combo/*` target.
 */
export async function authorizePrivateComboForKey(
  keyId: string,
  wireId: string
): Promise<NormalizedUserCombo | null> {
  if (!keyId || typeof wireId !== "string" || !isPrivateComboId(wireId)) return null;
  const id = parseUserComboWireId(wireId);
  if (!id) return null;
  const policy = await getEffectiveUserPortalPolicy(keyId);
  if (!policy.portalEnabled || !policy.userCombosEnabled) return null;
  if (!policy.allowedConnections || policy.allowedConnections.length === 0) return null;
  const row = await getUserCombo(keyId, id);
  if (!row || !row.enabled || row.keyId !== keyId) return null;

  const members = Array.isArray(row.models) ? row.models : [];
  if (members.length === 0) return null;
  for (const member of members) {
    if (typeof member !== "string" || member.length === 0) return null;
    if (isPrivateComboId(member)) return null;
    if (member.startsWith("auto/") || member.startsWith("qtSd/")) return null;
    if (personalModelDisabled(policy.disabledModels, member)) return null;
    if (!(await isModelAllowedForKeyById(keyId, member))) return null;
  }

  return {
    id: `user-combo/${row.id}`,
    name: row.name,
    models: members,
    enabled: true,
    keyId: row.keyId,
    revision: row.revision,
  };
}

/**
 * Executable combo object for a private combo, in the shape the existing
 * combo executor consumes (`models` as normalized steps, `strategy`, `config`).
 */
export async function buildPrivateComboRuntime(
  keyId: string,
  wireId: string
): Promise<Record<string, unknown> | null> {
  const authorized = await authorizePrivateComboForKey(keyId, wireId);
  if (!authorized) return null;
  const { normalizeComboModels } = await import("./combos/steps.ts");
  const steps = normalizeComboModels(authorized.models, { comboName: authorized.name });
  if (steps.length === 0) return null;
  return {
    id: authorized.id,
    name: authorized.name,
    models: steps,
    strategy: "priority",
    config: { strategy: "priority" },
    private: true,
    keyId: authorized.keyId,
  };
}

/** Validate private combo models: admin allow-list ceiling + personal prefs + connection catalog. */
export async function validateUserComboModels(
  adminAllowed: (model: string) => Promise<boolean> | boolean,
  policy: PortalPolicy,
  models: string[]
): Promise<void> {
  if (!policy.portalEnabled) throw new Error("PORTAL_DISABLED");
  if (!policy.userCombosEnabled) throw new Error("USER_COMBOS_DISABLED");
  if (!Array.isArray(models) || models.length === 0 || models.length > 32) throw new Error("MODELS_INVALID");
  for (const m of models) {
    if (typeof m !== "string" || m.length === 0 || m.length > 256) throw new Error("MODEL_INVALID");
    if (isPrivateComboId(m)) throw new Error("NESTED_COMBO_REJECTED");
    if (m.startsWith("auto/") || m.startsWith("qtSd/")) throw new Error("VIRTUAL_COMBO_REJECTED");
    if (!(await adminAllowed(m))) throw new Error(`ADMIN_CEILING:${m}`);
    if (personalModelDisabled(policy.disabledModels, m)) throw new Error(`PERSONAL_DISABLED:${m}`);
  }
}

/**
 * Servable model rows for a key = admin catalog (safe projection) minus personal disabled.
 *
 * Public contract: ONE argument (the key id). The raw secret is resolved
 * INTERNALLY from the stored key row (never returned, never logged) because the
 * admin allow-list matcher (`isModelAllowedForKey`) is keyed by the raw secret.
 * `rawKey`/`catalogIds` remain optional for callers that already hold both.
 */
export async function getPortalModelsForKey(
  keyId: string,
  rawKey?: string | null,
  catalogIds?: string[]
): Promise<Array<{ id: string; disabled: boolean }>> {
  const policy = await getEffectiveUserPortalPolicy(keyId);
  if (!policy.portalEnabled) return [];
  let secret = rawKey ?? null;
  let ids = catalogIds;
  if (!secret || !ids) {
    const { getApiKeyById } = await import("./db/apiKeys.ts");
    const row = await getApiKeyById(keyId);
    if (!row) return [];
    if (!secret && typeof row.key === "string" && row.key) secret = row.key;
    if (!ids) ids = await listPortalCatalogModelIds(policy.allowedConnections);
  }
  const seen = new Set<string>();
  const out: Array<{ id: string; disabled: boolean }> = [];
  for (const id of ids ?? []) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    if (!(await isModelAllowedForKey(secret, id, null, { ignorePersonalRestrictions: true }))) continue;
    out.push({ id, disabled: personalModelDisabled(policy.disabledModels, id) });
  }
  return out;
}

/**
 * Catalog model ids reachable through the granted connections only.
 *
 * Minimal: one fresh DB read for node prefixes + synced catalog; per granted
 * connection only, never unioned. `prefix/model` where prefix is the node
 * prefix for the connection's provider (custom node support incl. portaltest).
 */
async function listPortalCatalogModelIds(allowedConnections: string[]): Promise<string[]> {
  const { getProviderConnectionById, getProviderNodes } = await import("./db/providers.ts");
  const { getSyncedAvailableModelsForConnection } = await import("./db/models.ts");
  const { PROVIDER_ID_TO_ALIAS } = await import("@omniroute/open-sse/config/providerModels.ts");
  const nodes = await getProviderNodes();
  const ids = new Set<string>();
  for (const connectionId of new Set(allowedConnections)) {
    const connection = await getProviderConnectionById(connectionId);
    if (!connection || connection.isActive === false) continue;
    const provider = String(connection.provider);
    const node = nodes.find((entry) => entry?.id === provider);
    const prefix = typeof node?.prefix === "string" ? node.prefix : PROVIDER_ID_TO_ALIAS[provider] || provider;
    const models = await getSyncedAvailableModelsForConnection(provider, connectionId);
    for (const model of models) {
      if (typeof model.id === "string" && model.id) ids.add(`${prefix}/${model.id}`);
    }
  }
  return [...ids];
}

/**
 * Raw-key-free admin model check, keyed by the API key id.
 *
 * The admin allow-list matcher is keyed by the raw secret, so this helper
 * resolves the stored secret INTERNALLY and NEVER returns it. Used by the
 * portal REST routes (which only hold the key id) and by private-combo member
 * validation.
 */
export async function isModelAllowedForKeyById(keyId: string, modelId: string): Promise<boolean> {
  if (!keyId || !modelId) return false;
  try {
    const { getApiKeyById } = await import("./db/apiKeys.ts");
    const row = await getApiKeyById(keyId);
    const secret = typeof row?.key === "string" ? row.key : null;
    if (!secret) return false;
    return await isAdminModelAllowed(secret, modelId);
  } catch {
    return false;
  }
}

/** Owner-scoped private combo list (no global catalog leak). */
export async function listUserCombosForKey(keyId: string): Promise<NormalizedUserCombo[]> {
  const policy = await getEffectiveUserPortalPolicy(keyId);
  if (!policy.portalEnabled || !policy.userCombosEnabled) return [];
  const rows = await listUserCombos(keyId);
  return rows
    .filter((row) => row.keyId === keyId)
    .map((row) => ({
      id: `user-combo/${row.id}`,
      name: row.name,
      models: row.models,
      enabled: row.enabled,
      keyId: row.keyId,
      revision: row.revision,
    }));
}
