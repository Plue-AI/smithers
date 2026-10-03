# T-MCH-09 Cleanup only after settled, captured and quiet

Stage S2 · Size S · Depends on T-STK-01, T-MCH-04, T-MCH-07, T-TRM-07 · Unblocks T-REL-02 · Issue: [#3569](https://github.com/smithersai/smithers/issues/3569)
Spec: spec.md §8.12, §4.2 (archived), §19.1 · Delta: delta.md §3 (cleanup row) · Product: mvp.md §6.7 Cleanup
Ready: 2026-10-03 smithers-8a sha256:52667dceba3e

## Goal

A machine's VM and disk are deleted only when its TODO is merged or dropped (or its scratch branch is archived), its final capture succeeded and matches the head ref, nothing is active on it, and 24 h have passed. History, activity and evidence stay.

## Scope

In:
- Reshape the existing 5-minute workspace cleaner and disk reclaim path over branch machines. Evaluate the four §8.12 conditions in one transaction with the archive decision, under the workspace runtime lock shared with wake and session admission. Remove the VM and disk after the archive decision commits; retry unfinished removal after restart. Reopen or a new writer must invalidate an uncommitted decision. C-MCH-05 covers these races.
- Lands dark until T-STK-01: absent settlement state or timestamps retain the VM and disk. Lands dark until T-MCH-04: absent branch identity or scratch archive state retains them. Lands dark until T-MCH-07: absent or failed final capture, or an unverifiable head ref, retains them. Lands dark until T-TRM-07: unavailable or stale session/service inventory retains them. Build against those contracts; never fall back to the old `kind=agent` age-only deletion. C-MCH-05 tests each unavailable contract.
- Measure 24 h from the committed TODO merge/drop timestamp or scratch archive timestamp, never idle time or capture time. Use the T-STK-01 settlement projection and T-MCH-04 workspace identity, not parallel TODO, branch or machine tables (§3.0).
- Head-ref equality: the captured commit recorded on `workspaces.head_commit_id` equals `refs/smithers/branches/<id>/head`. Any write after the capture invalidates eligibility; verify under the capture/writer boundary, not just against a stale database row. C-MCH-05 races a post-capture write with cleanup.
- "No terminal or service is active": open terminals and SSH sessions block deletion. Read the T-TRM-07 session registry and service state. After 24 h on a settled branch, stop remaining services through the broker, confirm their processes ended, and obtain a new final capture before reconsidering deletion (§8.12). A failed stop or capture retains the disk. Add no `box.services` surface; the Machine view stays [D]. C-MCH-05 covers service shutdown and failure.
- Retained after delete: the workspace runtime row with archived branch state, TODO rows, activity, burst files, attempts, evidence and the branch head ref in the host repository store. Do not route branch cleanup through flow-journal deletion or orphan-journal reclamation. C-MCH-05 verifies retained rows and objects.
- Scratch branches: archiving is a member action. Deletion then follows the same four conditions.

Out:
- When machines sleep (T-MCH-06) and the capture itself (T-MCH-07).
- Deleting the head ref or history of a merged item: spec §8.12 keeps them.
- New cleanup scheduler, parallel `branches`/`machines` tables, admission or sleep policy, shorter retention, forced terminal/SSH closure, custom repository cleanup hooks, image/toolchain changes, root installation and plist loading.
- PR-reopen implementation belongs to T-GH-03; this ticket exercises that production path for recovery after disk removal.

## Changes

- Reshape `packages/backend/internal/services/workspace_disk_reclaim.go:20-98` (`defaultAgentWorkspaceDiskReclaimAfter`, `CleanupStoppedAgentWorkspaceDisks`, `reclaimAgentWorkspaceDisk`) and `packages/backend/internal/db/workspace_disk_reclaim_ext.go:11`: replace the age-only agent selector and guard with the settled/captured/quiet policy. Rewrite `workspace_disk_reclaim_test.go`; delete its age-only expectations, not the reusable reclaim implementation.
- Reuse `packages/backend/internal/cleanup/workspace_cleaner.go:35-77`, wired by `packages/backend/internal/compose/main.go:924`, with an injectable clock. Keep one scheduler and one reclaim path.
- `packages/backend/internal/services/workspace_abandon_reaper.go:105-159`: lease-lapse deletion never applies to branch machines. smithers-3f decides whether a non-branch consumer remains; retain the reaper only for that consumer, otherwise delete it and its wiring.
- `packages/backend/internal/services/workspace_lifecycle.go:219-254` `destroyWorkspace`: refuse branch destruction outside a passing cleanup decision. Preserve journals and retained branch rows instead of its ordinary soft-delete/journal-drop path. `deleteWorkspaceRefs` (`workspace_source.go:75-88`) never deletes the retained branch head, including after cleanup.
- Reuse `packages/backend/microsandbox/runtime.go:779-811` `ReclaimWorkspaceDisk` for stopped runtime removal and idempotence. Extend the existing workspace query surface for candidates joined to `mythical_items` and scratch archive metadata on the workspace contract; add no parallel schema or job.
## Tests

C-MCH-05 (folded steps and assertions):
- Run cases a/i after 24 h: merged or archived scratch, captured and no sessions; remove VM/disk. Retain b failed capture, c post-capture write, d terminal, e SSH, f service stop failure, g dropped at 23 h 59 m, and h in-review after 30 d idle. Also test a service that stops successfully after 24 h: capture its final writes before removal. Preserve all captured objects and evidence.
1. Drive one tick through the production `cleanup.NewWorkspaceCleaner(...).Start(ctx)` wiring with real `WorkspaceService` and an injectable clock; do not call the decision helper as acceptance evidence. Use checked-in literal fixtures and expected outcomes. No test reads spec files or derives expectations from production code at runtime.
2. For each case, record whether the VM and disk were removed and `workspaces.state`.
3. For case a: read activity, attempts and evidence for the TODO; `git cat-file -e <captured commit>` in the host store; read the branch head ref.
4. In the policy suite advance case g past 24 h and run cleanup before testing reopen. In the real-microVM suite create a dropped TODO with distinct tracked and untracked files plus a binary file, capture it, record each path’s bytes and digest, and settle it with no sessions. Advance the clock to 24 h plus 1 min, run the production cleanup job, and verify the original runtime and disk path are absent. Verify captured commit, tree, blobs, branch head, activity, attempts and evidence remain in the host store. At 7 days minus 1 h reopen through the normal PR-reopen path, admit a fresh real microVM reconstructed from the captured head, and compare every recorded path byte for byte. Never reuse the old disk or preseed the new working copy.
5. Kill the host process between marking case i `archived` and removing its disk. Restart and run the job.

Pass when:
- Step 2: only a and i are removed. b, c, d, e, f, g and h keep their VM and disk.
- Step 3: every row is present, the commit exists and the ref resolves.
- Step 4: cleanup removes g’s original disk after retention. Reopen creates a fresh real machine from retained objects, and all recorded tracked, untracked and binary bytes match the capture. A missing object or use of the original disk fails the check.
- Step 5: case i's disk is removed exactly once, and no other machine changes.

Fail when:
- Case b or c is deleted, which means uncommitted work was lost.
- Case d, e or f is deleted while a session or service is live, or successful service shutdown loses its final writes.
- Deletion removes the head ref, activity or evidence.
- The job uses `last_activity_at` instead of the settle time, so case h, which isn't settled, is deleted.


- C-MCH-05 has two required suites: policy decisions with a runtime fake, and real-microVM recovery after removal of a dropped TODO’s disk past 24 h. Reopen must reconstruct from retained host objects and reproduce every recorded byte.

- C-MCH-05 also drives missing dependency contracts and races cleanup against wake/session admission, post-capture writes and PR-reopen. Assert no removal for missing or stale safety facts and no deletion of a reopened or newly active branch. Run `TestCleanupRepositoryExecutionBoundary` and `TestCleanupRootInputsValidatedBeforeUse` from Security preconditions on the reference host with the real broker.

- unit (reshape `workspace_disk_reclaim_test.go`): a decision table over {TODO merged, dropped, in_review, working; scratch archived or not} × {capture ok, failed, ref ≠ capture} × {terminal open, SSH open, service running, none} × {23 h 59 m, 24 h}. Only the all-pass rows delete.
- integration (real PostgreSQL, real jj, fake runtime): a merged and captured machine is deleted after 24 h. Its activity rows, attempts and branch head ref still read back, and `git cat-file -e` of the captured commit succeeds. This is C-MCH-05.
- integration: write a file after the capture (ref ≠ capture). The job refuses, and the next sleep's capture makes it eligible.
- fault: kill the host between marking `archived` and removing the disk. The restart finishes the removal once and never re-deletes another machine.

## Acceptance

- [C-MCH-05](../checks/C-MCH-05.md): cleanup never deletes uncaptured work or a machine with an active session or service.

## Risks and notes

- A dropped TODO's branch is archived (spec §10.7.2) but can be reopened within 7 days when its PR reopens on GitHub (§4.1, `dropped → in_review`). Deleting its machine after 24 h means the reopened item boots from the captured head, not the disk. That is safe only if the capture is complete. Confirmed by C-MCH-05's reopen case.
- A service that fails to stop after 24 h pins its disk until shutdown and final capture succeed. C-MCH-05 covers a long-lived dev server, its final writes and a failed shutdown.
- §8.12 requires stopping services after 24 h. smithers-3f decides the existing broker shutdown seam and whether the non-branch reaper has a remaining consumer. smithers-8a accepts any change to the retention or capture policy; an unresolved policy change retains the disk.

## Security preconditions

- Owner: smithers-3f. Cleanup runs as the install service user, without sudo, and invokes no repository hooks or scripts. Repository execution during capture or reopen stays inside a machine as an unprivileged user (M-29). Host object inspection treats repository bytes as data and disables repository-selected hooks, filters and helpers. C-MCH-05 `TestCleanupRepositoryExecutionBoundary` drives cleanup and production PR-reopen with hostile hooks/config and a host canary; require zero host execution, positive guest execution and effective uid other than 0 for repository commands. Missing isolation fails closed.
- Root step: only the existing guest broker's service-cgroup kill. Inputs: broker executable and protocol implementation from main-pinned installed bundle bytes; operation tag and machine binding from the installed host service (main implementation, server-owned database identity); session ids, uid and cgroup handles from the broker's trusted registry (main implementation); cgroup population from the guest kernel. Consume no branch pathname, command, environment, config, script, executable or toolchain as root. Treat any branch-influenced selector as untrusted data: validate it against this machine's registry before use. C-MCH-05 `TestCleanupRootInputsValidatedBeforeUse` sends foreign-machine ids, traversal/option-shaped selectors and forged cgroup paths through the real cleanup-to-broker boundary; require refusal before signal, no other machine affected, and no branch bytes loaded or executed by root. Inventory any additional privileged input with smithers-3f before use; absence of validated provenance keeps cleanup dark.
- VM stop/remove reuses the bundled `msb` adapter as the install service user: fixed argv, server-owned machine identity, scrubbed environment and no repository-selected binary. C-MCH-05 records effective uid and executable provenance at cleanup and reopen. No branch-built root artifact is permitted even if validated; no plist generation or load belongs to this ticket.

## Ready checklist

1. Dependencies: T-STK-01 supplies the settlement projection/schema; T-MCH-04 supplies shared workspace identity/archive state; T-MCH-07 supplies capture/head verification; T-TRM-07 supplies broker session state and service shutdown. Scope names a fail-closed dark landing for each absent contract; T-GH-03 is a recovery acceptance prerequisite, not a production cleanup call dependency.
2. Exclusions: Scope excludes a second scheduler/schema, admission/sleep policy, forced terminal closure, history deletion, repository hooks, images/toolchains, root installation and PR-reopen implementation.
3. Boundary tests: C-MCH-05 runs the production WorkspaceCleaner tick, runtime removal and normal PR-reopen; literal outcomes are independent of spec files and production code. Add unavailable-contract, admission/write/reopen race, service-final-write and security cases to the same suites.
4. Decisions: smithers-3f owns the broker/runtime seam and remaining non-branch reaper consumers; smithers-8a accepts retention/capture policy changes. Unresolved safety facts retain the disk.
5. Owner pre-review: smithers-3f. Does the runtime/writer lock exclude wake, new sessions, post-capture writes and reopen through archive commit and removal? Does the existing reclaim path preserve refs, journals and evidence while safely stopping services? Does the root-input inventory cover every consumed input and do the two security cases prove isolation and selector validation? Record answers here; owner review is post hoc under Will's parallel-build directive.
6. Security: the Security preconditions inventory the root broker inputs and their main/bundle sources, forbid branch-built root artifacts and plist loads, and name smithers-3f plus C-MCH-05 executable lifecycle tests for M-29, effective uid, hostile repository config and root selector validation.
