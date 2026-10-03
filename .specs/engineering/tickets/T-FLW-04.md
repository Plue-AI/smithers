# T-FLW-04 Coding host loads the pinned closure by digest

Stage S1 · Size M · Depends on T-FLW-03, T-STK-01, T-FLW-11, T-COL-02, T-INS-02, T-FLW-01, T-SEC-01 · Unblocks T-AGT-04, T-APP-01, T-APP-05, T-FLW-05, T-FLW-13, T-MNT-02, T-MNT-04, T-REL-02, T-STK-05 · Issue: [#3512](https://github.com/smithersai/smithers/issues/3512)
Spec: spec.md §3 (`mythical_items.flow_digest`), §4.1, §10.4.1, §11.3.0, §11.4 · Delta: delta.md §8 (pinning row), §11 (#3377 row) · Product: mvp.md J5.4, §6.12 Pinned versions

## Goal
A TODO run executes exactly the Active flow version recorded when the TODO entered Starting, keeps it across Resume and ordinary Retry, pins the Active version only for an explicit Retry with the current flow, and never runs the `flows/` in its own branch's working copy.

## Scope
- `stack.propose` refuses a run with no TODO (`not_a_todo_run`), so a draft-version `todo` run ends before proposing (§11.4.3). Check: C-J11-02.

In:
- Build against the named dependency contracts and land dark while any provider is unavailable: T-STK-01 records, T-FLW-03 Active metadata, T-FLW-11 one-run admission, T-COL-02 projections, T-INS-02 microVM launch, T-FLW-01 isolation and T-SEC-01 root validation. Refuse TODO launch with class `infra` until the records, Active version and machine execution providers are available and C-SEC-02 passes; publish version fields only through the available live provider. Never substitute a process host, branch source or fabricated Active version. Qualification remains pending until the production providers pass their named checks. Checks: C-J5-01, C-SEC-02.
- At the `queued → starting` transition (a machine granted, §4.1), record `(flow_name, source_commit, digest)` of the Active `todo` version on the TODO, attempt and run checkpoint. T-FLW-11 supplies one run per attempt, so one pin covers the TODO. Check: C-J5-01.
- Enable the coding host in the TODO branch machine to load from the pinned source commit through `Registry.loadBody(name, digest)` (§11.4.1). Reuse machine-local `ExecutionSnapshot` pin/restore; never register the TODO working copy's `flows/`. Check: C-J5-01.
- Resolve imported repository modules and lockfiles from a separate immutable checkout of the pinned source commit inside the machine. Reuse the existing registry and snapshot root against that checkout, with dependencies resolved there as the unprivileged agent; `@smthrs/*` comes from the installed coding host (§11.3.0). Branch helper/lockfile edits and rebase never change that root. No closure archive or packaged dependency environment. Check: C-J5-01.
- Resume continues the same run on its checkpoint digest, and Retry starts a new run of the same pinned digest. Retry with the current flow starts a new attempt on the Active version and keeps the earlier attempt and evidence (§4.1, §10.7.1; T-STK-05).
- A scratch-branch Run of the working-copy version is labeled "draft version" and can never be a TODO run (§11.4.3).

Out:
- #3377 (concurrent pinned versions in one host) isn't needed and isn't touched. Each TODO's branch machine runs its own coding host, which loads its run's closure by digest, so two versions of one flow run at once in two machines (§11.4.2).
- Version loading and activation (T-FLW-03); the seed patch (T-FLW-05); the `todo` composition (T-FLW-11).
- The draft-run monitor view (T-FLW-07); TODO View changes (T-APP-02/T-UI-04).
- Closure archives, blob routes, packaged dependency environments, new manifests or digest algorithms, privileged dependency installs and new root execution paths (§11.3.0, delta.md §8).
- Host execution, dependency resolution from the working copy and silent version upgrades on ordinary Retry or Resume.

## Changes
- Reuse `packages/smithers/agent/registry/src/ExecutionSnapshot.ts:62-70` (`Manifest`) and `:171` (`restore`), plus `packages/smithers/agent/registry/src/Registry.ts:392-440` (`loadBody`). Point their existing root at the pinned source checkout. No second manifest, digest algorithm, pinning library or closure archive (delta.md §8).
- Reshape stack engine admission (`packages/backend/internal/services/mythical_items.go:1681`, replaced by T-FLW-11) to read Active `todo` metadata (T-FLW-03) and write `flow_name`, `source_commit` and `flow_digest` with the attempt pin in the transaction moving the TODO to `starting`. Reuse T-STK-01 records, not a new pin table. With no Active version, refuse with class `infra`; never fall back to branch source. Check: C-J5-01.
- `packages/backend/flowdispatch/types.go:63-85` (`RuntimeCheckpoint`) → `ExecutionDigest` is set from the pinned digest at launch, not from what the host reports later.
- Enable coding host start (`flows/coding/host.ts`, `flows/repository/registry.ts:438-449` `loadBody`) to bind TODO discovery, import resolution and snapshot restore to the pinned source checkout only. Preserve the existing `execution_changed` refusal on digest mismatch. Check: C-J5-01.
- Reuse the machine source materialization path to retain the pinned commit independently of the editable TODO checkout. Validate the run binding before materialization; unavailable source or mismatched digest refuses before repository import. No host evaluation, blob route or branch fallback. smithers-3f accepts the materialization/binding seam; smithers-38 accepts its registry root. Checks: C-J5-01, C-SEC-02.
- Retry (T-STK-05) → the new attempt copies the previous attempt's pinned digest. Only explicit Retry with the current flow selects the Active digest for the new attempt. Resume reuses the run's checkpoint digest; earlier attempts are unchanged.
- Reshape the existing `run:<id>` and TODO projections to expose `flow_name`, `digest` and pinned `source_commit`; T-APP-02/T-UI-04 consume them in the TODO card. Label a scratch-branch working-copy run "draft version" (§11.4.3). No View implementation here.
- Update existing public schemas/OpenAPI fields only where the pinned metadata crosses HTTP; smithers-b8 signs off that field contract. No new route.

## Tests

- Landing integration, `packages/backend/flowhost/pinned_closure_integration_test.go` (new): enter T-FLW-11 production one-run admission and the flowdispatch worker; use T-INS-02's real microVM launcher and pinned-commit registry loading; read `run:<id>` and `todo:<n>` through `/api/live`. The existing `workspace_crash_recovery_test.go` proves process lifecycle, not pinned source loading, so reuse its harness but add this production-boundary coverage. Process-runtime cases remain component coverage. Once T-STK-05 lands, qualify Stop, Resume, Retry and Retry-current through served `/api/todos` routes. Checks: C-J5-01, C-STK-03, C-SEC-02.
- Add unavailable pinned commit, corrupt source, digest mismatch and wrong-run binding cases through production admission/dispatch: no repository import and no branch fallback. Disable each named provider in turn and assert the dark-landing refusal and zero imports; a valid-provider case is the positive control. Literal source fixtures, error envelopes and attempt/version relationships supply expectations; no runtime spec read or production pin/restore oracle. Checks: C-J5-01, C-SEC-02.
- Integration (real PostgreSQL, test process runtime), `packages/backend/flowhost/pinned_closure_integration_test.go` (new): a TODO enters `starting` on v1; v2 activates mid-run; the run's resume and a Retry both load v1's digest; a new TODO pins v2 at its own `starting`.
- Integration, same file: a TODO still `queued` when v2 activates pins v2, since the pin happens at `starting`, not at placement.
- Integration, same file: the TODO's branch working copy contains a modified `flows/todo/flow.ts` that writes a marker on import; the marker never appears, and the run's digest is v1.
- Integration, same file: the TODO's branch edits a helper `flows/todo/flow.ts` imports from `lib/` and changes `pnpm-lock.yaml`, then fails. Its Retry restores v1 with no `lockfile_changed` failure, and the marker the edited helper writes never appears.
- Unit, `packages/smithers/agent/registry/test/ExecutionSnapshot.test.ts` (extend): reuse existing snapshot integrity cases; point restore at a pinned source checkout while a separate editable branch changes helper and lockfile bytes. Assert the literal original helper result and refusal of corrupt snapshot data before import.
- Unit, `packages/backend/internal/services/mythical_items_test.go` (extend): admission with no Active `todo` version refuses with `infra` and starts no run.
- S2 fault qualification: kill the machine after v2 activates; recovery keeps v1, through the real launcher and production worker. Share the C-DUR-02 harness with T-FLW-09/T-REL-04; it does not block the S1 loader landing. Check: [C-DUR-02](../checks/C-DUR-02.md).

## Acceptance

- [C-J11-02](../checks/C-J11-02.md): S2, S3 qualification; does not block S1 completion.


- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J11-02](../checks/C-J11-02.md): Source opens the flow on the proposing TODO's branch, and a scratch-branch Run is a "draft version" that never proposes.

- [C-J5-01](../checks/C-J5-01.md): landing proves production admission pins v1, restores it while v2 activates and pins v2 for a new TODO at Starting; the TODO that edits the flow runs v1. Resume/Retry and Retry with the current flow qualification remains pending until T-STK-05 lands; it does not block loader landing. Check: C-STK-03.

## Risks and notes
- Restore currently reads lockfiles from its configured root (`ExecutionSnapshot.ts:120-158`). Binding that root to the pinned source checkout is required; the editable TODO root cannot supply dependencies or lockfile identity. smithers-38 accepts this seam; C-J5-01 proves helper/lockfile edits do not affect Retry or Resume.

## Security preconditions and root inputs

Pinned-source checkout, dependency resolution, pin/restore and repository imports run only as the unprivileged agent inside the machine (M-29). This ticket adds no root step. It reuses T-INS-02/T-FLW-01 launch and T-SEC-01 guest bootstrap/setup/exec. smithers-3f reviews that boundary; smithers-38 reviews registry integrity. Root never executes branch-built code. Branch/member inputs below block enabling the loader until C-SEC-02 passes `TestGuestHelperInstallPinsInterpreterAndEnv` (R1), `TestRootSetupNeverFollowsMemberSymlinks` (R2) and `TestRootPreflightParsesOnlyEnvelope` (R3) through fresh and retained machines, with positive controls. Command argv/env/cwd and file payloads are consumed only after group/GID/UID drop. T-FLW-01's managed-artifact validation proves coding artifacts come from the approved install bundle, never branch output (`TestRootManagedArtifactInstallUsesApprovedBundleOnly`, C-SEC-02).

The reused root steps consume the following inputs (T-SEC-01 R1–R3 inventory):

### R1

Inputs:

- Helper bytes and expected digest, fixed `/opt/smithers/guest` destination and install script — **main**, embedded into the **install-controlled** backend.
- `msb` executable/path, host child environment/PATH/HOME, machine identifier, deadlines — **install-controlled** runtime configuration/state; executable provenance must remain bundle-controlled.
- Guest image or layer/snapshot, `/bin/sh`, `python3`, `sha256sum`, `cut`, `mkdir`, `cat`, `mv`, executable search paths, Python startup/import paths and existing helper/temporary-file/parent entries — **install-controlled** base; snapshots/cache/environment can contain **branch-derived** and **member-controlled** entries. Digest comparison alone does not validate parent ownership, symlinks, interpreter provenance or startup imports.
- OCI image pull/metadata/blob responses — **install-controlled** pinned image selection, upstream registry responses; retained snapshot data — **install-controlled** state with **branch/member-derived** contents where applicable.

### R2

Inputs:

- Setup argv (login, UID, directories), fixed HOME_LINKS/GO_SETTINGS, helper source — **main** constants today; future member login/UID bindings — **install-controlled** DB allocations derived from **GitHub/member** identities, not arbitrary user argv.
- `/etc/passwd`/group account entries, `useradd`, shell, existing home path and account UID/GID — **install-controlled** image/account state.
- `/opt/smithers/env.json`: all keys/values, including PATH, PYTHONPATH, Go settings, tool-cache targets — generated from **main** code and **branch-derived** toolchain selection; file ownership and immutability are separate inputs.
- `/var/cache/smithers/home` names/entries, cache directories, existing `.cache`, `.config`, `.config/go`, `.config/go/env`, all ancestor/leaf symlinks and directory metadata — **branch-derived** dependency output and **member-controlled** retained home state.
- Kernel/filesystem responses to mkdir/stat/open/chown/chmod and symlink operations — **install-controlled** guest OS; which object they address can be **member-controlled**.

### R3

Inputs:

- JSON request id, argv, env, cwd, root, user and stdin mode; operation/path/content/mode/read limit for fs — **main/install-controlled** envelope and fixed identity fields, with **branch/member-controlled** argv, environment values, relative paths, file bytes and existing symlink graph. Capture metadata and command results are **branch/member-controlled** outputs.
- `/opt/smithers/env.json`, helper/interpreter startup environment, passwd/group records and guest directory state — sources as R1/R2.
- Terminal request ID, `/run/smithers/requests` directory/ancestors, request `.json` bytes, ownership/mode, stdin/file descriptors, terminal size and signal inputs — **main/install-controlled** IDs and transport settings; request payload and retained filesystem entries can be **branch/member-controlled**. Protected no-follow request creation/read/removal and bounded parsing are proved by TestRootPreflightParsesOnlyEnvelope.
- Host-generated exec IDs; kill/kill-all names, child directories, cgroup.procs/kill/events and their observed state — **main/install-controlled** IDs and kernel cgroup state; a guest command influences process population. Any selectable path/name must be validated against the fixed subtree.
- Relay/probe port, fixed host.microsandbox.internal bridge destination, ws relay-port metadata — **main/install-controlled**; bytes flowing over relay/TCP and associated peer responses — **member/branch-controlled** or authenticated host data, depending on channel.
- Fork/wait/signal/exit observations, filesystem resolution and network responses — **install-controlled** kernel responses influenced by member processes/network traffic.


## Ready checklist
1. Dependencies: T-FLW-03 supplies Active metadata; T-STK-01 supplies records; T-FLW-11 supplies one-run admission; T-COL-02 supplies projections; T-INS-02, T-FLW-01 and T-SEC-01 supply machine launch, isolation and root validation. Scope names fail-closed dark landing for every unavailable provider. T-STK-05 control-door and S2 fault qualification remain pending until their owners land. Checks: C-J5-01, C-STK-03, C-SEC-02.
2. Exclusions: Out names concurrent versions in one host, activation, seed patches, composition, monitor/TODO visuals, host execution, branch dependency fallback, silent upgrades, closure archives/blob routes, packaged dependency environments and privileged installs. Reuse existing pin/restore and registry loading; add no pin table or digest algorithm.
3. Boundary tests: production one-run admission/flowdispatch → real microVM → pinned-commit Registry.loadBody → served live topics qualifies S1. Provider refusals have positive controls. Served control routes and C-J5-01 full activation journey remain pending until their providers land; fixtures do not qualify that e2e journey. All expectations use literal fixtures, never runtime spec reads or production-derived oracles. C-SEC-02 qualifies isolation/root validation.
4. Decisions: smithers-3f accepts the admission transaction, attempt/checkpoint identity and retry handoff; smithers-38 accepts restore/environment integrity and the digest contract; smithers-b8 signs off projected public fields; smithers-06 accepts their TODO View seam. Will through smithers-8a decides any pinning policy change.
5. Owner pre-review (post hoc under the parallel-build directive; recorded answers stand): smithers-3f: Is the Starting pin atomic and immutable across ordinary Retry/Resume? Does pinned-source materialization validate the run binding and stay unprivileged? Do root inputs pass the named C-SEC-02 tests? smithers-38: Does Registry.loadBody resolve helper imports and lockfiles only from the pinned checkout? Does missing/corrupt source fail before import? smithers-b8: Do public run/TODO fields expose the same pin without a new route? smithers-06: Can the existing TODO View consume those fields without a visual change here?
6. Security: Scope requires unprivileged machine-only repository execution and refuses unavailable isolation/root validation. The root inventory lists every inherited R1–R3 input and source; named C-SEC-02 tests validate branch/member data before privileged use. No branch-built root code or privileged dependency install is permitted. smithers-3f reviews the boundary and smithers-38 reviews pinned-root integrity. Checks: C-SEC-02, C-J5-01.

