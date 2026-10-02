# C-DUR-04 Daemon or VM killed during a burst or capture

Proves: mvp.md §9 Durability, M-27 ("every change is recoverable from snapshots") · spec.md §8.4.3, §9.1.1–9.1.3, §9.3.4, §19.1 · Layer: fault · Stage: S2 · Tickets: T-COL-03, T-REL-04
Automation: `packages/backend/internal/machined/fault_test.go` (new) driving `crates/smithers-machined` kill hooks (`SMITHERS_MACHINED_KILL_AT=<point>`, test builds only) · Runs in: CI on a Linux runner with real inotify, cgroups and jj (daemon kills), and the reference host (VM kills)

## Setup

- A build of the commit under test with kill hooks compiled in, never in release builds. Real PostgreSQL and a real jj working copy of `smithers-mvp-canary` content.
- One machine with the daemon connected. A writer process runs in a member session cgroup. It writes files with `write` + `fsync` + `close` and logs `(seq, path, sha256)` to the host only after `close` returns, so each logged line is an acknowledged write.
- Kill points:
  - K1: the daemon dies with a burst open.
  - K2: after the burst's jj snapshot, before the burst event is queued.
  - K3: event in the outbox, before it is sent.
  - K4: the host commits the activity row, then the host dies before acknowledging.
  - K5a/b/c: capture after snapshot / during the push of the head and snapshot commits / after the push, before verify.
  - K6: the VM is killed (`msb` force stop) at K1 and at K5b.
  - K7: the daemon dies with an unflushed live document while two clients type. T-COL-08 adds it, and it runs from stage 3; K1–K6 gate stage 2.

## Steps

1. For each kill point, run the writer for 20 files, trigger the point, and let the guest init restart the daemon (§9.1.3), or wake the VM for K6.
2. Wait for the daemon to report `status()` ready and for its outbox to drain.
3. Run `capture()` once.
4. Compare the writer log with the working copy, the captured head tree, and the `activity`/`burst_files` rows.
5. Repeat each kill point 10 times.

## Pass when

- Every acknowledged write's bytes (by SHA-256) are in the working copy after restart and in the tree of `refs/smithers/branches/<id>/head` after step 3, across all 10 runs of every kill point.
- Every written path appears in exactly one `burst_files` row of one activity entry. No `burst_id` appears twice (K3, K4 redelivery). Every entry's `snapshot_before` and `snapshot_after` exist in the host store.
- At K5a–c and K6, the head ref is either the previous capture or the new one, and always names a commit present in the host store. Step 3 converges to the working copy's snapshot.
- After K1–K3 the daemon is reconnected within 5 s plus restart time, and the branch shows the machine awake without manual action.
- K7 (S3): after reconnect, both clients and the file on disk converge to identical text that contains every keystroke both clients sent.

## Fail when

- A file the writer logged as written is missing or has older bytes after restart.
- An activity entry is duplicated, or a burst's files vanish from activity.
- The head ref points at a commit the host store lacks, or moves backwards past an earlier capture.
- The daemon stays dead until someone restarts the machine by hand.
- Kill hooks are present in a release build (`strings` on the bundled binary finds `SMITHERS_MACHINED_KILL_AT`).

## Evidence

`.artifacts/checks/C-DUR-04/<UTC timestamp>/`: per kill point and run, the writer log, the working-copy hashes, the head ref before and after, an export of the `activity` and `burst_files` rows, the daemon and host logs, the outbox contents at the kill, and `env.json` (commit, runner kernel, msb version).
