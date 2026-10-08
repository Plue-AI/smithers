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
import sys
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


def validate_base(base, revision, *, overlay=False):
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
    if not overlay and any(p.startswith("share/trm06/") or p in ("bin/trm06-gateway", "libexec/trm06-supervisor") for p in seen):
        raise ValueError("spike already assembled")
    return manifest


def destination_chain(root):
    """Hold all absolute ancestors without following symlinks."""
    path = Path(os.path.abspath(root))
    chain = [os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)]
    try:
        for part in path.parts[1:]:
            chain.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                 dir_fd=chain[-1]))
        return chain
    except BaseException:
        for fd in chain:
            os.close(fd)
        raise


def same_destination(root, parts, parent, artifact, ancestry, *, links=1):
    """Revalidate every held ancestor, including preserved-subtree moves."""
    current_chain = destination_chain(root)
    try:
        for part in parts[:-1]:
            current_chain.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                         dir_fd=current_chain[-1]))
        if len(current_chain) != len(ancestry):
            raise ValueError("overlay destination ancestry replaced")
        for original, current in zip(ancestry, current_chain):
            held, observed = os.fstat(original), os.fstat(current)
            if (held.st_dev, held.st_ino) != (observed.st_dev, observed.st_ino):
                raise ValueError("overlay destination ancestor replaced")
        observed = os.stat(parts[-1], dir_fd=current_chain[-1], follow_symlinks=False)
        if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != links or (observed.st_dev, observed.st_ino) != (artifact.st_dev, artifact.st_ino):
            raise ValueError("overlay destination artifact replaced")
    finally:
        for fd in current_chain:
            os.close(fd)



def add_artifact(root, manifest, relative, source, mode):
    parts = relative.split("/")
    if relative.startswith("/") or any(part in ("", ".", "..") for part in parts):
        raise ValueError("invalid overlay artifact path")
    ancestry = destination_chain(root)
    parent = ancestry[-1]
    try:
        for part in parts[:-1]:
            try:
                os.mkdir(part, 0o755, dir_fd=parent)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            ancestry.append(child)
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
        same_destination(root, parts, parent, artifact_info, ancestry)
        manifest["files"].append({"path": relative, "sha256": hash_value.hexdigest(), "stage": "host", "mode": mode})
    finally:
        for fd in ancestry:
            os.close(fd)



def publish_manifest(root, manifest):
    """Replace the manifest through a held staging directory, never a symlink.

    The copied base already contains manifest.json. Atomic descriptor-relative
    replacement avoids truncating a raced symlink's outside target.
    """
    ancestry = destination_chain(root)
    parent = ancestry[-1]
    temporary = ".trm06-manifest.json"
    created = False
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
        created = True
        with os.fdopen(fd, "wb") as output:
            output.write((json.dumps(manifest, indent=2) + "\n").encode())
            output.flush()
            os.fsync(output.fileno())
            artifact = os.fstat(output.fileno())
        same_destination(root, [temporary], parent, artifact, ancestry)
        os.rename(temporary, "manifest.json", src_dir_fd=parent, dst_dir_fd=parent)
        created = False
        same_destination(root, ["manifest.json"], parent, artifact, ancestry)
        os.fsync(parent)
    finally:
        try:
            if created:
                try:
                    os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError:
                    pass  # A replacement may have moved the staging leaf too.
        finally:
            for fd in ancestry:
                os.close(fd)


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


def validate_gateway(path):
    """Require actual Darwin ARM64 executable bytes, not a build target label."""
    regular(path)
    with path.open("rb") as source:
        header = source.read(32)
        if len(header) != 32:
            raise ValueError("truncated gateway Mach-O")
        magic, cpu, subtype, kind, count, commands, flags, reserved = struct.unpack("<8I", header)
        size = os.fstat(source.fileno()).st_size
        if magic != 0xFEEDFACF or cpu != 0x0100000C or kind != 2 or not 0 < count <= 4096 or not 8 * count <= commands <= 1024 * 1024 or 32 + commands > size:
            raise ValueError("gateway must be Darwin ARM64 Mach-O executable")
        table = source.read(commands)
        offset = 0
        for _ in range(count):
            if offset + 8 > len(table):
                raise ValueError("truncated Mach-O load command")
            command, length = struct.unpack_from("<II", table, offset)
            if length < 8 or length % 8 or offset + length > len(table):
                raise ValueError("invalid Mach-O load command")
            offset += length
        if offset != commands:
            raise ValueError("unclaimed Mach-O command bytes")


def supervisor_build_environment(target, source=None):
    sysroot = Path(subprocess.check_output(["rustc", "--print", "sysroot"], text=True).strip())
    metadata = subprocess.check_output(["rustc", "-vV"], text=True)
    hosts = [line.removeprefix("host: ") for line in metadata.splitlines() if line.startswith("host: ")]
    if len(hosts) != 1 or "/" in hosts[0] or hosts[0] in ("", ".", ".."):
        raise ValueError("invalid Rust host triple")
    linker = sysroot / "lib/rustlib" / hosts[0] / "bin/rust-lld"
    regular(linker)
    environment = dict(os.environ, CARGO_TARGET_DIR=str(target),
                       CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=str(linker))
    # Cargo prefers encoded flags over RUSTFLAGS. Clear both caller-selected
    # flags and wrappers, and remove the randomized archive extraction path.
    for name in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER",
                 "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS"):
        environment.pop(name, None)
    if source is not None:
        environment["CARGO_ENCODED_RUSTFLAGS"] = "--remap-path-prefix=" + str(source) + "=/smithers/main"
    return environment


def main_revision(repo, requested=None):
    revision = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "origin/main"], text=True).strip()
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("invalid main revision")
    if requested is not None:
        if len(requested) != 40 or any(c not in "0123456789abcdef" for c in requested):
            raise ValueError("invalid requested main revision")
        subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", requested, revision], check=True)
        return requested
    return revision


def build_artifacts(repo, output, expected_revision=None):
    """Build only main-pinned release inputs; never a bundle or root authority."""
    if os.geteuid() == 0:
        raise ValueError("release builds must be unprivileged")
    revision = main_revision(repo, expected_revision)
    if expected_revision is not None and revision != expected_revision:
        raise ValueError("main changed before overlay build")
    if output.exists() or output.is_symlink() or output.resolve().is_relative_to(Path("/usr/local/lib/smithers")):
        raise ValueError("output must be a new uninstalled staging directory")
    with tempfile.TemporaryDirectory(prefix="trm06-main-") as temporary:
        build = Path(temporary)
        archive = build / "main.tar"
        subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", "-o", str(archive), revision], check=True)
        source_digest = digest(archive)
        with tarfile.open(archive) as source:
            source.extractall(build / "source", filter="data")
        source = build / "source"
        environment = dict(os.environ, GOOS="darwin", GOARCH="arm64", CGO_ENABLED="0", GOFLAGS="", GOWORK="off")
        gateway = build / "trm06-gateway"
        subprocess.run(["go", "build", "-trimpath", "-buildvcs=false", "-o", str(gateway), "./scripts/spikes/trm-06/gateway"], cwd=source, env=environment, check=True)
        validate_gateway(gateway)
        subprocess.run(["cargo", "build", "--locked", "--release", "--target", "aarch64-unknown-linux-musl", "--manifest-path", str(source / SPIKE / "supervisor/Cargo.toml")], cwd=source, env=supervisor_build_environment(build / "cargo-target", source), check=True)
        # Cargo hardlinks its executable to deps. Retain a private single-link copy.
        supervisor = build / "trm06-supervisor"
        shutil.copyfile(build / "cargo-target/aarch64-unknown-linux-musl/release/trm06-supervisor", supervisor)
        validate_supervisor(supervisor)
        receipt = {"revision": revision, "source_archive_sha256": source_digest,
                   "kind": "release-inputs-only", "activation": "unavailable",
                   "toolchain": {"go": subprocess.check_output(["go", "version"], text=True).strip(),
                                 "rust": subprocess.check_output(["rustc", "-vV"], text=True).strip()},
                   "files": []}
        output.mkdir()
        try:
            add_artifact(output, receipt, "bin/trm06-gateway", gateway, 0o755)
            add_artifact(output, receipt, "libexec/trm06-supervisor", supervisor, 0o755)
            for name, mode in FILES.items():
                add_artifact(output, receipt, "share/trm06/" + name, source / SPIKE / name, mode)
            receipt["files"].sort(key=lambda entry: entry["path"])
            # Deliberately not manifest.json: these inputs lack the base release,
            # review key and signed receipts, and are never an installed bundle.
            (output / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        except BaseException:
            shutil.rmtree(output)
            raise
    return receipt


def assemble(repo, base, output, review_key, expected_revision=None):
    if os.geteuid() == 0:
        raise ValueError("release builds must be unprivileged")
    revision = main_revision(repo, expected_revision)
    manifest = validate_base(base, revision)
    regular(review_key)
    if review_key.stat().st_size != 32:
        raise ValueError("reviewer key must be the owner's provisioned raw Ed25519 public key")
    if output.exists() or output.is_symlink() or output.resolve().is_relative_to(Path("/usr/local/lib/smithers")):
        raise ValueError("output must be a new uninstalled staging directory")
    with tempfile.TemporaryDirectory(prefix="trm06-overlay-") as temporary:
        artifacts = Path(temporary) / "artifacts"
        receipt = build_artifacts(repo, artifacts, revision)
        shutil.copytree(base, output, symlinks=True)
        try:
            manifest = validate_base(output, revision)
            for entry in receipt["files"]:
                add_artifact(output, manifest, entry["path"], artifacts / entry["path"], entry["mode"])
            validate_gateway(output / "bin/trm06-gateway")
            validate_supervisor(output / "libexec/trm06-supervisor")
            add_artifact(output, manifest, "share/trm06/smithers-3f.pub", review_key, 0o644)
            manifest["files"].sort(key=lambda entry: entry["path"])
            publish_manifest(output, manifest)
        except BaseException:
            shutil.rmtree(output)
            raise
    return {"revision": revision, "source_archive_sha256": receipt["source_archive_sha256"],
            "toolchain": receipt["toolchain"],
            "artifacts": {entry["path"]: entry["sha256"] for entry in manifest["files"]},
            "activation": "refused-until-reviewed"}



def archive_overlay(repo, root, destination):
    """Publish a reproducible verified overlay using the release archive writer.

    No signature is created and nothing is installed. The tar's actual bytes,
    including manifest and symlink targets, must match the staged identities.
    """
    if destination.exists() or destination.is_symlink() or destination.resolve().is_relative_to(root.resolve()):
        raise ValueError("archive must be a new path outside the overlay")
    manifest_bytes = (root / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes, object_pairs_hook=unique)
    validate_base(root, manifest["revision"], overlay=True)
    required = {"bin/trm06-gateway", "libexec/trm06-supervisor", "share/trm06/smithers-3f.pub"}
    required.update("share/trm06/" + name for name in FILES)
    entries = {entry["path"]: entry for entry in manifest["files"]}
    if not required.issubset(entries):
        raise ValueError("incomplete spike overlay")
    validate_gateway(root / "bin/trm06-gateway")
    validate_supervisor(root / "libexec/trm06-supervisor")
    if regular(root / "share/trm06/smithers-3f.pub").st_size != 32:
        raise ValueError("invalid reviewer key")
    # The publication tool is executable release input too. Read it from the
    # overlay's main commit; a dirty checkout must never select build code.
    revision = main_revision(repo, manifest["revision"])
    writer_bytes = subprocess.check_output([
        "git", "-C", str(repo), "show",
        revision + ":apps/app/scripts/deterministic-tar.py"])
    if not writer_bytes or len(writer_bytes) > 1024 * 1024:
        raise ValueError("invalid main-pinned archive writer")
    writer_sha = hashlib.sha256(writer_bytes).hexdigest()
    ancestry = destination_chain(destination.parent)
    parent = ancestry[-1]
    temporary = None
    staging = None
    checked_archive = None
    staging_info = None
    try:
        temporary = Path(tempfile.mkdtemp(prefix="trm06-archive-", dir=destination.parent))
        staging = os.open(temporary.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        staging_info = os.fstat(staging)
        archive = temporary / "overlay.tar.gz"
        writer = temporary / "deterministic-tar.py"
        writer.write_bytes(writer_bytes)
        subprocess.run([sys.executable, "-I", "-S", str(writer),
                        str(root), str(archive), "directory"], check=True)
        expected = set(entries) | {"manifest.json"}
        seen = set()
        fd = os.open("overlay.tar.gz", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=staging)
        checked_archive = os.fdopen(fd, "rb")
        artifact = os.fstat(checked_archive.fileno())
        if not stat.S_ISREG(artifact.st_mode) or artifact.st_nlink != 1:
            raise ValueError("invalid archive publication artifact")
        with tarfile.open(fileobj=checked_archive, mode="r:gz") as source:
            for member in source:
                if member.name not in expected or member.name in seen:
                    raise ValueError("archive contains unexpected artifact")
                seen.add(member.name)
                entry = entries.get(member.name)
                if member.issym():
                    if entry is None or member.linkname != entry.get("symlink"):
                        raise ValueError("archive symlink differs from manifest")
                elif member.isfile():
                    if entry is not None and "symlink" in entry:
                        raise ValueError("archive replaced declared symlink")
                    with source.extractfile(member) as contents:
                        actual = hashlib.file_digest(contents, "sha256").hexdigest()
                    wanted = entry["sha256"] if entry else hashlib.sha256(manifest_bytes).hexdigest()
                    if actual != wanted or member.mode != (entry["mode"] if entry else 0o644):
                        raise ValueError("archive bytes/mode differ from manifest")
                else:
                    raise ValueError("archive contains non-artifact entry")
        if seen != expected:
            raise ValueError("archive is missing artifacts")
        validate_base(root, manifest["revision"], overlay=True)
        # Exclusive publication refuses an output replacement; no existing
        # archive or symlink target is overwritten.
        # Hold the checked archive inode and both publication directories.
        # A preserved subtree move must refuse just like artifact assembly.
        checked_archive.seek(0)
        archive_sha = hashlib.file_digest(checked_archive, "sha256").hexdigest()
        same_destination(destination.parent, [temporary.name, "overlay.tar.gz"], staging,
                         artifact, ancestry + [staging])
        os.link("overlay.tar.gz", destination.name, src_dir_fd=staging,
                dst_dir_fd=parent, follow_symlinks=False)
        published = os.stat(destination.name, dir_fd=parent, follow_symlinks=False)
        try:
            # Recheck after link too: never return a receipt for a moved
            # parent or a replaced source between checking and linking.
            same_destination(destination.parent, [destination.name], parent,
                             artifact, ancestry, links=2)
        except BaseException:
            observed = os.stat(destination.name, dir_fd=parent, follow_symlinks=False)
            if (observed.st_dev, observed.st_ino) == (published.st_dev, published.st_ino):
                os.unlink(destination.name, dir_fd=parent)
            raise
        return {"revision": manifest["revision"], "sha256": archive_sha,
                "archive_writer_sha256": writer_sha,
                "activation": "refused-until-reviewed"}
    finally:
        if checked_archive is not None:
            checked_archive.close()
        # Descriptor-relative cleanup cannot follow a raced staging pathname.
        if staging is not None:
            try:
                os.unlink("overlay.tar.gz", dir_fd=staging)
            except FileNotFoundError:
                pass
            try:
                os.unlink("deterministic-tar.py", dir_fd=staging)
            except FileNotFoundError:
                pass
            os.close(staging)
        if temporary is not None and staging_info is not None:
            try:
                observed = os.stat(temporary.name, dir_fd=parent, follow_symlinks=False)
                if stat.S_ISDIR(observed.st_mode) and (observed.st_dev, observed.st_ino) == (staging_info.st_dev, staging_info.st_ino):
                    os.rmdir(temporary.name, dir_fd=parent)
            except FileNotFoundError:
                pass
        for descriptor in ancestry:
            os.close(descriptor)


def verify_reproducible(repo, output, revision=None, base=None, review_key=None):
    """Build twice in independent directories; compare produced bytes, not claims.

    With a real base/key this checks the complete release overlay and archive.
    Without them it retains release inputs only and explicitly refuses acceptance.
    """
    revision = main_revision(repo, revision)
    if (base is None) != (review_key is None):
        raise ValueError("complete overlay needs both base and reviewer key")
    if output.exists() or output.is_symlink():
        raise ValueError("reproducibility output must be new")
    output.mkdir()
    try:
        builds = []
        archives = []
        for name in ("first", "second"):
            directory = output / name
            if base is None:
                result = build_artifacts(repo, directory, revision)
                identities = {entry["path"]: (entry["mode"], entry["sha256"])
                              for entry in result["files"]}
            else:
                result = assemble(repo, base, directory, review_key, revision)
                manifest = validate_base(directory, revision, overlay=True)
                identities = {entry["path"]: (entry["mode"], entry["sha256"], entry.get("symlink"))
                              for entry in manifest["files"]}
                archives.append(archive_overlay(repo, directory, output / (name + ".tar.gz")))
            # Independently read the produced files; do not trust build receipts.
            for path, identity in identities.items():
                if digest(directory / path) != identity[1] or stat.S_IMODE((directory / path).stat().st_mode) != identity[0]:
                    raise ValueError("reproducibility artifact differs from receipt")
            builds.append((identities, result))
        if builds[0][0] != builds[1][0]:
            raise ValueError("independent release builds differ")
        if archives and archives[0]["sha256"] != archives[1]["sha256"]:
            raise ValueError("independent complete overlay archives differ")
        receipt = {"revision": revision, "status": "reproducible",
                   "kind": "complete-overlay" if base is not None else "release-inputs-only",
                   "activation": "refused-until-reviewed", "accepted": False,
                   "builds": [result for _, result in builds], "archives": archives}
        (output / "reproducibility.json").write_text(json.dumps(receipt, indent=2) + "\n")
        return receipt
    except BaseException as error:
        # Keep failure samples: a NO result is evidence too. No passing receipt.
        (output / "reproducibility-failure.json").write_text(json.dumps({
            "revision": revision, "status": "NO", "accepted": False,
            "failure": str(error)}) + "\n")
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--review-key", type=Path)
    parser.add_argument("--build-only", action="store_true", help="retain main release inputs without a base bundle or approval key")
    parser.add_argument("--revision", help="pin a full SHA already landed on origin/main")
    parser.add_argument("--archive", type=Path, help="publish a deterministic complete overlay archive")
    parser.add_argument("--verify-reproducible", action="store_true", help="build twice and retain independent artifact/archive comparisons")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    if args.verify_reproducible:
        if args.archive is not None or (args.build_only and (args.base is not None or args.review_key is not None)):
            parser.error("reproducibility manages its own archives; build-only excludes base/key")
        if not args.build_only and (args.base is None or args.review_key is None):
            parser.error("complete reproducibility requires --base and --review-key")
        result = verify_reproducible(repo, args.output.absolute(), args.revision, args.base, args.review_key)
    elif args.build_only:
        if args.base is not None or args.review_key is not None or args.archive is not None:
            parser.error("--build-only does not accept base, review key or archive")
        result = build_artifacts(repo, args.output.absolute(), args.revision)
    else:
        if args.base is None or args.review_key is None:
            parser.error("overlay requires --base and --review-key")
        result = assemble(repo, args.base.resolve(), args.output.absolute(), args.review_key, args.revision)
    if args.archive is not None:
        result["archive"] = archive_overlay(repo, args.output.absolute(), args.archive.absolute())
    print(json.dumps(result))
