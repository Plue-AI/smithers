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

TOOLS = ("claude", "codex", "gh")
INTERVAL = 600
OBSERVATIONS = 145  # Start, every ten minutes, and the 24-hour endpoint.


class CallSequence:
    """Validate capture completeness, never issue a release-check receipt."""

    def __init__(self, guest_uid):
        self.guest_uid = guest_uid
        self.started = None
        self.ended = False
        self.versions = []
        self.calls = 0
        self.previous_at = None
        self.failure = None

    def refuse(self, reason):
        # Keep the first failure even if a later end record claims success.
        if self.failure is None:
            self.failure = reason

    def accept(self, data):
        parts = data.split(":")
        kind = parts[0]
        if self.ended:
            self.refuse("record_after_end")
        elif kind == "refused":
            self.refuse("guest_refused")
        elif kind == "begin":
            if self.started is not None or int(parts[2]) != self.guest_uid:
                self.refuse("invalid_begin")
            else:
                self.started = int(parts[1])
                self.previous_at = self.started
        elif self.started is None:
            self.refuse("missing_begin")
        elif kind == "version":
            if self.calls or len(self.versions) == len(TOOLS) or parts[1] != TOOLS[len(self.versions)]:
                self.refuse("version_order")
            else:
                self.versions.append(parts[1])
        elif kind == "call":
            iteration, tool_index = divmod(self.calls, len(TOOLS))
            at = int(parts[2])
            target = self.started + iteration * INTERVAL
            if self.versions != list(TOOLS):
                self.refuse("missing_versions")
            if iteration >= OBSERVATIONS or parts[1] != TOOLS[tool_index]:
                self.refuse("call_order")
            # The guest permits 60 seconds of scheduler delay and each previous
            # tool can consume its 120-second timeout in this observation.
            if at < target or at > target + 60 + tool_index * 120 or at < self.previous_at:
                self.refuse("call_timing")
            if parts[3:] != ["0", "0"]:
                self.refuse("tool_failed_or_login_prompt")
            self.previous_at = at
            self.calls += 1
        elif kind == "end":
            self.ended = True
            at = int(parts[1])
            if self.calls != OBSERVATIONS * len(TOOLS) or self.versions != list(TOOLS):
                self.refuse("incomplete_calls")
            if at < self.started + 86400 or at < self.previous_at:
                self.refuse("incomplete_duration")
            if parts[2] != "0":
                self.refuse("guest_failed")

    def finish(self):
        if not self.ended:
            self.refuse("missing_end")
        return self.failure is None


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
    sequence = CallSequence(guest_uid)
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
                        sequence.accept(data)
                        output.write(data + "\n")
                        output.flush()
            status = terminal.wait()
        finally:
            timer.cancel()
    complete = sequence.finish()
    metadata.update(terminal_exit=status, recorder_timeout=timed_out.is_set(),
                    guest_completed=sequence.ended, capture_complete=complete,
                    observed_calls=sequence.calls, capture_failure=sequence.failure)
    (evidence / "capture.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print("Capture ended; the approved check runner needs both machines and signed sleep/wake evidence.", file=sys.stderr)
    # A complete capture is still not qualification. Never emit a passing receipt.
    return 124 if timed_out.is_set() else status or (0 if complete else 1 if sequence.failure != "missing_end" else 78)


if __name__ == "__main__":
    repo, machine, guest_uid, directory = sys.argv[1:]
    sys.exit(capture(repo, machine, int(guest_uid), Path(directory)))
