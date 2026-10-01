#!/usr/bin/env python3
"""Real Microsandbox exec + SSH setsid survival. No hosted Cloud claim."""
import json, shlex, subprocess, time, uuid
name = "smthrs-job-spike-" + uuid.uuid4().hex[:12]
image = "node:26-trixie"
def run(*args):
    return subprocess.run(["microsandbox", *args], check=True, capture_output=True, text=True, timeout=120)
try:
    run("create", image, "--pull", "never", "--name", name, "--memory", "512M", "--cpus", "1", "--max-duration", "10m", "--idle-timeout", "5m", "--label", "smithers.test=job-survival-spike", "--no-net")
    for transport in ("exec", "ssh"):
        root = "/var/lib/smthrs-jobs/" + transport
        child = f"echo $$ >{root}/pid; sleep 8; echo 0 >{root}/exit"
        launcher = f"mkdir -p {root}; setsid /bin/sh -c {shlex.quote(child)} </dev/null >{root}/out 2>{root}/err & echo launcher-returned"
        argv = ["exec", "--no-tty", name, "--", "/bin/sh", "-c", launcher] if transport == "exec" else ["ssh", name, "--", "/bin/sh", "-c", shlex.quote(launcher)]
        started = time.monotonic()
        receipt = run(*argv)
        elapsed = time.monotonic() - started
        assert receipt.stdout.strip() == "launcher-returned", receipt
        # Observe after the connection ended, before the detached work finishes.
        probe = run("exec", "--no-tty", name, "--", "/bin/sh", "-c", f"test ! -f {root}/exit && kill -0 -$(cat {root}/pid) && echo Running")
        assert probe.stdout.strip() == "Running", probe
        time.sleep(8)
        exited = run("exec", "--no-tty", name, "--", "/bin/sh", "-c", f"cat {root}/exit")
        assert exited.stdout.strip() == "0", exited
        print(json.dumps({"transport": transport, "image": image, "launch_seconds": elapsed, "observed_after_connection_end": "Running", "exit": 0}))
finally:
    run("remove", "--force", name)
