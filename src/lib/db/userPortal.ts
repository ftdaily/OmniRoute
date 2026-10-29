/**
 * p3-owned storage module: scoped user-portal state (owner-keyed, no global mutation, no secrets).
 *
 * Exports (frozen contract):
 * - getPortalKeyState(keyId): fresh DB state, parsed fields, no secrets
 * - getKeyPreferences / updateKeyPreferences (revision-guarded, CONFLICT on stale)
 * - listUserCombos / getUserCombo / createUserCombo / updateUserCombo / deleteUserCombo
 *   (owner-SQL WHERE key_id AND id, revision guards, bounded validation)
 * - isPrivateComboId, bumpPortalSessionRevision
 */
import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";
import { ensureApiKeyFallbackColumns } from "./apiKeyColumnFallbacks";
import { clearApiKeyCaches } from "./apiKeys";
import { clearModelPermissionCache } from "./apiKeys/modelPermissionCache";

export const USER_COMBO_PREFIX = "user-combo/";
export const MAX_COMBOS_PER_KEY = 50;
export const MAX_COMBO_MODELS = 32;
export const MAX_COMBO_NAME = 80;
export const MAX_MODEL_ID = 256;
export const MAX_DISABLED_MODELS = 256;

export type PortalKeyState = {
  id: string;
  name: string;
  portalEnabled: boolean;
  userCombosEnabled: boolean;
  portalSessionRevision: number;
  isActive: boolean;
  isBanned: boolean;
  revokedAt: string | null;
  expiresAt: string | null;
  /** Effective usability: false when revoked, banned, inactive, or expired (sentinel counts as expired). */
  usable: boolean;
  allowedConnections: string[];
  modelAccessMode: string | null;
  allowedModels: string[];
  blockedModels: string[];
};

export class PortalRevisionConflictError extends Error {
  readonly code = "CONFLICT";
  constructor(message = "revision conflict: stale expectedRevision") {
    super(message);
    this.name = "PortalRevisionConflictError";
  }
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export const EXPIRED_SENTINEL_ISO = "1970-01-01T00:00:00.000Z";

function normalizeExpiry(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? EXPIRED_SENTINEL_ISO : new Date(t).toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return EXPIRED_SENTINEL_ISO;
    return new Date(value).toISOString();
  }
  return EXPIRED_SENTINEL_ISO;
}

/** Parse an API-key row's expiry; invalid/non-empty values FAIL CLOSED to the expired sentinel. */
export function parseKeyExpiryFailClosed(value: unknown): string | null {
  return normalizeExpiry(value);
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true;
}

function assertRevision(value: unknown, field = "expectedRevision"): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PortalRevisionConflictError(`${field} must be a non-negative integer`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isPrivateComboId(model: unknown): boolean {
  return typeof model === "string" && model.startsWith(USER_COMBO_PREFIX);
}

/**
 * Personal-only model gate for p4's inference integration (call BEFORE cached admin
 * allow, but do not replace it). Fresh storage read; no admin module import (no cycle).
 *
 * Returns TRUE (enabled) on any storage error: fail-open is safe because this helper
 * only ever ADDS personal restrictions on top of the authoritative admin policy gate
 * (isModelAllowedForKey), never grants access. "true" = no personal restriction found.
 */
export async function isUserModelEnabled(keyId: string, model: string): Promise<boolean> {
  try {
    const prefs = await getKeyPreferences(keyId);
    return !prefs.disabledModels.includes(model);
  } catch {
    return true;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUserComboWireId(wireId: unknown): string | null {
  if (typeof wireId !== "string" || !wireId.startsWith(USER_COMBO_PREFIX)) return null;
  const id = wireId.slice(USER_COMBO_PREFIX.length);
  return UUID_RE.test(id) ? id : null;
}

function validateComboName(name: unknown): string {
  if (typeof name !== "string" || name.length < 1 || name.length > MAX_COMBO_NAME) {
    throw new Error(`combo name must be 1..${MAX_COMBO_NAME} chars`);
  }
  return name;
}

function validateComboModels(models: unknown): string[] {
  if (!Array.isArray(models)) throw new Error("combo models must be an array");
  if (models.length > MAX_COMBO_MODELS) {
    throw new Error(`combo models exceed max ${MAX_COMBO_MODELS}`);
  }
  for (const m of models) {
    if (typeof m !== "string" || m.length < 1 || m.length > MAX_MODEL_ID) {
      throw new Error(`combo model id must be 1..${MAX_MODEL_ID} chars`);
    }
  }
  return models as string[];
}

function validateDisabledModels(models: unknown): string[] {
  if (!Array.isArray(models)) throw new Error("disabledModels must be an array");
  if (models.length > MAX_DISABLED_MODELS) {
    throw new Error(`disabledModels exceed max ${MAX_DISABLED_MODELS}`);
  }
  for (const m of models) {
    if (typeof m !== "string" || m.length < 1 || m.length > MAX_MODEL_ID) {
      throw new Error(`disabled model id must be 1..${MAX_MODEL_ID} chars`);
    }
  }
  return models as string[];
}

export async function getPortalKeyState(keyId: string): Promise<PortalKeyState | null> {
  const db = getDbInstance() as any;
  // Same lazy schema heal as the api-keys module: fresh/test DBs may lack the
  // portal/lifecycle columns (is_active, is_banned, ...) that the SELECT below
  // reads. Without this the ceiling throws → 503 on every self-loop request.
  try {
    ensureApiKeyFallbackColumns(db);
  } catch {
    // Heal is best-effort; the SELECT below surfaces real storage failures.
  }
  const row = db
    .prepare(
      `SELECT id, name, portal_enabled, user_combos_enabled, portal_session_revision,
              is_active, is_banned, revoked_at, expires_at,
              allowed_connections, model_access_mode, allowed_models, blocked_models
       FROM api_keys WHERE id = ?`
    )
    .get(keyId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const expiresAt = normalizeExpiry(row.expires_at);
  const expired = expiresAt !== null && Date.parse(expiresAt) <= Date.now();
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    portalEnabled: toBool(row.portal_enabled),
    userCombosEnabled: toBool(row.user_combos_enabled),
    portalSessionRevision: Number(row.portal_session_revision ?? 0),
    isActive: toBool(row.is_active),
    isBanned: Boolean(row.is_banned),
    revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
    expiresAt,
    usable: toBool(row.is_active) && !Boolean(row.is_banned) && row.revoked_at == null && !expired,
    allowedConnections: parseStringArray(row.allowed_connections),
    modelAccessMode: row.model_access_mode == null ? null : String(row.model_access_mode),
    allowedModels: parseStringArray(row.allowed_models),
    blockedModels: parseStringArray(row.blocked_models),
  };
}

export async function getKeyPreferences(
  keyId: string
): Promise<{ disabledModels: string[]; revision: number }> {
  const db = getDbInstance() as any;
  const row = db
    .prepare(`SELECT disabled_models, revision FROM key_preferences WHERE key_id = ?`)
    .get(keyId) as { disabled_models?: unknown; revision?: unknown } | undefined;
  if (!row) return { disabledModels: [], revision: 0 };
  return {
    disabledModels: parseStringArray(row.disabled_models),
    revision: Number(row.revision ?? 0),
  };
}

export async function updateKeyPreferences(
  keyId: string,
  disabledModels: string[],
  expectedRevision: number
): Promise<{ disabledModels: string[]; revision: number }> {
  assertRevision(expectedRevision);
  const valid = validateDisabledModels(disabledModels);
  const db = getDbInstance() as any;
  const ts = nowIso();
  const payload = JSON.stringify(valid);
  const existing = await getKeyPreferences(keyId);
  if (existing.revision !== expectedRevision) {
    throw new PortalRevisionConflictError();
  }
  const next = expectedRevision + 1;
  const res = db
    .prepare(
      `UPDATE key_preferences SET disabled_models = ?, revision = ?, updated_at = ?
       WHERE key_id = ? AND revision = ?`
    )
    .run(payload, next, ts, keyId, expectedRevision);
  if ((res.changes ?? 0) === 0) {
    if (existing.revision === 0) {
      // No row yet (or raced insert): insert only if still absent.
      try {
        db.prepare(
          `INSERT INTO key_preferences (key_id, disabled_models, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(keyId, payload, next, ts, ts);
      } catch {
        throw new PortalRevisionConflictError();
      }
    } else {
      throw new PortalRevisionConflictError();
    }
  }
  clearModelPermissionCache();
  return { disabledModels: valid, revision: next };
}

export type UserComboRecord = {
  id: string;
  keyId: string;
  name: string;
  models: string[];
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

function comboData(models: string[], enabled: boolean): string {
  return JSON.stringify({ models, config: { strategy: "priority" }, enabled });
}

function parseComboRow(row: Record<string, unknown>): UserComboRecord {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.data ?? "{}"));
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  return {
    id: String(row.id),
    keyId: String(row.key_id),
    name: String(row.name),
    models: parseStringArray(data.models),
    enabled: data.enabled !== false,
    revision: Number(row.revision ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function listUserCombos(keyId: string): Promise<UserComboRecord[]> {
  const db = getDbInstance() as any;
  const rows = db
    .prepare(
      `SELECT * FROM user_combos WHERE key_id = ? ORDER BY created_at ASC LIMIT ${MAX_COMBOS_PER_KEY}`
    )
    .all(keyId) as Array<Record<string, unknown>>;
  return rows.map(parseComboRow);
}

export async function getUserCombo(keyId: string, id: string): Promise<UserComboRecord | null> {
  const db = getDbInstance() as any;
  const row = db.prepare(`SELECT * FROM user_combos WHERE key_id = ? AND id = ?`).get(keyId, id) as
    Record<string, unknown> | undefined;
  return row ? parseComboRow(row) : null;
}

export async function createUserCombo(
  keyId: string,
  input: { name: string; models: string[] }
): Promise<UserComboRecord> {
  const name = validateComboName(input.name);
  const models = validateComboModels(input.models);
  const db = getDbInstance() as any;
  const id = randomUUID();
  const ts = nowIso();
  // Transactional count-cap + insert (no check-then-insert race).
  const txn = (db as { transaction: (fn: () => unknown) => () => unknown }).transaction(() => {
    const count = (
      db.prepare(`SELECT COUNT(*) AS c FROM user_combos WHERE key_id = ?`).get(keyId) as {
        c: number;
      }
    ).c;
    if (count >= MAX_COMBOS_PER_KEY) {
      throw new Error(`user combos exceed max ${MAX_COMBOS_PER_KEY} per key`);
    }
    db.prepare(
      `INSERT INTO user_combos (id, key_id, name, data, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    ).run(id, keyId, name, comboData(models, true), ts, ts);
  });
  try {
    txn();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      throw new Error(`combo name already exists for this key`);
    }
    throw err;
  }
  const created = await getUserCombo(keyId, id);
  if (!created) throw new Error("combo creation failed");
  return created;
}

export async function updateUserCombo(
  keyId: string,
  id: string,
  patch: { name?: string; models?: string[]; enabled?: boolean; expectedRevision: number }
): Promise<UserComboRecord> {
  assertRevision(patch.expectedRevision);
  const existing = await getUserCombo(keyId, id);
  if (!existing) throw new Error("combo not found");
  if (existing.revision !== patch.expectedRevision) {
    throw new PortalRevisionConflictError();
  }
  const name = patch.name !== undefined ? validateComboName(patch.name) : existing.name;
  const models = patch.models !== undefined ? validateComboModels(patch.models) : existing.models;
  const enabled = patch.enabled !== undefined ? patch.enabled === true : existing.enabled;
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  const db = getDbInstance() as any;
  const next = existing.revision + 1;
  const ts = nowIso();
  try {
    const res = db
      .prepare(
        `UPDATE user_combos SET name = ?, data = ?, revision = ?, updated_at = ?
         WHERE key_id = ? AND id = ? AND revision = ?`
      )
      .run(name, comboData(models, enabled), next, ts, keyId, id, existing.revision);
    if ((res.changes ?? 0) === 0) throw new PortalRevisionConflictError();
  } catch (err) {
    if (err instanceof PortalRevisionConflictError) throw err;
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      throw new Error(`combo name already exists for this key`);
    }
    throw err;
  }
  const updated = await getUserCombo(keyId, id);
  if (!updated) throw new Error("combo not found");
  return updated;
}

export async function deleteUserCombo(
  keyId: string,
  id: string,
  expectedRevision?: number
): Promise<void> {
  const db = getDbInstance() as any;
  if (expectedRevision !== undefined) {
    assertRevision(expectedRevision);
    const existing = await getUserCombo(keyId, id);
    if (!existing) throw new Error("combo not found");
    if (existing.revision !== expectedRevision) throw new PortalRevisionConflictError();
  }
  db.prepare(`DELETE FROM user_combos WHERE key_id = ? AND id = ?`).run(keyId, id);
}

/**
 * Lifecycle hook: bump the key's portal_session_revision atomically + invalidate
 * auth/model-permission caches. Preserves key id (rotation handled by regenerateApiKey).
 * Call on: regen/revoke/ban/disable/delete/portal-disable/admin-ceiling changes.
 */
export async function bumpPortalSessionRevision(keyId: string): Promise<number> {
  const db = getDbInstance() as any;
  db.prepare(
    `UPDATE api_keys SET portal_session_revision = COALESCE(portal_session_revision, 0) + 1 WHERE id = ?`
  ).run(keyId);
  const row = db.prepare(`SELECT portal_session_revision FROM api_keys WHERE id = ?`).get(keyId) as
    { portal_session_revision?: unknown } | undefined;
  clearApiKeyCaches();
  clearModelPermissionCache();
  return Number(row?.portal_session_revision ?? 0);
}
