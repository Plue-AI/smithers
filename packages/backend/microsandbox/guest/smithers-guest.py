#!/usr/bin/env python3
"""Guest side of the Smithers Microsandbox workspace adapter.

The backend plants this file at /opt/smithers/guest/smithers-guest.py and
reaches it only through `msb exec`. It holds no credentials. Subcommands:

  exec            run one command in its own cgroup as the workspace user;
                  the request is one JSON document on stdin (or --request FILE)
  root-recipe DIGEST run only a binary-pinned system recipe as root
  kill ID         kill every process of one command cgroup
  kill-all        kill every command cgroup (backend restart recovery)
  fs USER read|write|list|remove ROOT PATH [ARG]
                  root-confined file operations as the workspace user
  relay PORT      bridge stdin/stdout to guest TCP 127.0.0.1:PORT
  bridge PORT HOST
                  listen on guest 127.0.0.1:PORT and forward to HOST:PORT
  setup USER UID  create the workspace user and adapter directories
  put-env         atomically replace the literal tmpfs team environment
  coding-binding  atomically install the fixed root-owned source binding
  coding-helper   atomically install the packaged Linux arm64 helper
  coding-helper-check verify the fixed helper's digest and root ownership
"""

import ctypes
import grp
import hashlib
import grp
import json
import os
import pwd
import re
import secrets
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
SECRET_ENV_DIR = "/run/smithers"
SECRET_ENV_LIMIT = 1 << 20
REQUEST_DIR = "/run/smithers/requests"
TOOL_HOME = "/var/cache/smithers/home"
ROOT_UID = 0


def fail(code, message):
    sys.stderr.write("smithers-guest: %s\n" % message)
    sys.stderr.flush()
    sys.exit(code)


def valid_id(value):
    return isinstance(value, str) and value.isascii() and 0 < len(value) <= 96 and all(c.isalnum() or c in "-_." for c in value) and not value.startswith(".")


def base_environment():
    try:
        fd = os.open(ENV_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                fail(3, "environment is not regular")
            body = handle.read(65537)
        if len(body) > 65536:
            fail(3, "environment exceeds limit")
        loaded = json.loads(body)
        allowed = set(HOME_LINKS) | set(GO_SETTINGS) | {"PATH", "PYTHONPATH", "HOME", "USER", "npm_config_cache", "YARN_CACHE_FOLDER", "BUN_INSTALL_CACHE_DIR", "UV_CACHE_DIR", "PIP_CACHE_DIR", "npm_config_store_dir", "UV_PYTHON_DOWNLOADS", "PIP_FIND_LINKS", "PIP_TARGET", "RUSTUP_HOME", "COREPACK_ENABLE_DOWNLOAD_PROMPT", "CI", "LANG"}
        if not isinstance(loaded, dict) or set(loaded) - allowed:
            fail(3, "invalid environment keys")
        if any(not isinstance(v, str) or "\x00" in v or "\n" in v or len(v) > 4096 for v in loaded.values()):
            fail(3, "invalid environment values")
        for name in HOME_LINKS:
            if name in loaded and (not loaded[name].startswith(("/var/cache/smithers/", "/opt/smithers/")) or ".." in loaded[name].split("/")):
                fail(3, "invalid cache target")
        return loaded
    except FileNotFoundError:
        return {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}


def secret_environment(body):
    """Bounded literal JSON, never shell input; also used by the session loader."""
    def unique(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                fail(3, "duplicate secret environment key")
            result[name] = value
        return result
    if len(body) > SECRET_ENV_LIMIT:
        fail(3, "secret environment exceeds limit")
    try:
        loaded = json.loads(body, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        fail(3, "invalid secret environment JSON")
    if not isinstance(loaded, dict) or len(loaded) > 1000:
        fail(3, "invalid secret environment")
    for name, value in loaded.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) or not isinstance(value, str) or "\x00" in value:
            fail(3, "invalid secret environment entry")
    return loaded


def require_secret_tmpfs(fd):
    # Linux fstatfs writes struct statfs; a generously sized aligned buffer
    # avoids depending on libc's remaining layout. Its first long is f_type.
    if sys.platform != "linux":
        fail(3, "secret environment requires Linux tmpfs")
    buffer = (ctypes.c_long * 32)()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.fstatfs(fd, ctypes.byref(buffer)) != 0 or buffer[0] != 0x01021994:
        fail(3, "secret environment requires tmpfs")


def secret_team():
    team = grp.getgrnam("team")
    if team.gr_gid != 20000:
        fail(3, "assigned team group is unavailable")
    return team.gr_gid


def put_secret_environment(body):
    """The only env writer, dormant until an authenticated installed caller exists."""
    if os.geteuid() != 0:
        fail(3, "secret environment writer requires broker")
    secret_environment(body)  # validate all data before privileged filesystem work
    gid = secret_team()
    run = safe_directory("/run", trusted=True, create=False)
    try:
        require_secret_tmpfs(run)
    finally:
        os.close(run)
    parent = safe_directory(SECRET_ENV_DIR, trusted=True)
    temporary = ".env-" + secrets.token_hex(16)
    created = False
    try:
        require_secret_tmpfs(parent)
        try:
            info = os.stat("env", dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o640 or info.st_nlink != 1:
                fail(3, "untrusted secret environment destination")
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        created = True
        with os.fdopen(fd, "wb") as handle:
            os.fchown(handle.fileno(), 0, gid)
            os.fchmod(handle.fileno(), 0o640)
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, "env", src_dir_fd=parent, dst_dir_fd=parent)
        created = False
        os.fsync(parent)
    finally:
        if created:
            os.unlink(temporary, dir_fd=parent)
        os.close(parent)


def load_secret_environment():
    # This function must never contribute secrets to a root helper environment.
    if os.geteuid() == 0:
        fail(3, "secret environment requires identity drop")
    try:
        parent = safe_directory(SECRET_ENV_DIR, trusted=True, create=False)
    except FileNotFoundError:
        return {}
    try:
        try:
            fd = os.open("env", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            return {}
        with os.fdopen(fd, "rb") as handle:
            gid = secret_team()
            if os.geteuid() < 19999 or gid not in [os.getegid()] + os.getgroups():
                fail(3, "assigned session identity is unavailable")
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o640 or info.st_nlink != 1:
                fail(3, "untrusted secret environment")
            require_secret_tmpfs(handle.fileno())
            return secret_environment(handle.read(SECRET_ENV_LIMIT + 1))
    finally:
        os.close(parent)


def cgroup_kill(path):
    """Only fixed root-owned cgroups can be addressed, through held descriptors."""
    name = os.path.basename(path)
    if os.path.dirname(path) != CGROUP_ROOT or not valid_id(name):
        fail(3, "invalid cgroup path")
    try:
        parent = safe_directory(CGROUP_ROOT, trusted=True, create=False)
    except FileNotFoundError:
        return
    group = None
    try:
        try:
            group = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        except FileNotFoundError:
            return
        info = os.fstat(group)
        if info.st_uid != ROOT_UID or info.st_mode & 0o022:
            fail(3, "untrusted command cgroup")
        try:
            fd = os.open("cgroup.kill", os.O_WRONLY | os.O_NOFOLLOW, dir_fd=group)
            with os.fdopen(fd, "w") as handle:
                handle.write("1")
        except OSError:
            pass
        deadline = time.monotonic() + 10
        while True:
            try:
                fd = os.open("cgroup.events", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=group)
                with os.fdopen(fd, "r") as handle:
                    if "populated 0" in handle.read(4096):
                        break
            except OSError as error:
                raise RuntimeError("command cgroup termination could not be confirmed") from error
            if time.monotonic() >= deadline:
                raise RuntimeError("command cgroup remains populated after cancellation")
            time.sleep(0.02)
        try:
            os.rmdir(name, dir_fd=parent)
        except OSError:
            pass
    finally:
        if group is not None:
            os.close(group)
        os.close(parent)


def assigned_identity(user, uid=None):
    if not isinstance(user, str) or not re.fullmatch(r"[a-z0-9_-]{1,32}", user):
        fail(125, "invalid guest identity")
    if user in ("root", "machined"):
        fail(125, "reserved guest identity")
    entry = pwd.getpwnam(user)
    if user == "agent" and uid is not None and uid != 19999:
        fail(125, "invalid agent binding")
    expected = 19999 if user == "agent" else uid
    if (type(expected) is not int or (user != "agent" and not 20000 <= expected <= 2147483647)
            or entry.pw_uid != expected or entry.pw_gid != expected
            or entry.pw_dir != "/home/" + user or entry.pw_shell != "/bin/bash"):
        fail(125, "invalid guest account")
    team = grp.getgrnam("team")
    if team.gr_gid != 20000 or user not in team.gr_mem:
        fail(125, "invalid team binding")
    if any(group.gr_gid != 20000 and user in group.gr_mem for group in grp.getgrall()):
        fail(125, "unexpected supplementary group")
    return entry


def drop_to(user, uid=None):
    entry = assigned_identity(user, uid)
    if os.geteuid() == entry.pw_uid:
        if os.getegid() != entry.pw_gid or os.getgroups() != [20000]:
            fail(125, "invalid guest groups")
        return entry
    os.setgroups([20000])
    os.setgid(entry.pw_gid)
    os.setuid(entry.pw_uid)
    return entry


def run_exec(request):
    if not isinstance(request, dict) or set(request) - {"id", "user", "argv", "env", "cwd", "root", "stdin", "payload"}:
        fail(125, "invalid exec envelope")
    exec_id = request.get("id", "")
    if not valid_id(exec_id) or request.get("user") != "agent":
        fail(125, "invalid exec envelope")
    user = "agent"
    group = os.path.join(CGROUP_ROOT, exec_id)
    group_fd = safe_directory(group, trusted=True)

    child = os.fork()
    if child == 0:
        try:
            fd = os.open("cgroup.procs", os.O_WRONLY | os.O_NOFOLLOW, dir_fd=group_fd)
            with os.fdopen(fd, "w") as handle:
                handle.write(str(os.getpid()))
            os.close(group_fd)
            drop_to(user)
            os.umask(0o002)
            if "payload" in request:
                request = read_request(request["payload"])
                if not isinstance(request, dict) or set(request) - {"id", "user", "argv", "env", "cwd", "root", "stdin"} or request.get("id") != exec_id or request.get("user") != user:
                    fail(125, "invalid exec payload")
            if request.get("stdin") != "inherit":
                null = os.open(os.devnull, os.O_RDONLY)
                os.dup2(null, 0)
                os.close(null)
            argv = request.get("argv") or []
            if not argv or not all(isinstance(a, str) for a in argv):
                fail(125, "invalid exec request")
            env = base_environment()
            env.update(load_secret_environment())
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

    os.close(group_fd)

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


def run_root_recipe(digest, request):
    pins = globals().get("ROOT_RECIPE_DIGESTS", {})
    kind = pins.get(digest)
    if kind not in ("sync", "toolchain") or not isinstance(request, dict):
        fail(125, "unapproved root recipe digest")
    script = request.get("script")
    if not isinstance(script, str) or hashlib.sha256(script.encode()).hexdigest() != digest:
        fail(125, "root recipe digest mismatch")
    argv = ["/bin/bash", "-c", script, "root-recipe"]
    if kind == "sync":
        if set(request) != {"script"}:
            fail(125, "invalid system envelope")
    elif kind == "toolchain":
        if set(request) != {"script", "toolchain"}:
            fail(125, "invalid toolchain envelope")
        data = request["toolchain"]
        if not isinstance(data, dict) or set(data) != {"packages", "postgres", "environment"}:
            fail(125, "invalid toolchain inputs")
        packages = data["packages"]
        if packages is None:
            packages = []
        if not isinstance(packages, list) or len(packages) > 64 or any(
                not isinstance(p, str) or not re.fullmatch(r"[a-z0-9][a-z0-9+.-]{0,127}", p) for p in packages):
            fail(125, "invalid toolchain packages")
        postgres = data["postgres"]
        if not isinstance(postgres, str) or (postgres and not re.fullmatch(r"[0-9]{1,2}", postgres)):
            fail(125, "invalid toolchain postgres")
        environment = data["environment"]
        allowed = {"PATH", "GOTOOLCHAIN", "GOPROXY", "GOFLAGS", "GOMODCACHE", "GOCACHE",
            "RUSTUP_HOME", "CARGO_HOME", "pnpm_config_store_dir", "pnpm_config_cache_dir",
            "PLAYWRIGHT_BROWSERS_PATH", "npm_config_store_dir", "npm_config_cache", "YARN_CACHE_FOLDER",
            "BUN_INSTALL_CACHE_DIR", "UV_CACHE_DIR", "UV_PYTHON_DOWNLOADS", "PIP_CACHE_DIR",
            "PIP_FIND_LINKS", "PIP_TARGET", "PYTHONPATH", "COREPACK_ENABLE_DOWNLOAD_PROMPT",
            "CI", "LANG", "DPRINT_CACHE_DIR"}
        if not isinstance(environment, dict) or set(environment) != allowed or any(
                not isinstance(v, str) or len(v) > 4096 or any(ord(c) < 32 for c in v)
                for v in environment.values()):
            fail(125, "invalid toolchain environment")
        argv.extend([postgres, json.dumps(environment), *packages])
    if os.geteuid() != 0:
        fail(125, "root recipe requires root")
    import subprocess
    # Never merge the agent-writable env.json or request environment.
    result = subprocess.run(argv, cwd="/", env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/root", "TMPDIR": "/var/tmp", "DEBIAN_FRONTEND": "noninteractive",
        "PYTHONPATH": ""})
    sys.stdout.flush()
    os.write(2, EXIT_TRAILER % result.returncode)
    return result.returncode


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
    try:
        mode = os.lstat(target).st_mode
    except (FileNotFoundError, NotADirectoryError):
        fail(2, "no such file or directory")
    try:
        if stat.S_ISDIR(mode):
            import shutil

            shutil.rmtree(target)
        else:
            os.unlink(target)
    except FileNotFoundError:
        fail(2, "no such file or directory")


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
    if not 1 <= port <= 65535:
        fail(3, "invalid relay port")
    drop_to("agent")
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
    if host != "host.microsandbox.internal" or not 1 <= port <= 65535:
        fail(3, "invalid bridge endpoint")
    drop_to("agent")
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


def sanitize_system_image():
    # Only immutable image directories are inspected, never /home, /workspace
    # or member-written caches. Debian's /bin, /sbin and /lib point into /usr.
    def strip(parent):
        for name in os.listdir(parent):
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                if name in ("sudo", "su", "sshd"):
                    os.unlink(name, dir_fd=parent)
                continue
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    current = os.fstat(child)
                    if current.st_uid != ROOT_UID or current.st_mode & 0o022:
                        fail(3, "untrusted system image directory")
                    strip(child)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    current = os.fstat(fd)
                    if not stat.S_ISREG(current.st_mode) or current.st_uid != ROOT_UID:
                        fail(3, "untrusted system image file")
                    if name in ("sudo", "su", "sshd"):
                        os.unlink(name, dir_fd=parent)
                    else:
                        os.fchmod(fd, stat.S_IMODE(current.st_mode) & ~0o6000)
                        if "security.capability" in os.listxattr(fd):
                            os.removexattr(fd, "security.capability")
                finally:
                    os.close(fd)
    parent = safe_directory("/usr", trusted=True, create=False)
    try:
        strip(parent)
    finally:
        os.close(parent)


def configure_shared_git():
    parent = safe_directory("/etc", trusted=True, create=False)
    try:
        fd = os.open("gitconfig", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                     0o644, dir_fd=parent)
        with os.fdopen(fd, "wb") as handle:
            info = os.fstat(handle.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != ROOT_UID
                    or info.st_nlink != 1 or info.st_mode & 0o022):
                fail(3, "untrusted system git config")
            handle.truncate(0)
            handle.write(b"[safe]\n\tdirectory = /workspace\n")
            handle.flush()
            os.fchmod(handle.fileno(), 0o644)
    finally:
        os.close(parent)


def prepare_system_identity():
    # Fixed image-owned records only; no roster or repository input is consumed.
    import subprocess
    try:
        entry = pwd.getpwnam("machined")
    except KeyError:
        try:
            pwd.getpwuid(19998)
        except KeyError:
            pass
        else:
            fail(3, "reserved daemon uid already exists")
        subprocess.run(["/usr/sbin/useradd", "--uid", "19998", "--gid", "team",
                        "--no-user-group", "--no-create-home", "--home-dir", "/nonexistent",
                        "--shell", "/usr/sbin/nologin", "--", "machined"], check=True,
                       env={"PATH": "/usr/bin:/bin"})
        entry = pwd.getpwnam("machined")
    if (entry.pw_uid != 19998 or entry.pw_gid != 20000 or entry.pw_dir != "/nonexistent"
            or entry.pw_shell != "/usr/sbin/nologin"
            or any(group.gr_gid != 20000 and "machined" in group.gr_mem for group in grp.getgrall())):
        fail(3, "invalid daemon account")


def setup(user, uid, directories):
    # Only the host's allocated identity may reach this function. The public
    # setup command remains agent-only until roster and broker receipts exist.
    if (not isinstance(user, str) or not re.fullmatch(r"[a-z0-9_-]{1,32}", user)
            or user in ("root", "machined") or type(uid) is not int
            or (uid != 19999 if user == "agent" else not 20000 <= uid <= 2147483647)):
        fail(3, "invalid setup identity")
    home = "/home/" + user
    allowed = ("/workspace", home, "/var/lib/smithers/state", "/var/tmp/smithers", "/var/cache/smithers") if user == "agent" else (home,)
    if any(path not in allowed for path in directories):
        fail(3, "invalid setup destination")
    import subprocess
    environment = {"PATH": "/usr/bin:/bin"}
    try:
        team = grp.getgrnam("team")
    except KeyError:
        subprocess.run(["/usr/sbin/groupadd", "--gid", "20000", "team"], check=True, env=environment)
        team = grp.getgrnam("team")
    if team.gr_gid != 20000:
        fail(3, "invalid team group")
    if user == "agent":
        sanitize_system_image()
        configure_shared_git()
        prepare_system_identity()
    try:
        entry = pwd.getpwnam(user)
    except KeyError:
        try:
            pwd.getpwuid(uid)
        except KeyError:
            pass
        else:
            fail(3, "allocated uid already exists")
        # Parent ownership is checked before useradd can address the home.
        parent = safe_directory("/home", trusted=True)
        os.close(parent)
        subprocess.run(["/usr/sbin/useradd", "--uid", str(uid), "--user-group",
                        "--groups", "team", "--no-create-home", "--home-dir", home,
                        "--shell", "/bin/bash", "--", user], check=True, env=environment)
        entry = pwd.getpwnam(user)
    entry = assigned_identity(user, uid)
    parent = safe_directory("/home", trusted=True)
    try:
        created = False
        try:
            os.mkdir(user, 0o700, dir_fd=parent)
            created = True
        except FileExistsError:
            pass
        home_fd = os.open(user, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            info = os.fstat(home_fd)
            if not created and (info.st_uid != uid or info.st_gid != uid):
                fail(3, "retained home account mismatch")
            if created:
                os.fchown(home_fd, uid, uid)
            os.fchmod(home_fd, 0o700)
        finally:
            os.close(home_fd)
    finally:
        os.close(parent)
    if user != "agent":
        return
    cgroup_fd = safe_directory(CGROUP_ROOT, trusted=True)
    os.close(cgroup_fd)
    for directory in directories:
        if directory == home:
            continue
        fd = safe_directory(directory)
        try:
            if directory == "/workspace":
                os.fchown(fd, 0, 20000)
                os.fchmod(fd, 0o2775)
            else:
                os.fchown(fd, uid, uid)
                os.fchmod(fd, 0o755)
        finally:
            os.close(fd)


def install_coding_binding(config, etc="/etc"):
    # Only the adapter's privileged msb call can install this file. Ordinary
    # workspace commands cannot select a destination or impersonate root.
    if os.geteuid() != ROOT_UID:
        fail(3, "coding binding requires root")
    expected = {"version", "workspaceId", "actorId", "repositoryId", "repositorySlug",
                "apiBaseUrl", "gitUrl", "repositoryPath", "username", "credentialSocket"}
    if not isinstance(config, dict) or set(config) != expected:
        fail(3, "coding binding fields are invalid")
    if (config["version"] != 1 or not isinstance(config["workspaceId"], str)
            or not valid_id(config["workspaceId"])
            or type(config["actorId"]) is not int or config["actorId"] <= 0
            or type(config["repositoryId"]) is not int or config["repositoryId"] <= 0
            or config["repositoryPath"] != "/workspace" or config["username"] != "agent"
            or config["credentialSocket"] != "/home/agent/.cache/smithers/git-credential/socket"
            or not all(isinstance(config[key], str) and "\x00" not in config[key]
                       for key in ("repositorySlug", "apiBaseUrl", "gitUrl"))):
        fail(3, "coding binding authority is invalid")

    def directory(parent, name=None):
        fd = os.open(parent if name is None else name,
                     os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                     **({} if name is None else {"dir_fd": parent}))
        info = os.fstat(fd)
        if info.st_uid != ROOT_UID or info.st_mode & 0o022:
            os.close(fd)
            fail(3, "coding binding directory is not root-owned and private")
        return fd

    etc_fd = directory(etc)
    parent_fd = None
    temporary = None
    try:
        try:
            os.mkdir("smithers", 0o755, dir_fd=etc_fd)
        except FileExistsError:
            pass
        parent_fd = directory(etc_fd, "smithers")
        target = "workspace-coding.json"
        try:
            current = os.stat(target, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or current.st_uid != ROOT_UID:
                fail(3, "coding binding target is not a root-owned file")
        except FileNotFoundError:
            pass
        temporary = ".workspace-coding-" + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent_fd)
        with os.fdopen(fd, "wb") as handle:
            handle.write(json.dumps(config, separators=(",", ":")).encode() + b"\n")
            handle.flush()
            os.fchmod(handle.fileno(), 0o644)
            os.fsync(handle.fileno())
        os.rename(temporary, target, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        temporary = None
        os.fsync(parent_fd)
    finally:
        if temporary is not None:
            os.unlink(temporary, dir_fd=parent_fd)
        if parent_fd is not None:
            os.close(parent_fd)
        os.close(etc_fd)


def coding_helper_current(digest, directory="/usr/local/bin"):
    if os.geteuid() != ROOT_UID:
        fail(3, "coding helper check requires root")
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        fail(3, "coding helper digest is invalid")
    parent_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(parent_fd)
        if info.st_uid != ROOT_UID or info.st_mode & 0o022:
            fail(3, "coding helper directory is not root-owned and private")
        try:
            current = os.stat("smithers-jj-export", dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or current.st_uid != ROOT_UID:
                fail(3, "coding helper target is not a root-owned file")
            fd = os.open("smithers-jj-export", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
        except FileNotFoundError:
            return False
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != ROOT_UID:
                fail(3, "coding helper target is not a root-owned file")
            if stat.S_IMODE(info.st_mode) != 0o755 or not 64 <= info.st_size <= 64 * 1024 * 1024:
                return False
            checksum = hashlib.sha256()
            remaining = 64 * 1024 * 1024 + 1
            while remaining:
                chunk = handle.read(min(65536, remaining))
                if not chunk:
                    return checksum.hexdigest() == digest
                checksum.update(chunk)
                remaining -= len(chunk)
            return False
    finally:
        os.close(parent_fd)


def install_coding_helper(body, directory="/usr/local/bin"):
    if os.geteuid() != ROOT_UID:
        fail(3, "coding helper requires root")
    if (len(body) < 64 or len(body) > 64 * 1024 * 1024 or body[:4] != b"\x7fELF"
            or body[4:6] != b"\x02\x01" or int.from_bytes(body[18:20], "little") != 183):
        fail(3, "coding helper is not Linux arm64")
    parent_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = None
    try:
        info = os.fstat(parent_fd)
        if info.st_uid != ROOT_UID or info.st_mode & 0o022:
            fail(3, "coding helper directory is not root-owned and private")
        target = "smithers-jj-export"
        try:
            current = os.stat(target, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or current.st_uid != ROOT_UID:
                fail(3, "coding helper target is not a root-owned file")
        except FileNotFoundError:
            pass
        temporary = ".smithers-jj-export-" + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent_fd)
        with os.fdopen(fd, "wb") as handle:
            handle.write(body)
            handle.flush()
            os.fchmod(handle.fileno(), 0o755)
            os.fsync(handle.fileno())
        os.rename(temporary, target, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        temporary = None
        os.fsync(parent_fd)
    finally:
        if temporary is not None:
            os.unlink(temporary, dir_fd=parent_fd)
        os.close(parent_fd)


# Where each tool looks under $HOME when its variable is unset. A process that
# keeps only PATH and HOME (a Flow host's least-authority tool environment)
# still finds the layer's caches and offline settings.
HOME_LINKS = {
    "PLAYWRIGHT_BROWSERS_PATH": ".cache/ms-playwright",
    "DPRINT_CACHE_DIR": ".cache/dprint",
    "CARGO_HOME": ".cargo",
    "RUSTUP_HOME": ".rustup",
    "pnpm_config_store_dir": ".local/share/pnpm/store",
    "pnpm_config_cache_dir": ".cache/pnpm",
}
GO_SETTINGS = ("GOTOOLCHAIN", "GOPROXY", "GOFLAGS", "GOMODCACHE", "GOCACHE")


def home_defaults(entry):
    if os.geteuid() != entry.pw_uid:
        fail(125, "home defaults require agent identity")
    # Called only in the command child after drop_to. Warm branch-produced
    # home names and settings never enter privileged setup.
    home_fd = safe_directory(entry.pw_dir)
    try:
        try:
            tool_fd = safe_directory(TOOL_HOME, create=False)
        except FileNotFoundError:
            tool_fd = None
        if tool_fd is not None:
            try:
                for name in os.listdir(tool_fd):
                    try:
                        os.symlink(os.path.join(TOOL_HOME, name), name, dir_fd=home_fd)
                    except FileExistsError:
                        pass
            finally:
                os.close(tool_fd)
    finally:
        os.close(home_fd)

    for relative in (".cache", ".config", ".config/go", ".local", ".local/share", ".local/share/pnpm"):
        try:
            fd = safe_directory(os.path.join(entry.pw_dir, relative), create=False)
            os.close(fd)
        except FileNotFoundError:
            pass
    if not os.path.exists(ENV_FILE):
        return
    environment = base_environment()

    home = safe_directory(entry.pw_dir)
    try:
        for name, relative in HOME_LINKS.items():
            target = environment.get(name)
            if target:
                parent, leaf = home_parent(home, relative, entry)
                try:
                    try:
                        os.symlink(target, leaf, dir_fd=parent)
                        os.chown(leaf, entry.pw_uid, entry.pw_gid, dir_fd=parent, follow_symlinks=False)
                    except FileExistsError:
                        pass
                finally:
                    os.close(parent)
        settings = ["%s=%s\n" % (name, environment[name]) for name in GO_SETTINGS if environment.get(name)]
        if settings:
            parent, leaf = home_parent(home, ".config/go/env", entry)
            try:
                fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
                with os.fdopen(fd, "w") as handle:
                    info = os.fstat(handle.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid not in (0, entry.pw_uid):
                        fail(3, "home defaults target is not regular")
                    os.fchown(handle.fileno(), entry.pw_uid, entry.pw_gid)
                    handle.truncate(0)
                    handle.writelines(settings)
            finally:
                os.close(parent)
    finally:
        os.close(home)


def safe_directory(path, trusted=False, create=True):
    if not path.startswith("/") or ".." in path.split("/"):
        fail(3, "invalid setup directory")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in filter(None, path.split("/")):
            if create:
                try:
                    os.mkdir(part, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            if trusted:
                info = os.fstat(child)
                if info.st_uid != 0 or info.st_mode & 0o022:
                    os.close(child)
                    fail(3, "untrusted directory ancestor")
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def home_parent(home, relative, entry):
    fd = os.dup(home)
    try:
        parts = relative.split("/")
        for part in parts[:-1]:
            try:
                os.mkdir(part, 0o755, dir_fd=fd)
                os.chown(part, entry.pw_uid, entry.pw_gid, dir_fd=fd, follow_symlinks=False)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def protected_requests():
    fd = safe_directory(REQUEST_DIR, trusted=True)
    info = os.fstat(fd)
    if info.st_uid != 0 or info.st_mode & 0o022:
        os.close(fd)
        fail(3, "untrusted request directory")
    os.fchmod(fd, 0o700)
    return fd


def read_request(handle):
    body = handle.read(1048577)
    if len(body) > 1048576:
        fail(125, "request exceeds limit")
    return json.loads(body)


def main(args):
    if not args:
        fail(125, "missing subcommand")
    command = args[0]
    if command == "put-env" and len(args) == 1:
        put_secret_environment(sys.stdin.buffer.read(SECRET_ENV_LIMIT + 1))
        return
    if command == "coding-helper-check" and len(args) == 1:
        digest = sys.stdin.buffer.read(65).decode("ascii")
        print("current" if coding_helper_current(digest) else "replace")
        return
    if command == "coding-helper" and len(args) == 1:
        install_coding_helper(sys.stdin.buffer.read(64 * 1024 * 1024 + 1))
        return
    if command == "coding-binding" and len(args) == 1:
        body = sys.stdin.buffer.read(65537)
        if len(body) > 65536:
            fail(3, "coding binding exceeds its limit")
        install_coding_binding(json.loads(body))
        return
    if command == "root-recipe" and len(args) == 2:
        sys.exit(run_root_recipe(args[1], read_request(sys.stdin.buffer)))
    if command == "exec":
        if len(args) == 3 and args[1] == "--request" and valid_id(args[2]):
            exec_id = args[2]
            parent = protected_requests()
            try:
                fd = os.open(exec_id + ".json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                with os.fdopen(fd, "rb") as handle:
                    info = os.fstat(handle.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
                        fail(3, "untrusted request")
                    os.unlink(exec_id + ".json", dir_fd=parent)
                    sys.exit(run_exec({"id":exec_id, "user":"agent", "payload":handle}))
            finally:
                os.close(parent)
        elif len(args) == 2 and valid_id(args[1]):
            # Pass the stream without reading it. Only the agent child reads
            # and decodes branch command/manifests after the credential drop.
            sys.exit(run_exec({"id":args[1], "user":"agent", "payload":sys.stdin.buffer}))
        else:
            fail(125, "invalid exec identity")
    if command == "put-request" and len(args) == 2 and valid_id(args[1]):
        parent = protected_requests()
        leaf = args[1] + ".json"
        fd = None
        created = False
        try:
            fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            created = True
            # Root creates the protected IPC descriptor; only the agent child
            # consumes branch bytes. It cannot choose or reopen the destination.
            child = os.fork()
            if child == 0:
                try:
                    os.close(parent)
                    drop_to("agent")
                    body = sys.stdin.buffer.read(1048577)
                    if len(body) > 1048576:
                        fail(125, "request exceeds limit")
                    with os.fdopen(fd, "wb") as handle:
                        handle.write(body)
                    os._exit(0)
                except BaseException:
                    os._exit(125)
            os.close(fd); fd = None
            _, status = os.waitpid(child, 0)
            if os.waitstatus_to_exitcode(status) != 0:
                fail(125, "request transfer failed")
            created = False
        finally:
            if fd is not None:
                os.close(fd)
            if created:
                os.unlink(leaf, dir_fd=parent)
            os.close(parent)
        return
    if command == "probe" and len(args) == 2:
        port = int(args[1])
        if not 1 <= port <= 65535:
            fail(3, "invalid probe port")
        drop_to("agent")
        try:
            socket.create_connection(("127.0.0.1", int(args[1])), timeout=2).close()
        except OSError:
            sys.exit(1)
        return
    if command == "kill" and len(args) == 2 and valid_id(args[1]):
        cgroup_kill(os.path.join(CGROUP_ROOT, args[1]))
        return
    if command == "kill-all":
        try:
            parent = safe_directory(CGROUP_ROOT, trusted=True, create=False)
        except FileNotFoundError:
            return
        try:
            for name in os.listdir(parent):
                if valid_id(name) and stat.S_ISDIR(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode):
                    cgroup_kill(os.path.join(CGROUP_ROOT, name))
        finally:
            os.close(parent)
        return
    if command == "fs" and len(args) >= 5:
        user = args[1]
        if user != "agent":
            fail(125, "invalid fs identity")
        if os.geteuid() == 0:
            drop_to(user)
        operation, root, path = args[2], args[3], args[4]
        if operation == "read":
            fs_read(root, path, int(args[5]))
        elif operation == "write":
            fs_write(root, path, int(args[5], 8))
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
    if command == "sanitize-system" and len(args) == 1:
        sanitize_system_image()
        return
    if command == "setup" and len(args) >= 3:
        if args[1] != "agent":
            fail(3, "member provisioning requires approved roster and broker")
        setup(args[1], int(args[2]), args[3:])
        entry = drop_to(args[1])
        os.umask(0o002)
        home_defaults(entry)
        return
    fail(125, "unknown subcommand %r" % command)


if __name__ == "__main__":
    main(sys.argv[1:])
