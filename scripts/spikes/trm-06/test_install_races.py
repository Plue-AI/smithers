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
from race_schedule import RaceSchedule

spec = importlib.util.spec_from_file_location("trm06_install", Path(__file__).with_name("install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerReplacement(unittest.TestCase):
    def test_install_boundary_replacement_matrix(self):
        for target in (None, "opt", "opt/smithers", "run", "run/smithers",
                       "opt/smithers/prototype", "run/smithers/trm06",
                       "opt/smithers/prototype/supervisor", "run/smithers/trm06/boot.json"):
            replacements = ("directory",) if target is None else ("symlink", "inode", "mode")
            if target and (target.endswith("supervisor") or target.endswith("boot.json")):
                replacements += ("contents", "same-size", "hardlink", "fifo")
            for replacement in replacements:
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

                    def mutate():
                        nonlocal replaced
                        if target and not replaced:
                            path = root / target
                            if replacement in ("contents", "same-size"):
                                # These replaceable-byte fixtures model the
                                # installed operator; our real UID stays local.
                                mode, size = path.stat().st_mode & 0o777, path.stat().st_size
                                path.chmod(0o600)
                                path.write_bytes(b"canary" if replacement == "contents" else b"x" * size)
                                path.chmod(mode)
                            elif replacement == "mode":
                                path.chmod(0o777)
                            elif replacement == "hardlink":
                                os.link(path, root / "hardlink")
                            else:
                                path.rename(path.with_name(path.name + "-original"))
                            if replacement == "symlink":
                                path.symlink_to(sentinel)
                            elif replacement == "fifo":
                                os.mkfifo(path)
                            elif replacement == "inode" and (target.endswith("supervisor") or target.endswith("boot.json")):
                                path.write_bytes(b"canary")
                                path.chmod(0o755)
                            elif replacement == "inode":
                                path.mkdir(mode=0o755)
                            replaced = True
                    def scheduled_link(parent, name, held):
                        schedule.replace()
                        real_linked(parent, name, held)

                    with RaceSchedule(mutate) as schedule, patch.object(installer.os, "getuid", return_value=0), patch.object(installer.os, "geteuid", return_value=0), \
                         patch.object(installer.os, "open", side_effect=rooted_open), patch.object(installer.os, "fstat", side_effect=root_owned), \
                         patch.object(installer, "linked", side_effect=scheduled_link), \
                         patch.object(installer.sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(json.dumps(payload).encode()))), \
                         patch.object(installer.subprocess, "Popen", return_value=types.SimpleNamespace(pid=123)) as launch, \
                         patch("sys.stdout", new_callable=io.StringIO):
                        if target:
                            with self.assertRaises((ValueError, OSError)):
                                installer.install()
                            self.assertTrue(replaced, "the attacker must reach its selected boundary")
                            launch.assert_not_called()
                        else:
                            installer.install()
                            launch.assert_called_once()
                            self.assertEqual(launch.call_args.kwargs["env"], {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})
                            self.assertTrue(launch.call_args.kwargs["executable"].startswith("/proc/self/fd/"))
                    self.assertEqual((sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode), before)


    def test_installer_refuses_nonregular_artifacts_before_read(self):
        # Kernel nonblocking opens must make a FIFO refusal prompt, even before
        # the first inode/digest comparison. A subprocess bounds a regression
        # that would otherwise hang this test at a blocking open.
        import subprocess
        for kind in ("fifo", "directory", "symlink", "hardlink", "oversized", "positive"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "artifact"
                if kind == "fifo": os.mkfifo(path)
                elif kind == "directory": path.mkdir()
                elif kind == "symlink": path.symlink_to("outside")
                else:
                    path.write_bytes(b"main" if kind != "oversized" else bytes(65537))
                    path.chmod(0o755)
                    if kind == "hardlink": os.link(path, path.with_name("other"))
                program = r"""
import importlib.util, os, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("installer", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
original = os.fstat
def owned(fd):
    values = list(original(fd)); values[4] = 0
    return os.stat_result(values)
parent = os.open(sys.argv[2], os.O_RDONLY | os.O_DIRECTORY)
try:
    with patch.object(m.os, "fstat", side_effect=owned):
        fd = m.verified_file(parent, "artifact", b"main", 0o755)
        os.close(fd)
except (ValueError, OSError):
    sys.exit(78)
finally:
    os.close(parent)
"""
                result = subprocess.run([os.sys.executable, "-I", "-S", "-c", program,
                                         str(Path(installer.__file__).resolve()), temporary],
                                        capture_output=True, timeout=2)
                self.assertEqual(result.returncode, 0 if kind == "positive" else 78,
                                 result.stderr.decode())

    def test_installed_destination_selectors_refuse_through_installer(self):
        fixture_spec = importlib.util.spec_from_file_location("validation", Path(__file__).with_name("validation.py"))
        fixture = importlib.util.module_from_spec(fixture_spec)
        fixture_spec.loader.exec_module(fixture)
        self.assertEqual(len(fixture.INSTALL_MUTATIONS), 16)
        for selector, (target, mutation) in fixture.INSTALL_MUTATIONS.items():
            with self.subTest(selector=selector), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                for relative in ("opt", "opt/smithers", "run", "run/smithers"):
                    (root / relative).mkdir(exist_ok=True)
                    (root / relative).chmod(0o755)
                outside = root / "outside"
                outside.write_bytes(b"outside-fixture\0")
                before = (outside.read_bytes(), outside.stat().st_uid, outside.stat().st_mode)
                selected = root / target.removeprefix("/")
                ownership = {}
                real_fstat, real_open = os.fstat, os.open
                def owner(fd, uid, gid):
                    self.assertEqual((uid, gid), (20001, 20001))
                    ownership[real_fstat(fd).st_ino] = uid
                # No elevation: substitute only the root metadata observations.
                # Mutation, no-follow resolution and refusals use real syscalls.
                with patch.object(fixture.os, "fchown", side_effect=owner):
                    fixture.mutate_install(str(selected), mutation)
                def root_owned(fd):
                    original = real_fstat(fd)
                    values = list(original)
                    values[4] = ownership.get(original.st_ino, 0)
                    return os.stat_result(values)
                def rooted_open(path, flags, mode=0o777, *, dir_fd=None):
                    return real_open(str(root) if path == "/" and dir_fd is None else path, flags, mode, dir_fd=dir_fd)
                binary = b"literal-supervisor-fixture"
                sha = hashlib.sha256(binary).hexdigest()
                request = {"supervisor": base64.b64encode(binary).decode(), "sha256": sha,
                           "boot": {"revision": "a" * 40, "supervisor_sha256": sha,
                                    "boot": [1] * 16, "secret": [2] * 32}}
                with patch.object(installer.os, "getuid", return_value=0), patch.object(installer.os, "geteuid", return_value=0), patch.object(installer.os, "open", side_effect=rooted_open), patch.object(installer.os, "fstat", side_effect=root_owned), patch.object(installer.sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))), patch.object(installer.subprocess, "Popen") as launch:
                    with self.assertRaises((ValueError, OSError)):
                        installer.install()
                    launch.assert_not_called()
                self.assertEqual((outside.read_bytes(), outside.stat().st_uid, outside.stat().st_mode), before)

    def test_installed_synchronized_matrix_through_real_installer(self):
        fixture_spec = importlib.util.spec_from_file_location("installed_fixture", Path(__file__).with_name("validation.py"))
        fixture = importlib.util.module_from_spec(fixture_spec)
        fixture_spec.loader.exec_module(fixture)
        self.assertEqual(len(fixture.INSTALL_RACES), 45)
        source = Path(__file__).with_name("install.py").read_text()
        for selector, (target, mutation) in fixture.INSTALL_RACES.items():
            if mutation == "owner":
                # Native guest execution observes real UID changes. This lane
                # must not simulate a forked worker's ownership receipt.
                continue
            with self.subTest(selector=selector), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                for relative in ("opt", "opt/smithers", "run", "run/smithers", "var", "var/tmp"):
                    (root / relative).mkdir(exist_ok=True)
                    (root / relative).chmod(0o755)
                outside = root / "outside"
                outside.write_bytes(b"outside-fixture\0")
                outside.chmod(0o640)
                before = (outside.read_bytes(), outside.stat().st_uid, outside.stat().st_mode)
                binary = b"literal-supervisor-fixture"
                sha = hashlib.sha256(binary).hexdigest()
                payload = {"supervisor": base64.b64encode(binary).decode(), "sha256": sha,
                           "boot": {"revision": "a" * 40, "supervisor_sha256": sha,
                                    "boot": [1] * 16, "secret": [2] * 32}}
                real_open, real_fstat = os.open, os.fstat
                def rooted_open(path, flags, mode=0o777, *, dir_fd=None):
                    if dir_fd is None and str(path).startswith("/") and not str(path).startswith(str(root) + "/"):
                        path = str(root / str(path).removeprefix("/"))
                    return real_open(path, flags, mode, dir_fd=dir_fd)
                def root_owned(fd):
                    values = list(real_fstat(fd)); values[4] = 0
                    return os.stat_result(values)
                original_mutate = fixture.mutate_startup
                def rooted_mutate(selected, kind):
                    path = root / selected.removeprefix("/")
                    mode = path.stat().st_mode & 0o777
                    if kind == "same-size" and path.name == "boot.json": path.chmod(0o600)
                    original_mutate(str(path), kind)
                    if kind == "same-size" and path.name == "boot.json": path.chmod(mode)
                def observed_sentinel():
                    info = outside.stat()
                    return {"sha256":hashlib.sha256(outside.read_bytes()).hexdigest(), "uid":20001,"mode":info.st_mode & 0o777}
                namespace = {"__name__":"installed_test"}
                exec(compile(source, "<trm06-installed-installer>", "exec"), namespace)
                try:
                    with patch.object(installer.os, "getuid", return_value=0), patch.object(installer.os, "geteuid", return_value=0), patch.object(installer.os, "open", side_effect=rooted_open), patch.object(installer.os, "fstat", side_effect=root_owned), patch.object(fixture, "mutate_startup", side_effect=rooted_mutate), patch.object(fixture, "fingerprint", side_effect=observed_sentinel), patch.object(installer.sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(json.dumps(payload).encode()))), patch.object(installer.subprocess, "Popen", return_value=types.SimpleNamespace(pid=123)) as launch, patch("sys.stdout", new_callable=io.StringIO), patch("sys.stderr", new_callable=io.StringIO):
                        fixture.arm_install_race(selector)
                        if target is None:
                            namespace["install"]()
                            launch.assert_called_once()
                        else:
                            with self.assertRaises((ValueError, OSError)):
                                namespace["install"]()
                            launch.assert_not_called()
                        record = fixture.install_race_result()
                        self.assertEqual(record["selector"], selector)
                        self.assertLessEqual(record["held_ns"], record["mutation_start_ns"])
                        self.assertLessEqual(record["mutation_start_ns"], record["mutation_end_ns"])
                        self.assertNotEqual(record["worker_pid"], os.getpid())
                        self.assertEqual(record["before"], record["after"])
                finally:
                    os.sys.setprofile(None)
                self.assertEqual((outside.read_bytes(), outside.stat().st_uid, outside.stat().st_mode), before)


if __name__ == "__main__":
    unittest.main()
