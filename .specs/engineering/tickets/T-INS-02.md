# T-INS-02 Launcher passes isolation, GitHub, model and public-URL settings; microVM-only

Stage S1 · Size M · Depends on T-INS-01, T-ACC-01, T-INS-03 · Unblocks T-INS-08, T-INS-04, T-STK-04, T-GH-01, T-FLW-11, T-MCH-14, T-STK-12 · Issue: to file
Spec: spec.md §1.1–§1.4, §3 (`install_settings`), §5.1.0, §8.2.1, §12.1.1, §17.3, §17.4 · Delta: delta.md §1 (Modify [S1] `NativeBackendProcess.ts`; Modify `isolation.go`) · Product: mvp.md §6.1, §9 Isolation, M-28, M-29, M-30

## Goal
The bundled launcher starts the backend in microVM isolation with no setting taken from the shell, prints the one-time setup URLs on a fresh install, and the install refuses to start when microVM isolation is unavailable.

## Scope
In:
- The launcher sets, never from the shell: `SMITHERS_WORKSPACE_ISOLATION=microvm`; `SMITHERS_MICROSANDBOX_BIN=<bundle>/bin/msb`; a fixed `SMITHERS_EGRESS_RELAY_PORT`; the loopback listeners `SMITHERS_SERVER_ADDR=127.0.0.1:4000` and `SMITHERS_SSH_ADDR=127.0.0.1:2222` (the config default `:2222` binds every interface, `packages/backend/internal/config/config.go:506`).
- Every other install setting lives in PostgreSQL `install_settings` (spec §3: bind, origins, setup token digest, budgets), GitHub App credentials in `github_app` (T-GH-01), model keys in sealed owner secrets (T-INS-06). The launcher passes none of them, and the backend reads them after PostgreSQL starts.
- On a start with no owner, the launcher prints the one-time setup URL for `http://localhost:4000` and each configured public origin, for example `http://localhost:4000/setup?token=…` (spec §5.1.0). T-ACC-01 owns the token and the claim; `smthrs host start` repeats the URLs (T-INS-08).
- `$STATE` is `~/Library/Application Support/Smithers` (spec §1.1), not the `…/headless` subdirectory `apps/app/src/bun/serve.ts:6-8` uses today.
- The launcher passes no machine sizing (`SMITHERS_MICROVM_*`); every limit derives from the detected host (spec §8.2.1, T-MCH-01).
- The backend refuses `process` isolation in native mode. `process` stays available only to tests that set it explicitly.

Out:
- The configured bind address, public origins, cookies and listener swap (T-INS-04).
- The host profile, the sizing formula, and deleting the fixed defaults in `packages/backend/microsandbox/runtime.go:223-237` (4 CPUs, 8,192 MiB, 32,768 MiB, 3 VMs) and the `SMITHERS_MICROVM_*` overrides (`apps/backend/isolation.go:168-197`) (T-MCH-01).
- Running overridable flows and the coding host in machines, including removing `SMITHERS_CODING_LOCAL_OWNER=1` (`apps/app/src/bun/NativeBackendProcess.ts:383`) and the self-host `trusted_process` coding host (T-FLW-01).
- The bootstrap token and local password owner (deleted by T-ACC-01).

- Out of scope: formula and release packaging, launchd lifecycle, owner claim implementation, secret-store setup, external runtime discovery, and enabling repository execution through a host coding binding.
- Landing preconditions: T-ACC-01 supplies the setup-token/status contract used to print URLs; T-INS-03 supplies the verified signing/entitlement result for the bundled runtime. Fail startup if that runtime cannot boot a machine. T-GH-01 and T-INS-06 add later setup stores; do not enable their incomplete setup steps here.

## Changes
- `apps/app/src/bun/NativeBackendProcess.ts:353-388` → add isolation, `msb` path, relay port and `SMITHERS_SSH_ADDR`; stop setting `SMITHERS_PUBLIC_URL` from the loopback origin (`:376`), since public origins come from `install_settings`. Keep `LAUNCHER_PASSTHROUGH` (`:62-68`) and `localOrigin()` (`:74-90`): the launcher's own readiness origin stays loopback.
- `apps/app/src/bun/serve.ts:6-8` → state dir `$STATE`; print the setup URL when the backend reports no owner.
- `apps/backend/main.go:169` native branch → refuse `SMITHERS_WORKSPACE_ISOLATION` other than `microvm`. `apps/backend/isolation.go:90-100` `workspaceIsolation()` keeps parsing both values for tests.
- `apps/app/PACKAGE.ts:257-268` `backend-child-env` → add look-for items: isolation not forced to `microvm`; an address, origin or sizing value taken from the process environment.
- `distribution/README.md` microVM section (`npm install -g` of Microsandbox) → the bundled `msb`. `docs/architecture/self-host-implementation.md:13` is updated by T-DOC-02.

## Decisions and pre-review
- Before start, smithers-b8 approves launcher environment, state-directory and setup-output contracts; smithers-3f approves native startup, entitlement validation and isolation guards. smithers-8a accepts the cross-owner launcher/backend seam. Will decides any change to install settings or isolation policy.
- Until T-FLW-01 provisions the guest coding binding, native composition must refuse repository-flow and coding dispatch before loading source or spawning a host child. T-INS-02 owns this temporary fail-closed guard in `packages/backend/internal/compose/flow_composition.go`; T-FLW-01 removes the guard only with its safe binding and removes `SMITHERS_CODING_LOCAL_OWNER=1`. This avoids a circular dependency while keeping §1.3 true on landing. C-SEC-02 checks zero host canary execution; full guest positive controls complete with T-FLW-01.

## Tests
- unit `apps/app/src/bun/NativeBackendProcess.test.ts`: the child env has `microvm`, an `msb` path inside the bundle and the two loopback addresses; a shell `SMITHERS_WORKSPACE_ISOLATION=process`, `SMITHERS_SERVER_ADDR`, `SMITHERS_PUBLIC_URL`, `SMITHERS_MICROVM_MEMORY_MIB` or `SMITHERS_PLATFORM_MODEL_KEYS_FILE` never reaches the child.
- unit `apps/app/src/bun/ServeEntrypoint.test.ts`: the setup URL is printed when no owner exists and never after the claim.
- unit `apps/backend/isolation_test.go` and `main_test.go`: native mode with `process` refuses; a missing or wrong-version `msb` refuses with the 0.6.16 message; no path falls back to host processes.
- integration (macOS arm64, real `msb`): start from the T-INS-01 bundle with `bin/msb` renamed; the launcher exits non-zero with the refusal and no backend or PostgreSQL process remains.

- Boundary integration in `apps/app/scripts/server-bundle.integration.test.ts` (T-INS-01): invoke the bundled `bin/smithers-server`, not the environment builder alone. Use hostile shell settings and an empty state directory, claim through the served OAuth/setup path, then restart and verify no setup token is printed. Test missing msb, missing libkrun, wrong version and failed hypervisor boot; require non-zero exit and no surviving backend/PostgreSQL children. Use literal expected addresses, version and refusal classes. No test reads spec files or computes expectations from launcher code.
- C-SEC-02 also dispatches a repository canary through production flow dispatch: before T-FLW-01 it must refuse with no host effect; afterwards the canary must execute only in the guest. Test-only process isolation must be unreachable from the bundled entrypoint.

## Acceptance
- [C-SEC-02](../checks/C-SEC-02.md): this ticket supplies the start-up refusal and the absence of a host-process fallback; T-FLW-01 supplies the flow side.

## Risks and notes
- The bind address and public origins live in `install_settings` and apply live in the backend (spec §3, §16.3.1), so the launcher never passes them. delta.md §1 still says the launcher passes them and that `localOrigin()` accepts the configured bind; this ticket follows spec.md, and the launcher's own readiness origin stays loopback.
- Until T-MCH-01 lands (stage 2) the backend still uses the fixed defaults, so a 24 GB host can start three 8 GiB machines. Observation that confirms it: swap on a 24 GB host with three awake machines (C-SPK-05).
- The egress relay already binds `127.0.0.1` (`apps/backend/isolation.go:54`). The SSH server is not constructed today (delta.md §5), so a wrong SSH bind appears only when T-TRM-03 lands. C-INS-01 checks it.
- `msb` boots VMs only with the hypervisor entitlement intact after installation (T-INS-03). Observation that confirms the risk: `hv_vm_create` refusal in the backend log on a Homebrew install.

## Ready checklist
1. Dependencies: T-INS-01 supplies the bundle, T-ACC-01 setup token/status and T-INS-03 verified runtime signing. Repository dispatch stays refused until T-FLW-01 supplies the guest binding.
2. Exclusions: listener swap, sizing, claims, secret setup, flow implementation, launchd, formula and external runtime discovery are explicit.
3. Tests: the bundled server entrypoint and production flow dispatcher use literal fixtures; hostile environment and runtime failures prove refusal and child cleanup.
4. Decisions: smithers-b8 approves launcher contracts, smithers-3f isolation, smithers-8a the shared seam; Will decides product-policy changes.
5. Owner pre-review: smithers-b8: Are bundle paths and child settings fixed independently of the shell? Does setup output use T-ACC-01 and stop after claim? smithers-3f: Do runtime failure and the pre-T-FLW-01 dispatch guard prevent every host execution fallback?
6. Security: verified microVM boot, host-only keys, no process fallback and refusal before repository loading require smithers-3f review; C-SEC-02 proves the execution boundary.
