"""Real file/lock receipt regressions; not real-VM cgroup evidence."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import contextlib
import io

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("trm06_validation", ROOT / "validation.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class ObserverReceipt(unittest.TestCase):
    def test_startup_refusal_fixtures_change_only_owned_cgroup_parent(self):
        for mode in ("cleanup-poison", "cgroup-writable", "cgroup-live-parent-writable"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                parent = Path(temporary) / "sessions"
                parent.mkdir(mode=0o755)
                original = os.open
                def own_open(path, flags, *args, **kwargs):
                    self.assertEqual(path, "/sys/fs/cgroup/smithers/sessions")
                    self.assertTrue(flags & os.O_NOFOLLOW)
                    return original(parent, flags, *args, **kwargs)
                with patch.object(fixture.sys, "argv", ["installed-fixture", mode]), patch.object(fixture.os, "getuid", return_value=0), patch.object(fixture.os, "geteuid", return_value=0), patch.object(fixture.os, "open", side_effect=own_open), patch.object(fixture, "fingerprint", return_value={"fixture": True}), contextlib.redirect_stdout(io.StringIO()) as output:
                    fixture.main()
                result = json.loads(output.getvalue())
                self.assertEqual(result["outside"], {"fixture": True})
                if mode == "cleanup-poison":
                    self.assertEqual([p.name for p in parent.iterdir()], ["TRM06-invalid-child"])
                    self.assertEqual(parent.stat().st_mode & 0o777, 0o755)
                else:
                    self.assertEqual(list(parent.iterdir()), [])
                    self.assertEqual(parent.stat().st_mode & 0o777, 0o777)

    def test_replacement_controls_preserve_original_inode_and_outside(self):
        for mode in ("cgroup-parent-replaced", "cgroup-child-writable", "cgroup-live-parent-replaced"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                sessions = base / "sessions"
                sessions.mkdir(mode=0o755)
                inode = sessions.stat().st_ino
                outside = base / "outside"
                outside.write_bytes(b"outside-fixture\0")
                before = outside.stat()
                original = os.open
                def own_open(path, flags, *args, **kwargs):
                    self.assertTrue(flags & os.O_NOFOLLOW)
                    if path == "/sys/fs/cgroup/smithers":
                        path = base
                    elif path == "/sys/fs/cgroup/smithers/sessions":
                        path = sessions
                    else:
                        self.assertIn(path, ("sessions", "s-0000000000000001"))
                        self.assertIn("dir_fd", kwargs)
                    return original(path, flags, *args, **kwargs)
                with patch.object(fixture.sys, "argv", ["installed-fixture", mode]), patch.object(fixture.os, "getuid", return_value=0), patch.object(fixture.os, "geteuid", return_value=0), patch.object(fixture.os, "open", side_effect=own_open), patch.object(fixture, "fingerprint", return_value={"fixture": True}), contextlib.redirect_stdout(io.StringIO()) as output:
                    fixture.main()
                self.assertEqual(json.loads(output.getvalue())["cgroup_replaced"], mode)
                if mode in ("cgroup-parent-replaced", "cgroup-live-parent-replaced"):
                    self.assertEqual((base / "trm06-sessions-original").stat().st_ino, inode)
                    self.assertNotEqual(sessions.stat().st_ino, inode)
                    self.assertEqual(sessions.stat().st_mode & 0o777, 0o755)
                else:
                    self.assertEqual(sessions.stat().st_ino, inode)
                    self.assertEqual((sessions / "s-0000000000000001").stat().st_mode & 0o777, 0o777)
                self.assertEqual(outside.read_bytes(), b"outside-fixture\0")
                self.assertEqual((outside.stat().st_ino, outside.stat().st_uid, outside.stat().st_mode), (before.st_ino, before.st_uid, before.st_mode))

    def test_live_child_mutations_hold_original_groups_and_refuse_foreign_names(self):
        for mode in ("cgroup-live-child-replaced", "cgroup-live-child-writable"):
            for invalid in (False, "foreign", "symlink"):
                with self.subTest(mode=mode, invalid=invalid), tempfile.TemporaryDirectory() as temporary:
                    parent = Path(temporary)
                    names = ["s-0000000000000001", "s-0000000000000002"]
                    for name in names:
                        (parent / name).mkdir(mode=0o755)
                    originals = {name: (parent / name).stat().st_ino for name in names}
                    controls = {name: b"kernel-control-fixture\n" for name in
                                ("cgroup.events", "cgroup.procs", "cgroup.kill", "cgroup.controllers")}
                    for name, contents in controls.items():
                        (parent / name).write_bytes(contents)
                    if invalid == "foreign":
                        (parent / "foreign").mkdir()
                    elif invalid == "symlink":
                        (parent / "s-0000000000000003").symlink_to(parent / names[0])
                    original_open, original_stat = os.open, os.fstat
                    def own_open(path, flags, *args, **kwargs):
                        self.assertTrue(flags & os.O_NOFOLLOW)
                        if path == "/sys/fs/cgroup/smithers/sessions":
                            path = parent
                        else:
                            self.assertIn(path, names)
                            self.assertIn("dir_fd", kwargs)
                        return original_open(path, flags, *args, **kwargs)
                    def own_stat(fd):
                        values = list(original_stat(fd))
                        values[4] = 0
                        return os.stat_result(values)
                    with patch.object(fixture.sys, "argv", ["installed-fixture", mode]), patch.object(fixture.os, "getuid", return_value=0), patch.object(fixture.os, "geteuid", return_value=0), patch.object(fixture.os, "open", side_effect=own_open), patch.object(fixture.os, "fstat", side_effect=own_stat), patch.object(fixture, "fingerprint", return_value={"fixture": True}), contextlib.redirect_stdout(io.StringIO()) as output:
                        if invalid:
                            with self.assertRaises(ValueError):
                                fixture.main()
                        else:
                            fixture.main()
                            self.assertEqual(json.loads(output.getvalue())["cgroup_replaced"], mode)
                    for name in names:
                        child = parent / name
                        if not invalid and mode == "cgroup-live-child-replaced":
                            self.assertEqual((parent / ("trm06-original-" + name)).stat().st_ino, originals[name])
                            self.assertNotEqual(child.stat().st_ino, originals[name])
                            self.assertEqual(child.stat().st_mode & 0o777, 0o755)
                        else:
                            self.assertEqual(child.stat().st_ino, originals[name])
                            self.assertEqual(child.stat().st_mode & 0o777, 0o777 if not invalid else 0o755)
                    for name, contents in controls.items():
                        self.assertEqual((parent / name).read_bytes(), contents)

    def test_live_cgroup_ancestor_preserves_original_session_inode(self):
        for mode in ("cgroup-live-ancestor-replaced", "cgroup-live-ancestor-writable"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                ancestor = root / "smithers"
                sessions = ancestor / "sessions"
                sessions.mkdir(parents=True)
                ancestor.chmod(0o755)
                (sessions / "s-0000000000000001").mkdir()
                original_ancestor, original_sessions = ancestor.stat().st_ino, sessions.stat().st_ino
                original_open, original_stat = os.open, os.fstat
                def rooted_open(path, flags, *args, **kwargs):
                    return original_open(root if path == "/sys/fs/cgroup" else path, flags, *args, **kwargs)
                def owned(fd):
                    values = list(original_stat(fd)); values[4] = 0
                    return os.stat_result(values)
                with patch.object(fixture.sys, "argv", ["installed-fixture", mode]), patch.object(fixture.os, "getuid", return_value=0), patch.object(fixture.os, "geteuid", return_value=0), patch.object(fixture.os, "open", side_effect=rooted_open), patch.object(fixture.os, "fstat", side_effect=owned), patch.object(fixture, "fingerprint", return_value={"fixture": True}), contextlib.redirect_stdout(io.StringIO()) as output:
                    fixture.main()
                    self.assertEqual(json.loads(output.getvalue())["cgroup_replaced"], mode)
                self.assertEqual(sessions.stat().st_ino, original_sessions)
                self.assertTrue((sessions / "s-0000000000000001").is_dir())
                if mode.endswith("replaced"):
                    self.assertNotEqual(ancestor.stat().st_ino, original_ancestor)
                    self.assertEqual((root / "trm06-smithers-original").stat().st_ino, original_ancestor)
                else:
                    self.assertEqual(ancestor.stat().st_mode & 0o777, 0o777)

    def test_live_owner_mutations_select_only_held_original_directories(self):
        # No root execution: observe the exact descriptor/identity syscall at
        # the installed fixture boundary, retaining real no-follow path opens.
        for component in ("parent", "child", "ancestor"):
            with self.subTest(component=component), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                ancestor = root / "smithers"
                sessions = ancestor / "sessions"
                sessions.mkdir(parents=True)
                ancestor.chmod(0o755)
                sessions.chmod(0o755)
                child = sessions / "s-0000000000000001"
                child.mkdir(mode=0o755)
                for name in ("cgroup.events", "cgroup.procs", "cgroup.kill"):
                    (sessions / name).write_bytes(b"kernel-control-fixture\n")
                sentinel = root / "outside"
                sentinel.write_bytes(b"outside-fixture\0")
                before = sentinel.stat()
                target = {"ancestor": ancestor, "parent": sessions, "child": child}[component]
                expected_inode = target.stat().st_ino
                real_open, real_stat = os.open, os.fstat
                def rooted_open(path, flags, *args, **kwargs):
                    self.assertTrue(flags & os.O_NOFOLLOW)
                    path = {"/sys/fs/cgroup": root, "/sys/fs/cgroup/smithers/sessions": sessions}.get(path, path)
                    return real_open(path, flags, *args, **kwargs)
                def owned(fd):
                    values = list(real_stat(fd)); values[4] = 0
                    return os.stat_result(values)
                calls = []
                def change_owner(fd, uid, gid):
                    calls.append((real_stat(fd).st_ino, uid, gid))
                with patch.object(fixture.sys, "argv", ["installed-fixture", "cgroup-live-" + component + "-owner"]), patch.object(fixture.os, "getuid", return_value=0), patch.object(fixture.os, "geteuid", return_value=0), patch.object(fixture.os, "open", side_effect=rooted_open), patch.object(fixture.os, "fstat", side_effect=owned), patch.object(fixture.os, "fchown", side_effect=change_owner), patch.object(fixture, "fingerprint", return_value={"fixture": True}), contextlib.redirect_stdout(io.StringIO()):
                    fixture.main()
                self.assertEqual(calls, [(expected_inode, 20001, 20001)])
                self.assertEqual(target.stat().st_ino, expected_inode)
                self.assertEqual(target.stat().st_mode & 0o777, 0o755)
                self.assertEqual(sentinel.read_bytes(), b"outside-fixture\0")
                self.assertEqual((sentinel.stat().st_ino, sentinel.stat().st_uid, sentinel.stat().st_mode), (before.st_ino, before.st_uid, before.st_mode))

    def test_reader_waits_for_complete_locked_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "observer.json"
            fixture.OBSERVER = path
            # A separate writer exposes invalid partial JSON while holding the
            # same lock the real detached observer inherits from its parent.
            writer = subprocess.Popen([sys.executable, "-I", "-S", "-c", """
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
os.write(fd, b'{"groups":')
print('ready', flush=True)
time.sleep(.1)
os.write(fd, b'["s-0000000000000001"],"zero":{},"samples":[]}')
os.fsync(fd)
os.close(fd)
""", str(path)], stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(writer.stdout.readline(), "ready\n")
                # Production requires a root-owned observation. This test uses
                # its actual unprivileged UID without bypassing locking or I/O.
                original = fixture.os.fstat
                def own_stat(fd):
                    info = original(fd)
                    values = list(info)
                    values[4] = 0
                    return os.stat_result(values)
                fixture.os.fstat = own_stat
                try:
                    result = fixture.observed_drain()
                finally:
                    fixture.os.fstat = original
                self.assertEqual(result, {"groups": ["s-0000000000000001"], "zero": {}, "samples": []})
                self.assertFalse(path.exists())
                self.assertEqual(writer.wait(timeout=2), 0)
            finally:
                if writer.poll() is None:
                    writer.kill()
                    writer.wait()
                writer.stdout.close()

    def test_unlocked_truncated_receipt_is_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "observer.json"
            fixture.OBSERVER = path
            path.write_bytes(b'{"groups":')
            path.chmod(0o600)
            original = fixture.os.fstat
            def own_stat(fd):
                values = list(original(fd))
                values[4] = 0
                return os.stat_result(values)
            fixture.os.fstat = own_stat
            try:
                with self.assertRaises(json.JSONDecodeError):
                    fixture.observed_drain()
            finally:
                fixture.os.fstat = original
            self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
