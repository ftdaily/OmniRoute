#!/usr/bin/env python3
"""Local rollout helper (fork/deploy). seal/install/beta/cutover for a
user-scoped omniroute systemd unit. Parametrised port of the scratch
rollout/local-release.py: every host-specific value arrives via CLI args.

Config (argparse, all overrideable; defaults mirror the 3854 run):
  --unit, --drop (task drop-in), --node, --beta-unit, --releases-root,
  --stable-port, --beta-port, --approval, --policy-format, --new-tables,
  --heap-mb, --stream-timeout-ms

Receipts live in --work-dir (chmod 0600): seal/install/beta json, approval,
before/beta-data. Usage:
  local-release.py seal --work-dir D [--unit U ...]
  local-release.py install --work-dir D --artifact A --release R --build-id B [--...]
  local-release.py beta --work-dir D --release-path P ...     (needs parent GO)
  local-release.py cutover --work-dir D ...                   (needs parent GO)
  local-release.py --help-policy   # print TABLES/NS/EXCLUDED contract

Safety (unchanged):
- seal is health-tolerant (records health200 truth, never hard-fails);
  beta/cutover require health-200.
- install asserts artifact seal + SHA + safe tar paths + BUILD_ID + native driver.
- beta clones DATA_DIR via SQLite backup API (never raw WAL copy).
- policy() pins grant-bearing tables + key_value namespaces; volatile runtime
  keys excluded ONLY via the explicit EXCLUDED list (proof-carried).
- Secrets: only secret NAMES travel in the env allowlist; values flow via
  EnvironmentFile 0600. .env/server.env are never staged (pack.py asserts).
"""
import argparse
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

TABLES = ['api_keys', 'combos', 'provider_nodes', 'registered_keys',
          'provider_key_limits', 'account_key_limits', 'key_groups',
          'key_group_members', 'key_preferences', 'user_combos',
          'retired_api_key_hashes', 'group_model_permissions',
          'api_key_token_limits', 'api_key_quota_limits',
          'model_combo_mappings', 'api_key_context_sources', 'proxy_assignments',
          'quota_recovery_tickets', 'sso_identities']
NS = ['apiKeySelfService', 'feature_flags', 'modelCompatOverrides', 'proxyConfig', 'settings']
EXCLUDED = {'_settingsRevision', 'learnedRateLimits', 'model_sync_last_run',
            'provider_limits_auto_sync_last_run', 'codex_catalog_revalidated_version'}


def build_parser():
    ap = argparse.ArgumentParser(description="Local omniroute rollout helper")
    ap.add_argument("--work-dir", default=str(HERE))
    ap.add_argument("--unit", default="omniroute-repo.service")
    ap.add_argument("--drop", default=None,
                    help="task drop-in path (default ~/.config/systemd/user/<unit>.d/zz-release.conf)")
    ap.add_argument("--node", default="/home/zuxler/.local/node-v24.15.0/bin/node")
    ap.add_argument("--beta-unit", default="omniroute-beta.service")
    ap.add_argument("--releases-root", default=None,
                    help="default ~/.local/share/omniroute/releases")
    ap.add_argument("--stable-port", type=int, default=20128)
    ap.add_argument("--beta-port", type=int, default=20129)
    ap.add_argument("--approval", default="parent-approved.json")
    ap.add_argument("--policy-format", default="c3854-v1")
    ap.add_argument("--new-tables", default="quota_recovery_tickets,sso_identities")
    ap.add_argument("--heap-mb", type=int, default=4096)
    ap.add_argument("--stream-timeout-ms", default="180000")
    ap.add_argument("--help-policy", action="store_true",
                    help="print TABLES/NS/EXCLUDED contract and exit")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("seal")
    ins = sub.add_parser("install")
    ins.add_argument("--artifact", required=True)
    ins.add_argument("--release", required=True)
    ins.add_argument("--build-id", required=True)
    sub.add_parser("beta")
    sub.add_parser("cutover")
    return ap


class Ctx:
    def __init__(self, args):
        self.args = args
        self.D = Path(args.work_dir)
        self.unit = args.unit
        self.drop = Path(args.drop) if args.drop else (
            Path.home() / f".config/systemd/user/{args.unit}.d/zz-release.conf")
        self.node = args.node
        self.beta_unit = args.beta_unit
        self.releases = Path(args.releases_root) if args.releases_root else (
            Path.home() / ".local/share/omniroute/releases")
        self.new_tables = set(t for t in args.new_tables.split(",") if t)
        self.heap = args.heap_mb
        self.stream_timeout = args.stream_timeout_ms
        self.approval = args.approval
        self.policy_format = args.policy_format


def run(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw).stdout.strip()


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def migrations_listing_sha(names):
    """pack.py artifact convention: sha256 of `ls src/lib/db/migrations/*.sql | sort`.

    The artifact ships the hex STRING (pack.py `migrations` field), not a list,
    so install() must hash its extracted listing the same way — never iterate
    the string as if it were filenames.
    """
    h = hashlib.sha256()
    for n in sorted(names):
        h.update(("src/lib/db/migrations/%s\n" % n).encode())
    return h.hexdigest()


def verify_migrations(target, want):
    migr_dir = target / "migrations"
    assert migr_dir.is_dir(), "migrations dir missing in image: " + str(migr_dir)
    names = sorted(p.name for p in migr_dir.glob("*.sql"))
    assert names, "no migrations in image: " + str(migr_dir)
    assert migrations_listing_sha(names) == want, \
        "artifact migration listing drift: image=%s" % ",".join(names)
    return names


def prop(ctx, n):
    return run(["systemctl", "--user", "show", ctx.unit, "-p", n, "--value"])


def readjson(ctx, n):
    return json.loads((ctx.D / n).read_text())


def save(ctx, n, d):
    p = ctx.D / n
    p.write_text(json.dumps(d, indent=2) + "\n")
    p.chmod(0o600)


def env_of(pid):
    return dict(x.split(b"=", 1) for x in
                Path("/proc", str(pid), "environ").read_bytes().split(b"\0") if b"=" in x)


def ledger(db):
    c = sqlite3.connect("file:" + str(db) + "?mode=ro", uri=True)
    try:
        return [r[0] for r in c.execute("SELECT version FROM _omniroute_migrations ORDER BY version")]
    finally:
        c.close()


def policy(ctx, db):
    c = sqlite3.connect("file:" + str(db) + "?mode=ro", uri=True)
    result = {"policy_format": ctx.policy_format}
    have = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table in TABLES:
        cols = [r[1] for r in c.execute("PRAGMA table_info(" + table + ")")
                if not (table == "api_keys" and r[1] == "last_used_at")]
        if not cols:
            if table in ctx.new_tables and table not in have:
                continue  # declared-new table legitimately absent pre-migration
            c.close()
            raise RuntimeError("policy: expected table missing: " + table)
        rows = c.execute("SELECT " + ",".join('"' + x + '"' for x in cols) +
                         ' FROM "' + table + '"').fetchall()
        encoded = sorted(json.dumps(list(r), sort_keys=True, default=str) for r in rows)
        result[table] = {"count": len(rows),
                         "sha256": hashlib.sha256("\n".join(encoded).encode()).hexdigest()}
    for namespace in NS:
        rows = c.execute("SELECT key,value FROM key_value WHERE namespace=? ORDER BY key",
                         (namespace,)).fetchall()
        if namespace == "settings":
            rows = [r for r in rows if r[0] not in EXCLUDED]
        result["key_value:" + namespace] = {"count": len(rows),
            "sha256": hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()}
    c.close()
    return result


def files_of(ctx, data):
    paths = [Path(prop(ctx, "FragmentPath")), *map(Path, prop(ctx, "DropInPaths").split()),
             data / ".env", data / "server.env"]
    return {str(p): sha(p) for p in paths if p.exists()}


def health(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:" + str(port) + "/healthz", timeout=4) as r:
            return r.status == 200
    except Exception:
        return False


def wait(port):
    for _ in range(45):
        if health(port):
            return
        time.sleep(2)
    raise RuntimeError("health deadline " + str(port))


def assert_port_free(port):
    import socket as _s
    try:
        c = _s.create_connection(("127.0.0.1", port), timeout=3)
    except OSError:
        return
    c.close()
    raise RuntimeError("port still bound: " + str(port))


def stop_exact_beta(ctx, beta_pid, strict=True):
    """Stop ONLY the recorded transient beta unit: live PID must match the receipt."""
    try:
        cur = int(run(["systemctl", "--user", "show", ctx.beta_unit, "-p", "MainPID", "--value"]))
    except ValueError:
        cur = 0
    if cur == 0:
        if strict:
            raise RuntimeError("beta unit not running when stop expected")
        assert_port_free(ctx.args.beta_port)
        print("LOCAL_BETA_ALREADY_STOPPED", beta_pid)
        return
    assert cur == beta_pid, "beta PID changed: refusing to stop foreign unit"
    run(["systemctl", "--user", "stop", ctx.beta_unit])
    assert run(["systemctl", "--user", "show", ctx.beta_unit,
                "-p", "ActiveState", "--value"]) != "active"
    assert_port_free(ctx.args.beta_port)
    print("LOCAL_BETA_STOPPED", beta_pid)


def backup(src, dest):
    c = sqlite3.connect("file:" + str(src) + "?mode=ro", uri=True)
    b = sqlite3.connect(dest)
    c.backup(b)
    assert b.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    b.close()
    c.close()
    Path(dest).chmod(0o600)


def seal(ctx):
    assert not ctx.drop.exists(), "task dropin already exists"
    pid = int(prop(ctx, "MainPID"))
    e = env_of(pid)
    data = Path(e[b"DATA_DIR"].decode())
    ok = health(ctx.args.stable_port)  # tolerant: record truth, do not raise
    d = {"pid": pid, "cwd": prop(ctx, "WorkingDirectory"), "data": str(data),
         "files": files_of(ctx, data), "policy": policy(ctx, data / "storage.sqlite"),
         "ledger": ledger(data / "storage.sqlite"),
         "health200": ok, "drop_was_present": False}
    backup(data / "storage.sqlite", ctx.D / "local-before.sqlite")
    save(ctx, "local-seal.json", d)
    print("LOCAL_SEALED", pid, "health200=" + str(ok))


def install(ctx, artifact, release, build):
    a = json.loads(Path(artifact).read_text())
    assert a.get("sealed") is True
    archive = Path(a["archive"])
    assert archive.is_file() and sha(archive) == a["sha256"]
    target = ctx.releases / release
    assert not target.exists(), "release exists; inspect before reuse"
    import tarfile
    with tarfile.open(archive, "r:gz") as tf:
        for m in tf.getmembers():
            p = Path(m.name)
            assert not p.is_absolute() and ".." not in p.parts, "unsafe archive path"
    target.mkdir(mode=0o700, parents=True)
    run(["tar", "-xzf", str(archive), "-C", str(target)])
    assert (target / "server-ws.mjs").is_file()
    assert (target / "dev/run-standalone.mjs").is_file()
    assert (target / ".build/next/BUILD_ID").read_text().strip() == build
    assert not (target / ".env").exists()
    verify_migrations(target, a["migrations"])
    run([ctx.node, "-e", "const D=require('better-sqlite3');let d=new D(':memory:');"
                          "if(d.prepare('SELECT 1 AS ok').get().ok!==1)process.exit(1);d.close()"],
        cwd=target)
    save(ctx, "local-release.json", {"path": str(target), "build_id": build,
                                    "commit": a.get("commit"), "archive_sha256": a["sha256"]})
    print("LOCAL_INSTALLED", str(target))


def beta(ctx):
    s = readjson(ctx, "local-seal.json")
    assert s["policy"]["policy_format"] == ctx.policy_format
    r = readjson(ctx, "local-release.json")
    assert r["archive_sha256"]  # bound to the installed artifact below via paths/build
    assert not (ctx.D / "local-beta-data").exists()
    data = ctx.D / "local-beta-data"
    data.mkdir(mode=0o700)
    backup(Path(s["data"]) / "storage.sqlite", data / "storage.sqlite")
    for n in [".env", "server.env"]:
        p = Path(s["data"]) / n
        if p.exists():
            shutil.copy2(p, data / n)
            (data / n).chmod(0o600)
    e = env_of(s["pid"])
    allowed = ["PATH", "HOME", "LANG", "JWT_SECRET", "STORAGE_ENCRYPTION_KEY",
               "INITIAL_PASSWORD", "NEXTAUTH_SECRET", "AUTH_SECRET"]
    be = {k: e[k.encode()].decode() for k in allowed if k.encode() in e}
    be.update({"DATA_DIR": str(data), "PORT": str(ctx.args.beta_port),
               "API_PORT": str(ctx.args.beta_port),
               "HOSTNAME": "127.0.0.1", "OMNIROUTE_HOSTNAME": "127.0.0.1",
               "NODE_ENV": "production", "OMNIROUTE_BUILD_ID": r["build_id"],
               "OMNIROUTE_DISABLE_BACKGROUND_SERVICES": "true",
               "OMNIROUTE_ENABLE_RUNTIME_BACKGROUND_TASKS": "false",
               "OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK": "true",
               "OMNIROUTE_DISABLE_LOCAL_HEALTHCHECK": "true",
               "OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK": "true",
               "STREAM_READINESS_TIMEOUT_MS": ctx.stream_timeout,
               "NODE_OPTIONS": f"--max-old-space-size={ctx.heap}"})

    def esc(v):
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'
    ef = ctx.D / "local-beta.env"
    ef.write_text("".join(k + "=" + esc(v) + "\n" for k, v in be.items()))
    ef.chmod(0o600)
    args = ["systemd-run", "--user", "--unit=" + ctx.beta_unit, "--property=MemoryMax=10G",
            "--property=MemorySwapMax=0", "--property=WorkingDirectory=" + r["path"],
            "--property=EnvironmentFile=" + str(ef), ctx.node,
            f"--max-old-space-size={ctx.heap}", "dev/run-standalone.mjs"]
    run(args)
    wait(ctx.args.beta_port)
    assert int(prop(ctx, "MainPID")) == s["pid"], "Stable changed while qualifying"
    beta_pid = int(run(["systemctl", "--user", "show", ctx.beta_unit,
                        "-p", "MainPID", "--value"]))
    assert run(["systemctl", "--user", "show", ctx.beta_unit,
                "-p", "WorkingDirectory", "--value"]) == r["path"]
    assert env_of(beta_pid)[b"OMNIROUTE_BUILD_ID"].decode() == r["build_id"]
    cb = sqlite3.connect("file:" + str(data / "storage.sqlite") + "?mode=ro", uri=True)
    try:
        lafter = [row[0] for row in cb.execute(
            "SELECT version FROM _omniroute_migrations ORDER BY version")]
        idx = {row[0] for row in cb.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        assert "idx_rcl_api_key_ts_cover" in idx, "missing 230 cover index on clone"
        assert "idx_rcl_request_id" in idx, "missing 230 request_id index on clone"
        assert "idx_quota_recovery_due" in idx, "missing 231 due index on clone"
    finally:
        cb.close()
    after = policy(ctx, data / "storage.sqlite")
    assert after["policy_format"] == ctx.policy_format
    pre = s["policy"]
    new_keys = set(after) - set(pre)
    allowed_new = {"quota_recovery_tickets", "sso_identities",
                   "request_cost_ledger", "proxy_subscriptions"}
    assert new_keys <= allowed_new, "unexpected new policy keys: " + str(sorted(new_keys))
    for k in set(pre) & set(after):
        if k in ("quota_recovery_tickets", "sso_identities") or k.startswith("key_value:"):
            continue
        assert pre[k] == after[k], "policy drift: " + k
    assert set(s["ledger"]) <= set(lafter), "migration went backwards"
    save(ctx, "local-beta.json", {"health": 200, "build_id": r["build_id"], "unit": ctx.beta_unit,
        "pid": beta_pid, "archive_sha256": r["archive_sha256"], "qualified": True})
    print("LOCAL_BETA_QUALIFIED", beta_pid, r["build_id"])


def cutover(ctx):
    s = readjson(ctx, "local-seal.json")
    r = readjson(ctx, "local-release.json")
    b = readjson(ctx, "local-beta.json")
    ap = readjson(ctx, ctx.approval)  # parent countersign; never written by beta()
    assert b["qualified"] is True
    assert b["build_id"] == r["build_id"] and b["unit"] == ctx.beta_unit
    assert b["archive_sha256"] == r["archive_sha256"] == ap["archive_sha256"]
    assert ap["build_id"] == r["build_id"] and ap.get("approved") is True
    assert ap.get("scope") == "local-cutover"
    beta_pid = int(run(["systemctl", "--user", "show", ctx.beta_unit,
                        "-p", "MainPID", "--value"]))
    assert beta_pid == b["pid"]
    assert run(["systemctl", "--user", "show", ctx.beta_unit,
                "-p", "WorkingDirectory", "--value"]) == r["path"]
    assert env_of(beta_pid)[b"OMNIROUTE_BUILD_ID"].decode() == r["build_id"]
    assert int(prop(ctx, "MainPID")) == s["pid"]
    assert prop(ctx, "WorkingDirectory") == s["cwd"]
    assert files_of(ctx, Path(s["data"])) == s["files"]
    assert not ctx.drop.exists()
    assert health(ctx.args.beta_port)
    backup(Path(s["data"]) / "storage.sqlite", ctx.D / "local-before.sqlite")
    changed = False
    try:
        changed = True
        ctx.drop.write_text("[Service]\nWorkingDirectory=" + r["path"] + "\nExecStart=\nExecStart="
                            + ctx.node + f" --max-old-space-size={ctx.heap} dev/run-standalone.mjs\n"
                            + "Environment=OMNIROUTE_BUILD_ID=" + r["build_id"] + "\n")
        run(["systemctl", "--user", "daemon-reload"])
        run(["systemctl", "--user", "restart", ctx.unit])
        wait(ctx.args.stable_port)
        assert prop(ctx, "WorkingDirectory") == r["path"]
        assert prop(ctx, "ActiveState") == "active"
        assert int(prop(ctx, "MainPID")) != s["pid"]
        newenv = env_of(prop(ctx, "MainPID"))
        assert newenv[b"OMNIROUTE_BUILD_ID"].decode() == r["build_id"]
        assert newenv[b"DATA_DIR"].decode() == s["data"]
        assert newenv.get(b"STREAM_READINESS_TIMEOUT_MS") == ctx.stream_timeout.encode()
        assert int(prop(ctx, "MemoryMax")) == 10737418240
        assert int(prop(ctx, "MemorySwapMax")) == 0
        save(ctx, "local-final.json", {"deployed": True, "pid": int(prop(ctx, "MainPID")),
                                      "build_id": r["build_id"], "health": 200,
                                      "restarts": int(prop(ctx, "NRestarts"))})
        stop_exact_beta(ctx, beta_pid, strict=True)  # beta must be the recorded PID
        assert_port_free(ctx.args.beta_port)
        print("LOCAL_STABLE_DEPLOYED", prop(ctx, "MainPID"), r["build_id"])
    except Exception:
        if changed:
            stop_exact_beta(ctx, beta_pid, strict=False)  # never strand beta on rollback
            ctx.drop.unlink(missing_ok=True)
            run(["systemctl", "--user", "daemon-reload"])
            run(["systemctl", "--user", "restart", ctx.unit])
            wait(ctx.args.stable_port)
            assert prop(ctx, "WorkingDirectory") == s["cwd"]
            assert_port_free(ctx.args.beta_port)
            print("LOCAL_METADATA_ROLLBACK_OK")
        raise


def print_policy():
    print(json.dumps({"tables": TABLES, "namespaces": NS, "excluded": sorted(EXCLUDED)}, indent=2))


def main(argv=None):
    ap = build_parser()
    args = ap.parse_args(argv)
    if args.help_policy:
        print_policy()
        return
    if not args.cmd:
        ap.error("one of {seal,install,beta,cutover} required")
    ctx = Ctx(args)
    {"seal": lambda: seal(ctx),
     "install": lambda: install(ctx, args.artifact, args.release, args.build_id),
     "beta": lambda: beta(ctx),
     "cutover": lambda: cutover(ctx)}[args.cmd]()


if __name__ == "__main__":
    main()
