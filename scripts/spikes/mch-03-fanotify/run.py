#!/usr/bin/env python3
"""Stock-guest prerequisite probe; never executes branch code as root."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

# Literal Linux UAPI flags: CLASS_NOTIF=0, REPORT_PIDFD=0x80,
# REPORT_DFID_NAME=0xc00; MARK_ADD=1, MARK_FILESYSTEM=0x100.
PROBE = r'''
import ctypes, errno, json, os
libc = ctypes.CDLL(None, use_errno=True)
libc.fanotify_init.argtypes = [ctypes.c_uint, ctypes.c_uint]
libc.fanotify_mark.argtypes = [ctypes.c_int, ctypes.c_uint, ctypes.c_uint64, ctypes.c_int, ctypes.c_char_p]
groups = []
for name, flags in [("notification", 0), ("dfid_name", 0xc00), ("required_pidfd_dfid_name", 0xc80), ("permission", 4)]:
    ctypes.set_errno(0)
    fd = libc.fanotify_init(flags, os.O_RDONLY | os.O_CLOEXEC)
    row = dict(name=name, flags=flags, result=fd, errno=ctypes.get_errno())
    row["error"] = errno.errorcode.get(row["errno"])
    if fd >= 0:
        try:
            ctypes.set_errno(0)
            row["mark_result"] = libc.fanotify_mark(fd, 0x101, 0x800|0x100|0x200|0x40|0x80|4|0x20, -100, b"/workspace")
            row["mark_errno"] = ctypes.get_errno()
            row["mark_error"] = errno.errorcode.get(row["mark_errno"])
        finally:
            os.close(fd)
    groups.append(row)
print(json.dumps(dict(kernel=os.uname().release, uid=os.geteuid(), groups=groups, mountinfo=open("/proc/self/mountinfo").read(), attribution_ready=False, writer_matrix="not_run", ignore_matrix="not_run")))
'''


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: run.py <evidence-directory>")
    binary = os.environ["SMITHERS_MICROSANDBOX_BIN"]
    evidence = Path(sys.argv[1])
    evidence.mkdir(parents=True, exist_ok=True)
    name = "fr3-wt-s2-fanotify-" + uuid.uuid4().hex[:12]
    # Reuse the production image pin, rather than introduce another base image.
    runtime = Path(__file__).resolve().parents[3] / "packages/backend/microsandbox/runtime.go"
    image = next(line.split('"')[1] for line in runtime.read_text().splitlines() if line.startswith("const DefaultImage = "))
    def run(*args):
        result = subprocess.run([binary, *args], capture_output=True, text=True)
        with (evidence / "commands.jsonl").open("a") as log:
            log.write(json.dumps(dict(argv=[binary, *args], status=result.returncode, stdout=result.stdout, stderr=result.stderr)) + "\n")
        result.check_returncode()
        return result.stdout
    try:
        run("create", image, "--name", name, "--cpus", "1", "--memory", "512M", "--root-disk", "32768M", "--mkdir", "/workspace", "--no-net", "--max-duration", "10m")
        facts = json.loads(run("exec", name, "--user", "19999:19999", "--", "/usr/bin/python3", "-I", "-S", "-c", PROBE))
        if facts["uid"] != 19999:
            raise RuntimeError("probe must run unprivileged")
        (evidence / "summary.json").write_text(json.dumps(facts, indent=2) + "\n")
        print(json.dumps(facts))
    finally:
        run("stop", name)
        run("remove", name)
    # Diagnostic success is deliberately not an attribution acceptance receipt.
    return 2


if __name__ == "__main__":
    sys.exit(main())
