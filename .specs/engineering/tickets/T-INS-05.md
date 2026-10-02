# T-INS-05 Homebrew tap, `smthrs host start/stop/status`, launchd daemon; delete the Docker image

Stage R · Size M · Depends on T-INS-01, T-INS-03 · Unblocks T-INS-07, T-DOC-01 · Issue: to file
Spec: spec.md §1.1, §1.2, §1.4, §5.1.0, §8.2.1, §16.1.0–§16.1.2, §20.1, §20.2 · Delta: delta.md §1 (Add: `smthrs host` group, launchd plist, formula; Delete [R]: the Docker self-host image) · Product: mvp.md J1.1, §6.1 Install on a Mac, §12.5, M-09, M-10

## Goal
On a fresh Apple Silicon Mac, `brew install smithersai/tap/smithers` then `smthrs host start` installs a launchd daemon that runs before anyone logs in and prints the setup URLs. The only privileged step is one `sudo` at `smthrs host start`, and no Smithers account or service run by us is needed.

## Scope
In:
- Tap repository `smithersai/homebrew-tap` (new; `gh repo view smithersai/homebrew-tap` finds none today) with `Formula/smithers.rb`: installs the signed CLI installer archive (`packages/smithers/docs/guides/installer-releases.md`) and the T-INS-01 server bundle into `libexec`, links `smthrs`, and signs `msb` the way T-INS-03 proved.
- Release bottles for macOS arm64 come from a macOS job added to the existing `.github/workflows/release.yml`, which already builds per-platform artifacts (§16.1.0a). No Smithers host can build macOS binaries. Archives are GitHub Release assets of `smithersai/smithers` with sha256 in the formula (§16.1.1: no network service run by us).
- `smthrs host start [--bind <addr>] [--origin <url>]` (§1.4, §16.1.2): writes the launchd daemon plist with `UserName` = the installing user, bootstraps it, waits for `/readyz`, and prints every listener's URL. Installing the LaunchDaemon asks for `sudo` once, and the quickstart says so (T-DOC-01). While no owner exists it prints the one-time setup URL for each listener (§5.1.0; T-ACC-01 owns the token). `--bind` and `--origin` set the same `install_settings` keys as Settings (T-INS-04). Idempotent: a second run neither starts a second backend nor rotates the setup token.
- The daemon path follows T-INS-03's recorded answer, made before stage 1 ends. If the daemon can't use Hypervisor.framework, `host start` installs the fallback instead, a launchd agent plus macOS automatic login (no `sudo`), and the quickstart documents it.
- `smthrs host stop`: `launchctl bootout`; data stays.
- `smthrs host status`: launchd state, launcher, backend, PostgreSQL, `msb doctor`, bind address and listening sockets, the detected host profile and limits (§8.2.1), PostgreSQL size, disk free, machines and capacity, GitHub sync health and rate budget (§20.2). Exits non-zero when any process is unhealthy.
- Logs to `$STATE/logs/` (§20.1).
- Delete the Docker self-host image (§16.1.0): nothing consumes it, it was never published (#2481), and it can't host microVMs.

Out:
- `smthrs host upgrade`, `backup`, `restore` (T-INS-07).
- A LAN certificate authority, `smthrs connect` or mDNS: never built.
- HTTPS in front of the install (§16.3.4: docs only, for example Tailscale serve or Caddy). The quickstart (T-DOC-01).

## Changes
- `packages/smithers/src/commands/Host.ts` (new): the `host` group with `start`, `stop`, `status` (T-INS-07 adds the rest), registered in `makeCli` (`packages/smithers/src/Cli.ts:76`). The top-level `up` and `status` verbs keep their meanings (`packages/smithers/src/Verb.ts:87`). `status` reads `/readyz` and `GET /api/install` (T-INS-06). Appendix B.6 lists the group, so the allowlist test (T-CAT-01) passes.
- `apps/app/launchd/sh.smithers.host.plist` (new template; the label is a proposal): `ProgramArguments` = the bundle's `bin/smithers-server`, `UserName`, `KeepAlive`, `RunAtLoad`, stdout and stderr under `$STATE/logs/`. A launchd agent template for the fallback, if T-INS-03 chose it.
- `.github/workflows/release.yml` → a macOS arm64 job that builds the bottle and the bundle archive, publishes them with the installer archives (same `SHA256SUMS` signing), and opens a formula bump in the tap.
- Delete the Docker path: `distribution/{Dockerfile,entrypoint.sh,publish-image.sh,publish-image.test.mjs,test-image.sh,backup.sh,restore.sh,upgrade.sh}`, the jobs in `.github/workflows/distribution.yml:37-43` and `release.yml:512-516, 861-866`, `apps/app/scripts/mode-matrix/docker-web-selfhost.ts`, and `apps/site/src/content/docs/docs/self-hosting.mdx` (Docker only; T-DOC-01 replaces it with the quickstart). `distribution/lib.sh`, `version.env` and their Go tests stay until T-INS-07 ports their checks and deletes them.
- `distribution/README.md` → delete the stale "Native application" section and the Docker image.
- CLI reference for the `host` group in `packages/smithers/docs/reference/cli/`; run `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/smithers:docs`.

## Tests
- Unit `packages/smithers/test/HostCommands.test.ts` (new): plist content, including `UserName`; `start` twice leaves one daemon and the same setup token; exactly one privileged call (`sudo launchctl bootstrap system`) per first start, none on a repeat; `--bind` and `--origin` reach `install_settings`; `status` exit code and one line per failing component with fake `launchctl`, `/readyz` and `msb doctor`; printed URLs equal the listeners and serving settings.
- Unit: `rg` over the repository finds no reference to `distribution/Dockerfile` or the image name.
- Integration (macOS arm64 runner, clean user): `brew install --formula` from a local checkout of the tap pours the bottle without building from source; `smthrs host start` → `/readyz` 200; reboot to the login window → `/readyz` 200 and one machine boots before anyone logs in; `kill -9` of the backend → launchd restarts the launcher and both processes return; `smthrs host stop` → no process left; data persists across stop and start.
- Journey: C-J1-01, C-REL-02.

## Acceptance
- [C-REL-02](../checks/C-REL-02.md): install and start on an erased Mac contact no Smithers-run host, need no Smithers account, and ask for `sudo` once.
- [C-J1-01](../checks/C-J1-01.md): Homebrew install to the setup card, recorded.

## Risks and notes
- A LaunchDaemon plist lives in `/Library/LaunchDaemons` and needs administrator rights to install. Observation: `launchctl bootstrap system` fails for a non-admin user. `smthrs host start` then says an administrator must run it once.
- `brew upgrade` alone replaces the keg under a running launcher. Observation: the launcher crashes after a bare `brew upgrade`. T-INS-07 sequences upgrades; decide there whether the formula refuses a bare upgrade while running.
- If T-INS-03 chose the fallback, C-J1-01 and C-REL-02 replace the `sudo` step with the documented automatic-login step; the tech lead updates them with the decision.
