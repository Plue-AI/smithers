# T-INS-02 Launcher passes isolation, GitHub, model and public-URL settings; microVM-only

Stage S1 · Size M · Depends on first merge: T-INS-01, T-ACC-01, T-SEC-01; rest of S1: — · Unblocks T-ACC-02, T-AGT-04, T-APP-01, T-APP-05, T-APP-15, T-APP-16, T-COL-03, T-FLW-01, T-FLW-03, T-FLW-04, T-FLW-05, T-FLW-08, T-FLW-09, T-FLW-11, T-GH-01, T-GH-02, T-GH-03, T-GH-04, T-GH-07, T-INS-04, T-INS-05, T-INS-06, T-INS-08, T-MCH-01, T-MCH-14, T-MNT-01, T-REL-02, T-REL-04, T-STK-02, T-STK-03, T-STK-04, T-STK-05, T-STK-06, T-STK-08, T-STK-09, T-STK-12, T-TRM-02 · Issue: [#3521](https://github.com/smithersai/smithers/issues/3521)
Spec: spec.md §1.1–§1.4, §3 (`install_settings`), §5.1.0, §8.2.1, §12.1.1, §17.3, §17.4 · Delta: delta.md §1 (Modify [S1] `NativeBackendProcess.ts`; Modify `isolation.go`) · Product: mvp.md §6.1, §9 Isolation, M-28, M-29, M-30
Ready: 2026-10-03 smithers-8a sha256:7c4a5cffdf0b

## Goal
The bundled launcher starts the backend in microVM isolation with no setting taken from the shell, prints the one-time setup URLs on a fresh install, and the install refuses to start when microVM isolation is unavailable.

## Scope
First merge: Qualify bundled startup and existing guest-only execution; refuse unsafe bindings. Check: C-J1-04.
Later dependency integrations land dark until their providers and phase checks pass.
In:
- Setup-URL relay (smithers-b8, 2026-10-02 17:37): the launcher matches a backend stdout line starting with `{"setup_urls":` and routes those exact bytes, newline included, never parsing or rebuilding URLs and never writing that line to its log stream; all other backend lines pass to logs as today. Two modes, chosen by launcher argv, never by env:
  - terminal mode (default; `bin/smithers-server` run by hand): the line is written verbatim to the launcher's stdout (the operator's terminal);
  - service mode (`--setup-handoff=file`, set in the launchd plist): the line never touches stdout, stderr or `$STATE/logs`. The launcher atomically writes only the latest line to `$STATE/run/setup-urls.json` (atomic handoff file, 0600, the installing user). A repeated start without a backend restart gets the same line; a launcher restart restarts the backend, which re-mints. Before answering, the launcher checks T-ACC-01's install status; once an owner exists it drops the line and answers "already set up". The handoff file is 0600, installing-user-owned, and removed on claim.
- The launcher sets, never from the shell: `SMITHERS_WORKSPACE_ISOLATION=microvm`; `SMITHERS_MICROSANDBOX_BIN=<bundle>/bin/msb`; a fixed `SMITHERS_EGRESS_RELAY_PORT`; the loopback listeners `SMITHERS_SERVER_ADDR=127.0.0.1:4000` and `SMITHERS_SSH_ADDR=127.0.0.1:2222` (the config default `:2222` binds every interface, `packages/backend/internal/config/config.go:503`). Resolve `<bundle>` from `realpath(process.execPath)`, never an environment variable. Check: C-SEC-02.
- Every other install setting lives in PostgreSQL `install_settings` (spec §3: bind, origins, setup token digest, budgets), GitHub App credentials in `github_app` (T-GH-01), model keys in sealed owner secrets (T-INS-06). The launcher passes none of them, and the backend reads them after PostgreSQL starts.
- T-ACC-01 supplies backend mint/claim under the shared owner lock and emits the committed setup_urls stdout line; T-INS-02 relays terminal output. T-INS-08 adds service handoff. Pre-claim restart rotates; post-claim emits nothing. Checks: C-SEC-02, C-SEC-04.
- `$STATE` is `~/Library/Application Support/Smithers` (spec §1.1), not the `…/headless` subdirectory `apps/app/src/bun/serve.ts:6-8` uses today.
- The launcher passes no machine sizing (`SMITHERS_MICROVM_*`); every limit derives from the detected host (spec §8.2.1, T-MCH-01).
- The backend refuses `process` isolation in native mode. `process` stays available only to tests that set it explicitly.

Out:
- The configured bind address, public origins, cookies and listener swap (T-INS-04).
- Host-profile/sizing changes remain T-MCH-01; current apps/backend/isolation.go:171-191 already uses Detect/ComputeSizing. Do not restore removed fixed defaults or shell overrides.
- Implementing overridable flows/coding bindings remains T-FLW-01; qualify the landed guest-only path here. The remaining local-owner assignment is explicit process-test configuration only (compose/flow_composition.go:71-81).
- The bootstrap token and local password owner (deleted by T-ACC-01).

- Out of scope: formula and release packaging, launchd lifecycle, owner claim implementation, secret-store setup, external runtime discovery, and enabling repository execution through a host coding binding.
- First merge requires the assembled bundle and owner bootstrap. Qualify terminal-mode setup output here; T-INS-08 later adds the file relay for LaunchAgent mode. Runtime signing is proved by startup, not the release spike. Incomplete later setup providers refuse.

## Changes
- Consume T-ACC-01’s existing setup-session service; T-ACC-01 owns exchange, expiry and claim invalidation. This ticket owns launcher relay only.
- `apps/app/src/bun/NativeBackendProcess.ts`: force the bundled backend mode without reading `SMITHERS_BACKEND_MODE` from the shell. Set `SMITHERS_WORKSPACE_ISOLATION=microvm`, `SMITHERS_MICROSANDBOX_BIN=<bundle>/bin/msb`, the fixed relay port and loopback addresses. Resolve the executable realpath for the bundle prefix. Stop deriving public origins from the shell; read them from `install_settings`. Keep launcher readiness on loopback. Drop the inherited PATH append: child PATH contains the bundle bin and fixed OS system directories only, never inherited Homebrew or user directories. Check: C-SEC-02.
- `apps/app/src/bun/serve.ts:6-8` → state dir `$STATE`; relay the T-ACC-01 `setup_urls` stdout line verbatim. Resolve the runtime bundle from `realpath(process.execPath)` in `NativeBackendProcess.ts`. Check: C-SEC-02.
- `apps/backend/main.go:119` startup boundary → validate native microVM isolation and refuse before `openExecutionRuntimes` (`:119` in the current file), not only in the later native branch. `apps/backend/isolation.go:91-102` keeps parsing process isolation for explicit tests. C-SEC-02 asserts no runtime or host coding child opens on refusal.
- `apps/app/PACKAGE.ts:257-268` `backend-child-env` → add look-for items: isolation not forced to `microvm`; an address, origin or sizing value taken from the process environment.
- `distribution/README.md` microVM section (`npm install -g` of Microsandbox) → the bundled `msb`. `docs/architecture/self-host-implementation.md:13` is updated by T-DOC-02.

## Decisions and pre-review
- smithers-b8’s launcher environment, state-directory and setup-output edits and smithers-3f’s native startup, entitlement and isolation edits are adopted by the tech lead. smithers-8a accepts the cross-owner seam and restamps this ticket after application. Will decides any change to install settings or isolation policy. Check: C-SEC-02.
- Preserve landed isolation checks in flowhost/workspace_launcher.go:28-35,51-54,76-94 and resolver.go:221-222 before source resolution/host launch. Native composition cannot enable AllowTrustedProcessForTests. C-SEC-02 drives every production launcher entry with guest positive controls and zero host canary effects.

- Missing guest binding/artifact/isolation authority refuses before source loading/host effects; qualify the landed guest path without a blanket coding refusal. Check: C-SEC-02.

## Tests
- Goal T7 / test T35 / C-INS-05 steps 4–7: from the relocated bundle and empty state, start the launcher with OS-only PATH; readiness is 200 within 30 s and all executables/dylibs are bundle or OS paths. Doctor is ready; with the image registry blocked a VM boots the bundled OCI image and prints ok. Write an API row, SIGTERM and restart: the row survives and PostgreSQL is major 18. Missing runtime/library or failed boot refuses with no surviving child.
- With T-INS-06, create two setup sessions and durable step states, rotate the token, and assert unchanged session digests and step states. Repeat after a PostgreSQL RAISE commit failure and an in-process Fprintf output failure; old-token refusal and new-token success remain separate token assertions. Checks: C-SEC-04, C-INS-06.
- unit `apps/app/src/bun/NativeBackendProcess.test.ts`: the child env has `microvm`, an `msb` path inside the bundle and the two loopback addresses; a shell `SMITHERS_WORKSPACE_ISOLATION=process`, `SMITHERS_SERVER_ADDR`, `SMITHERS_PUBLIC_URL`, `SMITHERS_MICROVM_MEMORY_MIB`, `SMITHERS_PLATFORM_MODEL_KEYS_FILE` or `SMITHERS_BACKEND_MODE=plue` never changes the bundled backend mode or reaches the child. Assert `SMITHERS_MICROSANDBOX_BIN=<bundle>/bin/msb` despite a hostile shell value. Check: C-SEC-02.
- Unit `apps/app/src/bun/ServeEntrypoint.test.ts`: a literal backend `setup_urls` fixture is relayed byte-for-byte; the launcher never constructs URLs. Resolve `<bundle>` from the executable realpath despite hostile bundle-path environment variables and an executable symlink. Start the packaged launcher once with `/opt/homebrew/bin` and a hostile user directory on inherited PATH; assert neither directory reaches child PATH and every spawned executable and loaded dylib stays under the bundle prefix or OS. Assert the bundled `msb` path overrides the shell. Check: C-SEC-02.
- unit `apps/backend/isolation_test.go` and `main_test.go`: native mode with `process` refuses; a missing or wrong-version `msb` refuses with the 0.6.16 message; no path falls back to host processes.
- integration (macOS arm64, real `msb`): start from the T-INS-01 bundle with `bin/msb` renamed; the launcher exits non-zero with the refusal and no backend or PostgreSQL process remains.

- Boundary integration in `apps/app/scripts/server-bundle.integration.test.ts` (T-INS-02): invoke the bundled `bin/smithers-server`, not the environment builder alone. Use hostile shell settings and an empty state directory, claim through the served OAuth/setup path, then restart and verify no setup token is printed. Test missing msb, missing libkrun, wrong version and failed hypervisor boot; require non-zero exit and no surviving backend/PostgreSQL children. Use literal expected addresses, version and refusal classes. No test reads spec files or computes expectations from launcher code. Assert one newline-terminated printed line with the literal `{"setup_urls": [...]}` shape and sole key `setup_urls`; independently compute SHA-256 of its token and compare it with the stored PostgreSQL digest. Never tap the backend pipe inside the production launcher. Before claim, restart and assert one new line covers loopback and each stored origin, the new URL works and the old URL is refused. After claim, restart and assert neither backend nor launcher emits a setup line. Checks: C-SEC-02, C-SEC-04.
- C-SEC-02 drives production repository dispatch: a valid landed guest binding executes only as guest user; missing/unsafe bindings refuse before source loading or host effects. The bundled entrypoint cannot select process-test isolation.

## Acceptance
- [C-INS-05](../checks/C-INS-05.md): launcher readiness, offline boot and persistence steps 4–7 pass; T-INS-01 owns assembly/layout only.

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-SEC-02](../checks/C-SEC-02.md): this ticket supplies the start-up refusal and the absence of a host-process fallback; T-FLW-01 supplies the flow side.

## Risks and notes
- The bind address and public origins live in `install_settings` and apply live in the backend (spec §3, §16.3.1), so the launcher never passes them. delta.md §1 still says the launcher passes them and that `localOrigin()` accepts the configured bind; this ticket follows spec.md, and the launcher's own readiness origin stays loopback.
- Sizing already derives from Detect/ComputeSizing (apps/backend/isolation.go:171-191); record actual profile at startup. Further qualification is T-MCH-01.
- The egress relay already binds `127.0.0.1` (`apps/backend/isolation.go:56`). The SSH server is not constructed today (delta.md §5), so a wrong SSH bind appears only when T-TRM-03 lands. C-INS-01 checks it.
- `msb` boots VMs only with the hypervisor entitlement intact after installation (T-INS-03). Observation that confirms the risk: `hv_vm_create` refusal in the backend log on a Homebrew install.

- Current launcher has no SMITHERS_CODING_LOCAL_OWNER assignment; compose/flow_composition.go:78 retains it only for explicit process tests. C-SEC-02 proves installation cannot select that branch.


### Criterion 6 root-input inventory

The following audited inputs include hostile refusal fixtures. They do not authorize branch-built bytes at root. The adopted source restrictions above govern accepted inputs.

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
- Root toolchain recipe consumes only main-installed script/digest/fixed environment, main-pinned index/machine.json packages/PostgreSQL values, bounded branch-derived detection environment, approved image/upstream apt sources/keyrings/PGDG/indexes/packages/scripts and retained destination metadata. Downloads/toolchains execute as agent. TestRootLayerInputsValidatedBeforeUse proves validation before use; branch-built root code remains forbidden.
- Dependency names/bytes are applied after UID drop (layers.go:546-571); root sees only the bounded R3 identity/envelope. TestRootLayerInputsValidatedBeforeUse independently observes the UID before payload use.
- Root consumes shipped apt script/digest, main-approved packages and approved image/upstream sources/signatures/packages/scripts; branch-selected browser installers run as agent. TestRootLayerInputsValidatedBeforeUse proves the distinction.
- Branch-derived markers/identity/inventory/paths/retained parents are read/written as agent; root sync consumes only shipped script/digest/fixed env and OS filesystem state. TestRootLayerInputsValidatedBeforeUse proves no marker chooses privileged code/destinations.

#### R5

Inputs: artifact source path/bytes, artifact mapping, executable and env-value paths, helper bytes/digest — **install-controlled** bundle/catalog; existing guest destination/parents — **install-controlled** filesystem, potentially **member-controlled** if writable. Coding binding workspace/actor/repository IDs, repository slug, API/git URLs, fixed workspace/user/socket/version — **install-controlled** server authority, with **GitHub/member-derived** identity/slug data. Destination files, owners/modes/symlinks and helper-check response — guest filesystem/response. Root script/helper/interpreter — **main/install-controlled** plus R1 startup inputs.

## First-merge root inputs and landing gates

R1 helper bootstrap consumes main-installed helper bytes/digest/script/destination, bundled msb/path/argv/host env, approved image/snapshot/OS/interpreter/system tools/import paths and retained ancestors/temporary entries. R2 setup consumes main-fixed login/UID/directory constants, installed passwd/group/account state, env.json keys/values/cache targets and home/cache names/ownership/modes/symlinks. R3 supervision consumes request/file/terminal envelopes, IDs/identity/argv/env/cwd/root/stdin/content/mode/limits, request files/parents/descriptors, cgroup cleanup IDs/kernel state, relay/probe endpoints and filesystem/network responses. Retained home/cache/env/request entries can be branch/member-derived; scripts/interpreters/code are approved main-installed bytes only. T-SEC-01’s TestGuestHelperInstallPinsInterpreterAndEnv, TestRootSetupNeverFollowsMemberSymlinks and TestRootPreflightParsesOnlyEnvelope must prove validation before privileged use through real fresh/retained production paths.

R4 preparation consumes approved image/snapshot/OS/account/filesystem state; install machine/owner/repository/layer labels, sizing/budget/timeout/net policy plus branch-derived recipe identity; main-installed script/digest/fixed root env/cwd, main index/machine.json packages/PostgreSQL pins, branch detection-derived bounded environment values; approved image/upstream apt sources/keyrings/PGDG key/indexes/packages/scripts and retained toolchain/rust/env.json destinations/ancestors. Branch dependency inputs/downloads/browser installers/marker data run as agent; root sync consumes only shipped script/digest/fixed env/OS state. TestRootLayerInputsValidatedBeforeUse must drive production setup-machine dispatch and actual preparation with literal hostile/valid inputs and retained destinations.

R5 managed startup consumes main-installed artifact source paths/bytes/catalog digests/mapping, executable/env paths, helper bytes/digest/script/interpreter; fixed destinations/parents/owners/modes/symlinks; server-bound workspace/actor/repository IDs, GitHub-derived slug, API/git URLs, fixed user/root/socket/version and helper-check responses. Retained filesystem/responses can be branch/member data. TestRootManagedArtifactInstallUsesApprovedBundleOnly must drive actual managed startup and coding binding, proving provenance and validation before root use. The raw root-shell plant in transport.go:415-436 is not that proof.

smithers-3f reviews every input and accepts C-SEC-02 production receipts before landing/enabling the reused execution slice. Missing/skipped/direct-Python proofs block. Branch data without validation blocks; branch-built scripts/binaries/interpreters/imports/toolchains never run as root, regardless of digest. M-29 requires repository execution as unprivileged machine user. Host processes stay unprivileged; never load a sudo plist from a lane workspace.

## Ready checklist
1. T-INS-01 assembly, T-ACC-01 mint/claim/stdout, T-SEC-01 shared root hardening; later service handoff not a gate.
2. Out of scope explicitly includes listener/sizing changes, claims/secrets, flow implementation, launchd/formula/external discovery.
3. C-SEC-02/C-SEC-04: bundled server and production flow dispatch. Commit literal layout/step/state/SHA/status/error/UID/role/secret fixtures; independent hashes and external effect logs supply expectations, never runtime spec/production oracles. Later checks run only with their providers.
4. smithers-b8 accepts apps/CLI/API; smithers-38 accepts packages TypeScript/public schemas; smithers-3f accepts Go/infra/security; smithers-06 accepts touched View/navigation contracts; smithers-8a accepts shared/schema/Plue seams. Will decides product-policy exceptions.
5. re-review needed: smithers-b8, terminal/stdout producer split; Is relay byte-exact/token-free? re-review needed: smithers-3f, landed guest path instead of blanket guard; Does every entry refuse unsafe isolation before imports? Are root inputs qualified? Prior PATH/msb answers stand where unchanged.
6. Host processes are unprivileged; no sudo lane plist. Execution consumers inherit the complete R1–R5 inventories and named production tests in T-INS-02/T-INS-06/T-STK-01; smithers-3f accepts receipts. M-29 confines code to unprivileged machines; unvalidated branch data blocks and branch-built root code is forbidden.
