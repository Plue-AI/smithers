"""Main-installed root fixture preparation/independent observation only.

No caller path, code, user or signal selector. The signed installed provider
selects one of these literal fixture operations in its own fresh disposable VM.
"""
import hashlib
import fcntl
import json
import os
from pathlib import Path
import signal
import select
import time
from datetime import datetime, timezone
import stat
import subprocess
import sys

OUTSIDE = Path("/var/tmp/trm06-outside")


def fingerprint():
    # Hash and inspect one held inode. A symlink, FIFO or replacement must not
    # redirect this root observer or combine metadata and bytes from two files.
    fd = os.open(OUTSIDE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("untrusted outside sentinel")
        if info.st_size > 65536:
            raise ValueError("oversized outside sentinel")
        data = source.read(info.st_size + 1)
        if len(data) != info.st_size:
            raise ValueError("outside sentinel size changed during observation")
        digest = hashlib.sha256(data).hexdigest()
        after = os.fstat(source.fileno())
        current = OUTSIDE.stat(follow_symlinks=False)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid,
                                  value.st_mode, value.st_nlink, value.st_size,
                                  value.st_mtime_ns, value.st_ctime_ns)
        if identity(info) != identity(after) or identity(after) != identity(current):
            raise ValueError("outside sentinel changed during observation")
        return {"sha256": digest, "uid": info.st_uid, "mode": stat.S_IMODE(info.st_mode)}


def cgroup_parent():
    # O_NOFOLLOW on the leaf alone would still follow a replaced ancestor.
    # Observe only the literal subtree reached through held directory inodes.
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for name in ("sys", "fs", "cgroup", "smithers", "sessions"):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def sample():
    processes = []
    supervisors = []
    supervisor_inputs = []
    for name in os.listdir("/proc"):
        if not name.isdecimal():
            continue
        try:
            fields = dict(line.split(":", 1) for line in Path("/proc", name, "status").read_text().splitlines() if ":" in line)
            cgroup = Path("/proc", name, "cgroup").read_text()
            if "20001" in fields["Uid"].split() or "/smithers/sessions/" in cgroup:
                processes.append({"pid": int(name), "uid": fields["Uid"], "gid": fields["Gid"], "groups": fields["Groups"], "state": fields["State"], "cgroup": cgroup})
            if fields["Uid"].split() == ["0"] * 4:
                with open(f"/proc/{name}/cmdline", "rb") as source:
                    argv = source.read(4097).split(b"\0")
                if argv[:2] == [b"/opt/smithers/prototype/supervisor", b"--serve"]:
                    supervisors.append(int(name))
                    with open(f"/proc/{name}/environ", "rb") as source:
                        environment = source.read(4097)
                    if len(environment) > 4096:
                        raise ValueError("oversized supervisor environment")
                    with open(f"/proc/{name}/exe", "rb") as source:
                        executable_sha256 = hashlib.file_digest(source, "sha256").hexdigest()
                    supervisor_inputs.append({"pid": int(name), "uid": fields["Uid"], "environment": environment.decode("ascii").split("\0")[:-1], "sha256": executable_sha256})
        except (FileNotFoundError, ProcessLookupError):
            pass
    cgroups = {}
    root = cgroup_parent()
    try:
        for name in os.listdir(root):
            if not name.startswith("s-"):
                continue
            if len(name) != 18 or any(c not in "0123456789abcdef" for c in name[2:]):
                raise ValueError("invalid observed cgroup")
            group = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            try:
                fd = os.open("cgroup.events", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=group)
                with os.fdopen(fd) as events:
                    cgroups[name] = events.read()
            finally:
                os.close(group)
    finally:
        os.close(root)
    return {"processes": processes, "supervisors": supervisors, "supervisor_inputs": supervisor_inputs, "cgroups": cgroups, "outside": fingerprint() if OUTSIDE.exists() else None}


OBSERVER = Path("/run/smithers/trm06/observer.json")


def arm_observer():
    # Hold kernel events descriptors before revocation/removal. No member path
    # or supervisor-reported population participates in this observation.
    handles = {}
    root = cgroup_parent()
    try:
        for name in os.listdir(root):
            if not name.startswith("s-"):
                continue
            if len(name) != 18 or any(c not in "0123456789abcdef" for c in name[2:]):
                raise ValueError("invalid observed cgroup")
            group = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            try:
                handles[name] = os.open("cgroup.events", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=group)
            finally:
                os.close(group)
    finally:
        os.close(root)
    if not handles:
        raise ValueError("no live cgroups to observe")
    output = os.open(OBSERVER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    # Keep readers out until the detached writer has flushed the entire receipt.
    # The inherited open-file description retains this lock across fork.
    fcntl.flock(output, fcntl.LOCK_EX)
    read_ready, write_ready = os.pipe()
    pid = os.fork()
    if pid:
        os.close(write_ready)
        os.close(output)
        for fd in handles.values():
            os.close(fd)
        try:
            if not select.select([read_ready], [], [], 1)[0] or os.read(read_ready, 1) != b'1':
                raise ValueError("observer did not arm")
        finally:
            os.close(read_ready)
        print(json.dumps({"armed": True, "observer": pid}))
        return
    os.close(read_ready)
    os.setsid()
    started = time.monotonic()
    rows = []
    zero = {}
    prior = {}
    last_full = started
    try:
        os.write(write_ready, b'1')
        os.close(write_ready)
        # Detached observer must not retain the msb exec output pipes.
        for fd in (0, 1, 2):
            try:
                os.close(fd)
            except OSError:
                pass
        while time.monotonic() - started < 6:
            utc = datetime.now(timezone.utc).isoformat()
            events = {}
            for name, fd in handles.items():
                try:
                    raw = os.pread(fd, 4097, 0).decode('ascii')
                    if len(raw) > 4096:
                        raise ValueError("oversized cgroup events")
                    events[name] = raw
                    if "populated 0" in raw.splitlines() and name not in zero:
                        zero[name] = utc
                except OSError as error:
                    events[name] = {"error": str(error)}
            now = time.monotonic()
            changed = {name: value for name, value in events.items() if prior.get(name) != value}
            if now - last_full >= .1:
                changed = events
                last_full = now
            if changed:
                rows.append({"utc": utc, "monotonic": now, "events": changed})
            prior = events
            if len(zero) == len(handles):
                break
            time.sleep(.002)
        body = json.dumps({"zero": zero, "groups": list(handles), "samples": rows}).encode()
        view = memoryview(body)
        while view:
            written = os.write(output, view)
            if written <= 0:
                raise ValueError("observer receipt write stalled")
            view = view[written:]
        os.fsync(output)
    finally:
        os.close(output)
        for fd in handles.values():
            os.close(fd)
        os._exit(0)


def observed_drain():
    # The observer is our fixed root-only file in this disposable VM. Missing,
    # partial or errored observations remain absent; removal never means zero.
    for _ in range(300):
        fd = os.open(OBSERVER, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as source:
            try:
                fcntl.flock(source.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                time.sleep(.02)
                continue
            info = os.fstat(source.fileno())
            if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or not stat.S_ISREG(info.st_mode):
                raise ValueError("untrusted observer output")
            raw = source.read(4 * 1024 * 1024 + 1)
        if raw:
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError("oversized observer output")
            result = json.loads(raw)
            # Each completed observation is preserved by the host campaign.
            # Consume only this fixed protected inode so restart can arm a new
            # observer before the subsequent revocation in the same fresh VM.
            current = OBSERVER.stat(follow_symlinks=False)
            if current.st_ino != info.st_ino or current.st_dev != info.st_dev:
                raise ValueError("observer replaced during read")
            os.unlink(OBSERVER)
            return result
        time.sleep(.02)
    raise ValueError("independent observer did not finish")


# Literal main-installed targets only, never member-supplied filesystem authority.
STARTUP_MUTATIONS = {
    "boot-symlink": ("/run/smithers/trm06/boot.json", "symlink"),
    "boot-writable": ("/run/smithers/trm06/boot.json", "writable"),
    "supervisor-replaced": ("/opt/smithers/prototype/supervisor", "canary"),
}
for label, target in (("boot", "/run/smithers/trm06/boot.json"),
                      ("supervisor", "/opt/smithers/prototype/supervisor")):
    for mutation in ("hardlink", "fifo", "directory"):
        STARTUP_MUTATIONS["startup-" + label + "-" + mutation] = (target, mutation)
STARTUP_MUTATIONS["startup-boot-identity"] = ("/run/smithers/trm06/boot.json", "identity")
for label, target in (("boot-parent", "/run/smithers/trm06"),
                      ("boot-ancestor", "/run/smithers"),
                      ("supervisor-parent", "/opt/smithers/prototype"),
                      ("supervisor-ancestor", "/opt/smithers")):
    for mutation in ("symlink", "clone", "writable"):
        STARTUP_MUTATIONS["startup-" + label + "-" + mutation] = (target, mutation)


def mutate_startup(target, mutation):
    # Called only with the literal table above by installed root fixture dispatch.
    # Ordinary-file tests reuse these syscalls; they confer no root authority.
    import shutil
    path = Path(target)
    if mutation == "writable":
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            os.fchmod(fd, 0o777 if stat.S_ISDIR(os.fstat(fd).st_mode) else 0o666)
        finally:
            os.close(fd)
    elif mutation == "hardlink":
        os.link(path, path.with_name(path.name + "-original"), follow_symlinks=False)
    elif mutation == "identity":
        # Valid but different authority at the same inode: restart must not
        # silently select a new boot id/secret even when modes remain trusted.
        fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "r+b") as output:
            data = json.loads(output.read(4097))
            data["boot"][0] ^= 1
            output.seek(0)
            output.write(json.dumps(data, separators=(",", ":")).encode())
            output.truncate()
    else:
        original = path.with_name(path.name + "-original")
        path.rename(original)
        if mutation == "symlink":
            path.symlink_to(original, target_is_directory=original.is_dir())
        elif mutation == "clone":
            shutil.copytree(original, path, symlinks=True)
        elif mutation == "fifo":
            os.mkfifo(path, 0o400 if path.name == "boot.json" else 0o755)
        elif mutation == "directory":
            path.mkdir(mode=0o400 if path.name == "boot.json" else 0o755)
        elif mutation == "canary":
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
            with os.fdopen(fd, "wb") as output:
                output.write(b"#!/bin/sh\nprintf canary >> /var/tmp/trm06-outside\n")
                os.fchmod(output.fileno(), 0o755)
        else:
            raise ValueError("unknown startup mutation")


def startup_log():
    # The init log stays on its original inode when a boot ancestor is moved.
    # Refuse every symlink in this fixed independent observation walk.
    for path in ("/run/smithers-original/trm06/init.log",
                 "/run/smithers/trm06-original/init.log",
                 "/run/smithers/trm06/init.log"):
        parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in Path(path).parts[1:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent)
                parent = child
            return os.open("init.log", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            pass
        finally:
            os.close(parent)
    raise ValueError("independent init log unavailable")


def main():
    if os.getuid() != 0 or os.geteuid() != 0:
        raise ValueError("root fixture requires installed provider")
    operation = sys.argv[1] if len(sys.argv) == 2 else ""
    if operation == "arm":
        arm_observer()
        return
    if operation == "drain":
        print(json.dumps({"sample": sample(), "observation": observed_drain() if OBSERVER.exists() else None}))
        return
    if operation == "landlock-kernel":
        # Independent kernel capability observation, not supervisor policy and
        # not a seccomp injection. Linux ARM64/x86-64 assign this syscall 444.
        import ctypes
        kernel = ctypes.CDLL(None, use_errno=True)
        ctypes.set_errno(0)
        abi = kernel.syscall(ctypes.c_long(444), ctypes.c_void_p(0), ctypes.c_size_t(0), ctypes.c_uint(1))
        print(json.dumps({"abi": abi, "errno": ctypes.get_errno(), "kernel": os.uname().release, "outside": fingerprint()}))
        return
    if operation == "fingerprint":
        print(json.dumps({"outside": fingerprint()}))
        return
    if operation == "sample":
        print(json.dumps(sample()))
        return
    if operation in STARTUP_MUTATIONS:
        observed = sample()
        if len(observed["supervisors"]) != 1:
            raise ValueError("not exactly one owned supervisor")
        pid = observed["supervisors"][0]
        process = os.pidfd_open(pid, 0)
        try:
            if os.readlink(f"/proc/{pid}/exe") != "/opt/smithers/prototype/supervisor":
                raise ValueError("supervisor executable mismatch")
            target, mutation = STARTUP_MUTATIONS[operation]
            mutate_startup(target, mutation)
            signal.pidfd_send_signal(process, signal.SIGKILL)
            if not select.select([process], [], [], 1)[0]:
                raise ValueError("owned supervisor did not exit")
        finally:
            os.close(process)
        print(json.dumps({"replaced": operation, "killed": pid, "before": observed, "outside": fingerprint()}))
        return
    if operation == "device-regular":
        # Main-installed fixture only, in its own disposable VM. Replace a fixed
        # device with an ordinary writable file; the dropped launch must refuse
        # before any member argv runs. Preserve the original node for evidence.
        dev = os.open("/dev", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.stat("zero", dir_fd=dev, follow_symlinks=False)
            if info.st_uid != 0 or not stat.S_ISCHR(info.st_mode) or info.st_rdev != os.makedev(1, 5):
                raise ValueError("unexpected initial zero device")
            os.rename("zero", "trm06-zero-original", src_dir_fd=dev, dst_dir_fd=dev)
            fd = os.open("zero", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o666, dir_fd=dev)
            with os.fdopen(fd, "wb") as output:
                output.write(b"device-fixture\x00")
                os.fchmod(output.fileno(), 0o666)
        finally:
            os.close(dev)
        print(json.dumps({"device_replaced": True, "outside": fingerprint()}))
        return
    if operation in ("cgroup-live-ancestor-replaced", "cgroup-live-ancestor-writable", "cgroup-live-ancestor-owner"):
        parent = os.open("/sys/fs/cgroup", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            child = os.open("smithers", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                info = os.fstat(child)
                if info.st_uid != 0 or info.st_mode & 0o022:
                    raise ValueError("untrusted initial cgroup ancestor")
                if operation == "cgroup-live-ancestor-owner":
                    os.fchown(child, 20001, 20001)
                elif operation == "cgroup-live-ancestor-writable":
                    os.fchmod(child, 0o777)
                else:
                    os.rename("smithers", "trm06-smithers-original", src_dir_fd=parent, dst_dir_fd=parent)
                    os.mkdir("smithers", 0o755, dir_fd=parent)
                    replacement = os.open("smithers", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    try:
                        # Move the exact original sessions inode into the new
                        # ancestor. Leaf-only identity checks would miss this.
                        os.rename("sessions", "sessions", src_dir_fd=child, dst_dir_fd=replacement)
                    finally:
                        os.close(replacement)
            finally:
                os.close(child)
        finally:
            os.close(parent)
        print(json.dumps({"cgroup_replaced": operation, "outside": fingerprint()}))
        return
    if operation in ("cgroup-live-child-replaced", "cgroup-live-child-writable", "cgroup-live-child-owner"):
        parent = os.open("/sys/fs/cgroup/smithers/sessions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            names = sorted(os.listdir(parent))
            if not names or any(len(name) != 18 or not name.startswith("s-") or any(c not in "0123456789abcdef" for c in name[2:]) for name in names):
                raise ValueError("invalid live cgroup children")
            for name in names:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    info = os.fstat(child)
                    if info.st_uid != 0 or info.st_mode & 0o022:
                        raise ValueError("untrusted initial live cgroup")
                    if operation == "cgroup-live-child-owner":
                        os.fchown(child, 20001, 20001)
                    elif operation == "cgroup-live-child-writable":
                        os.fchmod(child, 0o777)
                    else:
                        os.rename(name, "trm06-original-" + name, src_dir_fd=parent, dst_dir_fd=parent)
                        os.mkdir(name, 0o755, dir_fd=parent)
                finally:
                    os.close(child)
        finally:
            os.close(parent)
        print(json.dumps({"cgroup_replaced": operation, "outside": fingerprint()}))
        return
    if operation in ("cgroup-writable", "cgroup-live-parent-writable", "cgroup-live-parent-owner"):
        parent = os.open("/sys/fs/cgroup/smithers/sessions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if operation == "cgroup-live-parent-owner":
                os.fchown(parent, 20001, 20001)
            else:
                os.fchmod(parent, 0o777)
        finally:
            os.close(parent)
        print(json.dumps({"cgroup_parent_writable": True, "outside": fingerprint()}))
        return
    if operation in ("cgroup-parent-replaced", "cgroup-child-writable", "cgroup-live-parent-replaced"):
        # Only the installed fixture may replace this fixed disposable subtree.
        # Keep the original inode for independent evidence; never redirect a kill
        # to a member-selected path.
        if operation in ("cgroup-parent-replaced", "cgroup-live-parent-replaced"):
            parent = os.open("/sys/fs/cgroup/smithers", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.rename("sessions", "trm06-sessions-original", src_dir_fd=parent, dst_dir_fd=parent)
                os.mkdir("sessions", 0o755, dir_fd=parent)
                replacement = os.open("sessions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    # Valid ownership/mode must not conceal inode replacement.
                    os.fchmod(replacement, 0o755)
                finally:
                    os.close(replacement)
            finally:
                os.close(parent)
        else:
            parent = os.open("/sys/fs/cgroup/smithers/sessions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.mkdir("s-0000000000000001", 0o755, dir_fd=parent)
                child = os.open("s-0000000000000001", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    os.fchmod(child, 0o777)
                finally:
                    os.close(child)
            finally:
                os.close(parent)
        print(json.dumps({"cgroup_replaced": operation, "outside": fingerprint()}))
        return
    if operation == "cleanup-poison":
        parent = os.open("/sys/fs/cgroup/smithers/sessions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.mkdir("TRM06-invalid-child", 0o755, dir_fd=parent)
        finally:
            os.close(parent)
        print(json.dumps({"cleanup_poisoned": True, "outside": fingerprint()}))
        return
    if operation == "boundary-sample":
        marker = Path("/workspace/trm06-member-canary")
        logfd = startup_log()
        with os.fdopen(logfd, "rb") as log:
            info = os.fstat(log.fileno())
            if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("untrusted init log")
            data = log.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError("oversized init log")
        print(json.dumps({"member_canary_exists": marker.exists() or marker.is_symlink(), "init_log": data.decode("utf-8", "strict"), "sample": sample(), "outside": fingerprint()}))
        return
    if operation == "restart":
        observed = sample()
        if len(observed["supervisors"]) != 1:
            raise ValueError("not exactly one owned supervisor")
        pid = observed["supervisors"][0]
        # This is the provider's own disposable supervisor, never an arbitrary
        # PID or member-selected process. Validate its exact installed executable.
        process = os.pidfd_open(pid, 0)
        try:
            if os.readlink(f"/proc/{pid}/exe") != "/opt/smithers/prototype/supervisor":
                raise ValueError("supervisor executable mismatch")
            signal.pidfd_send_signal(process, signal.SIGKILL)
            if not select.select([process], [], [], 1)[0]:
                raise ValueError("owned supervisor did not exit")
        finally:
            os.close(process)
        print(json.dumps({"killed": pid, "before": observed}))
        return
    if operation not in ("positive", "race-parent", "poison-imports", "symlink-opt", "symlink-run", "existing-prototype"):
        raise ValueError("unknown fixture")
    # Fresh disposable VM only, before sessions exist. The fixture's permitted
    # outside write would succeed under Ben's Unix permissions; Landlock must
    # still reject it. No retained file is repaired or followed.
    fd = os.open(OUTSIDE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    with os.fdopen(fd, "wb") as output:
        output.write(b"outside-fixture\x00")
        os.fchmod(output.fileno(), 0o640)
    os.chown(OUTSIDE, 20001, 20001)
    if operation == "poison-imports":
        for name in ["sitecustomize.py", "json.py", "subprocess.py"]:
            path = Path("/workspace", name)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
            with os.fdopen(fd, "wb") as output:
                output.write(b"open('/var/tmp/trm06-outside','ab').write(b'canary')\n")
            os.chown(path, 20001, 20001)
    if operation == "race-parent":
        os.chmod("/opt/smithers", 0o777)
        def drop():
            os.setgroups([20000])
            os.setresgid(20001, 20001, 20001)
            os.setresuid(20001, 20001, 20001)
            if os.getresuid() != (20001, 20001, 20001) or os.getresgid() != (20001, 20001, 20001) or os.getgroups() != [20000]:
                os._exit(78)
        race = "import os,time\nfor i in range(10000):\n try: os.unlink('/opt/smithers/prototype')\n except FileNotFoundError: pass\n os.symlink('/var/tmp','/opt/smithers/prototype')\n time.sleep(.001)\n"
        subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-c", race], preexec_fn=drop, env={"PATH": "/usr/bin:/bin"}, cwd="/", stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    if operation == "symlink-opt":
        # Keep the existing shared adapter install intact. Poison only the
        # prototype destination, a member/replaced entry the installer refuses.
        os.symlink("/var/tmp", "/opt/smithers/prototype")
    elif operation == "symlink-run":
        os.makedirs("/run/smithers", mode=0o755, exist_ok=True)
        os.symlink("/var/tmp", "/run/smithers/trm06")
    elif operation == "existing-prototype":
        os.mkdir("/opt/smithers/prototype", 0o755)
        fd = os.open("/opt/smithers/prototype/supervisor", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o755)
        with os.fdopen(fd, "wb") as output:
            output.write(b"#!/bin/sh\nprintf canary >> /var/tmp/trm06-outside\n")
    print(json.dumps({"outside": fingerprint()}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"class":"unavailable","code":"prototype_authority_unavailable"}', file=sys.stderr)
        sys.exit(78)
