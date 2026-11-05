// 213 collision compat (N pattern). Portable: fs-mock per-test + fresh runner
// import per-test (importFresh query-buster). better-sqlite3 :memory: DBs.
// No /tmp files, no hardcoded paths, no env scenarios.
// Pattern: tests/unit/db-migration-runner-account-identity.test.ts
// (withMockedMigrationFs + importFresh). Runs under default `npm test`.
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
function pre213Files(): Record<string, string> {
  // MINIMAL chain: 001 base (api_keys + usage_history) only. Later migrations
  // have cross-deps on core.getDbInstance healers (e.g. 127 needs healer-built
  // columns); the compat under test is 213 <-> 226 only.
  const out: Record<string, string> = {};
  out["001_initial_schema.sql"] = readDisk("001_initial_schema.sql");
  return out;
}
// 226 content MUST be byte-identical to the old fork 213 (rename, not rewrite).
function forkSql(): string {
  return readDisk("226_user_portal_flags_prefs_combos.sql");
}
function upstreamSql(): string {
  return readDisk("213_api_key_preferred_connections.sql");
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
  // getMigrationFiles() runs lazily inside runMigrations(), NOT at import time
  // (only the MIGRATIONS_DIR path binds at load); the fs mock wraps each CALL.
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
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((r) => r.name);
}
function appliedVersions(db: Db): Map<string, string> {
  const rows = db.prepare("SELECT version, name FROM _omniroute_migrations").all() as Array<{
    version: string;
    name: string;
  }>;
  return new Map(rows.map((r) => [r.version, r.name]));
}
function seedLedger(db: Db, version: string, name: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _omniroute_migrations (version TEXT PRIMARY KEY, name TEXT, applied_at TEXT)"
  );
  db.prepare("INSERT INTO _omniroute_migrations (version, name, applied_at) VALUES (?,?,?)").run(
    version,
    name,
    "2026-10-24 09:56:45"
  );
}

test("213-compat RED: duplicate 213 files throw before any migration runs", async () => {
  const files = { ...pre213Files() };
  files["213_api_key_preferred_connections.sql"] = upstreamSql();
  files["213_user_portal_flags_prefs_combos.sql"] = forkSql(); // old number -> dup
  await withFreshRunner(files, (runner) => {
    const db = new Database(":memory:") as unknown as Db;
    assert.throws(
      () =>
        withMockedMigrationFs(files, () =>
          (runner as { runMigrations: (d: unknown, o: unknown) => void }).runMigrations(db, {
            isNewDb: true,
          })
        ),
      /version collision.*213/i,
      "expected collision throw for duplicate 213"
    );
  });
});

test("213-compat FRESH: upstream 213 + fork 226 both apply with all objects", async () => {
  const files = { ...pre213Files() };
  files["213_api_key_preferred_connections.sql"] = upstreamSql();
  files["226_user_portal_flags_prefs_combos.sql"] = forkSql();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: true }));
    const c = cols(db, "api_keys");
    assert.ok(c.includes("preferred_connections"), "upstream 213 column present");
    assert.ok(c.includes("portal_enabled"), "fork 226 portal_enabled present");
    assert.ok(c.includes("user_combos_enabled"), "fork 226 user_combos_enabled present");
    assert.ok(c.includes("portal_session_revision"), "fork 226 portal_session_revision present");
    const t = tableNames(db);
    assert.ok(t.includes("key_preferences"), "key_preferences table present");
    assert.ok(t.includes("user_combos"), "user_combos table present");
    const applied = appliedVersions(db);
    assert.equal(applied.get("213"), "api_key_preferred_connections");
    assert.equal(applied.get("226"), "user_portal_flags_prefs_combos");
    const n = withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    assert.equal(n, 0, "rerun applies nothing");
  });
});

test("213-compat LEGACY (Tencent): 213/fork-name row + portal DATA migrate, gain upstream col", async () => {
  const files = { ...pre213Files() };
  files["213_api_key_preferred_connections.sql"] = upstreamSql();
  files["226_user_portal_flags_prefs_combos.sql"] = forkSql();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    // TRUE legacy state WITHOUT the 226 file and WITHOUT upstream 213:
    const legacyFiles = { ...pre213Files() };
    legacyFiles["213_user_portal_flags_prefs_combos.sql"] = forkSql();
    withMockedMigrationFs(legacyFiles, () => r.runMigrations(db, { isNewDb: true }));
    db.prepare(
      "INSERT INTO api_keys (id, name, key, machine_id, created_at) VALUES (?,?,?,?,?)"
    ).run("k1", "legacy", "enc:v1:x", "m1", "2026-10-24");
    db.exec("UPDATE api_keys SET portal_enabled=1, user_combos_enabled=1 WHERE id='k1'");
    db.prepare(
      "INSERT INTO key_preferences (key_id, disabled_models, created_at, updated_at) VALUES (?,?,?,?)"
    ).run("k1", '["m1"]', "2026-10-24", "2026-10-24");
    assert.equal(appliedVersions(db).get("213"), "user_portal_flags_prefs_combos");
    assert.ok(
      !cols(db, "api_keys").includes("preferred_connections"),
      "precondition: no upstream col"
    );
    // PATCHED fileset: reconcile UPDATEs ledger 213->226, then upstream 213 applies
    withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    const applied = appliedVersions(db);
    assert.equal(applied.get("213"), "api_key_preferred_connections", "upstream 213 now recorded");
    assert.equal(applied.get("226"), "user_portal_flags_prefs_combos", "legacy row moved to 226");
    assert.ok(cols(db, "api_keys").includes("preferred_connections"), "gained upstream column");
    const row = db
      .prepare("SELECT portal_enabled, user_combos_enabled FROM api_keys WHERE id=?")
      .get("k1") as unknown as { portal_enabled: number; user_combos_enabled: number };
    assert.equal(row.portal_enabled, 1, "portal DATA preserved (not just columns)");
    assert.equal(row.user_combos_enabled, 1, "combos flag preserved");
    const pref = db
      .prepare("SELECT disabled_models FROM key_preferences WHERE key_id=?")
      .get("k1") as unknown as { disabled_models: string };
    assert.equal(pref.disabled_models, '["m1"]', "key_preferences DATA preserved");
  });
});

test("213-compat UPSTREAM-APPLIED: 226 EXECUTES (not skip) on DB without portal cols", async () => {
  const files = { ...pre213Files() };
  files["213_api_key_preferred_connections.sql"] = upstreamSql();
  files["226_user_portal_flags_prefs_combos.sql"] = forkSql();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    // TRUE upstream-213 state: only upstream 213 applied, NO portal columns
    const upFiles = { ...pre213Files() };
    upFiles["213_api_key_preferred_connections.sql"] = upstreamSql();
    withMockedMigrationFs(upFiles, () => r.runMigrations(db, { isNewDb: true }));
    assert.ok(!cols(db, "api_keys").includes("portal_enabled"), "precondition: no portal cols");
    assert.equal(appliedVersions(db).get("213"), "api_key_preferred_connections");
    // Patched run: compat must NOT map (fromName mismatch), 226 must EXECUTE
    withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    const c = cols(db, "api_keys");
    assert.ok(c.includes("portal_enabled"), "226 EXECUTED portal_enabled");
    assert.ok(c.includes("portal_session_revision"), "226 EXECUTED portal_session_revision");
    const t = tableNames(db);
    assert.ok(t.includes("key_preferences"), "226 EXECUTED key_preferences");
    assert.ok(t.includes("user_combos"), "226 EXECUTED user_combos");
    assert.equal(
      appliedVersions(db).get("213"),
      "api_key_preferred_connections",
      "upstream 213 untouched"
    );
  });
});

test("213-compat PARTIAL: 3 cols but no tables -> 226 heals (tables created, loud log)", async () => {
  const files = { ...pre213Files() };
  files["213_api_key_preferred_connections.sql"] = upstreamSql();
  files["226_user_portal_flags_prefs_combos.sql"] = forkSql();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    // Partial schema: columns exist (legacy half-run) but tables never created
    const legacyFiles = { ...pre213Files() };
    legacyFiles["213_user_portal_flags_prefs_combos.sql"] = forkSql();
    withMockedMigrationFs(legacyFiles, () => r.runMigrations(db, { isNewDb: true }));
    db.exec("DROP TABLE key_preferences; DROP TABLE user_combos;");
    // Guard (cols+tables) returns false -> 226 re-executes -> duplicate-column ->
    // existing applyMigrationSkippingExistingColumns heals: strips pre-existing
    // cols, creates missing tables, record 226 LOUDLY. Assert healed state.
    withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    const t = tableNames(db);
    assert.ok(t.includes("key_preferences"), "healed: key_preferences created");
    assert.ok(t.includes("user_combos"), "healed: user_combos created");
    assert.equal(
      appliedVersions(db).get("226"),
      "user_portal_flags_prefs_combos",
      "226 recorded after heal"
    );
    const c = cols(db, "api_keys");
    assert.ok(
      c.includes("portal_enabled") &&
        c.includes("user_combos_enabled") &&
        c.includes("portal_session_revision"),
      "columns intact after heal"
    );
  });
});
test("213-compat UNKNOWN-NAME: 213 under foreign name is NOT remapped (mismatch logged)", async () => {
  const files = { ...pre213Files() };
  files["213_api_key_preferred_connections.sql"] = upstreamSql();
  files["226_user_portal_flags_prefs_combos.sql"] = forkSql();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    const base = { ...pre213Files() };
    withMockedMigrationFs(base, () => r.runMigrations(db, { isNewDb: true }));
    seedLedger(db, "213", "something_else_entirely");
    // Foreign 213 occupies the version slot: upstream 213 stays pending-skipped,
    // so preferred_connections is MISSING. The runner MUST surface this loudly
    // (detectNameMismatches CRITICAL log) — never silently claim healthy.
    // Fail-closed here = boot loudly complains AND 226 does not pretend to fix it.
    withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    const applied = appliedVersions(db);
    assert.equal(applied.get("213"), "something_else_entirely", "foreign 213 row never rewritten");
    const c = cols(db, "api_keys");
    assert.ok(
      !c.includes("preferred_connections"),
      "upstream 213 content correctly ABSENT under foreign slot (operator must resolve manually)"
    );
    // 226 is an independent version — applies normally (portal content), but does
    // NOT mask the missing upstream column above. Both facts asserted together.
    assert.equal(
      applied.get("226"),
      "user_portal_flags_prefs_combos",
      "226 applies as fresh version"
    );
  });
});
