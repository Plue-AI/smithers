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


def linked(parent, name, held):
    """Refuse a detached/replaced install inode before privileged startup."""
    current = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
    try:
        expected = os.fstat(held)
        actual = os.fstat(current)
        if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
            refuse()
        if actual.st_uid != 0 or actual.st_mode & 0o022:
            refuse()
    finally:
        os.close(current)


def verified_file(parent, name, expected, mode):
    """Hold only bounded regular installed bytes, never a FIFO/device."""
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
    try:
        verify_bytes(fd, expected, mode)
        return fd
    except BaseException:
        os.close(fd)
        raise


def verify_bytes(fd, expected, mode):
    before = os.fstat(fd)
    if (before.st_uid != 0 or before.st_nlink != 1 or not stat.S_ISREG(before.st_mode)
            or stat.S_IMODE(before.st_mode) != mode or before.st_size != len(expected)):
        refuse()
    os.lseek(fd, 0, os.SEEK_SET)
    data = bytearray()
    while len(data) <= len(expected):
        chunk = os.read(fd, min(1024 * 1024, len(expected) + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
    after = os.fstat(fd)
    identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid,
                              value.st_gid, value.st_nlink, value.st_size,
                              value.st_mtime_ns, value.st_ctime_ns)
    if bytes(data) != expected or identity(before) != identity(after):
        refuse()


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
        boot_bytes = json.dumps(boot, separators=(",", ":")).encode()
        fresh_file(state, "boot.json", boot_bytes, 0o400)
        fd = verified_file(prototype, "supervisor", binary, 0o755)
        held.append(fd)
        boot_fd = verified_file(state, "boot.json", boot_bytes, 0o400)
        held.append(boot_fd)
        # Reopen every link through its held parent. A renamed ancestor must
        # not leave an init running against a different absolute boot path.
        for parent, name, child in [(root, "opt", opt), (opt, "smithers", smithers),
                                    (root, "run", run), (run, "smithers", runtime),
                                    (smithers, "prototype", prototype), (runtime, "trm06", state),
                                    (prototype, "supervisor", fd), (state, "boot.json", boot_fd)]:
            linked(parent, name, child)
        # Recheck contents as well as links: truncate/write/chmod can retain
        # the inode observed above. Only these held installed bytes may launch.
        verify_bytes(fd, binary, 0o755)
        verify_bytes(boot_fd, boot_bytes, 0o400)
        logfd = os.open("init.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=state)
        with os.fdopen(logfd, "wb") as log:
            # Keep the verified inode through exec. The literal fixed descriptor
            # path is generated here, never from member/branch input.
            process = subprocess.Popen(["/opt/smithers/prototype/supervisor", "--init"], executable="/proc/self/fd/" + str(fd), pass_fds=(fd,), stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd="/", env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}, start_new_session=True)
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
