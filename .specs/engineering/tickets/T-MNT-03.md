# T-MNT-03 Approve exact author replies before publishing

Stage M · Size S · Depends on T-MNT-02, T-APP-04, T-GH-09, T-UI-05, T-ACC-02, T-ACC-04, T-CAT-01, T-FLW-01, T-SEC-01 · Unblocks T-MNT-05 · Issue: [#3595](https://github.com/smithersai/smithers/issues/3595)
Spec: spec.md §5.2, §6.1.2b, §8.3, §10.2.1, §12.4, §16.4, §17.1–§17.5 · Delta: none (maintainer extension) · Product: mvp.md §14, §8, M-05, M-26, M-29; actions.md C.8–C.12; AGENTS.md Superseded 2026-10-01 rulings

## Goal

The Issue card holds an editable draft reply. A maintainer approves its exact text before Smithers posts it once.

## Scope

In:
- Reuse flows/repository/replies.ts and retained approvals. Store target issue/PR identity, evidence revision, draft revision and text digest with approval.
- The requesting owner or maintainer edits and approves in their session. A delegated agent can request confirmation but cannot approve.
- A changed draft, changed source evidence or changed subject revision invalidates approval. A refusal or timeout keeps the draft with an honest receipt.
- Outsider replies enter passive incoming context; no await-author/continue-author action resumes credentialed work without another maintainer admission.
- Build against the specified contracts and land dark for every unlanded dependency above. Keep reply controls hidden and refuse drafting, confirmation and publication when admission, current credential/role checks, catalog dispatch, retained flow runtime, machine confinement, Confirm binding or canonical App reconciliation is unavailable. Never fall back to automatic replies, host execution or the legacy Cloud adapter. C-MNT-03 tests each missing provider; C-MNT-06 tests confinement.
- T-MNT-02 supplies admitted evidence, pinned flow execution and capacity/no-sudo machine prerequisites through T-MNT-01, T-FLW-03, T-MCH-06 and T-MCH-11. T-ACC-02/T-ACC-04 supply current-role/session and delegated guards; T-CAT-01 supplies dispatch; T-FLW-01 supplies machine-only runtime composition; T-SEC-01 supplies guest root validation. These prerequisites gate enablement, not Ready.

Out:
- Autonomous replies, review-thread conversations, auto-labels, closing issues, and automatic work resumed by an author's comment.
- New outbound queues, approval tables, reproduction executors, machine provisioning or root helpers; token delivery to machines; generic comment-composer replacement; upgrade implementation (T-MNT-05).

## Changes

- Reshape `flows/repository/replies.ts:108,137,152` (ConfirmReply, PublishReply and the automatic branch): require session authorization and digest-bound approval on every publication. Reuse `packages/backend/internal/services/approvals.go:290` and `packages/backend/db/product/queries/approvals.sql:42` for the retained decision CAS, and the decision route in `packages/backend/internal/routes/approvals.go:119`. No Boolean human-task answer alone authorizes a write.
- Reuse `apps/app/src/mainview/cards/IssueCards.tsx:246` for the Issue draft binding and `apps/app/src/mainview/cards/views/ConfirmView.tsx:14` for confirmation. Engineering owns contracts/containers and `cardActions` → `flowAction`; smithers-06 owns View changes. Handlers use `onAction(action.tag)` and `data-flow` (§14.2.1).
- Reshape the retained reply adapter in `flows/repository/replies.ts:68` and keyed comment code in `packages/backend/internal/services/mythical_github.go:438,452,484` for canonical App identity and a persisted GitHub comment receipt. The current adapter uses Cloud receipts; the current lookup accepts any App bot. Neither is sufficient. Publish the approved reply bytes with the deterministic App marker and attribution shown in the confirmation; store the wire-body digest. Recheck the requesting person’s live authority and bound target/draft/evidence/subject before send. After a lost response, lookup the marker and verify canonical App identity, target and wire-body digest before retry; a conflicting body refuses. No outbound queue or machine-held GitHub token (C-MNT-03).
- A lost HTTP response leaves publication pending reconciliation, never safe to blindly post again. Preserve the returned GitHub comment identity and authorship receipt (C-MNT-03).

## Tests

C-MNT-03 (folded steps and assertions):
- Drive the registered Issue reply actions through production catalog dispatch, `repository/ConfirmReply`, the HTTP approval decision route, and `repository/PublishReply` through the host App publisher. Use real PostgreSQL and a GitHub protocol server that commits then drops its response; do not call a service directly as acceptance evidence. Exercise the Issue/Confirm controls through their production handlers.
- Pin literal draft bytes, target IDs, actor/credential fixtures, role changes, marker attribution and expected wire bytes in tests. Compute test digests independently from those fixtures. Never read spec files or derive expected policy, bytes or digests from production functions at runtime.
- Disable each dependency provider named in Scope: zero drafts, approvals, machine requests and outbound writes. Force legacy `replies=automatic`, direct publish and human-task true without a session receipt: zero writes. Present the same marker from a member and another App, and a canonical-App comment with different bytes: none satisfies reconciliation.
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
- Owner pre-review: smithers-06 reviews UI and copy, smithers-b8 app flows and containers, smithers-3f Go services and infrastructure, smithers-38 package contracts and runtime composition. The Ready checklist records their concrete pre-review questions. Under the parallel-build directive, existing recorded owner answers stand and owners review post hoc; record untouched boundaries as such.

## Risks and notes

Who decides: the requesting owner or maintainer approves the actual reply and displayed attribution. Models draft; the host publisher checks the receipt. smithers-3f accepts authorization, App reconciliation and security seams; smithers-38 accepts approval contracts and runtime composition; smithers-b8 accepts command/API and container bindings; smithers-06 accepts View and confirmation copy. No new ADR is in scope. Check C-MNT-03 rejects forged and stale approvals.

Security: repository flows and repository code execute only as an unprivileged user inside machines, never in the host process (§17.3, M-29). Host publication consumes typed data and a verified person receipt; App credentials stay on the host. Outsider content stays quoted passive data. smithers-3f reviews these preconditions; C-MNT-06 and launch C-SEC-03 prove them. This ticket adds no root step and sends no draft, evidence or author text to root. Inherited guest startup/exec uses T-SEC-01’s R1–R3 input inventory: main/bundle helper, digest, install script and constants; install-controlled runtime/image/interpreter/account/kernel/cgroup/relay state; branch/member-derived snapshot, env.json, cache/home metadata, request argv/env/cwd/file bytes and symlinks. Its named C-SEC-02 tests (`TestGuestHelperInstallPinsInterpreterAndEnv`, `TestRootSetupNeverFollowsMemberSymlinks`, `TestRootPreflightParsesOnlyEnvelope`) must validate those inputs before root use and apply execution payloads only after UID/GID/group drop. Branch-built root code is forbidden; any additional branch-sourced root input blocks enablement until smithers-3f names and accepts its validation test. The inherited S2 broker/no-sudo boundary remains T-MCH-11’s contract, proved by C-MNT-06.

## Ready checklist

1. Dependencies: the header names retained evidence, Confirm UI, App recovery, current-role/credential authorization, catalog dispatch, machine-only runtime and root validation; Scope names inherited machine prerequisites and fails closed for every unavailable dependency.
2. Exclusions: Scope explicitly excludes autonomous/author-resumed work, review threads, labels/closure, parallel queues/tables/executors, root helpers, machine tokens, generic composer replacement and upgrade implementation.
3. Tests: C-MNT-03 enters production catalog, flow, HTTP decision, UI-handler and host-publisher boundaries with literal independent fixtures; C-MNT-06 proves machine confinement and C-MNT-05 verifies real GitHub bytes.
4. Decisions: the requesting owner/maintainer approves reply bytes and attribution; smithers-3f accepts security/reconciliation, smithers-38 contracts/runtime, smithers-b8 API/container bindings and smithers-06 Views/copy.
5. Owner pre-review questions (owners review post hoc under the parallel-build directive; existing recorded answers stand): smithers-06: Does confirmation show the exact reply and attribution? Are stale/timeout drafts visible? smithers-b8: Do Issue controls enter catalog dispatch? Can a direct publication or legacy automatic branch bypass the receipt? smithers-3f: Does reconciliation verify canonical App identity and wire bytes? Do live authority and guest input validation fail closed? smithers-38: Does the retained approval bind target/draft/evidence/subject and digest? Does replay preserve one publication identity? Record untouched boundaries as such.
6. Security: smithers-3f owns machine-only unprivileged execution, host-only App credentials, passive outsider inputs and the inherited root input inventory/validation tests; C-SEC-03, C-SEC-02 and C-MNT-06 gate enablement. No new root step or branch-built root code is in scope.
