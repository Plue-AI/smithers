#!/usr/bin/env python3
"""Portable test fallback; the maintainer's machine-wide vcs_lock.py wins when present."""
import fcntl
import subprocess
import sys
import tempfile
from pathlib import Path
with (Path(tempfile.gettempdir()) / "fault-3367-vcs.lock").open("w") as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    raise SystemExit(subprocess.run([sys.argv[2]], check=False).returncode)
