# C-SPK-03 Host↔guest relay round trip

Proves: mvp.md §9 Live updates (transport share) · spec.md §9.1.1, §1.4 (host-relay port), §8.2.1; overview.md E-04 · Layer: spike · Stage: W0 · Tickets: T-COL-01, T-COL-11
Automation: to write, as a `smthrs test` target · Runs in: reference host

## Setup

- Reference host: the team's Mac mini, macOS 15+, whatever its size, with `msb` 0.6.16 and libkrun. Record the commit, `msb --version` and the host profile (spec §8.2.1).
- One microVM booted from `DefaultImage` (`packages/backend/microsandbox/runtime.go:57`) with the machine memory and vCPUs §8.2.1 derives for that host, and no other VM running.
- The Rust echo server from `scripts/spikes/col-01/echo/` listens on a guest loopback port, and a host listener is bridged into the guest.
- No browser or network is involved: this check isolates the host↔guest leg.

Candidate Automation declaration (unapproved): `scripts/spikes/col-01/relay-rtt/` (new; `scripts/spikes/col-01/run.sh rtt`) · Runs in: reference host

Receipt: CI's own check run at the landed SHA, or a `smthrs test` run on the reference host, recorded through `scripts/check-run.mjs` (minimal-code synthesis ruling 3).

## Steps

1. Transport A, `relay`: open one connection with `DialWorkspacePort` (`microsandbox/transport.go:67`) and keep it open for the whole run.
2. Send 1,000 frames of 64 B, one at a time. Record the host monotonic clock (`time.Now()` monotonic reading) at send and at echo receipt. Repeat with 1,000 frames of 4 KiB.
3. Transport B, `bridge`: the guest echo client dials the bridged host port (`transport.go:126` `startBridges`). Repeat step 2 with the host as the echo side, timed on the host clock.
4. Start a CPU load on every guest vCPU (`yes > /dev/null` × 4) and repeat steps 2–3.
5. Record connection setup time for each transport (n = 20).

## Pass when

- For at least one transport, the idle round trip p95 is < 20 ms for both frame sizes, with n ≥ 1,000 each, on the host monotonic clock.
- That transport's loaded p95 (step 4) is < 100 ms.
- No frame is lost, reordered or corrupted: every echo byte-equals its frame.
- The report names the transport T-COL-03 uses and attaches p50/p95/p99 for every cell.

## Fail when

- The p95 is computed from a subset (warm-up dropped without saying so) or from fewer than 1,000 samples.
- A new connection is opened per frame, which measures `msb exec` spawn time and not the long-lived relay.
- Times are taken in the guest and compared with host times (two clocks).
- The loaded run is skipped, or a transport is named as chosen without the numbers that pick it.

## Evidence

`.artifacts/checks/C-SPK-03/<UTC timestamp>/`: `samples.csv` (transport, size, load, rtt_ns), `summary.json` (percentiles per cell), `env.json` (commit, `msb --version`, VM config, macOS version, host profile), and the chosen transport with one line of reason.

## T-COL-11 decision receipt

A reference-host budget miss is retained as a failed measurement, with raw samples. T-COL-11 W0 completes its decision evidence when the matrix is complete and the topology trigger is applied; S1 additionally requires smithers-8a to accept ADR 0003 after T-COL-10 creates it. This does not waive the production latency budget. Expected bytes, frame sizes, sequence tags and thresholds are literal harness fixtures, never derived from spec files or runtime implementation constants. Capture/growth/GC and kernel commands run only inside the disposable machine, reviewed by smithers-3f.
