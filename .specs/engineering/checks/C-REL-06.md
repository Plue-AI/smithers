# C-REL-06 Quiesce and backup make one consistent snapshot under concurrent work, and it restores on a second Mac

Proves: mvp.md M-26, §12.6, §6.1 Restart · spec.md §8.2.1, §16.4, §16.5.1–§16.5.3, §17.4, §19.1, §19.2 · Layer: e2e and fault · Stage: R · Tickets: T-INS-07
Automation: `scripts/release/backup-restore.mjs` (new) drives both Macs, the load and the comparison; `packages/smithers/test/host-backup.fault.test.ts` (new) drives the kill points; `packages/backend/internal/services/install_quiesce_integration_test.go` (new) covers the freeze gate · Runs in: reference host A and a second Mac B, recorded

## Setup
- Host A: the reference host with the release candidate at commit X installed from the tap, set up against the scratch repository `smithers-mvp-canary/<date>`, with members Ben and Alice.
- Mac B: a different Apple Silicon Mac, erased, macOS 15 or later, with a macOS user name different from A's (so `$STATE` has a different absolute path), Homebrew, and Smithers installed from the tap at commit X with no `$STATE`.
- Load on A that runs through step 1:
  - branches T1 and S awake; on each, Ben's terminal appends a counter to `count.txt` every 100 ms;
  - TODO T1's coding run inside a step;
  - a wiki page edited through the API every 200 ms;
  - an app-agent turn running in `main`'s conversation;
  - a PR comment for T1 queued just before the backup starts;
  - Ben's Claude Code and Codex logins in the credential store, and a `~/.marker` in his home on T1's machine.

## Steps
1. On A, run `smthrs host backup`. Throughout it, every 250 ms from a second client, try to create a TODO, open a terminal on S, edit the wiki page, wake an asleep branch and post a prompt.
2. Read `MANIFEST.json` and list the backup directory with sizes and modes.
3. Stop A. Archive the backup directory with `tar`, copy the archive to B, extract it into B's `~/Library/Application Support/Smithers/backups/`, and run `smthrs host restore <dir>` on B.
4. On B, compare with the manifest:
   - the Home card's stack (`GET /api/stack` and the `home` snapshot): each TODO's number, state and place;
   - every file's SHA-256;
   - each branch's captured head; after each branch wakes, its working copy is at that head, `count.txt` holds the captured content, and Ben's home holds `~/.marker` with his uid and mode 0700;
   - each credential store row (member, file, `written_at`, ciphertext SHA-256), and that each row decrypts under the restored install key;
   - each run journal's last finished step, and that no projection is ahead of its journal;
   - every `activity.snapshot_before` and `snapshot_after` exists in the repository store, and the wiki page's latest revision equals its persisted document state.
5. Let B run for 5 min, and open Ben's terminal on T1's machine. Then stop B.
6. Start A again from its own data. Repeat step 1 six times with a fault hook, killing the backup command once at each point: after the freeze, during the drain, during machine capture, during `pg_dump`, during the clone, and before the manifest rename. After each kill, wait 31 s and create a TODO.
7. Delete `MANIFEST.json` from one complete backup, change one byte of another backup's dump, and run `smthrs host restore` on each.
8. Fill A's volume until free disk minus 40 GiB is below the database size, and run `smthrs host backup`.
9. Run `smthrs host backup` four more times, then list `backups/`.

## Pass when
- Step 1: every attempted mutation gets `{code: "install_quiesced", class: "infra", retry_at}`; reads succeed throughout; the same mutations succeed after the command exits.
- Step 2: the manifest lists version, schema version, PostgreSQL major, quiesce op and time, every file's path, size and SHA-256, and the stack, branch-head, credential and run-journal summary. No path is absolute. The directory is mode 0700 and contains no `backups/`, `logs/` or PostgreSQL data directory.
- Step 3: restore verifies every hash and exits 0; B's install starts with every machine asleep.
- Step 4: every comparison holds.
- Step 5: T1's run continues from its last finished step with no completed step re-run, or shows interrupted with Retry; the queued PR comment exists exactly once on GitHub; the app-agent turn completes or shows interrupted; Ben's terminal shows no login prompt for Claude Code or Codex; capacity reads the formula for B's host profile.
- Step 6: no kill leaves a directory with a manifest, only `backups/.partial-*`; 31 s after each kill the TODO is created, and machines wake on demand.
- Step 7: both restores refuse, naming the missing manifest or the hash mismatch, and change nothing.
- Step 8: refused before the freeze; admissions never close.
- Step 9: exactly the three newest backups remain.

## Fail when
- A mutation succeeds between the freeze and the reopen.
- B shows a TODO, branch head, home, credential row or run step that differs from the manifest, or an activity entry whose snapshot is missing.
- The restore needs any file from A other than the backup directory, or reads a cloned PostgreSQL data directory.
- Admissions stay closed after a crashed backup.

## Evidence
`.artifacts/checks/C-REL-06/<UTC timestamp>/`:
- `MANIFEST.json` and `backup-tree.txt` (paths, sizes, modes);
- `host-a.json` and `host-b.json`: host profile, macOS version, Smithers version and `$STATE` path;
- `mutation-refusals.log` with timestamps;
- `restore-compare.json`: each manifest summary item and file hash with its expected value, its actual value on B and a pass flag;
- B's `smthrs host restore` and `smthrs host start` transcripts;
- Home card screenshots on A before the backup and on B after the restore;
- run journals and projections before and after, and the GitHub write log for T1's PR;
- `kill-points.log`, `ls -lR backups/` after step 9, and commit X.
