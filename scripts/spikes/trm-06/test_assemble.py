"""Unprivileged release preflight; no cross-build/install evidence claimed."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

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
