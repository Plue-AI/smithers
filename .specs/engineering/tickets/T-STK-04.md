# T-STK-04 Merge: person session, one predicate and an in-flight fence, sha-bound, squash

Stage S1 · Size L · Depends on T-STK-01, T-ACC-03, T-STK-12, T-ACC-04, T-ACC-05, T-STK-07, T-GH-02, T-GH-05, T-GH-09, T-INS-02 · Unblocks T-STK-05, T-APP-04 · Issue: to file
Spec: spec.md §4.1, §4.1.2a, §5.2, §5.3, §6.2.4, §10.4.5, §10.6.1, §10.6.2, §10.6.2a, §10.6.2b, §10.6.2c, §10.6.3, §12.1.2, §12.3 (TODO PR merged), §12.5, §16.4 · Delta: delta.md §6 (Modify merge; Delete `change.land` path) · Product: mvp.md §4.2 Merging, §6.10, J1.7, J2.6, M-01, M-05, rule 6, Appendix B.4 (Stack: merge)

## Goal
Only an owner or maintainer signed in with a browser session can merge, and only while the one merge predicate holds: the first unmerged item, in review, at its accepted generation with no pending work, rebase or open wait, and at exactly the PR head the person reviewed. A moved head, a pending edit or steer, a rebase, a reorder or an out-of-order request merges nothing.

## Scope
In:
- `POST /api/todos/{n}/merge {reviewed_head_sha}` and the `/merge Tn` catalog command (person only; agents get a Review & merge confirmation, mvp.md Appendix B.2).
- `session` credential and role owner or maintainer (§10.6.2), plus `MergeReady` (§10.6.2a): the one predicate behind the route, `merge_block` and a Review & merge confirmation's approve, with its nine rows and reason codes.
- Consume T-STK-12's `LockStack`, `todos.merging` and held-signal delivery (§10.6.2b). This ticket owns the locked merge predicate, fresh pre-dispatch rechecks, dispatch and restart reconciliation. Shared primitives refuse fenced mutations and hold steers, review comments, rebases and proposes (C-STK-07).
- `todo_approvals` rows carrying the D-23 rule: an approval counts only from a person's session and only for the generation and PR head it names (§10.6.2c); a new generation voids it.
- GitHub merge with `sha = reviewed_head_sha` and `merge_method = squash`; `in_review → merged` once GitHub reports the merge and `main` contains the commit.
- The linked issue closes only when `fixes_issue` is true.
- `merge_block = {reason, detail?}` on the `home` and `todo:<n>` projections, from `MergeReady` (§10.6.2a): "Merges after Tn", the failing required check's name, GitHub's refusal text as received, or the reason code.
- One merge path: delete the `automerge`-label merge, Land and `change.land` paths in this change (mvp.md Appendix B.4: "today it merges on the `automerge` label").

Out:
- The Confirm card and person confirmations for delegated credentials (T-ACC-05, T-APP-04).
- Reading required checks from branch protection, protection reason text and out-of-order merges on GitHub (T-GH-05).
- Implementing outbound idempotency keys and crash reconcile (T-GH-09); the merge path must consume them before it is enabled.
- New card Views, generic Plue landing removal, direct agent merge and host execution of checks.
- The squash-merge check at setup (T-INS-06). Stacked PR bases (spec §0 [D]).

## Changes
- `packages/backend/internal/services/todo_merge.go` (new) → `Merge(ctx, n, reviewedHead)`: authorize `merge` through `Authorize` (T-ACC-03); refuse token auth (`AuthInfo.IsTokenAuth`, `internal/middleware/scope.go:59`) so only a session passes; evaluate `MergeReady` rows 1-7 and set the fence in one transaction that locks the stack row, then the TODO row; recheck before dispatch with a fresh capture when the machine is awake, `git ls-remote` of `main`, the PR read live (`mythicalGitHubAPI.Pull`, `mythical_github.go:258`) and checks with their `required` flag (T-GH-05); insert `todo_approvals` with the generation; call `Merge` (`:314`, already `sha` + squash) through the outbound path (T-GH-09); the fence is the merge-in-flight marker that `smthrs host upgrade` and `POST /api/install/quiesce` read (§16.4, §16.5).
- `packages/backend/internal/services/mythical_items.go` → `gate` (`:2238`) stops after the agent review and never calls `merge` (`:2435`). Delete the label applier checks (`:2466-2516`), `automergeLabel` (`:65`), `checks.Automerge`, `checks.Land` and `landedByMaintainer`. Completion (`complete`, `:3168`) closes the issue only when `todos.fixes_issue`.
- After a merge, later items rebase onto the new `main` and their open PRs are force-updated (§10.6.3) through the existing integrate path. Every new generation deletes that TODO's `todo_approvals` rows.
- `todo_approvals.generation` migration remains here. T-STK-12 owns the `todos.merging` migration (C-STK-07).
- Consume `LockStack(tx)` and `FenceSet(tx, todo)` from T-STK-12 in every merge transaction. Do not create another lock or held-signal queue (C-STK-07).
- `packages/backend/internal/routes/todos.go` (new) → the merge route. Refusals use the §6.2.3 envelope: `permission` for ineligible credential or role, `conflict` with the §10.6.2a reason code for rows 1-8, `github` for GitHub’s refusal. Eligible delegated requests return 202 with a private confirmation through T-ACC-05; only its author’s eligible session executes Merge (§5.2.1, C-ACC-02).
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
- [C-ACC-02](../checks/C-ACC-02.md): eligible delegated requests return 202 with a private confirmation and no merge; run and machine credentials get `permission` refusals. Only the requesting person’s eligible session approves and merges.
- [C-J2-05](../checks/C-J2-05.md) (S1 part): merge turns the TODO Merged and closes the issue only when it fixes it.
- [C-STK-07](../checks/C-STK-07.md): races against Merge merge nothing stale; concurrent merges make one GitHub call.
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- May start against T-ACC-03's final `Authorize` seam using test-only fixtures. Land after T-ACC-03 and every listed dependency; C-ACC-02 must use the real authorizer.
- `/api/repos/{o}/{r}/landings*` and `LandingService` (`services/landing.go`) still serve Plue. This ticket deletes only their TODO doors. The routes stay for Plue and are unmounted in the install composition, with `x-composition: plue` on their OpenAPI rows (§6.2.4); T-CUT-02 does the unmount.
- Risk: GitHub reports `mergeable: null` while it computes. Observation: a refusal on a fresh PR head in the integration log. Retry the read once after 2 s before refusing.

## Ready checklist

1. Dependencies include credentials/confirmation, independent waits, required-check data and reads, outbound recovery and the isolation launcher. Resolve the T-GH-05 and T-GH-09 prerequisite cycles listed in the edit draft before start.
2. Out names Confirm Views, implementing check ingestion and outbound recovery, Plue landing removal, direct agent merge, host checks and stacked PR bases. Consuming prerequisite services is in scope.
3. C-STK-07 and `todo_merge_db_test.go` call `POST /api/todos/{n}/merge` through the install router with real middleware, PostgreSQL and GitHub fake. C-ACC-02 exercises `/merge` and confirmation approval through the production catalog dispatcher. Assert each literal guard fixture’s route status, merge_block and GitHub call count. Expected statuses, graphs, timings and outputs are literal test fixtures or independent input logs. No test reads spec files or computes expectations from production code at runtime.
4. smithers-8a decides merge-contract changes and Plue/install deletion ambiguity. smithers-b8 approves catalog/app seams; smithers-38 signs off removing `landable` under §21.1.
5. Before start, smithers-3f: do all stack writers use the same lock/fence; do fresh capture and outbound recovery prevent stale or duplicate merge? smithers-b8: do delegated requests use confirmation and all TODO Land doors disappear? smithers-38: is removing `landable` complete for every caller? Views are excluded; changing one needs smithers-06 pre-review.
6. Fresh capture uses the machine boundary. Checks and repository flows never execute on the host; T-INS-02 refuses missing isolation (§1.3). Packaged host Git operations on captured trees disable repository hooks/helpers (§10.5.5). smithers-3f reviews this boundary and session-only execution; C-STK-07, C-ACC-02 and C-SEC-02 prove it.
