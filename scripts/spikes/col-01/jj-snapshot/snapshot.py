#!/usr/bin/env python3
"""Measure the real jj subprocess; preparation and validation are untimed."""

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time


FILE_COUNT = 200
FIXTURE_NAME = "col01-snapshot-fixture"


def summary(values):
    if not values or any(type(value) is not int or value <= 0 for value in values):
        raise ValueError("samples must be positive integer nanoseconds")
    ordered = sorted(values)
    return {
        "n": len(ordered), "min_ns": ordered[0], "max_ns": ordered[-1],
        "p50_ns": ordered[(len(ordered) * 50 + 99) // 100 - 1],
        "p95_ns": ordered[(len(ordered) * 95 + 99) // 100 - 1],
        "p99_ns": ordered[(len(ordered) * 99 + 99) // 100 - 1],
    }


class Repository:
    def __init__(self, repo, jj):
        self.repo = Path(repo).resolve()
        if not (self.repo / ".jj").is_dir():
            raise ValueError("a prepared disposable jj repository is required")
        executable = shutil.which(str(jj))
        if executable is None:
            raise ValueError(f"jj executable not found: {jj}")
        self.jj = str(Path(executable).resolve())
        self.fixture = self.repo / FIXTURE_NAME
        self.files = [self.fixture / f"file-{index:03}.txt" for index in range(FILE_COUNT)]
        self.expected = []
        self.generation = 0

    def argv(self, *args, ignore_working_copy=False):
        argv = [self.jj, "--repository", str(self.repo), "--no-pager", "--color", "never",
                "--config", 'user.name="COL01 snapshot"',
                "--config", 'user.email="col01@example.invalid"']
        if ignore_working_copy:
            argv.append("--ignore-working-copy")
        return argv + list(args)

    def command(self, *args, ignore_working_copy=False):
        return subprocess.run(self.argv(*args, ignore_working_copy=ignore_working_copy),
                              cwd=self.repo, check=True, capture_output=True, timeout=120)

    def initialize(self):
        self.fixture.mkdir()
        self.expected = [self.content(index, 0) for index in range(FILE_COUNT)]
        for path, content in zip(self.files, self.expected):
            path.write_bytes(content)
        # Initial fixture creation is setup, explicitly outside all sample cells.
        self.snapshot()
        self.verify()

    @staticmethod
    def content(index, generation):
        prefix = f"file={index:03};generation={generation:016};".encode()
        return prefix + b"x" * (127 - len(prefix)) + b"\n"

    def prepare(self, count):
        if type(count) is not int or not 0 <= count <= FILE_COUNT:
            raise ValueError("changed file count must be an integer in [0, 200]")
        # Catch accidental concurrent edits before attributing their work to jj.
        if any(path.read_bytes() != expected for path, expected in zip(self.files, self.expected)):
            raise ValueError("fixture changed outside driver preparation")
        self.generation += 1
        for index in range(count):
            content = self.content(index, self.generation)
            self.files[index].write_bytes(content)
            self.expected[index] = content

    def snapshot(self):
        argv = self.argv("util", "snapshot")
        start = time.perf_counter_ns()
        subprocess.run(argv, cwd=self.repo, check=True, capture_output=True, timeout=120)
        elapsed = time.perf_counter_ns() - start
        if elapsed <= 0:
            raise ValueError("nonpositive monotonic snapshot interval")
        return elapsed

    def verify(self):
        # --ignore-working-copy is essential: this checks the measured command's
        # stored tree without silently repairing a missed snapshot afterwards.
        actual = self.command("file", "show", FIXTURE_NAME,
                              ignore_working_copy=True).stdout
        if actual != b"".join(self.expected):
            raise ValueError("measured snapshot tree differs from prepared file contents")
        tracked = self.command("file", "list", ignore_working_copy=True).stdout.decode().splitlines()
        expected_paths = {f"{FIXTURE_NAME}/{path.name}" for path in self.files}
        if not expected_paths.issubset(tracked):
            raise ValueError("snapshot fixture files were ignored or not tracked")
        if any("node_modules" in Path(path).parts for path in tracked):
            raise ValueError("node_modules dependencies are tracked, not ignored")


class Busy:
    def __init__(self, workers):
        if type(workers) is not int or workers <= 0:
            raise ValueError("busy worker count must be positive")
        self.workers = workers
        self.processes = []

    def __enter__(self):
        try:
            for _ in range(self.workers):
                self.processes.append(subprocess.Popen(["yes"], stdout=subprocess.DEVNULL,
                                                       stderr=subprocess.DEVNULL))
            if any(process.poll() is not None for process in self.processes):
                raise RuntimeError("a CPU load worker exited during launch")
            return self
        except BaseException:
            self.stop()
            raise

    def receipt(self):
        if any(process.poll() is not None for process in self.processes):
            raise RuntimeError("a CPU load worker exited during the measured cell")
        workers = []
        for process in self.processes:
            stat = Path(f"/proc/{process.pid}/stat")
            cpu_ticks = None
            if stat.exists():
                fields = stat.read_text().rsplit(")", 1)[1].split()
                cpu_ticks = int(fields[11]) + int(fields[12])
            workers.append({"pid": process.pid, "cpu_ticks": cpu_ticks})
        return workers

    def stop(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
        for process in self.processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def __exit__(self, *exc):
        self.stop()


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("repo", type=Path)
    result.add_argument("output", type=Path)
    result.add_argument("--jj", default="jj")
    result.add_argument("--samples", type=int, default=100)
    result.add_argument("--busy-workers", type=int, required=True)
    result.add_argument("--deviation", default="Host profile, competing VMs and guest configuration are recorded by the harness; these are observations on this host.")
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    if args.samples < 100 or args.busy_workers <= 0:
        raise ValueError("at least 100 samples/cell and positive busy workers are required")
    repo, output = args.repo.resolve(), args.output.resolve()
    if output == repo or repo in output.parents:
        raise ValueError("artifacts must be outside the measured repository")
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("artifact directory is nonempty; refusing stale evidence")
    fixture = Repository(repo, args.jj)
    metadata = {
        "jj_version": subprocess.check_output([fixture.jj, "--version"], text=True).strip(),
        "jj_executable": fixture.jj,
        "jj_sha256": hashlib.sha256(Path(fixture.jj).read_bytes()).hexdigest(),
        "platform": platform.platform(), "repo": str(repo),
        "base_commit": fixture.command("log", "-r", "@-", "--no-graph", "-T", "commit_id",
                                       ignore_working_copy=True).stdout.decode(),
        "samples_per_cell": args.samples, "busy_workers": args.busy_workers,
        "guest_logical_cpus": os.cpu_count(),
        "deviation": args.deviation,
        "snapshot_argv": fixture.argv("util", "snapshot"),
        "measurement": "monotonic subprocess wall time for jj util snapshot; includes process startup and repository scan",
        "preparation": "200 additional tracked 128-byte fixture text files; rewrite exactly N before each measured invocation",
        "validation": "every sample checks stored fixture contents and ignored node_modules with --ignore-working-copy",
        "percentile_method": "empirical nearest rank", "warmup_samples_dropped": 0,
        "limitations": "Disposable full clone plus installed dependencies; fixed-size fixture edits rather than edits to existing source. Preparation/validation run between samples and warm filesystem/repository caches. No OS cache flush or pure in-process snapshot cost is claimed.",
    }
    (output / "env.json").write_text(json.dumps(metadata, indent=2) + "\n")
    cells = []
    busy = None
    try:
        fixture.initialize()
        with (output / "samples.csv").open("x", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(["load", "changed_files", "seq", "snapshot_ns", "deviation"])
            stream.flush()
            for load in ["idle", "busy"]:
                if load == "busy":
                    busy = Busy(args.busy_workers)
                    busy.__enter__()
                for count in [0, 1, 12, 200]:
                    values = []
                    before = busy.receipt() if busy else []
                    for seq in range(args.samples):
                        fixture.prepare(count)
                        elapsed = fixture.snapshot()
                        # Retain even a sample whose subsequent correctness
                        # assertion fails, but never publish a passing summary.
                        writer.writerow([load, count, seq, elapsed, args.deviation])
                        stream.flush()
                        fixture.verify()
                        if busy:
                            busy.receipt()
                        values.append(elapsed)
                    after = busy.receipt() if busy else []
                    if platform.system() == "Linux" and busy:
                        if any(end["cpu_ticks"] <= begin["cpu_ticks"] for begin, end in zip(before, after)):
                            raise RuntimeError("busy load lacks CPU execution evidence for every worker")
                    cells.append({"load": load, "changed_files": count, "deviation": args.deviation,
                                  "stats": {**summary(values), "deviation": args.deviation},
                                  "busy_before": before, "busy_after": after})
        gate = next(cell for cell in cells if cell["load"] == "idle" and cell["changed_files"] == 12)
        result = {"cells": cells, "idle_12_file_gate_passed": gate["stats"]["p95_ns"] < 500_000_000,
                  "gate": "idle 12 changed files, >=100 samples, p95 <500ms", "env": metadata}
        (output / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
        return 0 if result["idle_12_file_gate_passed"] else 1
    except BaseException as error:
        failure = {"status": "failed", "error": str(error), "completed_cells": cells}
        if isinstance(error, subprocess.CalledProcessError):
            failure["stderr"] = error.stderr.decode(errors="replace") if error.stderr else ""
            failure["command"] = error.cmd
            failure["returncode"] = error.returncode
        (output / "failure.json").write_text(json.dumps(failure, indent=2) + "\n")
        raise
    finally:
        if busy:
            busy.stop()


if __name__ == "__main__":
    sys.exit(main())
