# T-INS-08 Restore the launchd service code; `smthrs host start/stop/status` from a built bundle; setup-URL handoff

Stage S1 · Size M · Depends on first merge: T-INS-01, T-INS-02, T-ACC-01; rest of S1: — · Unblocks T-APP-03, T-CUT-02, T-INS-04, T-INS-05, T-INS-07, T-MCH-01, T-REL-02 · Issue: [#3523](https://github.com/smithersai/smithers/issues/3523)
Spec: spec.md §1.1, §1.2, §5.1.0, §16.1.2, §20.1, §20.2 · Product: mvp.md J1.1, J1.2, §6.1, §11 stage 1 item 1, M-26
Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §5, v1 §7). Absorbs T-INS-08 ([#3607](https://github.com/smithersai/smithers/issues/3607)).

## Goal
`smthrs host start --bundle <dir>` runs a bundle built from a clean checkout as a launchd service that serves in the installing user’s login session, restarts after a crash and prints the setup URLs, so the walking skeleton installs the way the release does.

## Scope
First merge: Start the per-user agent and print the setup URL on localhost. Check: C-J1-04.
Later dependency integrations land dark until their providers and phase checks pass.
In:
- `host start`: resolve `--bundle`, else the keg path T-INS-05 installs, else refuse naming both; verify the T-INS-01 `manifest.json` before touching the plist; write and bootstrap the plist in `~/Library/LaunchAgents` under `gui/<uid>`, without privilege escalation; wait for `/readyz`; print loopback and each configured origin with the setup URL while no owner exists. Idempotent: same bundle starts nothing new and keeps the token; another bundle rewrites the plist and restarts once.
- `host stop`: `launchctl bootout`; data stays. `host status`: launchd state, bundle path and version, `/readyz`, `microvm doctor`, then `GET /api/install` fields as they land; non-zero exit when a process is unhealthy or the bundle is missing.
- Setup-URL handoff: mint and owner claim share `pg_advisory_xact_lock(installSetupOwnerLockID)`. After the digest commits, atomically replace `$STATE/run/setup-urls.json` (0600, installing-user-owned) with `{"setup_urls":[...]}` for loopback and configured origins. `host start` reads it after `/readyz`. Restart before claim rotates the token; repeat start does not. Claim removes the file under the same lock; after claim print "already set up". Tokens never enter logs, traces or status. Checks: C-INS-06, C-SEC-04.

Out: tap, bottles and Docker deletion (T-INS-05); `--bind`/`--origin` (T-INS-04); upgrade, backup, restore (T-INS-07); setup sessions and the owner claim (T-ACC-01).

## Changes
- Restore `35ec608f65^:flows/organization/setup/service.ts` (297 lines: `plist()`, `hostPlist`, `which`, launchctl install and uninstall) and `service.test.ts` (205) into `packages/smithers/src/internal/backend/HostService.ts`. Drop `cleanPlist` and the organization CLI arguments.
- Reshape the restored `hostPlist`: `ProgramArguments` = the bundle's absolute `bin/smithers-server --setup-handoff=file`, logs under `$STATE/logs/` (about 20 lines).
- Reuse the existing supervisor: the plist runs `apps/app/src/bun/serve.ts` through `NativeBackendProcess.ts` (spawn, `/readyz` at `:105`, SIGTERM then SIGKILL at `:417`). No new process model.
- Reshape the existing `host` group in `packages/smithers/src/internal/backend/Commands.ts:32,54`: add `start` and `stop`; `status` reads `/readyz`, `smithers-backend microvm doctor` (`apps/backend/main.go:71`) and `GET /api/install` (T-INS-06 removes `/api/host`).
- Reuse the launcher's existing setup token handling (`NativeBackendProcess.ts`, `SMITHERS_AUTH_BOOTSTRAP_TOKEN`) for the relay.
- New: the advisory-lock mint and the one JSON stdout line in the backend's native startup. Rejected reuse: today's token is minted by the launcher with no claim serialization and no per-origin URLs.
- Docs: `apps/app/scripts/README.md` stage-1 install note; CLI reference for `host`; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/smithers:docs`.

## Tests
- Unit (restored `service.test.ts`, extended): plist fields including the absolute bundle path; bundle resolution and refusal; manifest mismatch refuses before any plist write; second start leaves one agent and the same token; no privileged calls.
- Integration `packages/smithers/test/host-service.integration.test.ts` through the production CLI, real launchd and bundled launcher: crash restart; readiness after login; handoff file mode 0600; no `setup?token=` in `$STATE/logs/*` or launchd stdout/stderr after start, repeat, restart and claim; effective UIDs of launcher, backend and PostgreSQL equal the installing user; `msb` disabled refuses start and runs no repository process.
- Integration (compiled backend, real PostgreSQL, `githubfake`): literal `{"setup_urls":[...]}` shape for empty and seeded origins; SHA-256 of the printed token equals the stored digest; restart before claim rotates token and digest; mint-vs-claim ordering in both lock orders; a commit failure emits nothing.

## Acceptance
- [C-INS-06](../checks/C-INS-06.md): launchd service, up after login, restarts after a crash, idempotent, prints setup URLs, no token in logs.
- [C-SEC-04](../checks/C-SEC-04.md): emission, rotation and silence after claim (from T-INS-08).
- [C-SEC-02](../checks/C-SEC-02.md): verbatim bundled-launcher relay, with T-INS-02.
- [C-J1-01](../checks/C-J1-01.md): fresh Mac with a built bundle at S1.
- [C-J1-04](../checks/C-J1-04.md): S1 part.
- [C-REL-02](../checks/C-REL-02.md): R part, after T-INS-05.

## Risks and notes
- A stage-1 bundle in a build directory breaks if moved; `host status` names the missing path.
- No fallback to host execution (§1.3, M-29).
