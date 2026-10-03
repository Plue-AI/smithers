# T-MCH-09 Cleanup only after settled, captured and quiet

Stage S2 · Size S · Depends on T-MCH-07 · Unblocks T-REL-02 · Issue: [#3569](https://github.com/smithersai/smithers/issues/3569)
Spec: spec.md §8.12, §4.2 (archived), §19.1 · Delta: delta.md §3 (cleanup row) · Product: mvp.md §6.7 Cleanup

## Goal

A machine's VM and disk are deleted only when its TODO is merged or dropped (or its scratch branch is archived), its final capture succeeded and matches the head ref, nothing is active on it, and 24 h have passed. History, activity and evidence stay.

## Scope

In:
- One cleanup job over branch machines with the four §8.12 conditions, evaluated in one transaction with the delete decision. The VM and disk are removed after the row is marked `archived`.
- Head-ref equality: the captured commit recorded on `machines.head_commit_id` equals `refs/smithers/branches/<id>/head`. Any write after the capture makes them differ, and the job refuses.
- "No terminal or service is active": open terminals, SSH sessions and services the team runs on the machine block deletion. This reads session and service state; it adds no `box.services` surface, which stays hidden (Machine view [D], delta.md §3).
- Retained after delete: PostgreSQL rows (`branches`, `machines` as `archived`, activity, burst files, attempts, evidence) and the branch head ref in the host repository store.
- Scratch branches: archiving is a member action. Deletion then follows the same four conditions.

Out:
- When machines sleep (T-MCH-06) and the capture itself (T-MCH-07).
- Deleting the head ref or history of a merged item: spec §8.12 keeps them.

## Changes

- `packages/backend/internal/services/machine_cleanup.go` (new): the job, run every 5 min from `packages/backend/internal/cleanup/workspace_cleaner.go`, with an injectable clock.
- `packages/backend/internal/services/workspace_disk_reclaim.go:19-95` (`defaultAgentWorkspaceDiskReclaimAfter`, `reclaimAgentWorkspaceDisk`) and `packages/backend/internal/db/workspace_disk_reclaim_ext.go`: the `kind=agent` 24 h reclaim has no rows after T-MCH-04, so delete it with its tests (`workspace_disk_reclaim_test.go`).
- `packages/backend/internal/services/workspace_abandon_reaper.go`: lease-lapse deletion never applies to branch machines. Keep it for any non-branch workspace that remains, or delete it if none remains.
- `packages/backend/internal/services/workspace_lifecycle.go:219` `destroyWorkspace`: refuses a branch machine unless called by the cleanup job with a passing decision. `deleteWorkspaceRefs` (`workspace_source.go:75`) keeps the branch head ref.
- `packages/backend/db/product/queries/machine_cleanup.sql` (new): candidates joined to `mythical_items.state` and `branches.archived_at`.

## Tests

C-MCH-05 (folded steps and assertions):
- Run cases a/i after 24 h: merged or archived scratch, captured and no sessions; remove VM/disk. Retain b failed capture, c post-capture write, d terminal, e SSH, f live service, g dropped at 23 h 59 m, and h in-review after 30 d idle. Preserve all captured objects and evidence.
1. Run the cleanup job once at the case's age.
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
- Case d, e or f is deleted while a session or service is live.
- Deletion removes the head ref, activity or evidence.
- The job uses `last_activity_at` instead of the settle time, so case h, which isn't settled, is deleted.


- C-MCH-05 has two required suites: policy decisions with a runtime fake, and real-microVM recovery after removal of a dropped TODO’s disk past 24 h. Reopen must reconstruct from retained host objects and reproduce every recorded byte.

- unit (`machine_cleanup_test.go`, new): a decision table over {TODO merged, dropped, in_review, working; scratch archived or not} × {capture ok, failed, ref ≠ capture} × {terminal open, SSH open, service running, none} × {23 h 59 m, 24 h}. Only the all-pass rows delete.
- integration (real PostgreSQL, real jj, fake runtime): a merged and captured machine is deleted after 24 h. Its activity rows, attempts and branch head ref still read back, and `git cat-file -e` of the captured commit succeeds. This is C-MCH-05.
- integration: write a file after the capture (ref ≠ capture). The job refuses, and the next sleep's capture makes it eligible.
- fault: kill the host between marking `archived` and removing the disk. The restart finishes the removal once and never re-deletes another machine.

## Acceptance

- [C-MCH-05](../checks/C-MCH-05.md): cleanup never deletes uncaptured work or a machine with an active session or service.

## Risks and notes

- A dropped TODO's branch is archived (spec §10.7.2) but can be reopened within 7 days when its PR reopens on GitHub (§4.1, `dropped → in_review`). Deleting its machine after 24 h means the reopened item boots from the captured head, not the disk. That is safe only if the capture is complete. Confirmed by C-MCH-05's reopen case.
- Services the team runs may never stop by themselves and pin a disk forever. Confirmed by a long-lived dev server on a merged branch.
- Spec gap: §8.12 gives no timeout for services on a settled branch (owner: tech lead).
