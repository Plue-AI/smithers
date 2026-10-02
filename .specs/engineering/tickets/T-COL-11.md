# T-COL-11 Spike: capture growth, versions commit, kernel probes and reference-host rerun

Stage W0 · Size M · Depends on T-COL-01 · Unblocks — · Issue: to file
Spec: spec.md §1.4, §7.1, §7.4.1–7.4.2, §7.6, §8.2.1, §9.1.1, §9.2.2, §18 · Delta: delta.md §4 (host relay, live channel) · Product: mvp.md J3.5, §6.8 Live co-editing, §9 Live updates, M-02

## Goal

Measure capture storage and guest capabilities, and rerun the transport decision on the specified reference host.

## Scope

In:
- jj snapshot latency (§9.1.2a): a VM with a clone of `smithersai/smithers` at `main`, dependencies installed under ignored paths. Time `jj util snapshot` after 1, 12 and 200 changed files, and with no change, each idle and with every guest vCPU busy. Captures and the overflow resync run one snapshot each (§9.1.3, §9.3.2), so this bounds them.
- Growth (§9.1.2a): run 1,000 captures, each after 12 changed files, and record the growth of `.jj/` and `.git/` per capture; then `jj op abandon` everything older than the newest 100 operations plus `jj util gc` and record what it reclaims. Also time one burst's versions commit (12 blobs, one tree, one commit; §9.3.4), n ≥ 100.
- Guest kernel probes for T-COL-03 and T-COL-08: `renameat2(RENAME_EXCHANGE)` and `RENAME_NOREPLACE` on the working-copy filesystem, `openat2` with `RESOLVE_BENEATH`, and cgroup v2 `cgroup.freeze` and `cgroup.kill`. Each is a recorded yes or no.

Out:
- The landed scope of T-COL-01, except the follow-up changes stated here.

## Changes

- Extend the disposable spike and retain its raw evidence in the existing check evidence directories.
- `scripts/spikes/col-01/` (new): `run.sh` (one command), `relay-rtt/` (Go client), `echo/` (Rust guest server), `dochost/` (Rust Yrs host), `fanout/` (Go WebSocket fan-out), `keystrokes.spec.ts` (Playwright, two pages), `jj-snapshot/` (timing script run inside the VM). The prototype runs against `packages/backend/microsandbox/transport.go:67` (`DialWorkspacePort`) and `:126` (`startBridges`) without modifying them.
- No change to `packages/`, `apps/` or `crates/`. Delete `scripts/spikes/col-01/` when ADR 0003 records the result. The evidence directory keeps the raw samples (AGENTS.md: benchmark methods and artifacts are retained).

## Tests

- spike: capture growth per capture and after abandon plus gc, and the versions-commit p95, in the same directory. The 14-day projection (one capture per 5 s, 8 h a day) must stay under 2 GiB per machine, or the tech lead shortens the 7-day window in §9.1.2a.
- spike: the four kernel probes, each yes or no.
- Rerun C-SPK-03 and C-SPK-07 on the idle reference host with browsers on a second device.

## Acceptance

- [C-SPK-03](../checks/C-SPK-03.md): reference-host round-trip results and raw samples; attach capture-growth, versions-commit and kernel-probe evidence alongside them.
- [C-SPK-07](../checks/C-SPK-07.md): reference-host keystroke p95 under 1 s with two browsers on a second Mac and converged text and disk.

## Risks and notes

- First run (2026-10-02, QA): relay 4 KiB busy p95 197 ms (target 20 ms) and bridge 30 Hz keystroke p95 1,738 ms (target 1 s), on a contended M3 Max with no second device. That run doesn't decide anything: the spike re-runs on an idle reference host with browsers on a second device, and T-COL-10's decision rule turns that re-run into ADR 0003's topology.
