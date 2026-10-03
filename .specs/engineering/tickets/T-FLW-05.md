# T-FLW-05 /flow.edit is a templated TODO request

Stage S1 · Size M · Depends on T-FLW-03, T-STK-02, T-CAT-01, T-FLW-11, T-FLW-04, T-APP-04 (confirmations), T-APP-16, T-APP-05, T-STK-01, T-ACC-03, T-APP-15, T-INS-02, T-FLW-01, T-MCH-10, T-SEC-01 · Unblocks T-FLW-06, T-REL-02 · Issue: [#3513](https://github.com/smithersai/smithers/issues/3513)
Spec: spec.md §1.3, §11.4, §11.5, §14.2.1 · Delta: delta.md §8 (Reuse /flow.edit row) · Product: mvp.md J5.1–J5.3, M-29, M-30
Ready: 2026-10-03 smithers-8a sha256:06297fecc997

## Goal
Show the proposed diff, then create an ordinary TODO with the request and diff as revision-1 context.

## Scope
In: /flow.edit, Make TODO and /flow.source through existing catalog and TODO paths.
- Land dark against each pending dependency's spec contract. T-FLW-03 supplies version/source resolution; T-STK-01/02 supply revision-1 storage and placement; T-CAT-01 supplies descriptors/dispatch; T-ACC-03 supplies authorization; T-APP-04 supplies confirmations; T-APP-16 supplies conversation context; T-APP-05 supplies Flow card actions; T-APP-15 supplies the read-only File card; T-FLW-11/04 supply built-in composition and pinned execution; T-INS-02/T-FLW-01/T-MCH-10/T-SEC-01 supply isolated execution and validated provisioning. Disable affected actions and refuse direct dispatch before TODO/context writes or execution when any required provider is unavailable. Missing confirmation consumers return `503 infra/confirmation_unavailable`. Never bypass authority, create a partial TODO or fall back to host execution. Enable each path only after its production-boundary tests pass. Checks: C-ACC-02, C-SEC-02 and the missing-provider cases below.
Out: patch storage/application, seed_patch columns or blobs, confinement validator, second proposal service, new TODO/context/confirmation stores, new flow loader or pinning service, direct main writes, merge/activation implementation, scratch Plan/Run, S2 terminal editing, S3 File-card co-editing, CLI/skill implementation, UI View implementation and root provisioning changes.

## Changes
- Reshape `apps/app/src/mainview/flows/entries/flow.ts:18` with the missing edit/source descriptors; reuse `entries/todo.ts:40` and its `todo.new` path, rather than adding a proposal service. Template /todo.new: Change flows/<name>/flow.ts: <request>; start from the built-in composition when no override exists.
- Extend `apps/app/src/mainview/cards/FlowContainer.tsx:23` through `cardActions` → `flowAction`, with `onAction(action.tag)` and `data-flow` in the supplied View (§14.2.1). Reuse `packages/rpc/src/FlowCard.ts` and T-APP-05's Flow projection contract; smithers-06 owns any required View change. Reuse T-STK-02's reshape of `packages/backend/internal/routes/mythical.go:293` and `services/mythical_file_todo.go:45`; do not add a second TODO writer. No new table, patch store or executable patch input.
- Quote the agent’s proposed diff in the prompt context. Keep ordinary placement and confirmation rules.
- /flow.source opens the proposing TODO’s file through T-APP-15 on that TODO’s branch; when no proposing TODO exists, use the same /flow.edit request path with no proposed diff. Preserve ordinary confirmation and placement rules. S1 is read-only; later editing remains with its phase owners.
- The coding agent derives and checks the change in its machine on the attempt’s pinned flow.

## Tests
- Extend `apps/app/src/mainview/flows/entries/todo.test.ts` and `cards/FlowContainer.test.tsx` for template/action coverage; these are supplemental. Acceptance uses the browser's registered /flow.edit and Make TODO dispatch through the production TODO create route and real PostgreSQL in C-J5-01: revision 1 retains literal request/diff context and default placement appends once. Tests use fixed prompts, file bytes, orders and refusal envelopes; none reads spec Markdown or derives expected policy from production code at runtime.
- At the same catalog/dispatcher and served TODO boundary, withhold each Scope provider in turn; assert disabled actions, refused direct dispatch, zero TODO/context writes and zero repository execution. Missing confirmations use the literal envelope above. Include valid-provider controls; dark refusal does not count as passing the full C-J5-01 journey.
- Through registered /flow.source, an existing proposing TODO opens its branch/file without creating another TODO. With none, the ordinary confirmed create path creates one TODO with no diff, then opens its File card. Use literal branch IDs and file paths. This S1 case is separate from C-J11-02's S2/S3 editing, Plan and Run journey.
- Repeated idempotency key returns the same TODO; changed payload refuses; another person cannot approve.
- Change the source before execution: the agent derives from the request and records the resulting change; no stored patch is applied.
- With no override, the machine creates flows/<name>/flow.ts from the built-in composition. No repository code executes on the host.

## Acceptance
- [C-J5-01](../checks/C-J5-01.md): proposed diff → ordinary TODO → merge → Active.
- [C-ACC-02](../checks/C-ACC-02.md): confirmation and idempotency.
- [C-SEC-02](../checks/C-SEC-02.md): machine-only execution.
- [C-J11-02](../checks/C-J11-02.md): Source integration at S2/S3 with its declared editing providers; not an S1 landing gate. S1 passes the production Source and missing-provider cases above. C-J5-01 merge/Active completes jointly with its loader, pinning, composition and card owners; dark landing claims only the covered refusal cases.

## Risks and notes
Proposed diffs are untrusted prompt context, not executable input. The machine derives the change from the request; neither the host nor a root step applies the proposed diff.
- smithers-b8 decides app command, confirmation and Source behavior and signs off public payload/refusal changes. smithers-3f decides persistence and security seams. smithers-38 signs off TypeScript library APIs under §21.1. smithers-06 decides View contracts; this ticket does not implement Views. smithers-8a accepts cross-owner seams; Will decides product changes. No ADR is introduced.
- Record owner pre-review questions before start. Recorded answers stand; unanswered reviews proceed post hoc under Will's 2026-10-03 directive. Pending dependencies do not block Ready; Scope guards block activation until integration checks pass.

## Security preconditions and root inputs
Repository source, proposed diffs and requests are data on the host. Repository flows, derivation, checks and file creation execute only as an unprivileged agent in a machine, without sudo (M-29). smithers-3f reviews the boundary and C-SEC-02 receipts. This ticket adds no root step. Induced machine creation, wake, file access and coding execution consume the existing R1–R5 inputs listed below, adopted from T-STK-12's audited inventory. Accepted root executables, scripts, interpreters, imports and toolchains must be main-pinned or install-bundle controlled; branch-built root payloads are forbidden regardless of digest equality.
Before enabling execution, require C-SEC-02 production fresh/retained-machine receipts for R1 `TestGuestHelperInstallPinsInterpreterAndEnv`, R2 `TestRootSetupNeverFollowsMemberSymlinks`, R3 `TestRootPreflightParsesOnlyEnvelope` (T-SEC-01), R4 `TestRootLayerInputsValidatedBeforeUse` (T-MCH-10's sec10 follow-up), and R5 `TestRootManagedArtifactInstallUsesApprovedBundleOnly` (T-FLW-01's follow-up). Branch/member-sourced data at root is an activation blocker until its named test proves validation before privileged use. R4 accepts the target index only from main, validates archive/destination/marker inputs, and runs dependency/toolchain repository work as agent. This ticket does not implement these providers.

#### R1

Inputs:

- Helper bytes and expected digest, fixed `/opt/smithers/guest` destination and install script — **main**, embedded into the **install-controlled** backend.
- `msb` executable/path, host child environment/PATH/HOME, machine identifier, deadlines — **install-controlled** runtime configuration/state; executable provenance must remain bundle-controlled.
- Guest image or layer/snapshot, `/bin/sh`, `python3`, `sha256sum`, `cut`, `mkdir`, `cat`, `mv`, executable search paths, Python startup/import paths and existing helper/temporary-file/parent entries — **install-controlled** base; snapshots/cache/environment can contain **branch-derived** and **member-controlled** entries. Digest comparison alone does not validate parent ownership, symlinks, interpreter provenance or startup imports.
- OCI image pull/metadata/blob responses — **install-controlled** pinned image selection, upstream registry responses; retained snapshot data — **install-controlled** state with **branch/member-derived** contents where applicable.

#### R2

Inputs:

- Setup argv (login, UID, directories), fixed HOME_LINKS/GO_SETTINGS, helper source — **main** constants today; future member login/UID bindings — **install-controlled** DB allocations derived from **GitHub/member** identities, not arbitrary user argv.
- `/etc/passwd`/group account entries, `useradd`, shell, existing home path and account UID/GID — **install-controlled** image/account state.
- `/opt/smithers/env.json`: all keys/values, including PATH, PYTHONPATH, Go settings, tool-cache targets — generated from **main** code and **branch-derived** toolchain selection; file ownership and immutability are separate inputs.
- `/var/cache/smithers/home` names/entries, cache directories, existing `.cache`, `.config`, `.config/go`, `.config/go/env`, all ancestor/leaf symlinks and directory metadata — **branch-derived** dependency output and **member-controlled** retained home state.
- Kernel/filesystem responses to mkdir/stat/open/chown/chmod and symlink operations — **install-controlled** guest OS; which object they address can be **member-controlled**.

#### R3

Inputs:

- JSON request id, argv, env, cwd, root, user and stdin mode; operation/path/content/mode/read limit for fs — **main/install-controlled** envelope and fixed identity fields, with **branch/member-controlled** argv, environment values, relative paths, file bytes and existing symlink graph. Capture metadata and command results are **branch/member-controlled** outputs.
- `/opt/smithers/env.json`, helper/interpreter startup environment, passwd/group records and guest directory state — sources as R1/R2.
- Host-generated exec IDs; kill/kill-all names, child directories, cgroup.procs/kill/events and their observed state — **main/install-controlled** IDs and kernel cgroup state; a guest command influences process population. Any selectable path/name must be validated against the fixed subtree.
- Relay/probe port, fixed host.microsandbox.internal bridge destination, ws relay-port metadata — **main/install-controlled**; bytes flowing over relay/TCP and associated peer responses — **member/branch-controlled** or authenticated host data, depending on channel.
- Fork/wait/signal/exit observations, filesystem resolution and network responses — **install-controlled** kernel responses influenced by member processes/network traffic.

#### R4

Inputs by privileged substep:

- Prepare boot/bootstrap: base OCI image, parent/newest same-family snapshot, owner/holder/repository/name/key labels, CPU/memory/disk/timeout/budget, net-rule allowlist — **install-controlled** configuration/state; recipe key, network destinations and selected tools are **branch-derived**. Image and snapshot contents include upstream OS and prior **branch-derived** outputs. R1/R2 also apply.
- Toolchain root recipe: `.smithers/target-index.json` Environment.Toolchain download versions/URLs/SHA256, Rust channel/components/targets, PostgreSQL major, destinations; or detected language/version evidence from repository manifests and version files — **branch**. Bundled `toolchains.json`, detector and script templates — **main/install-controlled**. `.smithers/machine.json` package additions — **main**, explicitly pinned by resolver. Downloads/archive entries/install scripts/tool `--version` output, Rust dist metadata/artifacts, apt package indexes/packages/maintainer scripts and PGDG key — upstream network responses, **branch-selected** for indexed download URLs/pins, otherwise **install-controlled** approved upstreams. GitHub-hosted release responses are **GitHub**, selected by the branch where index supplies the URL. `/etc/os-release`, apt sources/keyrings, root temp dirs and existing executable/filesystem state — **install-controlled** image/snapshot, including prior branch outputs. Every env.json key/value and root subprocess environment is consumed; fixed overrides are HOME=/root, TMPDIR=/var/tmp, DEBIAN_FRONTEND=noninteractive, system PATH, empty PYTHONPATH; other base_environment values remain inputs.
- Root input plant: all declared input path names and bytes (package/lock/workspace manifests, Go/Cargo inputs, selected tool entry/source files, dprint config, Python/requirements/pyproject inputs as selected by recipe); `tarFiles` regular-entry metadata, generated tar bytes; fixed destination/cache path and UID/GID, existing prepare directory/ancestors — **branch** files/names, **main** tar construction/script/UID, **install-controlled** snapshot paths with prior **branch-derived** cache content. This root step consumes file bytes even though later dependency installers run as agent.
- Root browser system install: Playwright selection/version triggering shipped apt script — **branch**; fixed package argv — **main**; apt sources/signatures/indexes/packages/scripts — **install-controlled** image/upstream network. It is separate from the unprivileged browser installer.
- Marker/sync and offline verification: serialized schema/kind/key/name/parent/repository/inventory/creation record, marker path, existing marker/temp/parent files and snapshot — **install-controlled** record with **branch-derived** recipe identity and output; script/destination — **main**. Reading a matching marker verifies identity, not trust of all layer contents.

#### R5

Inputs: artifact source path/bytes, artifact mapping, executable and env-value paths, helper bytes/digest — **install-controlled** bundle/catalog; existing guest destination/parents — **install-controlled** filesystem, potentially **member-controlled** if writable. Coding binding workspace/actor/repository IDs, repository slug, API/git URLs, fixed workspace/user/socket/version — **install-controlled** server authority, with **GitHub/member-derived** identity/slug data. Destination files, owners/modes/symlinks and helper-check response — guest filesystem/response. Root script/helper/interpreter — **main/install-controlled** plus R1 startup inputs.

## Ready checklist
1. Dependencies: header and index include revision storage/placement, catalog, authorization/confirmation, conversation and Flow/File cards, loading/composition/pinning, microVM launcher/execution, layers and root validation; all are S1. Scope names a fail-closed guard for every pending dependency.
2. Exclusions: Out explicitly excludes patch services/storage/application, duplicate stores, loaders/pinning, direct main writes, merge/activation, scratch execution, later editing, CLI/skills, Views and root changes. Changes reuse the existing TODO, catalog, container and RPC paths per delta §8.
3. Tests: C-J5-01 uses the real browser catalog/dispatcher and served TODO boundary with PostgreSQL; C-ACC-02 checks confirmation/idempotency; C-SEC-02 checks real machines. Named Source and missing-provider cases use those production doors and fixed oracles. No runtime spec or implementation-derived expectations; S2/S3 C-J11-02 remains phase-scoped.
4. Decisions: smithers-b8 signs off command/public app contracts; smithers-3f persistence/security; smithers-38 library APIs; smithers-06 View contracts; smithers-8a cross-owner seams; Will product changes. No new ADR or table is planned.
5. Owner pre-review questions recorded before start; recorded answers stand and unanswered review proceeds post hoc: smithers-b8: Does edit/source reuse todo.new with revision-1 context and ordinary confirmation/idempotency? Does Source select the proposing TODO branch and refuse missing providers? smithers-3f: Are context/placement writes atomic through the existing writer? Do all induced execution paths require R1–R5 validation and deny host fallback? smithers-38: Do catalog and FlowCard contracts reuse existing APIs without patch types or stores? smithers-06: Can the supplied Flow View show the diff and Make TODO through onAction/data-flow without a second handler path?
6. Security: smithers-3f reviews M-29 machine-only unprivileged execution and the complete R1–R5 input/source inventory above. Named production C-SEC-02 tests validate branch/member data before root use; missing receipts block activation. Branch-built root code is forbidden. Proposed diffs remain context; this ticket adds no privileged operation.

