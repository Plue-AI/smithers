"""Unprivileged release preflight; no cross-build/install evidence claimed."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import tarfile
import shutil
import unittest
from unittest.mock import patch
from race_schedule import RaceSchedule

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

    def test_reproducibility_refuses_changed_independent_build_and_retains_no(self):
        for changed in (False, True):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / "evidence"
                calls = []
                def build(repo, directory, revision):
                    calls.append(directory)
                    directory.mkdir()
                    artifact = directory / "artifact"
                    artifact.write_bytes(b"second" if changed and len(calls) == 2 else b"main")
                    artifact.chmod(0o755)
                    return {"revision": revision, "files": [{"path": "artifact", "mode": 0o755, "sha256": assemble.digest(artifact)}]}
                with patch.object(assemble, "main_revision", return_value=REVISION), patch.object(assemble, "build_artifacts", side_effect=build):
                    if changed:
                        with self.assertRaisesRegex(ValueError, "independent release builds differ"):
                            assemble.verify_reproducible(Path(temporary), output)
                        self.assertFalse((output / "reproducibility.json").exists())
                        self.assertEqual(json.loads((output / "reproducibility-failure.json").read_bytes())["status"], "NO")
                    else:
                        result = assemble.verify_reproducible(Path(temporary), output)
                        self.assertEqual(result["kind"], "release-inputs-only")
                        self.assertFalse(result["accepted"])
                        self.assertEqual(result["archives"], [])
                self.assertEqual(calls, [output / "first", output / "second"])
                self.assertTrue((output / "first/artifact").exists())
                self.assertTrue((output / "second/artifact").exists())

    def test_reproducibility_requires_new_output_and_paired_overlay_inputs(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(assemble, "main_revision", return_value=REVISION), patch.object(assemble, "build_artifacts") as build:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "must be new"):
                assemble.verify_reproducible(root, root)
            for base, key in ((root, None), (None, root)):
                with self.assertRaisesRegex(ValueError, "both base and reviewer key"):
                    assemble.verify_reproducible(root, root / "output", base=base, review_key=key)
            build.assert_not_called()

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

    def test_release_environment_remaps_source_and_removes_caller_compiler_flags(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            linker = root / "lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld"
            linker.parent.mkdir(parents=True)
            linker.write_bytes(b"linker")
            poison = {name: "/branch" for name in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS")}
            with patch.dict(os.environ, poison), patch.object(subprocess, "check_output", side_effect=[str(root) + "\n", "host: x86_64-unknown-linux-gnu\n"]):
                env = assemble.supervisor_build_environment(root / "target", root / "random-source")
            self.assertEqual(env["CARGO_ENCODED_RUSTFLAGS"], "--remap-path-prefix=" + str(root / "random-source") + "=/smithers/main")
            for name in poison.keys() - {"CARGO_ENCODED_RUSTFLAGS"}:
                self.assertNotIn(name, env)

    def overlay(self, temporary):
        base, manifest = self.base(temporary)
        gateway = Path(temporary) / "gateway"
        gateway.write_bytes(struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 2, 1, 8, 0, 0) + struct.pack("<II", 1, 8))
        supervisor = Path(temporary) / "supervisor"
        header = bytearray(64)
        header[:7] = b"\x7fELF\x02\x01\x01"
        struct.pack_into("<HHI", header, 16, 2, 183, 1)
        struct.pack_into("<Q", header, 32, 64)
        struct.pack_into("<HHH", header, 52, 64, 56, 1)
        supervisor.write_bytes(header + struct.pack("<I", 1) + bytes(52))
        key = Path(temporary) / "key"
        key.write_bytes(b"k" * 32)
        assemble.add_artifact(base, manifest, "bin/trm06-gateway", gateway, 0o755)
        assemble.add_artifact(base, manifest, "libexec/trm06-supervisor", supervisor, 0o755)
        assemble.add_artifact(base, manifest, "share/trm06/smithers-3f.pub", key, 0o644)
        for name, mode in assemble.FILES.items():
            assemble.add_artifact(base, manifest, "share/trm06/" + name, Path(__file__).with_name(name), mode)
        assemble.publish_manifest(base, manifest)
        return base

    def test_complete_overlay_archive_reproduces_across_paths_and_metadata(self):
        repo = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as temporary:
            base = self.overlay(temporary)
            first = Path(temporary) / "first.tar.gz"
            result = assemble.archive_overlay(repo, base, first)
            relocated = Path(temporary) / "relocated"
            shutil.copytree(base, relocated)
            for path in relocated.rglob("*"):
                os.utime(path, (123456, 123456))
            second = Path(temporary) / "second.tar.gz"
            self.assertEqual(assemble.archive_overlay(repo, relocated, second), result)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with tarfile.open(first) as archive:
                names = archive.getnames()
                self.assertEqual(names, sorted(names))
                self.assertIn("share/trm06/validation.py", names)
                for member in archive:
                    self.assertEqual((member.uid, member.gid, member.mtime, member.uname, member.gname), (0, 0, 0, "", ""))
            with self.assertRaises(ValueError): assemble.archive_overlay(repo, base, first)
            with self.assertRaises(ValueError): assemble.archive_overlay(repo, base, base / "nested.tar.gz")

    def test_archive_refuses_incomplete_and_changed_overlay(self):
        repo = Path(__file__).resolve().parents[3]
        for mode in ("missing", "bytes", "unmanifested", "key", "gateway"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                base = self.overlay(temporary)
                if mode == "missing": (base / "share/trm06/run.sh").unlink()
                elif mode == "bytes": (base / "libexec/trm06-supervisor").write_bytes(b"branch")
                elif mode == "unmanifested": (base / "extra").write_bytes(b"extra")
                else:
                    path = base / ("share/trm06/smithers-3f.pub" if mode == "key" else "bin/trm06-gateway")
                    path.write_bytes(b"short")
                    manifest = json.loads((base / "manifest.json").read_bytes())
                    for entry in manifest["files"]:
                        if entry["path"] == path.relative_to(base).as_posix(): entry["sha256"] = assemble.digest(path)
                    (base / "manifest.json").write_text(json.dumps(manifest))
                archive = Path(temporary) / "refused.tar.gz"
                with self.assertRaises((ValueError, OSError)): assemble.archive_overlay(repo, base, archive)
                self.assertFalse(archive.exists())

    def test_archive_checks_actual_tar_bytes_even_when_staging_is_unchanged(self):
        repo = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as temporary:
            base = self.overlay(temporary)
            destination = Path(temporary) / "refused.tar.gz"
            real_run = subprocess.run
            def corrupt(argv, **kwargs):
                result = real_run(argv, **kwargs)
                import io
                with tarfile.open(argv[-2], "w:gz") as archive:
                    info = tarfile.TarInfo("bin/trm06-gateway")
                    info.size = 6
                    info.mode = 0o755
                    archive.addfile(info, io.BytesIO(b"branch"))
                return result
            with patch.object(assemble.subprocess, "run", side_effect=corrupt):
                with self.assertRaisesRegex(ValueError, "archive bytes/mode"):
                    assemble.archive_overlay(repo, base, destination)
            self.assertFalse(destination.exists())
            assemble.validate_base(base, REVISION, overlay=True)

    def test_archive_publication_never_overwrites_raced_output_symlink(self):
        repo = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as temporary:
            base = self.overlay(temporary)
            destination = Path(temporary) / "refused.tar.gz"
            outside = Path(temporary) / "outside"
            outside.write_bytes(b"outside-fixture")
            original = outside.stat()
            real_run = subprocess.run
            def race(argv, **kwargs):
                result = real_run(argv, **kwargs)
                destination.symlink_to(outside)
                return result
            with patch.object(assemble.subprocess, "run", side_effect=race):
                with self.assertRaises(FileExistsError): assemble.archive_overlay(repo, base, destination)
            self.assertEqual(outside.read_bytes(), b"outside-fixture")
            self.assertEqual((outside.stat().st_ino, outside.stat().st_mode, outside.stat().st_uid), (original.st_ino, original.st_mode, original.st_uid))
            self.assertFalse(list(Path(temporary).glob("trm06-archive-*")))

    def test_archive_publication_holds_complete_destination_ancestry(self):
        repo = Path(__file__).resolve().parents[3]
        for timing in ("before-link", "during-link"):
            for target in ("parent", "ancestor", "staging", "archive"):
                with self.subTest(timing=timing, target=target), tempfile.TemporaryDirectory() as temporary:
                    base = self.overlay(temporary)
                    container = Path(temporary) / "container"
                    parent = container / "distribution"
                    parent.mkdir(parents=True)
                    destination = parent / "overlay.tar.gz"
                    outside = Path(temporary) / "outside"
                    outside.mkdir()
                    sentinel = outside / "overlay.tar.gz"
                    sentinel.write_bytes(b"outside-fixture")
                    before = sentinel.stat()
                    original_digest = assemble.hashlib.file_digest
                    original_link = assemble.os.link
                    mutated = False
                    def mutate():
                        nonlocal mutated
                        staging = next(parent.glob("trm06-archive-*"))
                        path = {"parent": parent, "ancestor": container,
                                "staging": staging, "archive": staging / "overlay.tar.gz"}[target]
                        saved = path.with_name(path.name + "-held")
                        path.rename(saved)
                        if target == "archive":
                            path.write_bytes(b"unverified-archive")
                        else:
                            path.mkdir()
                            # Preserve all descendants, including archive inode.
                            for child in list(saved.iterdir()): child.rename(path / child.name)
                        mutated = True
                    def hashed(contents, *args, **kwargs):
                        result = original_digest(contents, *args, **kwargs)
                        name = getattr(contents, "name", None)
                        # The final archive hash happens after tar verification,
                        # in both the previous and descriptor-held implementations.
                        if timing == "before-link" and not mutated and (isinstance(name, int) or str(name).endswith("overlay.tar.gz")):
                            schedule.replace()
                        return result
                    def link(*args, **kwargs):
                        if timing == "during-link" and not mutated: schedule.replace()
                        return original_link(*args, **kwargs)
                    with RaceSchedule(mutate) as schedule, patch.object(assemble.hashlib, "file_digest", side_effect=hashed), patch.object(assemble.os, "link", side_effect=link):
                        with self.assertRaises((ValueError, OSError)):
                            assemble.archive_overlay(repo, base, destination)
                        self.assertFalse(destination.exists())
                    self.assertEqual(sentinel.read_bytes(), b"outside-fixture")
                    observed = sentinel.stat()
                    self.assertEqual((observed.st_ino, observed.st_uid, observed.st_mode),
                                     (before.st_ino, before.st_uid, before.st_mode))

    def test_revision_pin_requires_full_sha_and_main_ancestry(self):
        for requested in ("branch", "a" * 39, "z" * 40):
            with self.subTest(requested=requested), patch.object(subprocess, "check_output", return_value="b" * 40 + "\n"), patch.object(subprocess, "run") as git:
                with self.assertRaises(ValueError): assemble.main_revision(Path("/repo"), requested)
                git.assert_not_called()
        with patch.object(subprocess, "check_output", return_value="b" * 40 + "\n"), patch.object(subprocess, "run") as git:
            self.assertEqual(assemble.main_revision(Path("/repo"), REVISION), REVISION)
            git.assert_called_once_with(["git", "-C", "/repo", "merge-base", "--is-ancestor", REVISION, "b" * 40], check=True)
        with patch.object(subprocess, "check_output", return_value="b" * 40 + "\n"), patch.object(subprocess, "run", side_effect=subprocess.CalledProcessError(1, "git")):
            with self.assertRaises(subprocess.CalledProcessError): assemble.main_revision(Path("/repo"), REVISION)

    def test_gateway_requires_arm64_macho_executable(self):
        for mode in ("valid", "x86", "library", "script", "truncated", "table", "command", "trailing", "count", "unaligned"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "gateway"
                header = bytearray(struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 2, 1, 8, 0, 0))
                table = bytearray(struct.pack("<II", 1, 8))
                if mode == "x86": struct.pack_into("<I", header, 4, 0x01000007)
                if mode == "library": struct.pack_into("<I", header, 12, 6)
                if mode == "script": header[:4] = b"#!/b"
                if mode == "table": struct.pack_into("<I", header, 20, 4096)
                if mode == "command": struct.pack_into("<I", table, 4, 0)
                if mode == "trailing":
                    table.extend(bytes(8))
                    struct.pack_into("<I", header, 20, 16)
                if mode == "count": struct.pack_into("<I", header, 16, 0)
                if mode == "unaligned":
                    struct.pack_into("<I", table, 4, 9)
                    table.extend(b"x")
                    struct.pack_into("<I", header, 20, 9)
                path.write_bytes(header + table if mode != "truncated" else header[:16])
                if mode == "valid": assemble.validate_gateway(path)
                else:
                    with self.assertRaises(ValueError): assemble.validate_gateway(path)

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
                def mutate():
                    root = base
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
                def replace(root, parts, parent, artifact, ancestry):
                    schedule.replace()
                    return original(root, parts, parent, artifact, ancestry)
                with RaceSchedule(mutate) as schedule, patch.object(assemble, "same_destination", side_effect=replace):
                    with self.assertRaises((ValueError, OSError)):
                        assemble.add_artifact(base, manifest, "libexec/trm06-supervisor", source, 0o755)
                self.assertEqual(len(manifest["files"]), 1)
                self.assertEqual(sentinel.read_bytes(), b"outside-fixture")
                self.assertEqual((sentinel.stat().st_ino, sentinel.stat().st_uid, sentinel.stat().st_mode), (before.st_ino, before.st_uid, before.st_mode))

    def test_preserved_subtree_ancestor_replacements_refuse_publication(self):
        for operation in ("artifact", "manifest"):
            for ancestor in ("base", "container", "share"):
                if operation == "manifest" and ancestor == "share":
                    continue
                with self.subTest(operation=operation, ancestor=ancestor), tempfile.TemporaryDirectory() as temporary:
                    container = Path(temporary) / "container"
                    container.mkdir()
                    base, manifest = self.base(container)
                    (base / "share/trm06").mkdir(parents=True)
                    source = Path(temporary) / "source"
                    source.write_bytes(b"main-artifact")
                    sentinel = Path(temporary) / "outside"
                    sentinel.write_bytes(b"outside-fixture")
                    before = sentinel.stat()
                    original = assemble.same_destination
                    def mutate():
                        target = {"base": base, "container": container, "share": base / "share"}[ancestor]
                        saved = target.with_name(target.name + "-held")
                        target.rename(saved)
                        target.mkdir()
                        # Preserve every lower directory and the final artifact inode.
                        # Comparing only the immediate parent cannot detect this.
                        for child in list(saved.iterdir()):
                            child.rename(target / child.name)
                    def check(root, parts, parent, artifact, ancestry):
                        schedule.replace()
                        return original(root, parts, parent, artifact, ancestry)
                    with RaceSchedule(mutate) as schedule, patch.object(assemble, "same_destination", side_effect=check):
                        with self.assertRaises(ValueError):
                            if operation == "artifact":
                                assemble.add_artifact(base, manifest, "share/trm06/launcher.py", source, 0o644)
                            else:
                                assemble.publish_manifest(base, manifest)
                    self.assertEqual(len(manifest["files"]), 1)
                    self.assertEqual(json.loads((base / "manifest.json").read_bytes()), manifest)
                    self.assertEqual(sentinel.read_bytes(), b"outside-fixture")
                    self.assertEqual((sentinel.stat().st_ino, sentinel.stat().st_uid, sentinel.stat().st_mode),
                                     (before.st_ino, before.st_uid, before.st_mode))

    def test_manifest_publication_replacement_matrix(self):
        for mode in ("positive", "manifest-symlink", "root-directory", "root-symlink"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                base, manifest = self.base(temporary)
                sentinel = Path(temporary) / "outside"
                sentinel.write_bytes(b"outside-fixture")
                before = sentinel.stat()
                original = assemble.same_destination
                changed = False
                def mutate():
                    nonlocal changed
                    if mode == "manifest-symlink":
                        (base / "manifest.json").unlink()
                        (base / "manifest.json").symlink_to(sentinel)
                    elif mode.startswith("root"):
                        base.rename(base.with_name("held-base"))
                        if mode == "root-directory": base.mkdir()
                        else: base.symlink_to(base.with_name("held-base"), target_is_directory=True)
                    changed = True
                def check(root, parts, parent, artifact, ancestry):
                    if not changed: schedule.replace()
                    original(root, parts, parent, artifact, ancestry)
                with RaceSchedule(mutate) as schedule, patch.object(assemble, "same_destination", side_effect=check):
                    if mode.startswith("root"):
                        with self.assertRaises((ValueError, OSError)):
                            assemble.publish_manifest(base, manifest)
                    else:
                        assemble.publish_manifest(base, manifest)
                        self.assertFalse((base / "manifest.json").is_symlink())
                        self.assertEqual(json.loads((base / "manifest.json").read_bytes()), manifest)
                self.assertEqual(sentinel.read_bytes(), b"outside-fixture")
                self.assertEqual((sentinel.stat().st_uid, sentinel.stat().st_mode, sentinel.stat().st_ino),
                                 (before.st_uid, before.st_mode, before.st_ino))
                self.assertFalse(list(Path(temporary).rglob(".trm06-manifest.json")))

    def test_build_only_cli_keeps_overlay_inputs_explicit(self):
        for extra in (["--base", "/missing"], ["--review-key", "/missing"]):
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / "output"
                result = subprocess.run([sys.executable, "-I", "-S", str(Path(__file__).with_name("assemble.py")), "--build-only", "--output", str(output), *extra], capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"--build-only does not accept", result.stderr)
                self.assertFalse(output.exists())

    def test_main_advance_refuses_before_artifact_build(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(assemble, "main_revision", return_value="b" * 40), patch.object(assemble.subprocess, "run") as build:
            output = Path(temporary) / "output"
            with self.assertRaisesRegex(ValueError, "main changed"):
                assemble.build_artifacts(Path(temporary), output, REVISION)
            build.assert_not_called()
            self.assertFalse(output.exists())

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
