# C-COL-05 Watcher completeness: per-file versions, metadata watches, overflow resync

Proves: mvp.md §6.8 External changes and Save and recovery guarantees (Capture, Restore), M-27 · spec.md §9.1.4, §9.3.1–9.3.5, §9.3.8 · Layer: integration · Stage: S2 · Tickets: T-COL-04, T-COL-05
Automation: `crates/smithers-machined/tests/versions.rs`, `crates/smithers-machined/tests/overflow.rs` (new), `packages/backend/internal/machined/events_integration_test.go` · Runs in: CI on a Linux runner with real inotify, cgroup v2, jj and a real host store

## Setup

- A working copy on an item change, with a TODO. Maya has an exec session; the coding agent writes through the local socket in a registered run; the app writes through the host connection.
- Each writer logs the SHA-256 of what it wrote.

## Steps

1. Overlap: Maya writes `a.ts` and `b.ts`. Within 500 ms the agent writes `c.ts`, then `a.ts` with Maya's digest as base.
2. Actor switch the other way: the agent writes `d.ts`. Within 200 ms Maya replaces `d.ts` with a temp-and-rename save.
3. Drain before write: Maya writes `e.ts`, and within 1 ms, before the watcher has read the event, the agent writes `e.ts` with Maya's digest as base.
4. Restore: on a copy of the branch, press `file.restore` for each file of each entry from steps 1–3.
5. Overflow: set `fs.inotify.max_queued_events` to 64 in the guest. In one burst of activity, create `newdir/` with 50 files, modify 200 tracked files, and run `jj new main` (a move). Restore the limit, then write `newdir/late.ts`.
6. Metadata only: `jj edit <change off the item>` whose tree equals `@`'s; then, back on the item, `git checkout -b x` (HEAD moves, same commit).

## Pass when

- Step 1: Maya's entry lists `a.ts` and `b.ts`, with `a.ts` after = Maya's bytes. The agent's entry lists `c.ts` and `a.ts`, with `a.ts` before = Maya's bytes and after = the agent's. Neither entry's diff shows the other's files, and Maya's burst closed before the agent's `a.ts` write applied.
- Step 2: the agent's entry has `d.ts` after = the agent's bytes, though Maya replaced the file within 200 ms; Maya's entry has `d.ts` before = the agent's bytes and after = hers.
- Step 3: Maya's `e.ts` write is its own outside entry; the agent's entry has `e.ts` before = Maya's bytes.
- Step 4: every Restore writes exactly that entry's `before` bytes, or opens Compare when the file changed since.
- Step 5: exactly one "changed outside Smithers" entry lists every changed path, including all 50 files under `newdir/`; `newdir/late.ts` produces its own event (the watch was re-armed); `moved_off` is raised after the resync; no write was accepted during the resync.
- Step 6: the `jj edit` raises `moved_off` within 1 s though no tracked file changed; `git checkout -b x` raises nothing.
- Every entry's versions commit is in the host store, and redelivering any burst event adds no row.

## Fail when

- An entry's diff includes another actor's change, or an actor's end state for a file is missing.
- A file changed during the overflow is in no entry, or a directory created during it stays unwatched.
- A move with no tracked-file change goes undetected.

## Evidence

`.artifacts/checks/C-COL-05/<UTC timestamp>/`: the writer logs, each burst event as received, the `activity` and `burst_files` rows, each versions commit's tree listing, the inotify and resync logs, and `env.json` (commit, kernel, jj version).
