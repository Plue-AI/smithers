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


def trusted(info, directory=False):
    if info.st_uid != 0 or info.st_mode & 0o022 or (directory and not stat.S_ISDIR(info.st_mode)):
        raise ValueError("untrusted install object")


def open_protected(path):
    """Hold each no-follow ancestor while opening the validated object."""
    parts = Path(path).parts
    if not Path(path).is_absolute() or any(part in (".", "..") for part in parts):
        raise ValueError("invalid install path")
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        trusted(os.fstat(parent), True)
        for part in parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
            trusted(os.fstat(parent), True)
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            trusted(info)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("invalid install artifact")
            return fd
        except BaseException:
            os.close(fd)
            raise
    finally:
        os.close(parent)


def read_held(fd, limit):
    if os.fstat(fd).st_size > limit:
        raise ValueError("oversized artifact")
    os.lseek(fd, 0, os.SEEK_SET)
    data = bytearray()
    while chunk := os.read(fd, min(1024 * 1024, limit + 1 - len(data))):
        data.extend(chunk)
        if len(data) > limit:
            raise ValueError("oversized artifact")
    return bytes(data)


def execute_held(fd, argv):
    environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    if os.execve in os.supports_fd:
        os.execve(fd, argv, environment)
    elif sys.platform == "darwin":
        # Darwin exposes the held vnode through devfs. Keep the descriptor open
        # across exec; never fall back to the replaceable installation pathname.
        os.set_inheritable(fd, True)
        os.execve("/dev/fd/" + str(fd), argv, environment)
    else:
        raise ValueError("descriptor execution unavailable")


def main():
    root = protected(ROOT, True)
    own = protected(Path(__file__))
    if own != root / "share/trm06/launcher.py":
        raise ValueError("branch launcher")
    held = []
    paths = []
    try:
        manifest_fd = open_protected(root / "manifest.json")
        held.append(manifest_fd)
        paths.append(root / "manifest.json")
        manifest = json.loads(read_held(manifest_fd, 16 * 1024 * 1024), object_pairs_hook=unique)
        revision = manifest["revision"]
        if manifest["version"] != 1 or manifest["platform"] != "darwin-arm64" or len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
            raise ValueError("invalid manifest")
        entries = {}
        for entry in manifest["files"]:
            relative = entry["path"]
            if relative in entries or relative.startswith("/") or any(p in ("", ".", "..") for p in relative.split("/")):
                raise ValueError("invalid artifact")
            entries[relative] = entry
        gateway = None
        for relative in ("share/trm06/launcher.py", "share/trm06/run.sh", "share/trm06/revoke.sh", "share/trm06/flow.sh", "bin/trm06-gateway"):
            entry = entries[relative]
            fd = open_protected(root / relative)
            held.append(fd)
            paths.append(root / relative)
            info = os.fstat(fd)
            if stat.S_IMODE(info.st_mode) != entry["mode"] or hashlib.sha256(read_held(fd, 64 * 1024 * 1024)).hexdigest() != entry["sha256"]:
                raise ValueError("replaced artifact")
            if relative == "bin/trm06-gateway":
                gateway = fd
        operation = sys.argv[1] if len(sys.argv) == 2 else ""
        if operation not in ("run", "revoke", "flow", "measure", "check-install", "check-session"):
            raise ValueError("invalid operation")
        # Refuse replacements already visible before exec. The held executable
        # also prevents a final post-check replacement selecting other bytes.
        for path, fd in zip(paths, held):
            current = open_protected(path)
            try:
                expected, observed = os.fstat(fd), os.fstat(current)
                if (expected.st_dev, expected.st_ino) != (observed.st_dev, observed.st_ino):
                    raise ValueError("replaced install object")
            finally:
                os.close(current)
        os.chdir("/")
        execute_held(gateway, [str(root / "bin/trm06-gateway"), operation])
    finally:
        for fd in held:
            os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"class":"unavailable","code":"prototype_authority_unavailable","check":"C-SPK-08"}', file=sys.stderr)
        sys.exit(78)
