# T-MNT-03 Approve exact author replies before publishing

Stage M · Size S · Depends on T-MNT-02, T-APP-04, T-GH-09, T-UI-05 · Unblocks T-MNT-05 · Issue: [#3595](https://github.com/smithersai/smithers/issues/3595)
Spec: spec.md §5.2, §6.1.2b, §8.3, §10.2.1, §12.4, §16.4, §17.1–§17.5 · Delta: none (maintainer extension) · Product: mvp.md §14, §8, M-05, M-26, M-29; actions.md C.8–C.12; AGENTS.md Superseded 2026-10-01 rulings

## Goal

The Issue card holds an editable draft reply. A maintainer approves its exact text before Smithers posts it once.

## Scope

In:
- Reuse flows/repository/replies.ts and retained approvals. Store target issue/PR identity, evidence revision, draft revision and text digest with approval.
- The requesting owner or maintainer edits and approves in their session. A delegated agent can request confirmation but cannot approve.
- A changed draft, changed source evidence or changed subject revision invalidates approval. A refusal or timeout keeps the draft with an honest receipt.
- Outsider replies enter passive incoming context; no await-author/continue-author action resumes credentialed work without another maintainer admission.

Out:
- Autonomous replies, review-thread conversations, auto-labels, closing issues, and automatic work resumed by an author's comment.

## Changes

- Adapt ConfirmReply and PublishReply to session authorization and digest-bound approval, using the shared Confirm card and Issue draft section.
- Publish exact approved bytes through the retained reply publisher and canonical App comment marker. After a lost response, lookup that marker before retry and retain the approval’s GitHub identity receipt. No outbound queue or machine-held GitHub token.
- A lost HTTP response leaves publication pending reconciliation, never safe to blindly post again. Preserve the returned GitHub comment identity and authorship receipt (C-MNT-03).

## Tests

C-MNT-03 (folded steps and assertions):
1. Draft without approving; attempt publication as an agent, Member and forged confirmation.
2. Reject or time out; edit the draft and change subject/evidence after approval; retry each stale publish.
3. Approve fresh exact text from the requesting maintainer session, then revoke their role before dispatch.
4. Approve again with live authority and publish; drop the response after commit, restart, reconcile and retry twice.
5. Deliver an outsider reply and edits to it while the run is waiting for the author.

Pass when:
- Steps 1–3 publish zero comments. Denied/timeout drafts persist; stale approval requires a new decision. No event text can satisfy approval.
- Step 4 publishes exactly one comment with approved bytes and target. Approval digest, keyed write and returned GitHub identity persist; retry reconciles the existing comment before another attempt.
- Step 5 updates passive context only; zero new credentialed work or resumed steps until a fresh maintainer admission.

Fail when:
- Changed text publishes under an old approval, publication duplicates after a lost response, or author content resumes a run.


- Unit: changed draft/evidence invalidates the approval; authorization covers every credential kind.
- Integration/fault injection: C-MNT-03 exercises the publisher through real PostgreSQL and a protocol server that commits then drops the response.
- E2E: C-MNT-05 verifies the approved bytes on real GitHub.

## Acceptance

- [C-MNT-03](../checks/C-MNT-03.md) passes with retained evidence.
- C-MNT-06 passes for every executable path this ticket exposes. C-SEC-03 remains a launch prerequisite, not work deferred to M.
- Owner pre-review: smithers-06 reviews UI and copy, smithers-b8 app flows and containers, smithers-3f Go services and infrastructure, smithers-38 package contracts and runtime composition. Each signs off the touched boundary before implementation; an untouched boundary is recorded as such.

## Risks and notes

Who decides: the requesting maintainer approves the actual reply. Models draft; the host publisher checks the receipt. smithers-3f reviews reconciliation, 38 runtime approval composition, b8 container binding and 06 draft/confirmation copy. Check C-MNT-03 rejects forged and stale approvals.
