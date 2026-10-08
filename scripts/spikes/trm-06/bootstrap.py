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
    ancestors = [os.dup(parent)]
    try:
        for name in path.split("/")[1:-1]:
            info = os.fstat(parent)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError("untrusted launcher ancestor")
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
            ancestors.append(os.dup(parent))
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
            # A retained launcher inode is insufficient when its validated
            # install ancestry has been detached. Reopen the fixed path without
            # following links and compare every held ancestor before evaluation.
            current = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                names = [None] + path.split("/")[1:-1]
                for name, original in zip(names, ancestors):
                    if name is not None:
                        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                        os.close(current)
                        current = child
                    held, observed = os.fstat(original), os.fstat(current)
                    if (held.st_dev, held.st_ino) != (observed.st_dev, observed.st_ino):
                        raise ValueError("replaced launcher ancestor")
                    for info in (held, observed):
                        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                            raise ValueError("untrusted launcher ancestor")
                observed = os.stat("launcher.py", dir_fd=current, follow_symlinks=False)
                if identity(after) != identity(observed):
                    raise ValueError("replaced launcher")
            finally:
                os.close(current)
        finally:
            os.close(fd)
    finally:
        os.close(parent)
        for descriptor in ancestors:
            os.close(descriptor)
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
