# T-MNT-01 Gate maintainer admission and expose passive incoming items

Stage M · Size S · Depends on T-CAT-01, T-CUT-03, T-APP-04, T-STK-09, T-GH-02, T-GH-09, T-APP-01, T-ACC-02, T-ACC-03, T-ACC-04, T-INS-02, T-FLW-01, T-FLW-03, T-MCH-06, T-MCH-11 · Unblocks T-MNT-02, T-MNT-04 · Issue: [#3593](https://github.com/smithersai/smithers/issues/3593)
Spec: spec.md §5.2, §6.1.2b, §8.3, §10.2.1, §12.4, §16.4, §17.1–§17.5 · Delta: none (maintainer extension) · Product: mvp.md §14, §8, M-05, M-26, M-29; actions.md C.8–C.12; AGENTS.md Superseded 2026-10-01 rulings
Ready: 2026-10-03 smithers-8a sha256:2747b5025504

## Goal

New outsider issues and PRs appear under Incoming. They start no work until an owner or maintainer requests it.

## Scope

In:
- Reuse hidden event admission, dispatch and the GitHub synced store. Incoming is a Home filter over issue/PR identities, not a second queue of TODOs.
- Stage-M catalog entries for issue triage and outside-PR review have minimum role maintainer; delegated requests require the requesting maintainer's own session confirmation.
- Pin subject text digest, issue context or PR base/head, requester, action and flow version at admission. Recheck live role and subject revision when confirming. Reject changed input before admission.
- Launch binaries keep these surfaces hidden and deny direct calls. Stage M enables only this reviewed catalog extension, not every retained action.
- Land dark against the specified contracts for every unlanded dependency in Depends on. Keep M discovery and Incoming disabled until catalog, Home and sync providers are wired; refuse admission before drafting, confirmation or durable request creation when live membership, authorizer, delegated identity, confirmation, subject snapshot or flow-version providers are unavailable. Refuse execution without the microVM-only launcher, machine-only flow runtime, capacity admission and no-sudo user isolation. C-MNT-01 tests each missing provider through production dispatch; C-MNT-06 gates execution. Unlanded dependencies do not block Ready.
- Security preconditions: preserve outsider provenance and the admitted snapshot; repository flow loading, reproduction and PR-head commands run only in machines as an unprivileged user, with no host fallback, teammate tokens, main-only secrets or GitHub write credentials. smithers-3f reviews these preconditions (C-MNT-06, C-SEC-03). This ticket adds or changes no root step and passes no issue text, PR head, branch file, recipe or command to root; root image and broker behavior remains owned by the machine tickets. A required change to that boundary needs an input/source inventory and a named validation test for every branch-sourced input before enabling it.

Out:
- Automatic launches from outsider events, new trigger infrastructure, dispatcher screen, issue-sweep, or changing the launch Make TODO rule.
- Triage, duplicate search and reproduction (T-MNT-02), author reply drafting/publishing (T-MNT-03), and PR-review execution (T-MNT-04). Outside PRs keep their identity; this ticket adds no TODO conversion, stack Merge control or GitHub review write.
- New queues, tables, executors or privileged setup; re-enabling Cut tags or user trigger-management routes; implementing design-owned Views.

## Changes

- Reshape the shared catalog and authorizer supplied by T-CAT-01/T-ACC-03. Reuse `packages/backend/internal/services/repository_job_manual.go:47` (`RunManual`, transactional request identity and dispatch) and the retained event/dispatch store; adapt admission to the maintainer command contract without remounting the removed gateway manual-management route (`packages/backend/internal/compose/router.go:577`). Keep the existing durable request/job store; add no parallel queue or table.
- Deduplicate by subject revision plus action and accepted request identity; duplicate delivery cannot manufacture a new permission. Explicit Retry retains attempt history.
- Extend `packages/rpc/src/HomeCard.ts:52`, `apps/app/src/mainview/cards/HomeContainer.tsx:17` and the Home projection supplied by T-APP-01 for Incoming; reuse the Home container and `cardActions` dispatch seam. smithers-06 owns changes to `apps/app/src/mainview/cards/views/HomeView.tsx:9`; engineering supplies props and action bindings through `onAction(action.tag)` with `data-flow`. Show requested, queued, working, waiting, failed and done from real receipts. Add no separate Incoming container or card system.
- Document the M catalog extension and hidden launch behavior. Will approves command names and any product scope change; smithers-8a accepts admission design decisions; smithers-b8 approves app/CLI/API seams; smithers-38 approves TS public contracts; smithers-3f approves Go/infra and security; smithers-06 approves card controls (C-MNT-01).

## Tests

C-MNT-01 (folded steps and assertions):
1. Deliver outsider issue-open/edit/comment/mention/label and PR-open/push/review events, twice and across a host restart.
2. Query launch palette, help, agent tools, CLI and direct API; query M Incoming and catalog.
3. Request triage/review as each credential and role, including delegated agents. Change role or subject revision between request and confirmation.
4. Confirm one fresh request as its requesting maintainer; duplicate the request and delivery after restart.
5. Exercise Make TODO and todo-label doors for team and outsider text with the C-SEC-03 matrix.

Pass when:
- Step 1 adds only synced input/activity and cursor receipts; zero new jobs, proposals, run credentials, machine requests or TODOs. Non-member todo labels are reverted once.
- Launch surfaces hide M commands and direct calls refuse them. M Incoming lists the original identities without launching work.
- Only owner/maintainer sessions or their own confirmed delegated requests admit work; wrong confirmer, suspended actor or stale subject admits zero.
- Step 4 creates exactly one durable run request with pinned subject/action/actor/version; 202 is requested, not completion.
- Step 5 preserves §10.2.1 and C-SEC-03, including refusal before a Member's outsider draft and exact label snapshots.

Fail when:
- Any event bypasses manual admission, any Member admits outsider work, or catalog hiding alone is treated as authorization.


- Unit: permission matrix and revision digest boundaries.
- Integration: C-MNT-01 through production install catalog dispatch and HTTP middleware, real poll consumption and PostgreSQL durable admission; browser-session and delegated CLI/API requests enter the same production command boundary. Exercise production confirmation create/approve routes, Home snapshot/subscription and the retained event consumer across restart. Do not call RunManual or the authorizer directly as acceptance proof, and do not remount user trigger-management routes. Pin literal role/credential cases, subject revisions, command ids, response states and database counter deltas in reviewed fixtures; never derive expected results from spec files, catalog descriptors, served routes or implementation code at runtime. Missing-provider cases assert hidden discovery and zero drafts, confirmations, requests, credentials or execution.
- E2E security: C-MNT-06. No launch gate moves to M.

## Acceptance

- [C-MNT-01](../checks/C-MNT-01.md) passes with retained evidence.
- C-MNT-06 passes for every executable path this ticket exposes. C-SEC-03 remains a launch prerequisite, not work deferred to M.
- Owner pre-review: the owners and questions in the Ready checklist cover every touched seam. Recorded owner answers stand; under Will's parallel-build directive, owners review post hoc and their pending answers do not block Ready.
- Preserve existing storage ownership; add no new table. If implementation requires one, record one owner in its `ownership.csv` row as `planned:T-MNT-01` before Ready (C-PRC-02). Landing runs §21.2's five-target drift set (C-PRC-01); closure requires machine-written receipts bound to the landed commit with verified log digests (C-PRC-03).

## Risks and notes

Who decides: Will owns release scope; smithers-8a owns admission mechanics; an owner or maintainer decides each outsider admission. No model decides trust. Passive sync is not a run. Checks C-MNT-01 and C-MNT-06 prove this boundary.

## Ready checklist
1. Dependencies: the header names live roster, authorization, delegation, private confirmation, launch trust/sync, Home, pinned flow versions, microVM execution, capacity admission and no-sudo isolation. Scope defines fail-closed dark landing for every unavailable dependency (C-MNT-01, C-MNT-06).
2. Exclusions: no automatic admission, triage/reproduction, author publishing, PR-review implementation, TODO conversion, stack Merge, new queue/table/executor, root change, trigger-management door, Cut-tag restoration or engineering-owned View implementation.
3. Tests: C-MNT-01 enters production command/HTTP, confirmation, poll and Home boundaries with real durable storage and literal fixtures; C-MNT-06 audits executable paths. Expectations never come from spec or implementation at runtime; missing providers admit zero effects.
4. Decisions: Will approves scope and command names; smithers-8a accepts admission mechanics; smithers-b8 approves app/CLI/API seams; smithers-38 approves TS public contracts; smithers-3f approves Go/infra/security; smithers-06 approves visual controls. A live owner or maintainer alone decides each outsider admission.
5. Owner pre-review questions (recorded answers stand; reviews post hoc under Will's directive): smithers-06: Does Incoming fit the Home filter without adding a new card? Do controls preserve approved copy and action routing? smithers-b8: Do app, CLI and API use one admission/confirmation boundary? Are launch and missing-provider doors closed? smithers-3f: Does transactional reuse preserve pinned authority and idempotency? Do all executable paths retain machine-only, no-sudo confinement without branch inputs reaching root? smithers-38: Does the Home subpath contract reuse existing schemas and action bindings? Do literal fixtures cover unavailable providers without runtime-derived expectations?
6. Security: smithers-3f reviews live role/subject rechecks, outsider snapshots, machine-only execution, no-sudo isolation and credential/egress limits (C-SEC-03, C-MNT-06). No root step is added or changed and no branch/outsider input is sent to root; any required root change blocks enablement until its complete input/source inventory and named branch-input validation test are recorded.
