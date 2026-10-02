# T-COL-04 Watcher (inotify), session-based attribution, ignore rules, bursts, activity

Stage S2 · Size L · Depends on T-COL-03, T-MCH-11, T-COL-10 · Unblocks T-STK-11, T-COL-05, T-COL-06, T-COL-07, T-COL-08, T-APP-10, T-APP-11, T-REL-03, T-REL-04, T-REL-01 · Issue: to file
Spec: spec.md §2 (Activity entry, actor notation), §3 (`activity`, `burst_files`), §7.2 (`:activity`, `:files`), §7.6 (row 6), §8.4.4, §8.10.3, §8.11.1, §9.1.2 (`register_run`), §9.3.1–9.3.4, §18 · Delta: delta.md §4 (`smithers-machined` S2; `burst_files`, `file_written` and snapshot commits row) · Product: mvp.md J3.2, J3.4, §6.8 External changes and Live updates, M-24, M-27

## Goal

When anything writes the working copy, an open card reloads within 1 s, and the branch shows one activity entry per burst with an honest author: the exact actor for writes through Smithers, the only active session's person for other writes ("Maya via SSH changed 12 files"), and "changed outside Smithers" otherwise. Every entry opens a diff between two snapshots the host store holds, so it works while the branch sleeps, and **Restore this file** puts one file back.

## Scope

In:
- inotify on the working copy (§9.3.1): recursive watches, re-armed on directory creation, with a scan of each new directory so files created before the watch is armed are not missed.
- Attribution (§9.3.1):
  - **Writes through Smithers** (the coding agent's write tool, app commands such as `file.restore`, and File card documents from S3) arrive as `write_file(path, base_digest, content, actor)` (§7.6 row 1). The daemon matches the following inotify event by path and digest and records that exact actor, even while other sessions are active.
  - **Other writes** (terminal tools, SSH editors, the agent's `bash`, hand-run `git`/`jj`) form one burst, attributed at close to the actor of the only session active on the branch during the burst. Sessions are the daemon's PTYs and processes from `open_session`: people's terminals and SSH sessions, and the agent's terminal, which `register_run(run_id, cgroup)` maps to `{agent: coding, run}`. With more than one active session, or none, the burst is `{outside: true}` and reads "changed outside Smithers".
  - [D] Exact per-write kernel attribution (fanotify with writer pids).
- `IN_Q_OVERFLOW` (§9.3.2): a full jj snapshot, recorded as one burst "changed outside Smithers".
- Ignore rules (§9.3.3): everything jj ignores, `.jj/`, `.git/` internals except `HEAD` and refs, and the toolchain paths T-MCH-10 names. Ignored directories get no watch, so their events never reach the daemon; the rest are filtered in user space. Events on `.git/HEAD`, refs and jj operation heads go to the moved-off detector (T-COL-05), never into `files[]`.
- `file_written{path, actor, post_digest}` within 200 ms of each write to a tracked path (§9.3.4, §7.6 row 6). The host turns it into a `branch:<id>:files` delta, so open File and Diff cards reload in under 1 s (§18, T-APP-11).
- Bursts (§9.3.4), keyed by the attributed actor: closed after 1.5 s quiet, 10 s after opening, or when another key writes a file this burst touched. On close, a jj snapshot and one burst event `{burst_id, actor, files[{path, change, renamed_to?, post_digest}], snapshot_before, snapshot_after}`. Both snapshot commits are pushed to `refs/smithers/branches/<id>/snapshots/<burst>`, coalesced, so a sleeping branch's activity and diffs never need the machine (§8.4.4).
- Presence feed: the last file of a burst attributed to a session becomes that session's `where` (§7.3.1, §8.10.4). An outside burst updates no session.
- Host ingest, idempotent by `burst_id`, in one transaction: one `activity` row (`kind = change`, actor, `burst_id`, snapshots, `files`), one `burst_files` row per file, and deltas on `branch:<id>:activity` and `branch:<id>:files`.
- Backend for **Restore this file** (`file.restore`, §9.3.5): `read_file(path, at = snapshot_before)`, then `write_file` with the burst's `post_digest` for that path as `base_digest` and the presser as actor. A `409 stale` (the file changed since that burst) writes nothing and returns `conflict`, so the card opens Compare. T-APP-11's `file.restore-deleted` uses the same service with base `"absent"`.

Out:
- The `activity` table and `branch:<id>:activity` topic (T-STK-01, S1). Moved-off (T-COL-05), the agent's transcript note (T-COL-07), presence semantics (T-COL-06), documents (T-COL-08), the File and Diff card UI (T-APP-11) and the Branch card (T-APP-10).
- [D] Per-entry Undo, command names and replaced-edit flags (§9.3.5–9.3.7).

## Changes

- `crates/smithers-machined/src/`: `watch.rs` (inotify, re-arm and scan), `ignore.rs`, `attrib.rs` (write_file matching, session activity), `session.rs` (registry fed by `open_session` and `register_run`), `burst.rs`, `events.rs` (`file_written`, burst events, snapshot push).
- The coding host's run start calls `register_run` (`flows/coding/` runtime entry).
- `packages/backend/internal/machined/events.go` (new): ingest, outbox acknowledgement after commit, `live.Publish`.
- `packages/backend/internal/services/file_restore.go` (new) and the `file.restore` catalog row (`agent: run`, in-card, T-CAT-01).
- `packages/backend/db/product/migrations/<next>_burst_files.sql` (new): `burst_files` (§3), its queries and sqlc output. Add the §3 burst columns to `activity` only if T-STK-01's migration omitted them.
- `packages/backend/docs/machined.md`: watcher, attribution, ignore and burst rules; `docs:sync`, `docs:check`, `smthrs docs //packages/backend:docs`.

## Tests

- unit (`burst.rs`): every close rule, plus a property test over random event streams: each event lands in exactly one burst, no burst exceeds 10 s, and a cross-key touch closes the earlier burst first.
- unit (`attrib.rs`, fixture cgroup trees): one active session gives its actor, two or none give `{outside: true}`, a registered run's terminal gives `{agent: coding, run}`, and a matched `write_file` keeps its exact actor with three sessions active.
- unit (`ignore.rs`): matches `git check-ignore` on a fixture of 200 paths with nested `.gitignore` files.
- integration, real inotify (`crates/smithers-machined/tests/watch.rs`, Linux runner or microVM): Maya alone runs a 12-file formatter → one burst by Maya; the same with Ben's terminal busy → one outside burst; each write emits `file_written` within 200 ms with the right `post_digest`; `node_modules/` and `target/` writes give no events; `mkdir d && touch d/x` is captured; `mv a b` gives `renamed` and an editor's temp-and-rename save gives `modified`; the daemon's own snapshot gives no event; a forced `IN_Q_OVERFLOW` gives one outside burst.
- integration, real PostgreSQL and host store (`packages/backend/internal/machined/events_integration_test.go`): one burst event commits one `activity` row, N `burst_files` rows and both deltas; a redelivered `burst_id` adds nothing; the diff is served with the machine asleep.
- integration (`file_restore`): the file's bytes equal its `snapshot_before` content and the new entry names the presser; a file changed since gets `conflict` and is untouched.
- perf: C-PERF-04. e2e: C-J3-03.
- contract: the §7.6 row-6 assertion (every `file_written` and burst `files[]` entry carries `post_digest`) in `packages/backend/internal/compose/cocontracts_test.go` (T-COL-10).

## Acceptance

- [C-J3-03](../checks/C-J3-03.md): one grouped entry attributed to the only active session, else "changed outside Smithers"; it opens the diff; Restore this file works; open cards update.
- [C-PERF-04](../checks/C-PERF-04.md): an outside disk write reaches an open File card in < 1 s p95.
- [C-J3-06](../checks/C-J3-06.md): a VS Code Remote edit over SSH lands attributed.

## Risks and notes

- Reading of "active" in §9.3.1: a session is active during a burst when it is open and its cgroup's CPU time (`cpu.stat` `usage_usec`) grew in the burst window, so a shell idle at its prompt doesn't count. Resolved: spec §9.3.1 adopts this definition.
- A long-running SSH editor server (VS Code's) keeps its session active, so a teammate's concurrent terminal command turns the burst outside. Confirmed by C-J3-06 with a second session busy. This is spec behavior, not a bug.
- inotify needs one watch per directory. Confirmed broken if adding a watch on the smithers repository fails with `ENOSPC`. Raise `fs.inotify.max_user_watches` in the guest image.
- Each burst close runs a jj snapshot. If T-COL-01's snapshot p95 exceeds 500 ms, the 1.5 s close rule still holds but capture lags; escalate before changing the rule.
