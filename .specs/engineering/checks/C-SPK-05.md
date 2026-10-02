# C-SPK-05 Host swap and memory pressure with 2 (24 GB) and 3 (32 GB) busy machines

Proves: mvp.md M-06, §9 Branch wake · spec.md §8.2.1, §8.2.2, §18 · Layer: spike · Stage: W0 · Tickets: T-MCH-01
Automation: `scripts/spikes/mch-01-memory/run.sh` (new) · Runs in: the reference host plus one Apple Silicon Mac with a different memory size

## Setup

- Two Apple Silicon Macs on macOS 15+ with different memory sizes; 24 GiB and 32 GiB are the expected examples, and one of them is the reference host (the team's Mac mini, whatever its size). Each is freshly rebooted, with no other user apps. The two hosts are calibration points for the reserve and the per-machine memory in the §8.2.1 formula, not product rules.
- On each: the host service and bundled PostgreSQL 18 from `main` at the commit under test (`pnpm dev`, `SMITHERS_WORKSPACE_ISOLATION=microvm`), and `msb` 0.6.16.
- Machines sized by the §8.2.1 formula from the detected profile with reserve 8 GiB: machine memory 8 GiB (6 GiB below 24 GiB of host memory) and vCPUs `clamp(perf_cores / 2, 2, 4)`. The run loads the formula's memory term, `floor((mem − 8) / machine_mem)` machines (2 and 3 on the example hosts), even when the core or disk term gives a lower capacity, because it calibrates memory. Layers for `smithersai/smithers` are already built.
- Load per machine: `pnpm install --frozen-lockfile` then `pnpm test` in a checkout of `smithersai/smithers` at a fixed commit.

## Steps

1. Record the host profile (§8.2.1): `hw.memsize`, `hw.perflevel0.physicalcpu`, `hw.physicalcpu`, free disk on `$STATE`, the macOS version. Record the starting `sysctl vm.swapusage` and the resident memory of `smithers-backend` and `postgres`.
2. Start the machines and the load in all of them at once.
3. Sample every 1 s until all loads finish: `sysctl vm.swapusage` (used), `sysctl kern.memorystatus_vm_pressure_level`, the RSS of each `msb` process, guest `free -m`, host CPU idle, and `GET /readyz` latency of the host service.
4. On the smaller host: repeat step 2 with one machine plus one layer-prepare VM at the machine size, building the `smithersai/smithers` layers from scratch (§8.2.2).
5. Compute the effective reserve per host: `hw.memsize − Σ VM RSS at peak − free at peak`. Fit the reserve as the larger of the two, rounded up to a whole GiB.

## Pass when

For steps 2–4, on both hosts:
- Swap used grows by ≤ 512 MiB from start to the end of the load.
- The pressure level is 1 (normal) in ≥ 95% of samples and never 4 (critical).
- `/readyz` p95 is under 100 ms over all samples (n ≥ 600).
- Every `pnpm test` and the layer build finish with the same result as on an idle host.
- The fitted reserve and per-machine memory keep the memory term at the counts loaded in step 2. If they don't, the report states the new constants for spec.md §8.2.1 and the capacities they give. The formula's shape doesn't change, and no host-specific rule is introduced.

## Fail when

- Swap grows past 512 MiB, or pressure reaches critical, and the report still keeps the reserve.
- The run omits the host service and PostgreSQL, which hides the reserve they use.
- Step 4 is skipped, leaving the prepare-VM size and slot rule (spec §8.2.2) unmeasured.
- The report proposes a rule keyed to a Mac model or memory size instead of new constants.
- The artifacts don't record each host's profile.

Resolved (tech lead): the proposed swap, pressure and `/readyz` thresholds are accepted for this spike.

## Evidence

`.artifacts/checks/C-SPK-05/<UTC timestamp>/`: per host `profile.json` (the step 1 host profile), `samples.csv`, `summary.json` (peak swap, pressure histogram, `/readyz` p95, CPU idle, effective reserve, test and build results), `sysctl hw` output, the fitted reserve and per-machine memory, the `msb` version and the commit.
