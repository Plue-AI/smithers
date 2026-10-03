"""C-SPK-05: isolated, named VMs; raw samples survive failures and cancellation."""
import argparse
import csv
from concurrent.futures import ThreadPoolExecutor
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import tarfile
import time
import urllib.request

GIB = 1 << 30


def output(*argv):
    return subprocess.check_output(argv, text=True).strip()


def sysctl(key):
    return output("/usr/sbin/sysctl", "-n", key)


def main():
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt("calibration interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", default=os.environ.get("STATE", os.environ.get("SMITHERS_DATA_ROOT", ".")))
    parser.add_argument("--out", required=True)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--snapshot", help="Prepared dependency layer; defaults to newest installed dependency layer")
    source.add_argument("--fresh", action="store_true", help="Use a fresh 32 GiB root disk instead of a prepared snapshot")
    parser.add_argument("--machines", type=int, help="Measurement override only; default is formula memory term")
    parser.add_argument("--ready-url", default="http://127.0.0.1:4000/readyz")
    parser.add_argument("--timeout", type=int, default=3600)
    args = parser.parse_args()
    evidence = Path(args.out).resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    state = Path(args.state).resolve()
    while not state.exists():
        state = state.parent
    detected = json.loads(output("go", "run", "./scripts/spikes/mch-01-memory/profile", str(state)))
    profile = detected["profile"]
    memory_mib = detected["limits"]["memory_mib"]
    cpus = detected["limits"]["cpus"]
    count = args.machines if args.machines is not None else max(0, (profile["memory_bytes"] - detected["reserve_bytes"]) // (memory_mib << 20))
    if count < 1:
        raise ValueError("machines must be positive")
    commit = output("jj", "log", "-r", "@", "--no-graph", "-T", "commit_id")
    pnpm = json.loads(Path("package.json").read_text())["packageManager"]
    bun = "bun@" + re.search(r'export const bunVersion = "([^"]+)"', Path(".smithers/WORKSPACE.ts").read_text())[1]
    snapshot = args.snapshot
    if not snapshot and not args.fresh:
        rows = output("msb", "snapshot", "list").splitlines()
        names = [row.split()[0] for row in rows if row.startswith("smthrs-dp-")]
        if not names:
            raise RuntimeError("needs prepared dependency layer: pass --snapshot NAME")
        snapshot = names[0]
    metadata = dict(profile=profile, commit=commit, msb_version=output("msb", "--version"), snapshot=snapshot, image=detected["image"],
                    machines=count, memory_mib=memory_mib, cpus=cpus, disk=32 if args.fresh else "inherited from prepared snapshot", formula=detected["limits"],
                    package_manager=pnpm, bun=bun,
                    limitations=["Shared host: other sessions and VMs remain running; not a rebooted calibration host.", "A full C-SPK-05 run also needs a running host service and PostgreSQL, an idle-host baseline, and the smaller-host layer-build repeat."])
    (evidence / "profile.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (evidence / "host-start.txt").write_text(output("/usr/sbin/sysctl", "hw.memsize", "hw.perflevel0.physicalcpu", "hw.physicalcpu", "kern.hv_support", "vm.swapusage", "kern.memorystatus_vm_pressure_level") + "\n" + output("ps", "-axo", "pid,rss,comm") + "\n")
    # Export only this workspace's tracked source, never its host node_modules.
    archive = evidence / "source.tar"
    files = output("jj", "--ignore-working-copy", "file", "list").splitlines()
    with tarfile.open(archive, "w") as tar:
        for name in files:
            tar.add(name, arcname=name, recursive=False)
    with archive.open("rb") as stream:
        metadata["source_sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    (evidence / "profile.json").write_text(json.dumps(metadata, indent=2) + "\n")
    prefix = "lane-cap-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + str(os.getpid())
    names, loads, logs = [], [], []
    samples, results = [], []
    initial_swap = swap_used()
    began = time.monotonic()
    failure = None
    sampling = ThreadPoolExecutor(max_workers=count + 1)
    guest_jobs = {}
    idle_job, idle = None, None
    try:
        for index in range(count):
            if shutil.disk_usage(Path.home()).free < 8 * GIB or shutil.disk_usage(state).free < 8 * GIB:
                raise RuntimeError("stopped: under 8 GiB free")
            name = prefix + "-" + str(index)
            names.append(name)  # Cleanup includes a partially failed boot.
            boot = ["msb", "create", detected["image"], "--root-disk", "32G"] if args.fresh else ["msb", "run", "--from-snapshot", snapshot, "-d"]
            subprocess.run(boot + ["-n", name, "-c", str(cpus), "-m", str(memory_mib) + "M", "-q",
                            "--label", "smithers.lane=cap", "--net", "public"], check=True)
            with archive.open("rb") as source:
                subprocess.run(["msb", "exec", "--stream", name, "--", "sh", "-c",
                                "mkdir -p /workspace; tar -xf - -C /workspace"], stdin=source, check=True)
        # Start all loads after all machines are booted and source is planted.
        for name in names:
            log = (evidence / (name + ".log")).open("wb")
            logs.append(log)
            script = "set -eu; export PATH=/opt/smithers/toolchain/bin:$PATH; cd /workspace; command -v pnpm >/dev/null || npm install --global " + shlex.quote(pnpm) + "; command -v bun >/dev/null || npm install --global " + shlex.quote(bun) + "; pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store --package-import-method hardlink; echo MCH_TEST_START; pnpm test"
            loads.append(subprocess.Popen(["msb", "exec", "--stream", "--timeout", str(args.timeout)+"s", name, "--", "sh", "-c", script],
                                          stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT))
        with (evidence / "samples.csv").open("w") as stream:
            fields = ["seconds", "swap_mib", "pressure", "ready_ms", "cpu_idle", "host_free_bytes", "backend_rss_kib", "postgres_rss_kib"] + [n + "_rss_kib" for n in names]
            writer = csv.DictWriter(stream, fieldnames=fields)
            writer.writeheader()
            while True:
                tick = time.monotonic()
                row = dict(seconds=round(tick - began, 3), swap_mib=swap_used(),
                           pressure=int(sysctl("kern.memorystatus_vm_pressure_level")),
                           ready_ms=ready_ms(args.ready_url), host_free_bytes=free_memory())
                # Slow guest commands and top must not delay the 1 s host sampler.
                if idle_job is None or idle_job.done():
                    if idle_job is not None:
                        idle = idle_job.result()
                    idle_job = sampling.submit(cpu_idle)
                row["cpu_idle"] = idle
                for name in names:
                    if name not in guest_jobs or guest_jobs[name].done():
                        guest_jobs[name] = sampling.submit(guest_free, evidence, name, row["seconds"])
                processes = output("ps", "-axo", "rss,args").splitlines()
                row["backend_rss_kib"] = sum(int(line.split()[0]) for line in processes if "smithers-backend" in line and "ps -axo" not in line)
                row["postgres_rss_kib"] = sum(int(line.split()[0]) for line in processes if "postgres" in line and "ps -axo" not in line)
                for name in names:
                    row[name + "_rss_kib"] = sum(int(line.split()[0]) for line in processes if " sandbox --name " + name + " " in line)
                writer.writerow(row)
                stream.flush()
                samples.append(row)
                if all(proc.poll() is not None for proc in loads):
                    break
                if tick - began > args.timeout:
                    raise RuntimeError("workload timeout")
                if shutil.disk_usage(Path.home()).free < 8 * GIB or shutil.disk_usage(state).free < 8 * GIB:
                    raise RuntimeError("stopped: under 8 GiB free")
                time.sleep(max(0, 1 - (time.monotonic() - tick)))
        for name in names:
            guest_free(evidence, name, round(time.monotonic() - began, 3))
    except BaseException as exc:
        failure = str(exc) or type(exc).__name__
    finally:
        # A second interrupt must not strand our disks or discard the receipt.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        sampling.shutdown(wait=True, cancel_futures=True)
        for proc in loads:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
            results.append(proc.wait())
        for log in logs:
            log.close()
        cleanup = {}
        for name in names:
            with (evidence / (name + "-cleanup.txt")).open("wb") as log:
                try:
                    known = [line.split()[0] for line in output("msb", "list").splitlines() if line.split()]
                    cleanup[name] = subprocess.run(["msb", "remove", "--force", name], stdout=log,
                                                   stderr=subprocess.STDOUT, timeout=120).returncode if name in known else 0
                except (subprocess.SubprocessError, OSError) as exc:
                    log.write(str(exc).encode())
                    cleanup[name] = 1
        archive.unlink(missing_ok=True)
        rss_keys = [name + "_rss_kib" for name in names]
        latencies = sorted(row["ready_ms"] for row in samples if row["ready_ms"] is not None)
        peak = max(samples, key=lambda row: sum(row[key] for key in rss_keys), default=None)
        pressure = {str(level): sum(row["pressure"] == level for row in samples) for level in (1, 2, 4)}
        idle_samples = [r["cpu_idle"] for r in samples if r["cpu_idle"] is not None]
        summary = dict(cpu_idle_mean=sum(idle_samples)/len(idle_samples) if idle_samples else None, samples=len(samples), duration_s=round(time.monotonic()-began, 3), initial_swap_mib=initial_swap,
                       final_swap_mib=swap_used(), peak_swap_mib=max((r["swap_mib"] for r in samples), default=initial_swap),
                       pressure=pressure, per_vm_peak_rss_kib={name: max((r[name+"_rss_kib"] for r in samples), default=0) for name in names},
                       ready_samples=len(latencies), ready_p95_ms=latencies[math.ceil(.95*len(latencies))-1] if latencies else None,
                       effective_reserve_gib=(profile["memory_bytes"]-sum(peak[k] for k in rss_keys)*1024-peak["host_free_bytes"])/GIB if peak else None,
                       load_exit_codes=results, cleanup=cleanup, failure=failure, reserve_bytes=detected["reserve_bytes"], machine_memory_mib=memory_mib,
                       acceptance="partial: third profile; 24/32 GiB hosts and controlled full calibration still required")
        (evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    if failure or any(results) or any(cleanup.values()):
        raise SystemExit(1)


def swap_used():
    return float(re.search(r"used = ([\d.]+)M", sysctl("vm.swapusage"))[1])


def ready_ms(url):
    start = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=.5) as response:
            if response.status != 200:
                return None
        return (time.monotonic() - start) * 1000
    except Exception:
        return None


def free_memory():
    text = output("vm_stat")
    page = int(re.search(r"page size of (\d+) bytes", text)[1])
    return int(re.search(r"Pages free:\s+(\d+)", text)[1]) * page


def cpu_idle():
    try:
        text = subprocess.check_output(["/usr/bin/top", "-l", "1", "-n", "0"], text=True, timeout=10)
    except (subprocess.SubprocessError, OSError):
        return None
    match = re.search(r"([\d.]+)% idle", text)
    return float(match[1]) if match else None


def guest_free(evidence, name, seconds):
    with (evidence / (name + "-guest-free-samples.txt")).open("a") as guest:
        guest.write(str(seconds) + "\n")
        try:
            subprocess.run(["msb", "exec", "--stream", name, "--", "free", "-m"], stdin=subprocess.DEVNULL,
                           stdout=guest, stderr=subprocess.STDOUT, timeout=10)
        except (subprocess.SubprocessError, OSError) as exc:
            guest.write(str(exc) + "\n")


if __name__ == "__main__":
    main()
