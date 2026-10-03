# T-MCH-14 Keep TODO workspaces until settled; wake before delivering a signal

Stage S1 · Size S · Depends on T-STK-01, T-INS-02, T-FLW-01 · Unblocks T-FLW-11, T-REL-02 · Issue: [#3526](https://github.com/smithersai/smithers/issues/3526)
Spec: spec.md §8.4, §10.4.1, §10.7.4, §8.12 · Delta: delta.md §6 · Product: mvp.md J10.2, M-31
Ready: 2026-10-02 smithers-8a sha256:f3572c6bf0fa

## Goal
A TODO's working copy and its waiting `todo` run survive days in review, so a GitHub review steer resumes the same run on the same files.

## Scope
In:
- Workspaces bound to an unmerged TODO are exempt from the 5-minute agent idle stop while their run waits on a durable signal, and from the 24 h stopped-disk reclaim.
- They may still be suspended with the disk kept.
- A reopened TODO (§10.7.4) whose workspace cleanup removed gets a new one from the branch's final capture when its first input needs the run.
- Before the stack engine delivers a signal (steer, review comment, rebase, resume) to a run whose workspace is suspended, it wakes the workspace and waits for the coding host.

Out:
- Admission, positions and people-first ordering (T-MCH-06, S2).
- Capture-before-sleep and reads that never wake (T-MCH-07, S2).
- Full cleanup policy after settle (T-MCH-09, S2), terminal/service safe-idle scheduling and daemon outbox drain (T-MCH-07, S2). S1 must refuse disk deletion without a retained final capture; it does not claim the S2 cleanup policy has landed.

- Out of scope: GitHub comment polling (T-GH-04), reopen state/attempt decisions (T-GH-05, T-STK-05), the one-run composition (T-FLW-11), new signal engine APIs, host execution on wake, and disk deletion based only on age.
- Before reclaiming a settled TODO disk in S1, require `head_commit_id` to equal the pinned candidate and verify its retained host ref using the existing head report. S1 suspension has no final push (`services/workspace_lifecycle.go:1000`); do not assume it captures new work. A mismatched, missing or unverifiable head keeps the disk. Reopened work uses the retained capture. Checks: C-STK-05, C-J10-08.

## Changes
- `packages/backend/internal/services/agent_dispatch.go:760` (`createAgentWorkspaceVM`) and `:209` (workspace suspension cleanup) → keep the TODO workspace/session binding while its run waits, and suspend without deleting its disk. `:1128` sets the legacy sandbox timeout; native workspace mode returns at `:1126` and never reaches it. Do not implement the native retention fix only at that timeout.
- `packages/backend/internal/services/workspace_disk_reclaim.go:20` (`defaultAgentWorkspaceDiskReclaimAfter = 24h`) → skip workspaces whose TODO is unmerged (join through `todos.branch_id` and the lane binding).
- Stack engine delivery in `services/mythical_items.go` persists the pending signal identity and queues delivery durably. Wake belongs behind the existing `flowhost/resolver.go:291-302` start path (`packages/backend/flowhost/resolver.go`), where the launcher uses `workspace_runtime.go:141` to start the workspace and verifies the guest host before delivery. Do not add a second pre-delivery wake in `mythical_items.go`. Re-read settlement and binding under the lifecycle lock. Retry the same identity after restart; a wake failure retries with backoff and surfaces as `failed{step: "wake"}` after 15 min. T-FLW-11 consumes this seam. Check: C-STK-05.

- Audit every lane deletion in `services/mythical_items.go`: `advanceItems → releaseLane → retireLane → DeleteWorkspace` (`:1124-1160`, `:1182`, `:1576`, `:2677`), `review()` (`:2391`), `sweepLanes` (`:1118/:1597`) and `start` (`:1646`). A lane bound to an unmerged TODO suspends and retains disk and binding; none of these paths may delete it. Reclaim checks settlement, lane binding and the pinned candidate inside `reclaimAgentWorkspaceDisk`’s runtime lock (`workspace_disk_reclaim.go:55` claim/sweep boundary), after re-reading current rows. C-STK-05 exercises each deletion path and races settlement, reclaim and resume.

## Decisions and pre-review
- Before start, smithers-3f approves TODO/workspace binding, lifecycle locking, retained-capture recovery and signal deduplication, and reviews machine-only execution on wake. smithers-38 pre-reviews any TypeScript signal-call contract; reuse the existing engine API. smithers-8a accepts the delivery seam, 15-minute wake failure policy and reference-host disk-use result. Will decides changes to retention or reopen policy.
- T-INS-02 and T-FLW-01 supply microVM startup and guest coding dispatch. A missing runtime or guest host keeps the signal pending or records the typed wake failure; no host process runs the repository. Provider keys remain on the host. C-SEC-02 checks that boundary. T-FLW-11 depends on this ticket, so tests here drive the production engine delivery seam with a fixture run, without depending on the future composition.

## Tests
- Integration (real microVM): a TODO in review suspends after idle. A steer delivered 25 h later (simulated clock) wakes it, the same run id resumes, and the working copy holds the files from before.
- Integration: drive the composed reclaim job with its injected clock; it skips an unmerged TODO, keeps a dropped disk without a final capture, and reclaims a dropped disk only with a retained final capture and no active terminal/service. Drive work input through the production delivery seam to verify provisioning from that capture. C-J10-08 later adds the real GitHub reopen and new-attempt path.
- Fault: kill the host while a wake for a signal is in progress. On restart the signal is delivered exactly once.

- Boundary integration in `packages/backend/internal/services/todo_long_wait_integration_test.go` (C-STK-05): run a fixture on the production guest dispatcher, advance the composed lifecycle/reclaim jobs, and deliver a durable input through the stack engine delivery seam, not by calling runtime wake or Signal directly. Assert fixed file contents, run identity and one consumed signal across a host restart. Once T-GH-04 and T-FLW-11 land, also run C-STK-05's GitHub review-comment poll and same-run loop. Use literal reviewed fixtures; no runtime spec reads or implementation-derived expectations. Joint reopen acceptance C-J10-08 remains pending until T-GH-05 and T-STK-05 land.

- C-STK-05 covers every lane retirement caller, a stale sweep list followed by resume, and a settlement race inside the lock. An unmerged TODO always keeps disk and binding. A settled TODO with a head different from its pinned candidate keeps the disk; only a matching retained head permits reclaim. Assert one resolver start and one consumed durable signal across restart.

## Acceptance



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-STK-05](../checks/C-STK-05.md)
- [C-J10-08](../checks/C-J10-08.md): the reclaimed-then-reopened step.

## Risks and notes
- Risk: many waiting TODOs keep suspended disks. Confirm disk use with 20 suspended TODO workspaces on the reference host. The 32 GiB disk per machine is sparse (APFS clone), and the layer budget (§8.2.1) bounds the rest.

## Ready checklist
1. Dependencies: T-STK-01 supplies TODO bindings; T-INS-02 and T-FLW-01 supply safe guest startup/dispatch. The delivery seam lands here; downstream flow, review and reopen owners integrate it later.
2. Exclusions: admission, full S2 sleep/cleanup, GitHub polling, reopen transitions, flow composition, new engine APIs and age-only deletion are explicit; missing final capture keeps the disk.
3. Tests: production guest dispatch, composed lifecycle jobs and stack delivery use fixed fixtures; fault recovery consumes one signal. GitHub/reopen joint checks remain pending until integrated.
4. Decisions: smithers-3f approves lifecycle/recovery seams, smithers-38 library contracts, smithers-8a delivery/failure policy and disk result; Will changes product retention/reopen policy.
5. Owner pre-review: smithers-3f: Answered at 2026-10-02 23:39 UTC; tech lead ADOPTS suspension at every lane deletion path, pinned-head reclaim and settlement checks inside the lock. smithers-38: Answered at 2026-10-02 23:39 UTC; tech lead ADOPTS wake behind the existing resolver start with no second pre-delivery wake.
6. Security: wake and restored-work provisioning require machine isolation and a guest coding host; no repository code or provider keys move to a host child. smithers-3f reviews this and C-SEC-02 proves it.
