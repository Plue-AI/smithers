# T-FLW-03 `flow-load`, versions, activation; keep previous on failure (`Executable.ts:2036`)

Stage S1 · Size M · Depends on T-FLW-01, T-GH-02, T-FLW-11, T-ACC-03, T-COL-02, T-CAT-01 · Unblocks T-APP-05, T-FLW-04, T-FLW-05, T-FLW-08, T-FLW-13, T-GH-07, T-MNT-02, T-REL-02, T-REL-03, T-STK-05 · Issue: [#3511](https://github.com/smithersai/smithers/issues/3511)
Spec: spec.md §3 (`workflow_definitions`), §4.3, §6.3 `/api/flows`, §7.2 `flows`, §10.4.1a, §11.1.1, §11.3 · Delta: delta.md §8 (flow-load row) · Product: mvp.md J5.3, §6.12 Flow card and Pinned versions, M-04

## Goal
When `main` moves, the install loads every overridable flow in an ephemeral machine, and the Flow card shows a version as Active only after it loaded. A version that fails to load leaves the previous one Active and shows the error. One digest pins a flow together with every repository module it imports, the overridable flows among them, and lockfile digest.

## Scope
In:
- Trigger (§11.3.1): every `main` move, whatever paths changed. Loads coalesce: at most one runs at a time, and when it ends the next starts at the newest commit not yet loaded.
- One background `flow-load` run per load, a system flow (§11.1.1), in an ephemeral machine at that commit. It loads, typechecks and digests every overridable flow, the `todo` composition included (§10.4.1a, T-FLW-11); return version metadata only.
- Pin repository modules and lockfile digests with `ExecutionSnapshot` (§11.3.0). Load dependencies inside the machine from the pinned source and lockfile. No closure upload or dependency archive.
- One `workflow_definitions` row per new digest with `loaded` or `failed{error}`, and nothing for a digest that already has a row; the activation rules of §11.3.2 and §4.3.
- The `flows` projection and `GET /api/flows`: versions with state `active|proposed|merged-syncing|merged-failed|previous`, the error, steps, and the TODO for a proposed version (§11.3.3).
- The registry fix: a failed refresh keeps the previous executable.

Out:
- Loading the pinned closure for a run (T-FLW-04); `/flow.edit` (T-FLW-05); the Flow card UI (T-APP-05).
- Admission through the runtime queue with class `background` (T-MCH-06, S2). In S1 the run takes an ephemeral machine from today's runtime.
- Triggers ([D] spec §11.7).
- Loading or typechecking repository modules on the host, a second flow catalog and native-addon platform fallback.

## Changes
- Extend `workflow_definitions` with source_commit, digest, status and load_error, and version uniqueness per repository/name/digest; retain prior rows. `is_active` selects the newest loaded row.
- Extend `workflow_sync.go`: `SetMainMoved` fans out to its coalesced load and the existing stack listener. `PersistDefinitions` is the sole activation writer; repository evaluation runs only in the ephemeral machine.
- Adapt the packaged load to run `ExecutionSnapshot.pin` in the machine and return name, digest, status, error and steps. Reuse `workflow_sync` persistence and previous-definition handling. No host import or blob route.
- Activation commits in `PersistDefinitions`, then publishes through the existing broker. A failed or older result never replaces the newest loaded Active row.
- `packages/smithers/agent/registry/src/Executable.ts:2036-2037` → on `Failure`, keep the previous executable registered and its scope held; record the refusal in `catalog.refused` beside it. Only `Removed` (`:2065-2070`) retires an entry.
- `GET /api/flows` (catalog with versions) and the `flows` topic → OpenAPI rows in `docs/api/openapi/` in the same change, checked by `packages/backend/internal/compose/openapi_conformance_test.go`.

## Tests

- Landing integration, `packages/backend/internal/services/flow_load_integration_test.go`: serve the install composition with real PostgreSQL and fake GitHub; move `main` through its production poll worker, not `OnMainMoved` directly. Observe the admitted `system/flow-load` run, its microVM, the served `GET /api/flows`, and subscribed `flows` deltas. Repeat coalescing, helper-only, lockfile-only, failed-load and out-of-order cases through that path. Assert machine-only evaluation and authorized metadata reads. Checks: C-J5-01, C-J5-02, C-SEC-02.
- Literal fixture commits, version relationships, steps and error envelopes are the oracles. Tests never parse spec files or generate expected activation state through production activation or digest code; digest coverage tests compare controlled fixture mutations.
- Unit, `packages/smithers/agent/registry/test/ExecutableRefresh.test.ts` (extend): "edit breaks an existing flow". Load X, rewrite it with a type error, and `refresh.flow("X")` returns `Refused`; `catalog.executables` still holds X with its first digest, and `catalog.refused` names X. The existing case at `:240` (a never-loaded flow stays out) still passes.
- Unit, `ExecutionSnapshot` (extend): changing only `flows/review/flow.ts` changes the `todo` digest; the pinned module list includes the imported `review` source. A helper under `lib/` imported by `flows/todo/flow.ts`, relative or through a workspace package, is in the closure, and changing it changes the digest; changing only the lockfile changes the version digest and not the execution digest.
- Unit, `packages/backend/internal/services/workflow_sync_test.go` (new): the activation table. A newer loaded version activates; a failed one keeps the previous; out-of-order completion of an older commit never activates; a repeated result for the same `(name, digest)` is a no-op.
- Integration (real PostgreSQL, fake GitHub, test process runtime), `packages/backend/internal/services/flow_load_integration_test.go` (new): `main` moves with `flows/todo/flow.ts` changed → one run and one new row for `todo`; a move touching only `src/` files no flow imports → one run and no new row; a move changing a helper outside `flows/` that `flows/todo/flow.ts` imports → a new `todo` version; a lockfile-only move → a new version of every flow; three moves during one load → one more load, at the newest; a broken flow → a `failed` row, unchanged activation, and a `flows` delta with `merged-failed` and the error text.
- Integration: a `todo` run pinned before a new `review` version activates keeps calling its pinned `review`.
- e2e and integration via the checks below.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J5-01](../checks/C-J5-01.md): a merged flow edit shows "Merged · active after sync" until load, then Active.
- [C-J5-02](../checks/C-J5-02.md): a broken flow merge leaves the previous version Active and shows the load error.

## Risks and notes
- Resolved: every `main` move loads (§11.3.1), so a change outside `flows/**` can't leave a stale version Active.
- Risk: a load on every `main` move costs one ephemeral machine per load. Confirmed when loads queue behind TODO machines on the scorecard. Coalescing bounds it to one load at a time; escalate before narrowing the trigger.
- Risk: a dependency environment with native addons built for another platform. Confirmed when a restored closure fails to load a `.node` file on a branch machine. Load machines and branch machines boot the same pinned base image, so a mismatch is a load failure, not a fallback.
- Risk: a `flow-load` machine competes with TODO machines in S1 under today's fixed runtime cap (`packages/backend/microsandbox/runtime.go:533-541`). Observed as a `capacity` refusal during load. T-MCH-06's admission and the spare machine of the default `parallel` (S2, §10.3.1) resolve it.
- "Proposed" needs the open TODOs' changed paths. Take them from the stack engine's candidate diff, not from the working copy.

## Ready checklist
1. Dependencies: T-FLW-11 supplies the built-in composition and transitively T-INS-02's launcher; T-GH-02 supplies main polling; T-ACC-03 supplies API authorization; T-COL-02 supplies the flows topic; T-CAT-01 supplies registration of the new tag.
2. Exclusions: Out excludes runtime restoration, flow editing, visual Flow cards, S2 admission and triggers; also excludes host evaluation, a second catalog and native-addon platform fallback.
3. Boundary tests: the production poll worker admits flow-load in a microVM; served flow routes and live deltas are asserted with literal fixture oracles (C-J5-01, C-J5-02, C-SEC-02).
4. Decisions: smithers-38 accepts closure discovery, digest/environment format and refresh scope lifetime; smithers-3f accepts activation ordering, callback fan-out and API credential scope; smithers-b8 signs off catalog/OpenAPI changes. Will, through smithers-8a, decides any narrowing of the every-main-move trigger.
5. Owner pre-review before start: smithers-38: Does a failed refresh retain the previous executable and scope? Does the closure include repository imports and lockfile digest? smithers-3f: Does callback wiring preserve the stack's existing MainMoved listener and authorize metadata reads? smithers-b8: Do the new tag and served routes have matching public contracts?
6. Security: T-INS-02/T-FLW-01 must already enforce microVM-only execution. Loading, typechecking and dependency installation run only in the ephemeral machine; the host stores bytes and activation data, never imports them.  smithers-3f reviews; C-SEC-02 and route integration qualify.

