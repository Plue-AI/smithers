# T-STK-02 Placement: append, before, move, drop; stack order

Stage S1 · Size M · Depends on T-STK-01, T-STK-12, T-ACC-05 · Unblocks T-APP-02, T-CAT-02, T-FLW-05, T-FLW-08, T-GH-03, T-GH-05, T-MCH-08, T-REL-02, T-STK-03, T-STK-05, T-STK-08, T-STK-09, T-STK-15 · Issue: [#3528](https://github.com/smithersai/smithers/issues/3528)
Spec: spec.md §3, §6.3, §10.2.2, §10.2.3, §10.3.2, §10.4.2, §10.5.1, §10.7.3, §15.1.5 · Delta: delta.md §6 (Add placement; items advance in stack order) · Product: mvp.md §4.2, §6.6, J4.2, J7.1, M-07, Appendix B.2

## Goal
A member appends a TODO, places it before Tn, or moves an item up or down. The engine works and merges items in that order.

## Scope
In:
- `todos.stack_position` as a dense ordering key; `place: append | before Tn` on `POST /api/todos`.
- `POST /api/todos/{n} {move: up|down}`.
- The removal primitive Drop calls: take an item out of the order and mark later items for rebase (§10.2.3).
- Items advance in stack order instead of issue order.
- Catalog policy: committed `/todo.new` is `confirm`; `/stack.move` is `run`. Draft placement is private until commit. Agents post a one-click confirmation for commit and move immediately (§5.2.1). Check: C-ACC-01.

Out:
- The Drop command itself: confirm, cancel, PR close, archive (T-STK-05).
- Amend placement, prompt revisions, PATCH and `/todo.amend`, including steer delivery, belong to T-STK-15. Append and Before do not call T-STK-06.
- Admission by `parallel` and capacity (T-STK-03); presence-aware rebase scheduling (T-STK-11).
- Splitting or squashing across TODOs (mvp.md §4.2, cut).
- Merge dispatch and approval (T-STK-04), conflict resolution (T-STK-08), PR draft promotion (T-GH-03), CLI and skill doors (T-CAT-02), and UI Views and Containers (T-UI-03, T-UI-04, T-APP-02).

## Changes
- `packages/backend/db/product/migrations/01xx_todo_position.sql` (new) → a unique index on `todos.stack_position` (created by T-STK-01) over unmerged, undropped TODOs.
- `packages/backend/internal/services/todo_place.go` (new) → `Place(append|before)`, `Move(up|down)` and `Remove(n)`. Each runs in one transaction with its `todo_events` row (`placed`, `moved`) and projections for `home` and each changed `todo:<n>`. Use the existing stack claim and adopt T-STK-12's `LockStack`/fence seam; placements refuse `409 merging` while fenced (C-STK-07).
- T-STK-15 owns Amend and calls the same placement service and durable steer path; no alternate placement writer is added.
- Before Tn, Move and Remove → every later item whose predecessor set changed gets `branches.rebase_pending{onto}` (§10.5.1). In S1 the engine's integrate path (`mythical_items.go:1812`) performs it at the run's next durable boundary.
- `packages/backend/internal/services/mythical_items.go:1107-1116` → sort by the TODO's `stack_position`; delete the chat-first and issue-number ordering.
- `packages/backend/internal/services/mythical_git.go:533` `rebaseCandidate` → when an item's earlier items change, replant the item's own commits onto its new prefix (`replant`, `:461`) instead of refusing with `errMythicalRewrite`. Use T-STK-12's `SelectPrefix`: the nearest earlier unmerged item's usable last accepted head, else `main`'s tip (§10.3.2).
- `packages/backend/internal/services/mythical_view.go:454` → `DependsOn` reports the earlier unmerged items, not `[]`.
- `packages/backend/internal/routes/todos.go` (new) → `move`; OpenAPI rows in `docs/api/openapi/todos.yaml` (new); regenerate `packages/smithers/src/internal/backend/ProductApi.ts` (`smthrs run //:openapiClients`).
- Catalog → `/stack.move`. Update `packages/backend/docs/todos.md` (new) and run the docs gates.

## Tests
- Boundary integration, `packages/backend/internal/services/todo_place_db_test.go` (new): submit `POST /api/todos` and `POST /api/todos/{n} {move}` through the composed install router and production command dispatcher with real PostgreSQL and real repository history. Direct `Place`, `Move` or `Remove` calls are unit coverage, not acceptance. Use literal fixture orders, file bytes and refusal outcomes; no test reads spec Markdown or computes expected results from production code at runtime. Checks: C-J7-01, C-J4-02, C-STK-07.
- Same boundary suite: an eligible delegated commit creates a private confirmation and no TODO until its author's session approves; a delegated move runs without a confirmation; run and machine credentials cannot place or move. Before and Move touching a fenced item return `409 merging` without position, event or rebase writes. Invalidated successors cannot reuse earlier verification or approvals. Checks: C-ACC-01, C-STK-07.
- Unit, `todo_place_test.go` (new): position keys for append, before the first item, before the last item, and 1,000 inserts at one spot (keys stay unique and ordered).
- Unit, same file: Move up of the first item and Move down of the last item are refused; merged and dropped items are never targets; moving past a `working` item is allowed.
- Integration with real PostgreSQL and real repository history, `todo_place_db_test.go` (new): Before T2 gives T1, new, T2, T3 and rebases affected started successors. Moving T3 above T2 replants its commits onto T1's verified head and marks T2 rebase-pending.
- Integration, same file: Append and Before through the production dispatcher commit once under concurrent placement, without a steer producer (C-J2-01, C-STK-07).
- Integration, same file: two concurrent moves on the same pair serialize; one wins and the other gets `409 conflict`.
- Unit, `mythical_items_test.go` (existing): `advanceItems` launches in stack order with issue numbers deliberately reversed.

## Acceptance





- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-APP-02](../checks/C-APP-02.md): Amend is T-STK-15's check; it is not this ticket's landing gate.

- [C-J7-01](../checks/C-J7-01.md): Before T3 lands between T2 and T3. The Amend assertions complete with T-STK-15 and are not this ticket's landing gate.
- [C-J4-02](../checks/C-J4-02.md): the lead moves a ready item above a stuck one while chatting.

## Risks and notes
- Risk: replanting a candidate whose earlier item was removed conflicts more often than today's append-only rebase. Observation: the C-J7-01 run or the integration test logs a conflict on a move with disjoint files. Conflicts route to T-STK-08.

## Ready checklist
1. Dependencies: T-STK-01 supplies TODO/event/projection storage; T-STK-12 supplies `LockStack`, merge-fence guards, prefix selection and rebase fanout, with T-INS-02/T-FLW-01 isolation prerequisites; T-ACC-05 brings the catalog authorizer, delegated credentials and person confirmations. New edges were S1 and acyclic when drafted; a concurrent T-ACC-05 reverse edge now requires the cross_group orientation repair before this dependency edit or start.
2. Exclusions: Drop orchestration, Amend and steer delivery, capacity admission, presence scheduling, split/squash, merge, conflict resolution, PR promotion, CLI/skill doors and UI implementation are named in Out.
3. Tests: `todo_place_db_test.go` enters the production router/dispatcher for append, before, move, confirmation and fence refusals with fixed oracles. C-J7-01's placement portion and C-J4-02's move portion complete at their named browser boundaries; Amend stays with T-STK-15. No runtime spec or implementation-derived expectations.
4. Decisions: smithers-3f approves the ordering-key, stack-lock, prefix/replant and transaction seams; smithers-b8 approves public payload and refusal changes; smithers-38 approves catalog/library contracts and any public TypeScript API diff under §21.1. smithers-8a accepts cross-owner seam decisions; Will decides product changes.
5. Owner pre-review before start: smithers-3f: Does placement serialize through the existing stack claim and stack-then-TODO lock? Does reordering preserve each item's own change and atomically invalidate affected successors? smithers-b8: Do create/move doors preserve confirmation and idempotency behavior? smithers-38: Do descriptor/client changes use the existing APIs without a second policy table? Views are excluded.
6. Security: require T-INS-02/T-FLW-01 before any induced repository work; repository checks and working-copy commands run only in the branch machine (§1.3, M-29), without sudo or host provider keys. Host object operations use packaged code and invoke no repository hooks, filters or configuration-selected executables. smithers-3f reviews this boundary; C-SEC-02 and the production-boundary placement cases supply evidence.

