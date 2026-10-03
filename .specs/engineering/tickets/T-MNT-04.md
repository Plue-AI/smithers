# T-MNT-04 Review outside PRs with the shared review step

Stage M · Size M · Depends on T-MNT-01, T-FLW-01, T-FLW-04, T-MCH-06, T-UI-19 · Unblocks T-MNT-05 · Issue: [#3596](https://github.com/smithersai/smithers/issues/3596)
Spec: spec.md §5.2, §6.1.2b, §8.3, §10.2.1, §12.4, §16.4, §17.1–§17.5 · Delta: none (maintainer extension) · Product: mvp.md §14, §8, M-05, M-26, M-29; actions.md C.8–C.12; AGENTS.md Superseded 2026-10-01 rulings

## Goal

A maintainer can review an outsider PR and see revision-bound findings on its own review card without creating a stack item.

## Scope

In:
- Extend /review admission to outside PRs only after a maintainer action. Reuse the exact review step/module used by the TODO flow, its findings schema, pinning and monitor.
- Capture PR number, contributor identity, base/head SHAs and diff. Run review in an ephemeral background machine with no host execution of contributor code.
- Read-only review is the default. Any required PR-head execution remains inside the isolated machine with no personal logins, repository secrets or GitHub write token.
- Review card shows findings and GitHub links. New pushes make findings stale and require a new maintainer request. No automatic review, steer, approval or merge follows.
- A separate maintainer action can commit work as a TODO through existing stack primitives; preserve the source PR link and identity, never silently convert the outsider PR.

Out:
- A second review engine, quizzes, in-app line comments, automated GitHub reviews, review-thread replies, stack Merge on outside PR cards or new landing machinery.

## Changes

- Replace intake-only pr-triage readiness scoring in this path with the shared TODO review step. Keep no parallel correctness reviewer.
- Route /review through the stage-M catalog gate, existing background machine admission and revision-bound evidence store.
- Add the Outside PR review view and container at the existing card seam. Keep Review & merge confined to TODO PRs. Stop/retry and restart recover through the shared run lifecycle (C-MNT-04).
- Define the separate commit-work action using existing TODO placement and person confirmation; admission is maintainer-only and does not rewrite the contributor's PR.

## Tests

C-MNT-04 (folded steps and assertions):
1. Open the outside PR card, request /review as Member and as a maintainer agent without confirmation.
2. Confirm as the requesting maintainer; release capacity and run the shared reviewer on the pinned base/head diff.
3. Push a new head during review; reload and explicitly request review again. Restart during the new run, then exercise failure and explicit Retry.
4. Inspect app, CLI/API projections and GitHub for writes or stack changes.
5. Separately request commit-work as Member, delegated maintainer and confirmed maintainer. Inspect resulting TODO and original PR.

Pass when:
- Unauthorized/unconfirmed calls create zero runs. Accepted review queues within existing capacity.
- TODO and outside review execute the same review module and findings contract, not pr-triage readiness scoring; the seeded defect has a supported finding or the quality gate fails.
- Findings bind to base/head; old findings show stale after push, never silently rebind. Only the fresh request launches again. Restart/retry retain attempts and honest errors.
- Review alone creates zero TODOs, stack items, approvals, merges or GitHub comments/reviews. The card keeps PR number/contributor and GitHub links with no stack Merge control.
- Only the separate confirmed maintainer action creates one normal TODO linked to the source PR; the contributor PR is neither rewritten nor adopted as its stack PR.

Fail when:
- A readiness report substitutes for review, a push launches review automatically, stale findings appear current, or review creates stack work.


- Unit: findings revision and role checks.
- E2E: C-MNT-04 against a real fork PR, including changed head, machine contention, failure and explicit commit-work conversion.
- E2E: C-MNT-06 verifies malicious PR code stays confined.

## Acceptance

- [C-MNT-04](../checks/C-MNT-04.md) passes with retained evidence.
- C-MNT-06 passes for every executable path this ticket exposes. C-SEC-03 remains a launch prerequisite, not work deferred to M.
- Owner pre-review: smithers-06 reviews UI and copy, smithers-b8 app flows and containers, smithers-3f Go services and infrastructure, smithers-38 package contracts and runtime composition. Each signs off the touched boundary before implementation; an untouched boundary is recorded as such.

## Risks and notes

Who decides: the maintainer requests review, interprets findings and separately commits any work. The shared reviewer advises and never approves or merges. 38 pre-reviews the shared module identity; 3f checks untrusted checkout confinement. C-MNT-04 proves this is correctness review rather than legacy readiness triage.
