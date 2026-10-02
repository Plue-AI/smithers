# T-STK-04 Merge: person session, one predicate and an in-flight fence, sha-bound, squash

Stage S1 · Size L · Depends on T-STK-01, T-ACC-03, T-STK-12 · Unblocks T-APP-04, T-STK-05, T-STK-06 · Issue: to file
Spec: spec.md §4.1, §4.1.2a, §5.2, §5.3, §6.2.4, §10.4.5, §10.6.1, §10.6.2, §10.6.2a, §10.6.2b, §10.6.2c, §10.6.3, §12.1.2, §12.3 (TODO PR merged), §12.5, §16.4 · Delta: delta.md §6 (Modify merge; Delete `change.land` path) · Product: mvp.md §4.2 Merging, §6.10, J1.7, J2.6, M-01, M-05, rule 6, Appendix B.4 (Stack: merge)

## Goal
Only an owner or maintainer signed in with a browser session can merge, and only while the one merge predicate holds: the first unmerged item, in review, at its accepted generation with no pending work, rebase or open wait, and at exactly the PR head the person reviewed. A moved head, a pending edit or steer, a rebase, a reorder or an out-of-order request merges nothing.

## Scope
In:
- `POST /api/todos/{n}/merge {reviewed_head_sha}` and the `/merge Tn` catalog command (person only; agents get a Review & merge confirmation, mvp.md Appendix B.2).
- `session` credential and role owner or maintainer (§10.6.2), plus `MergeReady` (§10.6.2a): the one predicate behind the route, `merge_block` and a Review & merge confirmation's approve, with its nine rows and reason codes.
- The merge fence `todos.merging` (§10.6.2b): the locked predicate; the recheck before dispatch (a fresh capture of an awake machine, `git ls-remote` of `main`, GitHub's PR head, required checks and mergeable state); dispatch; `409 {code: merging}` for placements and amends of the item; held steers and review comments; deferred `rebase_pending` and `stack.propose`; reconcile on start.
- `todo_approvals` rows carrying the D-23 rule: an approval counts only from a person's session and only for the generation and PR head it names (§10.6.2c); a new generation voids it.
- GitHub merge with `sha = reviewed_head_sha` and `merge_method = squash`; `in_review → merged` once GitHub reports the merge and `main` contains the commit.
- The linked issue closes only when `fixes_issue` is true.
- `merge_block = {reason, detail?}` on the `home` and `todo:<n>` projections, from `MergeReady` (§10.6.2a): "Merges after Tn", the failing required check's name, GitHub's refusal text as received, or the reason code.
- One merge path: delete the `automerge`-label merge, Land and `change.land` paths in this change (mvp.md Appendix B.4: "today it merges on the `automerge` label").

Out:
- The Confirm card and person confirmations for delegated credentials (T-ACC-05, T-APP-04).
- Reading required checks from branch protection, protection reason text and out-of-order merges on GitHub (T-GH-05).
- Outbound idempotency keys and crash reconcile for the merge write (T-GH-09).
- The squash-merge check at setup (T-INS-06). Stacked PR bases (spec §0 [D]).

## Changes
- `packages/backend/internal/services/todo_merge.go` (new) → `Merge(ctx, n, reviewedHead)`: authorize `merge` through `Authorize` (T-ACC-03); refuse token auth (`AuthInfo.IsTokenAuth`, `internal/middleware/scope.go:59`) so only a session passes; evaluate `MergeReady` rows 1-7 and set the fence in one transaction that locks the stack row, then the TODO row; recheck before dispatch with a fresh capture when the machine is awake, `git ls-remote` of `main`, the PR read live (`mythicalGitHubAPI.Pull`, `mythical_github.go:258`) and checks with their `required` flag (T-GH-05); insert `todo_approvals` with the generation; call `Merge` (`:314`, already `sha` + squash) through the outbound path (T-GH-09); the fence is the merge-in-flight marker that `smthrs host upgrade` and `POST /api/install/quiesce` read (§16.4, §16.5).
- `packages/backend/internal/services/mythical_items.go` → `gate` (`:2238`) stops after the agent review and never calls `merge` (`:2435`). Delete the label applier checks (`:2466-2516`), `automergeLabel` (`:64`), `checks.Automerge`, `checks.Land` and `landedByMaintainer`. Completion (`complete`, `:3168`) closes the issue only when `todos.fixes_issue`.
- After a merge, later items rebase onto the new `main` and their open PRs are force-updated (§10.6.3) through the existing integrate path. Every new generation deletes that TODO's `todo_approvals` rows.
- `packages/backend/db/product/migrations/01xx_todo_merge_fence.sql` (new) → `todos.merging jsonb` and `todo_approvals.generation`.
- `packages/backend/internal/services/stack_lock.go` (new) → `LockStack(tx)` (the stack row, then the TODO rows) and `FenceSet(tx, todo)`. Every stack mutation calls them; T-STK-02, T-STK-05, T-STK-06 and T-STK-12 call them in their own changes, and C-STK-07 covers each.
- `packages/backend/internal/routes/todos.go` → the merge route. Refusals use the §6.2.3 envelope: `permission` for credential or role, `conflict` with the §10.6.2a reason code for rows 1-8, `github` for GitHub's refusal.
- Delete `packages/backend/internal/services/mythical_land_todo.go`, `mythical_land_todo_test.go`, route `POST /mythical/items/{id}/land` (`internal/compose/router.go:1123`, `routes/mythical.go:321`) and its OpenAPI row (`docs/api/openapi/repositories.yaml:12095`).
- Delete the app doors: `history.land` and `HISTORY_LAND_USER_ONLY_REASON` (`apps/app/src/mainview/flows/entries/history.ts:24`, `:120`), `StackSeam.landStackItem` (`state/seams/StackSeam.ts:613`), `landable` (`packages/rpc/src/StackView.ts:81`), `change.land` (`flows/entries/change.ts:76`) and `ChangeSeam.landChange`/`land` (`state/seams/ChangeSeam.ts:1347-1364`), with their tests.
- `docs/api/openapi/todos.yaml` → the merge row; regenerate `ProductApi.ts` (`smthrs run //:openapiClients`); update `packages/backend/docs/todos.md` and run the docs gates.

## Tests

- C-J2-05: TODO and Confirm use the same required-check decision at the reviewed SHA. Failed optional plus passed required permits merge; pending required blocks both Containers and the service, with zero GitHub calls.
- Unit, `todo_merge_test.go` (new): the guard table. Each guard fails alone (delegated, run and machine credentials; member role; each `MergeReady` row of §10.6.2a with its reason code) and yields no GitHub call. The same function gives the route's refusal and `merge_block`.
- Integration with real PostgreSQL and the fake GitHub server, `todo_merge_db_test.go` (new): a maintainer session merges T1 at its head. Exactly one `PUT /pulls/{n}/merge` with `sha` and `merge_method=squash`; one `todo_approvals` row; `merged` only after `OnMain` (`mythical_github.go:539`) is true.
- Integration, same file: a head change after approval deletes the approval, and a merge with the old head is refused.
- Integration, same file: the issue closes for `fixes_issue = true` and stays open for `false`.
- Unit, `mythical_items_test.go` (existing): no worker pass calls `Merge`, whatever labels the issue carries.
- Integration, `todo_merge_race_db_test.go` (new), for C-STK-07: a steer, an edit, a reorder, `rebase_pending`, a `main` move and a second merge, each against a merge the fake GitHub holds; zero merge calls for every refusal and at most one per TODO; the fence reconciled after an engine restart.

## Acceptance
- [C-J4-03](../checks/C-J4-03.md): only the first unmerged item merges; later items show "Merges after Tn".
- [C-ACC-02](../checks/C-ACC-02.md): delegated, run and machine credentials get `permission` refusals on this route. The check also needs T-ACC-04 and T-ACC-05.
- [C-J2-05](../checks/C-J2-05.md) (S1 part): merge turns the TODO Merged and closes the issue only when it fixes it.
- [C-STK-07](../checks/C-STK-07.md): races against Merge merge nothing stale; concurrent merges make one GitHub call.

## Risks and notes
- `/api/repos/{o}/{r}/landings*` and `LandingService` (`services/landing.go`) still serve Plue. This ticket deletes only their TODO doors. The routes stay for Plue and are unmounted in the install composition, with `x-composition: plue` on their OpenAPI rows (§6.2.4); T-CUT-02 does the unmount.
- Risk: GitHub reports `mergeable: null` while it computes. Observation: a refusal on a fresh PR head in the integration log. Retry the read once after 2 s before refusing.
