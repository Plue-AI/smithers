# ADR 0003: Live code co-editing: one live channel, documents addressed by topic, the daemon as disk authority

Status: proposed (2026-10-06). This file holds only the T-COL-01 spike result ([#3441](https://github.com/smithersai/smithers/issues/3441)): **spike result, decision by T-COL-10**. T-COL-10 ([#3508](https://github.com/smithersai/smithers/issues/3508)) writes this record's decision, the `base_digest` rule. Its topology section is decided by T-COL-11 ([#3553](https://github.com/smithersai/smithers/issues/3553)), which smithers-8a accepts.

## Topology

Decided by T-COL-11. The spike result below is its W0 input.

## Spike result (T-COL-01)

Measured on 2026-10-06 with `scripts/spikes/col-01/run.sh` against the unchanged `DialWorkspacePort` (`packages/backend/microsandbox/transport.go:67`) and `startBridges` (`:126`).

### Answers

| Question (T-COL-01 goal) | Answer | Number |
| --- | --- | --- |
| One host↔guest connection adds < 20 ms p95 per round trip? | yes, on `relay` | relay idle 4 KiB p95 0.787 ms, n = 1,000 |
| Keystroke browser→host→VM→browser < 1 s p95 from a second Mac? | yes, both transports | worst p95 345.3 ms (bridge, 30 Hz) |
| One jj snapshot of the smithers working copy < 500 ms p95? | yes | idle 12-file p95 234.0 ms, n = 100 |

### Recommendation for T-COL-03's boot file

`topology=relay`. Relay passes every C-SPK-03 cell with a 25x margin on the idle gate. The ticket's bridge trigger (relay 4 KiB idle p95 > 20 ms while bridge stays under) did not occur: relay is 0.787 ms, and the unchanged bridge is 53.6 ms.

The bridge failure is the documented Nagle/delayed-ACK confounder, now confirmed. The guest helper's `bridge` (`microsandbox/guest/smithers-guest.py`) leaves Nagle on; a 4 KiB frame waits about 50 ms for a delayed ACK at every load. The spike-only copy with `TCP_NODELAY` on both sockets (`scripts/spikes/col-01/echo/bridge_nodelay.py`) brings bridge 4 KiB idle p95 to 0.409 ms. If T-COL-11 picks `bridge`, the helper must set `TCP_NODELAY` first. Both transports stay implemented (ADR 0004).

The host-side document mirror fallback is **not needed** by T-COL-11's rule: relay 4 KiB p95 under guest load is 0.464 ms (trigger 20 ms), and bridge 30 Hz keystroke p95 is 345.3 ms (trigger 1 s). No decision here drops the VM as document host (E-04) or adds a transport.

### Host profile (spec §8.2.1)

| Item | Value |
| --- | --- |
| Reference host | Mac mini Mac16,11, Apple M4 Pro, 14 cores (10 performance), 64 GiB, macOS 26.6.2 (25G83), `msb 0.6.16` |
| Machine | `DefaultImage` (`node@sha256:71fed097…798b`), 4 vCPU, 8 GiB, 32 GiB disk, guest kernel 6.12.99 |
| Second Mac | MacBook Pro on the same Wi-Fi (802.11ax, 6 GHz, 160 MHz); host also on Wi-Fi (`en1`); 20-ping RTT min 4.9 ms, max 93–212 ms |
| Browser | Playwright 1.62.1 headless Chromium 151.0.7922.34, `yjs 13.6.32`, plain-HTTP insecure context |
| Harness | lane at `e02b0ccb71` plus the `scripts/spikes/col-01/` changes landed with this record |

Isolation: the team's other lanes kept the host busy; during the RTT run the 1-minute load ranged 8.3–134 (median 26). The 2026-10-05 run's relay idle failures (p95 43–57 ms at load about 50) came from that contention, not the transport. Every run and RTT cell started only below load 10 (guest busy workers subtracted) and was rerun if it ended at or above 10; rejected attempts are kept. The first three idle cells (relay 64 B and 4 KiB, bridge 64 B) ran beside one other lane's running VM, which can only add latency. Keystroke and snapshot runs were gated at start only: host load rose to 24–27 during the keystroke runs and stayed at 11.5–17.6 during the snapshot cells. Extra host load only adds latency, so every pass below is conservative.

### C-SPK-03 round trip (n = 1,000 per cell, host monotonic clock, nearest rank, no warm-up dropped)

| Transport | Load | Frame | p50 ms | p95 ms | p99 ms | Gate | Host load before→after |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| relay | idle | 64 B | 0.211 | 0.271 | 1.142 | pass < 20 | 9.84→9.84 |
| relay | idle | 4 KiB | 0.279 | 0.787 | 4.750 | pass < 20 | 9.84→9.84 |
| bridge | idle | 64 B | 0.194 | 0.383 | 0.554 | pass < 20 | 9.84→9.84 |
| bridge | idle | 4 KiB | 50.029 | 53.605 | 61.866 | **fail** < 20 | 9.19→9.91 (attempt 3) |
| bridge-nodelay | idle | 64 B | 0.093 | 0.220 | 0.305 | pass < 20 | 9.91→9.91 |
| bridge-nodelay | idle | 4 KiB | 0.181 | 0.409 | 0.530 | pass < 20 | 9.91→9.91 |
| relay | busy | 64 B | 0.164 | 0.219 | 9.185 | pass < 100 | 9.91→9.84 |
| relay | busy | 4 KiB | 0.218 | 0.464 | 1.867 | pass < 100 | 9.84→9.84 |
| bridge | busy | 64 B | 0.121 | 0.269 | 0.540 | pass < 100 | 9.84→9.84 |
| bridge | busy | 4 KiB | 50.071 | 60.085 | 60.724 | pass < 100 | 13.90→13.54 (attempt 2) |
| bridge-nodelay | busy | 64 B | 0.091 | 0.154 | 0.224 | pass < 100 | 13.54→13.54 |
| bridge-nodelay | busy | 4 KiB | 0.144 | 0.234 | 0.314 | pass < 100 | 13.54→13.26 |

Busy means 4 `yes` workers on the 4 guest vCPUs, counted before sampling; busy-cell load includes those 4. Every echo byte-equalled its frame. `bridge-nodelay` is a diagnostic and is never chosen. The 3 rejected bridge 4 KiB attempts had the same 50 ms p50, so the plateau does not depend on host load.

Connection setup (n = 20, includes `msb exec` spawn): relay p50 69.6 / p95 83.1 / p99 170.4 ms; bridge 108.2 / 200.4 / 229.5 ms; bridge-nodelay 113.4 / 127.6 / 136.2 ms.

E-04 control, 100 sequential writes, every readback verified: `WriteWorkspaceFile` service path (two guest execs) p50 245.3 / p95 435.0 / p99 457.6 ms; one-exec `Runtime.WriteFile` p50 91.0 / p95 221.7 / p99 269.0 ms. Both are 300–1,000x a relay round trip.

### C-SPK-07 keystrokes from the second Mac (runner monotonic clock, first keystroke included)

| Transport | Workload | n | p50 ms | p95 ms | p99 ms | Per-editor p95 ms | Converged |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| bridge | 10 Hz | 1,000 | 13.1 | 136.6 | 190.4 | A 136.6 | A = B = disk |
| bridge | 30 Hz | 1,000 | 14.5 | 345.3 | 902.7 | A 345.3 | A = B = disk |
| bridge | concurrent 10 Hz | 2,000 | 16.3 | 139.2 | 207.0 | A 141.1, B 137.3 | A = B = disk |
| relay | 10 Hz | 1,000 | 11.6 | 110.5 | 152.8 | A 110.5 | A = B = disk |
| relay | 30 Hz | 1,000 | 10.3 | 108.7 | 150.7 | A 108.7 | A = B = disk |
| relay | concurrent 10 Hz | 2,000 | 16.0 | 160.5 | 382.7 | A 161.7, B 158.5 | A = B = disk |

Every sequence tag arrived exactly once, and the disk file matched both pages 1.5 s after each run (SHA-256 recorded per run). Achieved send rates equalled the targets.

Where the tail goes (mean share of latency over the samples at or above p95; one-way legs use a minimum-RTT clock offset, ±2.4–5.4 ms):

| Transport | Workload | browser→host | host→VM→host | host→browser |
| --- | --- | ---: | ---: | ---: |
| bridge | 10 Hz | 29 % | 58 % | 13 % |
| bridge | 30 Hz | **89 %** | 8 % | 3 % |
| bridge | concurrent 10 Hz | 21 % | 33 % (+34 % fan-out queue) | 12 % |
| relay | 10 Hz | 15 % | 80 % | 4 % |
| relay | 30 Hz | 36 % | 56 % | 8 % |
| relay | concurrent 10 Hz | **62 %** | 7 % (+7 % queue) | 24 % |

The ticket's network-leg risk (browser→host > 50 % of p95) is confirmed in 2 of 6 runs; Wi-Fi jitter on that leg reached 300 ms at p95. A host-side mirror cannot shorten that leg. The 10 Hz host→VM tail (p95 about 90 ms on both transports, 1–2 ms at 30 Hz) is consistent with the prototype's save running on the update path (`scripts/spikes/col-01/dochost/main.rs` persists inside the frame loop): the 1 s maximum fires once a second, so at 10 Hz one keystroke in 10 waits behind fsync and rename, and at 30 Hz one in 30, below the p95 rank. The daemon should save off the update path.

Deviation: macOS Local Network privacy blocks Homebrew `node` and Chromium on the second Mac from LAN peers (`EHOSTUNREACH`). The runner therefore used the second Mac's own LAN address, `http://10.0.0.22:39041`, and Apple's `/usr/bin/python3` relayed it, with `TCP_NODELAY`, to the host at `http://10.0.0.59:39041`. Every byte still crossed the Wi-Fi link; the relay added about 1 ms per HTTP request (13.2 ms direct versus 14.1 ms relayed, median of 5). Granting the terminal Local Network access removes the relay.

### jj snapshot (§9.1.2a; n = 100 per cell, includes jj process start and the full scan)

| Guest load | Changed files | p50 ms | p95 ms | p99 ms | max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| idle | 0 | 82.7 | 97.7 | 105.3 | 106.1 |
| idle | 1 | 173.3 | 228.1 | 251.7 | 298.8 |
| idle | 12 | 179.7 | **234.0** | 256.8 | 373.0 |
| idle | 200 | 197.0 | 248.9 | 321.0 | 408.1 |
| busy | 0 | 84.8 | 107.8 | 162.7 | 164.6 |
| busy | 1 | 218.6 | 283.0 | 332.7 | 397.7 |
| busy | 12 | 221.4 | 271.4 | 382.5 | 409.5 |
| busy | 200 | 634.3 | 690.3 | 720.4 | 739.3 |

`jj 0.39.0` (`jj util snapshot`, a new process per sample) on a depth-1 clone of public `main` at `3a4488ae64`, with dependencies installed offline under ignored `node_modules` from the Linux ARM64 store archive (`dfc3d565…195d`, built by `scripts/spikes/col-01/store.sh`). Edits rewrite N of 200 tracked 128-byte fixture files. The 12-file idle gate (500 ms) passes with 2x margin. No-change p95 is 97.7 ms, so the fsmonitor (watchman) question does not arise. Only 200 files with every vCPU busy exceeds 500 ms; at one capture per 5 s (§9.1.3) that is 14 % of one vCPU.

T-COL-11 follow-ups from the same machine, for that ticket: 1,000 12-file captures grew `.jj` by 92.7 MB and `jj op abandon` plus `jj util gc` reclaimed 281.6 MB; the gross 14-day projection is 7.47 GB, over the 2 GiB budget. The synthetic versions commit took p50 9.5 / p95 16.0 / p99 20.4 ms (n = 100). The growth budget miss stopped the run before the kernel probes, which remain unmeasured.

### Evidence

On the reference host under `~/lanes/x-t-col-01c/.artifacts/checks/` and copied to the second Mac's checkout under `.artifacts/checks/`: C-SPK-03 `20261006T175240.156069000Z` (RTT `samples.csv`, `samples-rejected.csv`, `setup.csv`, `summary.json`, `env.json`, `host-load.csv`), `20261006T204136.340244000Z` (control), `20261007T002537.278841000Z` (snapshot, plus the T-COL-11 growth, versions-commit and kernel follow-ups); the two failed snapshot preparations (`20261006T224859.635243000Z`, `20261007T001725.176696000Z`) are kept; C-SPK-07 `20261006T221846Z-remote-bridge` and `20261006T224353Z-remote-relay` (keystrokes.csv, clock calibration, traces, A/B/disk texts and hashes, client network receipt) with the host-side `20261006T221702.234206000Z` and `20261006T222354.430225000Z`. The first RTT attempt (`20261006T161018.318525000Z`) stopped at its 60-minute load wait and is kept.
