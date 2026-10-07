#!/usr/bin/env python3
"""Read-only S-3 observer. Never launches workloads or changes cgroups."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import time

ROLES = {"vscode", "idle-node", "formatter"}
WINDOW = 1.5


def validate(entries):
    if len(entries) != 3 or {e["role"] for e in entries} != ROLES:
        raise ValueError("exactly vscode, idle-node and formatter are required")
    paths = [Path(e["cgroup"]).resolve() for e in entries]
    if len(set(paths)) != 3 or any(a in b.parents for a in paths for b in paths if a != b):
        raise ValueError("cgroups must be distinct and non-overlapping")
    for e in entries:
        if not isinstance(e["uid"], int) or e["uid"] <= 0 or not e["participant"]:
            raise ValueError("non-root uid and participant are required")
    by_role = {e["role"]: e for e in entries}
    active = by_role["formatter"]
    if by_role["vscode"]["participant"] != active["participant"] or by_role["vscode"]["uid"] != active["uid"]:
        raise ValueError("VS Code and formatter must belong to the active person")
    idle = by_role["idle-node"]
    if idle["participant"] == active["participant"] or idle["uid"] == active["uid"]:
        raise ValueError("idle Node must belong to a second person and uid")
    return active["participant"]


def usage(path):
    values = [line.split()[1] for line in Path(path).read_text().splitlines()
              if line.startswith("usage_usec ")]
    if len(values) != 1 or not values[0].isdigit():
        raise ValueError("missing or malformed usage_usec")
    return int(values[0])


def inspect(entry):
    root = Path(entry["cgroup"]).resolve()
    if Path("/sys/fs/cgroup") not in root.parents:
        raise ValueError("requires real cgroup v2 under /sys/fs/cgroup")
    if not (root / "cgroup.events").exists():
        raise ValueError("cgroup v2 unavailable")
    pids = set()
    for directory, _, _ in os.walk(root):
        pids.update(Path(directory, "cgroup.procs").read_text().split())
    if not pids:
        raise ValueError(entry["role"] + " has no process")
    processes = []
    for pid in sorted(pids, key=int):
        proc = Path("/proc", pid)
        uid_line = next(line for line in (proc / "status").read_text().splitlines() if line.startswith("Uid:"))
        if any(int(uid) != entry["uid"] for uid in uid_line.split()[1:]):
            raise ValueError("unexpected uid in " + entry["role"])
        argv = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        processes.append({"pid": int(pid), "argv": argv,
                          "exe": os.readlink(proc / "exe")})
    # The workload command is evidence, not an authority or a substitute for
    # operator verification that VS Code is connected and only one person works.
    return processes


def summarize(entries, samples):
    active = validate(entries)
    if len(samples) < 41:
        raise ValueError("at least 40 measured windows are required")
    windows = []
    for before, after in zip(samples, samples[1:]):
        elapsed = after["at"] - before["at"]
        if not WINDOW <= elapsed <= WINDOW * 1.1:
            raise ValueError("window duration outside 1.5 s + 10% scheduling tolerance")
        deltas = {e["role"]: after["cpu"][e["role"]] - before["cpu"][e["role"]] for e in entries}
        if any(delta < 0 for delta in deltas.values()):
            raise ValueError("CPU counter reset")
        if deltas["formatter"] <= 0:
            raise ValueError("formatter did not gain CPU in every window; one-active-person workload unproven")
        participants = sorted({e["participant"] for e in entries if deltas[e["role"]] > 0})
        windows.append({"elapsed_seconds": elapsed, "cpu_delta_usec": deltas,
                        "participants": participants, "ambiguous": len(participants) > 1})
    ambiguous = sum(w["ambiguous"] for w in windows)
    # Strictly greater than 10%, without floating point threshold rounding.
    kernel = ambiguous * 10 > len(windows)
    return {"status": "measured", "active_participant": active, "windows": windows,
            "window_count": len(windows), "ambiguous_windows": ambiguous,
            "ambiguous_fraction": ambiguous / len(windows),
            "decision": "kernel-attribution-required-at-launch" if kernel else "participant-aggregation-sufficient-for-this-workload"}


def collect(entries, count, samples=None):
    validate(entries)
    if platform.system() != "Linux" or os.geteuid() == 0:
        raise ValueError("run this read-only branch probe unprivileged in Linux")
    if count < 40:
        raise ValueError("at least 40 windows are required")
    if samples is None:
        samples = []
    for index in range(count + 1):
        if index:
            time.sleep(WINDOW)
        processes = {e["role"]: inspect(e) for e in entries}
        cpu = {e["role"]: usage(Path(e["cgroup"], "cpu.stat")) for e in entries}
        samples.append({"at": time.monotonic(), "cpu": cpu, "processes": processes})
    return samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--windows", type=int, default=40)
    args = parser.parse_args()
    # Exclusive create refuses stale evidence, including a prior pending run.
    with args.output.open("x") as output:
        receipt = {"host": platform.node(), "kernel": platform.release(),
                   "window_seconds": WINDOW, "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
        code = 78
        try:
            entries = json.loads(args.manifest.read_text())
            receipt["manifest"] = entries
            receipt["samples"] = []
            samples = collect(entries, args.windows, receipt["samples"])
            receipt.update(summarize(entries, samples))
            code = 0
        except (OSError, ValueError, KeyError, TypeError, StopIteration) as error:
            receipt.update(status="pending", decision=None, reason=str(error))
        json.dump(receipt, output, indent=2)
        output.write("\n")
    print(receipt["status"] + ": " + str(receipt.get("decision") or receipt.get("reason")))
    return code


if __name__ == "__main__":
    sys.exit(main())
