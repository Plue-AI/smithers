# T-STK-02 Placement: append, before, move, drop; stack order

Stage S1 · Size M · Depends on T-STK-01, T-STK-12, T-ACC-03, T-CAT-01, T-APP-04, T-INS-02, T-FLW-01, T-SEC-01 · Unblocks T-APP-01, T-APP-02, T-FLW-05, T-FLW-08, T-GH-03, T-MCH-08, T-MNT-04, T-REL-02, T-STK-03, T-STK-05, T-STK-06, T-STK-08, T-STK-09 · Issue: [#3528](https://github.com/smithersai/smithers/issues/3528)
Spec: spec.md §3, §6.3, §10.2.2, §10.2.3, §10.3.2, §10.4.2, §10.5.1, §10.7.3, §15.1.5 · Delta: delta.md §6 (Reshape placement through existing lane admission; reuse item events) · Product: mvp.md §4.2, §6.6, J4.2, J7.1, M-07, Appendix B.2

## Goal
A member appends a TODO, places it before Tn, or moves an item up or down. The engine works and merges items in that order.

## Scope
In:
- `mythical_items.stack_position` as a dense ordering key; `place: append | before Tn` on `POST /api/todos`.
- `POST /api/todos/{n} {move: up|down}`.
- The removal primitive Drop calls: take an item out of the order and mark later items for rebase (§10.2.3).
- Items advance in stack order instead of issue order.
- Catalog policy: committed `/todo.new` is `confirm`; `/stack.move` is `run`. Draft placement is private until commit. Eligible delegated actors request a private confirmation for commit and move immediately (§5.2.1); the restricted `terminal_s1` profile permits delegated append confirmation only and refuses Before and Move (§5.3.2a). Check: C-ACC-01.
- Land dark against every unlanded dependency contract: T-STK-01 storage, T-STK-12 lock/fence/prefix providers, T-ACC-03 authorization, T-CAT-01 descriptors, T-APP-04 confirmations, T-INS-02 launcher, T-FLW-01 machine execution and T-SEC-01 root validation. Disable affected create/move dispatch and worker advancement before any mutation or repository work when a required provider is unavailable; never fall back to the issue-order worker or host execution. Missing S1 delegated append confirmation returns `403 permission/confirm_in_app`, with no effects; other missing confirmation consumers return `503 infra/confirmation_unavailable`. Enable each path only after its production-boundary cases pass. Checks: C-ACC-01, C-SEC-02, `todo_place_db_test.go`.

Out:
- The Drop command itself: confirm, cancel, PR close, archive (T-STK-05).
- Amend placement, prompt revisions, PATCH and `/todo.amend`, including steer delivery, belong to T-STK-06. Append and Before do not call T-STK-06.
- Admission by `parallel` and capacity (T-STK-03); presence-aware rebase scheduling (T-STK-08).
- Splitting or squashing across TODOs (mvp.md §4.2, cut).
- New TODO, event, projection or approval stores; a second stack worker or policy table; root provisioning, helper installation and toolchain/layer changes.
- Merge dispatch and approval (T-STK-04), conflict resolution (T-STK-08), PR draft promotion (T-GH-03), CLI and skill doors (T-CAT-01), and UI Views and Containers (T-UI-03, T-UI-04, T-APP-02).

## Changes
- Reshape `packages/backend/internal/services/mythical_file_todo.go:45` (`FileTodo`) and existing admission in `mythical_items.go:443`: add `Place(append|before)`, `Move(up|down)` and `Remove(n)` on the existing service. Delete mandatory GitHub issue creation for chat TODOs; retain issue admission's trust gate. No parallel placement service or writer. Each mutation commits its `product_job_events` facts and source projection cursor in one transaction; publish `home` and changed `todo:<n>` projections after commit. Use the existing stack claim and T-STK-12's `LockStack`/fence seam; placements refuse `409 merging` while fenced. Check: `todo_place_db_test.go` (C-STK-07's placement races, folded into T-STK-04's tests).
- `packages/backend/internal/services/mythical_items.go:1107-1116` → sort by the TODO's `stack_position`; delete the chat-first and issue-number ordering. Before Tn, Move and Remove atomically mark affected successors rebase-pending and invalidate obsolete verification/approvals. Extend the existing integrate path (`:1812`) at the run's next durable boundary; reuse candidate fields and verification lanes, not a second candidate protocol (§10.4.4). Checks: C-J7-01, C-STK-06, `todo_place_db_test.go`.
- `packages/backend/internal/services/mythical_git.go:533` `rebaseCandidate` → replant only the item's own commits onto its new prefix using existing `replant` (`:461`), rather than refusing inserted or moved candidates with `errMythicalRewrite`. Use T-STK-12's `SelectPrefix`: the nearest earlier unmerged item's usable last verified head, else `main`'s tip (§10.3.2). Collapse the existing commit-ancestor implementations to one when changing ancestry (§10.4.4). Check: C-STK-06.
- `packages/backend/internal/services/mythical_view.go:454` → `DependsOn` reports earlier unmerged items, not `[]`.
- Reshape `packages/backend/internal/routes/mythical.go:293` and `packages/backend/internal/compose/router.go:1134` into the install create/move doors of §6.3, through the production command dispatcher. Update existing `docs/api/openapi/repositories.yaml:12212` rows and regenerate `packages/smithers/src/internal/backend/ProductApi.ts` (`smthrs run //:openapiClients`). Do not add parallel `routes/mythical_items.go` or `openapi/mythical_items.yaml` files. Check: C-ACC-01.
- Extend the existing catalog descriptors with `/stack.move`; reuse T-CAT-01's policy and dispatch APIs. T-STK-06 calls the same placement primitives for Amend; this ticket adds no steer producer.
- `packages/backend/db/product/migrations/01xx_todo_position.sql` (new) → unique `(repository_id, stack_position)` over unmerged, undropped TODOs, using T-STK-01's column. Existing schema lacks this ordering constraint; do not add tables or duplicate T-STK-01's migration. Assign the unlanded migration number at landing and preserve landed history (C-PRC-02).
- `packages/backend/docs/mythical_items.md` (planned by T-STK-12; absent today) → extend the shared item page with placement/order behavior and run the docs gates; create it only if the provider has not yet supplied it. Existing item code is reused; the missing documentation is the only new page.

## Tests
- Boundary integration, `packages/backend/internal/services/todo_place_db_test.go` (new): submit `POST /api/todos` and `POST /api/todos/{n} {move}` through the composed install router and production command dispatcher with real PostgreSQL and real repository history. Direct `Place`, `Move` or `Remove` calls are unit coverage, not acceptance. Use literal fixture orders, file bytes and refusal outcomes; no test reads spec Markdown or computes expected results from production code at runtime. Checks: C-J7-01, C-J4-02, C-STK-07.
- Same boundary suite: an eligible delegated commit creates a private confirmation and no TODO until its author's session approves; a delegated move runs without a confirmation; run and machine credentials cannot place or move. Before and Move touching a fenced item return `409 merging` without position, event or rebase writes. Invalidated successors cannot reuse earlier verification or approvals. Checks: C-ACC-01, C-STK-07.
- Unit, `todo_place_test.go` (new): position keys for append, before the first item, before the last item, and 1,000 inserts at one spot (keys stay unique and ordered).
- Unit, same file: Move up of the first item and Move down of the last item are refused; merged and dropped items are never targets; moving past a `working` item is allowed.
- Integration with real PostgreSQL and real repository history, `todo_place_db_test.go` (new): Before T2 gives T1, new, T2, T3 and rebases affected started successors. Moving T3 above T2 replants its commits onto T1's verified head and marks T2 rebase-pending.
- Integration, same file: Append and Before through the production dispatcher commit once under concurrent placement, without a steer producer (C-J2-01, C-STK-07).
- Integration, same file: two concurrent moves on the same pair serialize; one wins and the other gets `409 conflict`.
- Unit, `mythical_items_test.go` (existing): `advanceItems` launches in stack order with issue numbers deliberately reversed.
- Boundary integration, `todo_place_db_test.go`: withhold each Scope provider in turn at the production router/dispatcher and worker boundary; assert refusal or disabled advancement, no position/event/projection/rebase writes and no host command or machine admission. Assert the exact missing-confirmation envelopes above. Restricted `terminal_s1` delegated append requests confirmation; Before and Move return `403 permission/permission` with no effects. Include valid provider/profile controls. Checks: C-ACC-01, C-SEC-02. Extend existing `mythical_file_todo_test.go` and `mythical_items_test.go` fixtures; the new database suite supplies real router, transaction and concurrency coverage absent from the existing unit suites.

## Acceptance

- `todo_place_db_test.go`: production placement, concurrency, fence, invalidation, missing-provider and credential-profile cases above pass with real migrated PostgreSQL and literal fixtures. C-STK-07 is folded into T-STK-04; its full merge races remain that ticket's gate.
- [C-ACC-01](../checks/C-ACC-01.md): placement authorization and missing-confirmation refusals. Persisted confirmation cases complete when T-APP-04 is integrated; unavailable cases are not reported as passes.
- [C-SEC-02](../checks/C-SEC-02.md): induced repository execution stays machine-only; executing providers supply root-validation receipts before activation.
- [C-STK-06](../checks/C-STK-06.md): placement prefix and invalidation portions; full run integration remains with its owners.
- [C-J1-04](../checks/C-J1-04.md): placement portion at its named journey layer after integration; dark landing does not claim the full journey passed.


- [C-APP-02](../checks/C-APP-02.md): Amend is T-STK-06's check; it is not this ticket's landing gate.

- [C-J7-01](../checks/C-J7-01.md): Before T3 lands between T2 and T3. The Amend assertions complete with T-STK-06 and are not this ticket's landing gate.
- [C-J4-02](../checks/C-J4-02.md): the lead moves a ready item above a stuck one while chatting.

## Risks and notes
- Activation follows the Scope provider guards. Build against spec contracts and land dark while dependencies are pending; pending dependencies or owner replies do not block Ready. Recorded owner answers stand and unanswered seam review proceeds post hoc under Will's 2026-10-03 directive.
- No new table is reserved. smithers-8a accepts any migration ownership change and smithers-3f approves its encoding under C-PRC-02; run the §21.2 drift gates under C-PRC-01 at landing.
- Risk: replanting a candidate whose earlier item was removed conflicts more often than today's append-only rebase. Observation: the C-J7-01 run or the integration test logs a conflict on a move with disjoint files. Conflicts route to T-STK-08.

## Ready checklist
1. Dependencies: the header and index list storage (T-STK-01), stack lock/fence/prefix (T-STK-12), authorization (T-ACC-03), descriptors (T-CAT-01), confirmations (T-APP-04), machine launcher/execution (T-INS-02, T-FLW-01) and root validation (T-SEC-01). All are S1; Scope names each dark-landing guard. No T-APP-04 reverse placement edge exists in its current header.
2. Exclusions: Out names Drop orchestration, Amend/steer, capacity, presence, split/squash, merge/conflict/PR, CLI/skills, UI, duplicate stores/workers/policy and root/layer work. Changes reshape existing admission, service, routes and API rows; new migration/test/docs items state why reuse alone is insufficient.
3. Tests: `todo_place_db_test.go` uses the production install router/dispatcher and worker boundary with real PostgreSQL/history and fixed oracles. C-ACC-01 covers credential and missing-provider refusals; C-STK-06 covers prefix/invalidation. C-J7-01 and C-J4-02 retain their browser boundaries, with other owners' assertions pending until integration. No runtime spec or implementation-derived expectations.
4. Decisions: smithers-3f approves ordering keys, stack locks, ancestry/replant, transactions, migrations and security; smithers-b8 approves public payload/refusal and app dispatch seams; smithers-38 approves catalog/library and public TypeScript API changes under §21.1. smithers-8a accepts cross-owner seams and ownership changes; Will decides product changes. No ADR is introduced.
5. Owner pre-review questions, recorded before start; recorded answers stand and unanswered review proceeds post hoc under Will's directive: smithers-3f: Does placement use the existing claim and stack-then-TODO lock? Does reordering preserve the own change and atomically invalidate successors? Do missing execution providers prevent all repository work? smithers-b8: Do create/move doors preserve confirmation, terminal_s1 restrictions and idempotency? Does the route reshape remove the replaced install door? smithers-38: Do descriptors and generated clients reuse the existing contract without a second policy table? Views are excluded, so no smithers-06 review is needed.
6. Security: smithers-3f reviews M-29 machine-only, unprivileged repository execution and packaged host object operations with hooks, filters and configuration-selected executables disabled. This ticket adds no root step and supplies no new root-step input, from main or branch; it records placement/rebase facts and reuses executing providers. Before enabling induced execution, those providers must supply their complete root-step input/source inventories and C-SEC-02 receipts: T-SEC-01 R1–R3 (`TestGuestHelperInstallPinsInterpreterAndEnv`, `TestRootSetupNeverFollowsMemberSymlinks`, `TestRootPreflightParsesOnlyEnvelope`), T-MCH-10's layer follow-up R4 (`TestRootLayerInputsValidatedBeforeUse`) and T-FLW-01's artifact follow-up R5 (`TestRootManagedArtifactInstallUsesApprovedBundleOnly`), as inventoried in T-STK-12. Any unvalidated branch-sourced root data blocks activation; branch-built root executables, scripts, imports and toolchains remain forbidden regardless of digest equality or test results. Missing providers fail closed in the named boundary suite.
