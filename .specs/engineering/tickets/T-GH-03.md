# T-GH-03 PR shape: slug branch, body, item-only diff; later items' PRs are drafts until next

Stage S1 · Size M · Depends on T-STK-01, T-STK-10 · Unblocks T-GH-05, T-GH-09 · Issue: to file
Spec: spec.md §8.1.1, §10.3.2, §10.6.3, §12.4.1 (PR title), §12.4.2, §12.5, §14.3 (Diff), §16.3.1 · Delta: delta.md §6 "PRs stay based on `main`", §7 · Product: mvp.md J10.1, §3 (TODO `T12`), §4.2 "Merging", §6.3 "From Smithers to GitHub", M-22

## Goal
When a TODO reaches In review, GitHub shows one PR from `smithers/<slug>` into `main` whose head commit is the item's verified candidate and whose body carries the prompt, acceptance, evidence, included earlier items, a link back and "Requested by @owner". Only the first item's PR is ready for review; later items' PRs are GitHub drafts until they become next. Smithers shows only the item's own change.

## Scope
In:
- Head branch = the TODO branch's recorded GitHub name (`branches.github_branch`, set once from `smithers/<slug>` by T-STK-01, §8.1.1). One branch and one PR for the TODO's life.
- Base `main`. Head commit = the verified candidate (`main` + every earlier unmerged item + this item), one commit whose parent is the current `main` tip (today's design, E-15).
- Draft state (§12.5.1): the first unmerged item's PR opens ready for review; every later item's PR opens with `draft: true`, so GitHub won't merge it.
- Becoming next: when the first item merges, the next item rebases onto the new `main`, its verified candidate holds only its own change, its PR is force-updated, and then it is marked ready with the GraphQL mutation `markPullRequestReadyForReview` (REST can't change draft state).
- PR title = the TODO title (§12.4.1).
- Body (§12.5.1): the latest prompt revision; acceptance; evidence (checks table, diff stat, review summary) from the latest attempt; the earlier unmerged items it includes, each as `Tn` and its title linked to its PR; a link back to the TODO at the install's first public origin (§16.3.1); "Requested by @owner" (§12.4.2). `Tn` doesn't autolink on GitHub, so no item is mistaken for issue or PR `#n`.
- Body refresh on every verified update and when an earlier item merges, so a merged item drops off the list (§10.6.3). Pushes use `--force-with-lease` against the recorded head (§12.5.2).
- Closing keywords stay stripped from every text the body quotes, so only completion closes an issue (§12.3 merged row).
- Item-only diff: from the previous unmerged item's verified candidate to this one, or from `main` for the first item. It feeds the TODO card's PR and the Diff card.

Out: stacked bases and retargeting ([D] §12.5.3); agent replies in review threads ([D]); keys and crash reconcile for the open, body-update, ready and push writes (T-GH-09 wraps the calls made here); evidence collection (T-STK-10); slug derivation and the `branches` table (T-STK-01); merge (T-STK-04); a later draft un-drafted and merged on GitHub (T-GH-05, §10.6.4).

## Changes
- `packages/backend/internal/services/mythical_items.go:2115-2124` (`mythicalBranch`) → read `branches.github_branch`; delete the `issue-<n>`, `change-<hex>` and `-r<k>` forms.
- `mythical_items.go:2126-2149` (`proposal()`) → render the §12.5.1 body from `todo_revisions`, `todo_attempts.evidence` and the stack order, and take the title from `todos.title` instead of the agent summary's first line. Keep `mythicalNoClosingKeywords` (`:2156`) over quoted text. Delete the fixed "One commit carrying…" sentence.
- `mythical_items.go:2081-2113` (`openPull`) → open with `draft` set unless the item is first; record the PR's `node_id`; after the PR exists, update its body when the rendered body's digest differs from the recorded one.
- Stack engine, after a merge's rebase pass (§10.6.3) → for the new first item, once its verified candidate is pushed, call `MarkReadyForReview`.
- `packages/backend/internal/services/mythical_github.go:282` (`CreatePull`) → accept `draft`; add `UpdatePullBody(number, body)` and `MarkReadyForReview(nodeID)` (`POST /graphql`, `markPullRequestReadyForReview(input: {pullRequestId})`, idempotent when already ready).
- `mythical_items.go:2419-2427` (`proposalDiff`) → diff the previous item's candidate tree against this candidate tree instead of `PRHead^..PRHead`.
- `GET /api/branches/{b}/diff` (§6.3; route owned by the branch API) → serve the item-only diff for item branches; OpenAPI row in `docs/api/openapi/` and re-bundle `docs/api/openapi.yaml`.
- `packages/backend/internal/githubfake/` → `draft` on PR create and the `markPullRequestReadyForReview` GraphQL mutation.
- `packages/backend/docs/github-sync.md` → a "Pull requests" section; docs gates as in T-GH-02.

## Tests
- Unit, `mythical_proposal_test.go` (existing): the body holds the latest revision only; lists exactly the unmerged earlier items in stack order as `Tn` links; names the owner's GitHub login; keeps no closing keyword from the prompt or evidence; stays under GitHub's 65,536-character body limit, with a link back when evidence is cut.
- Unit: the PR title equals the TODO title; a TODO whose slug changes after its first push keeps its recorded branch name.
- Integration, real PostgreSQL + real git + `githubfake` (`mythical_pr_shape_integration_test.go`, new): with T1, T2 and T3 in review, T1's PR is ready and T2's and T3's are drafts; T2's head commit has parent = `main` tip and tree = main + T1 + T2; its base is `main`; Smithers' diff for T2 contains none of T1's paths.
- Integration: T1 merges → T2's head is force-updated to main + T2, its body no longer lists T1, and exactly one `markPullRequestReadyForReview` call follows the push; T3 stays a draft. A repeat of the ready call after a crash is a no-op.
- Integration: amending T2 updates the body to revision 2.
- e2e: [C-J10-01](../checks/C-J10-01.md).

## Acceptance
- [C-J10-01](../checks/C-J10-01.md): the PR on `smithers/<slug>` is based on `main`, its body has the prompt, evidence, included items and requester, and Smithers' diff shows only the item.

## Risks and notes
- Risk: a long prompt (24 KiB today, `mythicalPromptBytes`) plus evidence can pass GitHub's body limit. Confirmed by a 422 from GitHub when the scratch repository gets a body over 65,536 characters.
- Risk: GitHub offers draft PRs on private repositories only with GitHub Team or Enterprise Cloud. Confirmed by a 422 refusing `draft` on a private repository owned by a Free account. Then setup needs a check like the squash check (T-INS-06), and product decides the fallback.
- Risk: T-STK-01's backfill must copy each open PR's branch into `branches.github_branch`, or an in-flight item opens a second PR after the upgrade. Confirmed on the dogfood install by counting PRs per TODO after the upgrade.
- Open: §12.5.1 names only the merge case. A drop or reorder that changes the first item would leave the invariant "only the first item's PR is ready" broken. Proposed: mark the new first ready and return the old one to draft (`convertPullRequestToDraft`). Owner: tech lead.
