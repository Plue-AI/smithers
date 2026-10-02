# T-FLW-03 `flow-load`, versions, activation; keep previous on failure (`Executable.ts:2036`)

Stage S1 · Size L · Depends on T-FLW-01, T-GH-02, T-FLW-11 · Unblocks T-FLW-04, T-FLW-05, T-APP-05 · Issue: to file
Spec: spec.md §3 (`flow_versions`, `flow_activations`), §4.3, §6.3 `/api/flows`, §7.2 `flows`, §10.4.1a, §11.1.1, §11.3 · Delta: delta.md §8 (flow-load row) · Product: mvp.md J5.3, §6.12 Flow card and Pinned versions, M-04

## Goal
When `main` moves with a change under `flows/**` or `.smithers/**`, the install loads every overridable flow in an ephemeral machine, and the Flow card shows a version as Active only after it loaded. A version that fails to load leaves the previous one Active and shows the error. One digest pins a flow together with every overridable flow it imports.

## Scope
In:
- Trigger (§11.3.1): the GitHub sync reports `main` moved and the diff touches `flows/**` or `.smithers/**`. Any other move starts no load.
- One background `flow-load` run per such commit, a system flow (§11.1.1), in an ephemeral machine at that commit. It loads, typechecks and digests every overridable flow, the `todo` composition included (§10.4.1a, T-FLW-11), and uploads each content-addressed closure to the host.
- Closure (§11.3.0): a flow's closure includes every overridable flow it imports, so a `todo` version's one digest also pins the `review` flow it calls (J5.4). A later `review` activation never changes a pinned `todo` run.
- One `flow_versions` row per flow per commit with `loaded` or `failed{error}`; the activation rules of §11.3.2 and §4.3.
- The `flows` projection and `GET /api/flows`: versions with state `active|proposed|merged-syncing|merged-failed|previous`, the error, steps, and the TODO for a proposed version (§11.3.3).
- The registry fix: a failed refresh keeps the previous executable.

Out:
- Loading the pinned closure for a run (T-FLW-04); `/flow.edit` (T-FLW-05); the Flow card UI (T-APP-05).
- Admission through `machine_requests` with class `background` (T-MCH-06, S2). In S1 the run takes an ephemeral machine from today's runtime.
- Triggers ([D] spec §11.7).

## Changes
- Migration (new) → `flow_versions` and `flow_activations` exactly as §3; unique `(flow_name, digest)`; `source_commit` indexed.
- `packages/backend/internal/services/flow_versions.go` (new) → `OnMainMoved(commit, changedPaths)`, registered beside `SetMainMoved` (`packages/backend/internal/services/github_main_pull.go:139`, wired at `internal/compose/main.go:902`). It admits one run per commit whose changed paths match `flows/**` or `.smithers/**`, idempotent by commit id.
- Flow `system/flow-load` (new, packaged, system) → runs in the coding host in the machine. For each overridable name it builds the catalog, pins with `ExecutionSnapshot.pin` (`packages/smithers/agent/registry/src/ExecutionSnapshot.ts:45`) over the flow and the overridable flows it imports, and returns `{name, digest, status, error?, steps[]}`. Each closure uploads by execution digest to the host blob store over the machine connection with the run credential. Its Appendix C row (`.specs/product/actions.md`, with its Inspect rendering) lands in the same change (§6.1.2).
- Activation in one transaction with a `projection_events` row (§3.1): a `loaded` version from a commit newer than the Active one's replaces it and records `previous_version_id`; `failed` changes nothing in `flow_activations`. An older commit's result never replaces a newer Active version.
- `packages/smithers/agent/registry/src/Executable.ts:2036-2037` → on `Failure`, keep the previous executable registered and its scope held; record the refusal in `catalog.refused` beside it. Only `Removed` (`:2065-2070`) retires an entry.
- `GET /api/flows` (catalog with versions) and the `flows` topic → OpenAPI rows in `docs/api/openapi/` in the same change, checked by `packages/backend/internal/compose/openapi_conformance_test.go`.
- Blob routes for closures (upload by `flow-load`, fetch by T-FLW-04) → the same OpenAPI rule; machine and run credentials only.

## Tests
- Unit, `packages/smithers/agent/registry/test/ExecutableRefresh.test.ts` (extend): "edit breaks an existing flow". Load X, rewrite it with a type error, and `refresh.flow("X")` returns `Refused`; `catalog.executables` still holds X with its first digest, and `catalog.refused` names X. The existing case at `:240` (a never-loaded flow stays out) still passes.
- Unit, `ExecutionSnapshot` (extend): changing only `flows/review/flow.ts` changes the `todo` digest; a closure blob of `todo` contains the `review` source it imports.
- Unit, `packages/backend/internal/services/flow_versions_test.go` (new): the activation table. A newer loaded version activates; a failed one keeps the previous; out-of-order completion of an older commit never activates; a repeated result for the same `(name, digest)` is a no-op.
- Integration (real PostgreSQL, fake GitHub, test process runtime), `packages/backend/internal/services/flow_load_integration_test.go` (new): `main` moves with `flows/todo/flow.ts` changed → one run and one row per overridable flow; a move touching only `.smithers/machine.json` → one run; a move touching only `src/` → no run; a broken flow → a `failed` row, unchanged activation, and a `flows` delta with `merged-failed` and the error text.
- Integration: a `todo` run pinned before a new `review` version activates keeps calling its pinned `review`.
- e2e and integration via the checks below.

## Acceptance
- [C-J5-01](../checks/C-J5-01.md): a merged flow edit shows "Merged · active after sync" until load, then Active.
- [C-J5-02](../checks/C-J5-02.md): a broken flow merge leaves the previous version Active and shows the load error.

## Risks and notes
- Risk: a change outside `flows/**` and `.smithers/**`, such as a shared module or `package.json`, alters a repository flow's closure without a load. §11.3.1 accepts this: the next qualifying move reloads. Confirmed if a commit touching only `packages/x` changes an execution digest computed by hand; escalate before widening the trigger.
- Risk: a `flow-load` machine competes with TODO machines in S1 under today's fixed runtime cap (`packages/backend/microsandbox/runtime.go:533-541`). Observed as a `capacity` refusal during load. T-MCH-06's admission and the spare machine of the default `parallel` (S2, §10.3.1) resolve it.
- "Proposed" needs the open TODOs' changed paths. Take them from the stack engine's candidate diff, not from the working copy.
