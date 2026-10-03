# T-STK-07 Needs you: independent waits, precedence, first answer wins, `ask` bound for implementing seats

Stage S1 · Size M · Depends on T-STK-01, T-ACC-04, T-MCH-14 · Unblocks T-APP-02, T-COL-05, T-FLW-11, T-GH-05, T-GH-06, T-GH-07, T-GH-09, T-REL-02, T-STK-04, T-STK-08, T-STK-13 · Issue: [#3451](https://github.com/smithersai/smithers/issues/3451)
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
- Approvals keep `approval.approve` and `approval.deny` on the same first-answer path. They are person-only and `agent: never`: approvals that gate a merge have no agent path (§15.1.5, Appendix B.2). Resolve the wait kind before authorization on every door, including `POST /api/todos/{n} {answer}`; an approval answer requires the eligible owner/maintainer session and never creates a delegated confirmation. Checks: C-ACC-01, C-STK-08.
- A generic `RaiseNeedsYou(kind, payload)` for the tickets that own the other TODO kinds.
- Projection: the `home` Needs you count and item `needs_you`, the `todo:<n>` question with its first answer, and the conversation entry's tone `attention` with the per-viewer action of §14.5.2.
- Toast recipients (§10.8.3): the TODO's owner in S1; members present on the branch from S2.

Out:
- Raising `conflict` (T-STK-08), `moved_off` (T-COL-05), `foreign_push` (T-GH-06), `order` (T-GH-05) and `force_push` (T-GH-07).
- Toast rendering (T-APP-07) and the TODO card (T-APP-02). Browser notifications (T-APP-18, S2).
- Merge approvals/dispatch, the one-run composition (T-FLW-11), run-attached projection (T-STK-13), arbitrary signals, new human-wait primitives or journals, general agent tool changes, automatic transcript-question detection, flow overrides, UI View/Container implementation and CLI/skill doors. Late-answer draft retention and Send as steer are T-APP-02/T-STK-06 integration.

## Changes
- `packages/backend/db/product/migrations/01xx_todo_waits.sql` (new) → `todo_waits(wait_id PK, todo_id, kind CHECK over the five TODO kinds, owner run|branch, payload, run_wait_id, opened_at, settled_at, settled_by, outcome)` with a partial index on open waits.
- `packages/backend/internal/services/todo_needs_you.go` (new) → raise from runtime wait events through `ProjectFlowRuntime` (`services/mythical_items.go:577`), keyed by the owning run and runtime wait id. Answer validates the TODO/run/wait binding, then performs one conditional update (`UPDATE todo_waits … WHERE wait_id = $wait AND settled_at IS NULL`). In that transaction, recompute the primary wait and state through T-STK-01's shared `todo_state.go` seam, append one answer event/activity entry and a keyed durable answer-delivery intent using the existing jobs store. Deliver only after commit to that exact wait. Reuse `flowdispatch.Service.Approve` (`packages/backend/flowdispatch/service.go:155`) only when that wait issued the matching opaque approval; use the existing deferred completion for ask. Do not approve a launch plan to answer a question. T-STK-13 later consumes these wait facts in run-attached projection; add no second state writer. Checks: C-J2-03, C-STK-08.
- `packages/backend/internal/services/stack_attention.go` (new) → `Open(kind, audience, payload)` and `Settle(id, actor)` on the `stack_attention` table from T-STK-01, with `home` deltas for its audience.
- Authorization (§5.2): any member, or a delegated credential acting for one, may answer a question; approvals take an owner's or maintainer's session; the coding agent's run credential may answer only its own `conflict`.
- The coding host's effective tool binding (`packages/smithers/src/internal/NativeControl.ts:1418`, `:1430-1450`, `:1707`) → verify and bind callable `ask` for the `coding/edit-atom` and `coding/dispatch-turn` seats. Both host paths already pin `ask`; pinning alone is not a callable-binding test. Reuse the existing StandardFlows ask contract (`packages/smithers/agent/src/StandardFlows.ts:964`, `:1010`) and durable human-wait completion (`packages/smithers/flows/flow/src/HumanTask.ts:71`), preserving the tool result. `flows/coding/request/flow.ts:58` keeps plan approval as kind `confirm`.
- Planner decline: the feature route in `flows/coding/todo.ts` (`leafFeedback`) asks through `ask` instead of declining with questions. `mythical_items.go:804` (`coding/Error/declined`) no longer receives a decline that carries questions.
- Appendix C (`.specs/product/actions.md`, §6.1.2): the `ask` row (C.7) exists. In the same change, record its binding to the two implementing seats and close gap 4 in C.23. Any tag this ticket adds gets its row in the same change.
- `docs/api/openapi/todos.yaml` and `packages/backend/docs/todos.md` (new in the TODO slice), regenerated `packages/smithers/src/internal/backend/ProductApi.ts` (`smthrs run //:openapiClients`); docs gates.

## Tests
- Boundary integration, `packages/backend/internal/services/todo_needs_you_db_test.go` (new): a fixture run on a real microVM invokes each production implementing-seat ask binding; wait events enter the registered flowdispatch projector. Submit answers through the composed `POST /api/todos/{n}` route and production command dispatcher with real PostgreSQL. Race 20 distinct request keys and assert one event, one completion and 19 literal `409 {answered_by}` responses. Unit tool lists and direct Raise/Answer calls do not replace this boundary. Use fixed kind/precedence/action and credential cases; no test reads spec files or derives expectations from production code at runtime. Checks: C-J2-03, C-STK-08.
- Same suite: delegated approval attempts fail through both named approve/deny commands and generic answer, with no settled wait, confirmation or delivery. A run credential cannot answer a question, another TODO's conflict or an unrelated wait. Duplicate runtime wait-open events create one row; crash after answer commit but before delivery resumes that exact wait once. Settling a question with a branch wait open leaves Needs you; run termination expires only its run waits, and merge/drop close all. Checks: C-ACC-01, C-STK-08.
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

## Ready checklist
1. Dependencies: T-STK-01 supplies state/events/activity/projection storage; T-ACC-04 supplies the catalog authorizer and delegated identity; T-MCH-14 supplies retained workspaces and wake-before-answer delivery, with T-INS-02/T-FLW-01 isolation. This ticket implements independent-wait recomputation through the existing state seam. T-FLW-11 and T-STK-13 consume it later; neither is a prerequisite. New S1 edges have no reverse path.
2. Exclusions: other wait producers, toast/card rendering, browser notifications, merge, composition/attachment projection, arbitrary signals, new wait storage systems, broad tool changes, transcript parsing, overrides, UI and CLI/skill doors are named. Late-answer UI/steer integration stays with T-APP-02/T-STK-06.
3. Tests: `todo_needs_you_db_test.go` drives real implementing-seat ask, production wait ingestion and composed answer/approval dispatch with literal race, policy and precedence oracles. C-J2-03's browser/draft/toast parts complete with their UI and steer owners; C-STK-08 covers this ticket's wait combinations before later producer integration. No runtime-derived expectations.
4. Decisions: smithers-3f approves wait identity, state/transaction ownership and durable answer delivery, and owns the planned todo_waits migration; smithers-38 approves effective ask bindings, result/old-journal compatibility and public TypeScript API changes under §21.1; smithers-b8 approves answer/approval API and retained approval-card seams; smithers-06 approves the TODO View wait/action seam. smithers-8a accepts cross-owner seams; Will accepts product/Appendix C changes.
5. Owner pre-review before start: smithers-3f: Are wait ids bound to the current TODO/run and are state/event/delivery intent atomic? Does first-answer replay complete only the winning wait? smithers-38: Do both implementing seats receive callable ask and resume with its existing tool result after restart? smithers-b8: Does every answer door enforce person-only approval policy and expose the winner without losing the late draft? smithers-06: Can the TODO View show every independent wait/action and keep the late answer with Send as steer? Visual implementation remains with design.
6. Security: require T-INS-02/T-FLW-01 before executing a repository fixture or implementing seat. The agent and repository flow run only inside their branch machine (§1.3, M-29), without sudo or host keys. Authenticate runtime wait events and bind answers to their TODO/run; delegated agents cannot approve, and run credentials can resolve only their own conflict. smithers-3f reviews isolation/authority, smithers-38 tool ownership; C-SEC-02 and the credential/ask boundary cases prove it.

