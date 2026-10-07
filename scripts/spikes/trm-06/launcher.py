"""Main-pinned installed shell/Python launcher; never an authority from a checkout.

Invoke the installed share/trm06/run.sh. Only the fixed system installation is
eligible. The gateway is checked before exec, then verifies signed security
approval independently before any VM/root/listener effects.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

ROOT = Path("/usr/local/lib/smithers/current")


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


def protected(path, directory=False):
    path = path.resolve(strict=True)
    # The system install's activation paths are root owned. The running owner
    # can configure host state, but cannot promote a branch build into this tree.
    for ancestor in reversed(path.parents):
        info = ancestor.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("untrusted install parent")
    info = path.stat()
    if info.st_uid != 0 or info.st_mode & 0o022 or (directory and not stat.S_ISDIR(info.st_mode)):
        raise ValueError("untrusted install")
    return path


def main():
    root = protected(ROOT, True)
    own = protected(Path(__file__))
    if own != root / "share/trm06/launcher.py":
        raise ValueError("branch launcher")
    manifest_path = protected(root / "manifest.json")
    if manifest_path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("oversized manifest")
    manifest = json.loads(manifest_path.read_bytes(), object_pairs_hook=unique)
    revision = manifest["revision"]
    if manifest["version"] != 1 or manifest["platform"] != "darwin-arm64" or len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("invalid manifest")
    entries = {}
    for entry in manifest["files"]:
        relative = entry["path"]
        if relative in entries or relative.startswith("/") or any(p in ("", ".", "..") for p in relative.split("/")):
            raise ValueError("invalid artifact")
        entries[relative] = entry
    for relative in ("share/trm06/launcher.py", "share/trm06/run.sh", "share/trm06/revoke.sh", "share/trm06/flow.sh", "bin/trm06-gateway"):
        entry = entries[relative]
        file = protected(root / relative)
        if file != root / relative:
            raise ValueError("symlink artifact")
        info = file.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 64 * 1024 * 1024 or stat.S_IMODE(info.st_mode) != entry["mode"] or hashlib.sha256(file.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError("replaced artifact")
    operation = sys.argv[1] if len(sys.argv) == 2 else ""
    if operation not in ("run", "revoke"):
        raise ValueError("invalid operation")
    os.chdir("/")
    os.execve(str(root / "bin/trm06-gateway"), [str(root / "bin/trm06-gateway"), operation], {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"class":"unavailable","code":"prototype_authority_unavailable","check":"C-SPK-08"}', file=sys.stderr)
        sys.exit(78)
