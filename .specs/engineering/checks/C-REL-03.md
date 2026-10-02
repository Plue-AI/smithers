# C-REL-03 A launch-day install upgrades to the next release with all data intact

Proves: mvp.md M-26, §12.6 · spec.md §6.3 (quiesce), §16.4, §16.5, §19.1 · Layer: journey · Stage: R · Tickets: T-INS-07
Automation: `scripts/journeys/upgrade.mjs` (new) computes digests and drives the CLI; the session is screen-recorded · Runs in: reference host, recorded manual

## Setup
- Release N (the launch candidate tag) installed from the tap, claimed by the owner, set up against `smithers-mvp-canary/<date>`.
- Release N+1: a tap version built from a later commit with at least one forward migration that rewrites an existing table, and a changed bundle file.
- Data created through the product on N: 3 members (owner, Maintainer, Member); 2 secrets (one main-only); a wiki page with 3 revisions; a repository flow override Active plus one failed version; TODOs in each state (queued, working with the agent mid-step, needs you, paused, failed, in review, merged, dropped); one asleep scratch branch whose captured working copy has an uncommitted file; a member home with a tool login file; bind `0.0.0.0` and two public origins.

## Steps
1. Record digest D1: per-table row counts and content hashes (columns the N+1 migration rewrites listed and excluded), repository store refs, blob hashes, member home file hashes read from each machine disk, secret names, flow activations, `install_settings` rows.
2. Start a merge and run `smthrs host upgrade` while it is in flight. Then open a burst (write in a terminal) and run it again.
3. With no merge in flight and no burst open, but with work in flight (the working TODO's agent mid-step, Alice's terminal open on another branch, an app-agent turn running), run `smthrs host upgrade`. Record each step's output and duration.
4. After success: digest D2; sign in as each member on each origin; resume the working TODO; merge the in-review TODO; wake the scratch branch and read the uncommitted file; check a secret reaches a machine's environment and its value is not readable through the API.
5. On a copy restored from step 3's backup, install N+1′ whose migration fails; run `smthrs host upgrade`; run the printed `smthrs host restore` command; record digest D3.

## Pass when
- Step 2: each run refuses and names the merge or the burst; D1 is unchanged after both.
- Step 3 exits 0 and leaves `$STATE/backups/N-<ts>/` with `MANIFEST.json` and the saved release N bundle (§16.4 step 3, §16.5.2).
- Step 4: D2 equals D1 outside the listed migrated columns; every action succeeds; the working TODO continues from its last finished step and its journal shows no completed step re-run; the bind and origins still apply; the app-agent turn from step 3 completed or shows interrupted with Retry, and Alice can open a new terminal.
- Step 5: the upgrade exits non-zero, prints one restore command, and after running it D3 equals D1 and release N serves.

## Fail when
- The upgrade starts while a merge is in flight.
- Secrets no longer decrypt after the upgrade (the install key changed).
- The restore needs a binary that `brew cleanup` already removed.
- Data written after the backup is lost without the restore command saying so.

## Evidence
`.artifacts/checks/C-REL-03/<UTC timestamp>/`: D1, D2 and D3 as JSON, CLI transcripts, the backup `MANIFEST`, the screen recording, versions N, N+1 and N+1′ with their commits, the host profile.
