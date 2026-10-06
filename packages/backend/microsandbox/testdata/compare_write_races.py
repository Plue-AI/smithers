#!/usr/bin/env python3
"""Supplemental Linux qualification probe for the disabled S1 writer (#3508).

Run unprivileged:
  python3 -I -B testdata/compare_write_races.py guest/smithers-guest.py

Uses real renameat2 with deterministic outside saves at exchange boundaries.
Exit zero requires stale-write preservation and root confinement. This does
not qualify an authenticated provider or fresh/retained machine startup.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile

assert os.geteuid() != 0, "never run branch qualification code as root"
assert sys.platform == "linux", "this probe requires Linux renameat2"
spec = importlib.util.spec_from_file_location("guest", sys.argv[1])
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
exchange = g.exchange_file
base = hashlib.sha256(b"original\n").hexdigest()
results = []


def write(root, path):
    g.sys.stdin = io.TextIOWrapper(io.BytesIO(b"agent-replacement\n"))
    out, error = io.StringIO(), io.StringIO()
    status = 0
    try:
        with contextlib.redirect_stderr(error), contextlib.redirect_stdout(out):
            g.fs_compare_write(str(root), path, 0o644, base, 1024)
    except SystemExit as failure:
        status = failure.code
    except OSError as failure:
        status = "os-error"
        error.write(str(failure))
    return {"status": status, "output": out.getvalue(), "error": error.getvalue()}


with tempfile.TemporaryDirectory(prefix="smithers-cas-quality-") as directory:
    root = pathlib.Path(directory)
    target = root / "file"
    target.write_bytes(b"original\n")
    calls = []

    def race(parent, source, leaf, flags):
        calls.append(flags)
        outside = root / "outside"
        outside.write_bytes(b"outside-first\n" if len(calls) == 1 else b"outside-latest\n")
        os.replace(outside, target)
        exchange(parent, source, leaf, flags)

    g.exchange_file = race
    result = write(root, "file")
    files = {path.name: path.read_text() for path in root.iterdir()}
    result.update(case="outside-save-during-rollback", files=files, exchange_calls=len(calls))
    result["passed"] = result["status"] == 6 and files == {"file": "outside-latest\n"}
    results.append(result)

with tempfile.TemporaryDirectory(prefix="smithers-cas-ancestor-") as directory:
    container = pathlib.Path(directory)
    root, outside = container / "workspace", container / "outside"
    root.mkdir()
    outside.mkdir()
    parent = root / "dir"
    parent.mkdir()
    (parent / "file").write_bytes(b"original\n")

    def move(parent_fd, source, leaf, flags):
        os.rename(parent, outside / "moved")
        parent.mkdir()
        exchange(parent_fd, source, leaf, flags)

    g.exchange_file = move
    result = write(root, "dir/file")
    outside_bytes = (outside / "moved/file").read_text()
    result.update(case="ancestor-moved-outside-root", outside_bytes=outside_bytes)
    result["passed"] = result["status"] != 0 and outside_bytes == "original\n"
    results.append(result)

g.exchange_file = exchange
print(json.dumps({"platform": sys.platform, "uid": os.geteuid(), "results": results}, indent=2))
sys.exit(0 if all(result["passed"] for result in results) else 1)
