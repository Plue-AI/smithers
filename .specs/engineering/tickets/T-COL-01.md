# T-COL-01 Spike: relay round trip, Yjs keystroke p95 and jj capture cost in a disposable machine

Stage W0 · Size S · Depends on — · Unblocks T-COL-11 · Issue: [#3441](https://github.com/smithersai/smithers/issues/3441)
Spec: spec.md §1.4, §7.1, §7.4.1–7.4.2, §7.6, §8.2.1, §9.1.1, §9.2.2, §18 · Delta: delta.md §4 (host relay, live channel) · Product: mvp.md J3.5, §6.8 Live co-editing, §9 Live updates, M-02
Ready: 2026-10-03 smithers-8a sha256:97d2f3b1853f

## Goal

Answer three yes/no questions with numbers on the reference host (the team's Mac mini, whatever its size; every artifact records the host profile, §8.2.1):
- Does one host↔guest connection add under 20 ms p95 per round trip?
- Does a keystroke travel browser→host→VM→browser in under 1 s p95 from browsers on a second Mac on the same network?
- Does one jj snapshot of the smithers repository's working copy inside a VM take under 500 ms p95 (§9.1.2a)?

## Scope

In:
- A disposable, one-command prototype: a Go echo client and a Rust echo server on a guest loopback port, measured over both existing transports. The first is `relay` (host dials the guest through `msb exec --stream`). The second is `bridge` (the guest dials a host port at guest `127.0.0.1`).
- A throwaway Yrs document host in the VM (`yrs =0.27.4`, one `Y.Text("content")`), a throwaway Go WebSocket fan-out in the host, and two browser tabs on a second Mac running the app's `yjs 13.6.32` (`apps/app/package.json:62`).
- The prototype document host writes to disk with the §9.2.2 debounce (200 ms after the last update, 1 s maximum, temp file + `fsync` + `rename`), so the disk-write cost is part of the measurement.
- jj snapshot latency (§9.1.2a): a VM with a clone of `smithersai/smithers` at `main`, dependencies installed under ignored paths. Time `jj util snapshot` after 1, 12 and 200 changed files, and with no change, each idle and with every guest vCPU busy. The daemon will run one snapshot per burst (§9.3.4), so this bounds burst close and capture.
- A control measurement of the E-04 rejected alternative: 100 sequential `WriteWorkspaceFile` calls (`packages/backend/internal/services/workspace_facets.go:244`, one `msb exec` per write).
- A one-page result recorded in ADR 0003 (T-COL-10): the transport chosen for T-COL-03, the measured p50/p95/p99, the snapshot latency table, and whether the overview's fallback is needed. The fallback is a host-side document mirror for fan-out, with the VM as the disk authority.

Out:
- Product code. Nothing from the prototype is ported. T-COL-03 and T-COL-08 rebuild only the validated decisions.
- Authentication, presence, awareness, attribution and the `/api/live` protocol (T-COL-02, T-COL-06, T-COL-08).
- The watcher and attribution (T-COL-04). Kernel per-write attribution is [D] (§9.3.1).
- VM memory (T-MCH-01). The weekly `jj op abandon` policy (§9.1.2a, T-COL-03).

## Changes

- `scripts/spikes/col-01/` (new): `run.sh` (one command), `relay-rtt/` (Go client), `echo/` (Rust guest server), `dochost/` (Rust Yrs host), `fanout/` (Go WebSocket fan-out), `keystrokes.spec.ts` (Playwright, two pages), `jj-snapshot/` (timing script run inside the VM). The prototype runs against `packages/backend/microsandbox/transport.go:67` (`DialWorkspacePort`) and `:126` (`startBridges`) without modifying them.
- No change to `packages/`, `apps/` or `crates/`. Delete `scripts/spikes/col-01/` when ADR 0003 records the result. The evidence directory keeps the raw samples (AGENTS.md: benchmark methods and artifacts are retained).

## Tests

- spike: C-SPK-03 measures round trips for 64 B and 4 KiB frames over each transport, idle and with all guest vCPUs busy (n ≥ 1,000 per cell).
- spike: C-SPK-07 measures keystroke latency with two browsers on a second Mac against a plain-HTTP LAN origin (n ≥ 1,000 keystrokes) and checks that both pages and the file on disk converge to the same text.
- spike: the `WriteWorkspaceFile` control records p50/p95 per write (n = 100).
- spike: jj snapshot latency on the smithers repository, n ≥ 100 per cell, p95 < 500 ms for the 12-file cell idle. The raw samples go in the C-SPK-03 evidence directory.

## Acceptance

- [C-SPK-03](../checks/C-SPK-03.md): relay round trip p95 < 20 ms idle on the reference host. The report names the transport T-COL-03 uses.
- [C-SPK-07](../checks/C-SPK-07.md): keystroke p95 < 1 s browser→host→VM→browser from a second Mac, n ≥ 1,000, with converged text and disk content.

## Risks and notes

- The `relay` path spawns one `msb exec` per connection and pipes through a Python helper (`microsandbox/guest/smithers-guest.py:319`). That may add jitter above 20 ms p95. Confirmed if the 4 KiB idle p95 over `relay` exceeds 20 ms while `bridge` stays under it. Then T-COL-03 uses `bridge`, with the daemon dialing the host.
- A busy guest (a `pnpm test` run uses every vCPU) can starve the daemon. Confirmed if the loaded p95 exceeds 100 ms. Then T-COL-03 must run the daemon at a higher scheduling priority, and the tech lead decides before T-COL-03 starts.
- The browser→host network leg takes the dominant share of the latency. Confirmed if that leg is more than 50 % of the p95. The fallback then does not help, and the tech lead takes the result to Will. The install has no network product of its own (§1.4), so the spike measures the plain LAN path that every exposure shares.
- The smithers working copy is large, and `jj util snapshot` walks it. Confirmed if the no-change snapshot p95 exceeds 500 ms. Then the tech lead decides, before T-COL-04 sets the burst close rule, whether T-COL-03 enables jj's `core.fsmonitor` (watchman).
- Decisions this spike must not make alone: dropping the VM as the document host (E-04), or adding a transport other than `relay`/`bridge`. Escalate both to the tech lead with the numbers.
