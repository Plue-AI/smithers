# T-FLW-09 Reconcile before retry for push, GitHub write and shell steps

Stage S2 · Size M · Depends on T-GH-09, T-GH-06, T-INS-02, T-FLW-01, T-FLW-03, T-FLW-04, T-FLW-11, T-FLW-07, T-MCH-04, T-MCH-06, T-SEC-01 · Unblocks T-REL-02, T-REL-04 · Issue: [#3564](https://github.com/smithersai/smithers/issues/3564)
Spec: spec.md §4.1 (`starting|working → failed` on `uncertain`, `failed → queued`), §6.2.3, §12.4.1, §19.1, §19.2, §19.3 · Delta: delta.md §8 (flows row; research gap 1–2) · Product: mvp.md §6.1 Restart, §9 Durability and Honesty
Ready: 2026-10-03 smithers-8a sha256:481f9f867492

## Goal
After the host, PostgreSQL or a machine dies mid-run, no completed step runs again, every interrupted external action is looked up before it repeats, and a step whose outcome can't be known shows the run as interrupted with Retry.

## Scope
In:
- Reuse the existing engine crossing gate, immutable-source checks, proposal recovery and RunTrace projection; reshape declarations and wiring only. No second engine, outbound queue, run store or pin archive.
- Build against the named dependency contracts and land dark. Until each unavailable dependency is qualified, refuse the affected recovery or Retry dispatch: T-GH-09 outbound reconciliation; T-GH-06 foreign-push wait; T-INS-02/T-FLW-01 isolated launch; T-FLW-03/T-FLW-04 activation and pin restore; T-FLW-11 TODO composition; T-FLW-07 interrupted projection and Retry; T-MCH-04/T-MCH-06 branch-machine recovery/admission; T-SEC-01 root validation. Keep durable intent and evidence, perform no repeat or host fallback, and test each missing provider through the production dispatcher (C-DUR-01..03, C-SEC-02).
- No new engine API (spec §19.2, §21.1). Every action in the `todo` flow with an outside effect declares `tier` and `idempotencyKey` explicitly. On an `intended` irreversible crossing with a key, the engine re-executes the body, and the body checks remote state first and returns what it finds.
- The rules of §19.2: a GitHub write is looked up by its key (T-GH-09's lookups); a model call is retried; a check command on an immutable source export declares `tier: "sealed"` and simply re-runs; any other keyless irreversible shell step fails with "interrupted, retry?"; a push compares the remote ref first.
- One product state `interrupted` for an unresolvable crossing, shown on the run and TODO cards with Retry. The TODO moves to `failed{class: interrupted, retryable: true}` (§4.1).
- Retry of an interrupted TODO is a new attempt from the first step of the pinned version, and the earlier attempt and its evidence stay (§4.1). Re-running finished steps is intended there, unlike recovery.

Out:
- The GitHub lookup functions, pending_op recovery and outbound keys (T-GH-09); do not implement a second reconciliation path.
- New engine APIs, generic shell compensation, terminal-process resurrection, image/toolchain changes, host execution of repository code, and visual components/CSS.
- Exactly-once labels, unlabels, comments and issue-close: these remain best-effort under §12.4.1, with the existing canonical-App comment marker.
- The monitor views (T-FLW-07); the kill-point suite across bursts and rebases (T-REL-04).
- Capture and burst durability inside the machine (T-COL-03).

## Changes
- No change to `packages/smithers/flows/flow/src/Action/make.ts` or `packages/smithers/flows/engine-store/src/internal/ActionPersistence.ts`: with a key, its `:2028-2040` gate already re-executes an `intended` crossing; without one, its `IrreversibleRetryRequiresIdempotencyKey` refusal is projected as `interrupted`.
- GitHub-write actions: reuse T-GH-09's five-kind pending_op reconciliation (§12.4.1b) before any repeat; pass its recorded operation identity through keyed action bodies. Do not infer a merge or close from a comment marker. Labels, unlabels, comments and issue-close retain §12.4.1's best-effort behavior; marker lookup requires canonical App identity.
- Shell steps: check commands run on an immutable source export (`flows/coding/checks.ts:71`), so they declare `tier: "sealed"` (or a key derived from the export digest). A lint test fails any shell action in the `todo` flow that doesn't state `tier` and `idempotencyKey` explicitly.
- Model calls → re-run (no outside effect); confirm their tier isn't `irreversible`.
- Push: `packages/backend/internal/services/mythical_items.go:2066-2074` (`pushProposal`) → on retry after a crash, `git ls-remote` the branch first. Equal to the intended head means done. Equal to the expected head means push with the existing `--force-with-lease`. Anything else is `needs_you{foreign_push}` (T-GH-06), never a push.
- Go jobs: `packages/backend/jobs/claims.go:437-450` (`uncertain`) → project as run state `interrupted`, and the TODO moves to `failed{class: interrupted, retryable: true}` from `starting` or `working` (§4.1).
- Reuse `apps/app/src/mainview/cards/RunTraceStatus.ts` as the state-folding precedent; wire the recorded interruption into T-FLW-07's model and authorized Retry action. TODO Retry dispatches `todo.retry` with its pinned version, not a generic rerun. smithers-06 owns the "Interrupted" rendering and control; engineering supplies actions through `cardActions` → `flowAction`. The toast settles on the durable terminal event (§19.3).

## Tests
- Acceptance boundary: extend C-DUR-01's `packages/smithers/test/faults/host/case40-host-kill-todo-run.test.ts` (new) and C-DUR-02's `packages/backend/flowhost/machine_kill_fault_test.go` (new). Start TODOs through the production authenticated command dispatcher and installed machine launcher with real PostgreSQL; kill host, PostgreSQL and machine at recorded crossings. Observe the served run/TODO topics and composed cards, then press Retry through the real `todo.retry` catalog action. Assert one new attempt on D1 after D2 activation, preserved evidence, no automatic keyless repeat, and no completed-step redispatch. Engine-only and direct-service tests are supplemental.
- Extend C-DUR-03's `packages/backend/internal/compose/github_outbound_kill_test.go` through production propose/merge/drop callers, real PostgreSQL, a bare remote and fake GitHub. Assert lookup before any repeat for all five kinds, no duplicate effective write, no foreign overwrite and current merge authority.
- Expected states, digests, labels and write counts are committed literals. No test reads spec files or computes its oracle from implementation code at runtime. New fault cases extend the existing harness; a second recovery harness is out of scope.
- `TestRecoveryRequiresMachineIsolation` and `TestRecoveryMissingProvidersFailClosed`: through production recovery dispatch, refuse unavailable contracts and process-runtime execution; a branch canary never runs on the host or as root. Positive controls use a machine. Check: C-SEC-02 and C-DUR-01..03.
- Unit, `packages/smithers/flows/engine-store/test/ActionPersistence.test.ts` (extend existing coverage): an irreversible keyed action killed after `intended` re-executes once; its body finds the remote result and returns it without a second write, and the journal outcome equals an uninterrupted run's; a keyless irreversible action refuses and projects `interrupted`; a `sealed` check re-runs.
- Unit (lint): every shell action in the `todo` flow states `tier` and `idempotencyKey`.
- Unit, `packages/backend/internal/services/mythical_items_test.go` (extend): a push retry with the remote at the intended head pushes nothing; at the expected head pushes once; at a third sha raises `foreign_push`.
- Fault, `packages/smithers/test/faults/engine/` (new case, beside `case01-kill-engine-mid-action.test.ts`): SIGKILL between `intended` and `succeeded` for a keyed GitHub-write action whose body looks itself up, a `sealed` check command, and a keyless irreversible shell action (refused, `interrupted`).
- Fault (host and machine, reference host): [C-DUR-01](../checks/C-DUR-01.md) and [C-DUR-02](../checks/C-DUR-02.md).

## Acceptance
- [C-DUR-01](../checks/C-DUR-01.md): killing the host mid-run re-runs no completed step and the run resumes.
- [C-DUR-02](../checks/C-DUR-02.md): killing a machine mid-run resumes the run or shows it interrupted with Retry.
- [C-DUR-03](../checks/C-DUR-03.md) (with T-GH-09): a host kill during a GitHub write or push reconciles without duplication.

## Risks and notes
- Risk: the coding agent's own tool calls inside one implement turn aren't engine actions. A kill mid-turn re-runs the turn's model call and may repeat a file write. Confirmed by a duplicate write in the burst log after a kill. Acceptable because writes land in the jj working copy and are recoverable (§9.3.4); state it in the evidence.
- Risk: until T-GH-09 lands, the Go path repeats keyed commands blindly; research found no test that a GitHub write interrupted mid-call is reconciled (`research/flows-engine.md`).

## Security preconditions
Repository flows, checks and coding-agent tools execute only as an unprivileged user in a machine (M-29, §1.3); recovery and Retry preserve this boundary. No sudo, repository-code host fallback or branch-built root payload. Host publication uses §12.5.1a controlled git configuration, disabling repository hooks, external diff, textconv, merge drivers and credential helpers. smithers-3f reviews this boundary and C-SEC-02 receipts.

Recovery reuses T-SEC-01's guest startup/setup/exec steps; it adds no root action. Their consumed inputs and sources follow. Main/install-controlled executable code remains trusted; every branch/member-derived data input blocks dispatch until the named validation test passes. R1 requires TestGuestHelperInstallPinsInterpreterAndEnv; R2 requires TestRootSetupNeverFollowsMemberSymlinks; R3 requires TestRootPreflightParsesOnlyEnvelope (C-SEC-02). Digest equality never permits branch-built code to run as root.

### R1

Inputs:

- Helper bytes and expected digest, fixed `/opt/smithers/guest` destination and install script — **main**, embedded into the **install-controlled** backend.
- `msb` executable/path, host child environment/PATH/HOME, machine identifier, deadlines — **install-controlled** runtime configuration/state; executable provenance must remain bundle-controlled.
- Guest image or layer/snapshot, `/bin/sh`, `python3`, `sha256sum`, `cut`, `mkdir`, `cat`, `mv`, executable search paths, Python startup/import paths and existing helper/temporary-file/parent entries — **install-controlled** base; snapshots/cache/environment can contain **branch-derived** and **member-controlled** entries. Digest comparison alone does not validate parent ownership, symlinks, interpreter provenance or startup imports.
- OCI image pull/metadata/blob responses — **install-controlled** pinned image selection, upstream registry responses; retained snapshot data — **install-controlled** state with **branch/member-derived** contents where applicable.

### R2

Inputs:

- Setup argv (login, UID, directories), fixed HOME_LINKS/GO_SETTINGS, helper source — **main** constants today; future member login/UID bindings — **install-controlled** DB allocations derived from **GitHub/member** identities, not arbitrary user argv.
- `/etc/passwd`/group account entries, `useradd`, shell, existing home path and account UID/GID — **install-controlled** image/account state.
- `/opt/smithers/env.json`: all keys/values, including PATH, PYTHONPATH, Go settings, tool-cache targets — generated from **main** code and **branch-derived** toolchain selection; file ownership and immutability are separate inputs.
- `/var/cache/smithers/home` names/entries, cache directories, existing `.cache`, `.config`, `.config/go`, `.config/go/env`, all ancestor/leaf symlinks and directory metadata — **branch-derived** dependency output and **member-controlled** retained home state.
- Kernel/filesystem responses to mkdir/stat/open/chown/chmod and symlink operations — **install-controlled** guest OS; which object they address can be **member-controlled**.

### R3

Inputs:

- JSON request id, argv, env, cwd, root, user and stdin mode; operation/path/content/mode/read limit for fs — **main/install-controlled** envelope and fixed identity fields, with **branch/member-controlled** argv, environment values, relative paths, file bytes and existing symlink graph. Capture metadata and command results are **branch/member-controlled** outputs.
- `/opt/smithers/env.json`, helper/interpreter startup environment, passwd/group records and guest directory state — sources as R1/R2.
- Terminal request ID, `/run/smithers/requests` directory/ancestors, request `.json` bytes, ownership/mode, stdin/file descriptors, terminal size and signal inputs — **main/install-controlled** IDs and transport settings; request payload and retained filesystem entries can be **branch/member-controlled**. Protected no-follow request creation/read/removal and bounded parsing are proved by TestRootPreflightParsesOnlyEnvelope.
- Host-generated exec IDs; kill/kill-all names, child directories, cgroup.procs/kill/events and their observed state — **main/install-controlled** IDs and kernel cgroup state; a guest command influences process population. Any selectable path/name must be validated against the fixed subtree.
- Relay/probe port, fixed host.microsandbox.internal bridge destination, ws relay-port metadata — **main/install-controlled**; bytes flowing over relay/TCP and associated peer responses — **member/branch-controlled** or authenticated host data, depending on channel.
- Fork/wait/signal/exit observations, filesystem resolution and network responses — **install-controlled** kernel responses influenced by member processes/network traffic.

## Ready checklist
1. Dependencies: Depends on includes outbound reconciliation and foreign-push waits, isolated launch, activation/pinning/TODO composition, interrupted projection, branch-machine admission and root validation. Scope lists fail-closed dark landing for each unavailable contract; all edges are S1 or S2.
2. Exclusions: Out names engine APIs, duplicate reconciliation/stores, generic compensation, terminal resurrection, image changes, host repository execution, visual code and exactly-once best-effort GitHub writes.
3. Boundary tests: C-DUR-01..03 drive production command/recovery composition and machine launch; Retry uses todo.retry and served cards/topics. Literal oracles never read the spec or derive expectations from implementation code.
4. Decisions: smithers-38 accepts action tiers, keys and durable decoding; smithers-3f accepts recovery, lease/conflict and root validation; smithers-b8 signs off Retry command/API and Container wiring; smithers-06 accepts the View seam. Will through smithers-8a decides any change to product recovery guarantees or the accepted repeated-file-write risk. No new public library API is authorized (§21.1).
5. Owner pre-review questions (recorded answers stand; owners review post hoc under Will's parallel-build directive): smithers-38: Do existing tier/key gates cover recovery without a new API? Do old journals still decode? smithers-3f: Does every repeat reconcile and preserve the lease and current authority? Are all root inputs validated before privileged use on fresh and retained machines? Does missing isolation fail closed? smithers-b8: Does TODO Retry use the authorized pinned-version command? Do interruption and toast settlement follow committed events? smithers-06: Can the existing View render Interrupted and Retry from supplied actions without engineering visual edits?
6. Security: M-29 confines repository execution to unprivileged machines; Security preconditions inventories every reused R1–R3 root input and source, names its validation test and blocks branch-derived inputs until validation passes. smithers-3f reviews; TestRecoveryRequiresMachineIsolation and C-SEC-02 prove refusal with positive controls.

