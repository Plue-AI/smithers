# Working together on one branch: merged design

Merged from codex-sol.md, codex-astra.md, fable.md and opus.md on 2026-10-06. Every code fact below was re-checked in `~/smithers-frontrun` at `origin/frontrun` `f98e01d638b2` (`jj log`, file reads, `rg`); paths are relative to the repository root. `B/` means `packages/backend/internal/`, `M/` means `crates/smithers-machined/src/`, `A/` means `apps/app/src/mainview/`.

## Decisions for Will

- **Keystrokes between people go through the host process on the Mac, never through the branch's virtual machine.** The machine still owns the file on disk and is the only thing allowed to say "saved". The one measurement we have shows the machine path misses the 1 s budget under load, and the wiki needs a host-side copy anyway, so this is one implementation for both.
- **Code and wiki share the same editor stack (Yjs, already in the product).** One protocol, one client, one document host. Nothing new to learn or maintain.
- **Other people's cursors show live in their colour.** Your 10-06 ruling overrides the earlier "cut". It is a one-flag change in the editor binding we already have.
- **Terminal and SSH changes are credited to the one person active on the branch, with one fix: a person's editor and shell count as one person.** Exact kernel-level attribution stays out of launch; we run the one-day kernel probe now so we know whether the fallback costs a day or a week if dogfood shows mis-crediting.
- **A write through Smithers never rolls back.** Compare, swap, keep whatever was displaced, flag it. We do not freeze everyone's terminal on every agent write; freezing happens only around a rebase.
- **Terminals end when the host restarts (they survive a 30 s connection blip).** Rebuilding shells across upgrades is not in launch; we count how often it hurts in dogfood.
- **The member roster is the only access authority.** Joining a branch creates the existing per-branch grant row; removing someone deletes it in the same transaction. No new access model.
- **Each branch has one shared conversation that runs on the host under the author's own permissions.** The browser's private chat path and its table are deleted.

## Where the panel disagreed

| Topic | Positions | Decision |
| --- | --- | --- |
| Where live documents live | Sol, Astra, Fable: host mirror for fan-out, daemon keeps a Yrs replica and owns the disk. Opus: host only; daemon stores an opaque record and does no CRDT. | Mirror plus daemon replica. The daemon engine is landed (`M/doc/host.rs`, 696 lines; `M/doc/disk/linux.rs`; `tests/documents.rs`, 786 lines) and spec §7.4.2/§9.2 freeze it; Opus's variant discards that and ships outside-write bytes over the link to merge on the host. |
| CRDT library | All four: Yjs 13.6.32 / Yrs 0.27.4 / `y-codemirror.next` 0.3.6. | Same. Pins verified in `apps/app/package.json:65-69` and `crates/smithers-machined/Cargo.toml:12`. |
| Attribution of terminal and SSH writes | Sol, Astra: kernel observation (fanotify/eBPF) is launch-critical. Fable: session CPU heuristic, measure, then decide. Opus: heuristic with people (not sessions) as candidates and the coding host excluded, plus a measured gate. | Opus's variant, plus the T-MCH-03 probe runs now. Spec §9.3.1 and mvp §6.8 define the launch rule; `tickets/deferred/T-MCH-03.md` says the stock guest kernel likely lacks `CONFIG_FANOTIFY` and predates 5.15 (fallback: rebuild libkrunfw, about a week). |
| Write rollback | Sol, Astra: journaled transaction that freezes every outside writer per write. Fable: spec §9.4.1 exchange plus displaced check. Opus: compare, swap, never swap back. | Never roll back. ADR 0003 records that exchange-and-rollback loses an outside save and that freezing cannot exclude IPC-launched services or in-flight kernel I/O; `M/doc/disk/linux.rs:195-283` already swaps and keeps displaced bytes under a token. |
| Thaw after a rebase failure | `machined.md` §3 and Fable: thaw always. Sol, Astra: never thaw with a half-applied rewrite. | Thaw only after the rewrite settled or `jj op restore` put the tree back. |
| Terminals across a host restart | Opus: re-attach from `status().sessions`. Others: end, per spec §9.6.4. | End at launch; keep the 30 s link re-attach that already exists (`B/machined/sessions.go:171`). Measure restarts with open shells in dogfood. |
| Branch access | Opus: derive from the roster, drop per-branch `workspace_shares`. Others: keep `workspace_shares`. | Keep grants, roster-driven. E-03 is marked Hard; `B/services/workspace_branch_machine.go:214,340` already creates a share at join and deletes it in the removal transaction. |
| Presence roster | Fable: new Go lease table in `B/live/presence.go`, delete the TS roster. Others: keep `BranchPresence.ts` through the bridge. | Keep the TS roster through `B/compose/presence.go`. Spec §7.3.1 names it; `GatewayServer.ts`, `BranchServer.ts`, `A/cards/BranchCard.tsx` and the public API baseline consume it. |
| Remote carets | Sol, Astra: in (brief). Fable, Opus: line flags only (spec §7.4.5, T-UI-19). | In. The brief is the owner's later ruling; `A/cards/liveDoc.ts:55` passes `null` awareness to `yCollab` to exclude them today, so this is a flag plus two awareness fields. |
| Save receipts | Sol, Astra: explicit per-stream sequence receipts. Fable, Opus: `saved{sv}`. | `saved{sv, through_seq}`. A Yjs state vector counts inserts only; a delete-only transaction never advances the client's clock, so `A/runtime/LiveDocProvider.ts:70` would mark it saved before it is on disk. |
| Revocation while the link is down | Sol, Astra: guest-side authorization lease renewed every second. Fable, Opus: host kill plus 1 s recovery poll. | No clock lease. The host sends `set_roster` on every handshake and the broker kills sessions of unlisted uids before `ready`; egress runs through the host relay (§8.9), so a partitioned machine cannot exfiltrate meanwhile. |
| First tracer bullet | Opus: wiki co-editing first (needs no daemon). Fable: terminal write attributed into a File card first. | Both, in parallel lanes: the wiki proves the document host and protocol; the terminal tracer proves the daemon path. |

---

## 1. Summary

Every awake branch has one microVM, one working copy, one roster-derived membership and one shared conversation; PostgreSQL owns membership, activity and turns, the machine disk owns file bytes and the code document's durable state. `smithers-machined` (Rust, root broker plus unprivileged daemon) is the only process that writes the working copy on Smithers' behalf, the only observer of outside writes, and the supervisor of every member and agent process, so every byte on disk has an actor and a recoverable before-state. Live documents are Yjs: browsers sync with one host document host (Go over the shared `smithers-ffi` Yrs core) on `/api/live`; for code the daemon is that host's one trusted peer and the disk authority, saving 200 ms after the last update, merging outside saves three-way, and alone sending `saved`; for wiki pages the same host persists to PostgreSQL. People reach the machine as their own unix user through broker sessions in per-session cgroups, which give terminals, SSH, watch-only sharing, session attribution, a 1 s freeze for rebases and `cgroup.kill` revocation within 5 s. Conversation turns are `chat_turns` rows per branch, one running at a time, each run on the host under a credential minted for its author.

## 2. Abstractions

| Object | Identity | Only writer | Source of truth and where it lives | Rebuilt from |
| --- | --- | --- | --- | --- |
| Branch | `workspaces` row keyed `(repository_id, kind, target_bookmark, name)` without `user_id` (`0108_branch_machines.sql`); owner is the `smithers-machines` service user | stack service for history (`B/services/mythical*.go`); machine service for lifecycle | PostgreSQL; captured heads at `refs/smithers/branches/<id>/head` in the host repository store | backups |
| Member access | `collaborators` row (`0116_members_roster.sql`: `unix_uid` from 20000; `0121`: `unix_login`) | maintainers through the roster transaction | PostgreSQL. A `workspace_shares` row is a projection: created at join (`ensureWorkspaceShare`), deleted at removal (`RevokeBranchMachineShare`) | the roster |
| Machine | branch plus boot id | admission scheduler (`B/microsandbox/runtime.go`), `B/machined.Registry` | host memory reconciled from `msb` at start; VM disk on the host volume; per-boot secret in `/run/smithers/machined/boot` | runtime VM list; a new boot mints new credentials |
| Session | u32 from the broker | broker (`M/broker/sessions.rs`) | cgroup `/sys/fs/cgroup/smithers/sessions/s<id>` plus broker registry (daemon memory); host view in `TerminalSessionManager` (host memory) | none: a daemon restart kills them (§9.6.4) |
| File (awake) | path plus SHA-256 | daemon under the branch lock; anyone outside | bytes on the machine disk | last capture in the host store |
| File (asleep) | path at the captured head | host | the head ref | the ref |
| Document | `doc:code:<branch>:<path>`, `doc:wiki:<page>` | daemon (code durability), host document host (wiki durability and all fan-out) | code: state record `/var/lib/smithers/docs/<path digest>` plus the file; wiki: `wiki_pages.crdt_state` and revisions. The host mirror and browser `Y.Doc`s are caches | the state record (same epoch); only a missing record reseeds with a new epoch |
| Change | `event_id` (burst, write, doc period, rebase) | daemon emits; host commits | `product_job_events` row, `burst_files` rows, receipt in `machine_event_receipts`, versions commit at `refs/smithers/branches/<id>/bursts/<burst>` | daemon outbox replay until acked |
| Presence | `(branch, participant, session)` | the `BranchPresence.ts` lease roster through the bridge | memory, 30 s lease | heartbeats; unknown for 30 s after a host start |
| Conversation | branch id as `chat_turns.conversation_id` (`0120`) | chat runtime (`B/chat`) | `chat_turns`, `chat_turn_batches`; per-member `collaborators.view_state` | backups |
| Actor | participant id | host authorizer | derived from the authenticated principal; never from a frame or body (ADR 0004 "Identity never comes from the machine") | n/a |

One participant shape everywhere: `{id, kind: person|smithers|coding|claude-code|codex|reviewer|outside, member_id?, for_member?, run_id?, session_id?, via: app|ssh|terminal|tool}`. Participant identity conveys attribution, never permission. The daemon never names a branch, machine or uid in anything it sends; browsers address documents by topic and never learn where authority lives.

## 3. Co-editing model

**Decision: Yjs, one core, one host document host, the daemon as the code peer and disk authority.**

```
 browser A ─ws /api/live─┐                                       microVM
 browser B ─ws /api/live─┤  host document host (Go + Yrs handle) ┌───────────────────────────────┐
 browser C ─ws /api/live─┘  one Y.Doc per open topic             │ smithers-machined             │
        ▲  fan-out, no VM hop     │ ▲                             │ M/doc/host.rs: Y.Doc peer     │
        │                         │ │ ADR 0004 kind 0x04,         │ state record + file           │
        └─ saved{sv,seq} ◀────────┘ │ one stream per open doc     │ 3-way merge of outside saves  │
                                    ▼ updates coalesced 50 ms     │ 200 ms debounce → fsync       │
                                  relay | bridge byte stream ────▶│ sends saved{ms, through, sv}  │
                                                                  └───────────────────────────────┘
 wiki: the same host object persists to PostgreSQL 2 s idle / 10 s max and sends saved after commit
```

**Library.** `yjs` 13.6.32 and `y-codemirror.next` 0.3.6 in browsers; Yrs 0.27.4 everywhere else through `crates/smithers-ffi/src/document_core.rs`, which the daemon already includes by path (`M/doc/mod.rs:4`). `Y.Text("content")` for code, `Y.Text("markdown")` for wiki, host-owned `Y.Map("authors")` (client id to actor). UTF-16 offsets. Per-character colour from item client ids (`A/cards/liveAttribution.ts`).

**Where documents live.** The host document host (`B/live/codedoc.go`, new, beside the landed `B/live/docrelay.go`) holds one Yrs document per open topic behind a handle API in `smithers-ffi` (interface I5). It is the peer every browser syncs with. For code it opens one ADR 0004 document stream per open path (`open_doc{path, actor: principal(host)}`, method 13), forwards browser updates coalesced every 50 ms with a host-assigned `seq`, applies daemon updates (outside edits, rebase reconciliation, `gone`) and fans them out, and relays `epoch` and `saved` unchanged. It never acknowledges a disk save, never opens host repository files, never spawns a helper per update. After a host restart it rebuilds from the daemon (sync step 1/2) before answering a browser. For wiki pages the same object persists after 2 s idle / 10 s max through `B/services/wiki_collaboration.go`'s revision-checked write and sends `saved` after commit. The daemon engine stays as spec §9.2 writes it; its only change is one trusted peer instead of one stream per browser.

**Why not the alternatives.**
- *Daemon only, host relays frames unparsed* (spec default, `docrelay.go`'s `Topology == "relay"`): every keystroke crosses the VM twice and shares the guest's vCPUs with `pnpm test`; the spike's 1,738 ms p95 is that path (`T-COL-11.md` Risks). The reference-host rerun can clear the transport but not the contention.
- *Host only, daemon stores an opaque record* (Opus): throws away the landed daemon engine and its tests, moves three-way merge to the host, and makes the daemon ship every outside write's bytes (≤ 1 MiB) over the link; the daemon must still do the atomic swap and keep displaced bytes, which is exactly `M/doc/disk/linux.rs`. Its gain (no Yrs in the guest, ≤ 2 × 1 MiB per open document) does not pay for that.
- *OT / `@codemirror/collab`*: a second engine beside the wiki's Yjs, a central sequencer that contradicts the two-peer split, and reconnect resend that state vectors give free.
- *Automerge or Loro*: migration of the landed client and wiki, no CodeMirror binding of `y-codemirror.next`'s maturity, no FFI we own.
- *Whole-text save over HTTP, diff-match-patch*: M-02 rejects it; concurrent typing at one spot drops characters.
- *Stateless JSON FFI per update* (today's `B/repohostserver/wiki_document.go:22`): O(document) per keystroke. The handle API replaces it.

**Admission and receipts.** Each subscription gets `{epoch, client_id}` from the host (ADR 0004 msg 5); two tabs of one person are two client ids. The host validates that an update introduces structs only under the subscriber's client id and never writes `authors`; the daemon re-checks on its side (`M/doc/host.rs` already refuses spoofing). Deletion authors go in the transaction envelope. Receipts (I1, I2):

```
browser → host   update bytes on sub <id>            host assigns seq per subscription
host → daemon    msg 1 input sync {actor, seq u64, update}   seq per stream, monotonic; same seq + different bytes = refused
daemon → host    msg 6 saved {unix_ms u64, through_seq u64, sv}   every input with seq ≤ through_seq is on disk
host → browser   saved {sv, seq}                     mapped from the daemon's through_seq to that subscription's seqs
```

"Saved to the machine" means every local update with `seq ≤` the last receipt. `LiveDocProvider.ts` keeps `covered()` on state vectors for display and adds the `seq` check for correctness.

**Document → disk** (spec §9.2.2, landed in `M/doc/disk/linux.rs`): state record (temp, fsync, rename, directory fsync); text to `.smithers-doc-<digest>-<rand>`, fsync; `renameat2(RENAME_EXCHANGE)` (`NOREPLACE` when absent); directory fsync. A displaced file whose digest equals `last_disk_digest` is deleted; any other displaced file is kept under a token (`keep()`), re-read after 200 ms quiet (at most 2 s), and reconciled as an outside write. Save 200 ms after the last update and at least every 500 ms while updates continue (not the spec's 1 s: the 1 s end-to-end budget needs room for the 50 ms coalesce, the link and fsync). The daemon knows its own writes by path and post-digest and excludes them from bursts. It adds `.smithers-*` to `.git/info/exclude`.

**Disk → document** (§9.2.3): on `IN_CLOSE_WRITE` / `IN_MOVED_TO` or a displaced file, read under the lock; equal digest means nothing; else `merge3(base = last saved text, ours = document, theirs = disk)` (`M/doc/merge.rs`). No overlap: one transaction under the outside actor's stable client id (`M/doc/authors.rs`). Overlap: the document wins on disk, the outside bytes become the burst's `after` version, non-overlapping hunks apply, and `branch:<id>:files` carries `outside_change{version, by}` so the card shows "Changed outside Smithers · Compare". A stale SSH save has no base to refuse against; recovery is the guarantee.

**Writes through Smithers never roll back** (replaces spec §9.4.1's swap-back and the stage-1 guest coordinator). `write_file` reuses the document swap: compare under the lock, swap, inspect the displaced file. Displaced digest equals the base: done. Displaced digest differs: an outside write landed inside the compare-to-swap window (about 1 ms); the daemon keeps those bytes as the burst's version, merges them into an open document as an outside write, flags Compare, and answers `applied{raced:[path]}`. A stale base seen at compare time answers `409 stale{path, current_digest}` and writes nothing (`B/services/workspace_facets.go:283-331` already carries this). For an open path the compare is against the document text and the write applies as one attributed transaction. Freezing sessions stays where §9.4.2 puts it: rebases and Return to Tn. E-16 narrows to "a stale write applies only when concurrent within the swap window, and both versions are kept and flagged"; ADR 0003's two counterexamples become regression fixtures of the new path.

**Undo and recovery.** ⌘Z is `Y.UndoManager` with `trackedOrigins: new Set()` on the local editor origin (`A/cards/liveDoc.ts:34`, landed), CodeMirror history off. Each editor's edits make one activity entry per 2 s idle period with a versions commit from the period's first save to its last, so co-edits are recoverable through Restore. Across reconnects a client resends every update no `saved` covers; an epoch change keeps them as `unsaved{count, text}` with Reapply and Copy (landed in `LiveDocProvider.ts:112-121`). Reapply merges against the current text or opens Compare; it never replays a whole file. Pending updates persist in the existing browser store scoped to origin/member/branch/epoch until a receipt covers them.

**Carets.** Awareness carries `{actor, colour, line, anchor, head}` with Yjs relative positions; the host stamps `actor` and `colour` from the socket identity and drops client-supplied values. `A/cards/liveDoc.ts:55` passes the provider's `Awareness` to `yCollab` instead of `null`, which enables `y-codemirror.next`'s remote selection plugin. The gutter name flag stays. Awareness coalesces at 50 ms client-side and is never persisted.

**Latency.** Keystroke to viewer is browser → host → browser on the LAN, one in-memory apply, no VM in the path; expected p95 under 150 ms against the 1 s budget (§18). Keystroke to disk: 50 ms coalesce, half an RTT (the contended measurement was 197 ms RTT busy), 200 ms debounce, fsync, half an RTT: under 600 ms even at the measured busy RTT. Outside save to open card: inotify, merge, half an RTT, fan-out: under 400 ms. The daemon's cgroup gets `cpu.weight` 1000 against 100 for sessions so a test run cannot starve saves. Binary, non-UTF-8 and files over 1 MiB open read-only.

## 4. Attribution and change tracking

| Door | Who | Actor | How |
| --- | --- | --- | --- |
| `write_file` over the host connection | app commands (`file.restore`, Reapply), document saves, flow steps | the authorizer's `principal` blob (ADR 0004 `Actor`) | daemon writes under the lock, records actor, path and post-digest, never re-attributes its own inotify event |
| `write_file` on `/run/smithers/machined.sock` | the coding agent's std tools | `run`, from `SO_PEERCRED` uid `agent` plus cgroup → `register_run` (method 10) | same; a request with an actor field is `unknown_field` and writes nothing |
| inotify burst | terminals, SSH editors, formatters, the agent's `bash`, hand-run `git`/`jj` | the only **person or agent participant** with CPU in the window, else `{outside: true}` | `M/attrib.rs` `cpu.stat usage_usec` per session cgroup, aggregated by participant |

Two changes to `M/attrib.rs` (its comment at line 50 says two sessions of one person stay ambiguous): candidates aggregate by participant, so Maya's shell and her Cursor server are one candidate; the coding host's cgroup is not a candidate (its writes are exact through the socket) and the agent counts only through its own PTY session while a command runs. The agent's coding host running with `/workspace` read-only in its mount namespace is a post-launch hardening, verified first on a real run.

**Grouping** (`M/burst.rs`, landed): one burst per key; all outside writes share one key; close after 1.5 s quiet, 10 s after open, or before a write with another key touches a file the burst touched. Per file `before` and `after` blobs; on close one parentless versions commit (`a/<path>`, `b/<path>`) and `burst{burst_id, actor, files[], versions_commit}` through the outbox with objects first as a git bundle (kind 0x06). The host (`B/machined/events.go`, new) verifies objects and inserts one `product_job_events` entry, N `burst_files` rows and the receipt in one transaction, publishes the bursts ref, then acks. The card reads "Maya via SSH changed 12 files" (distinct paths) and opens `before → after` per file from the host store, so it works while the branch sleeps. `file_written{path, actor, post_digest}` hints skip the outbox and reload open cards within 1 s. Ignored paths (§9.3.3) produce nothing. `moved_off{by}` fires from the metadata watches; Return to Tn runs `jj edit` under the freeze.

**Recovery.** Restore this file writes the burst's `before` with `base = that burst's post_digest`; a stale base opens Compare. Restore (deleted) uses `absent`; Follow reopens at the renamed path. The coding agent gets a system note naming who changed which files before its next tool call (T-COL-12) and must re-read before writing (`stale_read`).

**Gate (measured, not guessed).** Prediction: with one person's SSH editor plus shell active and the agent between commands, at least 95 % of that person's `pnpm format` bursts read "Maya via SSH"; two people active in one 1.5 s window read "changed outside Smithers", which is the product rule. The extended C-J3-03 run on the reference host measures it. If the first number falls under 90 %, kernel attribution (T-MCH-03) moves into launch; the S-2 probe below tells us in advance whether that is a day (stock kernel has fanotify) or a week (rebuild libkrunfw, T-INS-01).

## 5. Sessions, identity and terminals

- **Identity.** `collaborators.unix_uid` from 20000 and `unix_login` `[a-z0-9_-]{1,32}` reserving `root`, `agent`, `machined` (migrations 0116, 0121, landed). `agent` 19999, `machined` 19998, group `team` 20000. `/workspace` is `root:team`, setgid, `g+rwX`, `umask 002`, `safe.directory=/workspace`. No sudo, su, setuid or file capabilities; the layer key includes the identity-policy version.
- **Homes.** `/home/<login>` on the machine's own disk, 0700, created at first session, kept across sleep, never shared or token-copied (spike T-MCH-02).
- **Roster sync.** After `Welcome` and before `ready`, and on every roster change, the host sends `set_roster{members[{login, uid}]}` (new control method 16). The broker spawns only for listed uids and kills sessions of unlisted uids before replying, so a removal during a link outage takes effect at the next handshake without a clock lease.
- **Sessions.** Only the root broker spawns: `open_session(user{login, uid}, kind pty|exec|sftp, argv?, size?)`, `tcp_connect(port)`, `close_session`, `kill_sessions(user|run)`, `register_run`, `attach_session(id, received)` (methods 6–10, 15; Go client `B/machined/sessions.go`, landed). Each process is in its own cgroup; stream frames `data|eof|resize|signal|exit|window|close` with 256 KiB credit per direction (ADR 0004 kind 0x05).
- **Terminals.** `POST /api/terminals` makes a `person` admission request, then `open_session(member, pty)`. `B/routes/terminal_session_manager.go` keeps fan-out, the 512 KiB ring replay and reconnect; `terminal_owner.go` drops and counts non-owner input on every frame. Terminals keep their own WebSocket (§7.5). The agent's `bash` runs in one PTY per run opened on the local socket, owner "Agent", watch-only, rendered in the same Terminal card. A stalled watcher is evicted; it cannot block the owner.
- **SSH.** Compose `packages/backend/ssh/ssh.go` (`New`, `ListenAndServe`; today imported only by Plue) in the install on `127.0.0.1:2222` plus the owner's bind address. Username = branch slug (`ResolveBranchName`); keys = the member's GitHub keys plus `smthrs ssh-key`; shell/exec → `open_session(pty|exec)`, `subsystem sftp` → `open_session(sftp)`, `direct-tcpip` → `tcp_connect` (guest loopback only); agent and remote forwarding refused. `B/services/workspace_ssh.go:24-38`, which admits only `agent`, is deleted. Saves from VS Code or Cursor are outside bursts attributed to that member. SSH presence reports the last file written, no line.
- **Revocation in 5 s.** One transaction commits member state, credential revocations, share deletion and the durable event (`B/services/member_revocation.go:59`); fan-out closes live sockets and document subscriptions, cancels queued turns and aborts the running one, detaches terminals and SSH, and calls `kill_sessions(user)` on every awake branch, which returns at `populated 0`. Recovery polls at 1 s so a lost NOTIFY still lands inside 5 s. A revoked uid is also absent from the next `set_roster`.
- **Host restart.** Sessions keep running 30 s stalled by credit and the host re-attaches by `attach_session` after a link blip; a host restart ends terminals (§9.6.4, §8.11.3). Re-attach across restarts is a measured post-launch item.

## 6. Presence and live updates

**Transport.** One WebSocket per tab at `/api/live` (`B/routes/live.go`, `B/live/{hub,conn}.go`, `A/runtime/LiveChannel.ts`): text frames `sub/unsub/snap/delta/gap/err/saved`, binary `[kind u8][sub u32][payload]` with kind 1 sync and 2 awareness. The client→server `{"t":"presence","where":…}` frame already exists (`B/live/conn.go:243`) and binds to the socket's authenticated identity.

| Topic | Kind | Snapshot | Deltas | Resume |
| --- | --- | --- | --- | --- |
| `branch:<id>` | state | `{id, name, machine{state, wait_position?}, item?, place?, presence[], terminals[], ssh_line}` | runtime facts, roster leases (≤ 4/s), terminal manager | fresh snapshot |
| `branch:<id>:files` | state | `{changed[{path, change, last_writer}], open[{path, saved_digest, saved_at, editors[{actor, line}], outside_change?}]}` | `burst_files`, `file_written`, document host | fresh snapshot |
| `branch:<id>:activity` | log | last 200 entries | `product_job_events` cursor; page `id > cursor` up to 200, else `gap` | cursor |
| `conversation:<branch>` | log | shared entries | chat replay cursor | cursor |
| `doc:code:<branch>:<path>`, `doc:wiki:<page>` | document | Yjs sync step 1/2 plus `epoch` | document host | sync step 1, resend uncovered updates |
| `view:<me>:<branch>`, `confirmations:<me>` | private state | per member | | fresh snapshot |

Today `B/compose/live.go:107-109` answers `Unsupported` for `:activity` and `:files`; `branch:<id>` goes through `presence.source`; `conversation` and `members` are composed.

**Presence.** Keep the `BranchPresence.ts` lease roster behind `gateway/src/HostBranchPresence.ts` through `B/compose/presence.go` (spec §7.3.1): 30 s leases keyed `(branch, participant, session)`, heartbeats every 10 s and on change from the browser (`{path, line}`, `{terminal}`, `{step}`, `{branch}`), the daemon (`presence Snapshot{sessions[{session, path?}]}`, ≤ 4/s, mapped by the host to participants), the runtime for coding and reviewer runs and the turn runner for app-agent turns. `B/compose/presence.go:117` keeps refusing browser heartbeats that claim a terminal, run or step; those arrive only from host-side sources. Rows stay per session, render per participant with sessions on hover; an agent never collapses into its sponsor's avatar. Presence is `unknown` for 30 s after a host start and `unknown` counts as present for safe-idle and presence-aware rebase. Deltas coalesce to 4/s per branch.

**Reconnect.** Back off 250 ms to 5 s with jitter; resubscribe with the last cursor per log topic; a cursor past retention or a 2 MiB send-budget overflow yields `gap` and a fresh snapshot, never a partial replay. PostgreSQL committed events are the source; NOTIFY is only a wake-up. Documents restart at sync step 1 and resend uncovered updates. Presence needs no cursor.

**Scale (qualification profile, not a product cap).** 8 people × 3 tabs plus 4 agents (about 30 sockets), 10 open 1 MiB documents, 4 typists at 30 Hz, the agent busy on every vCPU. Two typists fan out roughly 1,800 small frames a second, far inside the per-connection 2 MiB budget. Documents close 60 s after their last subscriber (§9.2.5); the document host caps open documents per branch and refuses beyond it. Control, receipts and revocation outrank bulk terminal and object data.

## 7. Shared conversation

Storage is landed: `chat_turns.conversation_id`, the ordering index and the partial unique index allowing one `running` turn per conversation (`0120`), routes `GET /api/conversations/{b}`, `POST …/prompt`, `…/turns/{id}/stop`, `PATCH|DELETE …/turns/{id}`, `GET|PUT …/view-state` (`B/chat/http.go:578-587`), `Store.Claim` under an advisory lock, `SharedEntries` (`B/chat/shared.go:32`), `RevokeInactiveAuthors` (`B/chat/author.go:27`). What remains is the cutover:

- **Ordering.** Entries are the turn/batch replay cursor; shared output is append-only. A queued prompt is private on `view:<member>:<branch>` and becomes shared when its turn starts.
- **Who runs which turn.** The host dispatcher (`B/chat/dispatcher.go`), never the browser. At claim it re-checks the author is an active member, mints `delegated(via=smithers)` for the author, runs the model and every command through the catalog with `Smithers-Via: smithers`, and revokes the credential at end. `confirm` rows post a private Confirm card; `never` rows are absent from the tool list; approve and merge are impossible from a turn. Steers and answers to the coding agent are recorded with their author; the run keeps its sponsor's `run` credential.
- **Privacy.** `SharedEntries` is the only read for turns and preflight: started turns and outputs, excluding queued prompts, Confirm cards, drafts and view state. Turn credentials cannot read `view:*` or `confirmations:*`.
- **Revocation.** Queued turns of a removed member become `cancelled(author_revoked)`; the running one is aborted and its credential revoked within 5 s; the next queued turn starts.
- **Context.** A preflight on the fast model over the prompt, author, branch state (including presence) and the titles of recent shared entries selects files, wiki revisions, TODOs and runs within 24k tokens; the transcript is not the context window. The coding agent sees steers, answers and outside-change notes through its run.
- **External agents.** Claude Code or Codex in a member's terminal is imported read-only from its transcript (ADR 0004 event variant 5), attributed "Claude Code for Ben"; imported text never runs commands.
- **Delete.** The app still posts to `/api/agent/turn` and runs the tool loop in the browser (`A/state/controller/turns.ts` `continueToolLeg`, `presentation.ts:96`); only `/api/conversations/main/view-state` is called. Cut the composer over to `/prompt`, delete the browser executor, the `/api/agent/turn*` write routes, `B/services/app_timeline.go`, `B/db/app_timelines.sql.go` and `db/product/queries/app_timelines.sql` in one commit, after the Earlier archive reads legacy conversations through the existing decoder.

## 8. Failure and durability

| Event | What happens | Never lost |
| --- | --- | --- |
| Machine sleeps | final capture: flush documents, close bursts, `jj util snapshot`, bundle objects, drain the outbox; the VM stops only when the outbox is empty; disk kept | every save and burst end state |
| Machine wakes | host sends its head's objects, calls `wake_reconcile(head)`; `moved`/`conflict` is an event, never only a reply; `set_roster`, then sessions only after `ready` | work captured before sleep; a conflict becomes Needs you |
| Daemon crash | broker kills every session cgroup, restarts the daemon with backoff; outbox replays from the lowest unacked seq; each open document reloads its record and reconciles the file (as saved / finish an interrupted swap / outside write while down); terminals end; the mirror reopens streams and resyncs | every receipted update, every acked event; unreceipted typing stays in browser buffers |
| VM crash | as above plus `wake_reconcile`; a replayed `captured` whose base differs from the head the host last sent gets `stale_base` | acked bytes and receipts; nothing applied twice (receipt keyed `(branch, event_id)`) |
| Daemon ↔ host link drops | sessions run 30 s stalled by credit; `attach_session(id, received)` resumes streams; the mirror keeps serving browsers ("Saving…"), buffers coalesced updates, resyncs on reconnect; outbox resends; `set_roster` on the handshake kills revoked uids | nothing; latency only |
| Browser drops | resubscribe with cursors; `gap` → fresh snapshot; documents resend uncovered updates; an epoch change keeps them as `unsaved` with Reapply/Copy | the member's typing while the tab or its local store lives |
| Host restart | mirrors rebuilt from each daemon before answering; presence unknown 30 s (no release); terminals end; chat leases and credentials recovered before a new turn is admitted; daemons keep running and replay outboxes after the handshake | everything on machine disk or in PostgreSQL |
| Rebase while people type | under the lock: freeze the sessions cgroup (≤ 1 s, else `busy{session}` and "Waiting for a write in Ben's terminal"), drain inotify, close bursts, local capture (pinned and queued, not awaited), `jj rebase`, reconcile each open document from disk as one transaction "Rebased onto Tk" keeping unsaved typing, thaw. Thaw only after the rewrite settled or `jj op restore` restored the captured tree; never with a half-applied rewrite. Browsers keep typing into the mirror; only saves wait; queued `write_file`s revalidate and stale ones get `409` | no writer's bytes; every pre-rebase state is in a versions commit or the capture |
| Outside save on a file people type in | watcher or displaced-file path, whichever first; no overlap merges; overlap keeps the document on disk and the outside bytes as the burst's `after`, flagged Compare | the outside bytes; the typists' characters |
| Smithers write races an outside save | the swap applies; displaced bytes kept as a version and merged or flagged; the writer gets `raced` | both versions |
| Disk full or persistence error | no `saved`, no further replacement; recovery material retained; cleanup cannot delete a machine whose final capture is incomplete | acknowledged state |
| Member removed mid-everything | one transaction; sockets, turns, terminals, SSH, sessions, share and run credentials gone within 5 s; TODOs keep history; a stale grant never authorizes a write (recheck at the mutation boundary) | the branch, its machine, other members' work |

Rules: an event is acknowledged only after the host commits objects, row and receipt in one transaction; `saved` is sent only after the record and file are fsync'd; the host moves a head ref only to a commit it holds; every object a queued event names is pinned by `refs/smithers/pending/<event_id>` and `syncfs`'d before the entry is written. Guest fsync is not off-machine replication; loss of the guest disk before capture needs backup and is outside the save guarantee.

## 9. Reuse map

| Piece | Class | Paths |
| --- | --- | --- |
| Wire codec, golden frames | keep, extend (seq, through_seq, set_roster, raced) | `B/machined/wire/*`, `M/{conn,msg,schema,document_payload}.rs`, `B/compose/testdata/cocontracts/` |
| Daemon components | keep, compose | `M/{hooks,lock,rpc,stream,credit,outbox_store,watch,ignore,attrib,burst,versions,events,resync,session}.rs`, `M/broker/{cgroups,sessions}.rs`, `M/doc/{host,merge,reconcile,state,authors,gone,disk}.rs`, tests `documents.rs`, `versions.rs`, `watch.rs`, `session_supervisor.rs` |
| Daemon processes | new (`machined.md` §2, §4–7); `M/main.rs` exits 78 today | `M/{daemon,link,brokerproto,confine,files,local,client,capture,objects,reconcile,freeze,oplog,wiring}.rs` |
| Host registry, session client | keep, mount, extend | `B/machined/{registry,sessions}.go`, `machinedfake`, `testfake`; new `link.go`, `events.go`, `capture.go`; `B/microsandbox/machined.go` (plant, init) |
| Head reporter | delete | `B/services/workspace_head.go` reporter functions (`installWorkspaceHeadReporter`, `rotateWorkspaceHeadToken`, `ReportWorkspaceHead`, …), its route and tests; capture replaces it |
| Guest write path | delete at daemon cutover | `B/microsandbox/guest/smithers-guest.py` `fs_*` and `coordinated_compare_write`, `B/microsandbox/{files_compare_write,guest_compare_write*}.go`, the writer-coordinator journal; keep ADR 0003's race probes as fixtures of the new path |
| File write route | keep | `PUT …/files/content` with `base_digest` and `changes` (`B/routes/workspace.go:482`, `B/services/workspace_facets.go:273`); reply gains `raced[]`; provider becomes daemon `write_file` |
| Live channel | keep, extend | `B/routes/live.go`, `B/live/{hub,conn}.go`, `B/compose/live.go` (serve `:activity`, `:files`), `A/runtime/LiveChannel.ts`, `packages/rpc/src/LiveDoc.ts` |
| Document relay | reshape into the document host | `B/live/docrelay.go` (topic parse, admission, actor envelope) plus new `B/live/codedoc.go`; delete the `Topology` switch |
| Yrs core and FFI | keep, add a handle API | `crates/smithers-ffi/src/document_core.rs`; new `live_document.rs` handle ABI; `B/repohostserver/wiki_document.go` moves to handles; `wiki_document.rs`'s JSON entry deleted when no caller remains |
| Wiki collaboration | reshape | `B/services/wiki_collaboration.go` keeps the revision-checked write; `B/routes/wiki_collaboration.go` keeps `GET …/document`; delete the client save queue (`A/state/controller/cloud-wiki.ts` `resumeWikiSaves`) in favour of `LiveDocProvider` |
| Browser provider and binding | keep, extend | `A/runtime/{LiveDocProvider,FileDocuments}.ts`, `A/cards/{liveDoc,liveAttribution}.ts`, `packages/rpc/src/testing/LiveDocRelay.ts`, `@smthrs/ui` code-editor adapter |
| File and Diff cards | reshape | `A/cards/FileCards.tsx` (`FileCardBody` already takes `live`), `CodeEditorSurface.tsx`, `views/CodeEditorView.tsx` for every file; delete the read-only `CodeFileView` render path in the same commit |
| Presence | keep | `flows/sync/src/BranchPresence.ts`, `gateway/src/HostBranchPresence.ts`, `B/compose/presence.go` (accept daemon and run sources), `A/cards/BranchCard.tsx` |
| Terminals | keep, reshape dialer | `B/routes/{terminal_session_manager,terminal_owner,terminal_ring_buffer}.go`; `B/routes/workspace_terminal.go` and `workspace_runtime_terminal.go` dial `B/machined/sessions.go`; `A/state/CloudTerminalClient.ts` unchanged |
| SSH gateway | compose, reshape bridge | `packages/backend/ssh/ssh.go`, `B/ssh/{server,channels,workspace_access,workspace_session,revocation}.go`; new `B/services/branch_ssh_bridge.go`; delete `B/services/workspace_ssh.go:24-38` |
| Identity and homes | reshape | `B/microsandbox/runtime.go` (uid 19999, team, machined), `guest/smithers-guest.py` setup, `layers.go`; `0116`, `0121` landed |
| One machine per branch, admission | keep, finish | `0108_branch_machines.sql`, `B/services/{workspace_branch_machine*,workspace_machine_queue,workspace_access}.go`, `B/microsandbox/runtime.go` admission, `#3567` slot retention |
| Membership | keep | `B/identity/member_boundary.go` (roster members on member routes), `B/services/member_revocation.go`, `workspace_shares` queries |
| Conversation | keep, cut over | `B/chat/{store,dispatcher,http,queue,shared,author,view_state,preflight}.go`, `0120`; delete `app_timelines`, the browser tool loop, `/api/agent/turn*` writes |
| Attribution | reshape | `M/attrib.rs` participant-level candidates; kernel observation stays in `tickets/deferred/T-MCH-03.md` until the gate fails |
| Spikes | keep as benchmark methods | `scripts/spikes/col-01/` (rerun on the reference host), `scripts/spikes/trm-06/` (README: "INCOMPLETE; activation refused") |

Net new, with why reuse fails: the daemon process layer (no production composition exists), the Go link and ingest (the reporter is connectionless), `codedoc.go` (the relay has no engine), the FFI handle API (the JSON call is O(document) per update), `branch_ssh_bridge.go` (the existing bridge targets a guest sshd that will not exist), `burst_files` and `machine_event_receipts` (job events cannot index per-file versions or dedupe by event id), `set_roster`.

## 10. Build plan

### Spikes, days 0–2, in parallel with the interfaces

| Spike | What | Result that changes the design |
| --- | --- | --- |
| S-1 | `scripts/spikes/col-01/run.sh` on the idle reference Mac mini with browsers on a second Mac, both transports, guest idle and busy (C-SPK-03, C-SPK-07); plus the four kernel probes (`RENAME_EXCHANGE`, `openat2`, `cgroup.freeze`, `cgroup.kill`) and the 1,000-capture growth run from T-COL-11 | Decides relay vs bridge and the save-path batching; it cannot remove the document host (the wiki needs it). A failed `RENAME_EXCHANGE` probe moves the displaced check before a `NOREPLACE` rename. Growth over 2 GiB per 14 days shortens op-log retention. |
| S-2 | T-MCH-03 fanotify probe (one day): `fanotify_init` in the stock libkrunfw guest, writer pid → uid for short-lived writers | Tells us the fallback cost if the attribution gate fails: a day (stock kernel) or a week (rebuilt libkrunfw, T-INS-01/03). |
| S-3 | In a Linux VM: a VS Code server, an idle Node process and a formatter in three cgroups as two uids; count 1.5 s windows where more than one participant's cgroups gain CPU | Over 10 % ambiguous windows with one person active means participant-level aggregation is not enough; kernel attribution enters launch now instead of after dogfood. |
| S-4 | T-TRM-06 (two days): a real VS Code Remote-SSH session over daemon `pty|exec|sftp|tcp` sessions with a root supervisor and no sshd; revocation timing with background children | A missing channel capability adds a frame to §9.6 before W7–W9 land; revocation over 5 s with children in uninterruptible I/O lengthens the kill wait and shows the blocker. |

### Interfaces first, days 1–2, seven lanes of one agent-day each

| ID | Interface (exact shape) | Proof |
| --- | --- | --- |
| I1 | ADR 0003 topology = document host plus daemon peer. ADR 0004 amendments: `open_doc{path, actor}` unchanged; doc msg 1 input `{actor, seq u64, update}`; doc msg 6 saved `{unix_ms u64, through_seq u64, sv}`; control method 16 `set_roster{members: list<{login str, uid u32}>} → {}`; `write_file` result adds `raced{path, displaced_digest}` beside `applied` and `stale` | Go/Rust golden frames in `B/compose/testdata/cocontracts/`; decode of every old frame unchanged |
| I2 | `packages/rpc/src/LiveDoc.ts`: `saved{sv, seq}`, awareness `{actor, colour, line, anchor?, head?}` (host stamps actor and colour), `outside{version, by}`, `gone{kind, by, to?}`; `packages/rpc/src/BranchCard.ts`: `branch:<id>`, `branch:<id>:files`, `branch:<id>:activity` entry `{id, at, kind: write|burst|doc_edit|rebase|moved_off, actor, files[{path, change, before_blob?, after_blob?}], versions?}` | zod fixtures; `LiveDocRelay.ts` fake updated; `co-edit.spec.ts` on the fake |
| I3 | Go `machined.Client`: `ReadFile`, `WriteFiles(ctx, branch, actor, changes) → {applied[{path, post_digest}], raced[], stale?}`, `Capture`, `WakeReconcile`, `Rebase`, `ReturnToItem`, `OpenDocument` (exists in `docrelay.go`), `Sessions(branch) SessionRPC` (exists), `SetRoster`, `Events(branch)`, `Ack` | `machinedfake` implements it; `registry_test.go` compiles every consumer against it |
| I4 | `M/wiring.rs`: production `Hooks` composition behind `unsupported` defaults so every Rust lane compiles; `Documents::flush_all/write_through/reconcile_all` as in `M/hooks.rs:70-100` | crate builds with each lane's module stubbed |
| I5 | `crates/smithers-ffi/src/live_document.rs` C ABI: `ld_open(kind, state?) → h`, `ld_apply(h, client, update) → {broadcast, refused}` (refuses foreign client ids and `authors` writes), `ld_sync1(h) → sv`, `ld_sync2(h, sv) → update`, `ld_awareness(h, bytes)`, `ld_set_author(h, client, actor)`, `ld_state(h)`, `ld_text(h, root)`, `ld_close(h)`; `catch_unwind` at every entry | `tests/yjs-interop.ts` moved beside it; Go wrapper race test; fuzz decode/apply at the boundary |
| I6 | Migrations `burst_files(event_id, path, change, before_blob, after_blob, post_digest, renamed_to)` and `machine_event_receipts(workspace_id, event_id, outcome, at)` unique on `(workspace_id, event_id)` | migration test on real PostgreSQL; duplicate event → one row |
| I7 | Write route reply: `200 {paths[{path, post_digest}], raced[{path, version}]}`; `409 stale{path, current_digest}` unchanged | OpenAPI row; handler test |

### Work items (agent-days), each landing dark behind a fail-closed gate

| # | Item | After | Proof: unit / integration (real PostgreSQL) / browser e2e / real machine |
| --- | --- | --- | --- |
| W1 | Daemon processes: broker, daemon lifecycle, link and handshake, confine, files, local socket, `client` subcommand (4) [T-COL-03a] | I3, I4 | `tests/{broker,link,confinement,write_file,local}.rs`; fake host replays `seq_handshake`, `seq_write_stale`; real microVM boot to `ready`, `kill -9` the daemon, back to `ready` |
| W2 | Outbox send, bundles, capture, `wake_reconcile`, freeze with thaw-after-settle, op-log (4) [T-COL-03a] | I4 | `tests/{outbox,capture,reconcile,barrier,oplog}.rs`; K3/K3b/K4/K4b/K5a–c fault runs ×10; forced rewrite failure leaves the tree frozen until restore |
| W3 | Host link, registry mounted, per-boot credentials, planting, ingest and receipts, capture publish; delete the head reporter (4) [T-COL-03] | I3, W1, W2 | `registry_integration_test.go` (cross-branch credential refused, newer boot replaces, duplicate event = one row); capture durability; real machine K6 |
| W4 | One machine per branch finished: every provisioning path over the 0108 key, member admission on every door, erasure safety, `GET /api/branches` (2) [T-MCH-04] | — | `TestBranchMachineConcurrentJoin` (60 requests → 1 row, 1 VM); `branch_machine_members_integration_test.go` extended; real machine C-MCH-01 |
| W5 | Identity: `team` group, no-sudo image, per-machine homes, `set_roster` in the broker (3) [T-MCH-11] | I1 | `real_users_test.go` (no setuid, `EACCES` on homes, team write); `jj st`, `git status`, `pnpm install` alternating across two members and `agent` ×100; C-MCH-09/10 soak across sleep |
| W6 | Watcher integration: `register_run`, participant-level candidates in `attrib.rs`, burst ingest, `burst_files`, `:activity` and `:files` topics, Restore (4) [T-COL-04, T-COL-04a, T-APP-11] | W3, W5, I6 | `TestBurstIngestProductionBoundary`; C-COL-05 matrix (overlap, actor switch, drain, overflow, metadata, two sessions of one person); real VM `pnpm format` on 12 files → one entry, Restore one file |
| W7 | Session supervisor end to end: spawn as uid, cgroups, stream frames, kill, attach, local-socket PTY (3) [T-TRM-07] | W1, W5, S-4 | `tests/sessions.rs` (exit 7, TERM, 1 MiB half-close, 1 GiB stalled reader, nohup lingers then dies at kill, 10 s reattach); real machine `pgrep -u` empty ≤ 5 s |
| W8 | Terminals on sessions: owner-only input, watchers, agent terminal, LSP exec session (2) [T-TRM-01, T-TRM-05] | W7 | manager unit (1,000 watcher frames → 0 stdin bytes); `terminal_owner_integration_test.go`; e2e C-J3-02, C-J3-10 |
| W9 | SSH gateway composed on sessions: branch logins, sftp, `direct-tcpip`, bind rule, revocation; delete the agent-only user path (3) [T-TRM-03] | W7, S-4 | `workspace_access_test.go`; `TestSSHProductionAuthorizationAndForwarding`; real machine VS Code Remote connect, edit, save, `-L` forward; removal ≤ 5 s with the server running, 20 runs |
| W10 | Presence: bridge accepts daemon and run sources, browser presence frame, 30 s unknown window, coalescer, visit audit (2) [T-COL-06] | I2 | fake-clock expiry at 30.0 s not 29.9; `TestPresenceDeltaCoalescing` (100 moves/s → ≤ 4/s); e2e C-J3-01 three participants visible within 1 s |
| W11 | Admission scheduler remainder: people-first FIFO, safe-idle release reading presence, sessions, bursts and flush (3) [T-MCH-06] | W4, W10 | C-MCH-02 and C-MCH-11 matrices through `POST /api/terminals`; restart reconciliation fault; C-PERF-05 warm wake |
| W12 | FFI handle API and Go wrapper (3) [I5] | I5 | 1,000 open/close cycles on 1 MiB documents under the race detector and ASan; panic through FFI is caught |
| W13 | Document host serving `doc:wiki` (2 s/10 s persist, `saved` after commit) and the wiki cutover; delete the client save queue (3) [T-COL-09] | W12, I2 | real database commit-before-saved; two browsers on one page; host kill loses no receipted keystroke; old routes absent, revisions readable. **Tracer bullet A: wiki co-editing ships here.** |
| W14 | Document host serving `doc:code` as the daemon's peer: 50 ms coalesce, seq/through_seq receipts, epoch relay, rebuild on restart (3) [T-COL-08b] | W12, W3 | `TestDocRelayWireContract`, `TestDocRelayAuthorization` (foreign client id, forged authors map, revocation ≤ 5 s), `TestDocRelayMirrorRecovery`, K8; deletion-only save receipt |
| W15 | Daemon documents wired: `Documents` hook on the lock, flush in capture, reconcile in freeze, own-write exclusion, `gone`; `write_file` over the document swap with `raced`; delete the guest coordinator and journal (4) [T-COL-08a, T-COL-10] | W2, W6, W14 | rerun `documents.rs` on the real stack; `SMITHERS_MACHINED_WATCH_DELAY_MS=2000` ordering ×40; K7a–K7e; fuzz 4 outside writers × 100,000 rounds, zero lost byte states, `raced` counted; ADR 0003's two counterexamples as fixtures |
| W16 | File card live mode: provider on the real channel, carets through awareness, `CodeEditorView` for every file, Compare/Restore/Follow/Reapply, author colours and gutter flags (3) [T-APP-14a, T-APP-14, T-UI-19 amended] | W14, W15 | `LiveDocProvider.test.ts`, `liveDoc.test.ts`; `co-edit.spec.ts` on the fake; e2e `file-coedit.spec.ts` from a second Mac (C-J3-04); C-PERF-03 ×200 |
| W17 | Conversation cutover: composer → `/prompt`, host tool loop, private queue, revocation; delete `app_timelines` and the browser executor (3) [T-APP-16] | — | `TestBranchConversationOrderedReplay`, `TestHostTurnAuthorRevocation` (≤ 5 s), `TestHostTurnPrivateContext` (canary never in a model request); e2e a turn survives closing the tab |
| W18 | Moved-off detection, Return to Tn, Keep for now; agent note on outside change (2) [T-COL-05, T-COL-12] | W6, W2 | `moved_off.rs` predicate table; two Returns race → one 409; e2e C-J3-09, C-J3-03 |
| W19 | Revocation fan-out end to end including `set_roster` on reconnect (2) [T-ACC-02] | W8, W9, W17 | partition the link, remove the member, restore the link: every descendant gone ≤ 5 s after the handshake; 20 runs |
| W20 | Fault and perf suites as `smthrs test` targets (K1–K8, C-PERF-02..06, `scripts/perf/{keystroke,disk-write}.mjs`) and the reference-host rehearsal (3) | W3, W15 | artifacts under `.artifacts/checks/` and `.artifacts/perf/<date>/` with the host profile; sleep/wake, rebase while two type, host restart, stale outside save, revocation, both themes, second laptop |

```
day    0        1
       012345678901234567890
S1-4   ███
I1-7   ██
W4     ██
W5       ███
W12      ███
W17       ███
W1       ████
W2       ████
W13         ███        ← tracer A: wiki co-editing live
W10         ██
W3           ████
W14          ███
W6               ████
W7               ███
W11              ███
W8                  ██
W9                  ███ ← tracer B: Ben's terminal echo → Alice's File card, attributed, < 1 s
W15                  ████
W18                   ██
W16                      ███
W19                      ██
W20                        ███
```

Critical path: I1–I7 → W1/W2 → W3 → W6/W7 → W15 → W16, about 19 agent-days serial with six to eight lanes busy. Off the path: W4, W5, W10, W12 → W13, W17. Tracer B (W1, W3, W5, W6, W7, W8) is the first thing to demand on a real machine; tracer A (W12, W13) proves the document host, protocol and latency with no daemon at all. Each item has one claimed issue (the ticket in brackets), lands with its unit and real-PostgreSQL suites green, and activates only when its real dependency reports `ready`; a component landing dark is not completion.

## 11. Risks and open questions

| # | Risk or question | Falsify cheaply | If it holds |
| --- | --- | --- | --- |
| R1 | The document host misses 1 s keystroke-to-viewer on the LAN | S-1 with browsers on the second Mac: expect p95 under 150 ms; above 500 ms the LAN, not placement, dominates | no topology fixes it; measure the LAN |
| R2 | Saves exceed 1 s under guest load | time the save path while `pnpm test` saturates every vCPU, with and without `cpu.weight` 1000 on the daemon | raise the max-age flush to 300 ms, prioritize document streams over object bundles; never claim Saved early |
| R3 | Session attribution reads "changed outside Smithers" too often | S-3 now; extended C-J3-03 after W6: under 90 % correct with one person active | T-MCH-03 kernel attribution enters launch; S-2 says whether that is a day or a week |
| R4 | A never-roll-back write loses bytes | W15 fuzz: every outside write's bytes appear in some version; count `raced` | more than a handful of `raced` in the first 10,000 dogfood writes means the window is wider than 1 ms; inspect the swap |
| R5 | `cgroup.freeze` cannot reach `frozen 1` in 1 s while a session is in uninterruptible I/O | C-COL-03 step 4 under `pnpm install`; measure timeout rate | lengthen to 2 s and show the blocker; never rewrite unfrozen |
| R6 | A shared working copy with several uids breaks jj/git (lock files, `safe.directory`) | W5's alternating commands ×100 | system gitconfig, setgid dirs, umask 002 |
| R7 | A panic in the Yrs core through FFI kills the host process | W12 fuzz and `catch_unwind` | run the document host in a child process behind the same interface |
| R8 | Deletion-only receipts: `through_seq` mapping across the mirror's coalesced batches drops a receipt | W14 test: delete-only transaction, kill the daemon after `saved`, restart, text matches | per-subscription seq stays authoritative; the mirror never coalesces across a receipt boundary |
| R9 | Disk growth: state records, versions commits, captures | S-1 growth run, 1,000 captures; 14-day projection under 2 GiB per machine | shorten op-log retention; prune state records of closed documents after capture |
| R10 | One running turn per conversation makes Alice wait behind Ben's 60 s turn | log queue wait per turn in dogfood; above 10 s p95 revisit | product decides parallel turns per author; the unique index already keys per conversation |
| R11 | VS Code's server dies with its exec channel, or revocation passes 5 s on a process in uninterruptible sleep | S-4 steps 6 and the revocation runs | add the missing frame to §9.6 before W8/W9; lengthen the kill wait and show the blocker |
| R12 | Two outside writers (formatter plus SSH save) inside one 1.5 s window share one burst key | C-COL-05 with two concurrent outside sessions of different people | spec behaviour: `outside`; the versions commit holds both end states |
| R13 | Host memory from open documents (N × ≤ 1 MiB × 2 copies) | count open documents on the dogfood install; close after 60 s idle | cap per branch; refuse beyond it |
| Q1 | Owner: accept the E-16 wording "a stale write applies only when concurrent within the swap window; both versions are kept and flagged" | R4's count | keep; the alternative is a freeze per write that ADR 0003 says cannot be made complete |
| Q2 | Product: SSH presence shows the file only; the line needs an editor extension | show the J3 mock with file-only SSH presence | J3.2's `retry.ts:12` comes from the File card, not SSH |
| Q3 | Engineering: spec §7.4.5 and T-UI-19 say no carets; the 10-06 brief says carets | amend both with the brief as authority | done in I2 |
| Q4 | Engineering: terminals across host restarts (amend §9.6.4) | count host restarts with open shells in the first two dogfood weeks | two days: persist `(session, owner, terminal)` and re-attach from `status().sessions` |
| Q5 | Engineering: retire ADR 0003's "Decided by T-COL-11" and T-COL-11's relay-or-mirror rule in favour of §3; keep its rerun as the transport and save-budget measurement | S-1 | done in I1 |

One action: land I1–I7 and run S-1 to S-4 this week, and start W1, W2, W4, W5, W12 and W17 in parallel against them; nothing else waits on a decision.
