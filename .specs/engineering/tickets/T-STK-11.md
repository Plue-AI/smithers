# T-STK-11 Presence-aware rebase: Rebase pending, Rebase now, write hold

Stage S2 · Size M · Depends on T-STK-08, T-COL-06, T-COL-03, T-COL-04, T-MCH-04, T-MCH-07 · Unblocks T-APP-10, T-REL-01, T-REL-02, T-REL-04 · Issue: [#3573](https://github.com/smithersai/smithers/issues/3573)
Spec: spec.md §7.3, §7.6, §8.4.4, §8.5.0, §9.1.2 (`rebase(onto)`, `write_file`), §9.3.4, §9.4.1, §10.5.1, §10.5.2, §10.5.3, §10.5.5, §18 (rebase hold) · Delta: delta.md §6 (Modify rebase: presence-aware scheduling and Rebase now, via `smithers-machined` §9.4) · Product: mvp.md §4.2 Rebase, J10.4, J7.4, M-32

## Goal
When `main` or an earlier item moves, a branch with only the coding agent rebases at the run's next durable boundary. A branch with people on it shows "Rebase pending" until they leave or someone there selects **Rebase now**, and the rebase never runs during a write made through Smithers.

## Scope

- A clean rebase reruns checks only. Agent-resolved rebase conflicts are new work: implement → check → review (§10.4.1). Check: C-J7-03.


- Publish `rebase {state: pending|rebasing|conflict, onto, paths?}` on `branch:<id>`, busy writer `{actor, terminal}` with requesting member, and each terminal’s `frozen` flag for the freeze. Check: C-COL-03.

- Rebase freeze UI (§9.4.2): everyone sees "Rebasing…" on the branch and each frozen terminal. Activity records "Rebased onto Tn" (or `main`). If the freeze cannot finish in 1 s, keep "Rebase pending", retry automatically and show the presser why, for example "Waiting for a write in Ben's terminal". Checks: C-COL-03, C-J10-04.

In:
- Scheduling of `branches.rebase_pending{onto}` from presence (§10.5.2): agent alone → next durable boundary; people present → "Rebase pending"; run when presence drops to the agent alone, or on **Rebase now**. Rebase now itself is T-STK-08's S1 system flow; this ticket routes it through the daemon on an awake branch.
- Execution on an awake branch through the daemon's `rebase(onto)` RPC (§9.1.2, §9.4.1): the §9.4.2 sequence: take the mutation lock, freeze every session cgroup (≤ 1 s, else `busy` and the rebase stays pending), drain and close bursts, capture, rebase, reconcile open documents, thaw; lock held < 2 s. Check: C-COL-03. In S2 those writes are `write_file` calls (§9.1.2: the File card and the agent's write tool); S3 adds live document writes (T-COL-08).
- After the rebase: activity "Rebased onto T2" (or `main`), approvals cleared, checks rerun (§10.5.3).
- Asleep branches rebase on the host against their captured head without waking (§10.5.5); a conflict there raises Needs you (T-STK-08) and wakes nothing.

Out:
- Reloading open live documents after a rebase as one attributed transaction (S3, T-COL-08).
- The Rebase now command and conflict handling (T-STK-08). The presence map (T-COL-06). Capture and the host connection (T-COL-03).
- Laptop pushes into the working copy (spec §0 [D]).

## Changes
- `packages/backend/internal/services/todo_rebase.go` (new) → `Decide(pending, presence) → {at_boundary | pending | now}`; subscribes to presence changes (T-COL-06) and runtime boundary events (§11.6.1); writes the `branch:<id>` and `home` deltas for "Rebase pending".
- `crates/smithers-machined` (T-COL-03) → implement the control RPC `rebase(onto)`: T-COL-03's §9.4.2 sequence around `jj rebase -d <onto>` on the item change (C-COL-03); report the new head and the conflicted paths.
- The coding agent's write tool waits on the hold instead of failing (the hold is ≤ 2 s).
- `packages/backend/internal/services/mythical_items.go:1812` (`integrate`) → for an awake branch, call the machine's `rebase` instead of the host-side `rebaseCandidate` (`services/mythical_git.go:533`). The host-side path stays only for asleep branches, reading `refs/smithers/branches/<id>/head` (T-MCH-07). One path per case, with no fallback between them.
- T-STK-08's Rebase now flow → on an awake branch, call the daemon's `rebase` like the scheduled path; same authorization and confirmation as in S1.
- One `activity` row of kind `rebase` with `onto`; `todo_approvals` for the TODO deleted in the same transaction.
- `packages/backend/docs/todos.md` → presence-aware rebase; docs gates.

## Tests
- Unit, `todo_rebase_test.go` (new): the decision table over presence {none, agent, agent + person, person + SSH} × pending {none, set}.
- Integration, `crates/smithers-machined/tests/rebase.rs` (new), in a microVM or Linux runner with real jj: a rebase requested during an open burst closes it first and captures it (§9.4.2, C-COL-03); a `write_file` issued during the hold lands after the rebase on the new base; the hold time is measured.
- Integration with real PostgreSQL and the T-COL-06 presence map, `todo_rebase_db_test.go` (new): `main` moves while Alice is present → "Rebase pending" and no rebase; Alice leaves → rebase within 2 s of presence expiry; **Rebase now** while Alice is present rebases at once through the daemon.
- Integration: an asleep branch rebases with zero `machine_requests` rows and zero wakes; a conflict there yields `needs_you{conflict}` and still no wake.
- Integration: after the rebase, the previous approval is gone and a check run is admitted for the new head.

## Acceptance
- [C-COL-03](../checks/C-COL-03.md): every writer freezes before capture; a freeze timeout leaves the rebase pending.

- [C-J10-04](../checks/C-J10-04.md): an unrelated merge on GitHub updates `main`; "Rebase pending" with people present; rebase without.
- [C-PERF-06](../checks/C-PERF-06.md): rebase with people present holds writes < 2 s (p95).

## Risks and notes
- Risk: `jj rebase` on a large working copy exceeds 2 s. Observation: C-PERF-06 p95 ≥ 2 s on the reference host. Escalate the failed budget before changing the §9.4.2 sequence; C-COL-03 must still pass.
- SSH and terminal writers are frozen for the rebase (§9.4.2). A process that blocks the freeze for 1 s leaves the rebase pending; C-COL-03 step 4 proves it.
