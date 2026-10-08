"""Independent observer no-follow controls, not real cgroup evidence."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("trm06_observer_paths", Path(__file__).with_name("validation.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class ObserverPaths(unittest.TestCase):
    def test_sentinel_fingerprint_requires_one_unchanged_regular_inode(self):
        for mode in ("positive", "symlink", "hardlink", "fifo", "directory", "replace", "rewrite", "chmod", "oversized"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                sentinel = root / "sentinel"
                outside = root / "outside"
                outside.write_bytes(b"outside-fixture\0")
                outside.chmod(0o640)
                before = outside.stat()
                if mode == "symlink": sentinel.symlink_to(outside)
                elif mode == "hardlink": os.link(outside, sentinel)
                elif mode == "fifo": os.mkfifo(sentinel)
                elif mode == "directory": sentinel.mkdir()
                else:
                    sentinel.write_bytes(b"sentinel-fixture\0")
                    sentinel.chmod(0o640)
                if mode == "oversized": sentinel.write_bytes(bytes(65537))
                digest = hashlib.sha256
                def race(data):
                    result = digest(data)
                    if mode == "replace":
                        sentinel.rename(root / "original")
                        sentinel.write_bytes(b"replacement")
                    elif mode == "rewrite": sentinel.write_bytes(b"replacement")
                    elif mode == "chmod": sentinel.chmod(0o666)
                    return result
                with patch.object(fixture, "OUTSIDE", sentinel), patch.object(fixture.hashlib, "sha256", side_effect=race):
                    if mode == "positive":
                        observed = fixture.fingerprint()
                        self.assertEqual(observed, {"sha256": hashlib.sha256(b"sentinel-fixture\0").hexdigest(), "uid": os.getuid(), "mode": 0o640})
                    else:
                        with self.assertRaises((ValueError, OSError)):
                            fixture.fingerprint()
                self.assertEqual(outside.read_bytes(), b"outside-fixture\0")
                self.assertEqual((outside.stat().st_ino, outside.stat().st_uid, outside.stat().st_mode), (before.st_ino, before.st_uid, before.st_mode))

    def test_sample_refuses_every_symlinked_cgroup_ancestor(self):
        for component in (None, "sys", "sys/fs", "sys/fs/cgroup", "sys/fs/cgroup/smithers", "sys/fs/cgroup/smithers/sessions"):
            with self.subTest(component=component), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                sessions = root / "sys/fs/cgroup/smithers/sessions"
                sessions.mkdir(parents=True)
                outside = root / "outside"
                outside.mkdir()
                sentinel = outside / "sentinel"
                sentinel.write_bytes(b"outside-fixture\0")
                before = (sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode)
                if component:
                    path = root / component
                    path.rename(path.with_name(path.name + "-original"))
                    path.symlink_to(outside, target_is_directory=True)
                real_open, real_listdir = os.open, os.listdir

                def rooted_open(path, flags, mode=0o777, *, dir_fd=None):
                    return real_open(str(root) if path == "/" and dir_fd is None else path, flags, mode, dir_fd=dir_fd)

                def no_processes(path):
                    return [] if path == "/proc" else real_listdir(path)

                with patch.object(fixture.os, "open", side_effect=rooted_open), patch.object(fixture.os, "listdir", side_effect=no_processes):
                    if component:
                        with self.assertRaises(OSError):
                            fixture.sample()
                    else:
                        self.assertEqual(fixture.sample()["cgroups"], {})
                self.assertEqual((sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode), before)


if __name__ == "__main__":
    unittest.main()
