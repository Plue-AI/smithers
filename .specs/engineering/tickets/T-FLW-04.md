# T-FLW-04 Coding host loads the pinned closure by digest

Stage S1 · Size M · Depends on T-FLW-03, T-STK-01, T-FLW-11, T-COL-02 · Unblocks T-APP-05, T-FLW-05, T-FLW-13, T-MNT-02, T-MNT-04, T-REL-02, T-STK-01, T-STK-05 · Issue: [#3512](https://github.com/smithersai/smithers/issues/3512)
Spec: spec.md §3 (`mythical_items.flow_digest`), §4.1, §10.4.1, §11.3.0, §11.4 · Delta: delta.md §8 (pinning row), §11 (#3377 row) · Product: mvp.md J5.4, §6.12 Pinned versions

## Goal
A TODO run executes exactly the Active flow version recorded when the TODO entered Starting, keeps it across Resume and ordinary Retry, pins the Active version only for an explicit Retry with the current flow, and never runs the `flows/` in its own branch's working copy.

## Scope
- `stack.propose` refuses a run with no TODO (`not_a_todo_run`), so a draft-version `todo` run ends before proposing (§11.4.3). Check: C-J11-02.

In:
- At the `queued → starting` transition (a machine granted, §4.1), record `(flow_name, digest)` of the Active `todo` version on the TODO, the attempt and the run checkpoint. With T-FLW-11, one run per attempt carries the whole TODO, so one digest covers it.
- The coding host in the TODO's branch machine fetches the closure blob by digest from the host, verifies it, and restores it with `ExecutionSnapshot.restore`. It never registers the working copy's `flows/` for a TODO run.
- The coding host resolves the closure's imports only from the blob: closure modules from it, and third-party packages from its dependency environment, unpacked once per machine under `/var/lib/smithers/flow-env/<lockfile digest>`. Restore checks the lockfile digest against that environment, never the working copy (`ExecutionSnapshot.ts:138-142`), so a branch that edits an imported helper or the lockfile still runs its pinned version (§11.4.1).
- Resume continues the same run on its checkpoint digest, and Retry starts a new run of the same pinned digest. Retry with the current flow starts a new attempt on the Active version and keeps the earlier attempt and evidence (§4.1, §10.7.1; T-STK-05).
- A scratch-branch Run of the working-copy version is labeled "draft version" and can never be a TODO run (§11.4.3).

Out:
- #3377 (concurrent pinned versions in one host) isn't needed and isn't touched. Each TODO's branch machine runs its own coding host, which loads its run's closure by digest, so two versions of one flow run at once in two machines (§11.4.2).
- Version loading and activation (T-FLW-03); the seed patch (T-FLW-05); the `todo` composition (T-FLW-11).
- The draft-run monitor view (T-FLW-07).
- Host execution, dependency resolution from the working copy and silent version upgrades on ordinary Retry or Resume.

## Changes
- Reuse `packages/smithers/agent/registry/src/ExecutionSnapshot.ts:61` (`Manifest`: `executionDigest`, `entry`, `modules`, `lockfileDigest`) as the pinned-closure record. No second manifest, digest algorithm or pinning library (minimal-code synthesis, 2026-10-03, v2 reuse).
- Stack engine admission (`packages/backend/internal/services/mythical_items.go`, the `todo` launch T-FLW-11 replaces at `:1681`) → read the Active `flow_versions` row for `todo` (T-FLW-03) and write `mythical_items.flow_name`, `mythical_items.flow_digest` (T-STK-01) and the attempt's digest in the transaction that moves the TODO to `starting`. With no Active version, refuse with class `infra` and never fall back to the working copy.
- `packages/backend/flowdispatch/types.go:63-85` (`RuntimeCheckpoint`) → `ExecutionDigest` is set from the pinned digest at launch, not from what the host reports later.
- Coding host start in the machine (`flows/coding/host.ts`, `flows/repository/registry.ts:377-388` `loadBody`) → for a TODO run, build the registry from the restored closure only. A digest mismatch fails with the existing `execution_changed` code.
- Closure fetch → `GET` of the T-FLW-03 blob route with the run credential; verify each blob's SHA-256 address before import, then restore through `packages/smithers/agent/registry/src/ExecutionSnapshot.ts:152-160`.
- Retry (T-STK-05) → the new attempt copies the previous attempt's pinned digest. Only explicit Retry with the current flow selects the Active digest for the new attempt. Resume reuses the run's checkpoint digest; earlier attempts are unchanged.
- Run projection (`run:<id>`) and TODO card → expose `flow_name`, `digest` and the version's source commit (§11.4.1). Label a scratch-branch run of a working-copy flow "draft version".
- No OpenAPI change beyond T-FLW-03's routes.

## Tests

- Landing integration, `packages/backend/flowhost/pinned_closure_integration_test.go`: prove pinned closure loading and restoring through T-FLW-11's production one-run admission and flowdispatch worker before T-STK-05 lands. Run the reference-host variant through T-INS-02's real microVM launcher, fetch through T-FLW-03's served blob route, and read `run:<id>` and `todo:<n>` from `/api/live`. Process-runtime cases remain component coverage. After T-STK-05 lands, qualify Stop, Resume, Retry and Retry with the current flow through served `/api/todos` routes; those control-door cases remain pending until then. Checks: C-J5-01, C-STK-03, C-SEC-02.
- Add missing/corrupt blob and wrong-run credential cases: no repository import and no working-copy fallback. Literal fixture source, error envelopes and attempt/version relationships supply expectations; no test reads spec files or uses production pin/restore code to compute its expected result.
- Integration (real PostgreSQL, test process runtime), `packages/backend/flowhost/pinned_closure_integration_test.go` (new): a TODO enters `starting` on v1; v2 activates mid-run; the run's resume and a Retry both load v1's digest; a new TODO pins v2 at its own `starting`.
- Integration, same file: a TODO still `queued` when v2 activates pins v2, since the pin happens at `starting`, not at placement.
- Integration, same file: the TODO's branch working copy contains a modified `flows/todo/flow.ts` that writes a marker on import; the marker never appears, and the run's digest is v1.
- Integration, same file: the TODO's branch edits a helper `flows/todo/flow.ts` imports from `lib/` and changes `pnpm-lock.yaml`, then fails. Its Retry restores v1 with no `lockfile_changed` failure, and the marker the edited helper writes never appears.
- Unit, `packages/smithers/agent/registry/test/ExecutionSnapshot.test.ts` (extend): a fetched blob whose bytes don't hash to its address is refused before restore.
- Unit, `packages/backend/internal/services/mythical_items_test.go` (extend): admission with no Active `todo` version refuses with `infra` and starts no run.
- Fault: kill the machine after v2 activates; the resumed run still pins v1 (shared harness with [C-DUR-02](../checks/C-DUR-02.md)).

## Acceptance



- [C-J11-02](../checks/C-J11-02.md): S2, S3 qualification; does not block S1 completion.


- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J11-02](../checks/C-J11-02.md): Source opens the flow on the proposing TODO's branch, and a scratch-branch Run is a "draft version" that never proposes.

- [C-J5-01](../checks/C-J5-01.md): landing proves production admission pins v1, restores it while v2 activates and pins v2 for a new TODO at Starting; the TODO that edits the flow runs v1. Resume/Retry and Retry with the current flow qualification remains pending until T-STK-05 lands; it does not block loader landing. Check: C-STK-03.

## Risks and notes
- Resolved: the closure carries its dependency environment (§11.3.0, §11.4.1), so restore never reads the branch's `node_modules` or lockfile (`ExecutionSnapshot.ts:64` `lockfileDigest`, `:141-142`).

## Ready checklist
1. Dependencies: T-FLW-03 supplies Active versions and closure routes; T-FLW-11 supplies production one-run admission, the flowdispatch worker and transitively the microVM launcher; T-COL-02 supplies run/TODO topics; T-STK-01 supplies records. T-STK-05 consumes the pinned loader and later supplies real Resume/Retry doors; its control-door cases remain pending until it lands and do not block this loader's landing. Checks: C-J5-01, C-STK-03.
2. Exclusions: Out excludes single-host concurrent versions, activation, seed patches, composition and monitor visuals; also excludes host execution, working-copy dependency fallback and silent upgrades during ordinary Retry or Resume.
3. Boundary tests: production one-run admission and flowdispatch worker → served blob fetch → machine restore → live topics qualify landing. Served Stop/Resume/Retry control routes qualify after T-STK-05 lands and remain pending until then. C-J5-01/C-STK-03 use literal fixtures; C-SEC-02 qualifies isolation. No runtime spec or production-derived oracle.
4. Decisions: smithers-3f accepts the admission transaction, attempt/checkpoint identity and retry handoff; smithers-38 accepts restore/environment integrity and the digest contract; smithers-b8 signs off projected public fields; smithers-06 accepts their TODO View seam. Will through smithers-8a decides any pinning policy change.
5. Owner pre-review before start: smithers-3f: Is the pin written atomically at Starting and preserved on ordinary Retry/Resume? Does explicit current-flow Retry retain earlier attempt evidence? smithers-38: Can restore resolve every import without consulting the working copy and refuse corrupt bytes before import? smithers-b8: Do run/TODO schema fields expose the pinned version consistently? smithers-06: Can the existing TODO View consume those fields without a visual change in this ticket?
6. Security: T-INS-02/T-FLW-01 enforce machine-only repository execution before launch. Fetch uses the run credential; verify blob addresses and environment identity before importing; missing, corrupt or unauthorized closures fail closed without working-copy or host fallback. smithers-3f reviews, with smithers-38 reviewing restore integrity; C-SEC-02 and pinned-closure integration prove this.

