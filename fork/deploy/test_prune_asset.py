"""Tests for fork/deploy/prune.py (Phase 1.3) and release-asset.sh (1.4).

Temp releases root + fake symlink/drop-ins. Live and foreign dirs are
never selected for deletion. release-asset.sh is exercised with a stubbed
gh on PATH (dry-run mode).
"""
import os
import subprocess
import sys
import tempfile
import unittest

DEPLOY = os.path.dirname(os.path.abspath(__file__))
PRUNE = os.path.join(DEPLOY, "prune.py")
ASSET = os.path.join(DEPLOY, "release-asset.sh")


def run_prune(root, link, dropin, *extra):
    return subprocess.run(
        [sys.executable, PRUNE, "--releases-root", root, "--current-symlink", link,
         "--dropin-dir", dropin, "--soak-hours", "48", *extra],
        capture_output=True, text=True, check=False,
    )


class PruneSelectTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "releases")
        self.dropin = os.path.join(self.tmp.name, "dropins")
        os.makedirs(self.root)
        os.makedirs(self.dropin)
        # ours: live, post-soak previous, fresh (in soak), drop-in referenced
        self.live = "cf4344a-CJvDF3DomnMxXLvOowleM-3854"
        self.prev = "5da1ffeb5b-M1P6npJA_9RWc5NHM1Gsw-nov5"
        self.fresh = "927a85a5d3-t325NJR58M-GvHF9W9GvL-pkg2"
        self.pinned = "37bdeb05bb-H73VuoLvw7VMU_x2SOOop"
        for d in (self.live, self.prev, self.fresh, self.pinned,
                  "beta-user-portal-x", "no-user-panel-y"):
            os.makedirs(os.path.join(self.root, d))
        old = 49 * 3600
        for d in (self.live, self.prev, self.pinned):
            p = os.path.join(self.root, d)
            os.utime(p, (old, old))
        self.link = os.path.join(self.tmp.name, "current")
        os.symlink(os.path.join(self.root, self.live), self.link)
        with open(os.path.join(self.dropin, "zz.conf"), "w") as f:
            f.write(f"WorkingDirectory={self.root}/{self.pinned}\n")

    def tearDown(self):
        self.tmp.cleanup()

    def body(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout

    def test_live_pinned_fresh_kept_prev_deleted(self):
        out = self.body(run_prune(self.root, self.link, self.dropin))
        self.assertIn(f"KEEP {self.live} (live", out)
        self.assertIn(f"KEEP {self.pinned} (referenced by a drop-in)", out)
        self.assertIn(f"KEEP {self.fresh} (within soak window", out)
        self.assertIn(f"DELETE {self.prev} (post-soak previous", out)

    def test_foreign_never_selected(self):
        out = self.body(run_prune(self.root, self.link, self.dropin))
        self.assertIn("FOREIGN beta-user-portal-x (name not ours; never touched)", out)
        self.assertIn("FOREIGN no-user-panel-y (name not ours; never touched)", out)
        self.assertNotIn("DELETE beta-user-portal-x", out)
        self.assertNotIn("DELETE no-user-panel-y", out)

    def test_broken_symlink_treated_as_no_live(self):
        os.remove(self.link)
        os.symlink(os.path.join(self.root, "nonexistent"), self.link)
        proc = subprocess.run(
            [sys.executable, PRUNE, "--releases-root", self.root,
             "--current-symlink", self.link, "--dropin-dir", self.dropin,
             "--soak-hours", "100000"],
            capture_output=True, text=True, check=False,
        )
        out = self.body(proc)
        # no crash; with no live target the old live dir is judged by age
        # rules only (drop-in pins still hold)
        self.assertIn(f"KEEP {self.pinned} (referenced by a drop-in)", out)

    def test_apply_needs_confirm_list(self):
        proc = run_prune(self.root, self.link, self.dropin, "--apply")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("--confirm-list", proc.stderr)

    def test_apply_deletes_only_confirmed(self):
        confirm = os.path.join(self.tmp.name, "confirm.txt")
        with open(confirm, "w") as f:
            f.write(f"DELETE {self.prev} (post-soak previous)\n")
        proc = run_prune(self.root, self.link, self.dropin, "--apply",
                         "--confirm-list", confirm)
        out = self.body(proc)
        self.assertIn(f"deleted {self.prev}", out)
        self.assertFalse(os.path.exists(os.path.join(self.root, self.prev)))
        self.assertTrue(os.path.exists(os.path.join(self.root, self.live)))
        self.assertTrue(os.path.exists(os.path.join(self.root, self.pinned)))

    def test_apply_refuses_unconfirmed(self):
        confirm = os.path.join(self.tmp.name, "confirm.txt")
        with open(confirm, "w") as f:
            f.write("DELETE something-else\n")
        proc = run_prune(self.root, self.link, self.dropin, "--apply",
                         "--confirm-list", confirm)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("not confirmed", proc.stderr)
        self.assertTrue(os.path.exists(os.path.join(self.root, self.prev)))


class ReleaseAssetTest(unittest.TestCase):
    def test_dry_run_upload_download(self):
        bindir = tempfile.mkdtemp()
        gh = os.path.join(bindir, "gh")
        with open(gh, "w") as f:
            f.write("#!/bin/sh\necho \"stub-gh $@\"\n")
        os.chmod(gh, 0o755)
        env = dict(os.environ, PATH=bindir + ":" + os.environ.get("PATH", ""),
                   DRY_RUN="1")
        tarball = os.path.join(bindir, "rel.tgz")
        with open(tarball, "wb") as f:
            f.write(b"x" * 64)
        up = subprocess.run(["bash", ASSET, "upload", "release-test", tarball],
                            capture_output=True, text=True, env=env, check=False)
        self.assertEqual(up.returncode, 0, up.stderr)
        self.assertIn("gh release create release-test", up.stdout)
        down = subprocess.run(["bash", ASSET, "download", "release-test", bindir],
                              capture_output=True, text=True, env=env, check=False)
        self.assertEqual(down.returncode, 0, down.stderr)
        self.assertIn("gh release download release-test", down.stdout)


if __name__ == "__main__":
    unittest.main()
