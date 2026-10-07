"""Unprivileged main-pinned spike overlay for an uninstalled release bundle.

Never installs, signs approvals, executes a prototype or writes to the current
system installation. The install owner's existing release installer remains the
only installation path. Run from a Mac release builder with the Linux ARM64
Rust musl target installed; uses the Rust toolchain’s bundled linker. Missing security approval keeps activation closed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import tarfile
import tempfile

SPIKE = Path("scripts/spikes/trm-06")
FILES = {"launcher.py": 0o644, "install.py": 0o644, "validation.py": 0o644,
         "run.sh": 0o755, "revoke.sh": 0o755, "flow.sh": 0o755}


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate manifest field")
        result[key] = value
    return result


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("not a single-link regular artifact")
    return info


def validate_base(base, revision):
    manifest = json.loads((base / "manifest.json").read_bytes(), object_pairs_hook=unique)
    if manifest["version"] != 1 or manifest["platform"] != "darwin-arm64" or manifest["revision"] != revision:
        raise ValueError("base bundle is not this main revision/platform")
    seen = set()
    for entry in manifest["files"]:
        relative = entry["path"]
        if relative.startswith("/") or any(p in ("", ".", "..") for p in relative.split("/")) or relative in seen:
            raise ValueError("invalid manifest path")
        seen.add(relative)
        path = base / relative
        if not path.resolve().is_relative_to(base.resolve()):
            raise ValueError("bundle artifact escapes")
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            if os.readlink(path) != entry.get("symlink"):
                raise ValueError("replaced bundle symlink")
        else:
            regular(path)
        if digest(path) != entry["sha256"] or stat.S_IMODE(path.stat().st_mode) != entry["mode"]:
            raise ValueError("replaced base artifact")
    actual = {p.relative_to(base).as_posix() for p in base.rglob("*") if (p.is_symlink() or not p.is_dir()) and p.relative_to(base).as_posix() != "manifest.json"}
    if actual != seen:
        raise ValueError("base bundle has unmanifested artifacts")
    if any(p.startswith("share/trm06/") or p in ("bin/trm06-gateway", "libexec/trm06-supervisor") for p in seen):
        raise ValueError("spike already assembled")
    return manifest


def same_destination(root, parts, parent, artifact):
    """Reopen without following a replaced ancestor before publishing identity."""
    current = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        held = os.fstat(parent)
        observed = os.fstat(current)
        if (held.st_dev, held.st_ino) != (observed.st_dev, observed.st_ino):
            raise ValueError("overlay destination parent replaced")
        observed = os.stat(parts[-1], dir_fd=current, follow_symlinks=False)
        if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1 or (observed.st_dev, observed.st_ino) != (artifact.st_dev, artifact.st_ino):
            raise ValueError("overlay destination artifact replaced")
    finally:
        os.close(current)


def add_artifact(root, manifest, relative, source, mode):
    parts = relative.split("/")
    if relative.startswith("/") or any(part in ("", ".", "..") for part in parts):
        raise ValueError("invalid overlay artifact path")
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            try:
                os.mkdir(part, 0o755, dir_fd=parent)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        source_info = os.fstat(source_fd)
        if not stat.S_ISREG(source_info.st_mode) or source_info.st_nlink != 1:
            os.close(source_fd)
            raise ValueError("not a single-link regular artifact")
        try:
            fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
        except BaseException:
            os.close(source_fd)
            raise
        with os.fdopen(source_fd, "rb") as input_file, os.fdopen(fd, "wb") as output:
            hash_value = hashlib.sha256()
            while chunk := input_file.read(1024 * 1024):
                output.write(chunk)
                hash_value.update(chunk)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
            artifact_info = os.fstat(output.fileno())
        same_destination(root, parts, parent, artifact_info)
        manifest["files"].append({"path": relative, "sha256": hash_value.hexdigest(), "stage": "host", "mode": mode})
    finally:
        os.close(parent)



def validate_supervisor(path):
    # A static Linux ARM64 binary needs no guest-selected dynamic interpreter.
    # Check the built bytes before staging, independently of Cargo's target name.
    regular(path)
    with path.open("rb") as source:
        header = source.read(64)
        if len(header) != 64 or header[:7] != b"\x7fELF\x02\x01\x01":
            raise ValueError("supervisor must be ELF64 little-endian")
        kind, machine, version = struct.unpack_from("<HHI", header, 16)
        offset = struct.unpack_from("<Q", header, 32)[0]
        header_size, entry_size, count = struct.unpack_from("<HHH", header, 52)
        size = os.fstat(source.fileno()).st_size
        if kind not in (2, 3) or machine != 183 or version != 1 or header_size != 64 or entry_size != 56 or not 0 < count <= 128 or offset < 64 or offset + count * entry_size > size:
            raise ValueError("invalid Linux ARM64 supervisor headers")
        source.seek(offset)
        for _ in range(count):
            entry = source.read(entry_size)
            if struct.unpack_from("<I", entry)[0] == 3:
                raise ValueError("supervisor must not use a guest dynamic interpreter")


def supervisor_build_environment(target):
    sysroot = Path(subprocess.check_output(["rustc", "--print", "sysroot"], text=True).strip())
    metadata = subprocess.check_output(["rustc", "-vV"], text=True)
    hosts = [line.removeprefix("host: ") for line in metadata.splitlines() if line.startswith("host: ")]
    if len(hosts) != 1 or "/" in hosts[0] or hosts[0] in ("", ".", ".."):
        raise ValueError("invalid Rust host triple")
    linker = sysroot / "lib/rustlib" / hosts[0] / "bin/rust-lld"
    regular(linker)
    return dict(os.environ, CARGO_TARGET_DIR=str(target), CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=str(linker))


def assemble(repo, base, output, review_key):
    if os.geteuid() == 0:
        raise ValueError("release builds must be unprivileged")
    revision = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "origin/main"], text=True).strip()
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("invalid main revision")
    manifest = validate_base(base, revision)
    regular(review_key)
    if review_key.stat().st_size != 32:
        raise ValueError("reviewer key must be the owner's provisioned raw Ed25519 public key")
    if output.exists() or output.is_symlink() or output.resolve().is_relative_to(Path("/usr/local/lib/smithers")):
        raise ValueError("output must be a new uninstalled staging directory")
    # Archive exactly main, never checkout changes or a branch-selected ref.
    with tempfile.TemporaryDirectory(prefix="trm06-main-") as temporary:
        build = Path(temporary)
        archive = build / "main.tar"
        subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", "-o", str(archive), revision], check=True)
        with tarfile.open(archive) as source:
            source.extractall(build / "source", filter="data")
        source = build / "source"
        environment = dict(os.environ, GOOS="darwin", GOARCH="arm64", CGO_ENABLED="0")
        gateway = build / "trm06-gateway"
        subprocess.run(["go", "build", "-trimpath", "-o", str(gateway), "./scripts/spikes/trm-06/gateway"], cwd=source, env=environment, check=True)
        subprocess.run(["cargo", "build", "--locked", "--release", "--target", "aarch64-unknown-linux-musl", "--manifest-path", str(source / SPIKE / "supervisor/Cargo.toml")], cwd=source, env=supervisor_build_environment(build / "cargo-target"), check=True)
        # Cargo hardlinks its top-level executable to deps. Stage a private
        # single-link copy before applying the release artifact invariant.
        supervisor = build / "trm06-supervisor"
        shutil.copyfile(build / "cargo-target/aarch64-unknown-linux-musl/release/trm06-supervisor", supervisor)
        validate_supervisor(supervisor)
        shutil.copytree(base, output, symlinks=True)
        try:
            manifest = validate_base(output, revision)
            add_artifact(output, manifest, "bin/trm06-gateway", gateway, 0o755)
            add_artifact(output, manifest, "libexec/trm06-supervisor", supervisor, 0o755)
            validate_supervisor(output / "libexec/trm06-supervisor")
            for name, mode in FILES.items():
                add_artifact(output, manifest, "share/trm06/" + name, source / SPIKE / name, mode)
            add_artifact(output, manifest, "share/trm06/smithers-3f.pub", review_key, 0o644)
            manifest["files"].sort(key=lambda entry: entry["path"])
            (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        except BaseException:
            shutil.rmtree(output)
            raise
    # Approval is deliberately absent. Give the reviewer the exact complete
    # artifact map to sign; no self-generated key or acceptance receipt exists.
    return {"revision": revision, "artifacts": {entry["path"]: entry["sha256"] for entry in manifest["files"]}, "activation": "refused-until-reviewed"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--review-key", required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    print(json.dumps(assemble(repo, args.base.resolve(), args.output.absolute(), args.review_key)))
