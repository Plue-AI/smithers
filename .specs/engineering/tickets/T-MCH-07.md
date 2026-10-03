# T-MCH-07 Sleep with final capture; reads never wake

Stage S2 · Size M · Depends on T-COL-03, T-MCH-04 · Unblocks T-INS-07, T-MCH-09, T-REL-01, T-REL-02, T-STK-08 · Issue: [#3568](https://github.com/smithersai/smithers/issues/3568)
Spec: spec.md §4.2, §8.4.3, §8.4.4, §9.1.2 (`capture()`), §19.1 · Delta: delta.md §3 (sleep reads and sleep/stop rows) · Product: mvp.md J4, §6.7 Sleep, §9 Honesty

## Goal

A sleeping branch's files, diff, activity and head are readable by any member without waking its machine, and what they read equals the working copy at the moment it slept.

## Scope

In:
- Sleep = `capture()` (flush documents, close bursts, jj snapshot, push the head ref and snapshot commits, verify), then stop the VM and keep the disk (§8.4.3, §9.1.2). Document flush is a no-op until S3 (§7.6). A failed capture leaves the machine awake and records the failure. It never stops without a capture.
- One head ref per branch: `refs/smithers/branches/<id>/head` (§8.4.4) replaces `refs/smithers/workspaces/<id>/head`.
- Reads of an asleep branch serve from the host repository store at the captured commit: file list, file content, diff against the item's base, and head. Activity already lives in PostgreSQL.
- Only a work action wakes a branch: terminal, SSH, steer, answer, resume, a TODO run, or (from S3) an edit in a File card (§8.4.4). File reads, diff, `/files`, `/diff` and the Branch card never call the runtime.
- Machine state transitions `awake → releasing → asleep` and `asleep → waking → awake` in `machines.state`, published on `branch:<id>`.

Out:
- Deciding when to sleep and which machine to release (T-MCH-06).
- The capture RPC and the daemon (T-COL-03). Deleting the bash head loop in `packages/backend/internal/services/workspace_head.go:52-171` belongs with it (delta.md §4).
- Asleep rebase on the host (T-STK-11).

## Changes

- `packages/backend/internal/repohost/refs.go:166` `WorkspaceHeadRef`: replaced by `BranchHeadRef(branchID)`. `WorkspaceIDFromHeadRef` (`:172`) and `ReservedRefViolation` (`:256`) are updated to the branch namespace. Delete the workspace form when no caller remains.
- `packages/backend/internal/services/workspace_lifecycle.go:985` `suspendWorkspace`: call the daemon's `capture()` and verify the pushed ref equals the reported head before `revokeWorkspaceHeadToken` (`:1000`) and the stop. On failure, return a typed `infra` error and keep the VM running.
- `packages/backend/internal/services/workspace_facets.go:445-470` `workspaceRuntimeFacetTarget`: delete the "writable callers wake the VM" branch (`:457-461`). An asleep branch routes reads to the host store; an awake branch reads through the runtime.
- `packages/backend/internal/services/branch_snapshot_reads.go` (new): list, read and diff at the captured commit with `repohost.Client.ListDirectory` (`packages/backend/internal/repohost/client.go:268`), `GetFileAtCommit` (`immutable_file.go:23`) and the existing change-file listing.
- `packages/backend/internal/services/workspace_source.go:75` `deleteWorkspaceRefs`: deletes the branch ref only on cleanup (T-MCH-09), never on sleep.
- `packages/backend/internal/services/workspace_mutation_authority_test.go:242-452`: assertions move from "a reader doesn't start the VM" to "nobody's read starts the VM".

## Tests

- integration (real PostgreSQL, real jj, fake runtime that counts starts): as owner, maintainer, member and a delegated CLI credential, read files, a file, diff and activity of an asleep branch. 0 runtime starts; content equals the captured commit. This is C-MCH-03.
- integration (reference host, real microVM): write a file, then sleep within 100 ms; the file is in the captured ref (no 2 s/30 s loss as in research/workspaces-machines.md risk 3).
- fault (`packages/backend/internal/services/branch_sleep_fault_test.go`, new): kill the VM during `capture()`. The branch shows the failure, the old ref is intact, and the next sleep captures. No acknowledged write is lost (C-DUR-04 shares the scenario).
- unit: `refs.go` round-trips the branch ref, and the receive-pack reserved-ref rule refuses a member push to it.

## Acceptance

- [C-MCH-03](../checks/C-MCH-03.md): reading a sleeping branch (files, diff, activity) never wakes it, and the content equals the captured head.

## Risks and notes

- The captured commit is a jj snapshot of the working copy, so it contains untracked, not-ignored files. A member's `.env` that isn't gitignored becomes readable to every member through the host store. Confirmed by creating `.env` in a terminal and reading it on the asleep branch. This is spec behavior (§8.4.4). Name it in the docs.
- `capture()` latency on a large working copy (jj snapshot of 100k files) delays release. Confirmed by timing sleep on `smithersai/smithers` with `node_modules` ignored. If it exceeds 10 s, admission waits longer than the 5 s warm-wake budget.
