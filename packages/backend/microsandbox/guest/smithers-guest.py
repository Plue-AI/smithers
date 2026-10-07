#!/usr/bin/env python3
"""Guest side of the Smithers Microsandbox workspace adapter.

The backend plants this file at /opt/smithers/guest/smithers-guest.py and
reaches it only through `msb exec`. It holds no credentials. Subcommands:

  exec            run one command in its own cgroup as the workspace user;
                  the request is one JSON document on stdin (or --request FILE)
  root-recipe DIGEST run only a binary-pinned system recipe as root
  kill ID         kill every process of one command cgroup
  kill-all        kill every command cgroup (backend restart recovery)
  recover-files   settle a pending file journal before retained-machine startup
  fs USER read|write|list|remove ROOT PATH [ARG]
                  root-confined file operations as the workspace user
  relay PORT      bridge stdin/stdout to guest TCP 127.0.0.1:PORT
  bridge PORT HOST
                  listen on guest 127.0.0.1:PORT and forward to HOST:PORT
  setup USER UID  create the workspace user and adapter directories
  put-env         atomically replace the literal tmpfs team environment
  coding-binding  atomically install the fixed root-owned source binding
  coding-helper DIGEST
                  atomically install the packaged Linux arm64 helper; the
                  bytes are stdin and must hash to DIGEST
  coding-helper-check DIGEST
                  report whether the fixed helper holds DIGEST
  managed-artifact PATH DIGEST
                  atomically plant one approved bundle file under
                  /opt/smithers/bundle; the bytes are stdin
  managed-artifact-check PATH DIGEST
                  report whether that planted file is current
"""

import base64
import ctypes
import contextlib
import fcntl
from contextlib import contextmanager
import grp
import hashlib
import grp
import json
import os
import pwd
import re
import secrets
import select
import select
import signal
import socket
import stat
import sys
import threading
import time

CGROUP_ROOT = "/sys/fs/cgroup/smithers"
WRITER_COORDINATOR = ("var", "lib", "smithers", "writer-coordinator")
MUTATION_CGROUP_ROOT = "/sys/fs/cgroup/smithers-mutations"
MUTATION_TIMEOUT = 60
EXIT_TRAILER = b"\x00SMITHERS-EXIT %d\x00"
ENV_FILE = "/opt/smithers/env.json"
SECRET_ENV_DIR = "/run/smithers"
SECRET_ENV_LIMIT = 1 << 20
REQUEST_DIR = "/run/smithers/requests"
# A signed-in terminal's delegated credential: SESSION_TOKEN_DIR/<session>/token
# (T-TRM-02, spec section 5.3.2), owned by the guest's single user, mode 0600.
SESSION_TOKEN_DIR = "/run/smithers/sessions"
SESSION_TOKEN_LIMIT = 512
TOOL_HOME = "/var/cache/smithers/home"
ROOT_UID = 0
# Root plants files only below this base ("/" in a guest), through directories
# it opens one at a time by descriptor (protected_directory).
PROTECTED_BASE = "/"
# Approved bundle files live only under this fixed, root-owned tree.
MANAGED_ARTIFACT_ROOT = ("opt", "smithers", "bundle")
MANAGED_ARTIFACT_LIMIT = 64 * 1024 * 1024
# The packaged Linux arm64 source-publication helper's fixed place.
CODING_HELPER_DIRECTORY = ("usr", "local", "bin")
CODING_HELPER_NAME = "smithers-jj-export"
# The bundle programs root plants in /usr/local/bin: the helper and the jj
# revision its jj-lib pins. No other name is ever written there.
CODING_PROGRAM_NAMES = (CODING_HELPER_NAME, "jj")


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
        loaded["PATH"] = "/opt/smithers/bundle/bin/linux-arm64:" + loaded.get("PATH", "/usr/local/bin:/usr/bin:/bin")
        return loaded
    except FileNotFoundError:
        return {"PATH": "/opt/smithers/bundle/bin/linux-arm64:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}


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


def session_token_body(body):
    if not 0 < len(body) <= SESSION_TOKEN_LIMIT or any(c <= 0x20 or c > 0x7e for c in body):
        fail(3, "invalid session token")
    return body


def session_token_identity(directory, expected, entry):
    """Check the retained bearer before any rotation or deletion."""
    try:
        fd = os.open("token", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        if expected == "absent":
            return
        fail(3, "session credential identity is missing")
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if (expected == "absent" or not stat.S_ISREG(info.st_mode) or
                info.st_uid != entry.pw_uid or info.st_gid != entry.pw_gid or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or
                info.st_size > SESSION_TOKEN_LIMIT + 1):
            fail(3, "untrusted session credential")
        body = handle.read(SESSION_TOKEN_LIMIT + 2)
        if not body.endswith(b"\n"):
            fail(3, "invalid retained session credential")
        token = session_token_body(body[:-1])
        if hashlib.sha256(token).hexdigest() != expected:
            fail(3, "session credential identity differs")


@contextmanager
def session_token_parent(session, expected, create):
    if os.geteuid() != 0:
        fail(3, "session token writer requires root")
    if not valid_id(session):
        fail(125, "invalid session id")
    if not valid_digest(expected) and not (create and expected == "absent"):
        fail(3, "invalid session credential identity")
    try:
        parent = safe_directory(SESSION_TOKEN_DIR, trusted=True, create=create)
    except FileNotFoundError:
        yield None
        return
    lock = None
    try:
        # All host replicas use the same root-owned guest lock. A user cannot
        # rename it or install a symlink, and no bearer is stored in it.
        lock = os.open(".credential-lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=parent)
        info = os.fstat(lock)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            fail(3, "untrusted session credential lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield parent
    finally:
        if lock is not None:
            os.close(lock)
        os.close(parent)


def session_issuer_envelope(directory, session, expected):
    fd = os.open("issuer.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                stat.S_IMODE(info.st_mode) != 0o644 or info.st_nlink != 1 or info.st_size > 1024):
            fail(3, "untrusted session issuer envelope")
        try:
            value = json.loads(handle.read(1025))
        except (ValueError, UnicodeError):
            fail(3, "invalid session issuer envelope")
        if (not isinstance(value, dict) or value.get("version") != 1 or
                value.get("session_id") != session or value.get("credential_identity") != expected):
            fail(3, "session issuer envelope differs")


def put_session_token(session, body, expected, issuer, user="agent", uid=None):
    """Compare and atomically replace one session's delegated credential."""
    body = session_token_body(body)
    if not isinstance(issuer, str) or not re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})", issuer) or int(issuer.rsplit(":", 1)[1]) > 65535:
        fail(3, "invalid session credential issuer")
    envelope = {"version": 1, "session_id": session, "issuer": issuer,
                "credential_identity": hashlib.sha256(body).hexdigest()}
    entry = assigned_identity(user)
    if uid is not None and entry.pw_uid != uid:
        fail(3, "session identity differs")
    with session_token_parent(session, expected, True) as parent:
        if expected == "absent":
            try:
                os.mkdir(session, 0o755, dir_fd=parent)
            except FileExistsError:
                pass
        directory = os.open(session, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        temporary = ".token-" + secrets.token_hex(16)
        created = False
        try:
            info = os.fstat(directory)
            if info.st_uid != 0 or info.st_mode & 0o022:
                fail(3, "untrusted session token directory")
            session_token_identity(directory, expected, entry)
            if sorted(os.listdir(directory)) != ([] if expected == "absent" else ["issuer.json", "token"]):
                fail(3, "unexpected session credential entries")
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            created = True
            with os.fdopen(fd, "wb") as handle:
                os.fchmod(handle.fileno(), 0o600)
                os.fchown(handle.fileno(), entry.pw_uid, entry.pw_gid)
                handle.write(body + b"\n")
                handle.flush()
                os.fsync(handle.fileno())
            # The issuer envelope is authenticated by a root-owned file in
            # this protected directory. Guest processes can change their bearer
            # bytes, but cannot bless another bearer, session or backend.
            if expected != "absent":
                session_issuer_envelope(directory, session, expected)
            envelope_temp = ".issuer-" + secrets.token_hex(16)
            envelope_created = False
            try:
                fd = os.open(envelope_temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
                envelope_created = True
                with os.fdopen(fd, "wb") as handle:
                    os.fchmod(handle.fileno(), 0o644)
                    handle.write(json.dumps(envelope, separators=(",", ":")).encode("ascii"))
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(envelope_temp, "issuer.json", src_dir_fd=directory, dst_dir_fd=directory)
                envelope_created = False
                os.replace(temporary, "token", src_dir_fd=directory, dst_dir_fd=directory)
            finally:
                if envelope_created:
                    os.unlink(envelope_temp, dir_fd=directory)
            created = False
            os.fsync(directory)
        finally:
            if created:
                os.unlink(temporary, dir_fd=directory)
            os.close(directory)


def delete_session_token(session, expected, user="agent", uid=None):
    """Delete only the matching bearer; never unlink unrelated entries."""
    entry = assigned_identity(user)
    if uid is not None and entry.pw_uid != uid:
        fail(3, "session identity differs")
    with session_token_parent(session, expected, False) as parent:
        if parent is None:
            return
        try:
            directory = os.open(session, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        except FileNotFoundError:
            return
        try:
            info = os.fstat(directory)
            if info.st_uid != 0 or info.st_mode & 0o022:
                fail(3, "untrusted session token directory")
            session_token_identity(directory, expected, entry)
            session_issuer_envelope(directory, session, expected)
            if sorted(os.listdir(directory)) != ["issuer.json", "token"]:
                fail(3, "unexpected session credential entries")
            os.unlink("token", dir_fd=directory)
            os.unlink("issuer.json", dir_fd=directory)
        finally:
            os.close(directory)
        os.rmdir(session, dir_fd=parent)



def session_binding_identity(user, uid):
    if os.geteuid() != 0 or not re.fullmatch(r"[a-z0-9_-]{1,32}", user) or user in ("root", "machined"):
        fail(3, "invalid session binding identity")
    if not re.fullmatch(r"[0-9]{1,10}", uid):
        fail(3, "invalid session binding uid")
    uid = int(uid)
    if not (uid == 19999 and user == "agent" or 20000 <= uid <= 2147483647 and user != "agent"):
        fail(3, "invalid session binding uid")
    entry = assigned_identity(user)
    if entry.pw_uid != uid or entry.pw_gid != uid:
        fail(3, "session binding identity differs")
    return entry


def put_session_binding(user, uid, body):
    # Opaque branch environment bytes: root checks the envelope and inode only.
    # The shipped session launcher parses contents after permanent identity drop.
    if not body or len(body) > 256 * 1024:
        fail(3, "invalid session binding size")
    entry = session_binding_identity(user, uid)
    parent = safe_directory("/run/smithers/admission", trusted=True)
    name = "u" + str(entry.pw_uid)
    try:
        require_secret_tmpfs(parent)
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        try:
            os.fchown(fd, 0, entry.pw_gid)
            os.fchmod(fd, 0o640)
            with os.fdopen(fd, "wb", closefd=False) as handle:
                handle.write(body)
                handle.flush()
                os.fsync(fd)
        except BaseException:
            os.unlink(name, dir_fd=parent)
            raise
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def delete_session_binding(user, uid):
    entry = session_binding_identity(user, uid)
    try:
        parent = safe_directory("/run/smithers/admission", trusted=True, create=False)
    except FileNotFoundError:
        return
    try:
        name = "u" + str(entry.pw_uid)
        try:
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != entry.pw_gid or stat.S_IMODE(info.st_mode) != 0o640 or info.st_nlink != 1:
            fail(3, "untrusted session binding")
        os.unlink(name, dir_fd=parent)
    finally:
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


def cgroup_kill(path, *, mutation=False, collect=True):
    """Only fixed root-owned cgroups can be addressed, through held descriptors."""
    name = os.path.basename(path)
    root = MUTATION_CGROUP_ROOT if mutation else CGROUP_ROOT
    if os.path.dirname(path) != root or not valid_id(name):
        fail(3, "invalid cgroup path")
    try:
        parent = safe_directory(root, trusted=True, create=False)
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
                if isinstance(error, FileNotFoundError):
                    # Another collector may already have removed this cgroup.
                    # Do not confuse its replacement at the same name with the
                    # held inode, or delete that replacement during cleanup.
                    try:
                        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        return
                    if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                        return
                raise RuntimeError("command cgroup termination could not be confirmed") from error
            if time.monotonic() >= deadline:
                raise RuntimeError("command cgroup remains populated after cancellation")
            time.sleep(0.02)
        if collect:
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


@contextlib.contextmanager
def writer_coordinator(exclusive=False):
    """A fixed protected lock shared by admission and root metadata helpers.

    An eventual transaction/recovery worker takes the exclusive side. Neither
    paths nor journal contents from a branch are read by this root boundary.
    """
    directory = protected_directory(WRITER_COORDINATOR, True)
    lock = None
    try:
        lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=directory)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != ROOT_UID or info.st_mode & 0o077 or info.st_nlink != 1:
            fail(125, "untrusted writer coordinator lock")
        fcntl.flock(lock, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield directory
    finally:
        # Closing, rather than explicit LOCK_UN, preserves the lock if a trusted
        # child still holds an inherited descriptor. All descriptors are CLOEXEC.
        if lock is not None:
            os.close(lock)
        os.close(directory)


@contextlib.contextmanager
def writer_admission():
    with writer_coordinator() as directory:
        try:
            os.stat("pending", dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            # Presence alone refuses. Root never follows or decodes a recovery
            # journal here, nor treats a stale lock age as permission to resume.
            fail(125, "workspace mutation recovery required")
        yield


def mutation_account():
    entry = assigned_identity("agent", 19999)
    team = grp.getgrnam("team")
    if team.gr_gid != 20000:
        fail(125, "mutation team identity is unavailable")
    return entry, team.gr_gid


def drop_mutation_identity(entry, gid):
    # Credential changes reset dumpability to this kernel policy. Refuse a
    # retained image that could expose the journal in the transition window.
    fd = os.open("/proc/sys/fs/suid_dumpable", os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        if handle.read(32).strip() != b"0":
            fail(125, "mutation credential transition would be dumpable")
    os.setgroups([])
    os.setresgid(gid, gid, gid)
    os.setresuid(entry.pw_uid, entry.pw_uid, entry.pw_uid)
    if (os.getresuid() != (entry.pw_uid,) * 3 or os.getresgid() != (gid,) * 3
            or os.getgroups() or os.geteuid() == 0 or os.getegid() == 0):
        fail(125, "mutation credential drop failed")
    # A live same-uid caller must not ptrace the input worker or reopen its
    # private journal descriptor while that caller is still sending input.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
        fail(125, "mutation worker is dumpable")
    os.umask(0o002)


def mutation_control(fd, accepted):
    if not select.select([fd], [], [], MUTATION_TIMEOUT)[0]:
        fail(125, "mutation worker timed out")
    value = os.read(fd, 1)
    if value not in accepted or len(value) != 1:
        fail(125, "mutation worker control failed")
    return value


def mutation_freeze(writers, frozen):
    fd = os.open("cgroup.freeze", os.O_WRONLY | os.O_NOFOLLOW, dir_fd=writers)
    try:
        os.write(fd, b"1" if frozen else b"0")
    finally:
        os.close(fd)
    expected = "frozen 1" if frozen else "frozen 0"
    deadline = time.monotonic() + MUTATION_TIMEOUT
    while True:
        fd = os.open("cgroup.events", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=writers)
        with os.fdopen(fd, "r") as handle:
            if expected in handle.read(4096).splitlines():
                return
        if time.monotonic() >= deadline:
            fail(125, "mutation writer freeze did not settle")
        time.sleep(0.01)


def mutation_pending(store, entry, gid):
    """Only fixed metadata is inspected by root; journal bytes stay private."""
    try:
        os.mkdir("pending", 0o700, dir_fd=store)
        os.fsync(store)
    except FileExistsError:
        pass
    pending = os.open("pending", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=store)
    journal = None
    try:
        info = os.fstat(pending)
        if info.st_uid != ROOT_UID or stat.S_IMODE(info.st_mode) != 0o700:
            fail(125, "untrusted mutation recovery directory")
        try:
            os.mkdir("journal", 0o700, dir_fd=pending)
        except FileExistsError:
            pass
        journal = os.open("journal", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=pending)
        info = os.fstat(journal)
        if info.st_uid == ROOT_UID and ROOT_UID != entry.pw_uid:
            # A crash may precede the initial chown. Root does not enumerate or
            # parse its contents; rmdir proves it is still an empty fresh grant.
            os.rmdir("journal", dir_fd=pending)
            os.close(journal)
            journal = None
            os.mkdir("journal", 0o700, dir_fd=pending)
            journal = os.open("journal", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=pending)
            os.fchown(journal, entry.pw_uid, gid)
            info = os.fstat(journal)
        if (info.st_uid != entry.pw_uid or info.st_gid != gid
                or stat.S_IMODE(info.st_mode) != 0o700):
            fail(125, "untrusted mutation journal grant")
        os.fsync(journal)
        os.fsync(pending)
        os.fsync(store)
        return pending, journal
    except BaseException:
        if journal is not None:
            os.close(journal)
        os.close(pending)
        raise


def mutation_cleanup(journal):
    # Called only by the dropped worker after durable commit/abort and thaw.
    # Remove state last, so interrupted cleanup cannot reveal prepared history.
    for name in os.listdir(journal):
        if name == "state.json":
            continue
        if name != "state.next" and not re.fullmatch(r"base-[0-9]+", name):
            fail(125, "unexpected mutation journal entry")
        os.unlink(name, dir_fd=journal)
    try:
        os.unlink("state.json", dir_fd=journal)
    except FileNotFoundError:
        pass
    os.fsync(journal)


class MutationStale(SystemExit):
    """Private settlement signal; no diagnostic is written under the freeze."""
    def __init__(self, path, digest):
        super().__init__(6)
        self.path, self.digest = path, digest


def coordinate_mutation(prepare, emit, limit, *, recover_only=False):
    """Coordinate recovery; new mutations remain private and gated off.

    prepare/emit are fixed installed callbacks, never supplied by a request.
    Only the dropped worker calls them. Root sees fixed control bytes, trusted
    account metadata and kernel cgroup state; it never opens journal payloads.
    """
    if os.geteuid() != 0 or type(limit) is not int or not 0 < limit <= 64 << 20:
        fail(125, "mutation coordinator requires trusted root envelope")
    with writer_coordinator(exclusive=True) as store:
        try:
            os.stat("pending", dir_fd=store, follow_symlinks=False)
            recovering = True
        except FileNotFoundError:
            recovering = False
        if recover_only and not recovering:
            return 0
        entry, gid = mutation_account()
        # Recovery runs before admitting a new request. A killed input worker
        # may still hold a stream, and a killed apply worker may have partial data.
        phases = [True] if recover_only else ([True, False] if recovering else [False])
        for recovery in phases:
            worker_group = os.path.join(MUTATION_CGROUP_ROOT, "active")
            cgroup_kill(worker_group, mutation=True)
            pending, journal = mutation_pending(store, entry, gid)
            writers = group = None
            descriptors = []
            child = None
            reaped = False
            try:
                writers = safe_directory(CGROUP_ROOT, trusted=True)
                if recovery:
                    mutation_freeze(writers, True)
                group = safe_directory(worker_group, trusted=True)
                state_r, state_w = os.pipe()
                descriptors = [state_r, state_w]
                command_r, command_w = os.pipe()
                descriptors.extend((command_r, command_w))
                child = os.fork()
                if child == 0:
                    code = 125
                    try:
                        # Join before closing the inherited admission lock. A
                        # replacement coordinator cannot miss a late-joining child.
                        fd = os.open("cgroup.procs", os.O_WRONLY | os.O_NOFOLLOW, dir_fd=group)
                        with os.fdopen(fd, "w") as handle:
                            handle.write(str(os.getpid()))
                        keep = {0, 1, 2, journal, state_w, command_r}
                        for name in os.listdir("/proc/self/fd"):
                            fd = int(name)
                            if fd not in keep:
                                try:
                                    os.close(fd)
                                except OSError:
                                    pass
                        drop_mutation_identity(entry, gid)
                        # No branch path or bytes are consumed above this point.
                        root = safe_directory("/workspace", create=False)
                        changes, input_error = None, None
                        if not recovery:
                            try:
                                changes = prepare()
                            except BaseException as failure:
                                # Installed prepare callbacks only decode bounded
                                # input. A rejected request still follows durable
                                # abort/cleanup, without leaving a needless fence.
                                input_error = failure
                        os.write(state_w, b"R")
                        mutation_control(command_r, (b"G",))
                        error, result = input_error, None
                        if recovery or error is not None:
                            phase = recover_mutation(root, journal, limit)
                        else:
                            try:
                                result = apply_mutation_batch(root, journal, changes, limit)
                                phase = "committed"
                            except BaseException as failure:
                                error = failure
                                phase = recover_mutation(root, journal, limit)
                        os.write(state_w, b"C" if phase == "committed" else b"A")
                        mutation_control(command_r, (b"T",))
                        try:
                            if isinstance(error, MutationStale):
                                fail(6, "stale:" + json.dumps({"path": error.path, "current_digest": error.digest},
                                                            separators=(",", ":")))
                            if error is not None:
                                raise error
                            if not recovery:
                                emit(result)
                            code = 0
                        finally:
                            mutation_cleanup(journal)
                    except SystemExit as error:
                        code = error.code if type(error.code) is int and 0 <= error.code <= 255 else 125
                    except BaseException as error:
                        sys.stderr.write("smithers-guest: mutation worker: %s\n" % error)
                        code = 125
                    finally:
                        try:
                            sys.stdout.flush()
                            sys.stderr.flush()
                        except OSError:
                            code = 125
                        os._exit(code)
                os.close(state_w)
                os.close(command_r)
                descriptors = [state_r, command_w]
                mutation_control(state_r, (b"R",))
                mutation_freeze(writers, True)
                os.write(command_w, b"G")
                mutation_control(state_r, (b"C", b"A"))
                # Never thaw from an error/finally path. The worker has durably
                # committed or rolled back before it sends this fixed signal.
                mutation_freeze(writers, False)
                os.write(command_w, b"T")
                deadline = time.monotonic() + MUTATION_TIMEOUT
                while True:
                    pid, status = os.waitpid(child, os.WNOHANG)
                    if pid:
                        reaped = True
                        break
                    if time.monotonic() >= deadline:
                        fail(125, "mutation response did not finish")
                    time.sleep(.01)
                cgroup_kill(worker_group, mutation=True)
                # rmdir is the only root inspection of the worker's cleanup.
                # If it was interrupted, pending stays and recovery rechecks it.
                os.rmdir("journal", dir_fd=pending)
                os.fsync(pending)
                os.rmdir("pending", dir_fd=store)
                os.fsync(store)
                code = os.waitstatus_to_exitcode(status)
                if code:
                    return 128 - code if code < 0 else code
            finally:
                try:
                    if child is not None and not reaped:
                        try:
                            os.kill(child, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        cgroup_kill(worker_group, mutation=True)
                        os.waitpid(child, 0)
                finally:
                    for fd in descriptors:
                        os.close(fd)
                    for fd in (group, writers, journal, pending):
                        if fd is not None:
                            os.close(fd)
        return 0


def coordinated_compare_write(args):
    """Decode the file-content batch in the dropped worker; still gated off.

    Root consumes only the host's bounded size envelope. Paths, bases, content
    and encodings use the existing HTTP changes shape; no request chooses uid,
    root, mode, journal or an executable. Input completes before writers freeze.
    """
    if len(args) != 5 or not isinstance(args[4], str) or not re.fullmatch(r"[0-9]{1,8}", args[4]):
        fail(3, "invalid compare-write size envelope")
    limit = int(args[4])
    if not 0 < limit <= 64 << 20:
        fail(3, "invalid compare-write limit")

    def prepare():
        if args[:4] != ["fs", "agent", "compare-write", "/workspace"]:
            fail(3, "invalid compare-write envelope")
        # JSON can expand a byte to six characters; separately bound path/key
        # overhead. Neither parsing nor base64 decoding sees unbounded input.
        wire_limit = min(64 << 20, 6 * limit + (2 << 20))
        body = sys.stdin.buffer.read(wire_limit + 1)
        if len(body) > wire_limit:
            fail(4, "mutation request exceeds byte limit")

        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    fail(3, "duplicate mutation field")
                result[key] = value
            return result

        try:
            request = json.loads(body.decode("utf-8"), object_pairs_hook=unique,
                                 parse_constant=lambda _: fail(3, "invalid mutation JSON"))
        except (ValueError, UnicodeError, RecursionError):
            fail(3, "invalid mutation JSON")
        if (not isinstance(request, dict) or set(request) != {"changes"}
                or not isinstance(request["changes"], list) or not 0 < len(request["changes"]) <= 256):
            fail(3, "invalid mutation batch")
        changes, paths, total = [], set(), 0
        for change in request["changes"]:
            if (not isinstance(change, dict) or not {"path", "base_digest", "content"} <= set(change)
                    or set(change) - {"path", "base_digest", "content", "encoding"}):
                fail(3, "invalid mutation fields")
            path, base, content = change["path"], change["base_digest"], change["content"]
            mutation_path(path)
            if path in paths:
                fail(3, "duplicate mutation path")
            paths.add(path)
            if base != "absent" and (not isinstance(base, str) or not re.fullmatch(r"[0-9a-f]{64}", base)):
                fail(3, "invalid base_digest")
            encoding = change.get("encoding", "utf-8")
            if encoding not in ("utf-8", "base64") or (content is None and "encoding" in change):
                fail(3, "invalid mutation encoding")
            if content is not None:
                if not isinstance(content, str):
                    fail(3, "invalid mutation content")
                try:
                    if encoding == "base64":
                        decoded = base64.b64decode(content, validate=True)
                        if base64.b64encode(decoded).decode("ascii") != content:
                            fail(3, "noncanonical mutation base64")
                    else:
                        decoded = content.encode("utf-8")
                except (ValueError, UnicodeError):
                    fail(3, "invalid mutation content")
                content = decoded
                total += len(content)
                if total > limit:
                    fail(4, "mutation batch exceeds byte limit")
            # None mode means preserve the mode observed under writer exclusion.
            changes.append((path, base, content, None))
        for path in paths:
            parts = path.split("/")
            if any("/".join(parts[:i]) in paths for i in range(1, len(parts))):
                fail(3, "mutation paths overlap")
        return changes

    def emit(result):
        sys.stdout.write(json.dumps({"changes": [{"path": path, "digest": digest}
                                                for path, digest in result.items()]},
                                   separators=(",", ":")))

    return coordinate_mutation(prepare, emit, limit)


def run_managed_child(exec_id, action, *, privileged=False):
    """Admit every workspace-writing child before it consumes branch operands.

    The parent remains outside the command tree for cancellation and collection.
    This admission is necessary for guest-wide exclusion; it does not itself
    freeze writers, drain outstanding kernel I/O, or qualify compare-and-write.
    """
    # Only validated, install-pinned metadata operations use this private flag.
    # No command/request envelope can select it.
    if privileged and os.geteuid() != 0:
        fail(125, "root metadata requires root")
    if not valid_id(exec_id):
        fail(125, "invalid exec identity")
    group = os.path.join(CGROUP_ROOT, exec_id)
    # Admit the group before forking, and close protected descriptors before
    # they can reach the unprivileged child. A concurrently frozen parent holds
    # children that join after this short admission section as well.
    admission = writer_admission() if os.geteuid() == 0 else contextlib.nullcontext()
    with admission:
        group_fd = safe_directory(group, trusted=True)
    try:
        child = os.fork()
    except BaseException:
        os.close(group_fd)
        raise
    if child == 0:
        code = 0
        try:
            fd = os.open("cgroup.procs", os.O_WRONLY | os.O_NOFOLLOW, dir_fd=group_fd)
            with os.fdopen(fd, "w") as handle:
                handle.write(str(os.getpid()))
            os.close(group_fd)
            entry = None if privileged else drop_to("agent")
            os.umask(0o022 if privileged else 0o002)
            action(entry)
        except SystemExit as error:
            code = 0 if error.code is None else error.code if type(error.code) is int and 0 <= error.code <= 255 else 125
        except FileNotFoundError as error:
            sys.stderr.write("smithers-guest: %s\n" % error)
            code = 127
        except PermissionError as error:
            sys.stderr.write("smithers-guest: %s\n" % error)
            code = 126
        except BaseException as error:  # noqa: BLE001 - the child must never return
            sys.stderr.write("smithers-guest: %s\n" % error)
            code = 126
        finally:
            try:
                sys.stdout.flush()
                sys.stderr.flush()
            except OSError:
                # A broken reply stream is not a successful helper response.
                code = 126
            finally:
                os._exit(code)

    os.close(group_fd)

    def terminate(signum, _frame):
        cgroup_kill(group)
        os._exit(128 + signum)

    signals = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
    previous = {signum: signal.signal(signum, terminate) for signum in signals}
    try:
        _, status = os.waitpid(child, 0)
        code = os.waitstatus_to_exitcode(status)
        # Descendants may outlive the direct child or hold its pipes. Reap the
        # entire admitted group before returning to any helper caller.
        cgroup_kill(group)
        return 128 - code if code < 0 else code
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def run_exec(request):
    if not isinstance(request, dict) or set(request) - {"id", "user", "argv", "env", "cwd", "root", "stdin", "payload"}:
        fail(125, "invalid exec envelope")
    exec_id = request.get("id", "")
    if not valid_id(exec_id) or request.get("user") != "agent":
        fail(125, "invalid exec envelope")

    def execute(_entry):
        payload = request
        if "payload" in payload:
            payload = read_request(payload["payload"])
            if not isinstance(payload, dict) or set(payload) - {"id", "user", "argv", "env", "cwd", "root", "stdin"} or payload.get("id") != exec_id or payload.get("user") != "agent":
                fail(125, "invalid exec payload")
        if payload.get("stdin") != "inherit":
            null = os.open(os.devnull, os.O_RDONLY)
            os.dup2(null, 0)
            os.close(null)
        argv = payload.get("argv") or []
        if not argv or not all(isinstance(a, str) for a in argv):
            fail(125, "invalid exec request")
        env = base_environment()
        env.update(load_secret_environment())
        for key, value in (payload.get("env") or {}).items():
            if not key or "=" in key or "\x00" in key or "\x00" in str(value):
                fail(125, "invalid environment variable %r" % key)
            env[key] = str(value)
        cwd = payload.get("cwd") or "/"
        root = payload.get("root")
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

    code = run_managed_child(exec_id, execute)
    sys.stdout.flush()
    os.write(2, EXIT_TRAILER % code)
    return code


def run_fs(args):
    # Called only after admission/drop (or by a process already unprivileged).
    operation, root, path = args[2], args[3], args[4]
    if operation == "read":
        fs_read(root, path, int(args[5]))
    elif operation == "write":
        fs_write(root, path, int(args[5], 8))
    elif operation == "compare-write":
        # No branch argument or environment can open this qualification gate.
        fail(125, "compare-write provider is not qualified")
    elif operation == "list":
        fs_list(root, path)
    elif operation == "remove":
        fs_remove(root, path)
    else:
        fail(125, "unknown fs operation")


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
    def execute(_entry):
        result = subprocess.run(argv, cwd="/", env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/root", "TMPDIR": "/var/tmp", "DEBIAN_FRONTEND": "noninteractive",
            "PYTHONPATH": ""})
        sys.exit(128 - result.returncode if result.returncode < 0 else result.returncode)

    # Root descendants must remain in the writer tree even if this supervisor
    # dies. A userspace lock held only by the supervisor cannot guarantee that.
    code = run_managed_child("recipe-" + secrets.token_hex(16), execute, privileged=True)
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


def exchange_file(parent, source, target, flags):
    """Linux renameat2; unsupported kernels refuse rather than use rename."""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(parent, os.fsencode(source), parent, os.fsencode(target), flags) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def file_digest_at(parent, name, limit):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        return "absent"
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            fail(3, "workspace mutation target is not a regular file")
        value = hashlib.sha256()
        count = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                return value.hexdigest()
            count += len(chunk)
            if count > limit:
                fail(4, "workspace file exceeds compare limit")
            value.update(chunk)
    finally:
        os.close(fd)


def mutation_path(path):
    if (not isinstance(path, str) or not path or len(path) > 1024 or "\x00" in path
            or any(part in ("", ".", "..") for part in path.split("/"))):
        fail(3, "invalid mutation path")
    try:
        path.encode("utf-8")
    except UnicodeError:
        fail(3, "invalid mutation path encoding")
    return path.split("/")


def mutation_parent(root, path):
    """Open only existing, non-symlink ancestors; return None when absent."""
    parts = mutation_path(path)
    parent = os.dup(root)
    try:
        for part in parts[:-1]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            except FileNotFoundError:
                os.close(parent)
                return None
            os.close(parent)
            parent = child
        return parent
    except BaseException:
        os.close(parent)
        raise


def mutation_read(parent, leaf, limit):
    if parent is None:
        return None, None
    try:
        fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        return None, None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            fail(3, "mutation input is not a regular file")
        chunks, count = [], 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - count))
            if not chunk:
                return b"".join(chunks), stat.S_IMODE(info.st_mode) & 0o777
            chunks.append(chunk)
            count += len(chunk)
            if count > limit:
                fail(4, "mutation exceeds byte limit")
    finally:
        os.close(fd)


def mutation_digest(body):
    return "absent" if body is None else hashlib.sha256(body).hexdigest()


def mutation_write_new(parent, leaf, body, mode):
    fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=parent)
    try:
        view = memoryview(body)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("mutation write made no progress")
            view = view[count:]
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)


def mutation_save_state(journal, state):
    # The old durable state remains authoritative until atomic replacement.
    try:
        os.unlink("state.next", dir_fd=journal)
    except FileNotFoundError:
        pass
    body = json.dumps(state, separators=(",", ":"), sort_keys=True).encode()
    if len(body) > 1 << 20:
        fail(4, "mutation journal exceeds byte limit")
    mutation_write_new(journal, "state.next", body, 0o600)
    os.replace("state.next", "state.json", src_dir_fd=journal, dst_dir_fd=journal)
    os.fsync(journal)


def mutation_identity(journal, limit):
    # Only the dedicated, dropped mutation worker may consume this journal.
    # Ordinary exec deliberately retains its team supplementary group instead.
    if os.geteuid() == 0 or os.getegid() == 0 or os.getgroups():
        fail(125, "mutation worker requires dropped uid, gid and supplementary groups")
    if type(limit) is not int or not 0 < limit <= 64 << 20:
        fail(3, "invalid mutation limit")
    info = os.fstat(journal)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o700):
        fail(125, "mutation journal is not private")


def mutation_validate_state(state):
    digest = lambda value: isinstance(value, str) and (value == "absent" or re.fullmatch(r"[0-9a-f]{64}", value))
    if (not isinstance(state, dict) or set(state) != {"version", "phase", "entries", "directories"}
            or type(state["version"]) is not int or state["version"] != 1
            or state["phase"] not in ("prepared", "committed", "aborted")
            or not isinstance(state["entries"], list) or not 0 < len(state["entries"]) <= 256
            or not isinstance(state["directories"], list) or len(state["directories"]) > 256 * 512):
        fail(125, "invalid mutation journal")
    paths, temporaries = set(), set()
    for index, entry in enumerate(state["entries"]):
        if (not isinstance(entry, dict) or set(entry) != {"path", "base", "before_mode", "after", "temporary", "backup"}
                or not digest(entry["base"]) or not digest(entry["after"])
                or entry["backup"] != "base-" + str(index)
                or not isinstance(entry["temporary"], str)
                or not re.fullmatch(r"\.smithers-mutation-[0-9a-f]{32}", entry["temporary"])):
            fail(125, "invalid mutation journal entry")
        mutation_path(entry["path"])
        mode = entry["before_mode"]
        if (mode is not None if entry["base"] == "absent" else type(mode) is not int or not 0 <= mode <= 0o777):
            fail(125, "invalid mutation journal mode")
        if entry["path"] in paths or entry["temporary"] in temporaries:
            fail(125, "duplicate mutation journal path")
        paths.add(entry["path"])
        temporaries.add(entry["temporary"])
    for path in paths:
        parts = path.split("/")
        if any("/".join(parts[:i]) in paths for i in range(1, len(parts))):
            fail(3, "mutation paths overlap")
    directories = set()
    for path in state["directories"]:
        mutation_path(path)
        if path in directories or not any(entry.startswith(path + "/") for entry in paths):
            fail(125, "invalid mutation journal directory")
        directories.add(path)


def recover_mutation(root, journal, limit):
    """Private worker phase; qualified writer exclusion MUST remain held.

    Only the coordinator invokes this after collecting any old mutation worker
    and freezing all writers. Root never reads the journal. Startup recovery
    cannot supply new file mutations or select a journal or workspace path.
    """
    mutation_identity(journal, limit)
    body, _ = mutation_read(journal, "state.json", 1 << 20)
    if body is None:
        # No workspace operation precedes the first durable prepared state.
        return "aborted"
    try:
        state = json.loads(body)
    except (ValueError, UnicodeError):
        fail(125, "unreadable mutation journal")
    mutation_validate_state(state)
    if state["phase"] != "prepared":
        # A settled journal must never reapply bytes after a possible thaw.
        os.fsync(journal)
        return state["phase"]
    originals, observed, total = [], [], 0
    # Validate every backup and current path before restoring even the first.
    for entry in state["entries"]:
        original = None
        if entry["base"] != "absent":
            original, _ = mutation_read(journal, entry["backup"], limit)
            if original is None or mutation_digest(original) != entry["base"]:
                fail(125, "mutation backup does not match its base")
            total += len(original)
            if total > limit:
                fail(4, "mutation backups exceed byte limit")
        parent = mutation_parent(root, entry["path"])
        try:
            if parent is None and original is not None:
                fail(125, "mutation recovery ancestor is missing")
            current, mode = mutation_read(parent, entry["path"].split("/")[-1], limit)
            if mutation_digest(current) not in (entry["base"], entry["after"]):
                fail(125, "mutation recovery found an outside write")
            observed.append((mutation_digest(current), mode))
            originals.append(original)
        finally:
            if parent is not None:
                os.close(parent)
    for entry, original, (current, mode) in zip(state["entries"], originals, observed):
        parent = mutation_parent(root, entry["path"])
        if parent is None:
            continue
        try:
            leaf, temporary = entry["path"].split("/")[-1], entry["temporary"]
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
            if original is None:
                if current != "absent":
                    os.unlink(leaf, dir_fd=parent)
            elif current != entry["base"] or mode != entry["before_mode"]:
                mutation_write_new(parent, temporary, original, entry["before_mode"])
                os.replace(temporary, leaf, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(parent)
    for path in sorted(state["directories"], key=lambda value: (-value.count("/"), value)):
        parent = mutation_parent(root, path)
        if parent is None:
            continue
        try:
            try:
                os.rmdir(path.split("/")[-1], dir_fd=parent)
            except FileNotFoundError:
                pass
            os.fsync(parent)
        finally:
            os.close(parent)
    state["phase"] = "aborted"
    mutation_save_state(journal, state)
    return "aborted"


def apply_mutation_batch(root, journal, changes, limit):
    """Prepare, apply and durably settle one batch in the dropped worker.

    The caller must hold qualified exclusion through this call AND recovery;
    these descriptor operations alone cannot stop outside writers. No production
    provider invokes this candidate until the coordinator and security gates pass.
    Changes are private normalized tuples (relative path, base, bytes-or-None,
    mode-or-None), adapted from the existing file-tool contract rather than a new API.
    None preserves existing permissions (0644 for a newly created file).
    """
    mutation_identity(journal, limit)
    if not isinstance(changes, list) or not 0 < len(changes) <= 256:
        fail(3, "invalid mutation batch")
    if os.listdir(journal):
        fail(125, "mutation journal requires recovery")
    entries, originals, directories, total_before, total_after = [], [], set(), 0, 0
    for index, change in enumerate(changes):
        if not isinstance(change, tuple) or len(change) != 4:
            fail(3, "invalid mutation change")
        path, base, body, mode = change
        parts = mutation_path(path)
        if ((base != "absent" and (not isinstance(base, str) or not re.fullmatch(r"[0-9a-f]{64}", base)))
                or (body is not None and not isinstance(body, bytes))
                or (mode is not None and (type(mode) is not int or not 0 <= mode <= 0o777))):
            fail(3, "invalid mutation change")
        parent = mutation_parent(root, path)
        try:
            original, before_mode = mutation_read(parent, parts[-1], limit)
        finally:
            if parent is not None:
                os.close(parent)
        current = mutation_digest(original)
        if current != base:
            raise MutationStale(path, current)
        total_before += len(original) if original is not None else 0
        total_after += len(body) if body is not None else 0
        if max(total_before, total_after) > limit:
            fail(4, "mutation batch exceeds byte limit")
        # Discover all absent ancestors without creating anything during validation.
        parent = os.dup(root)
        missing = False
        try:
            for i, part in enumerate(parts[:-1]):
                if not missing:
                    try:
                        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    except FileNotFoundError:
                        missing = True
                    else:
                        os.close(parent)
                        parent = child
                if missing and body is not None:
                    directories.add("/".join(parts[:i + 1]))
        finally:
            os.close(parent)
        entries.append({"path": path, "base": base, "before_mode": before_mode,
                        "after": mutation_digest(body), "temporary": ".smithers-mutation-" + secrets.token_hex(16),
                        "backup": "base-" + str(index)})
        originals.append(original)
    state = {"version": 1, "phase": "prepared", "entries": entries,
             "directories": sorted(directories, key=lambda value: (value.count("/"), value))}
    mutation_validate_state(state)
    for entry, original in zip(entries, originals):
        if original is not None:
            mutation_write_new(journal, entry["backup"], original, 0o600)
    mutation_save_state(journal, state)
    try:
        for path in state["directories"]:
            parent = mutation_parent(root, path)
            if parent is None:
                fail(125, "mutation ancestor disappeared")
            try:
                os.mkdir(path.split("/")[-1], 0o775, dir_fd=parent)
                os.fsync(parent)
            finally:
                os.close(parent)
        for entry, (_, _, body, mode) in zip(entries, changes):
            parent = mutation_parent(root, entry["path"])
            if parent is None and body is None:
                continue
            if parent is None:
                fail(125, "mutation ancestor disappeared")
            try:
                leaf, temporary = entry["path"].split("/")[-1], entry["temporary"]
                if body is None:
                    if entry["base"] != "absent":
                        os.unlink(leaf, dir_fd=parent)
                else:
                    after_mode = mode if mode is not None else (entry["before_mode"] if entry["before_mode"] is not None else 0o644)
                    mutation_write_new(parent, temporary, body, after_mode)
                    os.replace(temporary, leaf, src_dir_fd=parent, dst_dir_fd=parent)
                os.fsync(parent)
            finally:
                if parent is not None:
                    os.close(parent)
        state["phase"] = "committed"
        mutation_save_state(journal, state)
    except BaseException:
        recover_mutation(root, journal, limit)
        raise
    return {entry["path"]: entry["after"] for entry in entries}


def fs_compare_write(root, path, mode, base, limit):
    """Candidate S1 exchange; NOT an enabled/qualified runtime capability.

    The installed runtime deliberately does not expose WorkspaceCompareWriter
    until fresh/retained-machine and concurrent ancestor/rollback qualification.
    No lexical host read followed by an unconditional write is used here.
    """
    if os.geteuid() == 0:
        fail(125, "compare-write requires unprivileged identity")
    if base != "absent" and not re.fullmatch(r"[0-9a-f]{64}", base):
        fail(3, "invalid base_digest")
    if not 0 < limit <= 64 << 20:
        fail(3, "invalid compare-write limit")
    parts = path.split("/")
    if not parts or any(p in ("", ".", "..") for p in parts) or "\x00" in path:
        fail(3, "workspace mutation path escapes or replaces root")
    # Reject symlinks in every ancestor and pin the directory used by all
    # exchanges. Missing parents are refused without creating directories.
    parent = safe_directory(root, create=False)
    temporary = None
    fd = None
    preserve = False
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        leaf = parts[-1]
        current = file_digest_at(parent, leaf, limit)
        if current != base:
            fail(6, "stale:" + current)
        data = sys.stdin.buffer.read(limit + 1)
        if len(data) > limit:
            fail(4, "workspace file exceeds write limit")
        temporary = ".smithers-write-" + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        os.fchmod(fd, mode & 0o777)
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
        os.close(fd)
        fd = None
        try:
            exchange_file(parent, temporary, leaf, 1 if base == "absent" else 2)
        except FileExistsError:
            fail(6, "stale:" + file_digest_at(parent, leaf, limit))
        except FileNotFoundError:
            fail(6, "stale:absent")
        if base == "absent":
            temporary = None
        else:
            # Keep displaced bytes on any failure, including a failed rollback.
            preserve = True
            try:
                displaced = file_digest_at(parent, temporary, limit)
            except BaseException:
                exchange_file(parent, temporary, leaf, 2)
                preserve = False
                raise
            if displaced != base:
                exchange_file(parent, temporary, leaf, 2)
                preserve = False
                os.fsync(parent)
                fail(6, "stale:" + displaced)
            preserve = False
        os.fsync(parent)
        sys.stdout.write(json.dumps({"digest": hashlib.sha256(data).hexdigest()}))
    finally:
        if fd is not None:
            os.close(fd)
        if temporary is not None and not preserve:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        os.close(parent)


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

    # Both sockets disable Nagle. A frame forwarded in two sends otherwise
    # waits for the peer's delayed ACK: 4 KiB frames stalled ~50 ms (#3749).
    def serve(client):
        try:
            client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            upstream = socket.create_connection((host, port), timeout=10)
            upstream.settimeout(None)
            upstream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
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
                        # Any chmod of an overlay lower file copies the whole file
                        # up and fsyncs it; change only files with set-id bits.
                        if current.st_mode & 0o6000:
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


def setup(user, uid, directories, *, create_home=True):
    # Only the host's allocated identity may reach this function. Account-only
    # boot provisioning must not create a member home before their first session.
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
        # useradd --user-group may silently choose a different primary gid
        # when uid 20000 meets the already allocated team gid. Bind it exactly.
        if uid != 20000:
            try:
                primary = grp.getgrgid(uid)
            except KeyError:
                try:
                    grp.getgrnam(user)
                except KeyError:
                    pass
                else:
                    fail(3, "allocated group name already exists")
                subprocess.run(["/usr/sbin/groupadd", "--gid", str(uid), "--", user],
                               check=True, env=environment)
            else:
                if primary.gr_name != user:
                    fail(3, "allocated gid already exists")
        subprocess.run(["/usr/sbin/useradd", "--uid", str(uid), "--gid", str(uid),
                        "--groups", "team", "--no-create-home", "--home-dir", home,
                        "--shell", "/bin/bash", "--", user], check=True, env=environment)
        entry = pwd.getpwnam(user)
    entry = assigned_identity(user, uid)
    if not create_home:
        return
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


def install_coding_binding(config):
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

    parent_fd = protected_directory(("etc", "smithers"), create=True)
    temporary = None
    try:
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
        os.close(parent_fd)


def valid_digest(digest):
    return isinstance(digest, str) and len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)


def coding_program_name(name):
    if name not in CODING_PROGRAM_NAMES:
        fail(3, "coding program name is not approved")
    return name


def coding_helper_current(digest, name=CODING_HELPER_NAME):
    if os.geteuid() != ROOT_UID:
        fail(3, "coding helper check requires root")
    if not valid_digest(digest):
        fail(3, "coding helper digest is invalid")
    return protected_file_current(CODING_HELPER_DIRECTORY, coding_program_name(name), digest, MANAGED_ARTIFACT_LIMIT)


def install_coding_helper(digest, body, name=CODING_HELPER_NAME):
    if os.geteuid() != ROOT_UID:
        fail(3, "coding helper requires root")
    if not valid_digest(digest):
        fail(3, "coding helper digest is invalid")
    target = coding_program_name(name)
    if (len(body) < 64 or len(body) > MANAGED_ARTIFACT_LIMIT or body[:4] != b"\x7fELF"
            or body[4:6] != b"\x02\x01" or int.from_bytes(body[18:20], "little") != 183):
        fail(3, "coding helper is not Linux arm64")
    install_protected_file(CODING_HELPER_DIRECTORY, target, digest, body, MANAGED_ARTIFACT_LIMIT)


def managed_artifact_request(relative, digest):
    # The adapter sends a manifest path and digest from the approved bundle.
    # Neither can name another directory or skip the byte check.
    if os.geteuid() != ROOT_UID:
        fail(3, "managed artifact requires root")
    if not valid_digest(digest):
        fail(3, "managed artifact digest is invalid")
    parts = relative.split("/") if isinstance(relative, str) else []
    if not 0 < len(parts) <= 8 or not all(valid_id(part) for part in parts):
        fail(3, "managed artifact path is invalid")
    return parts


def artifact_limit(relative):
    return 256 * 1024 * 1024 if relative == "share/cli/linux-arm64.tar.gz" else MANAGED_ARTIFACT_LIMIT


def managed_artifact_mode(relative):
    return 0o644 if relative in ("share/skills/smithers/SKILL.md", "share/cli/linux-arm64.tar.gz") else 0o755


def managed_artifact_current(relative, digest):
    parts = managed_artifact_request(relative, digest)
    return protected_file_current(MANAGED_ARTIFACT_ROOT + tuple(parts[:-1]), parts[-1], digest, artifact_limit(relative), managed_artifact_mode(relative))


def install_managed_artifact(relative, digest, body):
    parts = managed_artifact_request(relative, digest)
    install_protected_file(MANAGED_ARTIFACT_ROOT + tuple(parts[:-1]), parts[-1], digest, body, artifact_limit(relative), managed_artifact_mode(relative))


def protected_directory(names, create):
    # Walk by descriptor from PROTECTED_BASE: the base and every directory
    # below it are root-owned, not group or world writable, and never a
    # symlink, on a fresh machine and on a retained one alike. The returned
    # descriptor is held through the caller's replacement, so a directory
    # swapped after it was checked is never written.
    fd = os.open(PROTECTED_BASE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != ROOT_UID or info.st_mode & 0o022:
            fail(3, "protected directory is not root-owned and protected")
        for name in names:
            if create:
                try:
                    os.mkdir(name, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
            try:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                raise
            except OSError:
                fail(3, "protected directory is a link or not a directory")
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid != ROOT_UID or info.st_mode & 0o022:
                fail(3, "protected directory is not root-owned and protected")
        return fd
    except BaseException:
        os.close(fd)
        raise


def machined_boot_body(body):
    # Host-minted authority only. Root never evaluates an environment, home,
    # command, repository config or branch-produced executable at this door.
    if not 0 < len(body) <= 4096 or b"\x00" in body:
        fail(3, "invalid machined boot authority")
    try:
        lines = body.decode("ascii").splitlines()
        values = dict(line.split("=", 1) for line in lines)
    except (ValueError, UnicodeError):
        fail(3, "invalid machined boot authority")
    if (len(values) != len(lines) or set(values) != {"boot_id", "relay_secret", "credential", "topology"}
            or not re.fullmatch(r"[0-9a-f]{32}", values["boot_id"])
            or not valid_digest(values["relay_secret"]) or not valid_digest(values["credential"])
            or values["topology"] != "relay"):
        fail(3, "invalid machined boot authority")
    return body


def machined_program(digest, body=None):
    if os.geteuid() != 0 or not valid_digest(digest):
        fail(3, "machined installation requires approved root inputs")
    names = ("opt", "smithers", "bin")
    if body is None:
        return protected_file_current(names, "smithers-machined", digest, MANAGED_ARTIFACT_LIMIT)
    if (len(body) < 64 or body[:6] != b"\x7fELF\x02\x01"
            or int.from_bytes(body[18:20], "little") != 183):
        fail(3, "machined executable is not Linux arm64")
    # An active broker must keep the executable bytes its boot admitted. Updating
    # its pathname underneath it would misidentify an older running artifact.
    parent = protected_directory(("run", "smithers", "machined"), create=True)
    lock = None
    try:
        require_secret_tmpfs(parent)
        lock = os.open("broker.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        info = os.fstat(lock)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            fail(3, "untrusted machined startup lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail(3, "machined update requires a stopped broker")
        install_protected_file(names, "smithers-machined", digest, body, MANAGED_ARTIFACT_LIMIT)
    finally:
        if lock is not None:
            os.close(lock)
        os.close(parent)


def start_machined(digest, body):
    if os.geteuid() != 0:
        fail(3, "machined startup requires root")
    machined_boot_body(body)
    if not machined_program(digest):
        fail(3, "installed machined executable differs from bundle")
    prepare_system_identity()
    parent = protected_directory(("run", "smithers", "machined"), create=True)
    lock = None
    try:
        require_secret_tmpfs(parent)
        lock = os.open("broker.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        info = os.fstat(lock)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            fail(3, "untrusted machined startup lock")
        running = False
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            running = True
        try:
            fd = os.open("boot", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            if running:
                fail(3, "serving machined has no boot authority")
        else:
            with os.fdopen(fd, "rb") as handle:
                info = os.fstat(handle.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != 19998
                        or stat.S_IMODE(info.st_mode) != 0o400 or info.st_nlink != 1 or info.st_size > 4096):
                    fail(3, "untrusted machined boot file")
                current = handle.read(4097)
            if running:
                if current != body:
                    fail(3, "serving machined boot differs from host authority")
                return "current"
        temporary = ".boot-" + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(body)
                handle.flush()
                os.fchown(handle.fileno(), 19998, 20000)
                os.fchmod(handle.fileno(), 0o400)
                os.fsync(handle.fileno())
            os.replace(temporary, "boot", src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        state = protected_directory(("var", "lib"), create=False)
        try:
            try:
                os.mkdir("smithers-machined", 0o700, dir_fd=state)
            except FileExistsError:
                pass
            directory = os.open("smithers-machined", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=state)
            try:
                info = os.fstat(directory)
                if info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700:
                    os.fchown(directory, 19998, 20000)
                elif info.st_uid != 19998 or stat.S_IMODE(info.st_mode) != 0o700:
                    fail(3, "untrusted machined state directory")
            finally:
                os.close(directory)
        finally:
            os.close(state)
        admission = protected_directory(("run", "smithers", "admission"), create=True)
        os.close(admission)
        # Preserve the team's live environment. Creation is the empty literal
        # default, never a branch's env.json or caller-selected file.
        env_parent = protected_directory(("run", "smithers"), create=False)
        try:
            try:
                info = os.stat("env", dir_fd=env_parent, follow_symlinks=False)
            except FileNotFoundError:
                put_secret_environment(b"{}")
            else:
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 20000
                        or stat.S_IMODE(info.st_mode) != 0o640 or info.st_nlink != 1):
                    fail(3, "untrusted team environment")
        finally:
            os.close(env_parent)
        # The native broker acquires this same fixed lock before binding its
        # listener. No PID selected by a caller is signalled or reused.
        fcntl.flock(lock, fcntl.LOCK_UN)
        import subprocess
        child = subprocess.Popen(["/opt/smithers/bin/smithers-machined", "broker"],
                                 cwd="/", env={"PATH": "/usr/bin:/bin", "HOME": "/"},
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
        time.sleep(0.05)
        if child.poll() is not None:
            fail(3, "machined broker refused startup")
        return "started"
    finally:
        if lock is not None:
            os.close(lock)
        os.close(parent)


def protected_file_current(names, target, digest, limit, mode=0o755):
    # Whether the root-owned file target under names already holds exactly
    # the approved bytes with mode 0755. Anything but a root-owned regular
    # file there refuses: it is never followed, read or replaced.
    try:
        parent = protected_directory(names, create=False)
    except FileNotFoundError:
        return False
    try:
        try:
            current = os.stat(target, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(current.st_mode) or current.st_uid != ROOT_UID:
            fail(3, "protected file is not a root-owned file")
        try:
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except OSError:
            fail(3, "protected file is not a root-owned file")
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != ROOT_UID:
                fail(3, "protected file is not a root-owned file")
            if stat.S_IMODE(info.st_mode) != mode or info.st_size > limit:
                return False
            checksum = hashlib.sha256()
            remaining = limit + 1
            while remaining:
                chunk = handle.read(min(65536, remaining))
                if not chunk:
                    return checksum.hexdigest() == digest
                checksum.update(chunk)
                remaining -= len(chunk)
            return False
    finally:
        os.close(parent)


def install_protected_file(names, target, digest, body, limit, mode=0o755):
    # Atomically replace target under names with body, mode 0755, only when
    # body is exactly the approved digest: an exclusive no-follow temporary
    # file in the held parent descriptor, then a rename over it.
    if len(body) > limit or hashlib.sha256(body).hexdigest() != digest:
        fail(3, "protected file bytes differ from the approved digest")
    parent = protected_directory(names, create=True)
    temporary = None
    try:
        try:
            current = os.stat(target, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or current.st_uid != ROOT_UID:
                fail(3, "protected file is not a root-owned file")
        except FileNotFoundError:
            pass
        # A leading dot is never a valid target name, so this cannot collide.
        temporary = ".install-" + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        with os.fdopen(fd, "wb") as handle:
            handle.write(body)
            handle.flush()
            os.fchmod(handle.fileno(), mode)
            os.fsync(handle.fileno())
        os.rename(temporary, target, src_dir_fd=parent, dst_dir_fd=parent)
        temporary = None
        os.fsync(parent)
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        os.close(parent)


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


TERMINAL_CLI_ARCHIVE = ("share", "cli", "linux-arm64.tar.gz")


def install_terminal_cli(entry):
    # Archive interpretation and package discovery run only after the uid drop.
    if os.geteuid() != entry.pw_uid or os.geteuid() == 0:
        fail(3, "terminal CLI requires session user")
    try:
        parent = protected_directory(MANAGED_ARTIFACT_ROOT + TERMINAL_CLI_ARCHIVE[:-1], False)
    except FileNotFoundError:
        return
    try:
        fd = os.open(TERMINAL_CLI_ARCHIVE[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != ROOT_UID or
                stat.S_IMODE(info.st_mode) != 0o644 or info.st_nlink != 1 or info.st_size > artifact_limit("share/cli/linux-arm64.tar.gz")):
            fail(3, "untrusted terminal CLI archive")
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
        handle.seek(0)
        import tarfile
        import shutil
        base = os.path.join(entry.pw_dir, ".local", "share", "smithers", "cli")
        directory = safe_directory(base)
        lock = None
        try:
            lock = os.open(".install-lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                           0o600, dir_fd=directory)
            info = os.fstat(lock)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != entry.pw_uid or
                    stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                fail(3, "untrusted terminal CLI installation lock")
            fcntl.flock(lock, fcntl.LOCK_EX)
            target = os.path.join(base, digest)
            try:
                os.mkdir(digest, 0o700, dir_fd=directory)
            except FileExistsError:
                current = os.open(digest, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(current)
            else:
                try:
                    with tarfile.open(fileobj=handle, mode="r:gz") as archive:
                        members = []
                        size = 0
                        for member in archive:
                            size += member.size
                            if len(members) >= 200000 or size > 2 * 1024 * 1024 * 1024:
                                fail(3, "terminal CLI archive exceeds extraction limits")
                            members.append(member)
                        archive.extractall(target, members=members, filter="data")
                    if not os.path.isfile(os.path.join(target, "node_modules", "@smthrs", "cli", "bin", "smithers.mjs")):
                        fail(3, "terminal CLI archive has no CLI")
                    with open(os.path.join(target, "guest-platform.json"), "rb") as marker:
                        if json.load(marker) != {"platform": "linux-arm64", "runtime": "node26"}:
                            fail(3, "terminal CLI archive has wrong architecture")
                except BaseException:
                    shutil.rmtree(target)
                    raise
            temporary = ".current-" + secrets.token_hex(16)
            os.symlink(digest, temporary, dir_fd=directory)
            try:
                os.replace(temporary, "current", src_dir_fd=directory, dst_dir_fd=directory)
            finally:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except FileNotFoundError:
                    pass
        finally:
            if lock is not None:
                os.close(lock)
            os.close(directory)


TERMINAL_SKILL_DIR = "/opt/smithers/bundle/share/skills/smithers"


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
    install_terminal_cli(entry)
    skill = TERMINAL_SKILL_DIR
    if os.path.isfile(skill + "/SKILL.md"):
        home = safe_directory(entry.pw_dir)
        try:
            for relative in (".claude/skills/smithers", ".agents/skills/smithers"):
                parent, leaf = home_parent(home, relative, entry)
                try:
                    try:
                        os.symlink(skill, leaf, dir_fd=parent)
                    except FileExistsError:
                        # Never replace a person's skill or follow its link.
                        pass
                finally:
                    os.close(parent)
        finally:
            os.close(home)
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
    if command == "machined-check" and len(args) == 2:
        print("current" if machined_program(args[1]) else "replace")
        return
    if command == "machined-install" and len(args) == 2:
        machined_program(args[1], sys.stdin.buffer.read(MANAGED_ARTIFACT_LIMIT + 1))
        return
    if command == "machined-start" and len(args) == 2:
        print(start_machined(args[1], sys.stdin.buffer.read(4097)))
        return
    if command == "put-env" and len(args) == 1:
        put_secret_environment(sys.stdin.buffer.read(SECRET_ENV_LIMIT + 1))
        return
    if command == "put-session-binding" and len(args) == 3:
        put_session_binding(args[1], args[2], sys.stdin.buffer.read(256 * 1024 + 1))
        return
    if command == "delete-session-binding" and len(args) == 3:
        delete_session_binding(args[1], args[2])
        return
    if command == "put-member-token" and len(args) == 6:
        entry = session_binding_identity(args[1], args[2])
        put_session_token(args[3], sys.stdin.buffer.read(SESSION_TOKEN_LIMIT + 1), args[4], args[5], args[1], entry.pw_uid)
        return
    if command == "delete-member-token" and len(args) == 5:
        entry = session_binding_identity(args[1], args[2])
        delete_session_token(args[3], args[4], args[1], entry.pw_uid)
        return
    if command == "put-token" and len(args) == 4:
        put_session_token(args[1], sys.stdin.buffer.read(SESSION_TOKEN_LIMIT + 1), args[2], args[3])
        return
    if command == "delete-token" and len(args) == 3:
        delete_session_token(args[1], args[2])
        return
    if command == "coding-helper-check" and len(args) in (2, 3):
        print("current" if coding_helper_current(*args[1:]) else "replace")
        return
    if command == "coding-helper" and len(args) in (2, 3):
        install_coding_helper(args[1], sys.stdin.buffer.read(MANAGED_ARTIFACT_LIMIT + 1), *args[2:])
        return
    if command == "managed-artifact-check" and len(args) == 3:
        print("current" if managed_artifact_current(args[1], args[2]) else "replace")
        return
    if command == "managed-artifact" and len(args) == 3:
        managed_artifact_request(args[1], args[2])
        install_managed_artifact(args[1], args[2], sys.stdin.buffer.read(artifact_limit(args[1]) + 1))
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
    if command == "recover-files" and len(args) == 1:
        # Fixed installed limit; no request operands or stdin are consumed.
        # This never admits a new mutation or opens the compare-write gate.
        sys.exit(coordinate_mutation(None, None, 64 << 20, recover_only=True))
    if command == "kill-all":
        # The mutation worker intentionally lives outside the frozen writer
        # tree. Cancellation must collect it too, without thawing or clearing
        # the journal fence; recovery owns that decision.
        # Only the coordinator holding the exclusive lock removes/reuses this
        # fixed name. A concurrent cancellation may kill, but must not rmdir a
        # later transaction's replacement after the original worker is gone.
        cgroup_kill(os.path.join(MUTATION_CGROUP_ROOT, "active"), mutation=True, collect=False)
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
        if args[1] != "agent":
            fail(125, "invalid fs identity")
        if os.geteuid() == 0:
            # Operand lookup and stdin consumption happen only in the admitted
            # unprivileged child, including read/remove and unavailable writes.
            sys.exit(run_managed_child("fs-" + secrets.token_hex(16), lambda _entry: run_fs(args)))
        run_fs(args)
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
    if command == "setup-member" and len(args) == 4:
        # Root transport only; no repository request selects an allocation.
        if (args[1] in ("root", "agent", "machined")
                or not re.fullmatch(r"[a-z0-9_-]{1,32}", args[1])
                or not re.fullmatch(r"[0-9]{5,10}", args[2])
                or not 20000 <= int(args[2]) <= 2147483647
                or args[3] not in ("account", "home")):
            fail(3, "invalid member setup identity")
        sys.exit(run_managed_child("member-root-" + secrets.token_hex(16),
                                   lambda _entry: setup(args[1], int(args[2]), [],
                                                        create_home=args[3] == "home"),
                                   privileged=True))
    if command == "setup" and len(args) >= 3:
        if args[1] != "agent":
            fail(3, "member provisioning requires approved roster and broker")
        # Both phases join the writer tree; only the bounded metadata operation
        # retains root. Home/cache operands are consumed after a separate drop.
        code = run_managed_child("setup-root-" + secrets.token_hex(16),
                                 lambda _entry: setup(args[1], int(args[2]), args[3:]),
                                 privileged=True)
        if code:
            sys.exit(code)
        sys.exit(run_managed_child("setup-" + secrets.token_hex(16), home_defaults))
    fail(125, "unknown subcommand %r" % command)


if __name__ == "__main__":
    main(sys.argv[1:])
