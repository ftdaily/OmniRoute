"""Tests for fork/deploy/tencent-release.py + fork/deploy/local-release.py fixes.

Covers the 5 Tencent Beta workarounds folded into the scripts (TENCENT-SCRIPT):
1. Ctx.policy_format bound like local-release.py (was AttributeError).
2. stage() extracts flat pack output; a single top dir == release name
   (old nested artifacts) is stripped; target chowned to --service-user.
3. artifact.json `migrations` is a sha256 STRING of the pack.py listing;
   stage()/install() compare listing hashes instead of iterating chars.
4. tencent-beta.env is written plain KEY=value (EnvironmentFile= rejects
   the `Environment=` unit-directive prefix); PORT == beta port asserted.
5. stage() copies DATA_DIR/.env (STORAGE_ENCRYPTION_KEY) into the clone
   0600 without logging its content. Local beta() already did both.
"""
import hashlib
import io
import os
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest import mock

DEPLOY = os.path.dirname(os.path.abspath(__file__))

import importlib.util

_spec = importlib.util.spec_from_file_location(
    "tencent_release", os.path.join(DEPLOY, "tencent-release.py"))
tr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tr)

_spec_lr = importlib.util.spec_from_file_location(
    "local_release", os.path.join(DEPLOY, "local-release.py"))
lr = importlib.util.module_from_spec(_spec_lr)
_spec_lr.loader.exec_module(lr)

SENTINEL_ENV = 'STORAGE_ENCRYPTION_KEY="SENTINEL-SECRET-1"\n'
MIGR_FILES = ["001_a.sql", "002_b.sql"]


def listing_sha(basenames):
    """Independent copy of the pack.py listing convention for assertions."""
    h = hashlib.sha256()
    for n in sorted(basenames):
        h.update(("src/lib/db/migrations/%s\n" % n).encode())
    return h.hexdigest()


def write_tarball(tgz, entries):
    with tarfile.open(tgz, "w:gz") as tf:
        for name, data in entries:
            raw = data.encode()
            ti = tarfile.TarInfo(name)
            ti.size = len(raw)
            tf.addfile(ti, io.BytesIO(raw))


def make_sqlite(path, build="b1", ledger="001"):
    c = sqlite3.connect(str(path))
    c.execute("CREATE TABLE t(x)")
    c.execute("CREATE TABLE key_value(namespace TEXT, key TEXT, value TEXT)")
    c.execute("INSERT INTO key_value VALUES('meta','build_id',?)", (build,))
    c.execute("CREATE TABLE _omniroute_migrations(version TEXT)")
    c.execute("INSERT INTO _omniroute_migrations VALUES(?)", (ledger,))
    for idx in ("idx_rcl_api_key_ts_cover", "idx_rcl_request_id",
                "idx_quota_recovery_due"):
        c.execute("CREATE INDEX %s ON t(x)" % idx)
    c.commit()
    c.close()


def fake_run_factory(tar_log):
    def fake_run(cmd, **kw):
        if cmd[0] == "tar":
            tar_log.append(list(cmd))
            subprocess.run(cmd, check=True, capture_output=True)
            return ""
        return ""

    return fake_run


def tencent_ctx(tmp, svc="omnisvc", beta_port=20129):
    os.makedirs(os.path.join(tmp, "releases"), exist_ok=True)
    data = os.path.join(tmp, "data")
    os.makedirs(data, exist_ok=True)
    os.makedirs(os.path.join(tmp, "work"), exist_ok=True)
    args = SimpleNamespace(
        work_dir=os.path.join(tmp, "work"), unit="u",
        current=os.path.join(tmp, "cur"),
        releases=os.path.join(tmp, "releases"), data=data,
        migr_sub="migrations", drop=os.path.join(tmp, "zz.conf"),
        node="node", new_tables="", heap_mb=64,
        min_free_gb=0, min_avail_mb=0, ledger_top="001",
        policy_format="c3854-v1", stable_port=20128, beta_port=beta_port,
        approval="parent-approved.json",
        clone_dir=os.path.join(tmp, "clone"), service_user=svc)
    return tr.Ctx(args)


def tencent_fixture(tmp, nested=False, migr_sha=None, dotenv=True):
    rel, build = "rel1-b1", "b1"
    ctx = tencent_ctx(tmp)
    data = str(ctx.data)
    make_sqlite(os.path.join(data, "storage.sqlite"))
    with open(os.path.join(data, "server.env"), "w") as f:
        f.write("A=1\n")
    if dotenv:
        with open(os.path.join(data, ".env"), "w") as f:
            f.write(SENTINEL_ENV)
    entries = []
    for f in ["dev/run-standalone.mjs", ".build/next/BUILD_ID",
              "server-ws.mjs", "migrations/001_a.sql",
              "migrations/002_b.sql"]:
        content = build if f.endswith("BUILD_ID") else "x:" + f
        entries.append(((rel + "/" + f) if nested else f, content))
    tgz = os.path.join(tmp, "a.tar.gz")
    write_tarball(tgz, entries)
    a = {"archive": tgz, "sha256": tr.sha(tgz), "release": rel,
         "build_id": build,
         "migrations": migr_sha if migr_sha is not None else listing_sha(MIGR_FILES),
         "sealed": True}
    return ctx, rel, build, a


def run_stage(ctx, build, a):
    tar_log = []
    buf = io.StringIO()
    with mock.patch.object(tr, "run", side_effect=fake_run_factory(tar_log)), \
            mock.patch.object(tr, "chown_tree") as m_chown, \
            redirect_stdout(buf):
        target, clone = tr.stage(ctx, "img", build, {}, a)
    return target, clone, tar_log, m_chown, buf.getvalue()


class CtxPolicyFormatTest(unittest.TestCase):
    """(1) tencent Ctx binds --policy-format like local Ctx."""

    def test_tencent_ctx_binds_policy_format(self):
        args = SimpleNamespace(
            work_dir="w", unit="u", current="c", releases="r", data="d",
            migr_sub="migrations", drop=None, node="n", new_tables="",
            heap_mb=64, min_free_gb=0, min_avail_mb=0, ledger_top="231",
            policy_format="c3854-v1", clone_dir="c", service_user="s")
        self.assertEqual(tr.Ctx(args).policy_format, "c3854-v1")

    def test_parser_default_matches_local(self):
        for mod in (tr, lr):
            args = mod.build_parser().parse_args(["beta"])
            self.assertEqual(args.policy_format, "c3854-v1")

    def test_ctxt_defaults_share_service_user_shape(self):
        args = tr.build_parser().parse_args(["beta"])
        self.assertTrue(hasattr(args, "service_user"))


class ChownTreeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clone = os.path.join(self.tmp.name, "omniroute-beta-test")
        os.mkdir(self.clone, 0o700)
        with open(os.path.join(self.clone, "server.env"), "w") as f:
            f.write("X=1\n")
        os.chmod(os.path.join(self.clone, "server.env"), 0o600)
        sub = os.path.join(self.clone, "sub")
        os.mkdir(sub)
        with open(os.path.join(sub, "storage.sqlite"), "w") as f:
            f.write("fake\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_chown_called_with_service_user_for_all_entries(self):
        import pwd
        import shutil as _shutil

        seen = []

        def fake_chown(path, user, group):
            seen.append((path, user, group))
            return None

        fake_pw = mock.Mock(pw_uid=os.getuid(), pw_gid=os.getgid())
        with mock.patch.object(_shutil, "chown", side_effect=fake_chown), \
                mock.patch.object(pwd, "getpwnam", return_value=fake_pw) as m_get:
            tr.chown_tree(self.clone, "omnisvc")
        m_get.assert_called_with("omnisvc")
        users = {u for _, u, g in seen}
        groups = {g for _, _, g in seen}
        self.assertEqual(users, {"omnisvc"})
        self.assertEqual(groups, {"omnisvc"})
        paths = {p for p, _, _ in seen}
        self.assertIn(self.clone, paths)
        self.assertIn(os.path.join(self.clone, "server.env"), paths)
        self.assertIn(os.path.join(self.clone, "sub", "storage.sqlite"), paths)

    def test_parser_defaults_service_user_omniroute(self):
        args = tr.build_parser().parse_args(["beta"])
        self.assertEqual(args.service_user, "omniroute")


class StageLayoutTest(unittest.TestCase):
    """(2) tencent stage(): flat fast path + nested strip + target chown."""

    def test_flat_pack_extracts_in_place(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, _rel, build, a = tencent_fixture(tmp)
            target, clone, tar_log, m_chown, _out = run_stage(ctx, build, a)
            self.assertEqual(len(tar_log), 1)
            self.assertEqual(tar_log[0][:2], ["tar", "-xzf"])
            self.assertEqual(tar_log[0][-2:], ["-C", str(target)])
            self.assertTrue((target / "dev/run-standalone.mjs").is_file())
            self.assertTrue((target / "server-ws.mjs").is_file())
            self.assertTrue((target / ctx.migr_sub / "001_a.sql").is_file())
            chowned = [str(c.args[0]) for c in m_chown.call_args_list]
            self.assertIn(str(target), chowned)
            self.assertTrue((clone / "server.env").is_file())

    def test_nested_release_prefix_is_stripped(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, rel, build, a = tencent_fixture(tmp, nested=True)
            target, _clone, _log, _chown, _out = run_stage(ctx, build, a)
            self.assertTrue((target / "server-ws.mjs").is_file())
            self.assertFalse((target / rel).exists())

    def test_nested_other_top_dir_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, rel, build, a = tencent_fixture(tmp, nested=True)
            wrong = os.path.join(tmp, "a.tar.gz")
            write_tarball(wrong, [("wrong-dir/server-ws.mjs", "x")])
            a = dict(a, archive=wrong, sha256=tr.sha(wrong))
            with self.assertRaises(AssertionError):
                run_stage(ctx, build, a)

    def test_clone_chown_runs_with_service_user(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, _rel, build, a = tencent_fixture(tmp)
            _t, _c, _log, _chown, _out = run_stage(ctx, build, a)
            self.assertEqual(
                [c.args[1] for c in _chown.call_args_list].count("omnisvc"), 2)


class MigrationsShaTest(unittest.TestCase):
    """(3) artifact `migrations` is a listing sha256 string."""

    def test_listing_sha_matches_pack_convention(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, _rel, build, a = tencent_fixture(tmp)
            target, _clone, _log, _chown, _out = run_stage(ctx, build, a)
            names = sorted(p.name for p in (target / "migrations").glob("*.sql"))
            self.assertEqual(names, MIGR_FILES)
            self.assertEqual(a["migrations"], listing_sha(names))

    def test_listing_drift_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, _rel, build, a = tencent_fixture(tmp, migr_sha="0" * 64)
            with self.assertRaises(AssertionError):
                run_stage(ctx, build, a)

    def test_missing_migrations_dir_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, rel, build, a = tencent_fixture(tmp)
            tgz = os.path.join(tmp, "b.tar.gz")
            write_tarball(tgz, [("server-ws.mjs", "x"),
                                ("dev/run-standalone.mjs", "x"),
                                (".build/next/BUILD_ID", build)])
            b = dict(a, archive=tgz, sha256=tr.sha(tgz))
            with self.assertRaises(AssertionError):
                run_stage(ctx, build, b)

    def test_local_install_rejects_listing_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            os.makedirs(out)
            rel, build = "rel9-b9", "b9"
            entries = [("server-ws.mjs", "x"),
                       ("dev/run-standalone.mjs", "x"),
                       (".build/next/BUILD_ID", build),
                       ("migrations/001_a.sql", "drifted")]
            tgz = os.path.join(tmp, "a.tar.gz")
            write_tarball(tgz, entries)
            art = {"archive": tgz, "sha256": "x" * 64, "size": 1,
                   "release": rel, "migrations": listing_sha(["001_a.sql"]),
                   "sealed": True}
            art_path = os.path.join(tmp, "artifact.json")
            with open(art_path, "w") as f:
                import json as _json
                _json.dump(art, f)
            with mock.patch.object(lr, "run", return_value=""):
                with self.assertRaises(AssertionError):
                    lr.install(types_ctx(tmp), art_path, rel, build)


class BetaEnvTest(unittest.TestCase):
    """(4) tencent-beta.env is plain KEY=value with the beta port."""

    def test_env_plain_and_carries_beta_port(self):
        import re

        with tempfile.TemporaryDirectory() as tmp:
            ctx, _rel, build, a = tencent_fixture(tmp)
            target, clone, _log, _chown, _out = run_stage(ctx, build, a)
            # boot_qualify needs the real fixture sqlite; only /proc RSS read is stubbed
            with mock.patch.object(tr, "health", return_value=True), \
                    mock.patch.object(tr, "require_health", return_value=None), \
                    mock.patch.object(tr, "show", return_value="pid"), \
                    mock.patch.object(tr, "policy", return_value={"policy_format": "c3854-v1"}), \
                    mock.patch.object(tr, "run") as m_run:
                import pathlib as _pl
                real_read = _pl.Path.read_text

                def fake_read(self, *a_, **k):
                    if str(self).startswith("/proc/"):
                        return "VmRSS:\t   1024 kB\n"
                    return real_read(self, *a_, **k)

                with mock.patch.object(_pl.Path, "read_text", fake_read):
                    seal = {"identity": {"main_pid": "pid"},
                            "policy": {"policy_format": "c3854-v1"},
                            "ledger": []}
                    tr.boot_qualify(ctx, target, clone, build, seal, a)
            self.assertTrue(m_run.call_count >= 3)
            ef = ctx.D / "tencent-beta.env"
            text = ef.read_text()
            self.assertNotIn("Environment=", text)
            for line in text.splitlines():
                self.assertRegex(line, r"^[A-Z_][A-Z0-9_]*=")
            ports = dict(re.findall(r'^(PORT|API_PORT)="(\d+)"$', text, re.M))
            self.assertEqual(ports.get("PORT"), "20129")

    def test_local_beta_env_already_plain(self):
        p = os.path.join(DEPLOY, "local-release.py")
        with open(p) as f:
            body = f.read()
        self.assertIn('k + "=" + esc(v)', body)
        self.assertNotIn('"Environment=" + ', body)


class DataEnvCloneTest(unittest.TestCase):
    """(5) clone gets DATA_DIR/.env 0600; never logged."""

    def test_dotenv_copied_0600(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, _rel, build, a = tencent_fixture(tmp)
            _t, clone, _log, _chown, _out = run_stage(ctx, build, a)
            dst = clone / ".env"
            self.assertTrue(dst.is_file())
            self.assertEqual(oct(os.stat(dst).st_mode & 0o777), "0o600")
            self.assertEqual(dst.read_text(), SENTINEL_ENV)

    def test_secret_never_logged(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, _rel, build, a = tencent_fixture(tmp)
            _t, _c, _log, _chown, out = run_stage(ctx, build, a)
            self.assertNotIn("SENTINEL", out)

    def test_missing_dotenv_skipped_not_fatal(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, _rel, build, a = tencent_fixture(tmp, dotenv=False)
            _t, clone, _log, _chown, _out = run_stage(ctx, build, a)
            self.assertFalse((clone / ".env").exists())


def types_ctx(tmp):
    args = SimpleNamespace(
        work_dir=os.path.join(tmp, "work"), unit="u",
        drop=os.path.join(tmp, "zz.conf"),
        beta_unit="b", releases_root=os.path.join(tmp, "releases"),
        node="node", new_tables="", heap_mb=64, stable_port=1, beta_port=2,
        approval="a", policy_format="c3854-v1", stream_timeout_ms="1")
    return lr.Ctx(args)


if __name__ == "__main__":
    unittest.main()
