"""Embedded in main-built shell entries, before evaluating launcher bytes.

The assembler replaces the digest literal from the same main source archive.
This file is build input, never a separately imported runtime authority.
"""
import hashlib
import os
import stat
import sys


def main():
    path = "/usr/local/lib/smithers/current/share/trm06/launcher.py"
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in path.split("/")[1:-1]:
            info = os.fstat(parent)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError("untrusted launcher ancestor")
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        info = os.fstat(parent)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("untrusted launcher parent")
        fd = os.open("launcher.py", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(fd)
            if (before.st_uid != 0 or not stat.S_ISREG(before.st_mode)
                    or stat.S_IMODE(before.st_mode) != 0o644 or before.st_nlink != 1
                    or not 0 < before.st_size <= 65536):
                raise ValueError("untrusted launcher")
            with os.fdopen(os.dup(fd), "rb") as source:
                body = source.read(65537)
            after = os.fstat(fd)
            identity = lambda info: (info.st_dev, info.st_ino, info.st_mode,
                                      info.st_uid, info.st_gid, info.st_nlink,
                                      info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            if (identity(before) != identity(after)
                    or hashlib.sha256(body).hexdigest() != "@TRM06_LAUNCHER_SHA256@"):
                raise ValueError("replaced launcher")
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    # Evaluate only the held, hashed bytes. Reopening the pathname would undo
    # the check when a replacement arrives between validation and evaluation.
    sys.argv = [path] + sys.argv[1:]
    exec(compile(body, path, "exec"), {
        "__name__": "__main__", "__file__": path,
        "PINNED_GATEWAY_SHA256": "@TRM06_GATEWAY_SHA256@",
        "PINNED_REVISION": "@TRM06_REVISION@",
    })


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"class":"unavailable","code":"prototype_authority_unavailable","check":"C-SPK-08"}', file=sys.stderr)
        sys.exit(78)
