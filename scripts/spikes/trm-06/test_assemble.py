"""Unprivileged release preflight; no cross-build/install evidence claimed."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("trm06_assemble", Path(__file__).with_name("assemble.py"))
assemble = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assemble)
REVISION = "a" * 40


class BundleAssembly(unittest.TestCase):
    def base(self, directory):
        base = Path(directory) / "base"
        (base / "bin").mkdir(parents=True)
        backend = base / "bin/smithers-backend"
        backend.write_bytes(b"literal-main-backend")
        backend.chmod(0o755)
        manifest = {"version": 1, "platform": "darwin-arm64", "revision": REVISION,
                    "files": [{"path": "bin/smithers-backend", "sha256": assemble.digest(backend), "mode": 0o755, "stage": "backend"}]}
        (base / "manifest.json").write_text(json.dumps(manifest))
        return base, manifest

    def test_build_target_does_not_inherit_shared_cache_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            linker = root / "lib/rustlib/aarch64-apple-darwin/bin/rust-lld"
            linker.parent.mkdir(parents=True)
            linker.write_bytes(b"linker")
            target = root / "private-target"
            with patch.dict(os.environ, {"CARGO_TARGET_DIR": "/shared/cache"}), patch.object(subprocess, "check_output", side_effect=[str(root) + "\n", "host: aarch64-apple-darwin\n"]):
                environment = assemble.supervisor_build_environment(target)
            self.assertEqual(environment["CARGO_TARGET_DIR"], str(target))
            self.assertEqual(environment["CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER"], str(linker))

    def test_supervisor_requires_static_arm64_elf(self):
        for mode in ("valid", "x86", "interpreter", "truncated", "table", "endian", "no-headers"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "supervisor"
                header = bytearray(64)
                header[:7] = b"\x7fELF\x02\x01\x01"
                struct.pack_into("<HHI", header, 16, 2, 183, 1)
                struct.pack_into("<Q", header, 32, 64)
                struct.pack_into("<HHH", header, 52, 64, 56, 1)
                entry = bytearray(56)
                struct.pack_into("<I", entry, 0, 1)
                if mode == "x86": struct.pack_into("<H", header, 18, 62)
                if mode == "interpreter": struct.pack_into("<I", entry, 0, 3)
                if mode == "table": struct.pack_into("<Q", header, 32, 4096)
                if mode == "endian": header[5] = 2
                if mode == "no-headers": struct.pack_into("<H", header, 56, 0)
                path.write_bytes(header + entry if mode != "truncated" else header[:32])
                if mode == "valid":
                    assemble.validate_supervisor(path)
                else:
                    with self.assertRaises(ValueError): assemble.validate_supervisor(path)

    def test_overlay_retains_base_and_records_exact_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            base, _ = self.base(temporary)
            manifest = assemble.validate_base(base, REVISION)
            artifact = Path(temporary) / "supervisor"
            artifact.write_bytes(b"main-supervisor-fixture\x00")
            assemble.add_artifact(base, manifest, "libexec/trm06-supervisor", artifact, 0o755)
            self.assertEqual(len(manifest["files"]), 2)
            self.assertEqual(manifest["files"][1], {"path": "libexec/trm06-supervisor", "sha256": assemble.digest(artifact), "stage": "host", "mode": 0o755})
            self.assertEqual((base / "libexec/trm06-supervisor").read_bytes(), artifact.read_bytes())
            self.assertEqual((base / "libexec/trm06-supervisor").stat().st_mode & 0o777, 0o755)
            (base / "manifest.json").write_text(json.dumps(manifest))
            verifier = Path(__file__).resolve().parents[3] / "apps/app/scripts/server-bundle-manifest.ts"
            verified = subprocess.run(["bun", str(verifier), str(base)], capture_output=True, timeout=10)
            self.assertEqual(verified.returncode, 0, verified.stderr.decode())
            with self.assertRaises(FileExistsError):
                assemble.add_artifact(base, manifest, "libexec/trm06-supervisor", artifact, 0o755)

    def test_replaced_unmanifested_and_other_revision_refuse(self):
        for mode in ("digest", "mode", "extra", "revision", "traversal", "duplicate", "hardlink"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                base, manifest = self.base(temporary)
                backend = base / "bin/smithers-backend"
                if mode == "digest": backend.write_bytes(b"branch")
                if mode == "mode": backend.chmod(0o777)
                if mode == "extra": (base / "canary").write_bytes(b"unmanifested")
                if mode == "revision": manifest["revision"] = "b" * 40
                if mode == "traversal": manifest["files"][0]["path"] = "../outside"
                if mode == "duplicate": manifest["files"].append(dict(manifest["files"][0]))
                if mode == "hardlink": os.link(backend, Path(temporary) / "outside-link")
                (base / "manifest.json").write_text(json.dumps(manifest))
                with self.assertRaises(ValueError): assemble.validate_base(base, REVISION)

    def test_overlay_replaced_source_refuses_before_destination_creation(self):
        for mode in ("symlink", "hardlink", "directory", "fifo"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                base, manifest = self.base(temporary)
                outside = Path(temporary) / "outside"
                outside.write_bytes(b"outside-fixture")
                source = Path(temporary) / "source"
                if mode == "symlink": source.symlink_to(outside)
                elif mode == "hardlink": os.link(outside, source)
                elif mode == "directory": source.mkdir()
                else: os.mkfifo(source)
                with self.assertRaises((ValueError, OSError)):
                    assemble.add_artifact(base, manifest, "libexec/trm06-supervisor", source, 0o755)
                self.assertFalse((base / "libexec/trm06-supervisor").exists())
                self.assertEqual(outside.read_bytes(), b"outside-fixture")
                self.assertEqual(len(manifest["files"]), 1)

    def test_overlay_symlink_cannot_write_outside(self):
        with tempfile.TemporaryDirectory() as temporary:
            base, manifest = self.base(temporary)
            outside = Path(temporary) / "outside"
            outside.mkdir()
            (base / "libexec").symlink_to(outside, target_is_directory=True)
            source = Path(temporary) / "source"
            source.write_bytes(b"canary")
            with self.assertRaises((ValueError, OSError)):
                assemble.add_artifact(base, manifest, "libexec/trm06-supervisor", source, 0o755)
            self.assertEqual(list(outside.iterdir()), [])
            (base / "share").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(OSError):
                assemble.add_artifact(base, manifest, "share/trm06/launcher.py", source, 0o644)
            self.assertEqual(list(outside.iterdir()), [])

    def test_replaced_destination_is_never_published_in_manifest(self):
        for mode in ("parent-symlink", "parent-directory", "artifact-symlink", "artifact-regular"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                base, manifest = self.base(temporary)
                source = Path(temporary) / "source"
                source.write_bytes(b"main-artifact")
                outside = Path(temporary) / "outside"
                outside.mkdir()
                sentinel = outside / "trm06-supervisor"
                sentinel.write_bytes(b"outside-fixture")
                before = sentinel.stat()
                original = assemble.same_destination
                def replace(root, parts, parent, artifact):
                    target = root / "libexec/trm06-supervisor"
                    if mode.startswith("parent"):
                        (root / "libexec").rename(root / "original-libexec")
                        if mode == "parent-symlink":
                            (root / "libexec").symlink_to(outside, target_is_directory=True)
                        else:
                            (root / "libexec").mkdir()
                    else:
                        target.rename(target.with_name("original-supervisor"))
                        if mode == "artifact-symlink":
                            target.symlink_to(sentinel)
                        else:
                            target.write_bytes(b"replacement")
                    return original(root, parts, parent, artifact)
                with patch.object(assemble, "same_destination", side_effect=replace):
                    with self.assertRaises((ValueError, OSError)):
                        assemble.add_artifact(base, manifest, "libexec/trm06-supervisor", source, 0o755)
                self.assertEqual(len(manifest["files"]), 1)
                self.assertEqual(sentinel.read_bytes(), b"outside-fixture")
                self.assertEqual((sentinel.stat().st_ino, sentinel.stat().st_uid, sentinel.stat().st_mode), (before.st_ino, before.st_uid, before.st_mode))

    def test_entrypoint_refuses_wrong_base_before_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            base, _ = self.base(temporary)
            key = Path(temporary) / "key"
            key.write_bytes(b"k" * 32)
            result = subprocess.run([sys.executable, "-I", "-S", str(Path(__file__).with_name("assemble.py")), "--base", str(base), "--output", str(Path(temporary) / "output"), "--review-key", str(key)], capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"base bundle is not this main revision", result.stderr)
            self.assertFalse((Path(temporary) / "output").exists())


if __name__ == "__main__":
    unittest.main()
