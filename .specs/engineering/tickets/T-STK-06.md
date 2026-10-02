# T-STK-06 Steers at every boundary of the TODO flow

Stage S1 · Size M · Depends on T-STK-01, T-FLW-11 · Unblocks T-STK-02, T-GH-04 · Issue: to file
Spec: spec.md §2, §3 (`activity`), §4.1 (`in_review → working`), §5.2, §6.4, §7.2 (`branch:<id>:activity`), §10.4.1, §10.4.2, §10.7.3, §11.6.1, §15.1.5 · Delta: delta.md §6 (Add steer route; accept steers between implement turns), §4 (`activity` table [S1]) · Product: mvp.md §6.6 Steer, J3.6, J4.2, J6.3, M-21, Appendix B.2

## Goal
Any member, or an agent acting for one, sends a steer to a TODO and the coding agent reads it within one model turn, on the same run and the same working copy, with the author shown in the branch activity.

## Scope
In:
- `POST /api/todos/{n} {steer: text}` and `/todo.steer Tn`. The command is `agent: run` in the catalog (mvp.md Appendix A `runs.steer` → `/todo.steer`: P, A, X): any member steers, and the app agent or an external agent steers at once for its person, recorded with `via` (§15.1.5; product, 2026-10-02).
- While a question is open (`needs_you{kind: question}`), Answer is the primary action and a steer never settles the wait; the steer is delivered as context and the question stays open (§10.7.3).
- Durable delivery to the attempt's `todo` run (T-FLW-11) as a signal, keyed by the request's `Idempotency-Key`.
- Steer admission at every step boundary of the `todo` flow (route, plan, implement, check, review, package, and the post-propose wait) and between agent turns inside implement (§10.7.3).
- Delivery by state (§10.7.3): held while `queued` or `starting` and delivered when the run starts; delivered on resume while `paused`; `in_review → working`, with the run's post-propose wait re-entering implement (§10.4.1).
- One `todo_events` row of kind `steer` and one `activity` row (kind `steer`) on the TODO's branch, each with the actor including `via` (§2, §6.4), through T-STK-01's `activity` writer.

Out:
- GitHub reviews and comments as steers (T-GH-04); amendments call this path (T-STK-02).
- Retry with a steer from `failed` (T-STK-05).
- Burst and change entries in the activity (S2, T-COL-04).

## Changes
- `packages/backend/internal/services/todo_steer.go` (new) → authorize `steer` (§5.2: members and delegated-as-person, never the run credential); append `todo_events(kind='steer')` and the `activity` row in one transaction; resolve the active run from `todo_attempts`; deliver with `flowdispatch.Service.Signal` (`packages/backend/flowdispatch/service.go:94`) named `steer`, `RequestID` = the idempotency key. Steers to a TODO with no live run wait in `todo_events` and are delivered at run start or resume.
- `flows/coding/steering.ts` → admit Message steers for the `todo` root and its step flows instead of only `coding/request` (`:15`, `:41-58`). Replace the boundary list (`after-poc`, `before-implementation`, `after-correction`, `:91`) with every step boundary of the `todo` composition.
- `flows/coding/implementation/flow.ts` → receive pending steers between atoms, and give the `EditAtom` agent queued steers between its model turns (≤ one model turn of latency).
- `flows/coding/request/flow.ts` → keep the existing `ReceiveFeedback` calls (`:112`, `:130`) on the shared boundary list.
- The coding host maps a `steer` signal onto the existing notification queue Message (`routeMessages`, `steering.ts:28`), so the gateway's actor attribution is kept.
- Delete `runs.steer` (`apps/app/src/mainview/flows/entries/runs.ts:136`) and `steerRun` (`apps/app/src/mainview/state/controller/runs.ts:657`); `/todo.steer` replaces them (mvp.md Appendix A).
- `docs/api/openapi/todos.yaml`, regenerated `ProductApi.ts` (`smthrs run //:openapiClients`), `packages/backend/docs/todos.md`, `flows/coding/steering.md`; docs gates.

## Tests
- Unit, `flows/test/coding-steering.test.ts` (existing): a Message to a `todo` run is admitted at each step boundary; a Message to a closed run is refused with `notification_closed`.
- Unit, `flows/test/coding-implementation-steer.test.ts` (new): a steer queued during atom 2 reaches the agent before its next model call, exactly once.
- Integration with real PostgreSQL and a real flow host, `todo_steer_db_test.go` (new): the same idempotency key twice yields one signal, one event and one activity row; the run id and working-copy change id are unchanged after delivery.
- Integration, same file: a steer from a delegated credential (`via=smithers`, `via=claude-code`) is delivered at once with no confirmation row; a steer while a question is open leaves the wait open and the TODO in `needs_you`.
- Integration, same file: a steer to `in_review` moves it to `working` and the run re-enters implement with the steer first; a steer to `queued` is delivered at run start; a steer from a run credential is refused.

## Acceptance
- [C-J3-05](../checks/C-J3-05.md): a steer appears with its author and the agent continues on the same working copy.

## Risks and notes
- Risk: a `flowdispatch` signal doesn't reach the coding host's notification queue, because today's steers go through the workspace gateway (`controller/runs.ts:650`). Observation: the integration test's steer never appears in the run transcript. Then the backend calls the gateway `steer` with a durable job instead.
- Risk: a steer whose run consumes it before the activity row commits shows in the transcript first. Observation: a transcript timestamp earlier than the activity entry's in C-J3-05. The event, the activity row and the signal's durable record commit in one transaction before delivery.
