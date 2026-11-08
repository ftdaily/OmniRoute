// Step 3: 230/231 renumber migration fixtures (real disk SQL, fs-mock per-test,
// fresh runner per-test). Mirrors 226-collision-repair + upstream 230/231 tests.
// Covers: FRESH all-to-231; Tencent-style legacy (217/218 portal names + UP
// 226/227 OLD names co-existing, unapplied) -> converges w/o duplicate/skip;
// local-style 226-229 applied (+ fork 228) -> 230+231 only. No /tmp files.
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
// Full patched disk state: parents + 213 + fork 226-229 + upstream 230/231.
function patchedFiles(): Record<string, string> {
  const out = baseFiles();
  out["004_proxy_registry.sql"] = readDisk("004_proxy_registry.sql");
  out["131_proxy_subscriptions.sql"] = readDisk("131_proxy_subscriptions.sql");
  out["182_request_cost_ledger_and_key_quota.sql"] = readDisk(
    "182_request_cost_ledger_and_key_quota.sql"
  );
  out["213_api_key_preferred_connections.sql"] = readDisk("213_api_key_preferred_connections.sql");
  out["226_user_portal_flags_prefs_combos.sql"] = readDisk(
    "226_user_portal_flags_prefs_combos.sql"
  );
  out["227_retired_api_key_hashes.sql"] = readDisk("227_retired_api_key_hashes.sql");
  out["228_quota_recovery_tickets.sql"] = readDisk("228_quota_recovery_tickets.sql");
  out["229_proxy_subscription_mirror_urls.sql"] = readDisk(
    "229_proxy_subscription_mirror_urls.sql"
  );
  out["230_request_cost_ledger_read_indexes.sql"] = readDisk(
    "230_request_cost_ledger_read_indexes.sql"
  );
  out["231_quota_recovery_due_cover.sql"] = readDisk("231_quota_recovery_due_cover.sql");
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
function tableNames(db: Db): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}
function indexesOn(db: Db, table: string): string[] {
  return (
    db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}
function appliedVersions(db: Db): Map<string, string> {
  const rows = db.prepare("SELECT version, name FROM _omniroute_migrations").all() as Array<{
    version: string;
    name: string;
  }>;
  return new Map(rows.map((r) => [r.version, r.name]));
}

test("230/231 FRESH: 001..231 all apply, 231 top, rerun clean", async () => {
  const files = patchedFiles();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    const n = withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: true }));
    assert.ok(n > 0, "fresh applies migrations");
    const applied = appliedVersions(db);
    assert.equal(applied.get("230"), "request_cost_ledger_read_indexes", "230 recorded");
    assert.equal(applied.get("231"), "quota_recovery_due_cover", "231 recorded");
    assert.ok(
      indexesOn(db, "request_cost_ledger").includes("idx_rcl_api_key_ts_cover"),
      "230 month_lookup index exists"
    );
    assert.ok(
      tableNames(db).includes("quota_recovery_tickets"),
      "231 quota_recovery_tickets rebuilt"
    );
    assert.ok(
      indexesOn(db, "quota_recovery_tickets").includes("idx_quota_recovery_due"),
      "231 due_cover index exists"
    );
    const n2 = withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    assert.equal(n2, 0, "rerun applies nothing");
  });
});

test("230/231 TENCENT-style: legacy 217/218 names + UP old 226/227 converge to 231", async () => {
  const files = patchedFiles();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    // Tencent never got fork 226-229 (stopped at old 217/218) and never saw UP
    // 226/227 by number: seed old 217/218 fork names only, then run full set.
    const legacy = { ...baseFiles() };
    legacy["182_request_cost_ledger_and_key_quota.sql"] =
      files["182_request_cost_ledger_and_key_quota.sql"];
    legacy["004_proxy_registry.sql"] = files["004_proxy_registry.sql"];
    legacy["131_proxy_subscriptions.sql"] = files["131_proxy_subscriptions.sql"];
    legacy["213_api_key_preferred_connections.sql"] =
      files["213_api_key_preferred_connections.sql"];
    legacy["217_user_portal_flags_prefs_combos.sql"] =
      files["226_user_portal_flags_prefs_combos.sql"];
    legacy["218_retired_api_key_hashes.sql"] = files["227_retired_api_key_hashes.sql"];
    withMockedMigrationFs(legacy, () => r.runMigrations(db, { isNewDb: true }));
    withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    const applied = appliedVersions(db);
    assert.equal(applied.get("226"), "user_portal_flags_prefs_combos", "226 via compat");
    assert.equal(applied.get("227"), "retired_api_key_hashes", "227 via compat");
    assert.equal(applied.get("228"), "quota_recovery_tickets", "228 upstream applied");
    assert.equal(applied.get("229"), "proxy_subscription_mirror_urls", "229 upstream applied");
    assert.equal(applied.get("230"), "request_cost_ledger_read_indexes", "230 applied");
    assert.equal(applied.get("231"), "quota_recovery_due_cover", "231 applied (top)");
    const n = withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    assert.equal(n, 0, "rerun applies nothing (no duplicate)");
  });
});

test("230/231 LOCAL-style: 226-229 ledger applied -> only 230+231 pending", async () => {
  const files = patchedFiles();
  await withFreshRunner(files, (runner) => {
    const r = runner as unknown as { runMigrations: (d: unknown, o: unknown) => number };
    const db = new Database(":memory:") as unknown as Db;
    const pre = { ...files };
    delete pre["230_request_cost_ledger_read_indexes.sql"];
    delete pre["231_quota_recovery_due_cover.sql"];
    withMockedMigrationFs(pre, () => r.runMigrations(db, { isNewDb: true }));
    assert.ok(!appliedVersions(db).has("230"), "precondition: no 230 yet");
    const n = withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    assert.equal(n, 2, "exactly 230+231 apply");
    const applied = appliedVersions(db);
    assert.equal(applied.get("230"), "request_cost_ledger_read_indexes");
    assert.equal(applied.get("231"), "quota_recovery_due_cover");
    const n2 = withMockedMigrationFs(files, () => r.runMigrations(db, { isNewDb: false }));
    assert.equal(n2, 0, "rerun applies nothing");
  });
});
