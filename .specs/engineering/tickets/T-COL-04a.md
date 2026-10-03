# T-COL-04a Rust watcher, attribution, versions and overflow resync

Stage S2 · Size M · Depends on T-COL-03r · Unblocks T-COL-04, T-REL-02 · Issue: [#3627](https://github.com/smithersai/smithers/issues/3627)
Spec: spec.md §2 (Activity entry, actor notation), §3 (`activity`, `burst_files`), §7.2 (`:activity`, `:files`), §7.6.2, §8.4.4, §8.10.3, §8.11.1, §9.1.2 (`register_run`), §9.1.4, §9.3.1–9.3.5, §9.3.8, §9.4.1, §18 · Delta: delta.md §4 (`smithers-machined` S2; `burst_files`, `file_written` and versions commits row) · Product: mvp.md J3.2, J3.4, §6.8 External changes and Live updates, M-24, M-27

## Goal

Build and test the watcher through the daemon RPC dispatcher and production watcher loop with real inotify and cgroups inside a Linux branch machine, using fixture host and session providers.

## Scope

In:
- Lands dark until T-COL-03r: without its codec and hook contract, the watcher cannot register with the dispatcher; unsupported requests are refused without writes or events. Build against its specified contract while it is unlanded.
- Lands dark until T-COL-03a and T-COL-04: production watcher activation requires the shared mutation lock, durable outbox and versions-ref provider, authenticated host connection and ingest. Missing providers refuse activation; hints never stand in for durable burst delivery. Fixture providers exercise the same hooks. T-COL-03a owns those providers; this ticket must not duplicate them.
- Lands dark until T-TRM-07 and T-MCH-11: production attribution requires the authenticated session registry, real session cgroups and unprivileged daemon identity. Missing providers refuse activation; unknown or ambiguous activity never claims a person or run. This ticket exposes hooks, not session spawning or user provisioning.
- Lands dark until T-COL-05 supplies the moved-off hook: metadata events and overflow cannot resume queued Smithers writes without a successful moved-off check. An unavailable or failed check leaves writes refused. S3 document reconciliation remains disabled until T-COL-08a integrates it.
- inotify on the working copy (§9.3.1): recursive watches, re-armed on directory creation, with a scan of each new directory so files created before the watch is armed are not missed.
- Attribution (§9.3.1):
  - **Writes through Smithers** (the coding agent's write tool, app commands such as `file.restore`, and File card documents from S3) arrive as `write_file(path, base_digest, content, actor)` (§7.6 row 1). The daemon performs the write itself under the mutation lock (§9.4.1), so it records that exact actor, even while other sessions are active, and knows its own inotify events by path and post-write digest.
  - **Other writes** (terminal tools, SSH editors, the agent's `bash`, hand-run `git`/`jj`) form one burst, attributed at close to the actor of the only session active on the branch during the burst. Sessions are the daemon's PTYs and processes from `open_session`: people's terminals and SSH sessions, and the run's sessions, which the host's `register_run(run_id, session)` maps to `{agent: coding, run}`. Processes left running after a session closes still count as that session (§9.6.3). All outside writes share one burst key, so at most one outside burst is open (§9.3.4). With more than one active session, or none, the burst is `{outside: true}` and reads "changed outside Smithers".
  - [D] Exact per-write kernel attribution (fanotify with writer pids).
- `IN_Q_OVERFLOW` (§9.3.2): the resync under the mutation lock: re-add every watch with a scan, take a jj snapshot through the shared capture hook, record every path whose content differs from its recorded version as one burst "changed outside Smithers", reconcile open documents (S3; S2 sends `file_written` for open cards), run the moved-off check, then run queued writes.
- Ignore rules (§9.3.3): everything jj ignores, `.jj/`, `.git/` internals except `HEAD` and refs, and the toolchain paths T-MCH-10 names. Ignored directories get no watch, so their events never reach the daemon; the rest are filtered in user space. Metadata watches are separate (§9.3.3): `.jj/repo/op_heads/heads/`, `.git/` (not recursive) and `.git/refs/` (recursive). Their events go to the moved-off detector (T-COL-05) 200 ms after they stop, never into `files[]`.
- `file_written{path, actor, post_digest}` within 200 ms of each write to a tracked path (§9.3.4, §7.6 row 6). The host turns it into a `branch:<id>:files` delta, so open File and Diff cards reload in under 1 s (§18, T-APP-11).
- Bursts (§9.3.4): writes through Smithers keyed by their exact actor, all outside writes by one key; closed after 1.5 s quiet, 10 s after opening, or before a write with another key touches a file this burst touched. Before each write through Smithers the daemon drains pending inotify events. Each path has a recorded version (a git blob written with the write, or at the outside burst's close); per file a burst keeps `before` (recorded version at first touch) and `after` (last recorded). On close, one parentless versions commit (`a/<path>` = before, `b/<path>` = after) and one burst event `{burst_id, actor, files[{path, change, renamed_to?, before_blob, after_blob, post_digest}], versions_commit}` through the outbox (§9.1.4), which pushes the commit to `refs/smithers/branches/<id>/bursts/<burst>`, so a sleeping branch's activity and diffs never need the machine (§8.4.4). No jj snapshot per burst.
- Presence feed: the last file of a burst attributed to a session becomes that session's `where` (§7.3.1, §8.10.4). An outside burst updates no session.

Out:
- Host ingest, restore service and live deltas (T-COL-04); production session supervision (T-TRM-07); member provisioning (T-MCH-11); daemon planting and head-reporter cutover (T-COL-03).
- Root broker, mutation-lock implementation, capture and durable outbox (T-COL-03a); moved-off decisions and Return/Keep commands (T-COL-05); presence roster (T-COL-06); document reconciliation and co-editing (T-COL-08a).
- Fanotify and exact kernel writer attribution, command names on entries, per-entry Undo and replaced-edit flags (§9.3.1, §9.3.6–9.3.7). No new host schema, protocol, transport or presence implementation.

## Changes

- Reuse T-COL-03r's crate, codec, dispatcher, hook traits and fake host. Implement watcher hooks in the daemon work owned by T-COL-03a/-03, as delta.md §4 requires; do not create a second daemon or standalone wire stack. The paths below are planned additions, not landed files.
- New watcher modules are justified by delta.md §4: `packages/backend/internal/services/workspace_head.go:55–171` polls heads without per-file versions or acknowledgments; `packages/backend/microsandbox/guest/smithers-guest.py:1–24` is a one-shot helper. Neither provides a durable watched-file outbox. Head-reporter deletion stays with T-COL-03's cutover.
- `crates/smithers-machined/src/`: `watch.rs` (inotify, re-arm and scan), `ignore.rs`, `attrib.rs` (write_file matching, session activity), `session.rs` (registry fed by `open_session` and `register_run`), `burst.rs`, `versions.rs` (recorded versions, versions commits), `events.rs` (`file_written`, burst events through the outbox), `resync.rs` (overflow).

- Supply fixture sessions with real populated cgroups and CPU counters; expose the session and register_run hooks for T-TRM-07. Use the Rust fake host from T-COL-03r. Toolchain ignore paths enter through a hook with literal fixture values from §9.3.3; this component does not call T-MCH-10 code.

## Tests

- Boundary: `tests/watch.rs` and `tests/versions.rs` start the production watcher loop and send encoded `write_file` and `register_run` requests through T-COL-03r's production RPC dispatcher. External writers change real files in populated session cgroups. Only the unavailable host, session registry and shared core providers use the specified fixture hooks; no direct burst/attribution call substitutes for these integration cases. Compare literal actor envelopes, file bytes, digests and golden frames committed with the tests; expected values never come from spec files or production encoders at runtime.
- Activation refusal (`tests/watch.rs`): remove each codec, lock, durable event/ref, authenticated host, session/identity and moved-off provider in turn; verify refused activation or blocked queued writes, no fabricated attributed event and no acknowledged undurable burst (C-COL-01, C-COL-05).
- Confinement (`tests/watch.rs`): at the RPC boundary, traversal, swapped symlinks and non-regular paths are refused without access outside `/workspace`; an unregistered run cannot choose an actor. Assert the watcher and writers are non-root (C-COL-01, C-COL-05).

- unit (`burst.rs`): every close rule, plus a property test over random event streams: each event lands in exactly one burst, no burst exceeds 10 s, and a cross-key touch closes the earlier burst first.
- unit (`attrib.rs`, fixture cgroup trees): one active session gives its actor, two or none give `{outside: true}`, a registered run's terminal gives `{agent: coding, run}`, and a matched `write_file` keeps its exact actor with three sessions active.
- unit (`ignore.rs`): matches `git check-ignore` on a fixture of 200 paths with nested `.gitignore` files.
- integration, real inotify (`crates/smithers-machined/tests/watch.rs`, Linux branch microVM with pre-provisioned session cgroups): Maya alone runs a 12-file formatter → one burst by Maya; the same with Ben's terminal busy → one outside burst; each write emits `file_written` within 200 ms with the right `post_digest`; `node_modules/` and `target/` writes give no events; `mkdir d && touch d/x` is captured; `mv a b` gives `renamed` and an editor's temp-and-rename save gives `modified`; the daemon's own writes give no outside event; a forced `IN_Q_OVERFLOW` runs the resync (C-COL-05).
- integration, real inotify and cgroups (`crates/smithers-machined/tests/versions.rs`, new): overlapping bursts on separate files, two actors writing one file in turn, and an outside close queued before an RPC write; every entry's `before` and `after` equal literal fixture bytes. Metadata-only changes emit no file activity and call the moved-off hook after 200 ms quiet. Overflow snapshots and scans new directories, emits one outside burst, and runs moved-off before queued writes (C-COL-05).

- Contract: the Rust fake host replays T-COL-03r golden event and ack frames; actual watcher events decode against those schemas, with post_digest on each file.
- Fault: C-DUR-04 K1–K3b component cases with durable versions refs and the Rust fake host.

## Acceptance

- [C-COL-01](../checks/C-COL-01.md): real S2 assertions for this component re-run the T-COL-03r golden-frame gate.
- C-COL-05: Linux overlap, actor-switch, drain, metadata and overflow cases.
- C-DUR-04: watcher-side K1–K3b evidence; full checks remain gated by T-COL-04.

## Risks and notes

- Decisions: smithers-3f approves the daemon/core/session seams, security preconditions, Linux fixture privileges and any watch-limit change. smithers-8a accepts ADR 0004 or scope/contract deviations; this ticket does not silently redefine them. Owner review is post hoc under the 2026-10-03 directive; the questions below remain the review record.
- Security preconditions (M-29, §1.3, §9.5): repository code, test builds and fixture writers execute only inside branch machines. Watcher, scans, git/jj object operations and RPC parsing run as `machined` (19998, `team`), never root; writers run as non-root fixture session users. Require the shared confined-path and authenticated-actor hooks before activation. smithers-3f reviews this boundary.
- Root-input inventory: this component adds no root step. Tests consume pre-provisioned cgroups and users; they do not run branch scripts, build tools, fixture setup or writers as root. Root provisioning belongs to T-COL-03a/T-MCH-11 and must retain those tickets' main-sourced input inventories and validation gates. If the fixture requires new root setup, smithers-3f must enumerate every consumed input and its main/branch source before enabling it; any branch input blocks it without a named validation test. Confinement tests above verify this ticket's processes stay non-root.

- T-COL-03r supplies the completed skeleton and hook traits. No dependency on T-MCH-04, T-TRM-07 or T-MCH-11.
- Use fixture watch limits approved by smithers-3f; branch tests do not change root-owned limits. Bursts build versions commits without a snapshot; capture and overflow resync take a jj snapshot (§9.3.2, §9.3.4, §9.1.3).

## Ready checklist

1. Dependencies: T-COL-03r supplies the called codec and hook contract; Scope names fail-closed dark landing for every unavailable integration provider. Core, session and host implementations remain hook providers, not new code dependencies. The S2 index row stays unchanged.
2. Exclusions: Out names broker/core durability, session provisioning, host/UI integration, moved-off commands, presence, S3 documents and all deferred attribution/undo features; Changes follows delta.md §4's single-daemon plan.
3. Tests: production RPC dispatcher plus real watcher/inotify/cgroups in a branch machine; literal fixtures prove actor, versions, metadata, overflow, refusal and confinement. C-COL-01 and C-COL-05 are folded check stubs; the named tests carry component evidence, and T-COL-04 carries integrated evidence. C-DUR-04 component cases use fixture core providers and do not claim the full durability pass.
4. Decisions: smithers-3f approves component seams, security and fixture privileges; smithers-8a accepts ADR or scope/contract deviations.
5. Owner pre-review record (post hoc per directive): smithers-3f must answer: Do the hooks reuse the single lock/outbox/capture and authenticated session registry without duplication? Do dark activation and moved-off refusal prevent writes without required providers? Do dispatcher tests prove confinement and non-root execution with no branch input consumed by root? No UI view, apps/ or TypeScript library code changes are in scope.
6. Security: M-29 confines repository execution to machines; the watcher and writers stay non-root, use confined paths and trusted actor/session hooks, and add no root step. smithers-3f reviews the boundary and root-input inventory; confinement tests prove the component's privilege assumptions.

