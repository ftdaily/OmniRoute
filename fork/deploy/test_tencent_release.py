"""Tests for fork/deploy/tencent-release.py chown_tree (Tencent Beta clone ownership).

The beta unit runs as User=<service-user> (default omniroute) but stage()
creates the clone dir as root; without chown the node process gets EACCES
scandir on the clone DATA_DIR. chown_tree fixes ownership post-copy.
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

DEPLOY = os.path.dirname(os.path.abspath(__file__))

import importlib.util

_spec = importlib.util.spec_from_file_location(
    "tencent_release", os.path.join(DEPLOY, "tencent-release.py"))
tr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tr)


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


if __name__ == "__main__":
    unittest.main()
