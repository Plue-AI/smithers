# T-GH-05 Checks on every PR, protection text, closed/reopened, out-of-order merge marks both merged

Stage S1 · Size M · Depends on T-GH-03, T-GH-02, T-STK-07 · Unblocks — · Issue: to file
Spec: spec.md §3.0, §4.1, §4.1.2a, §6.1.2 (in-card), §10.6.2, §10.6.4, §12.1.2 (`administration: read`), §12.3 (checks, approved, merged, closed rows), §12.4.1, §14.5.2 · Delta: delta.md §7 "PR closed → dropped…" · Product: mvp.md J10.5, §6.3 (checks, merged, closed, branch protection rows), M-22

## Goal
Every TODO PR shows its GitHub checks by name, a blocked merge shows GitHub's own sentence, and a merge, close or reopen made on GitHub moves the TODO to Merged, Dropped or back to In review exactly as if done in Smithers. A later draft un-drafted and merged first marks both items merged with a note, folds `main`, and asks maintainers for an OK.

## Scope
In:
- Checks on every TODO PR head, not only on the automerge path. The `pr-state` stream (T-GH-02) feeds `{name, status, conclusion, required}` into the latest attempt's evidence, the `todo:<n>` PR `checks` and the home `merge_block`.
- Required checks come from `main`'s branch protection and rulesets, read with `administration: read` (§12.1.2). A failed required check holds Merge and names itself (§12.3). Other failures show in evidence but don't block.
- GitHub's refusal text, built (delta.md §7): `landingGitHubStatusError` (`landing_github_pull.go:446-465`) discards the response body today and returns generic sentences. Keep the body's `message` and `errors[].message` on every non-2xx response, so a blocked merge shows GitHub's sentence, for example "1 approving review required on GitHub" (§10.6.2).
- PR merged on GitHub → `merged` once `main` contains the commit (§4.1). The linked issue closes, with a comment linking the change, only when `fixes_issue` is true. Later items are force-updated (§10.6.3).
- PR closed unmerged → `dropped` with `state_reason` "closed on GitHub by @x", the actor read from the issue's `closed_by`. Later items get `rebase_pending` (§4.1 drop guard).
- PR reopened within 7 days → `in_review` (§4.1) at the TODO's previous stack position when it is still free, otherwise appended. `smithers/<slug>` is recreated on GitHub from the last verified candidate captured in the host repository store, whatever happened to the machine (§12.3). A TODO dropped by a GitHub close stays followed for those 7 days.
- Out-of-order merge (§10.6.4): someone un-drafts a later item's PR and merges it first. Its squash commit contains the earlier unmerged items' changes. The engine marks the merged item and every earlier unmerged item it contained as `merged`, notes on each earlier one "T3 merged before T2; T2's change is in T3's commit", folds `main`, and opens `stack_attention{kind: order}` for maintainers with that sentence (§4.1.2a). The attention holds the stack's merges until a maintainer presses **OK** (in-card). Later items rebase as after any merge.

Out: the merge command and its session and role guards (T-STK-04); rebase execution (T-STK-08, T-STK-11); the PR body and draft state (T-GH-03); keyed issue close and comment writes (T-GH-09 wraps them); stacked bases ([D]); merge methods other than squash (§10.6.2 fixes squash).

## Changes
- `packages/backend/internal/services/github_inbound_pulls.go` (new) → the T-GH-02 consumer for PR state and checks of TODO PRs, reading the `github_synced_*` store (§3.0).
- `packages/backend/internal/services/mythical_items.go:2163-2221` (`follow`) → read PR state from the synced store; replace `rejected` (`:2196-2197`) with `dropped` plus actor; add the reopen and out-of-order cases. Out of order finds the earlier items contained in the merged commit from the stack order, marks each merged with the note in `todo_events` and activity, and opens `stack_attention` through T-STK-07's API.
- `mythical_items.go:85` (`mythicalSettledStates`) → keep GitHub-closed TODOs followed for 7 days.
- `packages/backend/internal/services/mythical_github.go:611` (`HeadChecks`) → build named results with `required` from the `pr-state` contexts (`isRequired`), with branch protection and rulesets naming the required set; delete its per-head REST reads; call it from the checks consumer, not only from `merge` (`mythical_items.go:2435`).
- `packages/backend/internal/services/landing_github_pull.go:446-465` (`landingGitHubStatusError`) → parse the response body and carry `message` and `errors[].message` verbatim in the typed error (§6.2.3 class `github`).
- `mythical_items.go:2455` ("CI failed on the approved head") and `:2532` ("GitHub refused the merge") → the named failing checks and GitHub's sentence.
- `mythical_items.go:3168-3255` (`complete`, `completionBody`) → close the issue only when `todos.fixes_issue`.
- Catalog: **OK** on the `order` attention as an `in-card` command, maintainers only (§6.1.2), through `POST /api/stack/attention/{id} {action: ok}` (shared with T-GH-07); OpenAPI row in `docs/api/openapi/`.
- `packages/backend/docs/github-sync.md` → "Checks, merges and closes" section; docs gates as in T-GH-02.

## Tests
- Unit, `github_inbound_pulls_test.go` (new): checks classification by name and `required` from classic protection and from a ruleset.
- Unit, `landing_github_pull_test.go` (extend): a 405 body `{"message":"At least 1 approving review is required by reviewers with write access."}` reaches the merge refusal unchanged; a 422 with `errors[]` keeps each message.
- Unit: the state table over {merged in order, merged out of order, closed, reopened at day 6, reopened at day 8, closed twice} with a fake clock.
- Integration, real PostgreSQL + real git + `githubfake`: [C-J10-08](../checks/C-J10-08.md).
- Integration, [C-STK-04](../checks/C-STK-04.md): T3 un-drafted and merged while T2 is first → T2 and T3 `merged`, T2's note, `main` folded, `stack_attention{order}` visible to maintainers and refused to members, later merges held until **OK**.
- Integration: a reopen restores the previous position when free and appends otherwise, and recreates the GitHub branch at the last verified candidate after the machine was cleaned up.
- Integration: `fixes_issue` false leaves the issue open; true closes it with a comment linking the merge commit, and only after the main pull shows the commit.
- e2e: [C-J10-05](../checks/C-J10-05.md). The merge-refusal sentence is a step of [C-J4-03](../checks/C-J4-03.md): branch protection requires one review, and Merge shows GitHub's sentence.

## Acceptance
- [C-J10-05](../checks/C-J10-05.md): a merge on GitHub turns the TODO Merged and closes its issue with a link.
- [C-J10-08](../checks/C-J10-08.md): a close on GitHub turns the TODO Dropped with the actor; a reopen within 7 days restores In review.
- [C-STK-04](../checks/C-STK-04.md): a later draft merged first marks both items merged with the note, folds `main`, and opens `order` attention settled by OK.

## Risks and notes
- Risk: `closed_by` can be null for a PR closed by deleting its head branch. Confirmed by deleting a TODO branch on the scratch repository and reading `GET /issues/{n}`. The reason then reads "closed on GitHub".
- Resolved: §10.6.4 closes each earlier item's open PR with "Merged via #<n> (Tk)" through `outbound_writes`.
- Resolved: mvp.md Appendix B.4 now has `order.ok` for the order attention's **OK** control, and spec §6.1.2 names OK.
