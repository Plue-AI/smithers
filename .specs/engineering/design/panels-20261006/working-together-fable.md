# Working together on one branch: design (Claude Fable)

Repository read: `~/smithers-frontrun` at origin/frontrun, 2026-10-06. Every path below was checked in that tree; "planned" marks a path a ticket names that does not exist yet.

## 1. Summary

One branch has one microVM whose Rust daemon (`smithers-machined`) is the only writer of the working copy on Smithers' behalf, the only observer of writes, and the supervisor of every member and agent process, so every byte on disk has an author and a recoverable before-state. Live code and wiki documents are Yjs documents served to browsers by one host-side document host (Go over the existing `smithers-ffi` Yrs core) on the one `/api/live` socket; the daemon is a second Yjs peer that owns the file on disk, saves 200 ms after the last update, merges outside saves three-way, and alone sends `saved`, so keystroke fan-out never crosses a busy VM and the disk stays the truth. People reach the machine as their own unix user through daemon sessions (terminals, SSH channels, sftp, port forwards) in per-session cgroups, which gives session-based attribution, watch-only sharing, 5 s revocation by `cgroup.kill`, and a 1 s freeze for rebases. Presence is a 30 s lease table in the Go live hub fed by browsers, the daemon and runs, published as `branch:<id>` deltas at most 4 per second. The branch's conversation is `chat_turns` rows keyed by `conversation_id`, one running turn per conversation, each turn run on the host with a credential minted for its author at start and revoked at end.

## 2. Abstractions

| Object | Identity | Owner (writer) | Source of truth, where it lives | Rebuilt from |
| --- | --- | --- | --- | --- |
| Branch | name (`smithers/<slug>`, `scratch/<member>/<name>`) | stack service (`services/mythical*.go`) | `workspaces` row keyed `(repository_id, kind, target_bookmark, name)` without `user_id` (T-MCH-04); grants in `workspace_shares`; PostgreSQL | backups |
| Machine | branch + boot id | runtime (`microsandbox/runtime.go`) + `internal/machined.Registry` | VM and disk on the host; boot credential and relay secret in registry memory and `/run/smithers/machined/boot` in the guest | runtime VM list at restart; a new boot mints new credentials |
| Session | u32 from the daemon | broker (`crates/smithers-machined/src/broker/sessions.rs`) | cgroup `/sys/fs/cgroup/smithers/sessions/s<id>` + broker registry (daemon memory); host view in `TerminalSessionManager` (host memory) | none; a daemon restart kills them (§9.6.4) |
| File (awake) | path + SHA-256 | daemon, under one mutation lock | bytes on the machine disk | last capture in the host repo store |
| File (asleep) | path at captured head | host | `refs/smithers/branches/<id>/head` in the host repo store | the ref |
| Document | `doc:code:<branch>:<path>` / `doc:wiki:<page>` | daemon (code) / host (wiki) for durability; host document host for fan-out | code: state record `/var/lib/smithers/docs/<digest>` + the file; wiki: `wiki_pages.crdt_state` in PostgreSQL; host mirror and browser `Y.Doc` are caches | the state record (same epoch); only a missing record reseeds from text with a new epoch |
| Change (burst) | `burst_id` | daemon emits, host commits | `product_job_events` row + `burst_files` rows + versions commit at `refs/smithers/branches/<id>/bursts/<burst>`; receipt in `machine_event_receipts` | daemon outbox replay until acked |
| Presence | `(branch, participant, session)` | Go live hub | memory, 30 s lease | heartbeats; unknown for 30 s after host start |
| Conversation | branch | chat runtime (`internal/chat`) | `chat_turns` + `chat_turn_batches`; per-member `collaborators.view_state` | backups |
| Actor / participant | id | host authorizer | derived from the authenticated principal; never from a frame or body | n/a |

Rule that keeps this honest: the daemon never names a branch, machine or uid in anything it sends; the host derives them from the authenticated connection (ADR 0004). Browsers never learn where a document's authority lives; they address it by topic.

## 3. Co-editing model

**Decision: Yjs, one core, two peers, mirror on the host.** The CRDT is Yjs in the browser (`yjs` 13.6.32, already pinned in `apps/app/package.json` and `packages/smithers/ui`) and Yrs 0.27.4 everywhere else through the one core `crates/smithers-ffi/src/document_core.rs`, which the daemon already includes by path (`crates/smithers-machined/src/doc/mod.rs`) and the host already binds for the wiki (`internal/repohostserver/wiki_document.go`). Text root `content` for code, `markdown` for wiki; `Y.Map("authors")` maps client id to actor. Per-character colour comes from each item's client id (`apps/app/src/mainview/cards/liveAttribution.ts`, landed).

```
 browser A ──ws /api/live──┐                                   microVM
 browser B ──ws /api/live──┤   host document host (Go + Yrs)     ┌────────────────────────────┐
 browser C ──ws /api/live──┘   one Y.Doc per open topic          │ smithers-machined          │
         ▲   fan-out ≤ 5 ms     │  ▲                              │  doc/host.rs: Y.Doc peer   │
         │                      │  │ ADR 0004 kind 0x04,          │  state record + file       │
         └── saved{sv} ◀────────┘  │ one stream per open doc      │  3-way merge of outside    │
                                   ▼ updates batched 50 ms        │  saves; sends saved{sv}    │
                                 relay/bridge byte stream ───────▶│  200 ms debounce → fsync   │
                                                                  └────────────────────────────┘
```

**Where documents live.** The host document host (`packages/backend/internal/live/codedoc.go`, planned beside the landed `docrelay.go`) holds one Yrs document per open topic and is the peer every browser syncs with. For a code file it opens one ADR 0004 document stream to the daemon (`open_doc{path, actor: principal(host)}`) and syncs as a §7.4.6 client: it forwards browser updates to the daemon coalesced every 50 ms (`Y.mergeUpdates`), applies daemon updates (outside edits, rebase reconciliation, gone states) to its copy and fans them out, and relays `saved{sv}` and `epoch` unchanged. For a wiki page the same host object persists to PostgreSQL after 2 s idle / 10 s max and sends `saved` after commit (`services/wiki_collaboration.go` keeps the revision-checked write). The daemon (`crates/smithers-machined/src/doc/host.rs`, 696 lines, landed as a component with `open`, `update`, `sync_message`, `write_through`, `completed_write`, `gone`, `tick`, `flush_all`, `reconcile_all`) stays the disk authority exactly as spec §9.2 writes it; the mirror changes nothing in it except that it has one trusted peer instead of one stream per browser.

**File ↔ document consistency.** Document → disk is §9.2.2: state record (temp, fsync, rename, dir fsync), text to `.smithers-doc-<digest>-<rand>`, `renameat2(RENAME_EXCHANGE)`, compare the displaced file with `last_disk_digest`, then `saved{sv}`. Disk → document is §9.2.3: on `IN_CLOSE_WRITE`/`IN_MOVED_TO` or a displaced file, read bytes under the lock; equal digest means nothing; otherwise `merge3(base = last saved text, ours = document, theirs = disk)` (`doc/merge.rs`, `similar` crate). No overlap: apply as one transaction under the outside actor's stable client id (`doc/authors.rs`), which the mirror and browsers receive within one RTT. Overlap: the document wins on disk, the outside bytes become the burst's `after` version, the non-overlapping hunks apply, and `branch:<id>:files` carries `outside_change {version, by}` so the card shows "Changed outside Smithers · Compare". The agent's `write_file` to an open path compares `base_digest` against the document text, not the disk, and applies as one attributed transaction (§9.4.1). The daemon excludes its own saves from watcher bursts by path and post-digest.

**Undo and recovery.** ⌘Z is a `Y.UndoManager` tracking only the local editor origin (`cards/liveDoc.ts`, landed), so nobody undoes a teammate. Every document edit also produces activity: one entry per editor per 2 s idle period with a versions commit from the period's first save to its last, so co-edits are recoverable through the same Restore-this-file path as outside bursts. Across reconnects a client keeps every update no `saved` covers and resends it in sync step 2 (`runtime/LiveDocProvider.ts`, landed); an epoch change keeps those updates as `unsaved {count, text}` with Reapply and Copy (C-DUR-04 K7e). The mirror is a cache: after a host restart it rebuilds from the daemon's state before answering a browser and never synthesizes `saved`.

**Why this meets the budget.** The spike measured the planned path at relay 4 KiB busy p95 197 ms and bridge 30 Hz keystroke p95 1,738 ms (contended M3 Max, no second device, `scripts/spikes/col-01/README.md`). Under the mirror, the keystroke-to-viewer budget (§18, < 1 s) is browser → host → browser: one LAN hop each way plus an in-memory apply, with no VM in the path, so a busy guest (a `pnpm test` using every vCPU) cannot stall viewers. The VM leg only bounds "Saved to the machine": 50 ms coalesce + half an RTT + 200 ms debounce + fsync + half an RTT, under 600 ms even at the measured busy RTT, inside the 1 s of §9.2.3a. Outside write to open card is daemon merge + half an RTT + fan-out, under 400 ms. The mirror also makes the browser protocol identical for wiki and code, which is the "one co-editing implementation" §7.4.3 asks for.

**Rejected.** (a) Documents only in the daemon with the host relaying frames unparsed: every keystroke crosses the VM twice and shares the guest CPU with the member's test run; the spike's 1.7 s p95 is that path. (b) Host-only documents writing with `PUT /files/content`: no author on disk, a guest exec per write (E-04's control). (c) OT (ShareDB-style): needs one sequencer, which contradicts a two-peer authority split and offline resend. (d) Automerge or Loro: a second CRDT beside the wiki's Yjs, no CodeMirror binding of `y-codemirror.next`'s maturity, and no Go FFI we already own. (e) Merge on save (diff-match-patch): M-02 rejects it. (f) Peer-to-peer WebRTC: no authority, no disk, no agent.

## 4. Attribution and change tracking

Every write gets an author by one of three doors, in order of exactness:

| Door | Who | Actor | How |
| --- | --- | --- | --- |
| `write_file(path, base, content, actor)` over the host connection | app commands (`file.restore`, `file.restore-deleted`), the mirror's document saves, flow steps | the host authorizer's `principal` blob (ADR 0004 `Actor`) | the daemon performs the write under the lock, records the actor with path and post-digest, and never re-attributes its own inotify event |
| `write_file` on `/run/smithers/machined.sock` | the coding agent's std tools (`smithers-machined client write-file`) | `run`, resolved from `SO_PEERCRED` uid `agent` + cgroup → `register_run` | same; a request carrying an actor field is `unknown_field` and writes nothing |
| inotify burst | terminals, SSH editors, formatters, the agent's `bash`, hand-run git/jj | the only session whose cgroup burned CPU during the burst, else `outside` | `crates/smithers-machined/src/attrib.rs` reads `cpu.stat usage_usec` per session cgroup |

Grouping (`src/burst.rs`, landed): one burst per key; all outside writes share one key; close after 1.5 s quiet, 10 s after open, or before a write with another key touches a file the burst touched. Each path keeps a recorded version blob; a burst keeps per-file `before` and `after`; on close the daemon writes one parentless versions commit (`a/<path>`, `b/<path>`) and emits `burst{burst_id, actor, files[{path, change, renamed_to?, before_blob?, after_blob?, post_digest?}], versions_commit}` through the outbox, objects first as a git bundle on an object stream. The host (`internal/machined/events.go`, planned) verifies objects, inserts one `product_job_events` change entry, N `burst_files` rows and the receipt in one transaction, publishes `refs/smithers/branches/<id>/bursts/<burst>`, then acks. The card reads "Maya via SSH changed 12 files" and opens `before → after` per file, from the host store, so it works while the branch sleeps. `file_written{path, actor, post_digest}` hints skip the outbox and reload open cards within 1 s. `moved_off{by}` fires from the metadata watches (`.jj/repo/op_heads/heads/`, `.git/HEAD`, `.git/refs/`) when `@` leaves the item change; Return to Tn runs `jj edit` under the freeze sequence.

Recovery: **Restore this file** writes the burst's `before` through `write_file` with `base = that burst's post_digest`; a `409 stale` opens Compare instead. **Restore** (deleted) uses base `absent`; **Follow** reopens at the renamed path. The coding agent gets a system note before its next tool call naming who changed which files (T-COL-12) and must re-read before writing (`stale_read`).

Position on fanotify: stay deferred. Session attribution misreads only when two sessions are busy at once; C-J3-06 with VS Code's server active plus a teammate's command measures how often, and that number, not a guess, decides whether kernel attribution is worth a root-side watcher.

## 5. Sessions, identity and terminals

- **Identity.** `collaborators.unix_uid` from 20000 and `unix_login` (migration `0121_member_unix_login.sql`, landed: sanitized `[a-z0-9_-]{1,32}`, reserves `root`, `agent`, `machined`). `agent` is 19999, `machined` 19998, group `team` 20000. `/workspace` is `root:team`, setgid, `g+rwX`; every session has `umask 002`. The image has no sudo, su, setuid or capabilities; the layer key includes the identity-policy version so uid-1500 layers rebuild once.
- **Homes.** `/home/<login>` on the machine's own disk, 0700, created by the guest helper at first session, kept across sleep, never shared (spike T-MCH-02 lost data on a shared virtiofs home). Tool logins persist per machine; nothing copies tokens.
- **Sessions.** Only the root broker spawns: `open_session(user{login, uid}, kind pty|exec|sftp, argv?, size?)`, `tcp_connect(port)`, `close_session`, `kill_sessions(user|run)`, `register_run`, `attach_session(id, received)`. The broker checks the login/uid pair against the machine's passwd before spawning, places each process in its own cgroup, and the stream protocol (`data`, `eof`, `resize`, `signal`, `exit`, `window` 256 KiB credit, `close`) is the ADR 0004 `0x05` kind. Go side: `internal/machined/sessions.go` (landed) is the one client; the terminal manager, the SSH gateway and the agent's `bash` all open sessions through it.
- **Terminals.** `POST /api/terminals` makes a `person` admission request, then `open_session(member, pty)`. The existing `TerminalSessionManager` keeps fan-out, 512 KiB ring replay and reconnect; binary input from any attachment whose authenticated member is not the owner is dropped and counted. Terminals keep their own WebSocket. The agent's `bash` runs in one PTY per run opened on the local socket, owner "Agent", watch-only, so its commands render in the same Terminal card.
- **SSH.** The host gateway (`packages/backend/ssh/ssh.go`, `internal/ssh/channels.go`, landed with `direct-tcpip` and branch-name resolution) listens on `127.0.0.1:2222` plus the owner's bind address; username = branch slug; keys = the member's GitHub keys plus `smthrs ssh-key`; shell/exec → `open_session(pty|exec)`, `subsystem sftp` → `open_session(sftp)`, `direct-tcpip` → `tcp_connect` (guest loopback only); agent and remote forwarding refused. Saves from VS Code/Cursor land as outside bursts attributed to that SSH session. Credentials for `smthrs` inside a session: `/run/smithers/<uid>/token/sessions/<id>/token`, delegated only; the person bearer never enters the guest.
- **Revocation in 5 s.** One transaction commits member state and credential revocations and publishes on the revocation bus; the live hub closes the member's sockets, the chat runner cancels their queued turns and aborts the running one, the terminal manager detaches them, and the host calls `kill_sessions(user)` on every awake branch; the broker writes `cgroup.kill` and replies only at `populated 0`. Recovery polls at 1 s so a lost NOTIFY still lands inside 5 s.

## 6. Presence and live updates

Transport: one WebSocket per tab at `/api/live` (`internal/routes/live.go` + `internal/live/{hub,conn}.go`, landed), text frames `sub/unsub/snap/delta/gap/err/saved`, binary `[kind u8][sub id u32][payload]` with kind 1 sync and 2 awareness. One addition, a client→server text frame bound to the socket's authenticated identity:

```
{"t":"presence","where":{"file":{"path":"retry.ts","line":12}}}        // or {"terminal":"t7"} | {"step":"s3"} | {"branch":true}
```

Topics and their sources are spec §7.2; the ones this design touches:

| Topic | Snapshot | Delta source |
| --- | --- | --- |
| `branch:<id>` | machine `{state, wait_position?}`, `presence[]`, `terminals[]`, item and place | runtime facts, presence lease table, terminal manager |
| `branch:<id>:activity` | last 200 entries | `product_job_events` cursor |
| `branch:<id>:files` | changed files vs base, per-file last writer, per open document `{path, saved_digest, saved_at, editors[{actor, line}], outside_change?}` | `burst_files`, `file_written` hints, document host |
| `doc:code:<branch>:<path>`, `doc:wiki:<page>` | Yjs sync step 1/2 + `epoch` | document host |
| `conversation:<branch>` | shared entries | `chat_turns` cursor |

Presence row: `{participant: {id, kind: person|smithers|coding|claude-code|codex|reviewer, for_member?}, session, via: app|ssh|terminal|cli, where, watching?, since}`. Sources: browsers every 10 s and on every move; the daemon's `presence Snapshot{sessions[{session, path?}]}` on change (≤ 4/s) and every 10 s, mapped by the host to participants; the runtime for coding and reviewer runs and the host turn runner for app-agent turns every 10 s while working. Leases are 30 s; a clean socket close, SSH close or revocation removes the row at once. `PresenceOn(branch)` answers `unknown` for 30 s after host start and callers (safe-idle release, presence-aware rebase) treat `unknown` as present.

Position: implement the lease table in Go inside `internal/live/presence.go`, not through the runtime bridge into `@smthrs/sync/BranchPresence.ts`. Every consumer is Go (the hub, the admission scheduler, the rebase policy, the SSH gateway) and `conn.go` already has `PresenceSession`; a cross-process RPC per heartbeat buys nothing. Delete the TS roster if `rg` finds no non-install consumer; never keep both.

Reconnect: the client backs off 250 ms to 5 s with jitter and resubscribes with its last cursor per projection topic; a cursor past retention or a 2 MiB overflow yields `gap`, the client resubscribes without a cursor and gets a fresh `snap`, never a partial replay. Presence needs no cursor; the snapshot is the roster. Documents restart at sync step 1 and resend uncovered updates. Scale: a branch has at most a team's tabs (tens), one socket each; presence costs ≤ 4 deltas/s per branch; document fan-out is one update per keystroke per subscriber, which the host handles in memory; the per-connection 2 MiB budget bounds a slow tab without hurting its neighbours.

## 7. Shared conversation

Storage is landed: `chat_turns.conversation_id` with the ordering index and the partial unique index allowing one `running` turn per conversation (`0120_branch_conversations.sql`), routes `GET /api/conversations/{b}`, `POST …/prompt`, `…/turns/{id}/stop`, `PATCH/DELETE …/turns/{id}`, `GET/PUT …/view-state` (`internal/chat/http.go`), and `Store.Claim` takes the oldest queued turn under an advisory lock keyed `conversation:<branch>`. What this design fixes:

- **Ordering.** Entries are the existing turn/batch replay cursor; shared output is append-only. A queued prompt is private to its author on `view:<member>:<branch>` and becomes a shared entry only when its turn starts.
- **Who runs which turn.** The host turn runner (`chat.Dispatcher`), never the browser. At claim it re-checks the author is an active member, mints `delegated(via=smithers)` for the author, runs the model and every command through the catalog's command→API mapping with `Smithers-Via: smithers`, and revokes the credential at end. A `confirm` row posts a private Confirm card; `never` rows are absent from the tool list; approve and merge are impossible from a turn.
- **Privacy.** `SharedEntries(conversation)` is the only read for turns and preflight: started turns and their outputs, excluding queued prompts, approvals and browser Drafts. Turn credentials cannot read `view:*` or `confirmations:*`.
- **Revocation.** The runner subscribes to the revocation bus: queued turns of a removed member become `cancelled(author_revoked)`, the running one is aborted and its credential revoked within 5 s; the next queued turn starts.
- **How the agent sees context.** The app agent runs a preflight on the fast model over the prompt, author, branch state, and the titles and summaries of recent shared entries, choosing files, wiki revisions, TODOs and runs within a 24k-token budget; only those, the prompt and the last three entries' text reach the answer model, and the chosen list is stored on the entry. The coding agent sees the branch through its run: steers and answers as durable signals, and outside-change notes inserted before its next tool call.
- **External agents.** Claude Code or Codex in a member's terminal is imported read-only into the same conversation from its transcript (daemon event variant 5, `conversation:<branch>` deltas), attributed "Claude Code for Ben"; imported text never runs commands.
- Delete `app_timelines` (`services/app_timeline.go`, `db/app_timelines.sql.go`, its routes) in the shell cutover; keep legacy per-member conversations readable under Earlier.

## 8. Failure and durability

| Event | What happens | Never lost |
| --- | --- | --- |
| Machine sleeps | final `capture()`: flush documents, close bursts, `jj util snapshot`, bundle objects, drain the outbox; the VM stops only when the outbox is empty; disk kept | every save and burst end state |
| Machine wakes | host sends its head's objects, calls `wake_reconcile(head)`; `moved` or `conflict` is emitted as an event, never only as the reply; sessions start only after `ready` | work captured before sleep; a conflict becomes Needs you |
| Daemon crash | broker kills every session cgroup, restarts the daemon with backoff; outbox replays from the lowest unacked seq; each open document reloads its state record and reconciles the file (as saved / finish an interrupted swap / outside write while down); terminals end; the mirror reopens the stream and resyncs | every `saved`-acknowledged keystroke, every acked event; unacked typing stays in browsers' recovery buffers |
| VM crash (K6) | same as daemon crash plus `wake_reconcile`; a replayed `captured` whose `base` differs from the head the host last sent gets `stale_base` and does not move the head | acked bytes and receipts; nothing applied twice (receipt `(branch, event_id)`) |
| Daemon ↔ host link drops | sessions keep running for 30 s stalled by credit; reconnect re-attaches by `attach_session(id, received)`; the mirror keeps serving browsers (cards show "Saving…"), buffers coalesced updates, and resumes sync step 1 on reconnect; outbox resends | nothing; latency only |
| Browser drops | resubscribe with cursors; `gap` → fresh snapshot; documents resend uncovered updates; a changed epoch keeps them as `unsaved` with Reapply/Copy | the member's typing |
| Host restart | mirror rebuilt from each daemon before answering; presence unknown 30 s (no release); terminals end; chat leases and credentials recovered before a new turn is admitted; daemons keep running and replay outboxes after the handshake | everything durable on machine disk or in PostgreSQL |
| Rebase while people type | under the lock: freeze the sessions cgroup (≤ 1 s, else `busy{session}` and "Waiting for a write in Ben's terminal"), drain inotify, close bursts, local capture (pinned and queued, not awaited), `jj rebase`, reconcile each open document from disk as one transaction "Rebased onto Tk" keeping unsaved typing, thaw; browsers keep typing into the mirror, only saves wait; queued `write_file`s revalidate and stale ones get `409` | no writer's bytes; every pre-rebase state is in a versions commit or the capture |
| Outside save on a file people type in | watcher or displaced-file path, whichever first; no overlap merges, overlap keeps the document on disk and the outside bytes as the burst's `after`, flagged Compare | the outside bytes; the typists' characters |
| Member removed mid-everything | one transaction; sockets, turns, terminals, SSH, sessions and run credentials gone within 5 s; their TODOs keep history; a stale `workspace_shares` grant never authorizes a write (recheck at the mutation boundary) | the branch, its machine, other members' work |

Durability rules: an event is acknowledged only after the host commits objects, row and receipt in one transaction; `saved` is sent only after the record and the file are fsync'd; the host moves a head ref only to a commit it holds; every object a queued event names is pinned by `refs/smithers/pending/<event_id>` and `syncfs`'d before the entry is written.

## 9. Reuse map

| Piece | Class | Paths |
| --- | --- | --- |
| Wire codec, golden frames | keep | `packages/backend/internal/machined/wire/*`, `crates/smithers-machined/src/{conn,msg}.rs`, `internal/compose/testdata/cocontracts/` |
| Daemon components | keep, compose | `crates/smithers-machined/src/{hooks,lock,rpc,stream,credit,outbox_store,watch,ignore,attrib,burst,versions,events,resync,session}.rs`, `src/broker/{cgroups,sessions}.rs`, `src/doc/*` (696-line host, merge, reconcile, state, authors, gone, disk), tests `documents.rs` (786), `versions.rs` (863), `watch.rs` |
| Daemon processes | new (machined.md §2, §4–7) | `src/{main,daemon,link,broker,brokerproto,confine,files,local,client,capture,objects,reconcile,freeze,oplog,jj,wiring}.rs`; `main.rs` today exits 78 "core not composed" |
| Host registry, session client | keep, extend | `internal/machined/{registry,sessions}.go`; new `link.go` (LinkSource over `microsandbox/transport.go:67,126`), `events.go` (ingest), `capture.go`; new `microsandbox/machined.go` (plant + init entry) |
| Head reporter | delete | `services/workspace_head.go:52–171,601–697`, route `POST …/workspaces/{id}/head`, its tests; `capture` replaces it |
| Guest helper `fs read/write`, `msb exec -t` terminal ownership | delete at cutover | `microsandbox/guest/smithers-guest.py` fs subcommands, `microsandbox/exec.go:599–645`, `routes/workspace_runtime_terminal.go`, `pipeWSToSSH` |
| File write route | reshape | `services/workspace_facets.go:244` `WriteWorkspaceFile` → daemon `write_file` with `base_digest` (landed for S1 guest path); `PUT …/files/content` stays the one non-document write door |
| Live channel | keep, extend | `routes/live.go`, `internal/live/{hub,conn}.go`, `apps/app/src/mainview/runtime/LiveChannel.ts`, `packages/rpc/src/LiveDoc.ts`; add `presence` frame to `packages/rpc/src/Live.ts` (absent) |
| Document relay | reshape into mirror | `internal/live/docrelay.go` (topic parse, admission, actor envelope) + new `codedoc.go` (Yrs mirror over the FFI binding in `internal/repohostserver/wiki_document.go`); one document host serves `doc:code:*` and `doc:wiki:*` |
| Wiki collaboration | reshape | `services/wiki_collaboration.go` keeps the revision-checked write; `routes/wiki_collaboration.go` keeps only `GET …/document` if a reader remains; migration `0126_wiki_live_cutover.sql` landed; delete `state/controller/cloud-wiki.ts` POST queue in favour of `LiveDocProvider` |
| Browser provider and binding | keep | `runtime/LiveDocProvider.ts`, `cards/liveDoc.ts`, `cards/liveAttribution.ts`, `packages/smithers/ui` code-editor adapter, `y-codemirror.next` 0.3.6 |
| File and Diff cards | reshape | `cards/FileCards.tsx` + `CodeSurface.tsx` → `CodeEditorView` for every file; delete `CodeFileView` rendering in the same commit |
| Presence | new Go, delete TS use | `internal/live/presence.go` (lease table, coalescer); `@smthrs/sync/BranchPresence.ts` deleted if no other consumer; schema reuse `packages/rpc/src/BranchCard.ts:46` |
| Terminals | keep, reshape dialer | `routes/terminal_session_manager.go` (owner gate at `:755`, `:570`), `routes/workspace_terminal.go:402` → `machined/sessions.go`; `state/CloudTerminalClient.ts` unchanged |
| SSH gateway | keep, reshape bridge | `packages/backend/ssh/ssh.go`, `internal/ssh/{server,channels,workspace_access,revocation}.go`; new `services/branch_ssh_bridge.go` mapping channels to sessions; `config.go:503` default `127.0.0.1:2222` |
| Identity and homes | reshape | `microsandbox/runtime.go:50–51,587` (uid 19999, team, machined), `guest/smithers-guest.py:475 setup`, `layers.go:351,517`; delete root/developer SSH users in `services/workspace_ssh.go:24–38` |
| One machine per branch | reshape | `0095` key without `user_id`, `workspace_provisioning.go` paths, `workspace_agent.go` attach; restore `ensureWorkspaceShare`/`revokeWorkspaceShare` from `a73a77de36` |
| Admission | reshape | `microsandbox/runtime.go:643 admitRunningLocked`, `capacity.go`, `CapacityError`; delete the 1800 s idle sweep for branch machines |
| Conversation | keep, cut over | `internal/chat/{store,dispatcher,http,queue,shared_context}.go`, `0120`; delete `services/app_timeline.go`, `db/app_timelines.sql.go`, browser tool loop `state/controller/turns.ts:603–618`, `/api/agent/turn*` write routes |
| LSP | reshape transport | `state/CloudLspClient.ts` over a daemon `exec` session per (member, language) |
| Spikes | keep as benchmark method | `scripts/spikes/col-01/` (rerun on the reference host), `scripts/spikes/trm-06/` (currently refuses to run: "INCOMPLETE; activation refused") |

Net new, with the reason reuse fails: the daemon process layer (no surviving guest daemon), the Go ingest and link (the reporter is connectionless), the Go presence lease table (the TS one lives in the wrong process), `codedoc.go` (the relay has no document engine), `branch_ssh_bridge.go` (the existing bridge forwards to a private sshd that no longer exists), `burst_files` and `machine_event_receipts` migrations (job events cannot index per-file versions or dedupe by event id).

## 10. Build plan

Interfaces first (days 1–2, four agents in parallel, each one day): **I1** ADR 0003 topology section = mirror, plus the ADR 0004 S3 note that the mirror topology opens one document stream per document with actor `principal(host)`; protocol stays 1 because no byte changes. **I2** `packages/rpc/src/Live.ts`: `presence` frame, `branch:<id>` presence row, `branch:<id>:files` document fields; golden fixtures. **I3** Go `machined.Client` interface (read, write, capture, wake, open/close doc, sessions, `LinkSource`) with a fake (`machinedfake`, `testfake/peer.go` exist). **I4** `src/wiring.rs` and `hooks.rs` stubs so every Rust lane compiles against `unsupported` defaults. After that, every item below builds against those four and lands dark behind a fail-closed gate.

| # | Item (agent-days) | Depends | Proof: unit / integration (real PostgreSQL) / e2e browser / real machine |
| --- | --- | --- | --- |
| B1 | Daemon processes: broker, daemon lifecycle, link + handshake, confine, files, local socket, `client` subcommand (4) | I3, I4 | `tests/{broker,link,confinement,write_file,local}.rs`; fake host replays `seq_handshake`, `seq_write_stale`; real microVM: `TestMachinedProductionBoundaryFailClosed` |
| B2 | Outbox send path, bundles, capture, wake_reconcile, freeze, oplog (4) | I4 | `tests/{outbox,capture,reconcile,barrier,oplog}.rs`; K3/K3b/K4/K4b/K5a–c fault runs ×10 |
| B3 | Host link, registry wiring, per-boot credentials, planting, ingest + receipts, capture publish; delete the head reporter (4) | I3, B1, B2 | `registry_integration_test.go` (cross-branch credential refused, newer boot replaces, duplicate event = one row); `TestMachinedCaptureDispatchDurability`; real machine K6 |
| B4 | One machine per branch: 0095 key, canonical provisioning, shares restore, erasure safety, `GET /api/branches` (3) | — | `TestBranchMachineConcurrentJoin` (60 concurrent requests → 1 row, 1 VM), migration test, `TestBranchMachineRevocation`; real machine C-MCH-01 |
| B5 | Identity, team group, no-sudo image, per-machine homes (3) | — | `real_users_test.go` (no setuid, `EACCES` on homes, team write), C-MCH-09/10 soak across sleep |
| B6 | Watcher integration: register_run, burst ingest, `burst_files` migration, Restore (3) | B3, B5 | `TestBurstIngestProductionBoundary`, C-COL-05 matrix (overlap, actor switch, drain, overflow, metadata); C-PERF-04 script |
| B7 | Sessions supervisor end to end: spawn as uid, cgroups, stream frames, kill, attach, local-socket pty (3) | B1, B5 | `tests/sessions.rs` (exit 7, TERM, 1 MiB half-close, 1 GiB stalled reader, nohup lingers then dies at kill, 10 s reattach); `TestSessionAdmissionFailsClosed`; real machine `pgrep -u` empty ≤ 5 s |
| B8 | Terminals on sessions: owner-only input, watchers, agent terminal, LSP exec session (2) | B7 | manager unit (1,000 watcher frames → 0 stdin bytes); `terminal_owner_integration_test.go`; e2e C-J3-02, C-J3-10 |
| B9 | SSH gateway on sessions: branch logins, sftp, direct-tcpip, bind rule, revocation (3) | B7 | `workspace_access_test.go`; `TestSSHProductionAuthorizationAndForwarding`; real machine VS Code Remote connect, edit, save, forward; removal ≤ 5 s |
| B10 | Presence lease table in Go, heartbeats from browser/daemon/runs, coalescer, 30 s unknown window, visit audit (2) | I2 | fake-clock expiry at 30.0 s not 29.9; `TestPresenceDeltaCoalescing` (100 moves/s → ≤ 4 deltas/s); e2e C-J3-01 |
| B11 | Admission scheduler: slots to confirmed stop, people-first FIFO, safe-idle release reading presence/sessions/bursts/flush (3) | B4, B10 | C-MCH-02 and C-MCH-11 matrices through `POST /api/terminals`; restart reconciliation fault; C-PERF-05 warm wake |
| B12 | Host document host: `codedoc.go` over the FFI core, serving `doc:code` (daemon peer, 50 ms coalesce, saved/epoch relay, rebuild on restart) and `doc:wiki` (2 s/10 s persist); delete wiki POST queue (4) | I1, I2, B3 | `TestDocRelayWireContract`, `TestDocRelayAuthorization` (foreign client id, forged authors map, revocation ≤ 5 s), `TestDocRelayMirrorRecovery`, K8; FFI fuzz at the boundary |
| B13 | Daemon documents wired: `Documents` hook on the lock, flush in capture, reconcile in freeze, own-write exclusion, gone states (3) | B2, B6, B12 | rerun `documents.rs` on the real stack; ordering test with `SMITHERS_MACHINED_WATCH_DELAY_MS=2000` ×40; K7a–K7e |
| B14 | File card live mode: provider on the real channel, `CodeEditorView` for every file, Compare/Restore/Follow/Reapply, author colours and gutter flags (3) | B12, B13 | `LiveDocProvider.test.ts`, `liveDoc.test.ts`, `co-edit.spec.ts` on the fake relay; e2e `file-coedit.spec.ts` (C-J3-04) from a second Mac; C-PERF-03 ×200 |
| B15 | Conversation cutover: host tool loop, composer → `/prompt`, private queue, revocation, delete `app_timelines` and browser executor (3) | — | `TestBranchConversationOrderedReplay`, `TestHostTurnAuthorRevocation` (≤ 5 s), `TestHostTurnPrivateContext` (canary never in a model request); e2e turn survives closing the tab |
| B16 | Moved-off detection, Return to Tn, Keep for now; agent note on outside change (2) | B6, B2 | `moved_off.rs` predicate table; `moved_off_integration_test.go` (two Returns race → one 409); e2e C-J3-09, C-J3-03 |
| B17 | Fault suite and perf scripts as `smthrs test` targets: K1–K8, C-PERF-02..06, `scripts/perf/{keystroke,disk-write}.mjs` (2) | B3, B13 | artifacts under `.artifacts/checks/` and `.artifacts/perf/` with host profile |
| B18 | Spike rerun on the idle reference host with browsers on a second Mac, both transports, guest idle and busy (1) | — | C-SPK-03, C-SPK-07 raw samples; decides the boot file's `topology` and tests risk R1 |

Critical path: I1–I4 → B1/B2 → B3 → B6/B7 → B13 → B14, about 18 agent-days serial, with B4, B5, B10, B12, B15 off the path. The first tracer bullet to demand: Ben and Alice in two browsers on a second Mac, one real microVM, Ben's terminal `echo` reloads Alice's File card attributed "Ben's terminal" within 1 s (B1, B3, B5, B6, B7, B8 only). Co-editing (B12–B14) widens that path; nothing in it waits on a product decision.

## 11. Risks and open questions

| # | Risk or question | Falsify cheaply | If it holds |
| --- | --- | --- | --- |
| R1 | The mirror is unnecessary complexity: on the idle reference host, relay-only fan-out might meet 1 s | B18: rerun C-SPK-07 with every guest vCPU busy and browsers on a second Mac; if daemon-only p95 < 500 ms under load, delete `codedoc.go` for code and keep the daemon as the only peer | keep the mirror; its second use (wiki) stays either way |
| R2 | Per-character authorship reads `Y.Text` item client ids, a private Yjs API | pin `yjs` 13.6.32 and keep `liveAttribution` tests; a failing upgrade switches to text attributes | record authors as attributes in the same core |
| R3 | Session attribution reads "changed outside Smithers" too often (VS Code's server keeps its session busy) | C-J3-06 with a second member running a command; count ambiguous bursts per hour of dogfood | revisit fanotify (`tickets/deferred/T-MCH-03.md`) |
| R4 | `renameat2(RENAME_EXCHANGE)` or `openat2` fails on the guest working-copy filesystem | the four kernel probes in B18 (yes/no each) | `RENAME_NOREPLACE` + rename fallback with the displaced-file check moved before the swap; smithers-3f review |
| R5 | `cgroup.freeze` cannot reach `frozen 1` within 1 s while a session is in uninterruptible I/O, so rebases stay pending | C-COL-03 step 4 under `pnpm install`; measure timeout rate | lengthen to 2 s and show the blocking session; never rewrite unfrozen |
| R6 | A shared working copy with several uids breaks jj/git (lock files, `safe.directory`) | alternate `jj st`, `git status`, `pnpm install` as Ben, Alice and agent ×100 in B5 | system gitconfig `safe.directory=/workspace`, setgid dirs, umask 002 |
| R7 | A panic in the Rust Yrs core through FFI kills the whole host process | fuzz `document_core` decode/apply at the Go boundary; `catch_unwind` in the FFI shims | run the document host in a child process with the same interface |
| R8 | Disk growth: state records + versions commits + captures | B18 growth run, 1,000 captures; 14-day projection < 2 GiB per machine | shorten op-log retention; prune state records of closed documents after capture |
| R9 | Host memory from open documents (N docs × ≤ 1 MiB × 2 copies) | count open docs on the dogfood install; close after 60 s idle | cap open documents per branch; refuse beyond it with "too many open files" |
| R10 | One running turn per conversation makes Alice wait behind Ben's 60 s turn | measure queue wait in the dogfood scorecard | product decides parallel turns per author; the unique index already keys per conversation |
| R11 | The TRM-06 spike never ran ("activation refused"), so the §9.6 session protocol has no VS Code evidence | B9's real-machine step is the spike; do it first in B9 | if VS Code needs a channel the protocol lacks, add the frame to §9.6 before B8/B9 land |
| R12 | Two outside writers (formatter + SSH save) inside one 1.5 s window share one burst key and so one actor decision | C-COL-05 steps 1–3 already cover switches; add two concurrent outside sessions | spec behaviour: `outside`; the versions commit still holds both end states |

One action: land I1–I4 this week and start B1, B2, B4, B5, B10, B12 and B15 in parallel against them; everything else waits on nothing but code.
