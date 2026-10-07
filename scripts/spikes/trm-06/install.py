"""Installed-bundle-only fresh guest installer. No branch code or root shell.

The host verifies signed approval and supplies reviewed bundle bytes over stdin.
This script is read from that same pinned bundle, never from the checkout.
"""
import base64
import hashlib
import json
import os
import stat
import subprocess
import sys


def refuse():
    raise ValueError("prototype_authority_unavailable")


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            refuse()
        result[key] = value
    return result


def directory(parent, name, create=False):
    if create:
        try:
            os.mkdir(name, 0o755, dir_fd=parent)
        except FileExistsError:
            pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    info = os.fstat(fd)
    if info.st_uid != 0 or info.st_mode & 0o022:
        os.close(fd)
        refuse()
    return fd


def fresh_file(parent, name, contents, mode):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=parent)
    try:
        with os.fdopen(fd, "wb", closefd=False) as output:
            output.write(contents)
            output.flush()
            os.fsync(fd)
        os.fchmod(fd, mode)
    finally:
        os.close(fd)


def install():
    # Refuse before parsing member/branch bytes or touching a destination.
    if os.getuid() != 0 or os.geteuid() != 0:
        refuse()
    request = json.loads(sys.stdin.buffer.read(90 * 1024 * 1024 + 1), object_pairs_hook=unique)
    if set(request) != {"supervisor", "sha256", "boot"}:
        refuse()
    binary = base64.b64decode(request["supervisor"], validate=True)
    if not 0 < len(binary) <= 64 * 1024 * 1024 or hashlib.sha256(binary).hexdigest() != request["sha256"]:
        refuse()
    boot = request["boot"]
    if set(boot) != {"revision", "supervisor_sha256", "boot", "secret"} or boot["supervisor_sha256"] != request["sha256"]:
        refuse()
    if len(boot["revision"]) != 40 or any(c not in "0123456789abcdef" for c in boot["revision"]):
        refuse()
    for key, count in [("boot", 16), ("secret", 32)]:
        if not isinstance(boot[key], list) or len(boot[key]) != count or not any(boot[key]) or any(type(b) is not int or not 0 <= b <= 255 for b in boot[key]):
            refuse()
    held = []
    try:
        root = directory(None, "/")
        held.append(root)
        opt = directory(root, "opt")
        held.append(opt)
        smithers = directory(opt, "smithers", True)
        held.append(smithers)
        run = directory(root, "run")
        held.append(run)
        runtime = directory(run, "smithers", True)
        held.append(runtime)
        # Both destinations must be absent before the first file is written.
        # Never upgrade or repair retained/member state in this fresh probe.
        for parent, name in [(smithers, "prototype"), (runtime, "trm06")]:
            try:
                os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                refuse()
        os.mkdir("prototype", 0o755, dir_fd=smithers)
        prototype = directory(smithers, "prototype")
        held.append(prototype)
        os.mkdir("trm06", 0o700, dir_fd=runtime)
        state = directory(runtime, "trm06")
        held.append(state)
        fresh_file(prototype, "supervisor", binary, 0o755)
        fresh_file(state, "boot.json", json.dumps(boot, separators=(",", ":")).encode(), 0o400)
        # Re-read via held descriptors before executing. Untrusted parents are
        # never traversed by a privileged repair/rename or recursive chown.
        fd = os.open("supervisor", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=prototype)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o755 or hashlib.sha256(source.read()).hexdigest() != request["sha256"]:
                refuse()
        logfd = os.open("init.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=state)
        with os.fdopen(logfd, "wb") as log:
            process = subprocess.Popen(["/opt/smithers/prototype/supervisor", "--init"], stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd="/", env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}, start_new_session=True)
        fresh_file(state, "init.pid", str(process.pid).encode(), 0o400)
        print(json.dumps({"installed": True, "init_pid": process.pid, "sha256": request["sha256"], "revision": boot["revision"]}))
    finally:
        for fd in reversed(held):
            os.close(fd)


if __name__ == "__main__":
    try:
        install()
    except Exception:
        # Never print request/boot/key bytes or potentially tainted exception text.
        print('{"class":"unavailable","code":"prototype_authority_unavailable"}', file=sys.stderr)
        sys.exit(78)
