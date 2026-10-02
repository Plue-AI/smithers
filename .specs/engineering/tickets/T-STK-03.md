# T-STK-03 Parallel setting clamped by capacity; admission in stack order

Stage S2 · Size S · Depends on T-STK-02, T-MCH-06 · Unblocks — · Issue: to file
Spec: spec.md §4.1.1, §8.2.1, §8.3, §8.4.2, §10.3.1 · Delta: delta.md §6 (Hide `history.parallel`; it becomes the owner setting), §3 (admission scheduler) · Product: mvp.md §6.6 Parallel work, §8 (lanes hidden; parallel is one owner setting), M-06, M-13, §13

## Goal
The owner sets how many TODOs work at once, the install never runs more than the detected capacity allows, one machine stays free for people and background runs by default, and queued TODOs take machines strictly in stack order with a visible position.

## Scope
In:
- Owner setting `parallel` from 1 to 8. Effective value = `min(parallel, capacity)`, with capacity from the detected host profile (§8.2.1).
- Default `parallel = max(1, capacity − 1)` (§10.3.1): 1 at capacity 1 or 2, 2 at capacity 3, 5 at capacity 6. The spare machine serves `person` and `background` requests (§8.3.1), so learning, `flow-load` and wiki refresh don't wait behind working TODOs.
- Queued TODOs file `machine_requests` of class `todo` (§8.3.1) in stack order; at most the effective `parallel` TODOs hold machines.
- What counts (§10.3.1): `starting` and `working` TODOs, plus `paused`, `needs_you` and `in_review` TODOs until their machine is released at safe-idle (§8.4.2).
- `todos.queue = {reason: "waiting for a machine", position}` from the scheduler's ordered waiting set (§4.1.1, §8.3.2).
- The setting on `/api/install` and the Settings card's field (owner only, `agent: never`, §15.1.5).

Out:
- The scheduler, classes, safe-idle release and the capacity formula (T-MCH-06, T-MCH-01).
- People's wake requests ahead of TODOs (T-MCH-06 owns the priority).
- Preemption of a working agent (never, §8.3.3).

## Changes
- `packages/backend/internal/services/todo_admission.go` (new) → on each engine pass, for `queued` TODOs in stack order, keep exactly `effective_parallel − holding` `todo` requests open, where `holding` counts per §10.3.1; cancel requests of TODOs that moved below the cut.
- `packages/backend/internal/services/mythical_items.go` → `slot` and `freeLane` (`:1038`, `:1050`) read the effective `parallel`; delete the chat-lane reserve `mythicalLaunchSlot` (`:3506`) and its comment (`:1036`). The default's spare machine replaces that reserve.
- Delete `SetMaxParallel` (`:2686`), route `PUT /mythical/config` (`internal/compose/router.go:1120`, `routes/mythical.go:246`), its OpenAPI row (`docs/api/openapi/repositories.yaml:12686`) and `history.parallel` (`apps/app/src/mainview/flows/entries/history.ts:70`). The value moves to the owner settings of `/api/install` (T-INS-06), migrating `mythical_stacks.max_parallel` (`0026_mythical_stacks.sql:22`).
- `home` projection → `parallel` (owner only) and each queued item's position.
- `docs/api/openapi` install schema field; regenerated `ProductApi.ts`; `packages/backend/docs/todos.md`; docs gates.

## Tests
- Unit, `todo_admission_test.go` (new): the default for capacity 1, 2, 3, 6 and 7 (1, 1, 2, 5, 6); effective parallel for those capacities against requested 1..8.
- Integration with real PostgreSQL and the T-MCH-06 scheduler on a fake runtime whose host profile gives capacity 3, `todo_admission_db_test.go` (new): with the default (2) and 5 queued TODOs, exactly T1 and T2 are admitted, and a `background` request is granted the third machine. A new TODO placed Before T2 admits before the old T2 the next time a slot frees.
- Same file: setting parallel to 8 stores 8 and reports effective 3; a profile change to capacity 2 lowers the effective value without stopping a working agent.
- Same file: a `needs_you` TODO holds its slot until its machine is released, then frees it.
- Same file: positions shown as "waiting for a machine #1", "#2" match the scheduler's order after every reorder.
- Integration: a maintainer, a member and a delegated credential get `permission` on the `parallel` write.

## Acceptance
- [C-STK-02](../checks/C-STK-02.md): items admit in stack order up to `parallel`; the setting is clamped by capacity.

## Risks and notes
- Risk: a person's wake takes the slot a TODO was promised, so the TODO's position jumps. That is M-13's rule; the position must update within 1 s (C-PERF-02), not stay stale. Observation: a stale position in the C-STK-02 log.
- Risk: at capacity 2 the default runs one TODO at a time. That is §10.3.1's choice; the owner may raise it to 2.
