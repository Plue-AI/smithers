# T-STK-02 Placement: append, before, amend, move, drop; stack order

Stage S1 · Size M · Depends on T-STK-01, T-STK-06 · Unblocks T-STK-09, T-STK-03, T-FLW-05, T-MCH-08 · Issue: to file
Spec: spec.md §3, §6.3, §10.2.2, §10.2.3, §10.3.2, §10.4.2, §10.5.1, §10.7.3, §15.1.5 · Delta: delta.md §6 (Add placement; items advance in stack order) · Product: mvp.md §4.2, §6.6, J4.2, J7.1, M-07, Appendix B.2

## Goal
A member places a TODO before Tn, amends Tn with no new TODO ("+1"), and moves an item up or down, and the engine works and merges items in exactly that order.

## Scope
In:
- `todos.stack_position` as a dense ordering key; `place: append | before Tn | amend Tn` on `POST /api/todos`.
- `PATCH /api/todos/{n}` (amend prompt and acceptance) and `POST /api/todos/{n} {move: up|down}`.
- The removal primitive Drop calls: take an item out of the order and mark later items for rebase (§10.2.3).
- Items advance in stack order instead of issue order.
- Catalog policy: `/todo.amend` and committed `/todo.new` are `confirm`; `/stack.move` is `run`. Draft placement is private form state until commit. Agents post a one-click confirmation for amend or commit, and move immediately (§5.2.1). Check: C-ACC-01.

Out:
- The Drop command itself: confirm, cancel, PR close, archive (T-STK-05).
- Steer delivery inside the run (T-STK-06); this ticket calls it for amendments.
- Admission by `parallel` and capacity (T-STK-03); presence-aware rebase scheduling (T-STK-11).
- Splitting or squashing across TODOs (mvp.md §4.2, cut).

## Changes
- `packages/backend/db/product/migrations/01xx_todo_position.sql` (new) → a unique index on `todos.stack_position` (created by T-STK-01) over unmerged, undropped TODOs.
- `packages/backend/internal/services/todo_place.go` (new) → `Place(append|before|amend)`, `Move(up|down)` (swap with the adjacent unmerged item, whatever its state) and `Remove(n)`. Each runs in one transaction with its `todo_events` row (`placed`, `moved`, `amended`) and `projection_events` for `home` and each changed `todo:<n>`.
- Amend → append `todo_revisions(rev+1, reason='amend', author_actor)`; no `todos` row and no number is allocated (§10.2.2). An amend of a queued TODO is revision 2, and the run reads every revision (§10.4.2). The new revision goes to the run as a steer through T-STK-06, under §10.7.3's rules: held while queued, delivered on resume, and `in_review → working`.
- Before Tn, Move and Remove → every later item whose predecessor set changed gets `branches.rebase_pending{onto}` (§10.5.1). In S1 the engine's integrate path (`mythical_items.go:1812`) performs it at the run's next durable boundary.
- `packages/backend/internal/services/mythical_items.go:1107-1116` → sort by the TODO's `stack_position`; delete the chat-first and issue-number ordering.
- `packages/backend/internal/services/mythical_git.go:533` `rebaseCandidate` → when an item's earlier items change, replant the item's own commits onto the new predecessor's last verified head (`replant`, `:461`) instead of refusing with `errMythicalRewrite`. Item N starts from item N−1's verified head (§10.3.2).
- `packages/backend/internal/services/mythical_view.go:454` → `DependsOn` reports the earlier unmerged items, not `[]`.
- `packages/backend/internal/routes/todos.go` → `PATCH` and `move`; OpenAPI rows in `docs/api/openapi/todos.yaml`; regenerate `ProductApi.ts` (`smthrs run //:openapiClients`).
- Catalog → `/todo.amend`, `/stack.move`. Update `packages/backend/docs/todos.md` and run the docs gates.

## Tests
- Unit, `todo_place_test.go` (new): position keys for append, before the first item, before the last item, and 1,000 inserts at one spot (keys stay unique and ordered).
- Unit, same file: Move up of the first item and Move down of the last item are refused; merged and dropped items are never targets; moving past a `working` item is allowed.
- Integration with real PostgreSQL and real git, `todo_place_db_test.go` (new): Before T2 on a stack of three gives order T1, new, T2, T3. Amend T2 adds revision 2 and no TODO number. Moving T3 above T2 replants T3's commits onto T1's verified head and marks T2 rebase-pending.
- Integration, same file: an amend of a `working` TODO reaches its run as one steer; an amend of an `in_review` TODO moves it to `working`.
- Integration, same file: two concurrent moves on the same pair serialize; one wins and the other gets `409 conflict`.
- Unit, `mythical_items_test.go` (existing): `advanceItems` launches in stack order with issue numbers deliberately reversed.

## Acceptance
- [C-J7-01](../checks/C-J7-01.md): Before T3 lands between T2 and T3; amend T2 shows "+1" with no new TODO.
- [C-J4-02](../checks/C-J4-02.md): the lead moves a ready item above a stuck one while chatting.

## Risks and notes
- Risk: replanting a candidate whose earlier item was removed conflicts more often than today's append-only rebase. Observation: the C-J7-01 run or the integration test logs a conflict on a move with disjoint files. Conflicts route to T-STK-08.
