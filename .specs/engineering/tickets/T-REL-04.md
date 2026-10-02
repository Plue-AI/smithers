# T-REL-04 Fault suite: kill points across runs, merges, writes, bursts, rebases

Stage S2, R · Size M · Depends on T-FLW-09, T-COL-04, T-STK-11 · Unblocks — · Issue: [#3459](https://github.com/smithersai/smithers/issues/3459)
Spec: spec.md §4.1, §10.4.1, §19.1, §19.2, §9.3.4, §9.4.1, §10.5, §10.6.2, §11.4, §12.4.1 (`outbound_writes`), §21 (Fault row) · Delta: delta.md §0 (fault suite carries over) · Product: mvp.md §9 Durability and Honesty, §6.1 Restart, §12.1 (restart mid-run, recovery receipts)

## Goal
Every named kill point across runs, merges, GitHub writes, bursts and rebases is exercised by one suite, and each leaves no re-run completed step, no duplicate external effect and no lost acknowledged write.

## Scope
In:
- One kill-point vocabulary for the host, reusing the five points of `packages/backend/internal/services/durable_crash_restart_test.go:30-50` (`pre-commit`, `post-commit`, `pre-launch`, `post-launch`, `stale-owner`) and its child-process harness (`SMITHERS_CRASH_POINT`, the `CRASH-POINT` marker).
- Kill points this ticket adds, beyond those its sibling checks own:
  - start (§4.1, §11.4.1): after `queued → starting` pins the flow digest and before the `todo` run's first step;
  - stop and resume (§4.1): after the durable pause signal and before the run parks in its `paused` wait, and after Resume settles the wait and before the next step;
  - merge (§10.6.2), a stack-engine system operation outside the `todo` run (§10.4.1): before the `todo_approvals` row, after it and before GitHub's merge call, after the call and before `merged`;
  - rebase (§9.4.1, §10.5): after capture and before the rebase, mid-rebase, after the rebase and before the "Rebased onto" activity entry, with people present and without;
  - PostgreSQL SIGKILL inside a TODO transition's transaction.
- The suite runner: runs every fault test, with C-DUR-01 to C-DUR-04's tests, as one nightly job on CI (host and daemon kills) and on the reference host (VM kills); writes a receipt per kill (point, subject, steps re-run, effects seen on the fake GitHub, writes acknowledged and found) into the matching check's evidence directory.
- A guard against vacuous passes: a test fails unless the child logged the kill point's marker before it died.

Out:
- The kill points C-DUR-01 to C-DUR-04 already own: host kill mid-run (`packages/smithers/test/faults/host/case40-host-kill-todo-run.test.ts`), machine kill (`packages/backend/flowhost/machine_kill_fault_test.go`), GitHub write and push kills (`packages/backend/internal/compose/github_outbound_kill_test.go`, `packages/smithers/test/faults/github-step-kill.test.ts`), daemon and VM kills during bursts and capture (`packages/backend/internal/machined/fault_test.go`). This ticket runs them; their tickets write them.
- Network partitions, disk-full and clock jumps. Kills inside GitHub itself (the fake GitHub server stands in).

## Changes
- `packages/backend/internal/services/todo_merge_fault_test.go` (new): merge kill points on the existing harness, real PostgreSQL 18, fake GitHub with `outbound_writes` lookups (§12.4.1).
- `packages/backend/internal/machined/rebase_fault_test.go` (new): rebase kill points through `smithers-machined` kill hooks (`SMITHERS_MACHINED_KILL_AT`, test builds only, as C-DUR-04 defines).
- `packages/backend/internal/services/postgres_kill_fault_test.go` (new): PostgreSQL SIGKILL during a transition; the TODO shows only states that have events (§3.2).
- `packages/backend/internal/services/todo_pause_fault_test.go` (new): start, stop and resume kill points on the same harness.
- `packages/smithers/test/faults/README.md` and `scripts/faults/run.mjs` (new): the nightly runner and receipt writer. Kill hooks exist only in test builds, so production binaries carry no fault code.

## Tests
- fault: start killed → after restart the TODO is `starting` or `working` as its last `todo_events` row says, and the run keeps the digest pinned at Starting.
- fault: stop or resume killed → after restart a stopped TODO is `paused` with the same run parked, never cancelled; Resume continues that run from its last finished step; Retry after a failure starts a new attempt and keeps the earlier attempt's row and evidence.
- fault: merge killed at each point → exactly one merge on the fake GitHub, one `merged` transition, one `todo_approvals` row bound to the reviewed head; a kill before the GitHub call leaves `in_review` with Merge enabled again.
- fault: rebase killed at each point → the working copy equals either the pre-rebase capture or the rebased head, never a mix; no acknowledged write lost; "Rebased onto" appears at most once; approvals cleared only if the head changed.
- fault: PostgreSQL killed mid-transition → after restart the TODO state equals its last `todo_events` row; no projection event without its row.
- fault: the runner reports a missing marker as a failure, not a pass.

## Acceptance
- [C-DUR-01](../checks/C-DUR-01.md): host killed mid-run re-runs no completed step; the run resumes.
- [C-DUR-02](../checks/C-DUR-02.md): machine killed mid-run resumes the run or shows it interrupted with Retry.
- [C-DUR-03](../checks/C-DUR-03.md): host killed during a GitHub write or push reconciles without duplication; merge kill points from this ticket included.
- [C-DUR-04](../checks/C-DUR-04.md): daemon or VM killed during a burst, capture or rebase loses no acknowledged write.

## Risks and notes
- fanotify needs a Linux guest, so daemon kill tests run on a Linux CI runner or in a microVM (§21 integration row). Observation: a macOS-only CI job skips them silently; the runner counts skips as failures.
- A shell step re-runs only when it declares itself idempotent (§19.2). A test must show a non-idempotent shell step becomes `interrupted` with Retry, not re-run.
- Stage split: start, stop, merge and PostgreSQL points land with T-FLW-09 at stage 2; rebase points follow T-STK-11 at stage 2; the reference-host VM run completes at stage R.
