# T-STK-15 Amend a TODO through the durable steer path

Stage S1 · Size M · Depends on T-STK-02, T-STK-06, T-STK-12, T-ACC-05, T-STK-05 · Unblocks T-APP-02, T-GH-03, T-REL-02 · Issue: [#3536](https://github.com/smithersai/smithers/issues/3536)
Spec: spec.md §3, §10.2.2, §10.4.2, §10.7.3, §15.1.5 · Delta: delta.md §6 · Product: mvp.md §4.2, J7.1, Appendix B.2

## Goal
Amend Tn with no new TODO and deliver its revision through the existing steer path.

## Scope
In:
- Move `place: amend Tn`, `PATCH /api/todos/{n}`, prompt/acceptance revisions and `/todo.amend` from T-STK-02.
- Amend → append `todo_revisions(rev+1, reason='amend', author_actor)`; no `todos` row and no number is allocated (§10.2.2). An amend of a queued TODO is revision 2, and the run reads every revision (§10.4.2). The new revision goes to the run as a steer through T-STK-06, under §10.7.3's rules: held while queued, delivered on resume, and `in_review → working`.
- `/todo.amend` is `confirm`; agents post a person confirmation (C-ACC-01).

Out:
- Append, Before, Move, Remove and stack admission remain in T-STK-02.
- Signal transport and fence primitives remain in T-STK-06 and T-STK-12.
- New signal queues, direct runtime calls, independent retry/reopen launchers, editing old revisions, issue edits and comments as amendments, flow activation and Draft/TODO View changes.

## Changes
- Extend T-STK-02's planned `packages/backend/internal/services/todo_place.go` and `packages/backend/internal/routes/todos.go`; append one attributed revision and event with committed projections, allocate no TODO number and create no branch or PR. These TODO paths are new in the prerequisite, not present in today's code.
- Call T-STK-06 with the same idempotency key. Commit the revision, event, activity and durable delivery intent atomically before sending. Use its holding and delivery, including resume and in-review re-entry. A reopened in-review TODO with no live run uses T-STK-05's new-attempt path (§10.7.4), never a second launcher. Refuse `409 merging` through T-STK-12's shared fence before any revision or delivery intent is written (C-STK-07).
- Add PATCH to planned `docs/api/openapi/todos.yaml`, regenerate `packages/smithers/src/internal/backend/ProductApi.ts`, update planned `packages/backend/docs/todos.md` and the real catalog command; add no alternate writer or signal queue.

## Tests
- `todo_place_db_test.go`, real PostgreSQL and production dispatcher: queued Amend creates revision 2; working Amend reaches the live run once; in-review Amend re-enters working. Replay allocates no number and sends no second signal (C-J7-01).
- C-ACC-01 tests delegated confirmation and session commit; C-STK-07 tests fenced Amend refusal with no revision write.

## Acceptance


- C-J7-01 Amend assertions pass: +1, no new TODO, branch or PR, and one attributed steer on the same run.
- C-ACC-01 and C-STK-07 pass for the Amend command.

## Risks and notes
- smithers-3f pre-reviews transaction and fence ownership; smithers-b8 pre-reviews catalog/API seams. smithers-8a accepts those seams. UI files remain with their current owners.

## Ready checklist
1. Dependencies: T-STK-02 supplies the placement transaction, T-STK-06 durable steering, T-STK-12 the shared merge fence, T-ACC-05 the authorized person confirmation and T-STK-05 the reopened-item new attempt. Added edges are S1 and acyclic in the current index; run/machine launch comes through these prerequisites.
2. Exclusions: Scope names independent signal queues and launchers, changing old revisions, issue-edit amendments, flow activation and visual components, in addition to placement and transport owned elsewhere.
3. Boundary tests: `packages/backend/internal/services/todo_place_db_test.go` drives PATCH /api/todos/{n}, the production catalog dispatcher for /todo.amend, and POST /api/confirmations/{id}/approve through the production router with real PostgreSQL and the machine-host signal receiver. Checked-in literal inputs and expected rows prove queued/paused holding, delivery on attachment/resume, working and in-review delivery once, reopened in-review new attempt, idempotent replay and fenced refusal. Delegated requests write no revision until the requesting person's session approves; wrong-person approval and stale-revision confirmation write none. Crash after the transaction but before delivery preserves one revision and delivers once on recovery. No runtime spec, catalog or implementation-derived expectation is used. C-J7-01's app test uses /todo.amend and Commit; C-ACC-01 and C-STK-07 cover authorization and fence refusal at the same boundaries.
4. Decisions: smithers-3f accepts revision/event/delivery transaction and fence ownership; smithers-b8 approves the catalog and public PATCH/confirmation contract; smithers-38 approves generated TypeScript client compatibility; smithers-8a accepts those seams and any scope change. Amend remains confirm, not a new policy choice.
5. Owner pre-review before start: smithers-3f: Can a crash or replay create a revision without durable delivery or duplicate either? Does the shared fence refuse before every write? smithers-b8: Do both Amend doors enforce the same revision-bound requester confirmation? smithers-38: Does regenerated ProductApi preserve the PATCH and 202 confirmation contracts? View changes remain with smithers-06 and outside this ticket. smithers-3f: answered 18:2x, ok. smithers-b8: answered 18:23, ok.
6. Security: smithers-3f reviews authorization, durable delivery and the inherited machine launcher before start. An amendment is data, not host-executable code; any resulting repository flow, coding-agent turn or check executes only in an isolated branch machine (M-29, §1.3), with no host fallback. T-INS-02 through the run prerequisites supplies isolation refusal; C-ACC-01 tests run/machine credential refusal and person confirmation, and C-STK-07 tests the fence.
