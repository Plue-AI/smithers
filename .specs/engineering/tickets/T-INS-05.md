# T-INS-05 Homebrew tap and release bottles; delete the Docker image

Stage R · Size M · Depends on T-INS-01, T-INS-03, T-INS-08 · Unblocks T-DOC-01, T-INS-07 · Issue: [#3460](https://github.com/smithersai/smithers/issues/3460)
Spec: spec.md §16.1.0–§16.1.2 · Delta: delta.md §1 (Add: formula; Delete [R]: the Docker self-host image) · Product: mvp.md J1.1, §6.1 Install on a Mac, §12.5, M-09, M-10

## Goal
On a fresh Apple Silicon Mac, `brew install smithersai/tap/smithers` pours a prebuilt bottle, and `smthrs host start` with no `--bundle` runs the bundle it installed (T-INS-08). No Smithers account or service run by us is needed, and the Docker image is gone.

## Scope
In:
- Tap repository `smithersai/homebrew-tap` (created 2026-10-02 by ops, private until the release stage; `brew tap` works with a token until then) with `Formula/smithers.rb`: installs the signed CLI installer archive (`packages/smithers/docs/guides/installer-releases.md`) and the T-INS-01 server bundle into `libexec` at the path `smthrs host start` resolves without `--bundle` (§16.1.2, T-INS-08), links `smthrs`, and signs `msb` the way T-INS-03 proved.
- Release bottles for macOS arm64 come from a macOS job added to the existing `.github/workflows/release.yml`, which already builds per-platform artifacts (§16.1.0a). No Smithers host can build macOS binaries. Archives are GitHub Release assets of `smithersai/smithers` with sha256 in the formula (§16.1.1: no network service run by us).
- Delete the Docker self-host image (§16.1.0): nothing consumes it, it was never published (#2481), and it can't host microVMs.

Out:
- `smthrs host start`, `stop`, `status` and the launchd plist (T-INS-08); `smthrs host upgrade`, `backup`, `restore` (T-INS-07).
- A LAN certificate authority, `smthrs connect` or mDNS: never built.
- HTTPS in front of the install (§16.3.4: docs only, for example Tailscale serve or Caddy). The quickstart (T-DOC-01).

## Changes
- `.github/workflows/release.yml` → a macOS arm64 job (GitHub-hosted runners are free for the public `smithersai/smithers`) that builds the bottle and the bundle archive, publishes them with the installer archives (same `SHA256SUMS` signing), and opens a formula bump in the tap.
- Delete the Docker path: `distribution/{Dockerfile,entrypoint.sh,publish-image.sh,publish-image.test.mjs,test-image.sh,backup.sh,restore.sh,upgrade.sh}`, the jobs in `.github/workflows/distribution.yml:37-43` and `release.yml:512-516, 861-866`, `apps/app/scripts/mode-matrix/docker-web-selfhost.ts`, and `apps/site/src/content/docs/docs/self-hosting.mdx` (Docker only; T-DOC-01 replaces it with the quickstart). `distribution/lib.sh`, `version.env` and their Go tests stay until T-INS-07 ports their checks and deletes them.
- `distribution/README.md` → delete the stale "Native application" section and the Docker image.

## Tests
- Unit: `rg` over the repository finds no reference to `distribution/Dockerfile` or the image name.
- Integration (macOS arm64 runner, clean user): `brew install --formula` from a local checkout of the tap pours the bottle without building from source; the poured `msb` keeps `com.apple.security.hypervisor`; `smthrs host start` with no `--bundle` runs the keg's bundle and `/readyz` answers 200.
- Journey: C-J1-01, C-REL-02.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): R part at its named layer.



- [C-REL-02](../checks/C-REL-02.md): install and start on an erased Mac contact no Smithers-run host, need no Smithers account, and ask for `sudo` once.
- [C-J1-01](../checks/C-J1-01.md): Homebrew install to the setup card, recorded.

## Risks and notes
- `brew upgrade` alone replaces the keg under a running launcher. Observation: the launcher crashes after a bare `brew upgrade`. T-INS-07 sequences upgrades; decide there whether the formula refuses a bare upgrade while running.
- If T-INS-03 chose the fallback, C-J1-01 and C-REL-02 replace the `sudo` step with the documented automatic-login step; the tech lead updates them with the decision.
