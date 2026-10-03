# T-STK-08 Rebase now; rebase conflicts: agent once, then Needs you with Resolve (M-32)

Stage S1 · Size M · Depends on T-STK-07, T-UI-23, T-APP-19 · Unblocks T-REL-02, T-STK-11 · Issue: [#3532](https://github.com/smithersai/smithers/issues/3532)
Spec: spec.md §4.1, §8.5.0, §10.4.1, §10.5.1, §10.5.2, §10.5.3, §10.5.4, §10.8, §11.2, §14.5.2, §15.1.5 · Delta: delta.md §6 (Modify rebase: conflicts → agent once → Needs you with Resolve) · Product: mvp.md §4.2 Rebase, J7.4, J10.4, M-32, §11 stage 1 item 7a, Appendix A `/branch.rebase`

## Goal
Anyone on a branch can rebase it now, and the stack service performs the rebase exactly and records it as "Smithers, for Ben". When an item's rebase conflicts, the coding agent gets exactly one attempt to resolve it and shows what it did; if that fails, the TODO shows Needs you with the conflicted paths and a Resolve action, and nothing retries silently.

## Scope

- A clean rebase reruns checks only. Agent-resolved rebase conflicts are new work: implement → check → review (§10.4.1). Check: C-J7-03.

In:
- **Rebase now** (§8.5.0, §8.5.2a, M-32): a stage-1 system flow of the stack service, the only writer of branch history. Doors: `/branch.rebase` (Appendix A) and the in-card control `branch.rebase-now` (Appendix B.4). Both are `agent: run` (§15.1.5, Appendix B), so a person, the app agent or an external agent invokes it with the member's rights. `POST /api/branches/{b} {rebase}` (§6.3).
- On an item branch it runs the branch's `rebase_pending` rebase through the stack engine at once, instead of at the run's next durable boundary (§10.5.2).
- On a scratch branch (T-MCH-08) it rebases onto the current head of what the branch was forked from: `main`'s tip, or the item's last verified head (§8.5.2a).
- jj operations are the engine's exact ones, never free-form model output. Stage 1 runs them over today's workspaces.
- Attribution: one `activity` row (kind `rebase`) per rebase, with the system actor and its requester, rendered "Smithers, for Ben" (§8.5.0); on items, also a `todo_events` row.
- Replace today's conflict loop (retry with feedback up to 3 attempts, then `blocked`) with one agent resolution attempt, then `needs_you{kind: conflict, paths}`.
- The attempt runs inside the TODO's `todo` run (T-FLW-11), with the conflicted paths and the `onto` revision as its first message. It is not a separate launch.
- After a successful resolution: check, "Rebased onto T2" (or `main`) in activity, approvals cleared, checks rerun (§10.5.3).
- An engine-raised conflict creates its own durable wait on the TODO (§10.5.4), from `working` or `in_review` (§4.1).
- **Resolve** (§14.5.2): in S1 it opens the TODO card's conflict view (conflicted files, terminal and SSH line); from S2 it opens the Branch card. The wait settles when someone presses **Done** and the working copy has no conflict markers in those paths (§10.5.4).
- The policy value "one attempt by default" as `conflictAttempts` in the install-stored config (§11.2).

Out:
- Presence-aware scheduling ("Rebase pending" while people are present), the daemon's `rebase(onto)` and write hold, and rebases of asleep branches (T-STK-11, S2). The Branch card renders `branch.rebase-now` from S2 (T-APP-10).
- Fork and Add to stack (T-MCH-08). The conflict view's rendering (T-APP-02).
- Conflicts from bringing in an outside push (T-GH-06) and from moving off the item (T-COL-05).

## Changes
- `packages/backend/internal/services/branch_rebase_now.go` (new) → the Rebase now system flow over today's workspaces: authorize (§5.2: join branch), resolve the target (`rebase_pending.onto` for an item, the fork source's current head for a scratch branch from `branches.forked_from`), call the integrate path now, and write the activity row with requester. Catalog rows `/branch.rebase` and `branch.rebase-now`, both `agent: run`; OpenAPI row for `POST /api/branches/{b}`; regenerated `ProductApi.ts`. If it lands as a `Flow.make` tag, its Appendix C row (C.23 gap 3) lands in the same change (§6.1.2).
- `packages/backend/internal/services/mythical_items.go:1840-1847` (`integrate`, conflict case) → on `errMythicalConflict`, if the attempt's conflict budget is unspent, signal the TODO's run with `conflict{paths, onto}`; otherwise `RaiseNeedsYou(conflict, {paths, onto})` (T-STK-07). `mythicalRetry` is no longer called for conflicts, and `retrying` and `blocked` are never written for them.
- `packages/backend/internal/services/mythical_items.go:1723` (`prompt`) → a resolution message naming the paths and the `onto` revision, reusing the retry-feedback text.
- `packages/backend/internal/services/mythical_git.go:533` (`rebaseCandidate`) → return the conflicted paths and leave a conflicted jj change for the agent or a person instead of discarding it.
- `packages/backend/internal/services/todo_needs_you.go` (T-STK-07) → **Done** on a `conflict` wait checks that `jj resolve --list` on the item change is empty for those paths, then settles the wait and resumes check; otherwise `409 {code: still_conflicted}`, and the wait stays open.
- `flows/coding/project-config.ts` → `conflictAttempts` (default 1), stored in `flow_config` (T-FLW-02).
- `packages/rpc/src/StackView.ts` → delete the `conflict` label derived from `retrying` (`itemStateLabel`, `:56`); the product state is `needs_you`.
- `packages/backend/docs/todos.md` → Rebase now and conflict behavior; docs gates.

## Tests
- Integration with real PostgreSQL, real git and jj, and the fake GitHub server, `todo_conflict_db_test.go` (new): `main` moves with a change to the same lines as T2. Case A: the scripted agent attempt resolves; the item verifies and stays out of Needs you; one resolution attempt is recorded.
- Same file, case B: the scripted attempt fails; `needs_you{kind: conflict, paths: ["src/retry.ts"]}`; no second attempt within 10 engine passes; no `retrying` or `blocked` write.
- Same file, case C: **Done** while the paths are still conflicted → `409 {code: still_conflicted}`; after a clean resolution **Done** is accepted and check runs.
- Same file: an approval recorded before the rebase is deleted after it; a conflict raised while `in_review` returns there after a resolution that needs no new work.
- Integration, `branch_rebase_now_db_test.go` (new): Rebase now on an item with `rebase_pending` rebases it before the run's next boundary; the activity row's actor is the system with Ben as requester; an app-agent call runs at once with no confirmation; a repeated request with the same `Idempotency-Key` rebases once.
- Same file: a scratch branch forked from `main` rebases onto `main`'s new tip, and one forked from T2 onto T2's last verified head.
- Unit, `mythical_items_test.go` (existing): `conflictAttempts = 0` raises Needs you with no agent attempt.

## Acceptance


- [C-J7-03](../checks/C-J7-03.md): conflict on rebase; agent resolves once, else Needs you with Resolve.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Risk: today's host-side rebase writes the candidate in the stack repository, not in the lane's working copy, so the agent's attempt may start from a tree without the conflict. Observation: case B's lane shows no conflict markers. Then the attempt must check out the conflicted change first.
- Resolved: §8.5.2b. The Branch card shows the conflicted paths with Resolve, and the scratch branch stays on its pre-rebase head until Done.
