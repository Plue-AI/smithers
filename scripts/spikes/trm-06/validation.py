"""Main-installed root fixture preparation/independent observation only.

No caller path, code, user or signal selector. The signed installed provider
selects one of these literal fixture operations in its own fresh disposable VM.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
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


def main():
    if os.getuid() != 0 or os.geteuid() != 0:
        raise ValueError("root fixture requires installed provider")
    operation = sys.argv[1] if len(sys.argv) == 2 else ""
    if operation == "fingerprint":
        print(json.dumps({"outside": fingerprint()}))
        return
    if operation == "sample":
        print(json.dumps(sample()))
        return
    if operation == "restart":
        observed = sample()
        if len(observed["supervisors"]) != 1:
            raise ValueError("not exactly one owned supervisor")
        pid = observed["supervisors"][0]
        # This is the provider's own disposable supervisor, never an arbitrary
        # PID or member-selected process. Validate its exact installed executable.
        if os.readlink(f"/proc/{pid}/exe") != "/opt/smithers/prototype/supervisor":
            raise ValueError("supervisor executable mismatch")
        os.kill(pid, signal.SIGKILL)
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
