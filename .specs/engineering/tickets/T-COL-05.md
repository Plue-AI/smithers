# T-COL-05 Moved off the item: detect; Return to Tn; Keep for now

Stage S2 · Size M · Depends on T-COL-04, T-STK-01, T-MCH-04, T-UI-15 · Unblocks T-APP-10, T-COL-08, T-REL-02 · Issue: [#3562](https://github.com/smithersai/smithers/issues/3562)
Spec: spec.md §3 (`branches.moved_off`), §4.1 (working → needs_you), §6.1.2 (`in-card`), §9.1.2 (`return_to_item`), §9.3.2–9.3.4, §9.3.8, §9.4.2, §10.8, §14.5.2 · Delta: delta.md §4 (moved-off detection) · Product: mvp.md §6.8 External changes, M-27, M-14

## Goal

A hand-run `git checkout main` or `jj edit` that takes an item branch's working copy off its item shows "Maya moved this branch off T2" as Needs you. The coding agent's write tool refuses while the branch is moved off. **Return to T2** puts the working copy back on its pre-move commit, and **Keep for now** holds the TODO in Needs you until the working copy is back on the item.

## Scope

In:
- Detection (§9.3.8). When a metadata watch fires (`.jj/repo/op_heads/heads/`, `.git/HEAD`, `.git/refs/`, `packed-refs`; §9.3.3) and after every overflow resync (§9.3.2), check two conditions: the item change is still present (by change id), and `@` descends from it (`jj log -r '<item_change>::@'` is non-empty). If either fails, emit `moved_off{by, item}` through the outbox, with `by` attributed like a burst (§9.3.1). The pre-move commit is `@` of the latest operation in `jj op log` whose `@` descends from the item change; it covers git moves and jj moves alike.
- Host: in one transaction, set `branches.moved_off` and open `needs_you{kind: moved_off}` through T-STK-01's wait API. Publish `branch:<id>` and `todo:<n>`. Toasts go to the TODO's owner and the members present on the branch (§10.8.3). The entry's action is Resolve → `/branch Tn` (§14.5.2).
- The agent stops writing: the daemon publishes the branch state at `/run/smithers/branch-state` (root, 0644), and the coding agent's write tool refuses with `moved_off` while it is set (§9.3.8). The TODO flow parks in the durable wait.
- Two in-card controls (§6.1.2 `in-card` catalog rows, registered through T-CAT-01):
  - **Return to Tn** answers the wait (first answer wins, §10.8.2). The daemon's `return_to_item()` (§9.1.2) runs `jj edit` back to the pre-move working-copy commit under the §9.4.2 sequence (lock, sessions frozen, bursts closed, capture, rewrite, documents reconciled, thaw), so no session writes during the move back. Anything written after the move stays in its own commit and is recoverable. The host clears `moved_off`, settles the wait and writes one activity entry attributed to the person who pressed it. The run continues.
  - **Keep for now** records the move. The TODO stays in Needs you, and the write refusal stays, until a later metadata event shows `@` back on the item. Then the host clears `moved_off` and settles the wait.
- Capture (T-COL-03) records the item change's last commit, never `@`, while `moved_off` is set. The stack keeps the item's last captured change throughout.

Out:
- Per-entry Undo of ordinary bursts (§9.3.5 [D]).
- Scratch branches, which have no item and so no detection.
- Conflict handling and rebase (T-STK-08, T-STK-08).

## Changes

- `crates/smithers-machined/src/moved_off.rs` (new): the detector, the `/run/smithers/branch-state` writer, and the `return_to_item()` control RPC.
- `packages/backend/internal/machined/moved_off.go` (new): ingest, the wait opening, and the Return and Keep handlers.
- `branches.moved_off jsonb` (§3): branch identity comes from the existing workspaces row; add the column in a new migration only if it is missing.
- `packages/smithers/agent/std/src/internal/FileMutation.ts`, `StdError.ts`: add the `moved_off` refusal next to T-COL-10's `stale_read`.
- The two `in-card` commands in the catalog source (T-CAT-01). The Branch card and TODO card buttons are T-APP-10 and T-APP-02.

## Tests

- Coverage gate (library, ledger #3480): every `@smthrs/std` src file this ticket edits gets a per-file 100/100/100/100 gate in `packages/smithers/agent/std/vitest.config.ts`, as `src/Container.ts` already has.
- unit (`moved_off.rs`): the descent predicate over a fixture jj repo for each of these:
  - `git checkout main`, `git switch -c x main`, `jj edit main` and `jj new main` → moved off;
  - `jj abandon <item>` → change missing;
  - `git commit` on the item, `jj new` on top, and a rebase that keeps the change id → not moved off.
- integration, real jj, inotify and cgroups (`crates/smithers-machined/tests/moved_off.rs`, new): a second uid runs `git checkout main` and gets one `moved_off` naming that member. Return to Tn puts `@` and the file bytes back on the pre-move commit, and a file written after the move stays in its own commit. Git `HEAD` follows (colocated repository).
- integration, real PostgreSQL (`packages/backend/internal/machined/moved_off_integration_test.go`, new): two Return presses race, and one wins while the other gets `409 {answered_by}`. Keep for now leaves Needs you open until a burst puts `@` back on the item. A redelivered event opens one wait. The agent's write gets `moved_off`.
- integration (`crates/smithers-machined/tests/moved_off.rs`): C-COL-05's metadata cases. `jj edit` to a change off the item with an identical tree raises `moved_off` within 1 s though no tracked file changed; `git checkout -b x` on the same commit raises nothing; a move made during a forced overflow is raised after the resync.
- e2e: C-J3-09.

## Acceptance

- [C-COL-05](../checks/C-COL-05.md): metadata watches and the overflow resync raise every move.
- [C-J3-09](../checks/C-J3-09.md): `git checkout main` over SSH shows Needs you with Return to Tn and Keep for now. Return restores the item, Keep holds Needs you until the working copy is back, and the agent writes nothing while moved off.
- [C-COL-03](../checks/C-COL-03.md): The mutation lock: rebase and Return to Tn with every writer active lose no write and let none land mid-rewrite; queued writes revalidate; a stale write never applies
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes

- In a colocated repository, `jj edit` must also move git `HEAD`. Confirmed broken if `git rev-parse HEAD` after Return differs from `@-`.
- An existing jj undo path, `POST …/workspaces/{id}/operations/{op_id}/undo` (`compose/router.go:550`, `services/change_operations.go:367`, `jj op revert` through `msb exec`), is a different behavior. T-CUT-02 decides whether it stays. This ticket must not route Return through it or add a third jj path.
