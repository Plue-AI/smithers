# C-DUR-04 Daemon, VM or host killed during a burst, capture or document save

Proves: mvp.md §9 Durability, §6.8 Save and recovery guarantees, M-27 ("every change is recoverable from snapshots") · spec.md §7.4.2, §7.4.6, §8.4.3, §9.1.1–9.1.4, §9.2.2, §9.2.5, §9.3.4, §19.1 · Layer: fault · Stage: S2, S3 · Tickets: T-COL-03, T-COL-08, T-COL-09, T-REL-04, T-COL-03a, T-COL-04a, T-COL-04, T-COL-08a, T-COL-08b
Automation: `packages/backend/internal/machined/fault_test.go` (new) driving `crates/smithers-machined` kill hooks (`SMITHERS_MACHINED_KILL_AT=<point>`, test builds only) · Runs in: CI on a Linux runner with real inotify, cgroups and jj (daemon kills), and the reference host (VM kills)

## Setup

- A build of the commit under test with kill hooks compiled in, never in release builds. Real PostgreSQL and a real jj working copy of `smithers-mvp-canary` content.
- One machine with the daemon connected. A writer process runs in a member session cgroup. It writes files with `write` + `fsync` + `close` and logs `(seq, path, sha256)` to the host only after `close` returns, so each logged line is an acknowledged write.
- Kill points:
  - K1: the daemon dies with a burst open.
  - K2: after the burst's versions commit is built, before the event enters the outbox.
  - K3: event in the outbox, before its refs are pushed.
  - K3b: refs pushed, before the event is sent.
  - K4: the host commits the activity row, then the host dies before acknowledging.
  - K5a/b/c: capture after snapshot / during the push of the head and snapshot commits / after the push, before verify.
  - K4b: the host connection is cut for 30 s while 50 bursts close, then restored (no restart).
  - K6: the VM is killed (`msb` force stop) at K1 and at K5b.
  - K7 (S3, T-COL-08), two clients typing in one file under the topology ADR 0003 chose:
    - K7a: the daemon dies with an unsaved document;
    - K7b: after a `saved` frame, the daemon, the VM, or the host service dies (one run each; with the host mirror, the host kill also discards the mirror);
    - K7c: the daemon dies between the state record write and the swap (§9.2.2 steps 1–3);
    - K7d: with the daemon stopped, an outside write rewrites the file; then the daemon restarts and the clients reconnect with their old documents.
    - K7e: retain client updates not covered by `saved`, stop the daemon and remove or corrupt the document state record; restart so the document recovers from disk with a new epoch. Reconnect both clients; choose Reapply in one and Copy in the other.
  - K8 (S3, T-COL-09): the host service dies 1 s after the last keystroke while two clients type on a wiki page; variant: both tabs close after the last `saved`, then the host dies, then one member reopens the page.

K1–K6 gate stage 2; K7 and K8 gate stage 3.

## Steps

1. For each kill point, run the writer for 20 files, trigger the point, and let the guest init restart the daemon (§9.1.3), or wake the VM for K6.
2. Wait for the daemon to report `status()` ready and for its outbox to drain.
3. Run `capture()` once.
4. Compare the writer log with the working copy, the captured head tree, and the `activity`/`burst_files` rows.
5. Repeat each kill point 10 times.

## Pass when
- K7e (S3): each client retains its unacknowledged edits and shows "N edits weren't saved" with Reapply and Copy. N equals that client's retained edit count. Reapply adds the retained edits once as new edits attributed to that member; Copy places their text on the clipboard without changing the recovered document (§9.2.5).


- Every acknowledged write's bytes (by SHA-256) are in the working copy after restart and in the tree of `refs/smithers/branches/<id>/head` after step 3, across all 10 runs of every kill point.
- Every written path appears in exactly one `burst_files` row of one activity entry. No `burst_id` appears twice (K3, K3b, K4, K4b redelivery). Every entry's versions commit, with each file's `before` and `after` blob, exists in the host store, and the outbox is empty afterwards.
- At K5a–c and K6, the head ref is either the previous capture or the new one, and always names a commit present in the host store. Step 3 converges to the working copy's snapshot.
- After K1–K3 the daemon is reconnected within 5 s plus restart time, and the branch shows the machine awake without manual action.
- K7a–K7d (S3): after reconnect, both clients and the file on disk converge to identical text that contains every keystroke covered by a `saved` frame, and every keystroke either surviving client sent, each exactly once. K7a–K7c keep the document's epoch, so no client resyncs fresh. K7c leaves the file equal to the state record with no "Changed outside Smithers" flag. K7d keeps the authors of unchanged characters and attributes the rewrite as an outside edit.
- K8 (S3): the reopened page holds every keystroke both clients sent, each once; in the variant, every keystroke a `saved` frame covered.

## Fail when

- A file the writer logged as written is missing or has older bytes after restart.
- An activity entry is duplicated, or a burst's files vanish from activity.
- A reconnecting client's text shows a character twice, or a document reseeds from text (a new epoch) while its state record exists.
- The head ref points at a commit the host store lacks, or moves backwards past an earlier capture.
- The daemon stays dead until someone restarts the machine by hand.
- Kill hooks are present in a release build (`strings` on the bundled binary finds `SMITHERS_MACHINED_KILL_AT`).

## Evidence

`.artifacts/checks/C-DUR-04/<UTC timestamp>/`: per kill point and run, the writer log, the working-copy hashes, the head ref before and after, an export of the `activity` and `burst_files` rows, the daemon and host logs, the outbox contents at the kill, for K7 and K8 both clients' texts and the state record or PostgreSQL row before and after, and `env.json` (commit, runner kernel, msb version).
