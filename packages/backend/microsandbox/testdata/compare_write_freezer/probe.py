"""Disposable probe: cgroup.freeze versus an already submitted write.

Run only in a newly delegated systemd user service, never an existing workload.
No root privileges or guest enablement are involved.
"""
import json
import os
import pathlib
import selectors
import subprocess
import sys
import tempfile
import time

if os.geteuid() == 0:
    raise SystemExit("never run branch qualification code as root")
scope = pathlib.Path("/sys/fs/cgroup" + pathlib.Path("/proc/self/cgroup").read_text().strip().split("::")[1])
if not (scope.name.startswith("run-") and scope.name.endswith(".service")):
    raise SystemExit("run only in a new disposable delegated user service")
group = scope / ("smithers-freezer-probe-" + str(os.getpid()))
group.mkdir()
child = None
try:
    with tempfile.TemporaryDirectory(prefix="smithers-freezer-probe-") as directory:
        target = pathlib.Path(directory) / "file"
        target.write_bytes(b"original\n")
        child = subprocess.Popen([sys.argv[1], str(group / "cgroup.procs"), str(target), sys.argv[2]],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        with selectors.DefaultSelector() as ready:
            ready.register(child.stdout, selectors.EVENT_READ)
            assert ready.select(5), "child readiness timed out"
        assert child.stdout.readline() == b"READY\n", child.stderr.read().decode()
        (group / "cgroup.freeze").write_text("1")
        deadline = time.monotonic() + 5
        while "frozen 1" not in (group / "cgroup.events").read_text():
            assert time.monotonic() < deadline, "freeze timed out"
            time.sleep(0.01)
        before = target.read_bytes()
        child.stdin.write(b"go\n")
        child.stdin.flush()
        deadline = time.monotonic() + 2
        while target.read_bytes() == before and time.monotonic() < deadline:
            time.sleep(0.01)
        after = target.read_bytes()
        events = (group / "cgroup.events").read_text()
        alive = child.poll() is None
        (group / "cgroup.freeze").write_text("0")
        deadline = time.monotonic() + 3
        while target.read_bytes() != b"outside-latest\n" and time.monotonic() < deadline:
            time.sleep(0.01)
        resumed = target.read_bytes()
        result = {"uid": os.getuid(), "kernel": os.uname().release, "mode": sys.argv[2],
            "before": before.decode(), "after": after.decode(),
            "resumed": resumed.decode(), "events_while_frozen": events, "writer_alive_while_frozen": alive,
            "held_until_thaw": before == after == b"original\n" and resumed == b"outside-latest\n" and "frozen 1" in events and alive}
        print(json.dumps(result, indent=2), flush=True)
        assert result["held_until_thaw"], "write escaped pause or positive control failed"
finally:
    (group / "cgroup.freeze").write_text("0")
    if child is not None:
        child.kill()
        child.communicate(timeout=5)
    group.rmdir()
