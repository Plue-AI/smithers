# C-REL-02 `brew install` and `smthrs host start` on a fresh Mac need no Smithers account or Smithers-run service

Proves: mvp.md §12.5, §6.1 Install on a Mac, M-09 · spec.md §5.1.0, §16.1.0–§16.1.2, §16.2 · Layer: journey · Stage: R · Tickets: T-INS-05, T-INS-08
Automation: `scripts/journeys/release-install.mjs` (new) for timings and the connection log; the session is screen-recorded · Runs in: reference host, erased, recorded manual

## Setup
- The reference host after Erase All Content and Settings, macOS 15 or later, one new admin user, Homebrew installed from brew.sh.
- No `~/.smithers`, no `SMITHERS_*` variable, no Smithers keychain item.
- Released tap version V. A scratch repository `smithers-mvp-canary/<date>`, a provider key and an AI Gateway key.
- A connection log of every outbound hostname from the Mac for the whole session (a logging DNS resolver set as the Mac's resolver, plus `nettop -m route` snapshots).

## Steps
1. Start the connection log and the screen recording.
2. `brew install smithersai/tap/smithers`.
3. `smthrs host start`; answer its one `sudo` prompt; record the printed URLs and the time to `/readyz`.
4. `smthrs host status`.
5. Open the printed setup URL; complete setup steps 0 to 6.
6. Ask one question; receive an answer with file cards.
7. Stop the log; classify every hostname.

## Pass when
- No step asks for a Smithers account, Smithers sign-in, license or token, and `smthrs login` never runs.
- Exactly one `sudo` prompt appears in the whole session, at `smthrs host start`, to install the launchd daemon (§16.1.2). `brew install` asks for none.
- Every hostname belongs to one of: Homebrew and GitHub (including release asset hosts), the configured model providers and AI Gateway, the package registries the repository's dependency install uses, Apple. Zero lookups of `smithers.sh`, `*.smithers.sh`, `jjhub.tech` or any other Smithers-operated host.
- Step 3 prints every listener's URL with a one-time setup URL for each (§5.1.0); step 4 reports every process healthy and the detected host profile.

## Fail when
- Telemetry, bug intake, an update check or a license call reaches a Smithers host.
- The formula downloads from a Smithers-run bucket instead of GitHub Release assets, or builds from source because no macOS arm64 bottle exists (§16.1.0a).
- The install works only with `SMITHERS_TOKEN` set or after `smthrs login`.
- A second `sudo` or password prompt appears, or one appears anywhere other than `smthrs host start`.
- The first machine pulls the guest base image from a registry instead of the bundled archive (§16.1.0).

## Evidence
`.artifacts/checks/C-REL-02/<UTC timestamp>/`: the connection log and its classification table, the terminal transcript with timestamps, `brew info smithers`, `smthrs host status` output, the screen recording, version V and its commit.
