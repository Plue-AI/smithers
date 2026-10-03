# T-COL-04 Backend change events, restore and watcher integration

Stage S2 · Size M · Depends on T-COL-03, T-COL-04a, T-COL-03f, T-TRM-07, T-COL-03r, T-STK-01, T-COL-02, T-CAT-01, T-ACC-03, T-COL-10 (S1) · Unblocks T-APP-10, T-APP-11, T-COL-05, T-COL-06, T-COL-08, T-COL-12, T-REL-01, T-REL-03, T-REL-04, T-STK-08 · Issue: [#3561](https://github.com/smithersai/smithers/issues/3561)
Spec: spec.md §2 (Activity entry, actor notation), §3 (`product_job_events`, `burst_files`), §7.2 (`:activity`, `:files`), §7.6.2, §8.4.4, §8.10.3, §8.11.1, §9.1.2 (`register_run`), §9.1.4, §9.3.1–9.3.5, §9.3.8, §9.4.1, §18 · Delta: delta.md §4 (`smithers-machined` S2; `burst_files`, `file_written` and versions commits row) · Product: mvp.md J3.2, J3.4, §6.8 External changes and Live updates, M-24, M-27
Ready: 2026-10-03 smithers-8a sha256:4127c2bd08c0

## Goal

When anything writes the working copy, an open card reloads within 1 s, and the branch shows one activity entry per burst with an honest author: the exact actor for writes through Smithers, the only active session's person for other writes ("Maya via SSH changed 12 files"), and "changed outside Smithers" otherwise. Every entry opens a diff between two snapshots the host store holds, so it works while the branch sleeps, and **Restore this file** puts one file back.

## Scope

- M-34 participants have id, agent kind, avatar, run/session and optional `for_member`. Smithers, Coding agent, Claude Code, Codex and Reviewer each have their own avatar and show for Ben. The broker registers agent process lifetime; ordinary terminal commands remain person-channel activity. Adapt historical `via` actors. Participant ids grant no authorization rights. Checks: C-J3-04, C-J3-10.


In:
- Host ingest, idempotent by `burst_id`, in one transaction: append one change entry through T-STK-01's existing `product_job_events` writer (actor, `burst_id`, `versions_commit`, `files` in data), one `burst_files` row per file with `before_blob`, `after_blob` and `after_digest`, and T-COL-03's `(branch, event_id)` receipt. Verify every named object in the host store before commit; return `missing_objects` without a receipt if one is absent. Publish both projection deltas through T-COL-02 only after commit. No `activity` table. Checks: C-COL-05, C-DUR-04.
- Lands dark until T-COL-03 and T-COL-03r: refuse ingest and Restore without an authenticated branch/boot connection, object verification, receipts and the shared codec. Until T-COL-04a and T-TRM-07, disable watcher integration and refuse session/run attribution; until T-COL-03f, the component gate cannot claim a pass. Until T-STK-01 and T-COL-02, refuse burst ingest without the transactional writer and live publisher. Until T-CAT-01, T-ACC-03 and T-COL-10 (S1), `file.restore` is unavailable without its catalog binding, authorizer and digest-guarded write path. Build against these contracts; no legacy or blind-write fallback. Checks: C-COL-01, C-COL-05.
- Lands dark until T-MCH-11: admit no watcher/session integration on an image without isolated unix identities and no-sudo confinement. This is an activation precondition, not a called-code dependency. Checks: C-COL-04, C-MCH-06.
- Lands dark until T-COL-05: emit the moved-off hook but refuse Restore while moved off; do not enable recovery controls. T-APP-10 and T-APP-11 enable their own cards; this ticket claims no card journey pass before those integrations. Checks: C-COL-05, C-J3-03.
- Backend for **Restore this file** (`file.restore`, §9.3.5): read the file's `before` blob from the host store, then `write_file` with the burst's `post_digest` for that path as `base_digest` and the presser as actor, resolved by T-ACC-03 through the T-CAT-01 command binding. Reuse T-COL-10's guarded workspace-write service after T-COL-03 routes it to the daemon. A `409 stale` (the file changed since that burst) writes nothing and returns `conflict`, so the card opens Compare. T-APP-11's `file.restore-deleted` uses the same service with base `"absent"`.
- Wire T-COL-04a to real broker sessions and host register_run. Publish file_written hints and session where; connect overflow and metadata hooks to moved-off.
- Integrate watcher and capture with real daemon, real host store and real PostgreSQL.
Out:
- Rust watcher implementation (T-COL-04a).

- A second activity log, event writer, live broker, codec or receipt table. Reuse `product_job_events` (T-STK-01), the live adapter (T-COL-02), codec (T-COL-03r) and receipts (T-COL-03). Moved-off recovery (T-COL-05), the agent's transcript note (T-COL-12), presence semantics (T-COL-06), documents and co-editing (T-COL-08), external-agent transcript discovery/import (T-AGT-02), the File and Diff card UI (T-APP-11) and the Branch card (T-APP-10). Exact per-write kernel attribution, new session supervisors and runtime package installation are excluded.
- [D] Per-entry Undo, command names and replaced-edit flags (§9.3.5–9.3.7).

## Changes

Reshape existing code first: `packages/backend/jobs/store.go:172` owns the existing transactional event append; T-STK-01 supplies its item-stream integration. Reuse `packages/backend/internal/sse/broker.go` and `durable.go` through T-COL-02. Reuse `packages/backend/internal/services/workspace_facets.go:244` for the guarded restore write. No parallel event or file-write service. Checks: C-COL-05, C-DUR-04.

- The existing S2 burst writer emits edit lifecycle evidence with source_key equal to burst id and stored actor attribution. T-REL-03 only reads it; this adds no person-minute inference or effort ingestion. Check: C-REL-04.

- Encode and decode only through `packages/backend/internal/machined/wire` (T-COL-03r); no local frame types, so the golden frames in `packages/backend/internal/compose/cocontracts_test.go` keep guarding this codec (smithers-3f, 2026-10-02).
- The host's run launch starts the coding host with `open_session(agent, exec)` and then calls `register_run(run_id, session)` (§9.1.2); the coding host never calls it.
- Extend T-COL-03's `packages/backend/internal/machined/` ingest hooks in `events.go`: object verification, burst append and acknowledgement after commit, with the existing publisher. This dependency-owned package is planned, not landed code; no second ingest framework.
- Add the small Restore handler to the existing workspace service; `file_restore.go` is only a split of that service. Bind `file.restore` (`agent: run`, in-card) through T-CAT-01. Rejected: a new write transport or restore service; the existing guarded file-write path does both.
- New `packages/backend/db/product/migrations/<next>_burst_files.sql`, queries and sqlc output: `burst_files` (§3). Existing job-event data cannot provide indexed per-file versions, so this table is required. Reuse T-COL-03's receipts. Add `planned:T-COL-04` with owner smithers-3f in `db/ownership.csv`; assign the migration number at landing. Store burst metadata in the existing event payload. Checks: C-PRC-01, C-PRC-02, C-COL-05.
- `packages/backend/docs/machined.md`: watcher, attribution, ignore and burst rules; `docs:sync`, `docs:check`, `smthrs docs //packages/backend:docs`.
- No watcher implementation duplication; consume T-COL-04a modules and T-COL-03r event schemas. Extend T-COL-03's planned `packages/backend/docs/machined.md`; no second daemon document.

## Tests

- C-COL-05 uses `TestBurstIngestProductionBoundary`, `TestFileRestoreCommandBoundary` and `TestChangeIntegrationLandsDark` (new). Drive the real authenticated daemon event dispatcher into real PostgreSQL and the host object store; invoke Restore through the catalog's production HTTP binding with a signed-in member, never by calling the restore service directly. Subscribe through `/api/live`; read diffs through the production file/diff routes while the machine sleeps. Fixed fixture bytes, paths, actor envelopes and independently computed hashes are the oracle; no expected value is read from spec files, production codecs or production helpers at runtime.
- `TestChangeIntegrationLandsDark` removes each named integration above in turn: ingest creates no row or receipt and sends no success ack; unavailable or unauthorized Restore writes nothing; hints cannot manufacture durable entries. `TestBurstIngestProductionBoundary` covers missing objects, transaction rollback, replay, ignored paths and cross-branch events as well as the matrix below. `TestFileRestoreCommandBoundary` covers deleted-file base `"absent"`, stale content, actor spoofing and a removed member. Checks: C-COL-01, C-COL-05, C-DUR-04.

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


- integration, real PostgreSQL and host store (`packages/backend/internal/machined/events_integration_test.go`): one burst event commits one `product_job_events` change entry, N `burst_files` rows and both post-commit deltas; a redelivered `burst_id` adds nothing; the diff is served with the machine asleep.
- integration (`TestFileRestoreCommandBoundary`, through the production catalog HTTP binding): the file's bytes equal its `before` version and the new entry names the presser; a file changed since gets `conflict` and is untouched.
- perf: C-PERF-04. e2e: C-J3-03.
- contract: the §7.6.2 assertion (every `file_written` and burst `files[]` entry carries `post_digest`) in `packages/backend/internal/compose/cocontracts_test.go` (planned by T-COL-03r).
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

- Decisions: smithers-3f accepts the host-ingest, receipt, broker and object-store seams and any confinement change; smithers-b8 approves the `file.restore` public command binding and conflict response. smithers-8a resolves any proposed departure from the normative actor, burst or restore rules. The recorded smithers-3f codec ruling stands with ownership moved to T-COL-03r. No new ADR is required.
- Security activation preconditions (smithers-3f reviews): repository commands, fixture writers, formatters, editors and version-control commands execute only inside machines as member or agent users; never on the host or as root. Host-store blobs are data, never loaded as repository code. Working-copy reads and writes use the unprivileged daemon's §9.5.2 path confinement. Checks: C-COL-04, C-MCH-06.
- Root-input inventory for the reused broker exercised here: its binary, init configuration, allowed operation set, fixed cgroup root, `/workspace` descriptor and uid/group limits come from the trusted main-built image, not the branch. Boot secret, uid/login mapping, run/session bindings and session environment come from authenticated host state under main's policy. Session kind, argv, size and cgroup operation requests arrive over the daemon's inherited socketpair; argv, environment values and working-copy content can contain branch-sourced data. Validate kind, bounds, session ownership, uid/login and fixed path confinement before effects; drop uid/gids before cwd lookup or exec. No branch path, executable, hook or configuration is consumed as root. `TestWatcherSessionRootInputs` (new, C-COL-04 rerun through the production host session dispatcher) submits uid 0, forged login/session, cgroup traversal, branch executable/argv and hostile environment, and proves refusal or execution only after privilege drop, with a root-owned sentinel unchanged. Branch-sourced root inputs block activation unless this test passes. smithers-3f reviews the inventory against the final broker call sites.
- Overflow test's root sysctl step consumes only the main-authored literal `/proc/sys/fs/inotify/max_queued_events`, value 64, and its saved prior kernel value from the trusted guest; restore it after the test. No branch input reaches this step. `TestWatcherOverflowSysctlInputs` (new, C-COL-05) proves the helper rejects alternate paths or branch-supplied values. Production watch-limit tuning belongs to the trusted image, not repository scripts.

- Reading of "active" in §9.3.1: a session is active during a burst when its cgroup is populated and its CPU time (`cpu.stat` `usage_usec`) grew in the burst window, so a shell idle at its prompt doesn't count. Resolved: spec §9.3.1 adopts this definition.
- A long-running SSH editor server (VS Code's) keeps its session active, so a teammate's concurrent terminal command turns the burst outside. Confirmed by C-J3-06 with a second session busy. This is spec behavior, not a bug.
- inotify needs one watch per directory. Confirmed broken if adding a watch on the smithers repository fails with `ENOSPC`. Raise `fs.inotify.max_user_watches` in the guest image.

## Ready checklist

1. Dependencies: only called code/schema contracts are in Depends on; Scope names dark landing and fail-closed behavior for every unavailable integration and the T-MCH-11 activation precondition. C-COL-01 and C-COL-05 prove refusal.
2. Exclusions: Scope excludes parallel writers/codecs/brokers, watcher implementation, recovery controls, transcript import, presence, co-editing, cards, kernel attribution, runtime packages and deferred Undo/command/replaced-edit features.
3. Boundary tests: named production event-dispatcher, catalog HTTP Restore and `/api/live` tests use fixed independent fixtures; C-J3-03, C-J3-06, C-PERF-04 and the complete S2 C-DUR-04 matrix qualify the real integrations.
4. Decisions: smithers-3f accepts Go/infra and security seams, smithers-b8 signs off the public Restore binding, and smithers-8a decides departures from normative behavior; the recorded codec answer stands.
5. Owner pre-review: smithers-3f: Does the existing writer commit burst files and receipts atomically before ack/publish? Does Restore reuse the guarded write with authenticated attribution? Does the root-input inventory match every broker and sysctl call? smithers-b8: Does the production catalog binding enforce current membership and preserve the stale/conflict response consumed by Compare? Are unavailable Restore and deleted-file responses compatible with the app contract? No View or TypeScript-library implementation is in scope. Reviews follow the 2026-10-03 directive's post hoc process; recorded owner answers stand.
6. Security: Scope stays dark without machine isolation; unprivileged daemon confinement, the complete root-input inventory and named root-input tests gate activation, reviewed by smithers-3f. Repository code never executes on the host or as root.
