#!/usr/bin/env python3
"""Tencent rollout helper (fork/deploy). seal/beta/promote for a root
systemd omniroute unit. Parametrised port of the scratch
rollout/tencent-release.py: every host-specific value arrives via CLI args.

Config (argparse; defaults mirror the 3854 Tencent run):
  --unit, --current (symlink), --releases, --data, --migr-sub, --drop,
  --node, --stable-port, --beta-port, --approval, --policy-format,
  --new-tables, --heap-mb, --min-free-gb, --min-avail-mb,
  --migration-230/--migration-231 name+sha pins,
  --ledger-top, --clone-dir (/var/lib/omniroute-beta-<release>)
  beta/promote take IMAGE BUILD BOOT (image name, build id, boot receipt).

Receipts live in --work-dir (chmod 0600, root-owned on host).
Usage (root on Tencent):
  tencent-release.py seal --work-dir D [--unit ...]
  tencent-release.py beta IMAGE BUILD BOOT --work-dir D --artifact A ...
      (needs parent GO)
  tencent-release.py promote IMAGE BUILD BOOT --work-dir D ...  (needs GO)
  tencent-release.py --help-policy  # print TABLES/NS/EXCLUDED contract

Safety (unchanged): seal read-only (+local JSON); beta asserts disk/mem;
stage unpacks safe paths + migration list; promote is an atomic symlink swap
with metadata rollback; secrets flow via EnvironmentFile 0600.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

TABLES = ["api_keys", "combos", "provider_nodes", "registered_keys",
          "provider_key_limits", "account_key_limits", "key_groups",
          "key_group_members", "key_preferences", "user_combos",
          "retired_api_key_hashes", "group_model_permissions",
          "api_key_token_limits", "api_key_quota_limits",
          "model_combo_mappings", "api_key_context_sources", "proxy_assignments",
          "quota_recovery_tickets", "sso_identities",
          "request_cost_ledger", "proxy_subscriptions"]
NS = ["apiKeySelfService", "feature_flags", "modelCompatOverrides", "proxyConfig", "settings"]
EXCLUDED = {"_settingsRevision", "learnedRateLimits", "model_sync_last_run",
            "provider_limits_auto_sync_last_run", "codex_catalog_revalidated_version"}
BETA_UNIT = "omniroute-beta.service"


def build_parser():
    ap = argparse.ArgumentParser(description="Tencent omniroute rollout helper")
    ap.add_argument("--work-dir", default=str(HERE))
    ap.add_argument("--unit", default="omniroute.service")
    ap.add_argument("--current", default="/opt/omniroute-current")
    ap.add_argument("--releases", default="/opt/omniroute-releases")
    ap.add_argument("--data", default="/var/lib/omniroute")
    ap.add_argument("--migr-sub", default="migrations")
    ap.add_argument("--drop", default=None,
                    help="task drop-in (default /etc/systemd/system/<unit>.d/zz-release.conf)")
    ap.add_argument("--node", default="/opt/node/bin/node")
    ap.add_argument("--stable-port", type=int, default=20128)
    ap.add_argument("--beta-port", type=int, default=20129)
    ap.add_argument("--approval", default="parent-approved.json")
    ap.add_argument("--policy-format", default="c3854-v1")
    ap.add_argument("--new-tables", default="quota_recovery_tickets,sso_identities")
    ap.add_argument("--heap-mb", type=int, default=1024)
    ap.add_argument("--min-free-gb", type=float, default=2.0)
    ap.add_argument("--min-avail-mb", type=float, default=600.0)
    ap.add_argument("--migration-230", default="230_request_cost_ledger_read_indexes.sql",
                    help="NAME or NAME:SHA256 of the 230 migration pin")
    ap.add_argument("--migration-231", default="231_quota_recovery_due_cover.sql",
                    help="NAME or NAME:SHA256 of the 231 migration pin")
    ap.add_argument("--ledger-top", default="231")
    ap.add_argument("--clone-dir", default=None,
                    help="default /var/lib/omniroute-beta-<release>")
    ap.add_argument("--service-user", default="omniroute",
                    help="OS user the beta unit runs as; owns the clone dir")
    ap.add_argument("--help-policy", action="store_true")
    ap.add_argument("cmd", nargs="?", choices=["seal", "beta", "promote"])
    ap.add_argument("image", nargs="?")
    ap.add_argument("build", nargs="?")
    ap.add_argument("boot", nargs="?")
    return ap


class Ctx:
    def __init__(self, args):
        self.args = args
        self.D = Path(args.work_dir)
        self.unit = args.unit
        self.current = Path(args.current)
        self.releases = Path(args.releases)
        self.data = Path(args.data)
        self.migr_sub = args.migr_sub
        self.drop = Path(args.drop) if args.drop else (
            Path(f"/etc/systemd/system/{args.unit}.d/zz-release.conf"))
        self.node = args.node
        self.new_tables = set(t for t in args.new_tables.split(",") if t)
        self.heap = args.heap_mb
        self.policy_format = args.policy_format
        self.min_free = int(args.min_free_gb * 1024 ** 3)
        self.min_avail = int(args.min_avail_mb * 1024 ** 2)
        self.ledger_top = str(args.ledger_top)

    def pin(self, spec):
        """'NAME' or 'NAME:SHA256' -> (name, sha or None)."""
        name, _, want = spec.partition(":")
        return name, want or None


def run(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw).stdout.strip()


def show(ctx, n):
    return run(["systemctl", "show", ctx.unit, "-p", n, "--value"])


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def readjson(ctx, n):
    return json.loads((ctx.D / n).read_text())


def save(ctx, n, d):
    p = ctx.D / n
    if p.exists():
        raise FileExistsError("refusing to overwrite " + str(p))
    p.write_text(json.dumps(d, indent=2) + "\n")
    p.chmod(0o600)


def health(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:" + str(port) + "/healthz", timeout=4) as r:
            return r.status == 200
    except Exception:
        return False


def require_health(port):
    if not health(port):
        raise RuntimeError("health not 200 on " + str(port))


def assert_port_free(port):
    import socket as _s
    try:
        c = _s.create_connection(("127.0.0.1", port), timeout=3)
    except OSError:
        return
    c.close()
    raise RuntimeError("port still bound: " + str(port))


def stop_exact_beta(ctx, beta_pid, strict=True):
    try:
        cur = int(run(["systemctl", "show", BETA_UNIT, "-p", "MainPID", "--value"]))
    except ValueError:
        cur = 0
    if cur == 0:
        if strict:
            raise RuntimeError("beta unit not running when stop expected")
        assert_port_free(ctx.args.beta_port)
        print("TENCENT_BETA_ALREADY_STOPPED", beta_pid)
        return
    assert cur == beta_pid, "beta PID changed: refusing to stop foreign unit"
    run(["systemctl", "stop", BETA_UNIT])
    assert run(["systemctl", "show", BETA_UNIT, "-p", "ActiveState", "--value"]) != "active"
    assert_port_free(ctx.args.beta_port)
    print("TENCENT_BETA_STOPPED", beta_pid)


def ledger(ctx, db):
    c = sqlite3.connect("file:" + str(db) + "?mode=ro", uri=True, timeout=30)
    try:
        return [r[0] for r in c.execute("SELECT version FROM _omniroute_migrations ORDER BY version")]
    finally:
        c.close()


def policy(ctx, db):
    c = sqlite3.connect("file:" + str(db) + "?mode=ro", uri=True, timeout=30)
    result = {"policy_format": ctx.policy_format}
    have = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table in TABLES:
        got = [r[1] for r in c.execute("PRAGMA table_info(" + table + ")")
               if not (table == "api_keys" and r[1] == "last_used_at")]
        if not got:
            if table in ctx.new_tables and table not in have:
                continue
            c.close()
            raise RuntimeError("policy: expected table missing: " + table)
        rows = c.execute("SELECT " + ",".join('"' + x + '"' for x in got) +
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


def identity(ctx):
    dropins = Path(f"/etc/systemd/system/{ctx.unit}.d")
    return {"main_pid": show(ctx, "MainPID"), "active": show(ctx, "ActiveState"),
            "nrestarts": show(ctx, "NRestarts"),
            "working_directory": show(ctx, "WorkingDirectory"),
            "current_link": str(ctx.current.resolve()) if ctx.current.is_symlink() else None,
            "exec_start": show(ctx, "ExecStart"),
            "dropins": sorted(p.name for p in dropins.glob("*.conf")) if dropins.is_dir() else []}


def backup(src, dest):
    c = sqlite3.connect("file:" + str(src) + "?mode=ro", uri=True, timeout=30)
    b = sqlite3.connect(dest)
    c.backup(b)
    assert b.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    b.close()
    c.close()
    Path(dest).chmod(0o600)


def disk_free_bytes(path):
    import shutil as _sh
    return _sh.disk_usage(path).free


def mem_avail_bytes():
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("MemAvailable not found in /proc/meminfo")


def seal(ctx):
    """READ-ONLY (+ local JSON write): record Stable truth. Never fails on outage."""
    assert disk_free_bytes("/") >= ctx.min_free, "disk free <2G on /"
    assert disk_free_bytes(str(ctx.data)) >= ctx.min_free, "disk free <2G on DATA_DIR"
    assert not ctx.drop.exists(), "task dropin already exists"
    ok = health(ctx.args.stable_port)
    data = {"policy_format": ctx.policy_format,
            "identity": identity(ctx),
            "policy": policy(ctx, ctx.data / "storage.sqlite"),
            "ledger": ledger(ctx, ctx.data / "storage.sqlite"),
            "health200": ok}
    snap = ctx.D / "tencent-before.sqlite"
    assert not snap.exists(), "snapshot exists; inspect before reuse"
    backup(ctx.data / "storage.sqlite", snap)
    save(ctx, "tencent-seal.json", data)
    print("TENCENT_SEALED", data["identity"]["main_pid"], "health200=" + str(ok))


def chown_tree(path, user):
    """chown -R path to the service user; the beta unit runs as this user."""
    import pwd
    import shutil
    uid = pwd.getpwnam(user).pw_uid
    gid = pwd.getpwnam(user).pw_gid
    for root, dirs, files in os.walk(path):
        shutil.chown(root, user, user)
        for n in dirs + files:
            shutil.chown(os.path.join(root, n), user, user)
    return uid, gid


def migrations_listing_sha(names):
    """pack.py artifact convention: sha256 of `ls src/lib/db/migrations/*.sql | sort`.

    The artifact ships the hex STRING (pack.py `migrations` field), not a list,
    so runners must hash their extracted listing the same way — never iterate
    the string as if it were filenames.
    """
    h = hashlib.sha256()
    for n in sorted(names):
        h.update(("src/lib/db/migrations/%s\n" % n).encode())
    return h.hexdigest()


def verify_migrations(target, migr_sub, want):
    migr_dir = target / migr_sub
    assert migr_dir.is_dir(), "migrations dir missing in image: " + str(migr_dir)
    names = sorted(p.name for p in migr_dir.glob("*.sql"))
    assert names, "no migrations in image: " + str(migr_dir)
    assert migrations_listing_sha(names) == want, \
        "artifact migration listing drift: image=%s" % ",".join(names)
    return names


def stage(ctx, image, build, s, a):
    """Unpack artifact tarball to a unique release dir + clone DATA_DIR via backup API."""
    import tarfile
    archive = Path(a["archive"])
    assert archive.is_file() and sha(archive) == a["sha256"]
    target = ctx.releases / a["release"]
    assert not target.exists(), "release exists; inspect before reuse"
    with tarfile.open(archive, "r:gz") as tf:
        for m in tf.getmembers():
            p = Path(m.name)
            assert not p.is_absolute() and ".." not in p.parts, "unsafe archive path"
    target.mkdir(mode=0o700)
    run(["tar", "-xzf", str(archive), "-C", str(target)])
    # Flat packs (pack.py 758697d9dd) land entrypoints at target root; a
    # single top dir named exactly <release> is an OLD nested artifact —
    # strip it. Anything else nested is rejected (no silent mis-extract).
    tops = [p for p in target.iterdir()]
    if len(tops) == 1 and tops[0].name == a["release"] and tops[0].is_dir() and \
            (tops[0] / "dev/run-standalone.mjs").is_file():
        for child in tops[0].iterdir():
            child.rename(target / child.name)
        tops[0].rmdir()
    assert (target / "dev/run-standalone.mjs").is_file(), \
        "entrypoint missing: flat pack expected, nested artifact not stripped"
    assert (target / ctx.migr_sub).is_dir()
    assert (target / ".build/next/BUILD_ID").read_text().strip() == build
    verify_migrations(target, ctx.migr_sub, a["migrations"])
    chown_tree(str(target), ctx.args.service_user)
    run([ctx.node, "-e",
         "const D=require('better-sqlite3');let d=new D(':memory:');"
         "if(d.prepare('SELECT 1 AS ok').get().ok!==1)process.exit(1);d.close()"],
        cwd=target)
    clone = Path(ctx.args.clone_dir) if ctx.args.clone_dir else Path(f"/var/lib/omniroute-beta-{a['release']}")
    assert not clone.exists(), "beta clone exists; inspect before reuse"
    clone.mkdir(mode=0o700)
    backup(ctx.data / "storage.sqlite", clone / "storage.sqlite")
    p = ctx.data / "server.env"
    assert p.is_file(), "protected file missing: server.env"
    import shutil as _sh
    _sh.copy2(p, clone / "server.env")
    (clone / "server.env").chmod(0o600)
    # STORAGE_ENCRYPTION_KEY lives in DATA_DIR/.env (never in server.env);
    # beta bootstrap refuses to generate it when the clone DB has encrypted
    # credentials. Copy it 0600 alongside server.env; never print its value.
    de = ctx.data / ".env"
    if de.is_file():
        _sh.copy2(de, clone / ".env")
        (clone / ".env").chmod(0o600)
    chown_tree(str(clone), ctx.args.service_user)
    return target, clone


def boot_qualify(ctx, target, clone, build, s, a):
    """Boot candidate on beta port with candidate migrations dir; assert health + deltas."""
    ef = ctx.D / "tencent-beta.env"
    assert not ef.exists(), "beta env exists; inspect before reuse"
    lines = ["DATA_DIR=\"%s\"" % str(clone), "PORT=\"%d\"" % ctx.args.beta_port,
             "API_PORT=\"%d\"" % ctx.args.beta_port,
             "HOSTNAME=\"127.0.0.1\"", "OMNIROUTE_HOSTNAME=\"127.0.0.1\"",
             "NODE_ENV=\"production\"", "OMNIROUTE_BUILD_ID=\"%s\"" % build,
             "OMNIROUTE_MIGRATIONS_DIR=\"%s\"" % str(target / ctx.migr_sub),
             "NODE_OPTIONS=\"--max-old-space-size=%d\"" % ctx.heap,
             "OMNIROUTE_DISABLE_BACKGROUND_SERVICES=\"true\"",
             "OMNIROUTE_ENABLE_RUNTIME_BACKGROUND_TASKS=\"false\"",
             "OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK=\"true\"",
             "OMNIROUTE_DISABLE_LOCAL_HEALTHCHECK=\"true\"",
             "OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=\"true\"",
             "STREAM_READINESS_TIMEOUT_MS=\"180000\""]
    # EnvironmentFile= takes bare KEY=value lines — never the `Environment=`
    # unit-directive prefix (systemd silently drops prefixed lines, which
    # once left beta on PORT 20128 fighting stable -> EADDRINUSE).
    ef.write_text("\n".join(line for line in lines) + "\n")
    ef.chmod(0o600)
    port_lines = {l.split("=", 1)[0]: l for l in lines}
    assert port_lines["PORT"] == 'PORT="%d"' % ctx.args.beta_port, \
        "beta env PORT drift: " + port_lines["PORT"]
    unit = ctx.D / "omniroute-beta.service"
    unit.write_text("[Unit]\nDescription=OmniRoute beta (fork)\nAfter=network-online.target\n"
                    "[Service]\nType=simple\nUser=omniroute\nGroup=omniroute\n"
                    "WorkingDirectory=" + str(target) + "\n"
                    "EnvironmentFile=" + str(ef) + "\n"
                    "EnvironmentFile=" + str(clone / "server.env") + "\n"
                    f"ExecStart={ctx.node} dev/run-standalone.mjs\n"
                    "Restart=no\n[Install]\nWantedBy=multi-user.target\n")
    try:
        run(["cp", str(unit), "/etc/systemd/system/omniroute-beta.service"])
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "start", "omniroute-beta.service"])
        for _ in range(90):
            if health(ctx.args.beta_port):
                break
            time.sleep(2)
        require_health(ctx.args.beta_port)
        assert show(ctx, "MainPID") == s["identity"]["main_pid"], "Stable changed while qualifying"
        c = sqlite3.connect("file:" + str(clone / "storage.sqlite") + "?mode=ro", uri=True, timeout=30)
        try:
            got_build = c.execute(
                "SELECT value FROM key_value WHERE namespace='meta' AND key='build_id'").fetchall()
            if got_build:
                assert got_build[0][0] == build, "clone BUILD_ID drift"
            lafter = [r[0] for r in c.execute(
                "SELECT version FROM _omniroute_migrations ORDER BY version")]
            assert lafter[-1] == ctx.ledger_top, "ledger top not %s: %r" % (ctx.ledger_top, lafter[-3:])
            idx = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index'")}
            assert "idx_rcl_api_key_ts_cover" in idx, "missing 230 cover index on clone"
            assert "idx_rcl_request_id" in idx, "missing 230 request_id index on clone"
            assert "idx_quota_recovery_due" in idx, "missing 231 due index on clone"
        finally:
            c.close()
        after = policy(ctx, clone / "storage.sqlite")
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
        rss = int(Path("/proc", run(["systemctl", "show", "omniroute-beta.service",
                                     "-p", "MainPID", "--value"]), "status")
                  .read_text().split("VmRSS:")[1].split()[0]) * 1024
        assert rss < 900 * 1024 ** 2, "beta RSS too large: %dMB" % (rss // 1024 ** 2)
    except BaseException:
        run(["systemctl", "stop", "omniroute-beta.service"])
        raise
    print("TENCENT_BETA_BOOT_QUALIFIED", build)


def beta(ctx, image, build, boot):
    """Stage candidate under unique release dir + cloned DATA_DIR on beta port. (needs GO)"""
    assert disk_free_bytes("/") >= ctx.min_free, "disk free <2G on /"
    assert disk_free_bytes(str(ctx.data)) >= ctx.min_free, "disk free <2G on DATA_DIR"
    assert mem_avail_bytes() >= ctx.min_avail, "MemAvailable too low: beta+stable will not fit"
    a = readjson(ctx, "tencent-artifact.json")
    assert a.get("sealed") is True
    assert build == a["build_id"]
    s = readjson(ctx, "tencent-seal.json")
    assert s["policy"]["policy_format"] == ctx.policy_format
    assert a["commit"] == s.get("artifact_commit_expected", a["commit"]), "artifact/commit binding"
    target, clone = stage(ctx, image, build, s, a)
    boot_qualify(ctx, target, clone, build, s, a)
    beta_pid = int(run(["systemctl", "show", "omniroute-beta.service",
                        "-p", "MainPID", "--value"]))
    save(ctx, "tencent-beta.json", {"health": 200, "build_id": build, "image": image,
        "target": str(target), "clone": str(clone), "pid": beta_pid,
        "archive_sha256": a["sha256"], "qualified": True})
    print("TENCENT_BETA_QUALIFIED", beta_pid, build)


def promote(ctx, image, build, boot):
    """Atomic symlink swap to qualified release; metadata rollback on failed health. (needs GO)"""
    a = readjson(ctx, "tencent-artifact.json")
    assert a.get("sealed") is True and build == a["build_id"]
    q = readjson(ctx, "tencent-beta.json")
    ap = readjson(ctx, ctx.args.approval)  # parent countersign; never written by beta()
    assert q["qualified"] is True
    assert q["build_id"] == build == ap["build_id"] and q["image"] == image == ap.get("image", image)
    assert q["archive_sha256"] == a["sha256"] == ap["archive_sha256"]
    assert ap.get("approved") is True and ap.get("scope") == "tencent-promote"
    s = readjson(ctx, "tencent-seal.json")
    assert s["policy"]["policy_format"] == ctx.policy_format
    target = str(ctx.releases / a["release"])  # derived from sealed artifact, not receipt
    assert q.get("target", target) == target, "receipt target drift"
    beta_pid = int(q["pid"])
    assert run(["systemctl", "show", "omniroute-beta.service",
                "-p", "ActiveState", "--value"]) != "active", \
        "beta still running; stop exact unit before promote"
    assert_port_free(ctx.args.beta_port)
    assert Path(target, ".build", "next", "BUILD_ID").read_text().strip() == build, "extracted BUILD_ID drift"
    assert Path(target, "dev", "run-standalone.mjs").exists()
    name230, want230 = ctx.pin(ctx.args.migration_230)
    name231, want231 = ctx.pin(ctx.args.migration_231)
    for name, want in ((name230, want230), (name231, want231)):
        p = Path(target, ctx.migr_sub, name)
        assert p.is_file(), "extracted migration missing: " + name
        if want:
            assert hashlib.sha256(p.read_bytes()).hexdigest() == want, "extracted migration drift: " + name
    assert int(show(ctx, "MainPID")) == int(s["identity"]["main_pid"])
    assert show(ctx, "WorkingDirectory") == s["identity"]["working_directory"]
    assert not ctx.drop.exists(), "task dropin already exists"
    old_link = str(ctx.current.resolve()) if ctx.current.is_symlink() else None
    changed = False
    try:
        changed = True
        ctx.drop.write_text("[Service]\nEnvironment=OMNIROUTE_BUILD_ID=" + build + "\n")
        ctx.drop.chmod(0o600)
        (ctx.releases / ".omniroute-current-prev").write_text((old_link or "") + "\n")
        tmp_link = Path(str(ctx.current) + "-next")
        if tmp_link.is_symlink() or tmp_link.exists():
            tmp_link.unlink()
        tmp_link.symlink_to(target)
        tmp_link.rename(ctx.current)  # atomic swap (same parent dir)
        assert ctx.current.is_symlink() and str(ctx.current.resolve()) == target
        assert "OMNIROUTE_BUILD_ID=" + build in ctx.drop.read_text()
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "restart", ctx.unit])
        for _ in range(90):
            if health(ctx.args.stable_port):
                break
            time.sleep(2)
        require_health(ctx.args.stable_port)
        new_pid = int(show(ctx, "MainPID"))
        assert new_pid != int(s["identity"]["main_pid"]), "stable PID unchanged after restart"
        assert show(ctx, "WorkingDirectory") == str(ctx.current), "unit WorkingDirectory moved"
        assert str(Path("/proc", str(new_pid), "cwd").resolve()) == target, "live cwd not on new release"
        assert show(ctx, "ActiveState") == "active"
        assert "OMNIROUTE_BUILD_ID=" + build in show(ctx, "Environment").split()
        save(ctx, "tencent-final.json", {"deployed": True,
            "pid": show(ctx, "MainPID"), "build_id": build, "image": image,
            "health": 200, "nrestarts": show(ctx, "NRestarts")})
        stop_exact_beta(ctx, beta_pid, strict=False)
        assert_port_free(ctx.args.beta_port)
        print("TENCENT_STABLE_DEPLOYED", show(ctx, "MainPID"), build)
    except BaseException:
        if changed:
            stop_exact_beta(ctx, beta_pid, strict=False)
            try:
                if old_link:
                    t = Path(str(ctx.current) + "-next")
                    if t.is_symlink() or t.exists():
                        t.unlink()
                    t.symlink_to(old_link)
                    t.rename(ctx.current)
                ctx.drop.unlink(missing_ok=True)
            finally:
                run(["systemctl", "daemon-reload"])
                run(["systemctl", "restart", ctx.unit])
                for _ in range(90):
                    if health(ctx.args.stable_port):
                        break
                    time.sleep(2)
                require_health(ctx.args.stable_port)
                assert show(ctx, "WorkingDirectory") == s["identity"]["working_directory"]
                assert_port_free(ctx.args.beta_port)
                print("TENCENT_METADATA_ROLLBACK_OK")
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
        ap.error("one of {seal,beta,promote} required")
    ctx = Ctx(args)
    if args.cmd == "seal":
        seal(ctx)
    elif args.cmd == "beta":
        beta(ctx, args.image, args.build, args.boot)
    elif args.cmd == "promote":
        promote(ctx, args.image, args.build, args.boot)


if __name__ == "__main__":
    main()
