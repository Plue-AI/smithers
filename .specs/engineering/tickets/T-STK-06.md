# T-STK-06 Steers at every boundary of the TODO flow

Stage S1 · Size M · Depends on T-STK-01, T-FLW-11, T-STK-12, T-STK-05 · Unblocks T-APP-02, T-CAT-02, T-COL-12, T-GH-04, T-REL-02, T-STK-15 · Issue: [#3531](https://github.com/smithersai/smithers/issues/3531)
Spec: spec.md §2, §3 (`activity`), §4.1 (`in_review → working`), §5.2, §6.4, §7.2 (`branch:<id>:activity`), §10.4.1, §10.4.2, §10.7.3, §11.6.1, §15.1.5 · Delta: delta.md §6 (Add steer route; accept steers between implement turns), §4 (`activity` table [S1]) · Product: mvp.md §6.6 Steer, J3.6, J4.2, J6.3, M-21, Appendix B.2

## Goal
Any member, or an agent acting for one, sends a steer with its author shown in branch activity. A live implementing agent receives it before its next model call on the same run and working copy; queued, starting and paused delivery follows §10.7.3. A failed or reopened TODO needing a run starts one new attempt through T-STK-05.

## Scope
In:
- `POST /api/todos/{n} {steer: text}` and `/todo.steer Tn`. The command is `agent: run` in the catalog (mvp.md Appendix A `runs.steer` → `/todo.steer`: P, A, X): any member steers, and the app agent or an external agent steers at once for its person, recorded with `via` (§15.1.5; product, 2026-10-02).
- While a question is open (`needs_you{kind: question}`), Answer is the primary action and a steer never settles the wait; the steer is delivered as context and the question stays open (§10.7.3).
- Durable delivery to the attempt's `todo` run (T-FLW-11) as a signal, keyed by the request's `Idempotency-Key`.
- Steer admission at every boundary of the `todo` composition (route, plan, implement, candidate, check, review, propose and the post-propose wait) and between agent turns inside implement (§10.7.3). Candidate and propose use the reserved system operations; there is no package step (§10.4.1).
- Delivery by state (§10.7.3): held while `queued` or `starting` and delivered when the run starts; delivered on resume while `paused`; `in_review → working`, with the run's post-propose wait re-entering implement (§10.4.1). A failed item enters T-STK-05's Retry with the steer first; a merged or dropped item refuses `todo_closed`.
- One `todo_events` row of kind `steer` and one `activity` row (kind `steer`) on the TODO's branch, each with the actor including `via` (§2, §6.4), through T-STK-01's `activity` writer.

Out:
- GitHub reviews and comments as steers (T-GH-04); amendments call this path (T-STK-15).
- Retry with a steer from `failed` (T-STK-05).
- Burst and change entries in the activity (S2, T-COL-04).
- Arbitrary named signals, agent seat/model/tool/budget changes, answering or approving a wait, Stop/Resume, retry implementation, flow activation, a new queue or journal, UI Views/Containers, and CLI/skill door implementation.

## Changes
- `packages/backend/internal/services/todo_steer.go` (new) → authorize `steer` (§5.2: members and delegated-as-person, never the run credential); append `todo_events(kind='steer')` and the `activity` row in one transaction; resolve the active run from `todo_attempts`; record a `steer` intent with the new `flowdispatch.Service.SignalInTx` counterpart of `Signal` (`packages/backend/flowdispatch/service.go:94`), `RequestID` = the actor-scoped idempotency key; the worker delivers after commit. Steers to a TODO with no live run wait in `todo_events` and are delivered at run start or resume. An `in_review` TODO with no live run (reopened, §10.7.4) starts a new attempt through T-STK-05's reopen path with the steer first. While a merge fence is set (§10.6.2b), a steer commits and is held: it is delivered if the fence clears without a merge and stays undelivered if the TODO merges.
- `flows/coding/steering.ts` → admit Message steers for the `todo` root and its step flows instead of only `coding/request` (`:15`, `:41-58`). Replace the boundary list (`after-poc`, `before-implementation`, `after-correction`, `:91`) with every step boundary of the `todo` composition.
- `flows/coding/implementation/flow.ts` → receive pending steers between atoms, and give the `EditAtom` agent queued steers between its model turns (≤ one model turn of latency).
- `flows/coding/request/flow.ts` → keep the existing `ReceiveFeedback` calls (`:112`, `:130`) on the shared boundary list.
- The coding host maps a `steer` signal onto the existing notification queue Message (`routeMessages`, `steering.ts:28`), so the gateway's actor attribution is kept.
- `packages/backend/flowdispatch/service.go:94` currently commits Signal in its own transaction. Add an internal `SignalInTx` counterpart using the same validated signal admission and `jobs.Store.AdmitInTx`, so the TODO event, activity and keyed signal intent commit together before worker delivery. T-STK-12 holds fenced inputs and releases them once after a failed merge; do not contact the runtime inside the transaction. Check: C-STK-07.
- Delete `runs.steer` (`apps/app/src/mainview/flows/entries/runs.ts:136`) and `steerRun` (`apps/app/src/mainview/state/controller/runs.ts:657`); `/todo.steer` replaces them (mvp.md Appendix A).
- `docs/api/openapi/todos.yaml` and `packages/backend/docs/todos.md` (new in the TODO slice), regenerated `packages/smithers/src/internal/backend/ProductApi.ts` (`smthrs run //:openapiClients`), `flows/coding/steering.md`; docs gates.

## Tests
- Boundary integration, `packages/backend/internal/services/todo_steer_db_test.go` (new): enter `POST /api/todos/{n} {steer}` through the composed install router and production command dispatcher, then deliver through the durable flowdispatch worker to the real pinned coding host on a microVM. Script the model provider to hold a turn while a steer arrives. Assert the literal input text and actor before the next model request; step-boundary or between-atom unit coverage alone does not prove this latency. Use a fixed boundary/state matrix, journal fixtures and refusal outcomes; no test reads spec files or derives expected results from production code at runtime. Check: C-J3-05.
- Same suite: queued/starting delivery waits for start, paused delivery waits for Resume, failed steering starts one Retry attempt, and reopened in_review steering starts one pinned attempt. Merged/dropped steering returns `todo_closed`. Crash before event/signal commit produces neither; crash after commit or notification acknowledgement delivers each accepted input once. Old queued Message receipts still decode. Checks: C-J3-05, C-STK-07.
- Unit, `flows/test/coding-steering.test.ts` (existing): a Message to a `todo` run is admitted at each step boundary; a Message to a closed run is refused with `notification_closed`.
- Unit, `flows/test/coding-implementation-steer.test.ts` (new): a steer queued during atom 2 reaches the agent before its next model call, exactly once.
- Integration with real PostgreSQL and the real pinned coding host on a microVM, `todo_steer_db_test.go` (new): the same idempotency key twice yields one signal, one event and one activity row; the run id and working-copy change id are unchanged after delivery.
- Integration, same file: a steer from a delegated credential (`via=smithers`, `via=claude-code`) is delivered at once with no confirmation row; a steer while a question is open leaves the wait open and the TODO in `needs_you`.
- Integration, same file: a steer to `in_review` moves it to `working` and the run re-enters implement with the steer first; a steer to `queued` is delivered at run start; a steer from a run credential is refused.

## Acceptance



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J3-05](../checks/C-J3-05.md): a steer appears with its author and the agent continues on the same working copy.
- [C-STK-07](../checks/C-STK-07.md) steps 2-4: a steer before the fence refuses Merge; one during it is held and delivered only if the merge fails.

## Risks and notes
- Consume T-STK-12's `LockStack`, `todos.merging` and held-signal delivery. T-STK-04's completed squash route is not a prerequisite; C-STK-07 must prove holding and release through the shared seam.
- Risk: a `flowdispatch` signal doesn't reach the coding host's notification queue, because today's steers go through the workspace gateway (`controller/runs.ts:650`). Observation: the integration test's steer never appears in the run transcript. Then the backend calls the gateway `steer` with a durable job instead.
- Risk: a steer whose run consumes it before the activity row commits shows in the transcript first. Observation: a transcript timestamp earlier than the activity entry's in C-J3-05. The event, the activity row and the signal's durable record commit in one transaction before delivery.

## Ready checklist
1. Dependencies: T-STK-01 supplies events/activity; T-FLW-11 supplies the one-run composition and retained machine; T-STK-12 supplies the lock/fence and held-input release; T-STK-05 supplies failed/reopened attempt starts, pinned loading, the T-STK-13 projection and the catalog authorizer/delegated credentials. The new S1 edge has no reverse path.
2. Exclusions: GitHub input ingestion, amendment and retry implementation, burst activity, arbitrary signals, agent settings, answering/approving, Stop/Resume, activation, new storage, UI and CLI/skill implementation are explicit.
3. Tests: `todo_steer_db_test.go` enters the composed route and production dispatcher/worker and observes the next real host model request on a machine. C-J3-05 covers browser and external-agent doors; C-STK-07 covers fence holding/release. Boundary labels, state cases, text and errors are fixed fixtures, not runtime-derived oracles.
4. Decisions: smithers-3f approves transaction and durable delivery seams; smithers-38 approves notification ownership, old-receipt compatibility and any public TypeScript API diff under §21.1; smithers-b8 approves public steer bindings and removal of runs.steer. smithers-8a accepts the cross-owner delivery seam; Will decides product changes.
5. Owner pre-review before start: smithers-3f: Can event/activity/signal intent commit atomically through the existing jobs store? Do fence release and failed/reopened steering each produce one delivery or attempt? smithers-38: Does root-to-step/model-turn routing preserve native ownership checks and old notification receipts? smithers-b8: Do person and delegated steer doors run immediately through one binding with correct via attribution? Views are excluded.
6. Security: require T-INS-02/T-FLW-01 through the listed prerequisites before input starts or resumes repository code. Repository flow and model-turn tools execute only in the branch machine (§1.3, M-29), without sudo or host keys; the host admits data and packaged control operations. Run credentials cannot impersonate a member or steer another run. smithers-3f reviews isolation/authority and smithers-38 reviews notification ownership; C-SEC-02 and the steer credential/restart cases prove the boundary.

