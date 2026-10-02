# T-STK-04 Merge: person session, first item only, sha-bound, squash

Stage S1 · Size M · Depends on T-STK-01, T-ACC-03 · Unblocks T-APP-04 · Issue: to file
Spec: spec.md §4.1, §4.1.2a, §5.2, §5.3, §6.2.4, §10.6.1, §10.6.2, §10.6.3, §12.1.2, §12.3 (TODO PR merged), §12.5, §16.4 · Delta: delta.md §6 (Modify merge; Delete `change.land` path) · Product: mvp.md §4.2 Merging, §6.10, J1.7, J2.6, M-01, M-05, rule 6, Appendix B.4 (Stack: merge)

## Goal
Only an owner or maintainer signed in with a browser session can merge, only the first unmerged item can merge, and the merge squashes exactly the PR head the person reviewed, so a moved head or an out-of-order request merges nothing.

## Scope
In:
- `POST /api/todos/{n}/merge {reviewed_head_sha}` and the `/merge Tn` catalog command (person only; agents get a Review & merge confirmation, mvp.md Appendix B.2).
- Guards of §10.6.2: `session` credential, role owner or maintainer, first unmerged item in stack order, `reviewed_head_sha` = current PR head, required GitHub checks passing, GitHub reports the PR mergeable. An open `stack_attention` row also holds the merge (§4.1.2a).
- `todo_approvals` rows carrying the D-23 rule: an approval counts only from a person's session and only for the PR head it names; a head change voids it.
- GitHub merge with `sha = reviewed_head_sha` and `merge_method = squash`; `in_review → merged` once GitHub reports the merge and `main` contains the commit.
- The linked issue closes only when `fixes_issue` is true.
- `merge_block` on the `home` and `todo:<n>` projections: "Merges after Tn", the failing required check's name, or GitHub's refusal text as received.
- One merge path: delete the `automerge`-label merge, Land and `change.land` paths in this change (mvp.md Appendix B.4: "today it merges on the `automerge` label").

Out:
- The Confirm card and person confirmations for delegated credentials (T-ACC-05, T-APP-04).
- Reading required checks from branch protection, protection reason text and out-of-order merges on GitHub (T-GH-05).
- Outbound idempotency keys and crash reconcile for the merge write (T-GH-09).
- The squash-merge check at setup (T-INS-06). Stacked PR bases (spec §0 [D]).

## Changes
- `packages/backend/internal/services/todo_merge.go` (new) → `Merge(ctx, n, reviewedHead)`: authorize `merge` through `Authorize` (T-ACC-03); refuse token auth (`AuthInfo.IsTokenAuth`, `internal/middleware/scope.go:59`) so only a session passes; read the PR live (`mythicalGitHubAPI.Pull`, `mythical_github.go:258`); read checks with their `required` flag (T-GH-05); insert `todo_approvals`; call `Merge` (`:314`, already `sha` + squash) through the outbound path (T-GH-09); record the merge-in-flight marker that `smthrs host upgrade` and `POST /api/install/quiesce` read (§16.4, §16.5).
- `packages/backend/internal/services/mythical_items.go` → `gate` (`:2238`) stops after the agent review and never calls `merge` (`:2435`). Delete the label applier checks (`:2466-2516`), `automergeLabel` (`:64`), `checks.Automerge`, `checks.Land` and `landedByMaintainer`. Completion (`complete`, `:3168`) closes the issue only when `todos.fixes_issue`.
- After a merge, later items rebase onto the new `main` and their open PRs are force-updated (§10.6.3) through the existing integrate path. Every head change deletes that TODO's `todo_approvals` rows.
- `packages/backend/internal/routes/todos.go` → the merge route. Refusals use the §6.2.3 envelope: `permission` for credential or role, `conflict` for order, stale head or open stack attention, `github` for GitHub's refusal.
- Delete `packages/backend/internal/services/mythical_land_todo.go`, `mythical_land_todo_test.go`, route `POST /mythical/items/{id}/land` (`internal/compose/router.go:1123`, `routes/mythical.go:321`) and its OpenAPI row (`docs/api/openapi/repositories.yaml:12095`).
- Delete the app doors: `history.land` and `HISTORY_LAND_USER_ONLY_REASON` (`apps/app/src/mainview/flows/entries/history.ts:24`, `:120`), `StackSeam.landStackItem` (`state/seams/StackSeam.ts:613`), `landable` (`packages/rpc/src/StackView.ts:81`), `change.land` (`flows/entries/change.ts:76`) and `ChangeSeam.landChange`/`land` (`state/seams/ChangeSeam.ts:1347-1364`), with their tests.
- `docs/api/openapi/todos.yaml` → the merge row; regenerate `ProductApi.ts` (`smthrs run //:openapiClients`); update `packages/backend/docs/todos.md` and run the docs gates.

## Tests
- Unit, `todo_merge_test.go` (new): the guard table. Each guard fails alone (delegated, run and machine credentials; member role; second item; stale head; pending or failed required check; GitHub not mergeable; open `stack_attention`) and yields no GitHub call.
- Integration with real PostgreSQL and the fake GitHub server, `todo_merge_db_test.go` (new): a maintainer session merges T1 at its head. Exactly one `PUT /pulls/{n}/merge` with `sha` and `merge_method=squash`; one `todo_approvals` row; `merged` only after `OnMain` (`mythical_github.go:539`) is true.
- Integration, same file: a head change after approval deletes the approval, and a merge with the old head is refused.
- Integration, same file: the issue closes for `fixes_issue = true` and stays open for `false`.
- Unit, `mythical_items_test.go` (existing): no worker pass calls `Merge`, whatever labels the issue carries.

## Acceptance
- [C-J4-03](../checks/C-J4-03.md): only the first unmerged item merges; later items show "Merges after Tn".
- [C-ACC-02](../checks/C-ACC-02.md): delegated, run and machine credentials get `permission` refusals on this route. The check also needs T-ACC-04 and T-ACC-05.
- [C-J2-05](../checks/C-J2-05.md) (S1 part): merge turns the TODO Merged and closes the issue only when it fixes it.

## Risks and notes
- `/api/repos/{o}/{r}/landings*` and `LandingService` (`services/landing.go`) still serve Plue. This ticket deletes only their TODO doors. The routes stay for Plue and are unmounted in the install composition, with `x-composition: plue` on their OpenAPI rows (§6.2.4); T-CUT-02 does the unmount.
- Risk: GitHub reports `mergeable: null` while it computes. Observation: a refusal on a fresh PR head in the integration log. Retry the read once after 2 s before refusing.
