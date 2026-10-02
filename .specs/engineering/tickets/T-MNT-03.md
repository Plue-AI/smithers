# T-MNT-03 Approve exact author replies before publishing

Stage M · Size S · Depends on T-MNT-02, T-ACC-05, T-GH-09, T-UI-05, T-APP-04 · Unblocks T-MNT-05 · Issue: to file
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
- Publish through the existing keyed outbound_writes transaction and reconcile-before-retry protocol. The host writes approved text via the install App; no GitHub write token enters a machine.
- A lost HTTP response leaves publication pending reconciliation, never safe to blindly post again. Preserve the returned GitHub comment identity and authorship receipt (C-MNT-03).

## Tests

- Unit: changed draft/evidence invalidates the approval; authorization covers every credential kind.
- Integration/fault injection: C-MNT-03 exercises the publisher through real PostgreSQL and a protocol server that commits then drops the response.
- E2E: C-MNT-05 verifies the approved bytes on real GitHub.

## Acceptance

- [C-MNT-03](../checks/C-MNT-03.md) passes with retained evidence.
- C-MNT-06 passes for every executable path this ticket exposes. C-SEC-03 remains a launch prerequisite, not work deferred to M.
- Owner pre-review: smithers-06 reviews UI and copy, smithers-b8 app flows and containers, smithers-3f Go services and infrastructure, smithers-38 package contracts and runtime composition. Each signs off the touched boundary before implementation; an untouched boundary is recorded as such.

## Risks and notes

Who decides: the requesting maintainer approves the actual reply. Models draft; the host publisher checks the receipt. smithers-3f reviews reconciliation, 38 runtime approval composition, b8 container binding and 06 draft/confirmation copy. Check C-MNT-03 rejects forged and stale approvals.
