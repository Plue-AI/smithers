# T-STK-15 Amend a TODO through the durable steer path

Stage S1 · Size M · Depends on T-STK-02, T-STK-06 · Unblocks — · Issue: to file
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

## Changes
- Extend the existing placement service and routes; append one attributed revision and event with committed projections, allocate no TODO number and create no branch or PR.
- Call T-STK-06 with the same idempotency key. Use its durable holding and delivery, including resume and in-review re-entry. Refuse `409 merging` through T-STK-12's shared fence (C-STK-07).
- Add PATCH OpenAPI, regenerate the client and update TODO docs and the real catalog command; add no alternate writer or signal queue.

## Tests
- `todo_place_db_test.go`, real PostgreSQL and production dispatcher: queued Amend creates revision 2; working Amend reaches the live run once; in-review Amend re-enters working. Replay allocates no number and sends no second signal (C-J7-01).
- C-ACC-01 tests delegated confirmation and session commit; C-STK-07 tests fenced Amend refusal with no revision write.

## Acceptance
- C-J7-01 Amend assertions pass: +1, no new TODO, branch or PR, and one attributed steer on the same run.
- C-ACC-01 and C-STK-07 pass for the Amend command.

## Risks and notes
- smithers-3f pre-reviews transaction and fence ownership; smithers-b8 pre-reviews catalog/API seams. smithers-8a accepts those seams. UI files remain with their current owners.
