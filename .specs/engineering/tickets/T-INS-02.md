# T-INS-02 Launcher passes isolation, GitHub, model and public-URL settings; microVM-only

Stage S1 · Size M · Depends on T-INS-01, T-ACC-01, T-ACC-07, T-INS-03 · Unblocks T-ACC-06, T-APP-15, T-APP-23, T-COL-07, T-FLW-11, T-GH-01, T-GH-03, T-INS-04, T-INS-08, T-MCH-08, T-MCH-14, T-REL-02, T-STK-04, T-STK-12, T-TRM-02 · Issue: [#3521](https://github.com/smithersai/smithers/issues/3521)
Spec: spec.md §1.1–§1.4, §3 (`install_settings`), §5.1.0, §8.2.1, §12.1.1, §17.3, §17.4 · Delta: delta.md §1 (Modify [S1] `NativeBackendProcess.ts`; Modify `isolation.go`) · Product: mvp.md §6.1, §9 Isolation, M-28, M-29, M-30
Ready: 2026-10-02 smithers-8a sha256:8b230ba3110e

## Goal
The bundled launcher starts the backend in microVM isolation with no setting taken from the shell, prints the one-time setup URLs on a fresh install, and the install refuses to start when microVM isolation is unavailable.

## Scope
In:
- Setup-URL relay (smithers-b8, 2026-10-02 17:37): the launcher matches a backend stdout line starting with `{"setup_urls":` and routes those exact bytes, newline included, never parsing or rebuilding URLs and never writing that line to its log stream; all other backend lines pass to logs as today. Two modes, chosen by launcher argv, never by env:
  - terminal mode (default; `bin/smithers-server` run by hand): the line is written verbatim to the launcher's stdout (the operator's terminal);
  - service mode (`--setup-handoff=socket`, set in the launchd plist): the line never touches stdout, stderr or `$STATE/logs`. The launcher keeps only the latest line, in memory, and serves it on `$STATE/run/host.sock` (unix socket, 0600, the installing user). A repeated start without a backend restart gets the same line; a launcher restart restarts the backend, which re-mints. Before answering, the launcher checks T-ACC-01's install status; once an owner exists it drops the line and answers "already set up". No plaintext token file exists anywhere.
- The launcher sets, never from the shell: `SMITHERS_WORKSPACE_ISOLATION=microvm`; `SMITHERS_MICROSANDBOX_BIN=<bundle>/bin/msb`; a fixed `SMITHERS_EGRESS_RELAY_PORT`; the loopback listeners `SMITHERS_SERVER_ADDR=127.0.0.1:4000` and `SMITHERS_SSH_ADDR=127.0.0.1:2222` (the config default `:2222` binds every interface, `packages/backend/internal/config/config.go:506`). Resolve `<bundle>` from `realpath(process.execPath)`, never an environment variable. Check: C-SEC-02.
- Every other install setting lives in PostgreSQL `install_settings` (spec §3: bind, origins, setup token digest, budgets), GitHub App credentials in `github_app` (T-GH-01), model keys in sealed owner secrets (T-INS-06). The launcher passes none of them, and the backend reads them after PostgreSQL starts.
- At token mint, T-ACC-07 emits one structured backend stdout line `{"setup_urls": [...]}` containing the loopback URL and one URL for each origin in `install_settings`. The launcher relays that line verbatim, without reconstructing URLs or querying status for a token. A restart before the claim re-mints the token and invalidates the old URL. After the claim nothing is emitted. T-ACC-01 supplies mint and claim; T-ACC-07 owns their shared advisory-lock ordering and backend emission; T-INS-02 owns relay. `smthrs host start` repeats the relayed output (T-INS-08). Checks: C-SEC-02, C-SEC-04.
- `$STATE` is `~/Library/Application Support/Smithers` (spec §1.1), not the `…/headless` subdirectory `apps/app/src/bun/serve.ts:6-8` uses today.
- The launcher passes no machine sizing (`SMITHERS_MICROVM_*`); every limit derives from the detected host (spec §8.2.1, T-MCH-01).
- The backend refuses `process` isolation in native mode. `process` stays available only to tests that set it explicitly.

Out:
- The configured bind address, public origins, cookies and listener swap (T-INS-04).
- The host profile, the sizing formula, and deleting the fixed defaults in `packages/backend/microsandbox/runtime.go:223-237` (4 CPUs, 8,192 MiB, 32,768 MiB, 3 VMs) and the `SMITHERS_MICROVM_*` overrides (`apps/backend/isolation.go:168-197`) (T-MCH-01).
- Running overridable flows and the coding host in machines, including removing `SMITHERS_CODING_LOCAL_OWNER=1` (`apps/app/src/bun/NativeBackendProcess.ts:383`) and the self-host `trusted_process` coding host (T-FLW-01).
- The bootstrap token and local password owner (deleted by T-ACC-01).

- Out of scope: formula and release packaging, launchd lifecycle, owner claim implementation, secret-store setup, external runtime discovery, and enabling repository execution through a host coding binding.
- Landing preconditions: T-ACC-01 supplies mint and claim; T-ACC-07 supplies the structured setup-URL stdout handoff; T-INS-03 supplies verified signing/entitlements for the bundled runtime. Fail startup if that runtime cannot boot a machine. T-GH-01 and T-INS-06 add later setup stores; do not enable incomplete steps here.

## Changes
- Build the §5.1.0 setup-token exchange and durable setup sessions before the frozen T-GH-01 manifest callback consumes them. Store session digests under `setup.session.<digest>` with the specified 24-hour idle expiry. Rotation changes only the token digest; existing session digests survive restart, digest commit failure and output failure. T-INS-06 owns durable `setup.<step>` state and proves that rotation preserves it. Checks: C-SEC-04 steps 2 and 7, C-INS-06 step 7.
- `apps/app/src/bun/NativeBackendProcess.ts`: force the bundled backend mode without reading `SMITHERS_BACKEND_MODE` from the shell. Set `SMITHERS_WORKSPACE_ISOLATION=microvm`, `SMITHERS_MICROSANDBOX_BIN=<bundle>/bin/msb`, the fixed relay port and loopback addresses. Resolve the executable realpath for the bundle prefix. Stop deriving public origins from the shell; read them from `install_settings`. Keep launcher readiness on loopback. Drop the inherited PATH append: child PATH contains the bundle bin and fixed OS system directories only, never inherited Homebrew or user directories. Check: C-SEC-02.
- `apps/app/src/bun/serve.ts:6-8` → state dir `$STATE`; relay the T-ACC-07 `setup_urls` stdout line verbatim. Resolve the runtime bundle from `realpath(process.execPath)` in `NativeBackendProcess.ts`. Check: C-SEC-02.
- `apps/backend/main.go:85` startup boundary → validate native microVM isolation and refuse before `openExecutionRuntimes` (`:109` in the current file), not only in the later native branch. `apps/backend/isolation.go:90-100` keeps parsing process isolation for explicit tests. C-SEC-02 asserts no runtime or host coding child opens on refusal.
- `apps/app/PACKAGE.ts:257-268` `backend-child-env` → add look-for items: isolation not forced to `microvm`; an address, origin or sizing value taken from the process environment.
- `distribution/README.md` microVM section (`npm install -g` of Microsandbox) → the bundled `msb`. `docs/architecture/self-host-implementation.md:13` is updated by T-DOC-02.

## Decisions and pre-review
- smithers-b8’s launcher environment, state-directory and setup-output edits and smithers-3f’s native startup, entitlement and isolation edits are adopted by the tech lead. smithers-8a accepts the cross-owner seam and restamps this ticket after application. Will decides any change to install settings or isolation policy. Check: C-SEC-02.
- Until T-FLW-01 provisions the guest coding binding, native composition must refuse repository-flow and coding dispatch before loading source or spawning a host child. T-INS-02 owns this temporary fail-closed guard in `packages/backend/internal/compose/flow_composition.go`; T-FLW-01 removes the guard only with its safe binding and removes `SMITHERS_CODING_LOCAL_OWNER=1`. This avoids a circular dependency while keeping §1.3 true on landing. C-SEC-02 checks zero host canary execution; full guest positive controls complete with T-FLW-01.

- Install the temporary fail-closed dispatch guard on the `flowhost.Launcher` wrap in `compose/flow_admission.go:24,89`, before source resolution or host launch. `flow_composition.go` wires the guarded launcher; guarding that composition alone misses other callers. T-FLW-01 replaces the refusal only with a guest binding. C-SEC-02 dispatches through every production launcher entry and asserts zero host canary effects.

## Tests
- With T-INS-06, create two setup sessions and durable step states, rotate the token, and assert unchanged session digests and step states. Repeat after a PostgreSQL RAISE commit failure and an in-process Fprintf output failure; old-token refusal and new-token success remain separate token assertions. Checks: C-SEC-04, C-INS-06.
- unit `apps/app/src/bun/NativeBackendProcess.test.ts`: the child env has `microvm`, an `msb` path inside the bundle and the two loopback addresses; a shell `SMITHERS_WORKSPACE_ISOLATION=process`, `SMITHERS_SERVER_ADDR`, `SMITHERS_PUBLIC_URL`, `SMITHERS_MICROVM_MEMORY_MIB`, `SMITHERS_PLATFORM_MODEL_KEYS_FILE` or `SMITHERS_BACKEND_MODE=plue` never changes the bundled backend mode or reaches the child. Assert `SMITHERS_MICROSANDBOX_BIN=<bundle>/bin/msb` despite a hostile shell value. Check: C-SEC-02.
- Unit `apps/app/src/bun/ServeEntrypoint.test.ts`: a literal backend `setup_urls` fixture is relayed byte-for-byte; the launcher never constructs URLs. Resolve `<bundle>` from the executable realpath despite hostile bundle-path environment variables and an executable symlink. Start the packaged launcher once with `/opt/homebrew/bin` and a hostile user directory on inherited PATH; assert neither directory reaches child PATH and every spawned executable and loaded dylib stays under the bundle prefix or OS. Assert the bundled `msb` path overrides the shell. Check: C-SEC-02.
- unit `apps/backend/isolation_test.go` and `main_test.go`: native mode with `process` refuses; a missing or wrong-version `msb` refuses with the 0.6.16 message; no path falls back to host processes.
- integration (macOS arm64, real `msb`): start from the T-INS-01 bundle with `bin/msb` renamed; the launcher exits non-zero with the refusal and no backend or PostgreSQL process remains.

- Boundary integration in `apps/app/scripts/server-bundle.integration.test.ts` (T-INS-01): invoke the bundled `bin/smithers-server`, not the environment builder alone. Use hostile shell settings and an empty state directory, claim through the served OAuth/setup path, then restart and verify no setup token is printed. Test missing msb, missing libkrun, wrong version and failed hypervisor boot; require non-zero exit and no surviving backend/PostgreSQL children. Use literal expected addresses, version and refusal classes. No test reads spec files or computes expectations from launcher code. Assert one newline-terminated printed line with the literal `{"setup_urls": [...]}` shape and sole key `setup_urls`; independently compute SHA-256 of its token and compare it with the stored PostgreSQL digest. Never tap the backend pipe inside the production launcher. Before claim, restart and assert one new line covers loopback and each stored origin, the new URL works and the old URL is refused. After claim, restart and assert neither backend nor launcher emits a setup line. Checks: C-SEC-02, C-SEC-04.
- C-SEC-02 also dispatches a repository canary through production flow dispatch: before T-FLW-01 it must refuse with no host effect; afterwards the canary must execute only in the guest. Test-only process isolation must be unreachable from the bundled entrypoint.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-SEC-02](../checks/C-SEC-02.md): this ticket supplies the start-up refusal and the absence of a host-process fallback; T-FLW-01 supplies the flow side.

## Risks and notes
- The bind address and public origins live in `install_settings` and apply live in the backend (spec §3, §16.3.1), so the launcher never passes them. delta.md §1 still says the launcher passes them and that `localOrigin()` accepts the configured bind; this ticket follows spec.md, and the launcher's own readiness origin stays loopback.
- Until T-MCH-01 lands (stage 2) the backend still uses the fixed defaults, so a 24 GB host can start three 8 GiB machines. Observation that confirms it: swap on a 24 GB host with three awake machines (C-SPK-05).
- The egress relay already binds `127.0.0.1` (`apps/backend/isolation.go:54`). The SSH server is not constructed today (delta.md §5), so a wrong SSH bind appears only when T-TRM-03 lands. C-INS-01 checks it.
- `msb` boots VMs only with the hypervisor entitlement intact after installation (T-INS-03). Observation that confirms the risk: `hv_vm_create` refusal in the backend log on a Homebrew install.

- Follow-up for frozen T-FLW-01: remove both `SMITHERS_CODING_LOCAL_OWNER` settings, in `apps/app/src/bun/NativeBackendProcess.ts:383` and `packages/backend/internal/compose/flow_composition.go:168`, when its safe guest binding lands. T-INS-02 must refuse dispatch while either legacy host binding can be selected. C-SEC-02 must prove no host fallback before removing the temporary guard. Do not edit T-FLW-01 in this draft.

## Ready checklist
1. Dependencies: T-INS-01 supplies the bundle, T-ACC-01 mint/claim, T-ACC-07 backend stdout handoff and T-INS-03 verified runtime signing. Repository dispatch stays refused until T-FLW-01 supplies the guest binding.
2. Exclusions: listener swap, sizing, claims, secret setup, flow implementation, launchd, formula and external runtime discovery are explicit.
3. Tests: the bundled server entrypoint and production flow dispatcher use literal fixtures; hostile environment and runtime failures prove refusal and child cleanup.
4. Decisions: smithers-b8 approves launcher contracts, smithers-3f isolation, smithers-8a the shared seam; Will decides product-policy changes.
5. Owner pre-review: smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-3f: answered, BLOCKING edits applied (tech lead adopts), for the bundled msb path and inherited PATH finding in 3f-tier01-b0. Preserve the earlier smithers-3f 2026-10-02 23:39 UTC guard approval. No T-INS-02 verdict is present in the supplied 3f-tier2-a input.
6. Security: verified microVM boot, host-only keys, no process fallback and refusal before repository loading require smithers-3f review; C-SEC-02 proves the execution boundary.
