# T-COL-04 Backend change events, restore and watcher integration

Stage S2 · Size M · Depends on T-COL-03, T-COL-04a, T-COL-03f, T-TRM-07, T-MCH-11, T-COL-03r · Unblocks T-APP-10, T-APP-11, T-COL-05, T-COL-06, T-COL-08, T-COL-12, T-REL-01, T-REL-02, T-REL-03, T-REL-04, T-STK-08 · Issue: [#3561](https://github.com/smithersai/smithers/issues/3561)
Spec: spec.md §2 (Activity entry, actor notation), §3 (`activity`, `burst_files`), §7.2 (`:activity`, `:files`), §7.6 (row 6), §8.4.4, §8.10.3, §8.11.1, §9.1.2 (`register_run`), §9.1.4, §9.3.1–9.3.5, §9.3.8, §9.4.1, §18 · Delta: delta.md §4 (`smithers-machined` S2; `burst_files`, `file_written` and versions commits row) · Product: mvp.md J3.2, J3.4, §6.8 External changes and Live updates, M-24, M-27

## Goal

When anything writes the working copy, an open card reloads within 1 s, and the branch shows one activity entry per burst with an honest author: the exact actor for writes through Smithers, the only active session's person for other writes ("Maya via SSH changed 12 files"), and "changed outside Smithers" otherwise. Every entry opens a diff between two snapshots the host store holds, so it works while the branch sleeps, and **Restore this file** puts one file back.

## Scope

- M-34 participants have id, agent kind, avatar, run/session and optional `for_member`. Smithers, Coding agent, Claude Code, Codex and Reviewer each have their own avatar and show for Ben. The broker registers agent process lifetime; ordinary terminal commands remain person-channel activity. Adapt historical `via` actors. Participant ids grant no authorization rights. Checks: C-J3-04, C-J3-10.


In:
- Host ingest, idempotent by `burst_id`, in one transaction: one `activity` row (`kind = change`, actor, `burst_id`, `versions_commit`, `files`), one `burst_files` row per file with `before_blob`, `after_blob` and `after_digest`, the `(branch, event_id)` receipt, and deltas on `branch:<id>:activity` and `branch:<id>:files`.
- Backend for **Restore this file** (`file.restore`, §9.3.5): read the file's `before` blob from the host store, then `write_file` with the burst's `post_digest` for that path as `base_digest` and the presser as actor. A `409 stale` (the file changed since that burst) writes nothing and returns `conflict`, so the card opens Compare. T-APP-11's `file.restore-deleted` uses the same service with base `"absent"`.- Wire T-COL-04a to real broker sessions and host register_run. Publish file_written hints and session where; connect overflow and metadata hooks to moved-off.
- Integrate watcher and capture with real daemon, real host store and real PostgreSQL.
Out:
- Rust watcher implementation (T-COL-04a).

- The `product_job_events` log and `branch:<id>:activity` topic (T-STK-01, S1). Moved-off (T-COL-05), the agent's transcript note (T-COL-10), presence semantics (T-COL-06), documents (T-COL-08), the File and Diff card UI (T-APP-11) and the Branch card (T-APP-10).
- [D] Per-entry Undo, command names and replaced-edit flags (§9.3.5–9.3.7).

## Changes

- The existing S2 burst writer emits edit lifecycle evidence with source_key equal to burst id and stored actor attribution. T-REL-03 only reads it; this adds no person-minute inference or effort ingestion. Check: C-REL-04.

- Encode and decode only through `packages/backend/internal/machined/wire` (T-COL-10); no local frame types, so the golden frames in `packages/backend/internal/compose/cocontracts_test.go` keep guarding this codec (smithers-3f, 2026-10-02).
- The host's run launch starts the coding host with `open_session(agent, exec)` and then calls `register_run(run_id, session)` (§9.1.2); the coding host never calls it.
- `packages/backend/internal/machined/events.go` (new): ingest, outbox acknowledgement after commit, `live.Publish`.
- `packages/backend/internal/services/file_restore.go` (new) and the `file.restore` catalog row (`agent: run`, in-card, T-CAT-01).
- `packages/backend/db/product/migrations/<next>_burst_files.sql` (new): `burst_files` (§3), its queries and sqlc output. Store burst metadata in the job-event data payload.
- `packages/backend/docs/machined.md`: watcher, attribution, ignore and burst rules; `docs:sync`, `docs:check`, `smthrs docs //packages/backend:docs`.
- No watcher implementation duplication; consume T-COL-04a modules and T-COL-10 event schemas.

## Tests

C-COL-05 (folded steps and assertions):
1. Overlap: Maya writes `a.ts` and `b.ts`. Within 500 ms the agent writes `c.ts`, then `a.ts` with Maya's digest as base.
2. Actor switch the other way: the agent writes `d.ts`. Within 200 ms Maya replaces `d.ts` with a temp-and-rename save.
3. Drain before write: Maya writes `e.ts`, and within 1 ms, before the watcher has read the event, the agent writes `e.ts` with Maya's digest as base.
4. Restore: on a copy of the branch, press `file.restore` for each file of each entry from steps 1–3.
5. Overflow: set `fs.inotify.max_queued_events` to 64 in the guest. In one burst of activity, create `newdir/` with 50 files, modify 200 tracked files, and run `jj new main` (a move). Restore the limit, then write `newdir/late.ts`.
6. Metadata only: `jj edit <change off the item>` whose tree equals `@`'s; then, back on the item, `git checkout -b x` (HEAD moves, same commit).

Pass when:
- Step 1: Maya's entry lists `a.ts` and `b.ts`, with `a.ts` after = Maya's bytes. The agent's entry lists `c.ts` and `a.ts`, with `a.ts` before = Maya's bytes and after = the agent's. Neither entry's diff shows the other's files, and Maya's burst closed before the agent's `a.ts` write applied.
- Step 2: the agent's entry has `d.ts` after = the agent's bytes, though Maya replaced the file within 200 ms; Maya's entry has `d.ts` before = the agent's bytes and after = hers.
- Step 3: Maya's `e.ts` write is its own outside entry; the agent's entry has `e.ts` before = Maya's bytes.
- Step 4: every Restore writes exactly that entry's `before` bytes, or opens Compare when the file changed since.
- Step 5: exactly one "changed outside Smithers" entry lists every changed path, including all 50 files under `newdir/`; `newdir/late.ts` produces its own event (the watch was re-armed); `moved_off` is raised after the resync; no write was accepted during the resync.
- Step 6: the `jj edit` raises `moved_off` within 1 s though no tracked file changed; `git checkout -b x` raises nothing.
- Every entry's versions commit is in the host store, and redelivering any burst event adds no row.

Fail when:
- An entry's diff includes another actor's change, or an actor's end state for a file is missing.
- A file changed during the overflow is in no entry, or a directory created during it stays unwatched.
- A move with no tracked-file change goes undetected.


- integration, real PostgreSQL and host store (`packages/backend/internal/machined/events_integration_test.go`): one burst event commits one `activity` row, N `burst_files` rows and both deltas; a redelivered `burst_id` adds nothing; the diff is served with the machine asleep.
- integration (`file_restore`): the file's bytes equal its `before` version and the new entry names the presser; a file changed since gets `conflict` and is untouched.
- perf: C-PERF-04. e2e: C-J3-03.
- contract: the §7.6 row-6 assertion (every `file_written` and burst `files[]` entry carries `post_digest`) in `packages/backend/internal/compose/cocontracts_test.go` (T-COL-10).
- Replay golden event frames through T-COL-03f into real PostgreSQL and host-store ingest; run identical cases against the real watcher.
- Run all original Linux watcher and versions fixtures with production sessions.
- Fault: own the complete C-DUR-04 K1–K6 matrix with real watcher, host, object store and VM; no fake substitutes for a full-check pass.

## Acceptance

- [C-J3-03](../checks/C-J3-03.md): one grouped entry attributed to the only active session, else "changed outside Smithers"; it opens the diff; Restore this file works; open cards update.
- [C-PERF-04](../checks/C-PERF-04.md): an outside disk write reaches an open File card in < 1 s p95.
- [C-J3-06](../checks/C-J3-06.md): a VS Code Remote edit over SSH lands attributed.
- [C-COL-05](../checks/C-COL-05.md): overlapping bursts and actor switches keep exact per-file versions; an overflow resync loses no change.
- [C-DUR-04](../checks/C-DUR-04.md): complete stage-2 K1–K6 matrix.
- [C-COL-01](../checks/C-COL-01.md): real S2 assertions for this component re-run the T-COL-03r golden-frame gate.

## Risks and notes

- Reading of "active" in §9.3.1: a session is active during a burst when its cgroup is populated and its CPU time (`cpu.stat` `usage_usec`) grew in the burst window, so a shell idle at its prompt doesn't count. Resolved: spec §9.3.1 adopts this definition.
- A long-running SSH editor server (VS Code's) keeps its session active, so a teammate's concurrent terminal command turns the burst outside. Confirmed by C-J3-06 with a second session busy. This is spec behavior, not a bug.
- inotify needs one watch per directory. Confirmed broken if adding a watch on the smithers repository fails with `ENOSPC`. Raise `fs.inotify.max_user_watches` in the guest image.
