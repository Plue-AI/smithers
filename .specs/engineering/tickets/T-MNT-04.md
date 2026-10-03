# T-MNT-04 Review outside PRs with the shared review step

Stage M · Size M · Depends on T-MNT-01, T-FLW-01, T-FLW-04, T-MCH-06, T-UI-19, T-APP-19 · Unblocks T-MNT-05 · Issue: [#3596](https://github.com/smithersai/smithers/issues/3596)
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

- Unit: findings revision and role checks.
- E2E: C-MNT-04 against a real fork PR, including changed head, machine contention, failure and explicit commit-work conversion.
- E2E: C-MNT-06 verifies malicious PR code stays confined.

## Acceptance

- [C-MNT-04](../checks/C-MNT-04.md) passes with retained evidence.
- C-MNT-06 passes for every executable path this ticket exposes. C-SEC-03 remains a launch prerequisite, not work deferred to M.
- Owner pre-review: smithers-06 reviews UI and copy, smithers-b8 app flows and containers, smithers-3f Go services and infrastructure, smithers-38 package contracts and runtime composition. Each signs off the touched boundary before implementation; an untouched boundary is recorded as such.

## Risks and notes

Who decides: the maintainer requests review, interprets findings and separately commits any work. The shared reviewer advises and never approves or merges. 38 pre-reviews the shared module identity; 3f checks untrusted checkout confinement. C-MNT-04 proves this is correctness review rather than legacy readiness triage.
