# T-MCH-07 Sleep with final capture; reads never wake

Stage S2 · Size M · Depends on T-COL-03, T-MCH-04, T-COL-02 · Unblocks T-APP-10, T-APP-11, T-COL-08, T-INS-07, T-MCH-09, T-REL-01, T-REL-02, T-STK-08 · Issue: [#3568](https://github.com/smithersai/smithers/issues/3568)
Spec: spec.md §4.2, §8.4.3, §8.4.4, §9.1.2 (`capture()`), §19.1 · Delta: delta.md §3 (sleep reads and sleep/stop rows) · Product: mvp.md J4, §6.7 Sleep, §9 Honesty
Ready: 2026-10-03 smithers-8a sha256:3bd3ec17bda8

## Goal

A sleeping branch's files, diff, activity and head are readable by any member without waking its machine, and what they read equals the working copy at the moment it slept.

## Scope

In:
- Sleep = `capture()` (flush documents, close bursts, jj snapshot, push the head ref and snapshot commits, verify), then stop the VM and keep the disk (§8.4.3, §9.1.2). Document flush is a no-op until S3 (§7.6). A failed capture leaves the machine awake and records the failure. It never stops without a capture.
- One head ref per branch: `refs/smithers/branches/<id>/head` (§8.4.4) replaces `refs/smithers/workspaces/<id>/head`.
- Reads of an asleep branch serve from the host repository store at the captured commit: file list, file content, diff against the item's base, and head. Activity already lives in PostgreSQL.
- Only a work action wakes a branch: terminal, SSH, steer, answer, resume, a TODO run, or (from S3) an edit in a File card (§8.4.4). File reads, diff, `/files`, `/diff` and the Branch card never call the runtime.
- Machine state transitions `awake → releasing → asleep` and `asleep → waking → awake` in the T-MCH-04 runtime record, published on `branch:<id>` through T-COL-02. Use its accepted schema; do not add a second machine table. Publish asleep only after confirmed stop. Check: C-MCH-03.
- Lands dark until T-COL-03: refuse sleep with typed `infra` when authenticated capture, object verification or outbox drain is unavailable; keep the machine running and its credentials valid. No stop fallback. Lands dark until T-MCH-04: refuse branch sleep and snapshot reads without an authoritative branch-to-runtime binding. Lands dark until T-COL-02: refuse sleep without the state publication provider. Build against these contracts before they land. Check: C-MCH-03, TestBranchSleepUnavailableProviders.
- Lands dark until T-MCH-06: disable automatic release and work-triggered wake without admission; a work request fails closed without starting a machine. Snapshot reads remain available without admission. Lands dark until T-SEC-01 and the T-COL-03 broker security checks: refuse privileged machine entry without passing root-boundary validation. These are enablement gates, not code dependencies. Check: C-MCH-03, TestBranchSleepUnavailableProviders.

Out:
- Deciding when to sleep and which machine to release (T-MCH-06).
- The capture RPC and the daemon (T-COL-03). Deleting the bash head loop in `packages/backend/internal/services/workspace_head.go:52-171` belongs with it (delta.md §4).
- Asleep rebase on the host (T-STK-08).
- S3 document reconciliation (T-COL-08), admission implementation (T-MCH-06), cleanup policy (T-MCH-09), member identity and image provisioning (T-MCH-11), daemon planting and root broker implementation (T-COL-03), and File, Diff or Branch View changes. No new snapshot service or public command family.

## Changes

- `packages/backend/internal/repohost/refs.go:166` `WorkspaceHeadRef`: replaced by `BranchHeadRef(branchID)`. `WorkspaceIDFromHeadRef` (`:172`) and `ReservedRefViolation` (`:256`) are updated to the branch namespace. Delete the workspace form when no caller remains.
- `packages/backend/internal/services/workspace_lifecycle.go:985` `suspendWorkspace`: call the daemon's `capture()` and verify the pushed ref equals the reported head before `revokeWorkspaceHeadToken` (`:1000`) and the stop. On failure, return a typed `infra` error and keep the VM running.
- `packages/backend/internal/services/workspace_facets.go:445-470` `workspaceRuntimeFacetTarget`: remove wake-on-read at `:457-460` for every credential. Preserve authorized write admission separately; file and service writes also call this helper. Reshape `ListWorkspaceFiles` (`:90`) and `ReadWorkspaceFile` (`:187`) to route asleep reads to the host store and awake reads through the runtime.
- Reshape the existing file facets and repository diff path; reuse `repohost.Client.ListDirectory` (`packages/backend/internal/repohost/client.go:268`), `GetFileAtCommit` (`immutable_file.go:23`), `GetChangeFiles` (`client.go:1687`) and `GetRevisionDiff` (`client.go:1660`). Pin reads to one verified captured commit and pass the item base explicitly for diff. Keep authorization, path confinement, binary encoding and size limits. No new snapshot-read service.
- `packages/backend/internal/services/workspace_source.go:75` `deleteWorkspaceRefs`: deletes the branch ref only on cleanup (T-MCH-09), never on sleep.
- `packages/backend/internal/services/workspace_mutation_authority_test.go:242-452`: assertions move from "a reader doesn't start the VM" to "nobody's read starts the VM".

## Tests

C-MCH-03 (folded steps and assertions):
- Name the production-boundary cases `TestBranchSleepCapturedReadsNeverWake`, `TestBranchSleepCaptureFailureKeepsRunning`, `TestBranchSleepUnavailableProviders` and `TestBranchHeadRefRejectsMemberPush`. Use the production router and credential middleware, with real PostgreSQL and host store; do not call service methods in place of HTTP dispatch. Cover `branch.sleep`, `/api/branches/{b}/files`, `/diff`, `/activity`, branch/head GET and `/api/live` as specified in §6.3, plus `/files`, `/diff` and `box.terminal` through the production command dispatcher. While the existing workspace routes remain, cover the mounted `WorkspaceHandler` file and suspend routes (`internal/compose/router.go:1441-1448`) too.
- Define literal fixture bytes for retry.ts and backoff.ts, the file list and expected diff against an item base distinct from main. Assert those values against both the captured tree and HTTP responses. Expected policy, bytes and diff never come from the spec file, production code or returned captured tree at runtime. A returned head is compared with the verified stored ref, not used to generate expected content.
- Capture a branch with committed retry.ts and uncommitted backoff.ts; read with owner session, member session and delegated CLI credentials. All return the captured bytes without waking it.
1. Put the branch to sleep (capture, then stop). Record `workspaces.head_commit_id`, the ref `refs/smithers/branches/<id>/head`, and the runtime start counter.
2. With each credential: list files, read `src/retry.ts` and `src/backoff.ts`, get the diff, and get activity through the HTTP API (the same calls the File, Diff and Branch cards make).
3. Read the `branch:<id>` projection.
4. Positive control: Alice opens a terminal on the branch.

Pass when:
- Step 1: the ref equals `head_commit_id`, and the captured tree contains `src/backoff.ts`.
- Step 2: every call succeeds with the literal fixture content and diff, and the runtime start counter is unchanged (0 starts, 0 resumes) for owner, maintainer, member and delegated CLI credentials. A revoked or cross-branch credential is refused without a runtime call.
- Step 3: the machine state is `asleep` throughout step 2, with no `waking` delta.
- Step 4: a `person` admission request is created and the machine wakes, which proves the counter works.

Fail when:
- The owner's or a writer's read wakes the VM (the old `workspaceRuntimeFacetTarget` branch at `packages/backend/internal/services/workspace_facets.go:457-461`).
- A read returns 409 "workspace is stopped" instead of the captured content.
- `src/backoff.ts` is missing because the sleep stopped the VM without a final capture.
- The diff is computed against `main` instead of the item's base.


- integration (real PostgreSQL, real jj, fake runtime that counts starts): as owner, maintainer, member and a delegated CLI credential, read files, a file, diff and activity of an asleep branch. 0 runtime starts; content equals the captured commit. This is C-MCH-03.
- integration (reference host, real microVM): write a file, then sleep within 100 ms; the file is in the captured ref (no 2 s/30 s loss as in research/workspaces-machines.md risk 3).
- fault: extend existing lifecycle and production-route integration coverage for capture timeout, missing object, ref mismatch, undrained outbox and stop failure. Before successful verification, there is no stop or credential revocation and no asleep publication. Kill the VM during capture: show failure without claiming it remains awake, retain the last verified head and recover acknowledged writes on restart (C-DUR-04). No new standalone fault suite.
- unit: `refs.go` round-trips the branch ref, and the receive-pack reserved-ref rule refuses a member push to it.

## Acceptance

- [C-MCH-03](../checks/C-MCH-03.md): the named production-boundary tests above prove snapshot reads, unavailable-provider refusal, capture-before-stop ordering and reserved-ref protection.
- [C-DUR-04](../checks/C-DUR-04.md): capture kill points preserve acknowledged writes and the last verified head.

## Risks and notes

- The captured commit is a jj snapshot of the working copy, so it contains untracked, not-ignored files. A member's `.env` that isn't gitignored becomes readable to every member through the host store. Confirmed by creating `.env` in a terminal and reading it on the asleep branch. This is spec behavior (§8.4.4). Name it in the docs.
- `capture()` latency on a large working copy (jj snapshot of 100k files) delays release. Confirmed by timing sleep on `smithersai/smithers` with `node_modules` ignored. If it exceeds 10 s, admission waits longer than the 5 s warm-wake budget.

## Decisions and security preconditions

smithers-3f accepts the runtime-record schema, capture/stop ordering, reserved-ref authority, host read confinement and latency tradeoff. smithers-b8 signs off command/API compatibility and the snapshot visibility documentation. smithers-8a decides any departure from the cited contracts or a latency budget change. No ADR change is authorized here. Owners review post hoc under the parallel-build directive; recorded owner answers stand.

Repository code executes only inside machines as an unprivileged user (M-29, §1.3). Host snapshot reads use install-shipped repository-store code and never execute captured files, hooks or branch-selected tools. Capture runs as `machined`, never root (§9.5.1). smithers-3f reviews these boundaries. C-MCH-03 proves hostile captured hooks and executable files cannot execute during snapshot reads.

This ticket adds no root step. Its work-wake positive control consumes the existing privileged guest entry: helper, interpreter, broker and fixed executable paths are main-pinned install/image bytes; branch/runtime identity, UID/GID, credential, request ID, deadlines and stop target are host-controlled state; retained disk, ancestors, account files and symlinks can contain branch/member data. Command argv, env, cwd, file paths and payload bytes are branch/member data and are applied only after privilege drop. No branch-built code is installed or executed as root. Branch/member inputs block privileged entry until T-SEC-01's `TestGuestHelperInstallPinsInterpreterAndEnv`, `TestRootSetupNeverFollowsMemberSymlinks` and `TestRootPreflightParsesOnlyEnvelope` prove validation on fresh and retained machines, and T-COL-03's C-COL-04 broker confinement checks pass. smithers-3f accepts those receipts; this ticket does not implement a second broker.

## Ready checklist
1. Depends on T-COL-03 (capture/client), T-MCH-04 (branch runtime schema) and T-COL-02 (live publication); Scope names fail-closed dark behavior for each and for admission/root enablement gates.
2. Out explicitly excludes timers, cleanup, asleep rebase, S3 reconciliation, identity/images, daemon/root implementation, Views and a new snapshot service or command family.
3. C-MCH-03 names production router/dispatcher cases with literal bytes, file list and item-base diff; C-DUR-04 covers capture faults. No runtime spec or implementation-derived expectations.
4. smithers-3f decides backend seams and latency tradeoffs; smithers-b8 approves command/API and documentation compatibility; smithers-8a accepts contract or budget departures.
5. Owner pre-review, recorded answers stand and review is post hoc: smithers-3f answers: Does the accepted runtime schema avoid a second table? Does capture verification and outbox drain precede credential revocation and confirmed stop? Are host reads and retained-machine root inputs confined? smithers-b8 answers: Do existing commands and routes keep their authorization and response contracts? Does documentation explain snapshot visibility, including unignored files? No UI View or TypeScript library change is in scope.
6. M-29 confines repository execution to unprivileged machine users; the security section lists consumed root-entry inputs and sources, names validation tests and blocks branch/member inputs until they pass; smithers-3f reviews the receipts.
