# C-MNT-04 Outside PR findings reuse TODO review and keep PR identity

Proves: mvp.md §14, M-05, M-26, M-29 · spec.md §6.1.2b, §10.2.1, §12.4, §16.4, §17.3, §17.5 · Layer: e2e · Stage: M · Tickets: T-MNT-04
Automation: unavailable (owner-approved executable mapping pending; C-PRC-03) · Runs in: reference Apple Silicon host, real install and microVMs, second-laptop browser, scratch GitHub repository

## Setup

A real fork PR with a seeded correctness defect that passes the legacy readiness rubric; a TODO candidate with the same diff. Record the shared review module/version used by both. Full machine capacity at request time.

Candidate Automation declaration (unapproved): apps/app/e2e/real/maintainer-outside-review.spec.ts (new) · Runs in: reference Apple Silicon host, real install and microVMs, second-laptop browser, scratch GitHub repository

Owner action before PRC-03 activation: supply an explicit approved executable command and its declared Runs in host. Do not infer a command from a path or prose. Until that mapping is approved and available, the runner refuses this check and ticket closure remains blocked. Check: C-PRC-03.

## Steps

1. Open the outside PR card, request /review as Member and as a maintainer agent without confirmation.
2. Confirm as the requesting maintainer; release capacity and run the shared reviewer on the pinned base/head diff.
3. Push a new head during review; reload and explicitly request review again. Restart during the new run, then exercise failure and explicit Retry.
4. Inspect app, CLI/API projections and GitHub for writes or stack changes.
5. Separately request commit-work as Member, delegated maintainer and confirmed maintainer. Inspect resulting TODO and original PR.

## Pass when

- Unauthorized/unconfirmed calls create zero runs. Accepted review queues within existing capacity.
- TODO and outside review execute the same review module and findings contract, not pr-triage readiness scoring; the seeded defect has a supported finding or the quality gate fails.
- Findings bind to base/head; old findings show stale after push, never silently rebind. Only the fresh request launches again. Restart/retry retain attempts and honest errors.
- Review alone creates zero TODOs, stack items, approvals, merges or GitHub comments/reviews. The card keeps PR number/contributor and GitHub links with no stack Merge control.
- Only the separate confirmed maintainer action creates one normal TODO linked to the source PR; the contributor PR is neither rewritten nor adopted as its stack PR.

## Fail when

- A readiness report substitutes for review, a push launches review automatically, stale findings appear current, or review creates stack work.

## Evidence

`.artifacts/checks/C-MNT-04/<UTC>/`: exact commit and install versions, detected host profile when machines run, per-step requests and receipts, database counter deltas, recorded inputs and output digests, logs and browser recordings where applicable. Redact credentials; retain denial and recovery receipts. An unexecuted check is pending.
