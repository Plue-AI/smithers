# T-GH-03 TODO PRs both ways: slug branch, body, item-only diff, drafts; checks, GitHub's refusal text, merged, closed, reopened, out-of-order merge

Stage S1 · Size M · Depends on T-STK-01, T-STK-02, T-STK-06, T-STK-12, T-GH-02, T-GH-09, T-ACC-03, T-FLW-11, T-MCH-14, T-INS-02, T-INS-04 · Unblocks T-APP-01, T-GH-04, T-GH-06, T-STK-04, T-REL-02 · Issue: [#3452](https://github.com/smithersai/smithers/issues/3452)
Spec: spec.md §4.1, §8.1.1, §10.3.2, §10.6.2–§10.6.4, §12.3, §12.4.1–§12.4.2, §12.5, §14.3 (Diff) · Delta: delta.md §6, §7 · Product: mvp.md J10.1, J10.5, J10.8, §4.2, §6.3, M-22

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ticket merges, GH-03+05). Absorbs T-GH-05 ([#3517](https://github.com/smithersai/smithers/issues/3517)).

## Goal
A TODO in review has one PR from `smithers/<slug>` into `main` with the item's accepted tree, a body with prompt, evidence, included items and "Requested by @owner", and drafts for every item after the first. A merge, close or reopen on GitHub moves the TODO to Merged, Dropped or In review; checks show by name; a blocked merge shows GitHub's own sentence; a later item merged first marks both merged and asks maintainers for OK.

## Scope
In: PR shape and draft policy (§12.5.1); inbound PR facts (§12.3); the 7-day reopen window; out-of-order merge (§10.6.4); controlled git configuration on every host publication caller (hooks, external diff, textconv, merge drivers and credential helpers disabled).
Out: keyed write recovery (T-GH-09 wraps every write here); evidence collection (T-STK-01); merge command and guards (T-STK-04); rebase execution (T-STK-08); next attempt after reopen (T-STK-05); stacked bases [D].

## Changes
- Reshape `services/mythical_items.go:2115` (`mythicalBranch`): read the recorded branch name; delete the `issue-<n>`, `change-<hex>` and `-r<k>` forms.
- Reshape `:2126` (`proposal`): render the §12.5.1 body from the item's latest revision, latest attempt evidence and accepted included-items manifest; title = TODO title. Keep `mythicalNoClosingKeywords`.
- Reshape `:2081` (`openPull`) and `mythical_github.go:282` (`CreatePull`): `draft` unless first; add `UpdatePullBody`, `MarkReadyForReview` and `ConvertToDraft` (GraphQL). Draft-unavailable fallback: title prefix `[waits for Tn]` and label `smithers:waiting`.
- Reshape `:2419` (`proposalDiff`): diff the accepted prefix candidate against the item's tree; serve it as `GET /api/branches/{b}/diff` `{files: DiffModel[]}` (OpenAPI in `docs/api/openapi/branches.yaml`).
- Reshape `:2163` (`follow`) and `:2827` (`ObserveGitHubEvent`): one pure `decideGitHubFact(fact, item, now)` Go switch returns events, a no-op reason or an attention kind. No `.tsv` table; poll, review and foreign-push consumers share it.
- Reshape `mythical_github.go:611` (`HeadChecks`): checks on every PR head, named, with `required` from `main`'s protection and rulesets (`administration: read`); the completion caller (`mythical_items.go:3224`) reads the same facts.
- Reshape `landing_github_pull.go:455` (`landingGitHubStatusError`): keep the body's `message` and `errors[].message` (class `github`, code `github_refused`).
- Reshape `:85` (`mythicalSettledStates`): a GitHub-closed TODO stays followed for 7 days; reopen restores its position if free, else appends, and recreates the branch from the last verified candidate.
- Reshape `:3118` (`mythicalLanded`) and `:2223` (`mythicalHold`): out-of-order merge marks every contained earlier item merged with the note "T3 merged before T2; T2's change is in T3's commit" and holds the stack's merges until a maintainer presses OK. The hold is the existing notice, not a `stack_attention` table.
- Reshape `:3168-3255` (`complete`, `completionBody`): close the issue only when `fixes_issue`, through T-GH-09.
- Reuse `internal/githubfake/`: add `draft`, the ready and draft mutations, and protection reads.
- New: none.

## Tests
- Unit: body holds the latest revision only, `Tn` links in stack order, no closing keyword, under 65,536 characters; title equals the TODO title.
- Unit: `decideGitHubFact` over literal fixtures for merged in order and out of order, closed, reopened at day 6, 7 and 8 (inclusive), closed twice; duplicates are no-ops.
- Unit: a 405 body reaches the merge refusal unchanged; a 422 keeps each `errors[].message`.
- Integration, real PostgreSQL, real git and `githubfake`, production routes and poller: T1 ready, T2 and T3 drafts; T1 merged on GitHub then T2 rebases, drops T1 from its body and turns ready once; T3 merged first marks T2 and T3 merged and holds merges until OK; OK from a member is refused and a stale revision returns 409.
- Integration: crash before and after the inbound commit; replay yields one transition and no second close or comment.
- Security: a repository with hostile hooks, diff drivers and credential helpers executes nothing on the host.

## Acceptance
- [C-J10-01](../checks/C-J10-01.md), [C-J10-05](../checks/C-J10-05.md), [C-J10-08](../checks/C-J10-08.md), [C-GH-13](../checks/C-GH-13.md), [C-STK-04](../checks/C-STK-04.md), [C-STK-07](../checks/C-STK-07.md), [C-STK-08](../checks/C-STK-08.md) (merges on GitHub during a steer, question or pause), [C-J1-04](../checks/C-J1-04.md), [C-SEC-02](../checks/C-SEC-02.md).

## Risks and notes
- Risk: a 24 KiB prompt plus evidence exceeds GitHub's body limit; GitHub answers 422. The body truncates evidence and links back.
- Risk: `closed_by` is null when the head branch is deleted; the reason then reads "closed on GitHub".
- smithers-3f approves the fact decision and containment proof; smithers-b8 the diff and OK contracts.
