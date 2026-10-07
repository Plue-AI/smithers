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
    info = OUTSIDE.stat(follow_symlinks=False)
    return {"sha256": hashlib.sha256(OUTSIDE.read_bytes()).hexdigest(), "uid": info.st_uid, "mode": stat.S_IMODE(info.st_mode)}


def sample():
    processes = []
    supervisors = []
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
        except (FileNotFoundError, ProcessLookupError):
            pass
    cgroups = {}
    root = os.open("/sys/fs/cgroup/smithers/sessions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
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
    return {"processes": processes, "supervisors": supervisors, "cgroups": cgroups, "outside": fingerprint() if OUTSIDE.exists() else None}


OBSERVER = Path("/run/smithers/trm06/observer.json")


def arm_observer():
    # Hold kernel events descriptors before revocation/removal. No member path
    # or supervisor-reported population participates in this observation.
    handles = {}
    root = os.open("/sys/fs/cgroup/smithers/sessions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
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
    if operation == "fingerprint":
        print(json.dumps({"outside": fingerprint()}))
        return
    if operation == "sample":
        print(json.dumps(sample()))
        return
    if operation in ("boot-symlink", "boot-writable", "supervisor-replaced"):
        observed = sample()
        if len(observed["supervisors"]) != 1:
            raise ValueError("not exactly one owned supervisor")
        pid = observed["supervisors"][0]
        # Hold the process identity before changing the pathname. A replacement
        # fixture must never turn restart into a signal to an unrelated process.
        process = os.pidfd_open(pid, 0)
        try:
            if os.readlink(f"/proc/{pid}/exe") != "/opt/smithers/prototype/supervisor":
                raise ValueError("supervisor executable mismatch")
            if operation == "supervisor-replaced":
                parent = os.open("/opt/smithers/prototype", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.rename("supervisor", "supervisor-original", src_dir_fd=parent, dst_dir_fd=parent)
                    fd = os.open("supervisor", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755, dir_fd=parent)
                    with os.fdopen(fd, "wb") as output:
                        output.write(b"#!/bin/sh\nprintf canary >> /var/tmp/trm06-outside\n")
                        os.fchmod(output.fileno(), 0o755)
                finally:
                    os.close(parent)
            else:
                parent = os.open("/run/smithers/trm06", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    if operation == "boot-symlink":
                        os.rename("boot.json", "boot-original.json", src_dir_fd=parent, dst_dir_fd=parent)
                        os.symlink("/var/tmp/trm06-outside", "boot.json", dir_fd=parent)
                    else:
                        fd = os.open("boot.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                        try:
                            os.fchmod(fd, 0o666)
                        finally:
                            os.close(fd)
                finally:
                    os.close(parent)
            signal.pidfd_send_signal(process, signal.SIGKILL)
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
    if operation == "cleanup-poison":
        parent = os.open("/sys/fs/cgroup/smithers/sessions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.mkdir("trm06-invalid-child", 0o755, dir_fd=parent)
        finally:
            os.close(parent)
        print(json.dumps({"cleanup_poisoned": True, "outside": fingerprint()}))
        return
    if operation == "boundary-sample":
        marker = Path("/workspace/trm06-member-canary")
        logfd = os.open("/run/smithers/trm06/init.log", os.O_RDONLY | os.O_NOFOLLOW)
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
