# T-STK-03 Parallel setting clamped by capacity; admission in stack order

Stage S2 · Size S · Depends on T-STK-02, T-MCH-06, T-MCH-01, T-INS-06, T-ACC-03, T-CAT-01, T-APP-03, T-APP-01, T-INS-02, T-FLW-01, T-MCH-11, T-SEC-01 · Unblocks — · Issue: [#3572](https://github.com/smithersai/smithers/issues/3572)
Spec: spec.md §4.1.1, §8.2.1, §8.3, §8.4.2, §10.3.1 · Delta: delta.md §6 (Hide `history.parallel`; it becomes the owner setting), §3 (admission scheduler) · Product: mvp.md §6.6 Parallel work, §8 (lanes hidden; parallel is one owner setting), M-06, M-13, §13
Ready: 2026-10-03 smithers-8a sha256:fcdc1b86b71e

## Goal
The owner sets how many TODOs work at once, the install never runs more than the detected capacity allows, one machine stays free for people and background runs by default, and queued TODOs take machines strictly in stack order with a visible position.

## Scope
Land dark against the named contracts while any dependency is unlanded. Without T-STK-02 ordering, T-MCH-06 admission or T-MCH-01 capacity, admit no TODO and create no fallback queue. Without T-INS-06 settings, T-ACC-03 authority or T-CAT-01 policy, refuse parallel writes. Keep the field and projection additions disabled until T-APP-03 and T-APP-01 integration passes C-STK-02 and C-UI-13. Without T-INS-02 isolation, T-FLW-01 machine execution, T-MCH-11 non-root identity or T-SEC-01 validation, start no repository work. Missing providers fail closed; dependency landing does not block drafting or building this slice.
In:
- Owner setting `parallel` from 1 to 8. Effective value = `min(parallel, capacity)`, with capacity from the detected host profile (§8.2.1).
- Default `parallel = max(1, capacity − 1)` (§10.3.1): 1 at capacity 1 or 2, 2 at capacity 3, 5 at capacity 6. The spare machine serves `person` and `background` requests (§8.3.1), so learning, `flow-load` and wiki refresh don't wait behind working TODOs.
- Queued TODOs file the runtime admission queue of class `todo` (§8.3.1) in stack order; at most the effective `parallel` TODOs hold machines.
- What counts (§10.3.1): `starting` and `working` TODOs, plus `paused`, `needs_you` and `in_review` TODOs until their machine is released at safe-idle (§8.4.2).
- `mythical_items.queue = {reason: machine, position}` from the scheduler's ordered waiting set (§4.1.1, §8.3.2).
- The setting on `/api/install` and the Settings card's field (owner only, `agent: never`, §15.1.5).

Out:
- The scheduler, classes, safe-idle release and the capacity formula (T-MCH-06, T-MCH-01). No second admission queue, new scheduler, host-profile reader or table.
- Lane controls, per-person or per-repository parallel settings, CLI/skill setting doors, new UI Views, image/toolchain changes and root helper changes. Reuse the Settings and Home seams; their owners retain the surrounding implementations.
- People's wake requests ahead of TODOs (T-MCH-06 owns the priority).
- Preemption of a working agent (never, §8.3.3).

## Changes
- Reshape `packages/backend/internal/services/mythical_items.go:1061` (`advanceItems`) and its existing lane admission, using T-STK-02 ordering and T-MCH-06 runtime requests. On each pass, keep at most `max(0, effective_parallel − holding)` queued `todo` demands open in stack order; cancel only ungranted demands below the cut. Count holders until machine release is confirmed. Extend existing engine tests; no new admission module or persisted queue.
- `packages/backend/internal/services/mythical_items.go` → `slot` (`:1038`) uses effective `parallel`; retain `freeLane` (`:1050`) only for internal lane identity, never as a second capacity gate. Delete the chat-lane reserve `mythicalLaunchSlot` (`:3506`) and its comment (`:1036`). Reuse `services/install_capacity.go` and the T-MCH-06 extension of `microsandbox/runtime.go:542` (`admitRunningLocked`). The default's spare machine replaces the reserve.
- Reshape validation from `SetMaxParallel` (`mythical_items.go:2686`) into the owner-only `PUT /api/install` supplied by T-INS-06; persist requested `parallel` in existing `install_settings`. Migrate the existing `mythical_stacks.max_parallel` value (`packages/backend/db/product/migrations/0026_mythical_stacks.sql:22`) once when no install value exists; use the capacity-derived default only when no saved value exists. Delete the old setter and query, `PUT /api/repos/{owner}/{repo}/mythical/config` (`packages/backend/internal/compose/router.go:1132`, `packages/backend/internal/routes/mythical.go:246`), its OpenAPI row (`docs/api/openapi/repositories.yaml:12686`) and `history.parallel` (`apps/app/src/mainview/flows/entries/history.ts:70`). Preserve landed migration history; add the forward migration at landing.
- Reuse `apps/app/src/mainview/cards/SettingsContainer.tsx:28`, `flows/entries/settings.ts:33` and the existing Install seam for `settings.parallel`; remove agent disclosure and enforce owner-only, `agent: never` in T-CAT-01 policy and T-ACC-03 authorization. Reuse `HomeContainer.tsx` and `packages/rpc/src/HomeCard.ts` / `SettingsCard.ts`; permit effective 0 when capacity is 0. `home` reports effective `parallel` to the owner and each queued item's scheduler position. Check: C-STK-02, C-UI-13.
- Extend `docs/api/openapi/install.yaml`; regenerate `packages/smithers/src/internal/backend/ProductApi.ts`. `packages/backend/docs/mythical_items.md` is absent today: update the document supplied by T-STK-02 rather than create a competing page; run docs gates.

## Tests

C-STK-02 (folded steps and assertions): `TestParallelAdmissionInstallBoundary` extends the existing backend integration coverage with real PostgreSQL, the production composed install router, command dispatcher, engine loop and T-MCH-06 scheduler. Set parallel through `PUT /api/install` and `settings.parallel`; create/reorder through `POST /api/todos` and `POST /api/todos/{n}`; read snapshots and deltas through `/api/live` (`home` and `todo:<n>`). Drive Ben's request through the production terminal-open route, not a direct scheduler call. Inject only host measurements, clock and runtime boot/stop responses. Direct service and engine-pass calls are supplemental unit coverage. Literal fixture orders, values, envelopes and sentinel bytes define expectations; no test reads spec Markdown or derives expected policy from production code at runtime.

Start with capacity 3 and literal stack T1–T5:
1. Set `parallel = 2`. Run engine passes until stable.
2. Place T6 with Before T2. Release T1's step so T1 reaches `in_review`, then let its machine reach safe-idle and be released (§8.4.2).
3. Set `parallel = 8`.
4. Lower the injected free-disk term so capacity becomes 2 while three TODO machines are held. Do not change startup memory/core measurements.
5. Ben opens a terminal on a sleeping scratch branch (a `person` request) while TODOs wait.
6. Read `home.items[].queue` and `todo:<n>.queue` positions after each step; assert literal orders with person requests included, not a value computed from the scheduler at runtime.

Pass when:
- Step 1: exactly T1 and T2 pass through `starting` to `working`; T3, T4 and T5 are `queued` with reason `machine` and positions 1, 2 and 3.
- Step 2: T1 holds its slot while `in_review` until its machine is released; the next TODO admitted after that is T6, not T3.
- Step 3: the stored value is 8; the effective value reported on `home` is 3; a third TODO admits in stack order.
- Step 4: effective parallel drops to 2; all three existing holders continue. No new grant occurs until holders fall below the new limit. Capacity 0 reports effective 0 and grants no machine, while the saved requested value remains 8.
- Step 5: Ben's request is granted before any queued TODO; TODO positions update in the same projection delta.
- Positions in every `home` snapshot match the literal expected waiting order for that step; include person-before-TODO ordering.

Fail when:
- Admission follows creation or issue order instead of `stack_position`.
- A new TODO is granted while existing holders meet or exceed `min(parallel, capacity)`; lowering the limit must not evict existing holders.
- Lowering capacity pauses or cancels a working agent (preemption, §8.3.3).
- A position stays stale after a reorder (shows #2 for a TODO now first).

- Unit, extend `mythical_items_test.go` and `install_capacity_test.go`: literal defaults for capacity 0, 1, 2, 3, 6 and 7 (1, 1, 1, 2, 5, 6); literal clamp cases including requested 8 with capacity 0 → effective 0 and capacity 3 → effective 3. Reject 0, 9 and fractional requested values; do not reset a saved value on restart.
- Integration, extend `install_capacity_integration_test.go` with `TestParallelAdmissionInstallBoundary`, real PostgreSQL and the T-MCH-06 scheduler on a conformance runtime whose host profile gives capacity 3: with the default (2) and 5 queued TODOs, exactly T1 and T2 are admitted, and a `background` request is granted the third machine. A new TODO placed Before T2 admits before the old T2 the next time a slot frees.
- Same file: setting parallel to 8 stores 8 and reports effective 3; lowering free disk to capacity 2 blocks new grants without stopping existing holders. Restart preserves 8; forward migration preserves a legacy saved value and never overwrites an existing install value.
- Same file: a `needs_you` TODO holds its slot until its machine is released, then frees it.
- Same file: positions shown as "waiting for a machine #1", "#2" match the scheduler's order after every reorder.
- `TestParallelOwnerOnlyInstallBoundary`: through the composed router and `settings.parallel` dispatcher, a maintainer, member, setup session, delegated, run and machine credential get HTTP 403 `permission` on the write and change no setting or demand. Owner session succeeds; the removed mythical config route is unserved. Missing authority, settings, ordering, scheduler and machine-execution providers fail closed without a grant or repository execution. Check: C-STK-02.
- `TestParallelSettingsCardBoundary`: drive the existing mounted Settings field through `onAction` → `cardActions` → `flowAction` → production dispatcher; observe saved value and live projections. No direct mocked setter supplies acceptance. Check: C-STK-02, C-UI-13.

## Acceptance
- [C-STK-02](../checks/C-STK-02.md): the named production-boundary tests above pass, including dark-provider refusal, authorization, persistence, order and non-preemption.
- [C-UI-13](../checks/C-UI-13.md): existing Settings and Home seams carry the field and live positions.
- [C-SEC-02](../checks/C-SEC-02.md): T-SEC-01 fresh/retained root-boundary validation passes before repository execution is enabled.

## Risks and notes
- Risk: a person's wake takes the slot a TODO was promised, so the TODO's position jumps. That is M-13's rule; the position must update within 1 s (C-PERF-02), not stay stale. Observation: a stale position in the C-STK-02 log.
- Risk: at capacity 2 the default runs one TODO at a time. That is §10.3.1's choice; the owner may raise it to 2.

## Decisions and execution preconditions
- smithers-3f accepts holder accounting, migration precedence, request cancellation and the engine/runtime seam. smithers-b8 signs off install payloads, refusals and Settings dispatch; smithers-38 signs off RPC and generated TypeScript API changes under §21.1. smithers-06 accepts any View prop change; reuse current Views. smithers-8a resolves cross-owner seam disagreements. Will decides product changes; the product agent owns any proposed default change under mvp.md §13. This ticket implements §10.3.1's current default and adds no ADR.
- Repository flows, agents and checks execute only as unprivileged users inside machines (M-29, §1.3). No host-process fallback, sudo or branch-built root executable is permitted. smithers-3f reviews this execution boundary. This ticket adds no root step: grants reuse the approved launcher and guest lifecycle. T-SEC-01's R1–R3 inventory and C-SEC-02 remain mandatory for every induced fresh or retained wake.
- Root inputs and sources for those reused steps: helper bytes/digest, bootstrap/install script, fixed destination, interpreter/base executables, image selection, runtime IDs, fixed identity and cgroup/relay bounds come from main-pinned install code or its bundle/configuration; startup environment, retained image/helper ancestors, passwd/group, env.json, home/cache entries and symlinks can include branch/member state. R1 validates interpreter/helper provenance and environment (`TestGuestHelperInstallPinsInterpreterAndEnv`); R2 validates setup identities, env.json keys and no-follow home/cache writes (`TestRootSetupNeverFollowsMemberSymlinks`); R3 validates bounded request envelopes/files, cleanup IDs and relay endpoints before use (`TestRootPreflightParsesOnlyEnvelope`). Branch argv/env/cwd, file paths/bytes, stdin, retained filesystem metadata and process state are data only; apply executable payloads after group/GID/UID drop. Branch-sourced root data blocks enablement until these named tests pass. Branch-sourced code remains forbidden. The complete input-by-input inventory is T-SEC-01's “Root steps, inputs and sources”; this ticket must not extend it without smithers-3f review.

## Ready checklist
1. Dependencies name placement, runtime admission/capacity, install storage, authority/catalog, Settings/Home integration, isolated launcher/flow execution, non-root users and root validation; all required phases are S2 or earlier. Scope defines fail-closed dark landing for every unlanded dependency.
2. Out excludes a second scheduler/queue/table, capacity detection and release policy, preemption, lane and per-person controls, CLI/skill doors, new Views, toolchains/images and root helpers.
3. C-STK-02 names production install routes, dispatcher, engine, terminal-open and live projections; C-UI-13 covers the mounted card seam. Literal fixtures supply independent expectations; direct calls are unit coverage only.
4. Decisions assigns Go/runtime/security to smithers-3f, app/public API to smithers-b8, TypeScript contracts to smithers-38, View props to smithers-06, cross-owner disputes to smithers-8a and product changes to Will/product agent.
5. Owner pre-review (owners review post hoc under the parallel-build directive): smithers-3f: Does accounting reuse the runtime queue and retain every holder until confirmed release? Does a lowered limit stop grants without preemption? smithers-b8: Does settings.parallel use the owner-only install dispatcher with no legacy bypass? smithers-38: Do existing card schemas represent effective 0 and live positions without a second contract? smithers-06: Can the existing Settings/Home Views render these fields through their current action and prop seams?
6. Execution preconditions require machine-only non-root repository work; smithers-3f reviews the reused root-input inventory. C-SEC-02's three named tests validate branch/member data before privileged use; branch-built root code and host fallback stay forbidden.

