# C-MNT-03 Only exact session-approved replies publish once

Proves: mvp.md §14, M-05, M-26, M-29 · spec.md §6.1.2b, §10.2.1, §12.4, §16.4, §17.3, §17.5 · Layer: integration · Stage: M · Tickets: T-MNT-03
Automation: unavailable (owner-approved executable mapping pending; C-PRC-03) · Runs in: real PostgreSQL, catalog dispatch and durable flow runtime; local GitHub protocol server for repeatable delivery and fault injection

## Setup

Real durable approvals and outbound_writes stores; GitHub protocol server accepts comments, records bodies and can drop the response after committing. Draft with evidence and subject digests; maintainer, Member and delegated credentials.

Candidate Automation declaration (unapproved): packages/backend/internal/services/maintainer_reply_db_test.go (new) · Runs in: real PostgreSQL, catalog dispatch and durable flow runtime; local GitHub protocol server for repeatable delivery and fault injection

Owner action before PRC-03 activation: supply an explicit approved executable command and its declared Runs in host. Do not infer a command from a path or prose. Until that mapping is approved and available, the runner refuses this check and ticket closure remains blocked. Check: C-PRC-03.

## Steps

1. Draft without approving; attempt publication as an agent, Member and forged confirmation.
2. Reject or time out; edit the draft and change subject/evidence after approval; retry each stale publish.
3. Approve fresh exact text from the requesting maintainer session, then revoke their role before dispatch.
4. Approve again with live authority and publish; drop the response after commit, restart, reconcile and retry twice.
5. Deliver an outsider reply and edits to it while the run is waiting for the author.

## Pass when

- Steps 1–3 publish zero comments. Denied/timeout drafts persist; stale approval requires a new decision. No event text can satisfy approval.
- Step 4 publishes exactly one comment with approved bytes and target. Approval digest, keyed write and returned GitHub identity persist; retry reconciles the existing comment before another attempt.
- Step 5 updates passive context only; zero new credentialed work or resumed steps until a fresh maintainer admission.

## Fail when

- Changed text publishes under an old approval, publication duplicates after a lost response, or author content resumes a run.

## Evidence

`.artifacts/checks/C-MNT-03/<UTC>/`: exact commit and install versions, detected host profile when machines run, per-step requests and receipts, database counter deltas, recorded inputs and output digests, logs and browser recordings where applicable. Redact credentials; retain denial and recovery receipts. An unexecuted check is pending.
