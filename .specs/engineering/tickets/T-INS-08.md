# T-INS-08 Launchd service and `smthrs host start/stop/status` from a built bundle

Stage S1 · Size M · Depends on T-INS-01, T-INS-02, T-INS-03 · Unblocks T-INS-04, T-INS-05, T-INS-07 · Issue: to file
Spec: spec.md §1.1, §1.2, §5.1.0, §16.1.2, §20.1, §20.2 · Delta: delta.md §1 (Add: `smthrs host` group, launchd plist) · Product: mvp.md J1.1, §6.1 Install on a Mac, §11 stage 1 item 1, M-26

## Goal
In stage 1, with no Homebrew formula yet, `smthrs host start --bundle <dir>` runs a server bundle built from a clean checkout as a launchd service that serves before anyone logs in, restarts after a crash and prints the setup URLs, so the walking skeleton installs the way the release does.

## Scope
In:
- `smthrs host start [--bundle <dir>]` (§16.1.2):
  - resolves the bundle: `--bundle`, else the keg layout beside `smthrs` that T-INS-05 installs, else a refusal that names both paths;
  - verifies the bundle's `manifest.json` (T-INS-01) and refuses a missing file or a hash mismatch before touching the plist;
  - writes the launchd plist: `UserName` = the installing user, `ProgramArguments` = the bundle's absolute `bin/smithers-server`, `RunAtLoad`, `KeepAlive`, stdout and stderr under `$STATE/logs/`;
  - bootstraps it, asking for `sudo` once for the LaunchDaemon, or installs the launchd agent fallback if T-INS-03 chose it;
  - waits for `/readyz` on loopback, then prints `http://localhost:4000` and each configured public origin, each with the one-time setup URL while no owner exists (§5.1.0; T-ACC-01 owns the token);
  - is idempotent: a second run with the same bundle starts no second backend and keeps the setup token. A run with another bundle rewrites the plist and restarts the service once; restore and upgrade use this (T-INS-07).
- `smthrs host stop`: `launchctl bootout`; data stays.
- `smthrs host status`: launchd state, bundle path and version, launcher, backend, PostgreSQL, `msb doctor` and listeners, then the host profile and limits, PostgreSQL size, disk free, machines and capacity, GitHub sync health and rate budget (§20.2) as their tickets land. A field whose source hasn't landed is omitted. Exits non-zero when any process is unhealthy or the bundle path is missing.
- Logs to `$STATE/logs/` (§20.1).

Out:
- The Homebrew tap, formula, release bottles and deleting the Docker image (T-INS-05, stage R).
- `--bind` and `--origin` (T-INS-04 adds them to this command).
- `smthrs host upgrade`, `backup`, `restore` (T-INS-07).
- The setup token, setup sessions and the owner claim (T-ACC-01).

## Changes
- `packages/smithers/src/commands/Host.ts` (new): the `host` group with `start`, `stop` and `status`, registered in `makeCli` (`packages/smithers/src/Cli.ts:76`). T-INS-04 adds the flags and T-INS-07 the remaining commands. The top-level `up` and `status` verbs keep their meanings (`packages/smithers/src/Verb.ts:87`). `status` reads `/readyz` and `GET /api/install` (T-INS-06). Appendix B.6 lists the group, so the allowlist test (T-CAT-01) passes.
- `apps/app/launchd/sh.smithers.host.plist` (new template; the label is a proposal), plus a launchd agent template if T-INS-03 chose the fallback.
- `apps/app/scripts/README.md` → build the bundle with `smthrs build //apps/app:serverBundle` and start it with `smthrs host start --bundle apps/app/.server-bundle`. This is the stage-1 install note that C-J1-04's operator holds.
- CLI reference for the `host` group in `packages/smithers/docs/reference/cli/`; run `pnpm docs:sync`, `pnpm docs:check` and `smthrs docs //packages/smithers:docs`.

## Tests
- unit `packages/smithers/test/HostCommands.test.ts` (new): plist content, including `UserName` and the resolved absolute bundle path; bundle resolution order and the refusal that names both paths; a manifest mismatch refuses before any plist is written; `start` twice leaves one daemon and the same setup token; exactly one privileged call (`sudo launchctl bootstrap system`) on a first start and none on a repeat; another `--bundle` rewrites the plist and restarts once; `status` exit code and one line per failing component with fake `launchctl`, `/readyz` and `msb doctor`; printed URLs equal the listeners and serving settings.
- integration: C-INS-06 on the reference host with the T-INS-01 bundle built from a clean checkout. Its reboot step needs a host that can reboot; the other steps also run on a macOS arm64 CI runner.

## Acceptance
- [C-INS-06](../checks/C-INS-06.md): `smthrs host start` runs a built bundle as a launchd service that is up before anyone logs in, restarts after a crash, is idempotent and prints the setup URLs.

## Risks and notes
- A LaunchDaemon plist lives in `/Library/LaunchDaemons` and needs administrator rights to install. Observation: `launchctl bootstrap system` fails for a non-admin user. `smthrs host start` then says an administrator must run it once.
- The stage-1 bundle lives in a build output directory, and the service fails if that directory moves or is deleted. Observation: `smthrs host status` names the missing path. The tap (T-INS-05) and restore (T-INS-07) pass stable paths.
- If T-INS-03 chose the fallback, C-INS-06's step 1 asks for no `sudo` and step 5 runs after the automatic login; the tech lead updates the check with the decision.
