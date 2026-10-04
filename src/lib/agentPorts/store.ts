/**
 * Agent Ports — persistent store for per-agent listener endpoints.
 * Table agent_endpoints(id, name, port UNIQUE, api_key_id, enabled, status, status_detail,
 * created_at, updated_at) — plain SQLite via getDbInstance, lazy schema ensure.
 */
import { getDbInstance } from "@/lib/db/core";
import { validateName, validatePort } from "./ports";

export type AgentEndpointStatus = "stopped" | "running" | "error";

export type AgentEndpoint = {
  id: string;
  name: string;
  port: number;
  apiKeyId: string;
  enabled: boolean;
  status: AgentEndpointStatus;
  statusDetail: string | null;
  createdAt: string;
  updatedAt: string;
};

let _schemaChecked = false;

export function ensureAgentEndpointsTable(): void {
  if (_schemaChecked) return;
  const db = getDbInstance();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_endpoints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      port INTEGER NOT NULL UNIQUE,
      api_key_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'stopped',
      status_detail TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  _schemaChecked = true;
}

function rowToEndpoint(row: Record<string, unknown>): AgentEndpoint {
  return {
    id: String(row.id),
    name: String(row.name),
    port: Number(row.port),
    apiKeyId: String(row.api_key_id),
    enabled: Number(row.enabled) === 1,
    status: (String(row.status) || "stopped") as AgentEndpointStatus,
    statusDetail: row.status_detail == null ? null : String(row.status_detail),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function listEndpoints(): Promise<AgentEndpoint[]> {
  ensureAgentEndpointsTable();
  const db = getDbInstance();
  const rows = db.prepare("SELECT * FROM agent_endpoints ORDER BY created_at ASC").all() as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToEndpoint);
}

export async function getEndpoint(id: string): Promise<AgentEndpoint | null> {
  ensureAgentEndpointsTable();
  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM agent_endpoints WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEndpoint(row) : null;
}

export async function createEndpoint(input: {
  name: string;
  port: number;
  apiKeyId: string;
  enabled?: boolean;
}): Promise<string> {
  ensureAgentEndpointsTable();
  const name = validateName(input.name);
  const port = validatePort(input.port);
  const db = getDbInstance();
  const id =
    globalThis.crypto?.randomUUID?.() ?? `ae-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO agent_endpoints (id, name, port, api_key_id, enabled, status, status_detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'stopped', NULL, ?, ?)`,
    ).run(id, name, port, input.apiKeyId, input.enabled === false ? 0 : 1, now, now);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: agent_endpoints.port/i.test(err.message)) {
      throw new Error(`Port ${port} is already assigned to another agent endpoint`);
    }
    throw err;
  }
  return id;
}

export async function updateEndpoint(
  id: string,
  patch: { name?: string; port?: number; apiKeyId?: string; enabled?: boolean },
): Promise<void> {
  ensureAgentEndpointsTable();
  const db = getDbInstance();
  const existing = await getEndpoint(id);
  if (!existing) throw new Error(`Agent endpoint ${id} not found`);
  const name = patch.name !== undefined ? validateName(patch.name) : existing.name;
  const port = patch.port !== undefined ? validatePort(patch.port) : existing.port;
  const apiKeyId = patch.apiKeyId !== undefined ? String(patch.apiKeyId) : existing.apiKeyId;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled ? 1 : 0;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `UPDATE agent_endpoints SET name=?, port=?, api_key_id=?, enabled=?, updated_at=? WHERE id=?`,
    ).run(name, port, apiKeyId, enabled, now, id);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: agent_endpoints.port/i.test(err.message)) {
      throw new Error(`Port ${port} is already assigned to another agent endpoint`);
    }
    throw err;
  }
}

export async function deleteEndpoint(id: string): Promise<void> {
  ensureAgentEndpointsTable();
  const db = getDbInstance();
  db.prepare("DELETE FROM agent_endpoints WHERE id = ?").run(id);
}

export async function setEndpointStatus(
  id: string,
  status: AgentEndpointStatus,
  statusDetail: string | null,
): Promise<void> {
  ensureAgentEndpointsTable();
  const db = getDbInstance();
  db.prepare("UPDATE agent_endpoints SET status=?, status_detail=?, updated_at=? WHERE id=?").run(
    status,
    statusDetail,
    new Date().toISOString(),
    id,
  );
}
