# T-STK-07 Needs you: independent waits, precedence, first answer wins, `ask` bound for implementing seats

Stage S1 · Size M · Depends on T-STK-01 · Unblocks T-COL-05, T-FLW-11, T-GH-05, T-GH-06, T-GH-07, T-REL-02, T-STK-04, T-STK-08 · Issue: [#3451](https://github.com/smithersai/smithers/issues/3451)
Spec: spec.md §4.1 (`working ↔ needs_you`, `in_review ↔ needs_you`), §4.1.0a, §4.1.2a, §5.2, §10.7.2a, §10.8, §10.8.0, §11.6.1, §14.4, §14.5.2 · Delta: delta.md §6 (Add Needs-you kinds and first-answer-wins answers) · Product: mvp.md §4.1 Needs you, J2.4, J3.6, J4.2, J6.3, M-14, §11 stage 1 item 4, Appendix B.3 (`ask`)

## Goal
When the coding agent asks a question, mid-implementation or at a flow step, when the planner declines with questions, or when a flow step needs a person's approval, the TODO shows Needs you. The first committed answer settles the wait, and every later answer gets `409 {answered_by}`.

## Scope
In:
- `todo_waits` (§10.8.0): one durable row per wait, with the TODO kinds of §10.8.1 (`question`, `approval`, `conflict`, `moved_off`, `foreign_push`), each a run wait or a branch wait. Waits are independent; run waits expire when their run ends; merge and drop close all. `todos.needs_you` holds the primary wait (§4.1.0a) for reads.
- The stack-level kinds `order` and `force_push` live in `stack_attention` (§4.1.2a), never on a TODO. This ticket provides the open and settle API for them; T-GH-05 and T-GH-07 raise them.
- Derived state (§4.1.0a): needs_you while any wait is open, ranked above paused and failed; the primary wait by kind order, then age; settling the last open wait recomputes the state (working, in_review, queued, paused or failed), and settling any other keeps needs_you.
- Bind the `ask` tool for the implementing seats `coding/edit-atom` and `coding/dispatch-turn` (§10.7.2a). It raises `needs_you{question}` as a durable wait, and the agent continues with the first answer as the tool result.
- Planner decline with questions (§10.8.1a): a feature TODO the planner would decline with questions raises `needs_you{question}` carrying those questions and waits. The first answer goes back to the planner, and the same run continues. A decline without questions (the `close` route: already done, duplicate, invalid) still ends the item, which §4.1.0 projects to `dropped`.
- `POST /api/todos/{n} {answer: {wait_id, text | decision}}` and `/todo.answer Tn` (`agent: run`, §15.1.5). The first commit wins; later answers get `409 {answered_by}`, and the late text stays in the submitter's draft with **Send as steer** (§10.8.2).
- Approvals keep `approval.approve` and `approval.deny` on the same first-answer path. They are person-only and `agent: never`: approvals that gate a merge have no agent path (§15.1.5, Appendix B.2).
- A generic `RaiseNeedsYou(kind, payload)` for the tickets that own the other TODO kinds.
- Projection: the `home` Needs you count and item `needs_you`, the `todo:<n>` question with its first answer, and the conversation entry's tone `attention` with the per-viewer action of §14.5.2.
- Toast recipients (§10.8.3): the TODO's owner in S1; members present on the branch from S2.

Out:
- Raising `conflict` (T-STK-08), `moved_off` (T-COL-05), `foreign_push` (T-GH-06), `order` (T-GH-05) and `force_push` (T-GH-07).
- Toast rendering (T-APP-07) and the TODO card (T-APP-02). Browser notifications (T-APP-18, S2).

## Changes
- `packages/backend/db/product/migrations/01xx_todo_waits.sql` (new) → `todo_waits(wait_id PK, todo_id, kind CHECK over the five TODO kinds, owner run|branch, payload, run_wait_id, opened_at, settled_at, settled_by, outcome)` with a partial index on open waits.
- `packages/backend/internal/services/todo_needs_you.go` (new) → raise from the runtime projection (`ProjectFlowRuntime`, `services/mythical_items.go:577`) when a wait opens. Answer as one conditional update (`UPDATE todo_waits … WHERE wait_id = $wait AND settled_at IS NULL`), then recompute `todos.state` and `todos.needs_you` by §4.1.0a in the same transaction, one `todo_events(kind='answer', actor)` row and one `activity` row (kind `answer`), then deliver to the wait through `flowdispatch.Service.Approve` (`packages/backend/flowdispatch/service.go:155`) for an approval or the deferred completion for an ask.
- `packages/backend/internal/services/stack_attention.go` (new) → `Open(kind, audience, payload)` and `Settle(id, actor)` on the `stack_attention` table from T-STK-01, with `home` deltas for its audience.
- Authorization (§5.2): any member, or a delegated credential acting for one, may answer a question; approvals take an owner's or maintainer's session; the coding agent's run credential may answer only its own `conflict`.
- The coding host's tool binding (`NativeControl.ts:1382-1404`) → bind `ask` for the `coding/edit-atom` and `coding/dispatch-turn` seats, backed by `HumanTask` kind `ask` (`packages/smithers/flows/flow/src/HumanTask.ts:71`). `flows/coding/request/flow.ts:58` keeps plan approval as kind `confirm`.
- Planner decline: the feature route in `flows/coding/todo.ts` (`leafFeedback`) asks through `ask` instead of declining with questions. `mythical_items.go:804` (`coding/Error/declined`) no longer receives a decline that carries questions.
- Appendix C (`.specs/product/actions.md`, §6.1.2): the `ask` row (C.7) exists. In the same change, record its binding to the two implementing seats and close gap 4 in C.23. Any tag this ticket adds gets its row in the same change.
- `docs/api/openapi/todos.yaml`, regenerated `ProductApi.ts` (`smthrs run //:openapiClients`), `packages/backend/docs/todos.md`; docs gates.

## Tests
- Unit, `todo_needs_you_test.go` (new): kind validation; the action per kind (§14.5.2: question and approval → Answer; conflict and moved_off → Resolve; foreign_push → Review); `order` and `force_push` are refused as TODO kinds.
- Unit, `flows/test/coding-ask-binding.test.ts` (new): `coding/edit-atom` and `coding/dispatch-turn` list `ask`; a call opens a wait and returns the answer as the tool result.
- Unit, `flows/test/coding-planner-questions.test.ts` (new): a feature TODO the scripted planner finds unclear opens one `ask` wait holding its questions and doesn't end the run; a `close` route still declines.
- Integration with real PostgreSQL, `todo_needs_you_db_test.go` (new): 20 goroutines answer one wait at once; exactly one `answer` event commits; 19 get `409` naming the winner; the run receives exactly one answer.
- Integration with a real flow host: an `ask` from the implementing seat raises `needs_you{question}`; the answer resumes the same run; a replayed answer with the same idempotency key is a no-op.
- Integration: a `needs_you` raised from `in_review` returns to `in_review` on an answer that needs no new work; an answer from a run credential to a `question` is refused with class `permission`; a delegated credential's `approval.approve` is refused with no confirmation path.

## Acceptance



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J2-03](../checks/C-J2-03.md): agent question → Needs you to the owner and on the home card; first answer wins.
- [C-STK-08](../checks/C-STK-08.md): independent waits give the §4.1.0a state; merges on GitHub close every wait.

## Risks and notes
- Risk: the agent asks free-form questions in its transcript instead of through `ask`. Observation: a TODO run whose transcript ends with a question while the TODO stays `working`. Add a flow-level test that `ask` is the only way to ask.
- Risk: a planner question waits for days on an issue-born TODO whose author isn't a member. Any member may answer (§10.8.2); the owner gets the toast.
