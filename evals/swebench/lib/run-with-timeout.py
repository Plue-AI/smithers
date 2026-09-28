#!/usr/bin/env python3
"""Run a command with a wall-clock deadline, returning 124 on expiry.

Unlike GNU timeout, Python 3 is available on both macOS and Linux in this rig.
Run the child in its own process group so its subprocesses cannot outlive the
deadline (or an interrupted runner).
"""

import os
import signal
import subprocess
import sys


def main():
    try:
        seconds = float(sys.argv[1])
        if seconds <= 0 or seconds == float("inf") or seconds != seconds:
            raise ValueError("budget must be finite and positive")
        command = sys.argv[2:]
        if not command:
            raise ValueError("missing command")
    except (IndexError, ValueError) as error:
        print(f"run-with-timeout: invalid budget or command: {error}", file=sys.stderr)
        return 2

    try:
        child = subprocess.Popen(command, start_new_session=True)
    except FileNotFoundError:
        print(f"run-with-timeout: command not found: {command[0]}", file=sys.stderr)
        return 127

    def stop(signum, _frame):
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        status = child.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        return 124
    return status if status >= 0 else 128 - status


if __name__ == "__main__":
    sys.exit(main())
