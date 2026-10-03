# T-COL-04a Rust watcher, attribution, versions and overflow resync

Stage S2 · Size M · Depends on T-COL-10, T-COL-03r · Unblocks T-COL-04, T-REL-02 · Issue: [#3627](https://github.com/smithersai/smithers/issues/3627)
Spec: spec.md §2 (Activity entry, actor notation), §3 (`activity`, `burst_files`), §7.2 (`:activity`, `:files`), §7.6 (row 6), §8.4.4, §8.10.3, §8.11.1, §9.1.2 (`register_run`), §9.1.4, §9.3.1–9.3.5, §9.3.8, §9.4.1, §18 · Delta: delta.md §4 (`smithers-machined` S2; `burst_files`, `file_written` and versions commits row) · Product: mvp.md J3.2, J3.4, §6.8 External changes and Live updates, M-24, M-27

## Goal

Build and test the watcher with real inotify and cgroups in a Linux fixture, without the backend or production session supervisor.

## Scope

In:
- inotify on the working copy (§9.3.1): recursive watches, re-armed on directory creation, with a scan of each new directory so files created before the watch is armed are not missed.
- Attribution (§9.3.1):
  - **Writes through Smithers** (the coding agent's write tool, app commands such as `file.restore`, and File card documents from S3) arrive as `write_file(path, base_digest, content, actor)` (§7.6 row 1). The daemon performs the write itself under the mutation lock (§9.4.1), so it records that exact actor, even while other sessions are active, and knows its own inotify events by path and post-write digest.
  - **Other writes** (terminal tools, SSH editors, the agent's `bash`, hand-run `git`/`jj`) form one burst, attributed at close to the actor of the only session active on the branch during the burst. Sessions are the daemon's PTYs and processes from `open_session`: people's terminals and SSH sessions, and the run's sessions, which the host's `register_run(run_id, session)` maps to `{agent: coding, run}`. Processes left running after a session closes still count as that session (§9.6.3). All outside writes share one burst key, so at most one outside burst is open (§9.3.4). With more than one active session, or none, the burst is `{outside: true}` and reads "changed outside Smithers".
  - [D] Exact per-write kernel attribution (fanotify with writer pids).
- `IN_Q_OVERFLOW` (§9.3.2): the resync under the mutation lock: re-add every watch with a scan, record every path whose content differs from its recorded version as one burst "changed outside Smithers", reconcile open documents (S3; S2 sends `file_written` for open cards), run the moved-off check, then run queued writes.
- Ignore rules (§9.3.3): everything jj ignores, `.jj/`, `.git/` internals except `HEAD` and refs, and the toolchain paths T-MCH-10 names. Ignored directories get no watch, so their events never reach the daemon; the rest are filtered in user space. Metadata watches are separate (§9.3.3): `.jj/repo/op_heads/heads/`, `.git/` (not recursive) and `.git/refs/` (recursive). Their events go to the moved-off detector (T-COL-05) 200 ms after they stop, never into `files[]`.
- `file_written{path, actor, post_digest}` within 200 ms of each write to a tracked path (§9.3.4, §7.6 row 6). The host turns it into a `branch:<id>:files` delta, so open File and Diff cards reload in under 1 s (§18, T-APP-11).
- Bursts (§9.3.4): writes through Smithers keyed by their exact actor, all outside writes by one key; closed after 1.5 s quiet, 10 s after opening, or before a write with another key touches a file this burst touched. Before each write through Smithers the daemon drains pending inotify events. Each path has a recorded version (a git blob written with the write, or at the outside burst's close); per file a burst keeps `before` (recorded version at first touch) and `after` (last recorded). On close, one parentless versions commit (`a/<path>` = before, `b/<path>` = after) and one burst event `{burst_id, actor, files[{path, change, renamed_to?, before_blob, after_blob, post_digest}], versions_commit}` through the outbox (§9.1.4), which pushes the commit to `refs/smithers/branches/<id>/bursts/<burst>`, so a sleeping branch's activity and diffs never need the machine (§8.4.4). No jj snapshot per burst.
- Presence feed: the last file of a burst attributed to a session becomes that session's `where` (§7.3.1, §8.10.4). An outside burst updates no session.

Out:
- Host ingest, restore service, live deltas and real session wiring (T-COL-04).

## Changes

- `crates/smithers-machined/src/`: `watch.rs` (inotify, re-arm and scan), `ignore.rs`, `attrib.rs` (write_file matching, session activity), `session.rs` (registry fed by `open_session` and `register_run`), `burst.rs`, `versions.rs` (recorded versions, versions commits), `events.rs` (`file_written`, burst events through the outbox), `resync.rs` (overflow).

- Supply fixture sessions with real populated cgroups and CPU counters; expose the session and register_run hooks for T-TRM-07. Use the Rust fake host from T-COL-03r.

## Tests

- unit (`burst.rs`): every close rule, plus a property test over random event streams: each event lands in exactly one burst, no burst exceeds 10 s, and a cross-key touch closes the earlier burst first.
- unit (`attrib.rs`, fixture cgroup trees): one active session gives its actor, two or none give `{outside: true}`, a registered run's terminal gives `{agent: coding, run}`, and a matched `write_file` keeps its exact actor with three sessions active.
- unit (`ignore.rs`): matches `git check-ignore` on a fixture of 200 paths with nested `.gitignore` files.
- integration, real inotify (`crates/smithers-machined/tests/watch.rs`, Linux runner or microVM): Maya alone runs a 12-file formatter → one burst by Maya; the same with Ben's terminal busy → one outside burst; each write emits `file_written` within 200 ms with the right `post_digest`; `node_modules/` and `target/` writes give no events; `mkdir d && touch d/x` is captured; `mv a b` gives `renamed` and an editor's temp-and-rename save gives `modified`; the daemon's own writes give no outside event; a forced `IN_Q_OVERFLOW` runs the resync (C-COL-05).
- integration, real inotify and cgroups (`crates/smithers-machined/tests/versions.rs`, new): C-COL-05's overlap, actor-switch and drain-before-write cases; every entry's `before` and `after` equal the bytes each actor wrote.

- Contract: the Rust fake host replays T-COL-10 golden event and ack frames; actual watcher events decode against those schemas, with post_digest on each file.
- Fault: C-DUR-04 K1–K3b component cases with durable versions refs and the Rust fake host.

## Acceptance

- [C-COL-01](../checks/C-COL-01.md): real S2 assertions for this component re-run the T-COL-10 golden-frame gate.
- C-COL-05: Linux overlap, actor-switch, drain, metadata and overflow cases.
- C-DUR-04: watcher-side K1–K3b evidence; full checks remain gated by T-COL-04.

## Risks and notes

- T-COL-03r supplies the completed skeleton and hook traits. No dependency on T-MCH-04, T-TRM-07 or T-MCH-11.
- Raise inotify watch limits in the fixture when required. Bursts build versions commits; capture alone takes a jj snapshot (§9.3.4, §9.1.3).

