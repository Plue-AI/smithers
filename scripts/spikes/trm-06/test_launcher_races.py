"""Unprivileged launcher entry schedules; not installed root/Mac receipts."""
import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from race_schedule import RaceSchedule

spec = importlib.util.spec_from_file_location("launcher", Path(__file__).with_name("launcher.py"))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherRaces(unittest.TestCase):
    def fixture(self, root):
        files = []
        for name in ("share/trm06/launcher.py", "share/trm06/run.sh", "share/trm06/revoke.sh", "share/trm06/flow.sh", "bin/trm06-gateway"):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"main-fixture:" + name.encode())
            path.chmod(0o755 if name.startswith("bin/") else 0o644)
            files.append({"path": name, "mode": path.stat().st_mode & 0o777, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        (root / "manifest.json").write_text(json.dumps({"version": 1, "platform": "darwin-arm64", "revision": "a" * 40, "files": files}))

    def test_gateway_replacement_after_validation_never_selects_new_bytes(self):
        for replacement in ("file", "symlink", "parent"):
            with self.subTest(replacement=replacement), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.fixture(root)
                expected = (root / "bin/trm06-gateway").read_bytes()
                outside = root / "outside"
                outside.write_bytes(b"canary")
                def execute(fd, argv):
                    gateway = root / "bin/trm06-gateway"
                    if replacement == "parent":
                        gateway.parent.rename(root / "old-bin")
                        (root / "bin").mkdir()
                        gateway.write_bytes(b"canary")
                    else:
                        gateway.unlink()
                        if replacement == "file": gateway.write_bytes(b"canary")
                        else: gateway.symlink_to(outside)
                    self.assertEqual(launcher.read_held(fd, 65536), expected)
                    self.assertEqual(argv[1], "check-install")
                    self.assertEqual(outside.read_bytes(), b"canary")
                with patch.object(launcher, "ROOT", root), patch.object(launcher, "__file__", str(root / "share/trm06/launcher.py")), patch.object(launcher, "protected", side_effect=lambda p, *args: Path(p)), patch.object(launcher, "trusted"), patch.object(launcher.os, "chdir"), patch.object(launcher.sys, "argv", ["launcher", "check-install"]), patch.object(launcher, "execute_held", side_effect=execute) as executed:
                    launcher.main()
                    executed.assert_called_once()

    def test_replacement_visible_before_exec_refuses_every_artifact(self):
        for target in ("manifest.json", "share/trm06/launcher.py", "share/trm06/run.sh", "share/trm06/revoke.sh", "share/trm06/flow.sh", "bin/trm06-gateway"):
            for replacement in ("file", "symlink", "parent"):
                with self.subTest(target=target, replacement=replacement), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    self.fixture(root)
                    original = launcher.read_held
                    mutated = False
                    def mutate():
                        nonlocal mutated
                        if not mutated:
                            mutated = True
                            path = root / target
                            if replacement == "parent":
                                path.parent.rename(root / "held-parent")
                                path.parent.mkdir()
                                path.write_bytes(b"branch")
                            else:
                                path.rename(path.with_name(path.name + "-held"))
                                if replacement == "file": path.write_bytes(b"branch")
                                else: path.symlink_to(path.with_name(path.name + "-held"))
                    def read(fd, limit):
                        data = original(fd, limit)
                        if data.startswith(b"main-fixture:bin/") and not mutated:
                            schedule.replace()
                        return data
                    # The manifest's parent is the fixture root; avoid renaming
                    # TemporaryDirectory itself and leaving an external fixture.
                    if target == "manifest.json" and replacement == "parent":
                        continue
                    with RaceSchedule(mutate) as schedule, patch.object(launcher, "ROOT", root), patch.object(launcher, "__file__", str(root / "share/trm06/launcher.py")), patch.object(launcher, "protected", side_effect=lambda p, *args: Path(p)), patch.object(launcher, "trusted"), patch.object(launcher, "read_held", side_effect=read), patch.object(launcher.sys, "argv", ["launcher", "run"]), patch.object(launcher, "execute_held") as execute:
                        with self.assertRaises((ValueError, OSError)): launcher.main()
                        execute.assert_not_called()

    def test_symlink_ancestors_and_artifacts_refuse(self):
        for target in ("share", "share/trm06", "share/trm06/launcher.py", "bin", "bin/trm06-gateway", "manifest.json"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.fixture(root)
                path = root / target
                old = root / "outside"
                path.rename(old)
                path.symlink_to(old, target_is_directory=old.is_dir())
                with patch.object(launcher, "trusted"):
                    with self.assertRaises(OSError): launcher.open_protected(path)

    def test_digest_reads_held_inode_after_path_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "artifact"
            path.write_bytes(b"main")
            with patch.object(launcher, "trusted"):
                fd = launcher.open_protected(path)
            try:
                path.unlink()
                path.write_bytes(b"branch")
                self.assertEqual(launcher.read_held(fd, 4), b"main")
                with self.assertRaises(ValueError): launcher.read_held(fd, 3)
            finally:
                os.close(fd)

    @unittest.skipUnless(os.execve in os.supports_fd, "requires kernel fd execution")
    def test_real_exec_uses_validated_inode_after_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "gateway"
            shutil.copyfile("/bin/true", path)
            path.chmod(0o755)
            with patch.object(launcher, "trusted"):
                fd = launcher.open_protected(path)
            try:
                path.rename(path.with_name("validated"))
                shutil.copyfile("/bin/false", path)
                path.chmod(0o755)
                child = os.fork()
                if child == 0:
                    try:
                        launcher.execute_held(fd, [str(path), "run"])
                    except BaseException:
                        os._exit(99)
                _, status = os.waitpid(child, 0)
                self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            finally:
                os.close(fd)

    def test_execution_scrubs_environment_and_uses_fd(self):
        original = os.execve
        with patch.dict(os.environ, {"PYTHONPATH": "/branch", "PATH": "/branch"}), patch.object(launcher.os, "supports_fd", {original}), patch.object(launcher.os, "execve") as execute:
            # Membership uses the patched function, as Python's capability set
            # otherwise contains the original callable.
            launcher.os.supports_fd.add(execute)
            launcher.execute_held(17, ["gateway", "run"])
            execute.assert_called_once_with(17, ["gateway", "run"], {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})

    def test_darwin_never_falls_back_to_install_path(self):
        with patch.object(launcher.os, "supports_fd", set()), patch.object(launcher.sys, "platform", "darwin"), patch.object(launcher.os, "set_inheritable") as inherit, patch.object(launcher.os, "execve") as execute:
            launcher.execute_held(17, ["gateway", "run"])
            inherit.assert_called_once_with(17, True)
            execute.assert_called_once_with("/dev/fd/17", ["gateway", "run"], {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})

    @unittest.skipUnless(os.execve in os.supports_fd, "requires kernel fd execution")
    def test_real_gateway_exec_environment_matrix(self):
        # Observe the actual exec environment, not arguments to a mocked exec.
        poison = {"PATH": "/branch", "HOME": "/branch", "PYTHONPATH": "/branch",
                  "PYTHONHOME": "/branch", "PYTHONSTARTUP": "/branch/startup",
                  "LD_PRELOAD": "/branch/canary.so", "LD_LIBRARY_PATH": "/branch",
                  "DYLD_INSERT_LIBRARIES": "/branch/canary.dylib",
                  "DYLD_LIBRARY_PATH": "/branch", "BASH_ENV": "/branch/startup",
                  "ENV": "/branch/startup", "MSB_BACKEND": "remote"}
        for values in [dict([item]) for item in poison.items()] + [poison]:
            with self.subTest(keys=list(values)):
                read, write = os.pipe()
                fd = os.open("/usr/bin/env", os.O_RDONLY)
                try:
                    child = os.fork()
                    if child == 0:
                        try:
                            os.close(read)
                            os.dup2(write, 1)
                            os.close(write)
                            os.environ.update(values)
                            launcher.execute_held(fd, ["env"])
                        except BaseException:
                            os._exit(99)
                    os.close(write)
                    write = None
                    with os.fdopen(read, "rb") as output:
                        observed = output.read()
                    _, status = os.waitpid(child, 0)
                    self.assertEqual(os.waitstatus_to_exitcode(status), 0)
                    self.assertEqual(observed, b"PATH=/usr/bin:/bin:/usr/sbin:/sbin\n")
                finally:
                    os.close(fd)
                    if write is not None:
                        os.close(write)
