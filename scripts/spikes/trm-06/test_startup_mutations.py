"""Real mutation syscalls; supplemental, not installed init or root receipts."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("observer", Path(__file__).with_name("validation.py"))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class StartupMutations(unittest.TestCase):
    def test_every_installed_selector_changes_the_intended_object(self):
        self.assertEqual(len(observer.STARTUP_MUTATIONS), 48)
        for name, (target, mutation) in observer.STARTUP_MUTATIONS.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / Path(target).name
                sentinel = root / "outside"
                sentinel.write_bytes(b"outside-fixture\0")
                before = (sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode)
                directory = name.startswith("startup-") and ("parent" in name or "ancestor" in name)
                if directory:
                    path.mkdir(mode=0o700)
                    (path / "boot.json").write_bytes(b"main-pinned")
                elif path.name == "boot.json":
                    path.write_text(json.dumps({"revision": "a" * 40, "supervisor_sha256": "a" * 64, "boot": [1] * 16, "secret": [2] * 32}))
                    path.chmod(0o400)
                else:
                    path.write_bytes(b"main-pinned")
                    path.chmod(0o755)
                child_inode = (path / "boot.json").stat().st_ino if directory else None
                original = path.stat()
                contents = None if directory else path.read_bytes()
                # Root can update the installed 0400 boot leaf. This ordinary
                # filesystem test grants its owner write for the syscall only;
                # it is explicitly not root-boundary evidence.
                if mutation in ("identity", "empty", "oversized", "same-size", "duplicate", "secret", "revision", "digest", "unknown", "null", "zero-boot", "zero-secret", "wrong-type", "trailing"):
                    path.chmod(0o600)
                if mutation == "owner":
                    # Ownership changes need root on the installed guest. Observe
                    # the exact descriptor and fixed IDs without elevating here.
                    def owner(fd, uid, gid):
                        self.assertEqual((uid, gid), (20001, 20001))
                        self.assertEqual(os.fstat(fd).st_ino, original.st_ino)
                    with patch.object(observer.os, "fchown", side_effect=owner) as changed:
                        observer.mutate_startup(str(path), mutation)
                        changed.assert_called_once()
                    self.assertEqual(path.stat().st_mode, original.st_mode)
                else:
                    observer.mutate_startup(str(path), mutation)
                if mutation in ("identity", "empty", "oversized", "same-size", "duplicate", "secret", "revision", "digest", "unknown", "null", "zero-boot", "zero-secret", "wrong-type", "trailing"):
                    path.chmod(original.st_mode & 0o777)
                if mutation == "held-leaves":
                    self.assertEqual((path / "boot.json").stat().st_ino, child_inode)
                    self.assertNotEqual(path.stat().st_ino, original.st_ino)
                    self.assertEqual((path / "boot.json").read_bytes(), b"main-pinned")
                elif mutation == "clone":
                    self.assertNotEqual(path.stat().st_ino, original.st_ino)
                    self.assertEqual((path / "boot.json").read_bytes(), b"main-pinned")
                elif mutation == "symlink":
                    self.assertTrue(path.is_symlink())
                elif mutation == "hardlink":
                    self.assertEqual(path.stat().st_nlink, 2)
                    self.assertEqual(path.read_bytes(), contents)
                elif mutation == "fifo":
                    import stat
                    self.assertTrue(stat.S_ISFIFO(path.stat().st_mode))
                elif mutation == "directory":
                    self.assertTrue(path.is_dir())
                elif mutation == "identity":
                    self.assertEqual(path.stat().st_ino, original.st_ino)
                    self.assertEqual(json.loads(path.read_bytes())["boot"], [0] + [1] * 15)
                    self.assertEqual(path.stat().st_mode, original.st_mode)
                elif mutation in ("empty", "oversized", "same-size", "duplicate", "secret", "revision", "digest", "unknown", "null", "zero-boot", "zero-secret", "wrong-type", "trailing"):
                    self.assertEqual(path.stat().st_ino, original.st_ino)
                    self.assertEqual(path.stat().st_mode, original.st_mode)
                    data = path.read_bytes()
                    if mutation == "empty": self.assertEqual(data, b"")
                    elif mutation == "oversized": self.assertEqual(len(data), 4097)
                    elif mutation == "same-size":
                        self.assertEqual(len(data), len(contents))
                        self.assertNotEqual(data, contents)
                    elif mutation == "duplicate": self.assertEqual(data.count(b'"boot"'), 2)
                    elif mutation == "secret": self.assertEqual(json.loads(data)["secret"], [3] + [2] * 31)
                    elif mutation == "revision": self.assertEqual(json.loads(data)["revision"], "b" * 40)
                    elif mutation == "digest": self.assertEqual(json.loads(data)["supervisor_sha256"], "b" * 64)
                    elif mutation == "unknown": self.assertEqual(json.loads(data)["uid"], 0)
                    elif mutation == "null": self.assertIsNone(json.loads(data)["boot"])
                    elif mutation == "zero-boot": self.assertEqual(json.loads(data)["boot"], [0] * 16)
                    elif mutation == "zero-secret": self.assertEqual(json.loads(data)["secret"], [0] * 32)
                    elif mutation == "wrong-type": self.assertEqual(json.loads(data)["secret"], "member")
                    elif mutation == "trailing":
                        with self.assertRaises(json.JSONDecodeError): json.loads(data)
                elif mutation == "canary":
                    self.assertNotEqual(path.stat().st_ino, original.st_ino)
                    self.assertIn(b"printf canary", path.read_bytes())
                elif mutation == "writable":
                    self.assertEqual(path.stat().st_mode & 0o777, 0o777 if directory else 0o666)
                self.assertEqual((sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode), before)


if __name__ == "__main__":
    unittest.main()
