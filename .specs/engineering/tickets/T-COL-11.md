# T-COL-11 Spike: reference-host rerun and the ADR 0003 topology decision; capture growth, versions commit, kernel probes

Stage W0, S1 · Size M · Depends on W0: T-COL-01 · S1: T-COL-10 · Unblocks T-COL-08, T-COL-08b · Issue: [#3553](https://github.com/smithersai/smithers/issues/3553)
Spec: spec.md §1.4, §7.1, §7.4.1–7.4.2, §7.6, §8.2.1, §9.1.1, §9.2.2, §18 · Delta: delta.md §4 (host relay, live channel) · Product: mvp.md J3.5, §6.8 Live co-editing, §9 Live updates, M-02
Ready: 2026-10-03 smithers-8a sha256:640f6dcf1015

## Goal

Measure capture storage and guest capabilities, and rerun the transport decision on the specified reference host.

## Scope

In:
- ADR 0003 "Live code co-editing: one live channel, documents addressed by topic, the daemon as disk authority", recording spec §7.6 and the measured numbers from T-COL-01. The contracts below are topology-neutral: a browser addresses a document only by its topic (`doc:code:<branch>:<path>`) and never learns where its Yrs authority lives (§7.4.2), so this ticket lands in stage 1 under either topology.
- The topology decision, in ADR 0003, written only after T-COL-01 re-runs on an idle reference host with browsers on a second device. If relay p95 exceeds 20 ms for 4 KiB frames under guest load, or bridge keystroke p95 exceeds 1 s at 30 Hz, ADR 0003 adopts the host-side document mirror for fan-out, with the daemon kept as the disk authority; otherwise documents live in the daemon. The decision is recorded before T-COL-08 starts. Spec §7.4.6 and §9.2 hold under both.
- jj snapshot latency (§9.1.2a): a VM with a clone of `smithersai/smithers` at `main`, dependencies installed under ignored paths. Time `jj util snapshot` after 1, 12 and 200 changed files, and with no change, each idle and with every guest vCPU busy. Captures and the overflow resync run one snapshot each (§9.1.3, §9.3.2), so this bounds them.
- Growth (§9.1.2a): run 1,000 captures, each after 12 changed files, and record the growth of `.jj/` and `.git/` per capture; then `jj op abandon` everything older than the newest 100 operations plus `jj util gc` and record what it reclaims. Also time one burst's versions commit (12 blobs, one tree, one commit; §9.3.4), n ≥ 100.
- Guest kernel probes for T-COL-03 and T-COL-08: `renameat2(RENAME_EXCHANGE)` and `RENAME_NOREPLACE` on the working-copy filesystem, `openat2` with `RESOLVE_BENEATH`, and cgroup v2 `cgroup.freeze` and `cgroup.kill`. Each is a recorded yes or no.
- Dark landing: build against T-COL-01’s prototype contract and T-COL-10’s ADR contract. Until T-COL-01 lands, the rerun command refuses missing prototype support without starting a machine or producing a receipt. Until T-COL-10 creates ADR 0003, keep the provisional decision in W0 evidence; do not create a competing ADR or claim S1 acceptance. Nothing enables production co-editing. C-SPK-03/C-SPK-07 exercise both missing-precondition cases.

Out:
- The landed scope of T-COL-01, except the follow-up measurements stated here.
- Production relay, mirror, daemon, document, capture-retention and kernel-fallback implementation; wire/API changes, presence, attribution and UI Views. T-COL-10 owns the `base_digest` rule, T-COL-03r the wire contract and T-COL-08b the document frames (minimal-code synthesis, 2026-10-03); T-COL-03 and T-COL-08 implement the chosen topology.

## Changes

- `docs/architecture/0003-live-code-co-editing.md`: fill ADR 0003's topology section with the decision, the rejected alternatives (host-side documents through `PUT /files/content`; per-file `msb exec`), and the T-COL-01 latency results with their artifact path. S1 depends on T-COL-10 creating the ADR with the `base_digest` rule. W0 records its measurements and provisional topology result in check evidence without editing that later-stage file. smithers-8a accepts ADR 0003 after smithers-3f reviews the transport and disk-authority seam; smithers-38 reviews any TS contract impact. Checks: C-SPK-03, C-SPK-07.
- Extend the disposable spike and retain its raw evidence in the existing check evidence directories.
- Reuse T-COL-01’s `scripts/spikes/col-01/` harness: `run.sh`, `relay-rtt/`, `echo/`, `dochost/`, `fanout/`, `keystrokes.spec.ts` and `jj-snapshot/`. Extend only the growth, versions-commit, kernel and security measurements; no second transport or Yrs prototype. These paths are T-COL-01 deliverables, absent on inspected main. The prototype runs against existing `packages/backend/microsandbox/transport.go:67` (`DialWorkspacePort`) and `:126` (`startBridges`) without modifying them. New measurement helpers are limited to probes the existing transport harness does not supply.
- No change to `packages/`, `apps/` or `crates/`. Retain `scripts/spikes/col-01/` as reproducible benchmark methods with the raw samples; remove disposable machines and generated binaries after measurement (AGENTS.md: benchmark methods and artifacts are retained).

## Tests

- spike: capture growth per capture and after abandon plus gc, and the versions-commit p95, in the same directory. The 14-day projection (one capture per 5 s, 8 h a day) must stay under 2 GiB per machine, or smithers-8a approves and records a shorter retention window in §9.1.2a; this spike does not implement the policy change.
- spike: the four kernel probes, each yes or no.
- Rerun C-SPK-03 and C-SPK-07 on the idle reference host with browsers on a second device. `scripts/spikes/col-01/run.sh` drives the existing `DialWorkspacePort` and `startBridges` boundaries; browser updates enter the prototype WebSocket fan-out through its LAN listener. Direct echo calls or localhost-only browser runs do not establish these measurements.
- Capture, versions-commit and kernel probes run in the real machine working-copy filesystem. Literal fixture bytes, frame sizes, sequence tags, 20 ms loaded relay decision threshold, 1 s keystroke threshold and 2 GiB growth threshold are pinned in the harness, never derived from spec files or runtime implementation constants. The C-SPK-03 100 ms loaded transport budget is distinct from this ticket's 20 ms topology trigger.
- S1 acceptance: smithers-8a signs ADR 0003's topology section, which cites the W0 raw samples and applies the stated OR rule. A measured budget miss triggers the fallback decision; it is never relabeled a passing latency result.
- C-SPK-03 `ExecutionPlacementAndRootInputs`: through `run.sh` machine creation, command launch and cleanup, record executable digests, input provenance, machine identity and effective uid. Assert repository dependency installs, snapshot/growth/GC, versions commits, document saves and filesystem probes run in the machine as non-root; host measurement processes run as non-root. With isolation unavailable, assert refusal before any repository command starts and no host fallback. Reject a branch-built root helper before installation or execution, even if its digest matches a branch-provided manifest. C-SPK-07 records the same placement for its document server and load commands. Fixtures and expected uids/provenance are literal independent harness inputs. A security failure stops measurement and produces no passing receipt.

## Acceptance

- [C-SPK-03](../checks/C-SPK-03.md): reference-host round-trip results and raw samples; attach capture-growth, versions-commit and kernel-probe evidence alongside them.
- [C-SPK-07](../checks/C-SPK-07.md): reference-host keystroke p95 under 1 s with two browsers on a second Mac and converged text and disk.

### Security preconditions and root inputs

- Run host measurement code only from reviewed main or the installed bundle, as non-root. Branch-built measurement code runs only in a machine as non-root. Privileged probes wait for their helper to land on reviewed main; no branch-produced script, binary, toolchain or plist is installed, loaded or executed by root, even after validation. This spike performs no sudo or launchd plist load; INS-03 installation is excluded.
- Fresh-machine provisioning and guest-helper bootstrap consume the main-pinned `DefaultImage` digest (`packages/backend/microsandbox/runtime.go:57`), image-shipped interpreter and system tools, main/bundle-embedded bootstrap and helper bytes plus their digest (`guest.go:18–39`, `:53–62`), and main-pinned harness machine ID, ports, image/resource/network configuration, fixed `agent` uid and directory constants (`runtime.go:46–51`, `:585–597`). Guest account and directory metadata come from the fresh main-pinned image, before cloning repository bytes. No branch image declaration, toolchain recipe, environment, helper path or retained snapshot is accepted.
- The guest command launcher and cleanup consume main/bundle helper bytes and digest, main-pinned synthetic request IDs, `agent` identity, command argv, environment, cwd/root paths and stdin fixtures, and guest-kernel cgroup membership/events. The launcher drops privilege before reading or executing repository bytes. Relay/bridge bootstrap consumes only main-pinned port numbers and the fixed `host.microsandbox.internal` endpoint; frame bytes are handled after dropping privilege (`guest/smithers-guest.py:419–446`). No branch-sourced request or environment reaches a root step in this spike.
- Privileged cgroup probes consume only a reviewed main-pinned helper, image-shipped interpreter/tools, main-pinned fixed probe cgroup names, control filenames, literal freeze/kill values and disposable child argv, and guest-kernel cgroup descriptors/events. They operate only on a fresh probe cgroup outside the working copy. Filesystem syscall probes run as non-root. Provision any extra system tools in the reviewed main-pinned image; repository dependency lifecycle scripts stay non-root.
- C-SPK-03 `ExecutionPlacementAndRootInputs` checks this inventory and rejects overrides from a lane workspace, including helper/image/toolchain/plist inputs. Unknown provenance or an extra root input fails closed before use; smithers-3f reviews any inventory change. Root inputs are main-pinned or image/bundle-shipped bytes and kernel state, with no branch-sourced input. These tests do not waive either engineering README hard rule.

## Risks and notes

- First run (2026-10-02, QA): relay 4 KiB busy p95 197 ms (target 20 ms) and bridge 30 Hz keystroke p95 1,738 ms (target 1 s), on a contended M3 Max with no second device. That run doesn't decide anything: the spike re-runs on an idle reference host with browsers on a second device, and this ticket's decision rule turns that re-run into ADR 0003's topology.

## Ready checklist

1. Dependencies: W0 lists T-COL-01’s prototype; S1 lists T-COL-10’s ADR. Existing main-pinned msb/image/transports supply execution. Scope refuses missing prototype support and keeps the ADR decision provisional until its dependency lands; neither phase enables production co-editing.
2. Exclusions: contracts, production transport/mirror/documents, retention implementation, kernel workarounds, attribution and Views are explicitly assigned elsewhere.
3. Boundary tests: C-SPK-03/C-SPK-07 drive real transport and the LAN prototype listener; capture and kernel probes run on the guest working-copy filesystem. Literal independent fixtures fix expectations. A budget miss is recorded as a miss and selects the fallback, not a fabricated PASS. S1 requires the signed ADR section.
4. Decisions: smithers-8a accepts ADR 0003, retention changes and kernel-probe consequences; Will approves any product-budget or disk-authority change. smithers-3f approves the transport/security seam; smithers-38 signs any TS contract diff under §21.1.
5. Owner pre-review: recorded answers stand: smithers-38 and smithers-3f, answered 18:2x, ok; owners review amendments post hoc under the parallel-build directive. smithers-3f (Go/infra): Are second-device measurements uncontended with the 20 ms trigger distinct from the 100 ms transport budget? Do filesystem probes run non-root on the actual guest filesystem, with every root input main-pinned and security failures refusing measurement? smithers-38 (TS seam): Does the topology preserve topic-only addressing and daemon-only durable save acknowledgments without a TS contract change?
6. Security: smithers-3f owns the root-input inventory and M-29 placement; C-SPK-03 `ExecutionPlacementAndRootInputs` and C-SPK-07 assert machine identity, non-root repository execution, refusal without isolation and rejection of branch-produced root inputs. No sudo/plist load occurs; both README hard rules apply.
