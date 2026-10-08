# C-REL-02 `brew install` and `smthrs host start` in a fresh macOS user account on the reference mini need no Smithers account or Smithers-run service

Proves: mvp.md §12.5, §6.1 Install on a Mac, M-09 · spec.md §5.1.0, §16.1.0–§16.1.2, §16.2 · Layer: journey · Stage: R · Tickets: T-INS-05, T-INS-08
Automation: `scripts/journeys/release-install.mjs` for timings and the connection log; the session is screen-recorded · Runs in: reference mini, fresh macOS user account with no prior Smithers state, recorded manual

## Setup
- The reference host after Erase All Content and Settings, macOS 15 or later, one new admin user, Homebrew installed from brew.sh.
- No `~/.smithers`, no `SMITHERS_*` variable, no Smithers keychain item.
- Released tap version V. A scratch repository `smithers-mvp-canary/<date>`, a provider key and an AI Gateway key.
- A connection log of every outbound hostname from the Mac for the whole session (a logging DNS resolver set as the Mac's resolver, plus `nettop -m route` snapshots).

## Steps
1. Start the connection log and the screen recording.
2. `brew install smithersai/tap/smithers`.
3. `smthrs host start` without `--bundle`; require no privilege prompt; record the printed URLs and the time to `/readyz`.
4. `smthrs host status`.
5. Open the printed setup URL; complete setup steps 0 to 6.
6. Ask one question; receive an answer with file cards.
7. Stop the log; classify every hostname.

## Pass when
- No step asks for a Smithers account, Smithers sign-in, license or token, and `smthrs login` never runs.
- No privilege prompt appears. Start installs one per-user LaunchAgent in `~/Library/LaunchAgents` under `gui/<uid>` (§16.1.2), running as the installing user. Repeat start leaves one backend and the same URLs.
- Every hostname belongs to one of: Homebrew and GitHub (including release asset hosts), the configured model providers and AI Gateway, the package registries the repository's dependency install uses, Apple. Zero lookups of `smithers.sh`, `*.smithers.sh`, `jjhub.tech` or any other Smithers-operated host.
- Step 3 prints every listener's URL with a one-time setup URL for each (§5.1.0); step 4 reports every process healthy and the detected host profile.

## Fail when
- Telemetry, bug intake, an update check or a license call reaches a Smithers host.
- The formula downloads from a Smithers-run bucket instead of GitHub Release assets, or builds from source because no macOS arm64 bottle exists (§16.1.0a).
- The install works only with `SMITHERS_TOKEN` set or after `smthrs login`.
- Any `sudo`, root process or password prompt appears in a ticket-owned formula, bottle build/pour, signing or host-start step.
- The first machine pulls the guest base image from a registry instead of the bundled archive (§16.1.0).

## Evidence
`.artifacts/checks/C-REL-02/<UTC timestamp>/`: the connection log and its classification table, the terminal transcript with timestamps, `brew info smithers`, `smthrs host status` output, the screen recording, version V and its commit.

## Recorder
Start the screen recording and logging DNS resolver before the recorder. Run
`node scripts/journeys/release-install.mjs <owner-config.json>` as the installing
user. The config names a new absolute `evidence` directory, an absolute `dnsLog`
export path, the release `version` and 40-character `commit`, and `hostnames`
with exact hostname arrays under `distribution`, `provider`, `registry` and
`apple`. Use the configured providers and registries; do not approve unknown
hosts just to make classification pass. Smithers domains are always forbidden.
Optional `readyURL` is a loopback HTTP `/readyz` endpoint (default port 4000).

The recorder invokes the public tap install and installed start/status commands,
repeats start, timestamps streamed output and readiness, and records unprivileged
`nettop -m route -L 0 -s 1` continuously until the operator finishes setup and
the question. Export the resolver's full session to `dnsLog` as JSONL rows
`{"at":"<ISO UTC timestamp>","hostname":"<queried hostname>"}` before typing
`done`. It retains the raw export and classifies every in-session row. Failed
commands, readiness, network capture and classification retain failure evidence.

These files are diagnostic, never publication receipts. The check owner reviews
the screen recording, full resolver coverage (including other Mac processes),
process-uid logs for bottle building/signing/pouring, no-source-build pour proof,
entitlements and relocation, the actual keg and LaunchAgent, fixed-expectation
verification-fault cases in T-INS-05, and setup/question evidence before accepting
a release-bound authenticated receipt. The recorder cannot prove those manual
and macOS observations. A Linux recorder test does not qualify the bottle.

Reconciliation: T-INS-05 and normative §16.1.2 replace this check's obsolete
sudo/LaunchDaemon expectations with an unprivileged per-user LaunchAgent. This
clarifies the contract; it does not infer a check-owner or signing verdict.
