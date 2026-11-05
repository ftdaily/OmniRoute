// 226-229 collision repair matrix. Portable: fs-mock per-test + fresh runner
// import per-test (importFresh query-buster). better-sqlite3 :memory: DBs.
// Covers the 2026-11-05 renumber: fork 217/218 -> 226/227, upstream 217/218
// -> 228/229 (byte-identical renames). Legacy ledgers recorded under EITHER
// old name must converge: full-shape guards skip, partials heal, missing
// tables get created. No /tmp files, no env scenarios.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
}
function migrationsDir(): string {
  return path.join(repoRoot(), "src/lib/db/migrations");
}
function readDisk(name: string): string {
  return fs.readFileSync(path.join(migrationsDir(), name), "utf8");
}
function baseFiles(): Record<string, string> {
  return { "001_initial_schema.sql": readDisk("001_initial_schema.sql") };
}
// Patched disk state: 001 + 004 (proxy_registry parent of 131) + 131
// (proxy_subscriptions parent for 229) + upstream 213 + the four renames.
// All content read from REAL disk files.
function patchedFiles(): Record<string, string> {
  const out = baseFiles();
  out["004_proxy_registry.sql"] = readDisk("004_proxy_registry.sql");
  out["131_proxy_subscriptions.sql"] = readDisk("131_proxy_subscriptions.sql");
  out["213_api_key_preferred_connections.sql"] = readDisk("213_api_key_preferred_connections.sql");
  out["226_user_portal_flags_prefs_combos.sql"] = readDisk(
    "226_user_portal_flags_prefs_combos.sql"
  );
  out["227_retired_api_key_hashes.sql"] = readDisk("227_retired_api_key_hashes.sql");
  out["228_quota_recovery_tickets.sql"] = readDisk("228_quota_recovery_tickets.sql");
  out["229_proxy_subscription_mirror_urls.sql"] = readDisk(
    "229_proxy_subscription_mirror_urls.sql"
  );
  return out;
}

function withMockedMigrationFs<T>(files: Record<string, string>, fn: () => T): T {
  const oE = fs.existsSync;
  const oR = fs.readdirSync;
  const oF = fs.readFileSync;
  const isMig = (t: unknown): boolean => {
    const s = String(t).replaceAll("\\", "/");
    return s.endsWith("/src/lib/db/migrations") || s.endsWith("/migrations");
  };
  (fs as unknown as Record<string, unknown>).existsSync = (t: unknown) => {
    if (files && isMig(t)) return true;
    if (files && Object.hasOwn(files, path.basename(String(t)))) return true;
    return (oE as typeof fs.existsSync)(t as fs.PathLike);
  };
  (fs as unknown as Record<string, unknown>).readdirSync = (t: unknown, o?: unknown) => {
    if (files && isMig(t)) return Object.keys(files);
    return (oR as (...a: never[]) => never)(t as never, o as never);
  };
  (fs as unknown as Record<string, unknown>).readFileSync = (t: unknown, o?: unknown) => {
    const n = path.basename(String(t));
    if (files && Object.hasOwn(files, n)) return files[n];
    return (oF as (...a: never[]) => string)(t as never, o as never);
  };
  try {
    return fn();
  } finally {
    (fs as unknown as Record<string, unknown>).existsSync = oE;
    (fs as unknown as Record<string, unknown>).readdirSync = oR;
    (fs as unknown as Record<string, unknown>).readFileSync = oF;
  }
}

async function withFreshRunner<T>(
  files: Record<string, string>,
  fn: (runner: typeof import("../../../src/lib/db/migrationRunner.ts")) => T | Promise<T>
): Promise<T> {
  const url = pathToFileURL(path.join(repoRoot(), "src/lib/db/migrationRunner.ts")).href;
  const mod = await import(`${url}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return withMockedMigrationFs(files, () => fn(mod)) as T;
}

type Db = {
  exec: (s: string) => void;
  prepare: (s: string) => {
    get: (...a: unknown[]) => Record<string, unknown> | undefined;
    all: (...a: unknown[]) => Array<Record<string, unknown>>;
    run: (...a: unknown[]) => void;
  };
};
function cols(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name
  );
}
function tableNames(db: Db): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}
function appliedVersions(db: Db): Map<string, string> {
  const rows = db.prepare("SELECT version, name FROM _omniroute_migrations").all() as Array<{
    version: string;
    name: string;
  }>;
  return new Map(rows.map((r) => [r.version, r.name]));
}
function seedPortalData(db: Db): void {
  db.prepare("INSERT INTO api_keys (id, name, key, machine_id, created_at) VALUES (?,?,?,?,?)").run(
    "k1",
    "legacy",
    "enc:v1:x",
    "m1",
    "2026-10-24"
  );
  db.exec("UPDATE api_keys SET portal_enabled=1, user_combos_enabled=1 WHERE id='k1'");
  db.prepare(
    "INSERT INTO key_preferences (key_id, disabled_models, created_at, updated_at) VALUES (?,?,?,?)"
  ).run("k1", '["m1"]', "2026-10-24", "2026-10-24");
}
function assertPortalObjects(db: Db, ctx: string): void {
  const c = cols(db, "api_keys");
  for (const col of ["portal_enabled", "user_combos_enabled", "portal_session_revision"]) {
    assert.ok(c.includes(col), `${ctx}: api_keys.${col} present`);
  }
  const t = tableNames(db);
  for (const tbl of ["key_preferences", "user_combos"]) {
    assert.ok(t.includes(tbl), `${ctx}: ${tbl} present`);
  }
}
function assertUpstreamObjects(db: Db, ctx: string): void {
  const t = tableNames(db);
  assert.ok(t.includes("retired_api_key_hashes"), `${ctx}: retired_api_key_hashes present`);
  assert.ok(t.includes("quota_recovery_tickets"), `${ctx}: quota_recovery_tickets present`);
  assert.ok(
    cols(db, "proxy_subscriptions").includes("mirror_urls"),
    `${ctx}: proxy_subscriptions.mirror_urls present`
  );
}

test("226-repair FRESH: 213+226-229 all apply with all objects, rerun clean", async () => {
  const files = patchedFiles();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: true }));
    assert.ok(
      cols(db, "api_keys").includes("preferred_connections"),
      "FRESH: upstream 213 column present"
    );
    assertPortalObjects(db, "FRESH");
    assertUpstreamObjects(db, "FRESH");
    const applied = appliedVersions(db);
    assert.equal(applied.get("213"), "api_key_preferred_connections");
    assert.equal(applied.get("226"), "user_portal_flags_prefs_combos");
    assert.equal(applied.get("227"), "retired_api_key_hashes");
    assert.equal(applied.get("228"), "quota_recovery_tickets");
    assert.equal(applied.get("229"), "proxy_subscription_mirror_urls");
    const n = withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    assert.equal(n, 0, "rerun applies nothing");
  });
});

test("226-repair LEGACY fork213: 213/portal-name row -> 226, upstream 213 applies", async () => {
  const files = patchedFiles();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    const legacy = { ...baseFiles() };
    legacy["213_user_portal_flags_prefs_combos.sql"] =
      files["226_user_portal_flags_prefs_combos.sql"];
    withMockedMigrationFs(legacy, () => r.runMigrations(db, { isNewDb: true }));
    seedPortalData(db);
    assert.equal(
      appliedVersions(db).get("213"),
      "user_portal_flags_prefs_combos",
      "precondition: legacy 213/portal row"
    );
    withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    const applied = appliedVersions(db);
    assert.equal(applied.get("213"), "api_key_preferred_connections", "upstream 213 recorded");
    assert.equal(applied.get("226"), "user_portal_flags_prefs_combos", "legacy row moved to 226");
    assert.ok(cols(db, "api_keys").includes("preferred_connections"), "gained upstream column");
    const row = db
      .prepare("SELECT portal_enabled FROM api_keys WHERE id=?")
      .get("k1") as unknown as { portal_enabled: number };
    assert.equal(row.portal_enabled, 1, "portal DATA preserved (not just columns)");
    assertPortalObjects(db, "fork213-post");
    assertUpstreamObjects(db, "fork213-post");
    const n = withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    assert.equal(n, 0, "rerun applies nothing");
  });
});

test("226-repair LEGACY fork217-218: portal-first DB gains quota+mirror, DATA kept", async () => {
  const files = patchedFiles();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    const legacy = { ...baseFiles() };
    legacy["217_user_portal_flags_prefs_combos.sql"] =
      files["226_user_portal_flags_prefs_combos.sql"];
    legacy["218_retired_api_key_hashes.sql"] = files["227_retired_api_key_hashes.sql"];
    withMockedMigrationFs(legacy, () => r.runMigrations(db, { isNewDb: true }));
    seedPortalData(db);
    assert.equal(appliedVersions(db).get("217"), "user_portal_flags_prefs_combos");
    assert.equal(appliedVersions(db).get("218"), "retired_api_key_hashes");
    withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    const applied = appliedVersions(db);
    assert.equal(applied.get("226"), "user_portal_flags_prefs_combos", "226 recorded via guard");
    assert.equal(applied.get("227"), "retired_api_key_hashes", "227 recorded");
    const row = db
      .prepare("SELECT portal_enabled FROM api_keys WHERE id=?")
      .get("k1") as unknown as { portal_enabled: number };
    assert.equal(row.portal_enabled, 1, "portal DATA preserved (no re-exec wipe)");
    assertPortalObjects(db, "fork217-post");
    assertUpstreamObjects(db, "fork217-post");
    const n = withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    assert.equal(n, 0, "rerun applies nothing");
  });
});

test("226-repair LEGACY upstream217-218: quota-first DB gains portal, no silent skip", async () => {
  const files = patchedFiles();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    const legacy = { ...baseFiles() };
    legacy["004_proxy_registry.sql"] = files["004_proxy_registry.sql"];
    legacy["131_proxy_subscriptions.sql"] = files["131_proxy_subscriptions.sql"];
    legacy["217_quota_recovery_tickets.sql"] = files["228_quota_recovery_tickets.sql"];
    legacy["218_proxy_subscription_mirror_urls.sql"] =
      files["229_proxy_subscription_mirror_urls.sql"];
    withMockedMigrationFs(legacy, () => r.runMigrations(db, { isNewDb: true }));
    assert.ok(
      tableNames(db).includes("quota_recovery_tickets"),
      "precondition: quota table exists"
    );
    assert.ok(!cols(db, "api_keys").includes("portal_enabled"), "precondition: no portal cols");
    withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    const applied = appliedVersions(db);
    assert.equal(
      applied.get("226"),
      "user_portal_flags_prefs_combos",
      "226 EXECUTED (not skipped)"
    );
    assertPortalObjects(db, "upstream217-post");
    assertUpstreamObjects(db, "upstream217-post");
    const n = withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    assert.equal(n, 0, "rerun applies nothing");
  });
});
