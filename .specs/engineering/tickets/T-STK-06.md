# T-STK-06 Steers and amendments at every boundary of the TODO flow

Stage S1 · Size M · Depends on T-STK-01, T-STK-02, T-STK-05, T-STK-12, T-FLW-11 · Unblocks T-APP-02, T-APP-10, T-COL-12, T-GH-04, T-REL-02 · Issue: [#3531](https://github.com/smithersai/smithers/issues/3531)
Spec: spec.md §4.1 (`in_review → working`), §5.2, §10.2.2, §10.4.2, §10.7.3, §15.1.5 · Delta: delta.md §6 (steer route; steers between implement turns) · Product: mvp.md §4.2, §6.6 Steer, J3.6, J4.2, J6.3, J7.1, M-21, Appendix B.2

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ticket merges STK-06+15; v2 "Reuse named in tickets"). Absorbs T-STK-06 ([#3536](https://github.com/smithersai/smithers/issues/3536)).

## Goal
A member, or an agent acting for one, steers or amends `Tn`. The live implementing agent receives the text before its next model call on the same run and working copy. An amendment is a new revision of the same TODO, delivered as a steer.

## Scope
In:
- `POST /api/todos/{n} {steer}` and `/todo.steer Tn` (`agent: run`, recorded with `via`).
- `PATCH /api/todos/{n}` and `/todo.amend Tn` (`agent: confirm`): append revision n+1 to `mythical_items.revisions`; no new number, branch or PR. HTTP 202 is the only JSON success response; its body carries `state` for committed and pending outcomes.
- Delivery by state (§10.7.3): held while `queued` or `starting`, delivered on resume while `paused`, `in_review → working` with the run re-entering implement. A failed or reopened TODO starts one attempt through T-STK-05 with the steer first. Merged or dropped refuses `todo_closed`. A merge fence (T-STK-12) refuses Amend with `409 merging` and holds a steer until the fence clears.
- An open question stays open; a steer never settles a wait.

Out: GitHub reviews as steers (T-GH-04), Retry (T-STK-05), S2 burst activity, arbitrary named signals, a new queue or journal, Views and Containers.

## Changes
- Reuse `ReceiveFeedback` (`flows/coding/steering.ts:156`) and `routeMessages` (`:28`). Reshape: admit the `todo` root and its step flows, not only `coding/request` (`:15`), and replace the three-value `Boundary` list (`:91`) with every step boundary of the `todo` composition (T-FLW-11).
- Reshape `flows/coding/implementation/flow.ts`: call `ReceiveFeedback` between atoms and hand queued steers to `EditAtom` between model turns. `flows/coding/request/flow.ts:112`, `:130` keep their calls.
- Reuse the dispatcher signal path (`packages/backend/flowdispatch/service.go:94`). Reshape: add `SignalInTx`, the signal twin of the existing `AdmitInTx` (`:80`), so the item event, revision and signal intent commit in one transaction before the worker delivers.
- Reuse T-STK-01's `product_job_events` for the `steer` and `amend` entries with actor and `via`.
- Delete `runs.steer` (`apps/app/src/mainview/flows/entries/runs.ts:128`) and `steerRun` (`apps/app/src/mainview/state/controller/runs.ts:631`); `/todo.steer` replaces them.
- `docs/api/openapi/mythical_items.yaml`, regenerated `ProductApi.ts` (`smthrs run //:openapiClients`), `packages/backend/docs/mythical_items.md`; docs gates.
- New: none.

## Tests
- Integration, real PostgreSQL and the real pinned coding host in a microVM: the scripted provider holds a turn while a steer arrives; the literal text and actor reach the next model request; run id and working-copy change id are unchanged.
- Same suite: one idempotency key twice yields one signal and one event; queued delivers at start, paused at Resume, `in_review` re-enters implement; a run credential is refused; a steer during an open question leaves Needs you. Crash after commit delivers once.
- Amend: queued Amend is revision 2; working Amend reaches the live run once; replay allocates no number and sends no second signal; a delegated Amend writes nothing until the person confirms; a fenced Amend writes no revision.
- Unit, `flows/test/coding-steering.test.ts`: a Message to a `todo` run is admitted at each boundary; a closed run refuses `notification_closed`.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md) (S1 part), [C-J3-05](../checks/C-J3-05.md) steps 2-4, [C-J7-01](../checks/C-J7-01.md) (Amend: +1, no new TODO, branch or PR, one attributed steer), [C-ACC-01](../checks/C-ACC-01.md) (Amend confirmation).

## Risks and notes
- Activation with T-APP-04: Steer delivery lands before Confirm wiring; delegated Amend remains refused. Missing providers refuse; joint acceptance gates enabling the path.
- Risk: a dispatcher signal never reaches the host's notification queue, because today's steers go through the workspace gateway (`controller/runs.ts:631`). Observation: the steer is missing from the run transcript. Then the backend calls the gateway `steer` from a durable job instead.
