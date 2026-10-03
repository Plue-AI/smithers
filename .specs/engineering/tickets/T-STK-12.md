# T-STK-12 Candidate equality: reuse verification and proposal on the item's prefix

Stage S1 · Size M · Depends on T-STK-01, T-FLW-01, T-ACC-03 · Unblocks T-APP-11, T-APP-17, T-COL-03, T-FLW-11, T-GH-03, T-GH-04, T-GH-09, T-MCH-08, T-STK-02, T-STK-04, T-STK-05, T-STK-06, T-STK-08 · Issue: [#3533](https://github.com/smithersai/smithers/issues/3533)
Ready: 2026-10-03 smithers-8a sha256:1b38d1c06fdf

## Goal
Every PR head Smithers writes has the tree of the candidate verified on the item's current prefix. A new item starts on the available verified prefix without waiting for earlier work.

## Scope
In:
- Reuse `mythical_items.generation`, `version`, `candidate_base`, `candidate_head`, `candidate_verified`, `pr_head`, `pending_op` and `checks`. Keep the separate verify launch and existing pin → record → push proposal path. No generation-receipt subsystem. Check: C-STK-06.
- Select the nearest earlier unmerged item's verified head, else main, for admission and integration. An earlier verified head or main move invalidates later candidates until rebased and verified. A changed base requires a new generation and checks even when the tree is equal. Check: C-STK-06.
- Package `stack.candidate` and `stack.propose` as reserved `Action.make` operations over NativeCoding, adapting the existing engine under its stack claim. Admit only the current run/machine binding; no slash, CLI, agent or `/help` door. Checks: C-STK-06, C-SEC-02, C-ACC-01, C-CAT-01.
- Outsider provenance and protected-path policy from trusted main remain required before publication; unreadable policy refuses publication. Check: C-STK-06.
- Lands dark until T-STK-01: refuse operations needing unavailable TODO/attempt/evidence schema before capture, persistence or GitHub effects; build against its specified contract. Check: C-STK-06.
- Lands dark until T-FLW-01: refuse repository execution and reserved-operation dispatch without the packaged catalog and machine-only coding-host binding. Checks: C-STK-06, C-SEC-02.
- Lands dark until T-ACC-03: refuse both operations before capture or state reads when current run/machine authority cannot be resolved and authorized. Check: C-ACC-01.
- Lands dark until T-INS-02: refuse capture, checks and review without the bundled microVM launcher; never fall back to host execution. T-INS-02 supplies a runtime safety gate, not a called code/schema dependency. Check: C-SEC-02.
- Lands dark until T-SEC-01 and the R4/R5 owner checks: refuse fresh/retained machine execution until `TestGuestHelperInstallPinsInterpreterAndEnv`, `TestRootSetupNeverFollowsMemberSymlinks`, `TestRootPreflightParsesOnlyEnvelope`, `TestRootLayerInputsValidatedBeforeUse` and `TestRootManagedArtifactInstallUsesApprovedBundleOnly` pass at their production boundaries. smithers-3f reviews R1–R5. R4 belongs to T-MCH-10's sec10 follow-up; R5 to T-FLW-01's follow-up. No call into T-SEC-01 is required. Check: C-SEC-02.
- R1–R5 below inventory root inputs. Capture/check/review payloads execute as the agent after groups/GID/UID drop. Root executable, script and toolchain bytes come only from trusted main or the installed bundle; branch-built root payloads are forbidden. R4 reads the target index from main, runs toolchain steps as agent and validates destinations before use. Branch/member-derived paths, retained state and envelopes are blockers until the named R1–R5 tests prove validation before privileged use. Check: C-SEC-02.

Out:
- New generation rows, capture epochs, `candidate_inputs_seq`, immutable acceptance receipts, new decision-helper families and a second dispatcher or stack claim.
- Full evidence storage/presentation (T-STK-01), the TODO composition and input/signal loop (T-FLW-11), Stop/Drop lifecycle (T-STK-05), steers (T-STK-06), merge predicates/fences/dispatch/reconciliation (T-STK-04), outbound reconciliation changes (T-GH-09), PR naming/body/draft lifecycle (T-GH-03).
- Daemon capture (T-COL-03), presence scheduling and conflict handling (T-STK-08), shared ancestry consolidation (T-GH-07), new retry caps, detecting reverted edits, rewriting working-copy history, new flow-engine APIs and public commands.
- Host execution of repository hooks, checks, flows, filters or configuration-selected helpers; privileged execution of branch-built artifacts.

## Changes
- Reuse `packages/backend/internal/services/mythical_items.go`: `start` at :1618, prefix assignments at :1665; `integrate` at :1812, generation increment/reset at :1899–1901; `propose` at :1951 and `writeCommit` at :2029. Reshape prefix selection and invalidate verification on work input or base changes. Keep verify as an engine launch and keep the PR commit parent on main with the verified candidate's tree. Check: C-STK-06.
- Reuse `packages/backend/internal/services/mythical.go:224` (`runClaimed`; claim loop :168). Adapt reserved operations to the owning claim, without recursive or independent claims. Preserve item version checks and pin-before-record ordering; replay existing jobs/pending_op instead of inventing candidate acceptance storage. Check: C-STK-06.
- Reshape the packaged binding in `flows/coding/stack.ts:26` over `NativeCoding` using its existing Action.make pattern; never register the operations as repository Flow.make flows. Use T-FLW-01's catalog and T-ACC-03's authorizer. Checks: C-STK-06, C-SEC-02, C-ACC-01, C-CAT-01.
- Reuse guest capture/reporting in `packages/backend/internal/services/workspace_head.go` and `WorkspaceService.runtimeRepositoryCommandOutput` at `workspace_repository.go:501`. Route reports through `packages/backend/internal/routes/workspace_head.go:52`. Compare reported tree with the verified candidate without adding a capture-epoch protocol. A changed tree invalidates publication; equal trees preserve verification. Check: C-STK-06.
- Reuse the separate verify lane; compare immutable candidate and check-result trees. A check that writes tracked files fails with `check_modified_tree`, preserves bytes and cannot publish or start an automatic repropose cycle. Formatting precedes verification. T-FLW-11 consumes that failure in the composition. Check: C-STK-06.
- Harden existing host object-transfer callers, including `packages/backend/internal/services/github_import.go:2684`, using `repository_source_retention.go:368` as the controlled-environment pattern. Ignore system/global and executable-selecting repository configuration; disable hooks, filters, external diff, textconv, merge drivers and credential helpers. Use fixed allowed protocols/redirects, bundle/OS executable paths and environment-only credentials. Check: C-SEC-02.
- Retain the existing protected-path gate (`mythical_items.go:1785`) and require trusted-main policy for outsider candidates before proposal. Run/machine admission does not widen outsider egress. Check: C-STK-06.
- Extend existing engine and route tests first. The new boundary fixture `packages/backend/internal/services/todo_candidate_flow_db_test.go` is necessary because direct engine tests do not cover guest-to-host operation dispatch. New production services, migrations and tables are unnecessary. Update the existing stack/coding docs touched by these bindings. Checks: C-STK-06, C-SEC-02.

## Decisions and pre-review
- Recorded owner answers stand: smithers-3f answered at 2026-10-02 23:39 UTC on runClaimed, guest snapshot and hardened host transfer; smithers-b8 answered at 17:05 on system-only bindings/no public doors; smithers-38 answered at 2026-10-02 23:39 UTC on Action.make over NativeCoding. smithers-8a adopted those seams. Owners review this minimal-code reshaping post hoc under the 2026-10-03 directive; no renewed before-start approval gate.
- smithers-3f decides backend capture, claim, verification and isolation details; smithers-38 decides the TypeScript Action/NativeCoding contract; smithers-b8 decides command descriptors and refusal envelopes. smithers-8a accepts cross-owner seam changes. Will alone changes product limits or the reverted-edit exclusion. smithers-8a's S13 ruling remains: tree-writing checks fail visibly and formatting precedes verification.

## Tests
- Boundary integration, `todo_candidate_flow_db_test.go` (C-STK-06): real PostgreSQL, real microVM, packaged guest coding host and fake GitHub. Invoke both reserved Action tags through production guest-to-host dispatch, never direct engine methods as acceptance. Send head reports through `POST /api/repos/{owner}/{repo}/workspaces/{id}/head` on the composed router. Expectations are literal fixture states, refusal codes and file bytes, never read from specs, descriptors or decision code at runtime.
- Prefix fixtures: first item uses main; T1 verified/T2 unverified makes T3 start on T1; no earlier verified item makes T3 start on main. Publish T2's verified head and move main separately; later work remains unpublished until rebased and reverified. Same tree on a changed base gets a new generation and fresh checks. Check: C-STK-06.
- Tree fixtures: check known file bytes, publish and compare independently observed PR tree bytes. Inject a write during checks and a changed head after verification; no stale publication. Equal-tree reports do not clear verification. A writing check preserves its output, fails visibly and does not cycle. Check: C-STK-06.
- Crash/replay fixtures: stop before/after pin, pending_op save and push; restart the production worker. Recorded writes settle without a second decision or duplicated PR; GitHub may retain the last verified head while new work verifies. Race normal item mutations with dispatch and assert version/claim serialization. Check: C-STK-06.
- Authority fixtures: wrong install/repository/TODO/attempt/run/branch/workspace, stale credentials, draft runs, session/delegated/public/unbound callers deny before capture or state disclosure. Verify descriptors have no public doors. Disable each Scope provider independently and assert zero snapshot, state mutation or GitHub write. Checks: C-STK-06, C-ACC-01, C-CAT-01.
- Outsider fixtures: hostile candidate policy cannot replace trusted-main policy; protected paths and unreadable policy refuse acceptance/publication, insider control succeeds and egress remains restricted. Check: C-STK-06.
- Isolation fixtures: C-SEC-02 drives fresh/retained bootstrap, root setup, command/fs/cgroup/relay, layer preparation and artifact installation through the production adapter. Use the five named R1–R5 tests, hostile env/config/symlinks and positive controls; independently observe no root canaries, outside writes or host repository execution.
- C-J1-04 and the built-in TODO-loop parts of C-STK-06 complete with T-FLW-11 and their owning tickets. Unavailable integrations remain pending; they are not passing receipts.

## Acceptance
- [C-STK-06](../checks/C-STK-06.md): production operation/head-report boundaries prove verified PR trees and prefix selection.
- [C-SEC-02](../checks/C-SEC-02.md): production binding, machine-only execution and R1–R5 validation.
- [C-ACC-01](../checks/C-ACC-01.md), [C-CAT-01](../checks/C-CAT-01.md): run/machine-only admission and no public doors.
- [C-J1-04](../checks/C-J1-04.md): first TODO to merged PR; built-in composition integration remains pending until its providers pass.

## Risks and notes
- Build against unlanded providers' specified contracts and land dark. No dependency's unlanded status blocks Ready. Acceptance uses real migrated PostgreSQL and real machine boundaries, not schema stubs as passing evidence.
- Current C-STK-06 still cites removed §10.4.5 and generation-receipt cases; its owner must reconcile those cases with normative §10.4.4 and delta §6 before recording completion. This draft changes only T-STK-12 and its index row.

### Criterion 6 root-input inventory

R1–R5 list every consumed input and its source, including hostile refusal fixtures. These inputs do not authorize branch-built executable bytes at root. The source restrictions and tests in Scope govern accepted inputs.

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
1. Dependencies: T-STK-01's TODO/evidence schema, T-FLW-01's packaged catalog/binding and T-ACC-03's authorizer are called contracts. Scope names dark refusals for each and the T-INS-02/T-SEC-01/R4/R5 runtime safety gates; all dependency edges are S1.
2. Exclusions: Scope names receipts/new schema, duplicate engine/dispatcher, UI, composition, merge fences, lifecycle, reconciliation, daemon/presence/conflicts, ancestry consolidation, retries, reverted edits, public doors and host/root repository execution.
3. Tests: C-STK-06 drives production Action dispatch and the composed head-report route with real PostgreSQL/microVM and independent literal fixtures; C-SEC-02 drives privileged adapters. Pending built-in integration has no passing receipt.
4. Decisions: smithers-3f owns backend/security choices, smithers-38 Action/NativeCoding contracts, smithers-b8 command envelopes, smithers-8a seam acceptance and S13, and Will product limits. No new policy decision is delegated to the implementer.
5. Owner pre-review: recorded answers above stand; review the reshaping post hoc. smithers-3f: Does runClaimed remain the only claim owner? Do verify/propose preserve tree equality and pin → record → push? Do all R1–R5 inputs validate before root use? smithers-38: Do packaged Action tags reuse NativeCoding without a second dispatcher? smithers-b8: Are both bindings system-only with no public door? No UI view change requires smithers-06.
6. Security: Scope enforces M-29, trusted-main outsider policy, agent UID execution and no host fallback; R1–R5 enumerate each root input/source. smithers-3f reviews the five named production-boundary tests; unvalidated branch-derived root inputs keep execution dark, and branch-built root payloads remain forbidden.
