# T-INS-08 Restore the launchd service code; `smthrs host start/stop/status` from a built bundle; setup-URL handoff

Stage S1 · Size M · Depends on T-INS-01, T-INS-02, T-INS-03, T-ACC-01 · Unblocks T-APP-03, T-CUT-02, T-INS-04, T-INS-05, T-INS-07, T-INS-09, T-MCH-01, T-REL-02 · Issue: [#3523](https://github.com/smithersai/smithers/issues/3523)
Spec: spec.md §1.1, §1.2, §5.1.0, §16.1.2, §20.1, §20.2 · Product: mvp.md J1.1, J1.2, §6.1, §11 stage 1 item 1, M-26
Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §5, v1 §7). Absorbs T-ACC-07 ([#3607](https://github.com/smithersai/smithers/issues/3607)).

## Goal
`smthrs host start --bundle <dir>` runs a bundle built from a clean checkout as a launchd service that serves before anyone logs in, restarts after a crash and prints the setup URLs, so the walking skeleton installs the way the release does.

## Scope
In:
- `host start`: resolve `--bundle`, else the keg path T-INS-05 installs, else refuse naming both; verify the T-INS-01 `manifest.json` before touching the plist; write and bootstrap the plist (one `sudo` for a LaunchDaemon, or the agent fallback T-INS-03 chose); wait for `/readyz`; print loopback and each configured origin with the setup URL while no owner exists. Idempotent: same bundle starts nothing new and keeps the token; another bundle rewrites the plist and restarts once.
- `host stop`: `launchctl bootout`; data stays. `host status`: launchd state, bundle path and version, `/readyz`, `microvm doctor`, then `GET /api/install` fields as they land; non-zero exit when a process is unhealthy or the bundle is missing.
- Setup-URL handoff (from T-ACC-07): at mint the backend emits one newline-terminated line `{"setup_urls":[...]}` with loopback plus each `install_settings.public_origins` entry, all with the same new token. Mint runs under `pg_advisory_xact_lock(installSetupOwnerLockID)`, which `claimOwner` also takes; emit only after the digest commits. Restart before claim re-mints and invalidates the old URL; nothing is emitted after claim, and `host start` prints "already set up". Under launchd the launcher relays the line over `$STATE/run/host.sock` (mode 0600); the token never reaches `$STATE/logs/`, stderr, traces or status responses.

Out: tap, bottles and Docker deletion (T-INS-05); `--bind`/`--origin` (T-INS-04); upgrade, backup, restore (T-INS-07); setup sessions and the owner claim (T-ACC-01).

## Changes
- Restore `35ec608f65^:flows/organization/setup/service.ts` (297 lines: `plist()`, `hostPlist`, `which`, launchctl install and uninstall) and `service.test.ts` (205) into `packages/smithers/src/internal/backend/HostService.ts`. Drop `cleanPlist` and the organization CLI arguments.
- Reshape the restored `hostPlist`: `ProgramArguments` = the bundle's absolute `bin/smithers-server --setup-handoff=socket`, add `UserName` = the installing user, logs under `$STATE/logs/` (about 20 lines).
- Reuse the existing supervisor: the plist runs `apps/app/src/bun/serve.ts` through `NativeBackendProcess.ts` (spawn, `/readyz` at `:105`, SIGTERM then SIGKILL at `:417`). No new process model.
- Reshape the existing `host` group in `packages/smithers/src/internal/backend/Commands.ts:32,54`: add `start` and `stop`; `status` reads `/readyz`, `smithers-backend microvm doctor` (`apps/backend/main.go:71`) and `GET /api/install` (T-INS-06 removes `/api/host`).
- Reuse the launcher's existing setup token handling (`NativeBackendProcess.ts`, `SMITHERS_AUTH_BOOTSTRAP_TOKEN`) for the relay.
- New: the advisory-lock mint and the one JSON stdout line in the backend's native startup. Rejected reuse: today's token is minted by the launcher with no claim serialization and no per-origin URLs.
- Docs: `apps/app/scripts/README.md` stage-1 install note; CLI reference for `host`; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/smithers:docs`.

## Tests
- Unit (restored `service.test.ts`, extended): plist fields including `UserName` and the absolute bundle path; bundle resolution and refusal; manifest mismatch refuses before any plist write; second start leaves one daemon and the same token; one privileged call on first start, none on repeat.
- Integration `packages/smithers/test/host-service.integration.test.ts` through the production CLI, real launchd and bundled launcher: crash restart; reboot readiness before login; socket mode 0600; no `setup?token=` in `$STATE/logs/*` or launchd stdout/stderr after start, repeat, restart and claim; effective UIDs of launcher, backend and PostgreSQL equal the installing user; `msb` disabled refuses start and runs no repository process.
- Integration (compiled backend, real PostgreSQL, `githubfake`): literal `{"setup_urls":[...]}` shape for empty and seeded origins; SHA-256 of the printed token equals the stored digest; restart before claim rotates token and digest; mint-vs-claim ordering in both lock orders; a commit failure emits nothing.

## Acceptance
- [C-INS-06](../checks/C-INS-06.md): launchd service, up before login, restarts after a crash, idempotent, prints setup URLs, no token in logs.
- [C-SEC-04](../checks/C-SEC-04.md): emission, rotation and silence after claim (from T-ACC-07).
- [C-SEC-02](../checks/C-SEC-02.md): verbatim bundled-launcher relay, with T-INS-02.
- [C-J1-01](../checks/C-J1-01.md): fresh Mac with a built bundle at S1.
- [C-J1-04](../checks/C-J1-04.md): S1 part.
- [C-REL-02](../checks/C-REL-02.md): R part, after T-INS-05.

## Risks and notes
- A LaunchDaemon needs an administrator once; a non-admin start says so.
- A stage-1 bundle in a build directory breaks if moved; `host status` names the missing path.
- If T-INS-03 chose the agent fallback, C-INS-06 step 1 asks for no `sudo` and step 5 runs after automatic login.
- No fallback to host execution (§1.3, M-29).
