# C-COL-03 The mutation lock: no writer loses a write or lands mid-rewrite

Proves: mvp.md §4.2 Rebase ("first snapshots every writer's work and never runs during a write made through Smithers"), §6.8 No silent overwrite, M-27, M-32 · spec.md §7.6 (row 1), §9.2.2, §9.4.1, §9.4.2 · Layer: integration · Stage: S2, S3 · Tickets: T-COL-03, T-STK-11, T-COL-05, T-COL-08, T-COL-03a, T-COL-08a
Automation: `crates/smithers-machined/tests/barrier.rs` (new) · Runs in: CI on a Linux runner with real jj, inotify and cgroup v2, and a reference-host microVM

## Setup

- A test build with pause hooks (`SMITHERS_MACHINED_PAUSE_AT=<point>`, test builds only) and a working copy of `smithers-mvp-canary` content on an item change with a TODO.
- Writers, each logging `(writer, seq, path, sha256)` only after its write returns:
  - W1: the agent's write tool through the local socket, writing `src/w1/*` with read digests;
  - W2: app `write_file` through the host connection (`file.restore` and plain writes);
  - W3: a member pty session appending to `src/w3.log` in a loop;
  - W4: an exec session doing editor-style temp-and-rename saves of `src/a.ts` every 50 ms;
  - W5: an exec session doing in-place truncate-and-write saves of `src/b.ts` every 50 ms;
  - W6 (S3): two document clients typing in `src/c.ts`.
- A new base commit that changes only `README.md`, so rebases don't conflict.

## Steps

1. Start every writer. Call `rebase(onto)` 50 times, 2 s apart.
2. Move the working copy with `jj new main` from W3's session, then call `return_to_item()`. Repeat 10 times.
3. Pause at the `frozen` point. Issue W1 and W2 writes, one of them with a `base_digest` on `README.md` taken before the rebase. Release.
4. Force a freeze timeout (hook: `frozen` never reported) and call `rebase(onto)`.
5. Race `write_file` against an outside rename: a hook pauses between the daemon's digest check and its swap while W4 saves, 100 times.

## Pass when

- Every write a writer logged before a rebase or move started is, by SHA-256, in the rewritten working copy or in a recorded version (a versions commit in the host store). None is lost.
- Between `frozen 1` and the thaw, the inotify log shows no working-copy event from any session process.
- Step 3: the queued writes complete after the rewrite; the stale `README.md` write gets `409 stale`, and the others apply on the new base.
- Step 4: nothing is rewritten, every session thaws within 1 s, the reply is `busy`, and `rebase_pending` stays set. The reply names the blocking session for the presser; releasing that blocker triggers an automatic retry (§9.4.2).
- Step 5: in 100 of 100 runs the daemon's write is either applied over the base it named or refused `409 stale` with W4's file swapped back; W4's save is never lost.
- (S3) Both document texts after each reconcile hold every keystroke typed during the hold, with its author, and "Rebased onto Tk" is one transaction.
- The lock hold is recorded per run; p95 under 2 s (C-PERF-06 measures it on the reference host).

## Fail when

- A session process writes while frozen, or a write lands between capture and thaw.
- A queued write applies against a stale base, or a stale write silently replaces newer content.
- Keystrokes stop relaying to other clients during the hold.

## Evidence

`.artifacts/checks/C-COL-03/<UTC timestamp>/`: the writer logs, the inotify trace with freeze and thaw marks, before and after tree hashes per run, lock-hold timings, the daemon log, and `env.json` (commit, kernel, jj version).
