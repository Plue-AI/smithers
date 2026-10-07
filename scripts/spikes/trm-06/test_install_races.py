"""Deterministic installer schedules; supplemental, never a root receipt.

Only UID observations and the final process launch are substituted. Directory
replacement, no-follow opens, contents and inode comparisons use real files.
"""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("trm06_install", Path(__file__).with_name("install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerReplacement(unittest.TestCase):
    def test_install_boundary_replacement_matrix(self):
        for target in (None, "opt", "opt/smithers", "run", "run/smithers",
                       "opt/smithers/prototype", "run/smithers/trm06",
                       "opt/smithers/prototype/supervisor"):
            for replacement in (("directory",) if target is None else ("symlink", "inode")):
                with self.subTest(target=target, replacement=replacement), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    (root / "opt").mkdir()
                    (root / "run").mkdir()
                    (root / "opt").chmod(0o755)
                    (root / "run").chmod(0o755)
                    sentinel = root / "outside"
                    sentinel.write_bytes(b"outside-fixture\0")
                    before = (sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode)
                    binary = b"literal-supervisor-fixture"
                    sha = hashlib.sha256(binary).hexdigest()
                    payload = {"supervisor": base64.b64encode(binary).decode(), "sha256": sha,
                               "boot": {"revision": "a" * 40, "supervisor_sha256": sha,
                                        "boot": [1] * 16, "secret": [2] * 32}}
                    real_open, real_stat = os.open, os.fstat
                    real_linked = installer.linked
                    replaced = False

                    def rooted_open(path, flags, mode=0o777, *, dir_fd=None):
                        if path == "/" and dir_fd is None:
                            path = str(root)
                        return real_open(path, flags, mode, dir_fd=dir_fd)

                    def root_owned(fd):
                        values = list(real_stat(fd))
                        values[4] = 0
                        return os.stat_result(values)

                    def scheduled_link(parent, name, held):
                        nonlocal replaced
                        if target and not replaced:
                            path = root / target
                            path.rename(path.with_name(path.name + "-original"))
                            if replacement == "symlink":
                                path.symlink_to(sentinel)
                            elif target.endswith("supervisor"):
                                path.write_bytes(b"canary")
                                path.chmod(0o755)
                            else:
                                path.mkdir(mode=0o755)
                            replaced = True
                        real_linked(parent, name, held)

                    with patch.object(installer.os, "getuid", return_value=0), patch.object(installer.os, "geteuid", return_value=0), \
                         patch.object(installer.os, "open", side_effect=rooted_open), patch.object(installer.os, "fstat", side_effect=root_owned), \
                         patch.object(installer, "linked", side_effect=scheduled_link), \
                         patch.object(installer.sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(json.dumps(payload).encode()))), \
                         patch.object(installer.subprocess, "Popen", return_value=types.SimpleNamespace(pid=123)) as launch, \
                         patch("sys.stdout", new_callable=io.StringIO):
                        if target:
                            with self.assertRaises((ValueError, OSError)):
                                installer.install()
                            launch.assert_not_called()
                        else:
                            installer.install()
                            launch.assert_called_once()
                            self.assertEqual(launch.call_args.kwargs["env"], {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})
                            self.assertTrue(launch.call_args.kwargs["executable"].startswith("/proc/self/fd/"))
                    self.assertEqual((sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode), before)


if __name__ == "__main__":
    unittest.main()
