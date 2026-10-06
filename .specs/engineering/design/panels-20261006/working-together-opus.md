# Working together on one branch: Opus design

Claude Opus, design panel, 2026-10-06. Code facts were checked at `origin/frontrun` `f98e01d6`; paths are relative to the repository root.

## 1. Summary

1. Each awake branch has one machine. Its disk holds the only working copy, and `smithers-machined` is the only process that writes it for Smithers and the only process that observes it, so people, terminals, SSH editors and the coding agent all work in one copy.
2. Every live document, code or wiki, has exactly one Yjs replica on the install: a Yrs document in the host process, reached by browsers over `/api/live`. A keystroke never crosses the VM boundary on its way to another person.
3. The machine stays the disk authority. The host saves each open document with one daemon call, `save_doc`, which writes an opaque state record and the text, never rolls back, and returns any bytes it displaced, so an outside save is merged or kept, never lost.
4. Every write gets an actor. Writes through Smithers (File card characters, the agent's write tool, app commands) are exact. Terminal, SSH and formatter writes are bursts attributed to one person from session activity, with a measured gate that switches to fanotify if the heuristic fails J3.
5. Everyone on a branch shares one conversation whose turns run on the host, one at a time, under each author's delegated credential, and removing a member ends everything they hold within 5 s.

## 2. Abstractions

```
 browser tabs ──/api/live──┐      terminal WS ──┐     SSH :2222 ──┐
                           ▼                    ▼                 ▼
 ┌───────────────── host process (Go, one per install) ─────────────────────┐
 │ live hub · doc hub (Yrs replicas) · presence leases · write service      │
 │ chat runner · terminal manager · SSH gateway · machine registry          │
 └──┬─────────────────────┬──────────────────────────┬──────────────────────┘
 PostgreSQL          host repo store            one ADR 0004 link per machine
 (roster, activity,  (captured heads,                │
  turns, wiki docs,   burst versions,                ▼
  receipts)           doc-period blobs)   ┌──── microVM: one per awake branch ───┐
                                          │ machined: lock, files, watcher,      │
                                          │ bursts, outbox, doc records          │
                                          │ broker: sessions as member uids      │
                                          │ /workspace (jj + git)                │
                                          └──────────────────────────────────────┘
```

| Object | Only writer | Source of truth, and where it lives |
| --- | --- | --- |
| Branch (`workspaces`, key without `user_id` since `0108_branch_machines.sql`) | Stack service (history), machine service (lifecycle) | Host PostgreSQL; history in host store refs |
| Machine (one per branch) | Admission scheduler | Host memory, reconciled from `msb` at start; disk on the host volume |
| Member access | Maintainers | Active `collaborators` row in PostgreSQL. Branch access derives from it (§11 Q5) |
| Session | Broker | Its cgroup, in daemon memory; the host mirrors it for streaming |
| File | Daemon for Smithers; anyone outside | Machine disk while awake; last captured head in the host store while asleep |
| Document | Doc hub | Replica in host memory. Durable: a record on the machine disk (code) or `wiki_page_revisions.crdt_state` (wiki) |
| Change (write, burst, doc period) | Write service, daemon, doc hub | `product_job_events` + `burst_files` in PostgreSQL; versions in the host store |
| Presence | Live hub | 30 s leases in host memory |
| Conversation | Chat runner | `chat_turns`, `chat_turn_batches` in PostgreSQL |
| View state | That member | `collaborators.view_state` |
| Unsaved edits | Browser | Yjs updates no `saved` covers, in tab memory |

Three rules keep this small. One writer per fact. The host never reads the working copy itself; it asks the daemon. The daemon runs no CRDT; it stores records it does not interpret, which removes `yrs` from the guest binary.

## 3. Co-editing model

### 3.1 Choice

Yjs on the wire: `yjs` 13.6.32 and `y-codemirror.next` 0.3.6 in browsers (already in `apps/app/package.json`), Yrs 0.27.4 on the host through `smithers-ffi`, which the backend already loads. A doc hub in the host process holds one replica per open document. One browser provider, `apps/app/src/mainview/runtime/LiveDocProvider.ts`, serves both kinds. The two persistence adapters differ only in where durable state goes: code saves through the daemon to the machine disk, wiki pages to `wiki_page_revisions` as today. Today neither is live: `0127_wiki_live_cutover.sql` retired the wiki's POST and SSE path, and no production code assigns `DocumentRelay`, so the wiki editor is read-only.

### 3.2 Paths

```
 Alice ─update─▶ host doc ─update─▶ Bob, Maya's File card            no VM hop
                    │  200 ms after the last update; at most 600 ms apart while typing
                    ▼
     save_doc(path, base, text, record) ───▶ machined: record, then text, fsync
                    ◀─── saved{post_digest, displaced?} | moved{digest, bytes}
                    ▼
     saved{sv} ───▶ browsers: "Saved to the machine"

 Maya's Cursor saves retry.ts ─inotify─▶ machined ─file_written{bytes}─▶ host doc: three-way merge
 Agent write tool ─PUT files/content (run credential)─▶ write service ─▶ doc txn + save, or daemon write_file
```

### 3.3 Messages

Host to daemon on the ADR 0004 control stream. `open_doc` and `close_doc` exist (`crates/smithers-machined/src/rpc.rs:30`) and change payloads; `save_doc` is new; `file_written` gains a field.

```
open_doc{path} → {disk: {digest, bytes} | absent | too_large | binary,
                  record?: {epoch: [16]u8, state: bytes, text, digest, prev_digest}}
save_doc{path, base: digest | "absent", text, record}
      → saved{post_digest, displaced?: {digest, bytes}}
      | moved{digest, bytes}                       disk ≠ base; nothing written
close_doc{path} → {}
hint  file_written{path, actor, post_digest, bytes?}   bytes only for open paths, ≤ 1 MiB
```

Browser frames stay as fixed in `packages/backend/internal/compose/testdata/cocontracts/doc-browser.json`: `snap{epoch, client_id}`, binary kinds 1 (sync) and 2 (awareness `{actor, colour, line}`), `saved{sv}`, `gone`.

### 3.4 Lifecycle

- **Open.** The first authorized subscriber makes the hub call `open_doc`. No record: seed from the bytes, new epoch. Record digest equals disk: load. Record `prev_digest` equals disk: a save stopped before its swap; load and save again. Otherwise load, then merge the disk bytes as an outside write against the record's text. Each subscriber gets a client id in `Y.Map("authors")`; the hub refuses updates carrying structs for any other client id, so colours cannot be forged.
- **Save.** The daemon reuses `crates/smithers-machined/src/doc/disk/linux.rs`: record via temp, `fsync`, `rename`; text via temp, `fsync`, `renameat2(RENAME_EXCHANGE)`; directory `fsync`. If the disk digest differs from `base` before writing, it writes nothing and answers `moved` with the current bytes. A displaced file whose digest is `base` keeps its temp name for 2 s before deletion, so an in-place writer that opened the file before the swap is still caught. A displaced file with any other digest returns as `displaced`. The host merges `moved` or `displaced` bytes as an outside write and saves again.
- **Outside write on an open path.** After `IN_CLOSE_WRITE` or `IN_MOVED_TO`, `file_written` carries the bytes. The hub merges three ways (base = last saved text, ours = document, theirs = bytes) with `doc/merge.rs` moved to the host. No overlap: one transaction under the burst actor's client id. Overlap: the document wins on disk, non-overlapping hunks apply, and the file shows "Changed outside Smithers · Compare" against the burst's `after` version. Merges are idempotent by digest.
- **Writes through Smithers.** One route, the existing `PUT .../workspaces/{id}/files/content`, which already requires `base_digest` and takes a `changes` batch (`packages/backend/internal/routes/workspace.go:469`). The write service compares every base first: open paths against the document text under the branch's hub lock, closed paths in the daemon's `write_file` compare phase. Any mismatch returns `409 stale{path, current_digest, current_text}` and writes nothing; the agent's edit tool re-applies its edit to the current text. Then open paths apply as document transactions under the writer's client id and save at once, and closed paths swap. The reply waits for the disk, so the agent's next `pnpm test` reads its own write.
- **Delete, rename, close.** `gone{deleted}` with Restore and `gone{renamed, to}` with Follow, as spec §9.2.6. A document closes 60 s after its last subscriber, after a final save; its record stays on disk, so authors survive reopening.

### 3.5 Writes never roll back

ADR 0003 (`docs/architecture/0003-live-code-co-editing.md`) found that spec §9.4.1's exchange-and-rollback loses an outside save landing during the rollback, and proposes freezing every session around each write. I reject a freeze per write: it stalls every terminal and VS Code server on each agent write, times out on uninterruptible I/O, and by the ADR's own account misses kernel I/O already in flight.

Rule: compare everything, then swap, and never swap back. A stale-based write can apply only if an outside save lands in the compare-to-swap window, about 1 ms. Those bytes are the displaced file: they become the burst's version, the file shows Compare, and the writer gets `raced: [path]`. The freeze stays where spec §9.4.2 puts it, around rebase and Return to Tn. This narrows E-16 to "a stale write applies only when concurrent within the swap window, and both versions are kept" (§11 Q1).

### 3.6 Undo and recovery

- Editor undo tracks only the local origin, so it never removes someone else's characters.
- **Restore this file** writes a burst's `before` version through the write route with base = the burst's `post_digest`; a stale base opens Compare.
- The hub writes one entry per editor per 2 s idle period ("Alice edited `retry.ts`") with before and after blobs stored directly in the host repository store.
- Browsers resend every update no `saved` covers. An epoch change shows "N edits weren't saved" with Reapply and Copy (already built in `LiveDocProvider.ts`).
- Any capture that leaves the machine (candidate, fork, sleep) is host-initiated and flushes open documents first.

### 3.7 Latency

| Path | Route | Expected p95 | Budget |
| --- | --- | --- | --- |
| Keystroke to another browser | browser → host → browser on the LAN | under 100 ms | 1 s |
| Keystroke to disk | at most 600 ms apart, one link round trip (197 ms worst measured), `fsync` | under 850 ms | 1 s |
| Outside save to open card | inotify, link, merge, fan-out | under 400 ms | 1 s |

The spike's 1,738 ms is keystrokes at 30 Hz through the VM; here no keystroke takes that path, and saves cross it at most 1.7 times a second per document. The daemon's cgroup gets `cpu.weight` 1000 against 100 for sessions, so `pnpm test` on every vCPU cannot starve saves. ADR 0003's relay-or-mirror question disappears; `relay` and `bridge` remain only as the link transport.

### 3.8 Rejected alternatives

| Alternative | Why not |
| --- | --- |
| Documents in the daemon, host relays frames (spec default) | Every keystroke crosses the most contended component, 4 vCPUs shared with the agent's builds, and the spike already missed. The author map and forgery check sit in an untrusted machine. |
| Host mirror plus daemon replica (ADR 0003 fallback) | Two replicas per document, a mirror rebuild protocol, two merge sites. Nothing it buys survives once the daemon stores an opaque record. |
| OT or `@codemirror/collab` | Fits a central host, but it is a second stack beside the wiki's Yjs, and reconnect resend needs rebasing that state vectors give free. |
| Automerge or Loro | A second engine and binding; better interleaving does not pay for migrating the landed client and wiki. |
| Server text with diff-match-patch | Concurrent typing at one spot drops or duplicates characters. |
| Stateless FFI per update (the wiki's `smithers_wiki_document` JSON call) | O(document) work per keystroke. The hub uses a handle API. |

## 4. Attribution and change tracking

| Write | Mechanism | Actor | Exact? |
| --- | --- | --- | --- |
| Typing in a File card | Client id → actor in `Y.Map("authors")` | Person | Per character |
| Agent write tool | Write route with the `run` credential | "Coding agent, for Ben" | Yes |
| App commands, Restore, Reapply | Write route with session or delegated credential | Person, or "Smithers, for Ben" | Yes |
| Rebase, Return to Tn | Daemon under freeze | Smithers | Yes |
| Agent `bash` | Burst; agent's own terminal session | Coding agent | Heuristic |
| Terminal, SSH shell, SSH editor, formatter, hand-run `jj`/`git` | Burst | "Maya via SSH" or "Ben's terminal" | Heuristic |

Bursts follow spec §9.3.4: one open outside burst per branch, closed 1.5 s after its last write, 10 s after it opened, or before another key touches one of its files. Its actor is the only candidate whose cgroups gained CPU time in the window (`crates/smithers-machined/src/attrib.rs`), else `{outside: true}`. Two changes:

1. **Candidates are people and the agent, not sessions.** Maya's shell and her Cursor server are both Maya, so her always-ticking editor server cannot turn her own format run into "outside".
2. **The coding host cannot write.** The broker starts the coding host with `/workspace` read-only in its own mount namespace, so its writes take the exact write route. The agent is a candidate only while its terminal runs a command.

**Gate.** Prediction: with the agent between commands, at least 80 % of Maya's `pnpm format` bursts read "Maya via SSH"; while the agent's terminal runs tests, under half do. An extended C-J3-03 measures it. If J3 step 4 reads "Changed outside Smithers", run the parked fanotify probe (`tickets/deferred/T-MCH-03.md`, one day) and attribute by writer pid → `/proc/<pid>/cgroup` → session, rebuilding libkrunfw with `CONFIG_FANOTIFY` if needed (about a week, T-INS-01).

**Activity.** Each change becomes one `product_job_events` entry, plus one `burst_files` row per file for bursts (that migration does not exist yet).

```
{kind: "write",    actor, request_id, files: [{path, before_blob, after_blob}]}
{kind: "burst",    actor, burst_id, files: n, versions: "refs/smithers/branches/<id>/bursts/<burst>"}
{kind: "doc_edit", actor, path, before_blob, after_blob, from, to}
```

Each renders as one line ("Maya via SSH changed 12 files", "Alice edited `retry.ts`") and opens a diff between two blobs in the host store, so it works while the branch sleeps. Before the agent's next tool call, its transcript gets "Maya via SSH changed `retry.ts`" (spec §9.3.9) and the files open in File cards with active typists.

## 5. Sessions, identity and terminals

- **Users and homes.** Spec §5.5 stands: member uids from 20000, `agent` 19999, `machined` 19998, group `team`, working copy `root:team` with setgid directories, `umask 002` and `safe.directory=/workspace`. No `sudo`, setuid or file capabilities. Homes are `/home/<login>` on each machine's own disk, mode 0700; tool logins never leave the machine (spike T-MCH-02).
- **Roster sync.** After `Welcome` and before `ready`, the host sends `set_roster{[{login, uid}]}`. The broker spawns only for listed uids and deletes the homes of unlisted ones, so a removed member's tool tokens leave awake machines at once and sleeping ones at their next wake.
- **Sessions.** Every process a person or the agent runs is a broker session in its own cgroup (`pty`, `exec`, `sftp`, `tcp`) with spec §9.6.2 frames and 256 KiB credit (`crates/smithers-machined/src/credit.rs`).
- **Terminals.** A daemon `pty` as the owner. The host terminal manager (`internal/routes/terminal_session_manager.go`) attaches over the link and keeps its WebSocket. It already fans out to many viewers, drops and counts non-owner input (`ownsInput`) and replays a 512 KiB ring: that is watch-only sharing. The agent's terminal is a `pty` owned by `agent`, registered to the run; its `bash` tool types into it, and members watch it like anyone's.
- **SSH.** Compose the existing gateway (`internal/ssh/server.go`, not mounted in `apps/backend/main.go` today) on port 2222. Username = branch; keys from GitHub plus `smthrs ssh-key`; connecting files a person wake. Shell and exec map to `pty`/`exec`, `sftp` to `sftp-server` as the member, `direct-tcpip` to `tcp_connect`. Agent forwarding and `tcpip-forward` are refused. VS Code's server must outlive its exec channel in Maya's cgroup (T-TRM-06).
- **Revocation in 5 s.** One transaction suspends the member, revokes credentials and writes the event (spec §5.6.2). The watcher (at most 1 s behind) then, in parallel, closes their live sockets and document subscriptions, terminal sockets and SSH connections; cancels queued turns and stops the running one; and on each awake machine calls `kill_sessions(uid)`, which returns at `populated 0`, then deletes `/run/smithers/<uid>/`. The clock stops at the last of these.
- **Host restart keeps terminals.** Spec §9.6.4 re-attaches nothing, so every `smthrs host upgrade` kills every shell. Sessions already survive 30 s without the host. On `Welcome` the host reads `status().sessions[{id, uid, kind}]` and re-attaches terminals whose owners are still members. SSH connections end at the host and drop; VS Code reconnects to its lingering server.

## 6. Presence and live updates

One WebSocket per tab at `/api/live` (`packages/backend/internal/live/{hub,conn}.go`, client `LiveChannel.ts`); terminals keep their own socket. Today the hub is snapshot-only, ignores client cursors, and answers `unsupported` for `branch:*:activity` and `branch:*:files` (`internal/compose/live.go:216`). Only the two log topics below need cursor replay; a snapshot of a small state topic is gap-free by construction.

| Topic | Kind | Resume after reconnect |
| --- | --- | --- |
| `home`, `todo:<n>`, `members`, `flows`, `install` | State | Fresh snapshot |
| `branch:<id>`: machine, presence, terminals | State | Fresh snapshot |
| `branch:<id>:files`: changed files, last writer, open docs with editors and outside flags | State | Fresh snapshot |
| `branch:<id>:activity` | Log | Cursor = `product_job_events.id`; page `id > cursor` up to 200, else `gap` |
| `conversation:<branch>` | Log | Cursor = the chat replay sequence, same paging |
| `view:<me>:<branch>`, `confirmations:<me>` | Private state | Fresh snapshot |
| `doc:code:<branch>:<path>`, `doc:wiki:<page>` | Document | Yjs sync steps 1 and 2 against state vectors |

**Presence.** Keep the lease roster in `flows/sync/src/BranchPresence.ts` behind `gateway/src/HostBranchPresence.ts`: 30 s leases keyed (branch, participant, session), fed every 10 s and on change by:
- the browser: `{path, line}` from the editor, `{terminal}`, `{run step}` or `{branch}`;
- the daemon, per session: the last file that session's bursts touched (an SSH editor reports no line);
- the runtime, for the coding agent and reviewers; the chat runner, for the app agent.

Deltas coalesce to 4 per second per branch. Nothing is released in the 30 s after a host start. `compose/presence.go` must stop refusing terminal and run locations.

**Scale.** A branch peaks at 8 people with 3 tabs plus 4 agents, about 30 sockets. Two typists at 30 updates a second fan out to about 1,800 small frames a second, far inside the 2 MiB per-connection budget. An install has 2 to 6 awake branches.

## 7. Shared conversation

- **Storage and order.** `chat_turns.conversation_id` = branch id, cards and events in `chat_turn_batches`, landed in `0121_branch_conversations.sql` with an index allowing one running turn per conversation. Entries order by the replay sequence assigned at commit; prompts queue first-in, first-out. `app_timelines` is deleted.
- **Credentials.** At turn start the runner checks the author is an active member, then mints `delegated(via=smithers)` for that author, valid 1 h and revoked at turn end. Tools run on the host through the catalog; `confirm` rows post a private Confirm card to the author; `never` rows are absent.
- **Who runs what.** App-agent turns run as their author. Steers and answers to the coding agent are input recorded with their author; the run keeps its sponsor's `run` credential, which can do no person action, so a teammate's steer grants nothing. External agents in terminals (M-38) appear as read-only imported entries.
- **Privacy and revocation.** Every started turn and its output is shared with every active member. Queued prompts, Confirm cards, drafts and view state stay private, and turn credentials cannot read them. Removal cancels queued turns (`author_revoked`) and stops the running one within 5 s.
- **Context.** The app agent's preflight reads only shared entries plus branch state, including presence ("Alice is editing `retry.ts`"), within a 24k-token budget. The coding agent receives revisions, steers with authors, answers and the change notes of §4.
- **What is missing.** Storage, shared reads (`internal/chat/shared.go`), author revocation (`author.go`) and the live topics exist. The app still posts turns privately to `/api/agent/turn` (`httpTurns.ts:99`) and never calls `/api/conversations/{b}/prompt`; the cutover is one change.

## 8. Failure and durability

| Event | Behavior |
| --- | --- |
| Tab closes, network drops | Only that tab's last second of typing is at risk; reconnect resends it. Log topics resume by cursor. |
| Host restart | Documents rebuild from the daemon record or PostgreSQL with the same epoch; clients resend. Terminals re-attach; turns resume by lease. |
| Daemon crash | The broker kills all sessions, so no process outlives attribution, and restarts the daemon. Host documents keep taking edits; saves resume after `open_doc` reconciles. |
| VM crash | Disk survives and the outbox replays. Acknowledged saves are on disk; the rest are re-sent from the host replica. `wake_reconcile` handles a head moved meanwhile. |
| Sleep | The host flushes and closes documents; the daemon closes bursts, snapshots, drains the outbox. Reads use the captured head. |
| Rebase while people type | The host holds saves. The daemon freezes sessions (at most 1 s), captures, rewrites and thaws. The host merges the rebased bytes into each open document as "Rebased onto Tk", keeping typing. A freeze timeout shows "Waiting for a write in Ben's terminal". |
| Install killed mid-save | The record precedes the text; on reopen, `prev_digest` equal to disk finishes the save. |

Never lost: an acknowledged save; the end state of every burst; displaced bytes; a client's unsaved edits while its tab lives; a started conversation entry; a queued prompt until its author or a revocation cancels it.

## 9. Reuse map

Paths under `B/` are in `packages/backend/internal/`, under `M/` in `crates/smithers-machined/src/`, under `A/` in `apps/app/src/mainview/`.

| Decision | What | Paths |
| --- | --- | --- |
| Keep | Browser co-editing client and fake relay | `A/runtime/{LiveChannel,LiveDocProvider,FileDocuments}.ts`, `A/cards/liveDoc.ts`, `A/cards/views/coEditingVisuals.ts`, `packages/rpc/src/testing/LiveDocRelay.ts` |
| Keep | Live hub; add log cursors and two topics | `B/live/{hub,conn}.go`, `B/compose/live.go` |
| Keep | Daemon engine and codecs | `M/{lock,watch,burst,versions,attrib,ignore,resync,outbox_store,credit,stream,session,events,conn,msg,schema}.rs`, `M/broker/` |
| Keep | Go wire, registry (mount it), session client | `B/machined/{wire,registry.go,sessions.go,testfake}` |
| Keep | Terminal manager, SSH server (compose it), presence | `B/routes/terminal_session_manager.go`, `B/ssh/server.go`, `flows/sync/src/BranchPresence.ts`, `gateway/src/HostBranchPresence.ts` |
| Keep | Conversation storage, shared reads, revocation | `B/chat/{store,dispatcher,shared,author,queue,view_state}.go` |
| Reshape | Daemon binary: compose broker, daemon and client | `M/main.rs` (exits 78 today) |
| Reshape | Document engine moves to the host library; the wiki merge becomes its adapter | `M/doc/{host,authors,merge,reconcile,state,gone}.rs` and `crates/smithers-ffi/src/wiki_document.rs` → `crates/smithers-ffi/src/live_document/` beside `document_core.rs` |
| Reshape | Daemon keeps only disk saves; drop `yrs` | `M/doc/disk.rs`, `M/doc/disk/linux.rs` |
| Reshape | Document relay becomes the doc hub; delete the topology switch | `B/live/docrelay.go` → `B/live/doc/` |
| Reshape | Write service: open paths to the hub, closed to the daemon | `B/routes/workspace.go:469`, `B/services/workspace_facets.go` |
| Reshape | Owner-only membership to roster; presence locations | `B/identity/member_boundary.go`, `B/compose/presence.go` |
| Reshape | App turns to `/api/conversations/{b}/prompt` | `A/state/controller/httpTurns.ts` |
| Delete | Guest compare-write, coordinator, mutation journal | `packages/backend/microsandbox/guest/smithers-guest.py`, `microsandbox/files_compare_write.go` |
| Delete | Head reporter loop, `app_timelines`, twelve `Gates` flags | `B/services/workspace_head.go`, `B/routes/app_timelines.go`, `B/services/app_timeline.go`, `M/doc/host.rs` |
| New | `burst_files`, FFI handles and Go wrapper, `save_doc`, `set_roster`, terminal re-attach, coding host read-only mount | |

## 10. Build plan

**Interfaces first, days 0 to 2, five lanes.** Every later item builds against them and their golden fixtures.

| ID | Interface | Proof |
| --- | --- | --- |
| IF-1 | ADR 0004 amendment: `open_doc`, `save_doc`, `close_doc` payloads, `file_written.bytes`, `set_roster`, `status().sessions` | Go and Rust golden frames in `internal/compose/testdata/cocontracts/` |
| IF-2 | `live_document` C ABI: `ld_open`, `ld_receive(h, client, frame) → {reply, broadcast, refused}`, `ld_merge_outside(h, base, theirs, client)`, `ld_replace(h, text, client)`, `ld_text`, `ld_record`, `ld_close` | `tests/yjs-interop.ts` moved from the daemon crate |
| IF-3 | Write route reply: `409 stale{path, current_digest, current_text}`, `200 {paths[{path, post_digest}], raced[]}` | OpenAPI row and Go handler test |
| IF-4 | Topic models for `branch:<id>`, `:activity`, `:files` | zod schemas in `packages/rpc` |
| IF-5 | `burst_files` migration and activity entry shapes (§4) | Migration test on real PostgreSQL |

**Spikes, day 0 to 1, in parallel with the interfaces.**
- S-1: `scripts/spikes/col-01/` with the document in a Go host process; two browsers on a second Mac, 1,000 keystrokes. Pass: p95 under 150 ms.
- S-2: in a Linux VM, a VS Code server, an idle Node process and a formatter in three cgroups; count 1.5 s windows where more than one person's cgroup gains CPU.

**Work items.** Each carries unit tests and, where it touches PostgreSQL, integration tests on a real database; the last column is the proof that decides it.

| ID | Days | After | Work (tickets) | Deciding test |
| --- | --- | --- | --- | --- |
| D1 | 3 | IF-1 | Daemon composition, guest init planting, registry mounted (T-COL-03, -03a) | Real VM: boot to `ready`; `kill -9` the daemon; back to `ready` |
| D2 | 4 | D1 | Sessions; terminals and the agent's terminal through the daemon (T-TRM-07, -01, -05) | Browser e2e: owner types, a watcher's keys are dropped |
| D3 | 3 | D1 | Member users, homes, no-`sudo` image, `set_roster` (T-MCH-11) | Real VM: `jj st`, `git status`, `pnpm install` alternating across two members and `agent` |
| D4 | 3 | D2 | SSH gateway; VS Code Remote-SSH (T-TRM-03, -06) | Recorded connect, save, terminal, `-L` forward, reconnect |
| D5 | 3 | D1, IF-3 | No-rollback `write_file`; route gate opened; guest coordinator deleted (T-COL-10) | Fuzz: 4 outside writers, 100,000 rounds, zero lost byte states |
| D6 | 4 | D1, IF-5 | Bursts ingested, `burst_files`, activity and files topics, reload, Restore (T-COL-04, -04a, T-APP-11) | Real VM: `pnpm format` on 12 files gives one entry; Restore one file |
| D7 | 2 | D2 | Presence locations and daemon heartbeats (T-COL-06) | Three participants visible within 1 s |
| A1 | 3 | day 0 | Roster membership and roster-derived branch access (T-ACC-02) | Removed member refused on every route |
| A2 | 2 | D2, D4, A1 | Revocation fan-out | VS Code running: last process gone under 5 s, 20 runs |
| L1 | 3 | IF-2 | Document engine moved into `smithers-ffi`; Go wrapper | 1,000 open and close cycles on 1 MiB documents under the race detector |
| L2 | 3 | L1 | Doc hub and wiki adapter: wiki co-editing live (T-COL-09) | Two browsers on one page; host kill loses no acknowledged keystroke |
| L3 | 4 | L2, D5, D6 | Code adapter and agent write routing (T-COL-08, T-APP-14) | Real VM: two people on one line plus Maya's SSH save; Compare shown |
| L4 | 3 | L3 | Rebase and Return to Tn with open documents (T-STK-08, T-COL-05) | Rebase while two type: hold under 2 s, no keystroke lost |
| C1 | 3 | A1 | Conversation cutover, `app_timelines` deleted (T-APP-16) | Two members see one order; removal stops a running turn in 5 s |
| R1 | 2 | D2 | Terminal re-attach after host restart | Two shells survive a host restart |
| P1 | 3 | all | Reference-host budgets, faults, J3 recording (C-PERF-03, -04, -06, C-DUR-04) | Artifacts in `.artifacts/perf/<date>/` |

```
day    0         1
       0123456789012345678
IF     ██
S      ██
A1     ███
D1       ███
L1       ███
C1        ███
L2          ███             wiki co-editing ships
D2          ████
D3          ███
D5          ███
D6          ████
D4              ███
D7              ██
R1              ██
L3              ████
A2                  ██
L4                   ███
P1                      ███
```

About 19 working days with six to eight lanes busy. Wiki co-editing ships first because it needs no daemon, which proves the hub, protocol, provider and latency before any code document depends on them.

## 11. Risks and open questions

| # | Risk or question | Falsify cheaply |
| --- | --- | --- |
| R1 | The host hub misses 1 s for keystrokes on the LAN | S-1, one day. Expect p95 under 150 ms; above 500 ms means the LAN, not placement, dominates, and no topology fixes it. |
| R2 | Saves exceed 1 s under guest load | Time `save_doc` while `pnpm test` saturates every vCPU, with and without `cpu.weight` 1000 on the daemon. |
| R3 | Session heuristic reads "outside" in J3 step 4 | S-2 now; extended C-J3-03 after D6. A miss triggers the fanotify probe and kernel decision of §4. |
| R4 | A no-rollback write loses bytes | D5's fuzz: every outside write's bytes must appear in some version; count `raced` outcomes. |
| R5 | Cgo handles leak or race | L1's soak under the Go race detector and Rust address sanitizer. |
| R6 | Full-text saves of 1 MiB files load the link | Two typists in a 1 MiB file for 10 minutes: bytes per second on the link and save p95. If it hurts, send a patch against `base` instead of the text. |
| R7 | VS Code's server dies with its exec channel, or revocation passes 5 s on a process in uninterruptible sleep | T-TRM-06 steps 6 and revocation runs. |
| R8 | One running turn per conversation blocks a quick prompt behind a long one in `main` | Log queue wait per turn in dogfood; above 10 s p95, revisit. |
| R9 | D1 slips and every daemon-backed item waits, as in wave 1 | Day-3 checkpoint: a real VM reports `ready` with the planted binary, or the plan slips day for day and L2 and C1 still ship |
| Q1 | Owner: accept §3.5's no-rollback wording for E-16 | Count `raced` replies in the first 10,000 dogfood writes; more than a handful means the window is wider than 1 ms |
| Q2 | Product: J3.2 shows "Maya editing `retry.ts:12`" over SSH, but no line is knowable without an editor extension; presence shows the file only | Show product the J3 mock with file-only SSH presence |
| Q3 | Owner: ship a rebuilt libkrunfw with fanotify if R3 fails | S-2 and the extended C-J3-03 decide it |
| Q4 | Engineering: terminals survive host restarts, amending spec §9.6.4 | R1 (two days): upgrade the host with two open shells |
| Q5 | Engineering: on the install, branch access derives from the active roster instead of per-branch `workspace_shares` rows; Plue keeps its grants | Deletion test: removal touches one row instead of one per branch |
| Q6 | Engineering: retire ADR 0003's topology section and T-COL-11's relay-or-mirror rule in favour of §3 | S-1 |

**One action:** run S-1 and S-2 tomorrow. Both take a day and decide the two load-bearing bets in this design: document placement and attribution.
