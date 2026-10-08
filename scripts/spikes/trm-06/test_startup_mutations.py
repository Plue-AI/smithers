"""Real mutation syscalls; supplemental, not installed init or root receipts."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("observer", Path(__file__).with_name("validation.py"))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class StartupMutations(unittest.TestCase):
    def test_every_installed_selector_changes_the_intended_object(self):
        self.assertEqual(len(observer.STARTUP_MUTATIONS), 22)
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
                    path.write_text(json.dumps({"boot": [1] * 16, "secret": [2] * 32}))
                    path.chmod(0o400)
                else:
                    path.write_bytes(b"main-pinned")
                    path.chmod(0o755)
                original = path.stat()
                contents = None if directory else path.read_bytes()
                # Root can update the installed 0400 boot leaf. This ordinary
                # filesystem test grants its owner write for the syscall only;
                # it is explicitly not root-boundary evidence.
                if mutation == "identity":
                    path.chmod(0o600)
                observer.mutate_startup(str(path), mutation)
                if mutation == "identity":
                    path.chmod(original.st_mode & 0o777)
                if mutation == "clone":
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
                elif mutation == "canary":
                    self.assertNotEqual(path.stat().st_ino, original.st_ino)
                    self.assertIn(b"printf canary", path.read_bytes())
                elif mutation == "writable":
                    self.assertEqual(path.stat().st_mode & 0o777, 0o777 if directory else 0o666)
                self.assertEqual((sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode), before)


if __name__ == "__main__":
    unittest.main()
