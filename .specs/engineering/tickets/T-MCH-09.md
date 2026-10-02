# T-MCH-09 Cleanup only after settled, captured and quiet

Stage S2 · Size S · Depends on T-MCH-07 · Unblocks — · Issue: to file
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
- `packages/backend/db/product/queries/machine_cleanup.sql` (new): candidates joined to `todos.state` and `branches.archived_at`.

## Tests

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
