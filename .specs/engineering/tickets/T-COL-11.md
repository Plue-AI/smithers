# T-COL-11 Spike: reference-host rerun and the ADR 0003 topology decision; capture growth, versions commit, kernel probes

Stage W0, S1 · Size M · Depends on W0: T-COL-01 · S1: T-COL-10 · Unblocks T-COL-08, T-COL-08b · Issue: [#3553](https://github.com/smithersai/smithers/issues/3553)
Spec: spec.md §1.4, §7.1, §7.4.1–7.4.2, §7.6, §8.2.1, §9.1.1, §9.2.2, §18 · Delta: delta.md §4 (host relay, live channel) · Product: mvp.md J3.5, §6.8 Live co-editing, §9 Live updates, M-02

## Goal

Measure capture storage and guest capabilities, and rerun the transport decision on the specified reference host.

## Scope

In:
- ADR 0003 "Live code co-editing: one live channel, documents addressed by topic, the daemon as disk authority", recording spec §7.6 and the measured numbers from T-COL-01. The contracts below are topology-neutral: a browser addresses a document only by its topic (`doc:code:<branch>:<path>`) and never learns where its Yrs authority lives (§7.4.2), so this ticket lands in stage 1 under either topology.
- The topology decision, in ADR 0003, written only after T-COL-01 re-runs on an idle reference host with browsers on a second device. If relay p95 exceeds 20 ms for 4 KiB frames under guest load, or bridge keystroke p95 exceeds 1 s at 30 Hz, ADR 0003 adopts the host-side document mirror for fan-out, with the daemon kept as the disk authority; otherwise documents live in the daemon. The decision is recorded before T-COL-08 starts. Spec §7.4.6 and §9.2 hold under both.
- jj snapshot latency (§9.1.2a): a VM with a clone of `smithersai/smithers` at `main`, dependencies installed under ignored paths. Time `jj util snapshot` after 1, 12 and 200 changed files, and with no change, each idle and with every guest vCPU busy. Captures and the overflow resync run one snapshot each (§9.1.3, §9.3.2), so this bounds them.
- Growth (§9.1.2a): run 1,000 captures, each after 12 changed files, and record the growth of `.jj/` and `.git/` per capture; then `jj op abandon` everything older than the newest 100 operations plus `jj util gc` and record what it reclaims. Also time one burst's versions commit (12 blobs, one tree, one commit; §9.3.4), n ≥ 100.
- Guest kernel probes for T-COL-03 and T-COL-08: `renameat2(RENAME_EXCHANGE)` and `RENAME_NOREPLACE` on the working-copy filesystem, `openat2` with `RESOLVE_BENEATH`, and cgroup v2 `cgroup.freeze` and `cgroup.kill`. Each is a recorded yes or no.

Out:
- The landed scope of T-COL-01, except the follow-up measurements stated here.
- Production relay, mirror, daemon, document, capture-retention and kernel-fallback implementation; wire/API changes, presence, attribution and UI Views. T-COL-10 owns the `base_digest` rule, T-COL-03r the wire contract and T-COL-08b the document frames (minimal-code synthesis, 2026-10-03); T-COL-03 and T-COL-08 implement the chosen topology.

## Changes

- `docs/architecture/0003-live-code-co-editing.md`: fill ADR 0003's topology section with the decision, the rejected alternatives (host-side documents through `PUT /files/content`; per-file `msb exec`), and the T-COL-01 latency results with their artifact path. S1 depends on T-COL-10 creating the ADR with the `base_digest` rule. W0 records its measurements and provisional topology result in check evidence without editing that later-stage file. smithers-8a accepts ADR 0003 after smithers-3f reviews the transport and disk-authority seam; smithers-38 reviews any TS contract impact. Checks: C-SPK-03, C-SPK-07.
- Extend the disposable spike and retain its raw evidence in the existing check evidence directories.
- `scripts/spikes/col-01/` (new): `run.sh` (one command), `relay-rtt/` (Go client), `echo/` (Rust guest server), `dochost/` (Rust Yrs host), `fanout/` (Go WebSocket fan-out), `keystrokes.spec.ts` (Playwright, two pages), `jj-snapshot/` (timing script run inside the VM). The prototype runs against `packages/backend/microsandbox/transport.go:67` (`DialWorkspacePort`) and `:126` (`startBridges`) without modifying them.
- No change to `packages/`, `apps/` or `crates/`. Delete `scripts/spikes/col-01/` when ADR 0003 records the result. The evidence directory keeps the raw samples (AGENTS.md: benchmark methods and artifacts are retained).

## Tests

- spike: capture growth per capture and after abandon plus gc, and the versions-commit p95, in the same directory. The 14-day projection (one capture per 5 s, 8 h a day) must stay under 2 GiB per machine, or smithers-8a approves and records a shorter retention window in §9.1.2a; this spike does not implement the policy change.
- spike: the four kernel probes, each yes or no.
- Rerun C-SPK-03 and C-SPK-07 on the idle reference host with browsers on a second device. `scripts/spikes/col-01/run.sh` drives the existing `DialWorkspacePort` and `startBridges` boundaries; browser updates enter the prototype WebSocket fan-out through its LAN listener. Direct echo calls or localhost-only browser runs do not establish these measurements.
- Capture, versions-commit and kernel probes run in the real machine working-copy filesystem. Literal fixture bytes, frame sizes, sequence tags, 20 ms loaded relay decision threshold, 1 s keystroke threshold and 2 GiB growth threshold are pinned in the harness, never derived from spec files or runtime implementation constants. The C-SPK-03 100 ms loaded transport budget is distinct from this ticket's 20 ms topology trigger.
- S1 acceptance: smithers-8a signs ADR 0003's topology section, which cites the W0 raw samples and applies the stated OR rule. A measured budget miss triggers the fallback decision; it is never relabeled a passing latency result.

## Acceptance

- [C-SPK-03](../checks/C-SPK-03.md): reference-host round-trip results and raw samples; attach capture-growth, versions-commit and kernel-probe evidence alongside them.
- [C-SPK-07](../checks/C-SPK-07.md): reference-host keystroke p95 under 1 s with two browsers on a second Mac and converged text and disk.

## Risks and notes

- First run (2026-10-02, QA): relay 4 KiB busy p95 197 ms (target 20 ms) and bridge 30 Hz keystroke p95 1,738 ms (target 1 s), on a contended M3 Max with no second device. That run doesn't decide anything: the spike re-runs on an idle reference host with browsers on a second device, and this ticket's decision rule turns that re-run into ADR 0003's topology.

## Ready checklist

1. Dependencies: W0 depends on T-COL-01's disposable prototype and uses existing msb/image/transports; S1 depends on T-COL-10 creating ADR 0003. Neither phase depends on the later production daemon or mirror.
2. Exclusions: contracts, production transport/mirror/documents, retention implementation, kernel workarounds, attribution and Views are explicitly assigned elsewhere.
3. Boundary tests: C-SPK-03/C-SPK-07 drive real transport and the LAN prototype listener; capture and kernel probes run on the guest working-copy filesystem. Literal independent fixtures fix expectations. A budget miss is recorded as a miss and selects the fallback, not a fabricated PASS. S1 requires the signed ADR section.
4. Decisions: smithers-8a accepts ADR 0003, retention changes and kernel-probe consequences; Will approves any product-budget or disk-authority change. smithers-3f approves the transport/security seam; smithers-38 signs any TS contract diff under §21.1.
5. Owner pre-review: smithers-38: answered 18:2x, ok. smithers-3f before W0 and S1, smithers-38 before S1. Are second-device measurements uncontended and do the 20 ms topology trigger and 100 ms transport budget stay distinct? Do probes run on the actual guest filesystem with raw results? Does the chosen topology preserve topic-only browser addressing and daemon-only durable save acknowledgments without changing TS contracts? smithers-3f: answered 18:2x, ok.
6. Security: smithers-3f reviews execution placement before start. Repository dependency installs, capture commands, growth/GC commands, kernel probes and document saves run only inside disposable machines. Host code measures and forwards frames; it never loads repository flows or executes repository commands. Use synthetic data and no production homes, credentials or provider keys.
