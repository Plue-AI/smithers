# T-FLW-03 `flow-load`, versions, activation; keep previous on failure (`Executable.ts:2036`)

Stage S1 · Size L · Depends on T-FLW-01, T-GH-02, T-FLW-11, T-ACC-03, T-COL-02, T-CAT-01 · Unblocks T-APP-05, T-FLW-04, T-FLW-05, T-FLW-08, T-FLW-13, T-GH-07, T-GH-08, T-MNT-02, T-REL-02, T-REL-03, T-STK-05 · Issue: [#3511](https://github.com/smithersai/smithers/issues/3511)
Spec: spec.md §3 (`flow_versions`, `flow_activations`), §4.3, §6.3 `/api/flows`, §7.2 `flows`, §10.4.1a, §11.1.1, §11.3 · Delta: delta.md §8 (flow-load row) · Product: mvp.md J5.3, §6.12 Flow card and Pinned versions, M-04

## Goal
When `main` moves, the install loads every overridable flow in an ephemeral machine, and the Flow card shows a version as Active only after it loaded. A version that fails to load leaves the previous one Active and shows the error. One digest pins a flow together with every repository module it imports, the overridable flows among them, and its dependency environment.

## Scope
In:
- Trigger (§11.3.1): every `main` move, whatever paths changed. Loads coalesce: at most one runs at a time, and when it ends the next starts at the newest commit not yet loaded.
- One background `flow-load` run per load, a system flow (§11.1.1), in an ephemeral machine at that commit. It loads, typechecks and digests every overridable flow, the `todo` composition included (§10.4.1a, T-FLW-11), and uploads each content-addressed closure to the host.
- Closure (§11.3.0): every repository file the entry reaches, whatever the specifier (relative, package.json `imports`, tsconfig `paths`, workspace packages), the overridable flows it imports included. So a `todo` version's one digest also pins the `review` flow it calls (J5.4) and its helpers outside `flows/`. A later `review` activation never changes a pinned `todo` run. The closure blob also carries the dependency environment: the installed third-party packages the closure imports, with their dependencies, stored per file by content address. `@smthrs/*` packages come from the coding host. A version's digest covers the execution digest and the lockfile digest.
- One `flow_versions` row per new digest with `loaded` or `failed{error}`, and nothing for a digest that already has a row; the activation rules of §11.3.2 and §4.3.
- The `flows` projection and `GET /api/flows`: versions with state `active|proposed|merged-syncing|merged-failed|previous`, the error, steps, and the TODO for a proposed version (§11.3.3).
- The registry fix: a failed refresh keeps the previous executable.

Out:
- Loading the pinned closure for a run (T-FLW-04); `/flow.edit` (T-FLW-05); the Flow card UI (T-APP-05).
- Admission through `machine_requests` with class `background` (T-MCH-06, S2). In S1 the run takes an ephemeral machine from today's runtime.
- Triggers ([D] spec §11.7).
- Loading or typechecking repository modules on the host, a second flow catalog and native-addon platform fallback.

## Changes
- Migration (new) → `flow_versions` and `flow_activations` exactly as §3; unique `(flow_name, digest)`; `source_commit` indexed.
- `packages/backend/internal/services/flow_versions.go` (new) → `OnMainMoved(commit)`, registered through `SetMainMoved` (`packages/backend/internal/services/github_main_pull.go:139`, wired at `packages/backend/internal/compose/main.go:902`). Fan out to this service and the existing `mythicalService.MainMoved`; do not replace the stack listener. It admits a load for every move, coalesced to the newest commit not yet loaded, idempotent by commit id.
- Flow `system/flow-load` (new, packaged, system) → runs in the coding host in the machine. For each overridable name it builds the catalog, pins with `ExecutionSnapshot.pin` (`packages/smithers/agent/registry/src/ExecutionSnapshot.ts:45`) over the flow and every repository module it imports, and returns `{name, digest, status, error?, steps[]}`. Discovery treats an import that resolves inside the repository as a closure module, including the workspace packages it lists as `hostImports` today (`Descriptor.ts`). The pin packs the dependency environment: the installed package directories the closure's external imports reach, with their transitive dependencies. Each closure uploads by execution digest to the host blob store over the machine connection with the run credential. Its Appendix C row (`.specs/product/actions.md`, with its Inspect rendering) lands in the same change (§6.1.2).
- Activation in one transaction with a `projection_events` row (§3.1): a `loaded` version from a commit newer than the Active one's replaces it and records `previous_version_id`; `failed` changes nothing in `flow_activations`. An older commit's result never replaces a newer Active version.
- `packages/smithers/agent/registry/src/Executable.ts:2036-2037` → on `Failure`, keep the previous executable registered and its scope held; record the refusal in `catalog.refused` beside it. Only `Removed` (`:2065-2070`) retires an entry.
- `GET /api/flows` (catalog with versions) and the `flows` topic → OpenAPI rows in `docs/api/openapi/` in the same change, checked by `packages/backend/internal/compose/openapi_conformance_test.go`.
- Blob routes for closures (upload by `flow-load`, fetch by T-FLW-04) → the same OpenAPI rule; machine and run credentials only.

## Tests

- Landing integration, `packages/backend/internal/services/flow_load_integration_test.go`: serve the install composition with real PostgreSQL and fake GitHub; move `main` through its production poll worker, not `OnMainMoved` directly. Observe the admitted `system/flow-load` run, its microVM, the served `GET /api/flows`, and subscribed `flows` deltas. Repeat coalescing, helper-only, lockfile-only, failed-load and out-of-order cases through that path. Add blob-route tests using valid, wrong-run, revoked and non-machine credentials. Checks: C-J5-01, C-J5-02, C-SEC-02.
- Literal fixture commits, version relationships, steps and error envelopes are the oracles. Tests never parse spec files or generate expected activation state through production activation or digest code; digest coverage tests compare controlled fixture mutations.
- Unit, `packages/smithers/agent/registry/test/ExecutableRefresh.test.ts` (extend): "edit breaks an existing flow". Load X, rewrite it with a type error, and `refresh.flow("X")` returns `Refused`; `catalog.executables` still holds X with its first digest, and `catalog.refused` names X. The existing case at `:240` (a never-loaded flow stays out) still passes.
- Unit, `ExecutionSnapshot` (extend): changing only `flows/review/flow.ts` changes the `todo` digest; a closure blob of `todo` contains the `review` source it imports. A helper under `lib/` imported by `flows/todo/flow.ts`, relative or through a workspace package, is in the closure, and changing it changes the digest; changing only the lockfile changes the version digest and not the execution digest.
- Unit, `packages/backend/internal/services/flow_versions_test.go` (new): the activation table. A newer loaded version activates; a failed one keeps the previous; out-of-order completion of an older commit never activates; a repeated result for the same `(name, digest)` is a no-op.
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
1. Dependencies: T-FLW-11 supplies the built-in composition and transitively T-INS-02's launcher; T-GH-02 supplies main polling; T-ACC-03 supplies blob/API authorization; T-COL-02 supplies the flows topic; T-CAT-01 supplies registration of the new tag.
2. Exclusions: Out excludes runtime restoration, flow editing, visual Flow cards, S2 admission and triggers; also excludes host evaluation, a second catalog and native-addon platform fallback.
3. Boundary tests: the production poll worker admits flow-load in a microVM; served flow/blob routes and live deltas are asserted with literal fixture oracles (C-J5-01, C-J5-02, C-SEC-02).
4. Decisions: smithers-38 accepts closure discovery, digest/environment format and refresh scope lifetime; smithers-3f accepts activation ordering, callback fan-out and blob-route credential scope; smithers-b8 signs off catalog/OpenAPI changes. Will, through smithers-8a, decides any narrowing of the every-main-move trigger.
5. Owner pre-review before start: smithers-38: Does a failed refresh retain the previous executable and scope? Does the closure include repository imports and transitive dependency bytes? smithers-3f: Does callback wiring preserve the stack's existing MainMoved listener and authorize blobs to the correct run? smithers-b8: Do the new tag and served routes have matching public contracts?
6. Security: T-INS-02/T-FLW-01 must already enforce microVM-only execution. Loading, typechecking and dependency installation run only in the ephemeral machine; the host stores bytes and activation data, never imports them. Blob requests require machine/run authorization and verified content addresses. smithers-3f reviews; C-SEC-02 and blob-route integration qualify.

