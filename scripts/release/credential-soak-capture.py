"""Capture a production personal terminal; never retain raw terminal/tool output."""
import json
import os
import platform
import re
import subprocess
import sys
import threading
import uuid
from pathlib import Path

REPORT = re.compile(
    r"(?:call:(?:claude|codex|gh):[0-9]+:[0-9]+:[01]|"
    r"version:(?:claude|codex|gh):[0-9]+:[0-9]+:[0-9]+|"
    r"(?:begin|end|refused):[0-9]+:[0-9]+)"
)


def redacted_line(line, nonce):
    prefix = f"SOAK:{nonce}:"
    line = line.rstrip("\r\n")
    if not line.startswith(prefix):
        return None
    data = line[len(prefix):]
    return data if REPORT.fullmatch(data) else None


def capture(repo, machine, guest_uid, evidence):
    nonce = uuid.uuid4().hex
    guest = Path(__file__).with_name("credential-soak-guest.sh").read_text()
    script = (f"bash -s <<'SMITHERS_SOAK_GUEST'\nexpected_uid={guest_uid}\n"
              f"nonce={nonce}\n{guest}\nSMITHERS_SOAK_GUEST\nexit\n")
    metadata = {"repository": repo, "machine": machine, "guest_uid": guest_uid,
                "host": platform.platform(), "recording_uid": os.getuid(),
                "qualification": "not evaluated"}
    (evidence / "capture.json").write_text(json.dumps(metadata, indent=2) + "\n")
    saw_end = False
    guest_failed = False
    with subprocess.Popen(
        ["smthrs", "workspace", "shell", machine, "--repo", repo, "--cols", "1000"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1,
    ) as terminal:
        # Bound the recorder even if the guest or socket never completes.
        timed_out = threading.Event()
        def expire():
            timed_out.set()
            terminal.terminate()  # Only the child this recorder started.
        timer = threading.Timer(87000, expire)
        timer.start()
        try:
            terminal.stdin.write(script)
            terminal.stdin.flush()  # Keep stdin open until the guest exits.
            with (evidence / "calls.redacted.log").open("x") as output:
                for line in terminal.stdout:
                    data = redacted_line(line, nonce)
                    if data is not None:
                        if data.startswith("end:"):
                            saw_end = True
                            guest_failed = guest_failed or data.rsplit(":", 1)[1] != "0"
                        if data.startswith("refused:"):
                            guest_failed = True
                        if data.startswith("call:"):
                            parts = data.split(":")
                            guest_failed = guest_failed or parts[3] != "0" or parts[4] != "0"
                        output.write(data + "\n")
                        output.flush()
            status = terminal.wait()
        finally:
            timer.cancel()
    metadata.update(terminal_exit=status, recorder_timeout=timed_out.is_set(), guest_completed=saw_end, guest_failed=guest_failed)
    (evidence / "capture.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print("Capture ended; the approved check runner needs both machines and signed sleep/wake evidence.", file=sys.stderr)
    # This exit status describes transport only. Never emit a passing receipt.
    return 124 if timed_out.is_set() else status or (1 if guest_failed else 0) or (0 if saw_end else 78)


if __name__ == "__main__":
    repo, machine, guest_uid, directory = sys.argv[1:]
    sys.exit(capture(repo, machine, int(guest_uid), Path(directory)))
