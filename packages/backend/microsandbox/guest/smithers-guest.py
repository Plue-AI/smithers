#!/usr/bin/env python3
"""Guest side of the Smithers Microsandbox workspace adapter.

The backend plants this file at /opt/smithers/guest/smithers-guest.py and
reaches it only through `msb exec`. It holds no credentials. Subcommands:

  exec            run one command in its own cgroup as the workspace user;
                  the request is one JSON document on stdin (or --request FILE)
  kill ID         kill every process of one command cgroup
  kill-all        kill every command cgroup (backend restart recovery)
  fs read|write|list|remove ROOT PATH [ARG]
                  root-confined file operations as the workspace user
  relay PORT      bridge stdin/stdout to guest TCP 127.0.0.1:PORT
  bridge PORT HOST
                  listen on guest 127.0.0.1:PORT and forward to HOST:PORT
  setup USER UID  create the workspace user and adapter directories
"""

import json
import os
import pwd
import select
import signal
import socket
import stat
import sys
import threading
import time

CGROUP_ROOT = "/sys/fs/cgroup/smithers"
EXIT_TRAILER = b"\x00SMITHERS-EXIT %d\x00"
ENV_FILE = "/opt/smithers/env.json"
REQUEST_DIR = "/run/smithers/requests"
TOOL_HOME = "/var/cache/smithers/home"


def fail(code, message):
    sys.stderr.write("smithers-guest: %s\n" % message)
    sys.stderr.flush()
    sys.exit(code)


def valid_id(value):
    return 0 < len(value) <= 96 and all(c.isalnum() or c in "-_." for c in value) and not value.startswith(".")


def base_environment():
    try:
        with open(ENV_FILE, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        return {str(k): str(v) for k, v in loaded.items()}
    except FileNotFoundError:
        return {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}


def cgroup_kill(path):
    """Kill every process in a command cgroup, wait until it is empty, remove it."""
    if not os.path.isdir(path):
        return
    try:
        with open(os.path.join(path, "cgroup.kill"), "w") as handle:
            handle.write("1")
    except OSError:
        pass
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            with open(os.path.join(path, "cgroup.events"), "r") as handle:
                if "populated 0" in handle.read():
                    break
        except OSError:
            break
        time.sleep(0.02)
    try:
        os.rmdir(path)
    except OSError:
        pass


def drop_to(user):
    if user in ("", "root"):
        return None
    entry = pwd.getpwnam(user)
    os.setgroups([])
    os.setgid(entry.pw_gid)
    os.setuid(entry.pw_uid)
    return entry


def run_exec(request):
    exec_id = str(request.get("id", ""))
    argv = request.get("argv") or []
    if not valid_id(exec_id) or not argv or not all(isinstance(a, str) for a in argv):
        fail(125, "invalid exec request")
    env = base_environment()
    for key, value in (request.get("env") or {}).items():
        if not key or "=" in key or "\x00" in key or "\x00" in str(value):
            fail(125, "invalid environment variable %r" % key)
        env[key] = str(value)
    cwd = request.get("cwd") or "/"
    root = request.get("root")
    if root:
        real_root = os.path.realpath(root)
        resolved = os.path.realpath(cwd)
        if resolved != real_root and not resolved.startswith(real_root + "/"):
            fail(125, "command directory resolves outside the workspace root")
        if not os.path.isdir(resolved):
            fail(125, "command directory is not a directory")
        cwd = resolved
    user = request.get("user") or ""
    group = os.path.join(CGROUP_ROOT, exec_id)
    os.makedirs(group, exist_ok=True)

    child = os.fork()
    if child == 0:
        try:
            with open(os.path.join(group, "cgroup.procs"), "w") as handle:
                handle.write(str(os.getpid()))
            if request.get("stdin") != "inherit":
                null = os.open(os.devnull, os.O_RDONLY)
                os.dup2(null, 0)
                os.close(null)
            drop_to(user)
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        except FileNotFoundError as error:
            sys.stderr.write("smithers-guest: %s\n" % error)
            os._exit(127)
        except PermissionError as error:
            sys.stderr.write("smithers-guest: %s\n" % error)
            os._exit(126)
        except BaseException as error:  # noqa: BLE001 - the child must never return
            sys.stderr.write("smithers-guest: %s\n" % error)
            os._exit(126)

    def terminate(signum, _frame):
        cgroup_kill(group)
        os._exit(128 + signum)

    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, terminate)
    _, status = os.waitpid(child, 0)
    code = os.waitstatus_to_exitcode(status)
    if code < 0:
        code = 128 - code
    # Descendants may outlive the command or hold its pipes. The process
    # adapter reaps its process group after exit; a cgroup reaps escapees too.
    cgroup_kill(group)
    sys.stdout.flush()
    os.write(2, EXIT_TRAILER % code)
    return code


def resolve_inside(root, requested, allow_missing_leaf):
    """Mirror the process adapter: lexical checks, then symlinks resolved and confined."""
    if requested.startswith("/"):
        fail(3, "workspace path must be relative")
    parts = [p for p in requested.split("/") if p not in ("", ".")]
    if ".." in parts:
        fail(3, "workspace path escapes root")
    real_root = os.path.realpath(root)
    candidate = os.path.join(real_root, *parts) if parts else real_root
    if os.path.lexists(candidate):
        resolved = os.path.realpath(candidate)
    elif allow_missing_leaf:
        resolved = os.path.join(os.path.realpath(os.path.dirname(candidate)), os.path.basename(candidate))
    else:
        fail(2, "no such file or directory")
    if resolved != real_root and not resolved.startswith(real_root + "/"):
        fail(3, "workspace path resolves outside root")
    return real_root, parts, resolved


def fs_read(root, path, limit):
    _, parts, resolved = resolve_inside(root, path, False)
    if not parts:
        fail(3, "workspace root cannot be read as a file")
    try:
        fd = os.open(resolved, os.O_RDONLY | os.O_NONBLOCK)
    except FileNotFoundError:
        fail(2, "no such file or directory")
    info = os.fstat(fd)
    if stat.S_ISDIR(info.st_mode):
        fail(5, "workspace file is a directory")
    if not stat.S_ISREG(info.st_mode):
        fail(3, "workspace file is not a regular file")
    if info.st_size > limit:
        fail(4, "workspace file exceeds read limit of %d bytes" % limit)
    out = sys.stdout.buffer
    remaining = limit + 1
    while True:
        chunk = os.read(fd, min(1 << 20, remaining))
        if not chunk:
            break
        remaining -= len(chunk)
        if remaining <= 0:
            fail(4, "workspace file exceeds read limit of %d bytes" % limit)
        out.write(chunk)
    out.flush()


def ensure_parent(real_root, parts):
    current = real_root
    for component in parts[:-1]:
        current = os.path.join(current, component)
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            try:
                os.mkdir(current, 0o700)
            except FileExistsError:
                pass
            info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode):
            resolved = os.path.realpath(current)
            if resolved != real_root and not resolved.startswith(real_root + "/"):
                fail(3, "workspace mutation parent resolves outside root")
            current = resolved
        elif not stat.S_ISDIR(info.st_mode):
            fail(3, "workspace mutation parent is not a directory")


def fs_write(root, path, mode):
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if path.startswith("/") or not parts or ".." in parts:
        fail(3, "workspace mutation path escapes or replaces root")
    real_root = os.path.realpath(root)
    ensure_parent(real_root, parts)
    _, _, resolved = resolve_inside(root, path, True)
    if os.path.islink(os.path.join(real_root, *parts)):
        fail(3, "workspace mutation target is a symlink")
    directory = os.path.dirname(resolved)
    data = sys.stdin.buffer.read()
    for _ in range(16):
        temporary = os.path.join(directory, ".smithers-write-%s" % os.urandom(8).hex())
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            break
        except FileExistsError:
            continue
    else:
        fail(3, "could not create a temporary file")
    try:
        os.fchmod(fd, mode & 0o777)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
        os.close(fd)
        os.rename(temporary, resolved)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def fs_list(root, path):
    _, _, resolved = resolve_inside(root, path, False)
    if not os.path.isdir(resolved):
        fail(5, "workspace path is not a directory")
    entries = []
    for name in sorted(os.listdir(resolved)):
        info = os.lstat(os.path.join(resolved, name))
        entries.append({"name": name, "mode": info.st_mode, "size": info.st_size, "dir": stat.S_ISDIR(info.st_mode)})
    sys.stdout.write(json.dumps(entries))


def fs_remove(root, path):
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if path.startswith("/") or not parts or ".." in parts:
        fail(3, "workspace mutation path escapes or replaces root")
    real_root = os.path.realpath(root)
    parent = os.path.realpath(os.path.join(real_root, *parts[:-1])) if len(parts) > 1 else real_root
    if parent != real_root and not parent.startswith(real_root + "/"):
        fail(3, "workspace mutation path resolves outside root")
    target = os.path.join(parent, parts[-1])
    if os.path.islink(target) or os.path.isfile(target):
        os.unlink(target)
    elif os.path.isdir(target):
        import shutil

        shutil.rmtree(target)


def pump(source, sink):
    try:
        while True:
            data = source()
            if not data:
                break
            sink(data)
    except OSError:
        pass


def relay(port):
    connection = socket.create_connection(("127.0.0.1", port), timeout=10)
    connection.settimeout(None)
    stdin = sys.stdin.buffer.raw
    stdout = sys.stdout.buffer.raw

    def upstream():
        pump(lambda: stdin.read(65536), connection.sendall)
        try:
            connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    thread = threading.Thread(target=upstream, daemon=True)
    thread.start()
    pump(lambda: connection.recv(65536), stdout.write)
    connection.close()


def bridge(port, host):
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port))
    listener.listen(128)

    def serve(client):
        try:
            upstream = socket.create_connection((host, port), timeout=10)
            upstream.settimeout(None)
        except OSError:
            client.close()
            return

        def half(src, dst):
            pump(lambda: src.recv(65536), dst.sendall)
            try:
                dst.shutdown(socket.SHUT_WR)
            except OSError:
                pass

        threading.Thread(target=half, args=(client, upstream), daemon=True).start()
        half(upstream, client)
        client.close()
        upstream.close()

    while True:
        client, _ = listener.accept()
        threading.Thread(target=serve, args=(client,), daemon=True).start()


def setup(user, uid, directories):
    try:
        pwd.getpwnam(user)
    except KeyError:
        os.system("useradd --create-home --uid %d --shell /bin/bash %s >/dev/null 2>&1 || true" % (uid, user))
    entry = pwd.getpwnam(user)
    os.makedirs(CGROUP_ROOT, exist_ok=True)
    # Tools that download into $HOME on first run were run once in the
    # dependency layer with HOME at the shared tool home; link what they left.
    if os.path.isdir(TOOL_HOME):
        for name in os.listdir(TOOL_HOME):
            link = os.path.join(entry.pw_dir, name)
            if not os.path.lexists(link):
                os.symlink(os.path.join(TOOL_HOME, name), link)
                os.lchown(link, entry.pw_uid, entry.pw_gid)
    for directory in directories:
        os.makedirs(directory, exist_ok=True)
        os.chown(directory, entry.pw_uid, entry.pw_gid)
        os.chmod(directory, 0o755)


def main(args):
    if not args:
        fail(125, "missing subcommand")
    command = args[0]
    if command == "exec":
        if len(args) == 3 and args[1] == "--request" and valid_id(args[2]):
            path = os.path.join(REQUEST_DIR, args[2] + ".json")
            with open(path, "rb") as handle:
                request = json.load(handle)
            os.unlink(path)
        else:
            request = json.loads(sys.stdin.buffer.read())
        sys.exit(run_exec(request))
    if command == "put-request" and len(args) == 2 and valid_id(args[1]):
        os.makedirs(REQUEST_DIR, mode=0o700, exist_ok=True)
        path = os.path.join(REQUEST_DIR, args[1] + ".json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(sys.stdin.buffer.read())
        return
    if command == "probe" and len(args) == 2:
        try:
            socket.create_connection(("127.0.0.1", int(args[1])), timeout=2).close()
        except OSError:
            sys.exit(1)
        return
    if command == "kill" and len(args) == 2 and valid_id(args[1]):
        cgroup_kill(os.path.join(CGROUP_ROOT, args[1]))
        return
    if command == "kill-all":
        if os.path.isdir(CGROUP_ROOT):
            for name in os.listdir(CGROUP_ROOT):
                path = os.path.join(CGROUP_ROOT, name)
                if os.path.isdir(path):
                    cgroup_kill(path)
        return
    if command == "fs" and len(args) >= 4:
        user = os.environ.get("SMITHERS_GUEST_USER", "")
        drop_to(user)
        operation, root, path = args[1], args[2], args[3]
        if operation == "read":
            fs_read(root, path, int(args[4]))
        elif operation == "write":
            fs_write(root, path, int(args[4], 8))
        elif operation == "list":
            fs_list(root, path)
        elif operation == "remove":
            fs_remove(root, path)
        else:
            fail(125, "unknown fs operation")
        return
    if command == "relay" and len(args) == 2:
        relay(int(args[1]))
        return
    if command == "bridge" and len(args) == 3:
        bridge(int(args[1]), args[2])
        return
    if command == "setup" and len(args) >= 3:
        setup(args[1], int(args[2]), args[3:])
        return
    fail(125, "unknown subcommand %r" % command)


if __name__ == "__main__":
    main(sys.argv[1:])
