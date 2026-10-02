# T-FLW-04 Coding host loads the pinned closure by digest

Stage S1 · Size M · Depends on T-FLW-03, T-STK-01, T-FLW-11 · Unblocks T-MNT-02, T-MNT-04 · Issue: to file
Spec: spec.md §3 (`todos.flow_name`, `todos.flow_digest`), §4.1, §10.4.1, §11.3.0, §11.4 · Delta: delta.md §8 (pinning row), §11 (#3377 row) · Product: mvp.md J5.4, §6.12 Pinned versions

## Goal
A TODO run executes exactly the Active flow version recorded when the TODO entered Starting, keeps it across resume and retry, and never runs the `flows/` in its own branch's working copy.

## Scope
- `stack.propose` refuses a run with no TODO (`not_a_todo_run`), so a draft-version `todo` run ends before proposing (§11.4.3). Check: C-J11-02.

In:
- At the `queued → starting` transition (a machine granted, §4.1), record `(flow_name, digest)` of the Active `todo` version on the TODO, the attempt and the run checkpoint. With T-FLW-11, one run per attempt carries the whole TODO, so one digest covers it.
- The coding host in the TODO's branch machine fetches the closure blob by digest from the host, verifies it, and restores it with `ExecutionSnapshot.restore`. It never registers the working copy's `flows/` for a TODO run.
- The coding host resolves the closure's imports only from the blob: closure modules from it, and third-party packages from its dependency environment, unpacked once per machine under `/var/lib/smithers/flow-env/<lockfile digest>`. Restore checks the lockfile digest against that environment, never the working copy (`ExecutionSnapshot.ts:138-142`), so a branch that edits an imported helper or the lockfile still runs its pinned version (§11.4.1).
- Resume continues the same run on its checkpoint digest, and Retry starts a new run of the same pinned digest (§4.1, §11.4.2).
- A scratch-branch Run of the working-copy version is labeled "draft version" and can never be a TODO run (§11.4.3).

Out:
- #3377 (concurrent pinned versions in one host) isn't needed and isn't touched. Each TODO's branch machine runs its own coding host, which loads its run's closure by digest, so two versions of one flow run at once in two machines (§11.4.2).
- Version loading and activation (T-FLW-03); the seed patch (T-FLW-05); the `todo` composition (T-FLW-11).
- The draft-run monitor view (T-FLW-07).

## Changes
- Stack engine admission (`packages/backend/internal/services/mythical_items.go`, the `todo` launch T-FLW-11 replaces at `:1681`) → read `flow_activations` for `todo` and write `todos.flow_name`, `todos.flow_digest` and the attempt's digest in the transaction that moves the TODO to `starting`. With no Active version, refuse with class `infra` and never fall back to the working copy.
- `packages/backend/flowdispatch/types.go:63-85` (`RuntimeCheckpoint`) → `ExecutionDigest` is set from the pinned digest at launch, not from what the host reports later.
- Coding host start in the machine (`flows/coding/host.ts`, `flows/repository/registry.ts:377-388` `loadBody`) → for a TODO run, build the registry from the restored closure only. A digest mismatch fails with the existing `execution_changed` code.
- Closure fetch → `GET` of the T-FLW-03 blob route with the run credential; verify the SHA-256 address before `restore` (`ExecutionSnapshot.ts:156`).
- Retry (T-STK-05) → the new `todo_attempts` row copies the TODO's pinned digest. Resume reuses the run's checkpoint digest.
- Run projection (`run:<id>`) and TODO card → expose `flow_name`, `digest` and the version's source commit (§11.4.1). Label a scratch-branch run of a working-copy flow "draft version".
- No OpenAPI change beyond T-FLW-03's routes.

## Tests
- Integration (real PostgreSQL, test process runtime), `packages/backend/flowhost/pinned_closure_integration_test.go` (new): a TODO enters `starting` on v1; v2 activates mid-run; the run's resume and a Retry both load v1's digest; a new TODO pins v2 at its own `starting`.
- Integration, same file: a TODO still `queued` when v2 activates pins v2, since the pin happens at `starting`, not at placement.
- Integration, same file: the TODO's branch working copy contains a modified `flows/todo/flow.ts` that writes a marker on import; the marker never appears, and the run's digest is v1.
- Integration, same file: the TODO's branch edits a helper `flows/todo/flow.ts` imports from `lib/` and changes `pnpm-lock.yaml`, then fails. Its Retry restores v1 with no `lockfile_changed` failure, and the marker the edited helper writes never appears.
- Unit, `packages/smithers/agent/registry/test/ExecutionSnapshot.test.ts` (extend): a fetched blob whose bytes don't hash to its address is refused before restore.
- Unit, `packages/backend/internal/services/mythical_items_test.go` (extend): admission with no Active `todo` version refuses with `infra` and starts no run.
- Fault: kill the machine after v2 activates; the resumed run still pins v1 (shared harness with [C-DUR-02](../checks/C-DUR-02.md)).

## Acceptance
- [C-J11-02](../checks/C-J11-02.md): Source opens the flow on the proposing TODO's branch, and a scratch-branch Run is a "draft version" that never proposes.

- [C-J5-01](../checks/C-J5-01.md): a TODO running before activation and its retry keep v1; TODOs that reach Starting after activation pin v2; the TODO that edits the flow runs v1.

## Risks and notes
- Resolved: the closure carries its dependency environment (§11.3.0, §11.4.1), so restore never reads the branch's `node_modules` or lockfile (`ExecutionSnapshot.ts:64` `lockfileDigest`, `:141-142`).
