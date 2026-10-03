# T-FLW-03 `flow-load`, versions, activation; keep previous on failure (`Executable.ts:2036`)

Stage S1 · Size M · Depends on T-FLW-01, T-GH-02, T-FLW-11, T-ACC-03, T-COL-02, T-CAT-01, T-INS-02, T-SEC-01 · Unblocks T-AGT-04, T-APP-01, T-APP-05, T-FLW-04, T-FLW-05, T-FLW-06, T-FLW-08, T-FLW-09, T-FLW-13, T-GH-07, T-MNT-01, T-MNT-02, T-REL-02, T-REL-03, T-STK-05 · Issue: [#3511](https://github.com/smithersai/smithers/issues/3511)
Spec: spec.md §3 (`workflow_definitions`), §4.3, §6.3 `/api/flows`, §7.2 `flows`, §10.4.1a, §11.1.1, §11.3 · Delta: delta.md §8 (flow-load row) · Product: mvp.md J5.3, §6.12 Flow card and Pinned versions, M-04
Ready: 2026-10-03 smithers-8a sha256:f1c725372a0e

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
- Dark landing: build against the named contracts while dependencies are unlanded. Keep load admission and activation disabled until T-FLW-01 (catalog, guest binding and approved packaged artifacts), T-INS-02 (bundled microVM launcher), T-FLW-11 (built-in composition) and T-SEC-01 (root validation) are available and C-SEC-02 passes. Do not wire the poll callback until T-GH-02 is available. Keep the served catalog and flows topic disabled until T-ACC-03, T-COL-02 and T-CAT-01 supply authorization, live publication and descriptors; missing providers refuse without host execution or activation writes. Enable each seam only after its production integration cases pass (C-J5-01, C-J5-02, C-SEC-02).

Out:
- Loading the pinned closure for a run (T-FLW-04); `/flow.edit` (T-FLW-05); the Flow card UI (T-APP-05).
- Admission through the runtime queue with class `background` (T-MCH-06, S2). In S1 the run takes an ephemeral machine from today's runtime.
- Triggers ([D] spec §11.7).
- Loading or typechecking repository modules on the host, a second flow catalog and native-addon platform fallback.
- New runtime, loader, snapshot store or activation table; branch-built root artifacts, root dependency installation and on-demand image/layer builds. Reuse an approved main-pinned base image and install-shipped coding host; install repository dependencies only as the unprivileged guest user.

## Changes
- Extend `workflow_definitions` with source_commit, digest, status and load_error, and version uniqueness per repository/name/digest; retain prior rows. `is_active` selects the newest loaded row.
- Reshape `packages/backend/internal/services/workflow_sync.go:260` (`PersistDefinitions`) for version persistence and activation, retaining its provenance and stale-head guards. Wire `packages/backend/internal/services/github_main_pull.go:139` (`SetMainMoved`) to fan out to the coalesced load and the existing stack listener; this setter belongs to the poll service, not workflow_sync. Replace the install composition’s host parser path with guest evaluation; repository evaluation runs only in the ephemeral machine.
- Reshape the existing guest launcher, registry discovery and `packages/smithers/agent/registry/src/ExecutionSnapshot.ts` pinning for the packaged flow-load operation; return name, digest, status, error and steps. Reuse workflow_sync persistence and previous-definition handling. No host import or blob route; no second loader or closure archive (delta §8).
- Activation commits in `PersistDefinitions`, then publishes through the existing broker. A failed or older result never replaces the newest loaded Active row.
- `packages/smithers/agent/registry/src/Executable.ts:2050-2052` → on `Failure`, keep the previous executable registered and its scope held; record the refusal in `catalog.refused` beside it. `Removed` (`:2081-2085`) retires an entry; a successful replacement transfers the scope. Update Refresh’s contract comment (`:1861`) in the same change.
- `GET /api/flows` (catalog with versions) and the `flows` topic → OpenAPI rows in `docs/api/openapi/` in the same change, checked by `packages/backend/internal/compose/openapi_conformance_test.go`.

## Tests

- Landing integration, `packages/backend/internal/services/flow_load_integration_test.go`: serve the install composition with real PostgreSQL and fake GitHub; move `main` through its production poll worker, not `OnMainMoved` directly. Observe the admitted `system/flow-load` run, its microVM, the served `GET /api/flows`, and subscribed `flows` deltas. Repeat coalescing, helper-only, lockfile-only, failed-load and out-of-order cases through that path. Assert machine-only evaluation and authorized metadata reads. Checks: C-J5-01, C-J5-02, C-SEC-02.
- Literal fixture commits, version relationships, steps and error envelopes are the oracles. Tests never parse spec files or generate expected activation state through production activation or digest code; digest coverage tests compare controlled fixture mutations.
- Unit, `packages/smithers/agent/registry/test/ExecutableRefresh.test.ts` (extend): "edit breaks an existing flow". Load X, rewrite it with a type error, and `refresh.flow("X")` returns `Refused`; `catalog.executables` still holds X with its first digest, and `catalog.refused` names X. The existing case at `:241` (a never-loaded flow stays out) still passes.
- Unit, `ExecutionSnapshot` (extend): changing only `flows/review/flow.ts` changes the `todo` digest; the pinned module list includes the imported `review` source. A helper under `lib/` imported by `flows/todo/flow.ts`, relative or through a workspace package, is in the closure, and changing it changes the digest; changing only the lockfile changes the version digest and not the execution digest.
- Unit, `packages/backend/internal/services/workflow_sync_test.go` (extend): the activation table. A newer loaded version activates; a failed one keeps the previous; out-of-order completion of an older commit never activates; a repeated result for the same `(name, digest)` is a no-op.
- Integration through the production poll worker, served routes and flows subscription (real PostgreSQL, fake GitHub, bundled microVM runtime; process-runtime coverage is supplemental only), `packages/backend/internal/services/flow_load_integration_test.go` (new): `main` moves with `flows/todo/flow.ts` changed → one run and one new row for `todo`; a move touching only `src/` files no flow imports → one run and no new row; a move changing a helper outside `flows/` that `flows/todo/flow.ts` imports → a new `todo` version; a lockfile-only move → a new version of every flow; three moves during one load → one more load, at the newest; a broken flow → a `failed` row, unchanged activation, and a `flows` delta with `merged-failed` and the error text.
- Integration: a `todo` run pinned before a new `review` version activates keeps calling its pinned `review`.
- Through the same production composition, remove each dependency provider named in the dark-landing Scope line: assert no load admission or activation writes, no metadata access without authorization and no host fallback; restore the provider and prove the positive case. C-J5-02 and C-SEC-02.
- C-SEC-02 drives fresh and retained machine startup and command dispatch with the root-input validation tests below, including approved-artifact positive controls.
- e2e and integration via the checks below.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J5-01](../checks/C-J5-01.md): a merged flow edit shows "Merged · active after sync" until load, then Active.
- [C-J5-02](../checks/C-J5-02.md): a broken flow merge leaves the previous version Active and shows the load error.
- [C-SEC-02](../checks/C-SEC-02.md): machine-only load evaluation, root-input validation and approved packaged artifacts, through the production microVM paths. Process-mode tests do not satisfy this gate.

## Risks and notes
- Resolved: every `main` move loads (§11.3.1), so a change outside `flows/**` can't leave a stale version Active.
- Risk: a load on every `main` move costs one ephemeral machine per load. Confirmed when loads queue behind TODO machines on the scorecard. Coalescing bounds it to one load at a time; escalate before narrowing the trigger.
- Risk: a dependency environment with native addons built for another platform. Confirmed when a restored closure fails to load a `.node` file on a branch machine. Load machines and branch machines boot the same pinned base image, so a mismatch is a load failure, not a fallback.
- Risk: a `flow-load` machine competes with TODO machines in S1 under today's fixed runtime cap (`packages/backend/microsandbox/runtime.go:542-548`). Observed as a `capacity` refusal during load. T-MCH-06's admission and the spare machine of the default `parallel` (S2, §10.3.1) resolve it.
- "Proposed" needs the open TODOs' changed paths. Take them from the stack engine's candidate diff, not from the working copy.

## Security preconditions and root inputs

M-29 and spec §1.3 apply to loading, typechecking and dependency install: run repository code only as an unprivileged machine user, with no sudo. smithers-3f reviews the following inputs and accepts C-SEC-02 receipts before enabling load admission. T-SEC-01 owns R1–R3; T-FLW-01’s approved-artifact follow-up owns R5. Branch-built scripts, binaries, interpreters, imports and toolchains never run as root, even if a digest matches. Branch/member data blocks privileged use until its named validation test passes.

- R1, helper install and privileged startup: helper bytes/digest, install/bootstrap script and fixed destination come from main embedded in the installed backend. msb/path, host environment/PATH/HOME, machine ID and deadlines come from install state. Image/layer/snapshot, shell, interpreter, env, hashing/file utilities, executable/import paths, helper/temp files and ancestor entries come from the approved main-pinned base or installed bundle; retained entries and cache/environment can be branch/member-controlled. OCI metadata/blob responses come from the registry for the install-pinned image. `TestGuestHelperInstallPinsInterpreterAndEnv` validates provenance, startup environment, ancestors and replacement resistance before fresh/retained root use.
- R2, setup and ownership: helper, setup argv (login, UID, directories) and HOME_LINKS/GO_SETTINGS come from main/install authority; passwd/group, useradd, shell, home and UID/GID come from approved image/account state. env.json keys/values (PATH, PYTHONPATH, Go settings, cache targets) come from main code with branch-derived toolchain data. Home/cache names, contents, ancestor/leaf symlinks and directory ownership/modes can come from branch dependency output or retained member state. Kernel filesystem results come from the guest OS but resolve those mutable entries. `TestRootSetupNeverFollowsMemberSymlinks` validates bounded settings, fixed identities and no-follow writes before use, including replacement races.
- R3, command supervision, file entry, cleanup and relay: request ID/fixed identity and envelope structure, exec/cleanup IDs, cgroup subtree and relay/probe ports/destination come from main/install authority. argv/env/cwd/root/stdin and file operation/path/content/mode/read-limit payloads, capture metadata and command results are branch/member data. Request directory/ancestors/files and descriptor state can contain retained branch/member entries; terminal sizes/signals come from transport. Startup env, helper/interpreter, passwd/group and directory state have R1/R2 sources. Cgroup files/state and fork/wait/signal/exit/filesystem/network responses come from the guest kernel, influenced by branch/member processes; relay bytes/peer responses can be branch/member-controlled. `TestRootPreflightParsesOnlyEnvelope` validates bounded envelopes, protected request parents, non-root identity, cgroup bounds and relay endpoints before use; apply command/file payloads only after supplementary-group/GID/UID drop.
- R5, managed coding-host artifacts: executable/helper bytes and expected catalog digest come only from the installed main-built bundle. Destination paths, ancestors, existing files/symlinks and retained workspace state can be branch/member-controlled; run/machine credential and launch bindings come from host install state. `TestRootManagedArtifactInstallUsesApprovedBundleOnly` and C-SEC-02’s production coding-binding/helper cases prove bundle provenance and bounded destinations before privileged use. No branch output is accepted as a root artifact.

## Ready checklist
1. Dependencies: the existing edges cover composition, polling, authorization, live publication and catalog contracts; explicit T-INS-02 and T-SEC-01 cover bundled machine execution and root validation. Unlanded contracts land dark as stated in Scope; they do not block Ready.
2. Exclusions: Out excludes runtime restoration, flow editing, visual Flow cards, S2 admission and triggers; also excludes host evaluation, a second catalog and native-addon platform fallback.
3. Boundary tests: the production poll worker, real microVM, served GET /api/flows and subscribed flows deltas use literal fixtures; missing-provider and root-input cases fail closed (C-J5-01, C-J5-02, C-SEC-02). No runtime spec or production-policy oracle.
4. Decisions: smithers-38 accepts closure discovery, digest/environment format and refresh scope lifetime; smithers-3f accepts activation ordering, callback fan-out and API credential scope; smithers-b8 signs off catalog/OpenAPI changes. Will, through smithers-8a, decides any narrowing of the every-main-move trigger.
5. Owner pre-review before start: smithers-38: Does a failed refresh retain the previous executable and scope? Does the closure include repository imports and lockfile digest? smithers-3f: Does callback wiring preserve the stack's existing MainMoved listener and authorize metadata reads? smithers-b8: Do the new tag and served routes have matching public contracts?
6. Security: the R1–R3 and R5 inventory above names each root input’s main/install or branch/member source and its C-SEC-02 validation gate; smithers-3f reviews. Repository evaluation and dependency install require an unprivileged machine user; branch-built root code is forbidden.
