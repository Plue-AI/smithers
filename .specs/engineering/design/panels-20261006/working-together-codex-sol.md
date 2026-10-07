# Working together on one branch — Codex Sol

## 1. Summary

Every awake branch has one microVM, one working copy and one shared conversation, with PostgreSQL owning membership and scheduling facts and the machine owning saved file bytes. Browsers co-edit through Yjs against a host-side Yrs mirror, while the machine daemon keeps the durable replica and alone confirms that edits reached disk. Every terminal, SSH connection and agent process belongs to a broker session, a Unix identity and a participant, which also identify observed changes and presence. Outside saves become three-way merges into live documents, with conflicting bytes preserved as recoverable versions, and conversation turns run on the host under their authors’ current permissions. Launch requires real-machine evidence for saving, attribution, revocation and latency; component tests and successful job launches cannot substitute for that evidence.

## 2. Abstractions

The October 6 brief governs this design: remote cursors are now required, despite their exclusion in the older product spec and T-UI-19. Reliable attribution of concurrent SSH saves also requires strengthening the older single-active-session heuristic. Neither change restores Pair.

| Object | Owner and source of truth |
| --- | --- |
| Branch | Existing workspace/lane binding in host PostgreSQL; stable workspace ID identifies a live branch, independently of its bookmark or current commit. One active working copy per repository/branch. Only the stack service writes `mythical`; this design never moves `main`. |
| Machine | Existing workspace runtime owns boot, disk and stop observations. PostgreSQL records bindings; scheduler memory owns reconciled capacity and demand. Guest disk owns uncaptured work. |
| Session | Broker owns process lifetime, UID, cgroup and stream offsets. Host records authenticated participant/member/run bindings and credential grants. A browser attachment is not a process session. |
| File | Exact bytes and mode on machine disk; path is a branch-relative locator, digest is SHA-256. Captured host Git objects serve sleeping-branch reads. |
| Document | Machine disk stores epoch, Yrs identities, author map, pending operations and save receipts. Daemon memory owns the live replica; host mirror and browser replicas are caches containing potentially unsaved edits. Wiki document authority is host PostgreSQL instead. |
| Change | Daemon durable journal/outbox and pinned Git versions until host acceptance; thereafter host objects plus PostgreSQL event receipts/activity rows. Presence and invalidation hints are not changes. |
| Conversation | Existing PostgreSQL `chat_turns`/`chat_turn_batches`, identified by repository and branch, ordered by the existing replay cursor. Private member view state stays in `collaborators.view_state`. |

Use one participant shape everywhere: `{id, kind: person|agent|system|outside, member_id?, agent_kind?, run_id?, session_id?, for_member?, via}`. Participant identity conveys attribution, never permission. Keep authorship and transport separate: an agent acting for Maya is its own participant even inside Maya’s terminal.

Inspection baseline: checkout `f28cbf01cf8c`; local `origin/frontrun` resolves to `40970fe191be`. Their differing paths concern backup maintenance and spike-control evidence, not these production components. No checkout or fetch was performed. The daemon has a `main.rs`, but it exits 78 with “core not composed”; `SessionRPC` remains an interface. Conversely, current branch membership admits active collaborators, file writes already carry bases, and branch/conversation/member live adapters exist. The brief’s older inventory therefore understates landed seams; none proves the complete journey works.

## 3. Co-editing model

Keep Yjs 13.6.32 in browsers and Yrs 0.27.4 in native adapters, reusing `crates/smithers-ffi/src/document_core.rs`. Use UTF-16 offsets, `Y.Text("content")` for code, `Y.Text("markdown")` for wiki, and authority-owned `Y.Map("authors")`. CodeMirror’s Yjs binding handles text and relative-position cursors. Render author colour and gutter names with accessible labels; add the brief’s cursor capability to the existing binding rather than another editor.

**Choose the host mirror.** Browser → host → browser fan-out avoids putting the guest relay in every remote keystroke’s critical path. The contended-laptop spike measured relay p95 197 ms against 20 ms and bridge keystroke p95 1,738 ms against 1 s. These are failures on a nonreference host, not evidence of a reference-host pass. ADR 0003 currently says topology is undecided; this is a recommendation for T-COL-11, not a claim that its required rerun happened. Once selected, implement one production topology and delete the alternative document adapter; preserve the underlying transport seam needed elsewhere.

The host instantiates resident document handles through the shared native Yrs core, validates updates, broadcasts immediately, and batches forwards to the machine every 20 ms without round trips per edit. It rebuilds from the daemon before answering subscriptions after restart. It never acknowledges a disk save, opens host repository files or spawns a helper per update.

Each subscriber receives `{epoch, client_id, client_lease}`. Allocate a distinct clock space per editing session, including two tabs belonging to one person. Validate new structs against that lease, forbid client changes to the authors map, and allow authenticated replay of the same member’s retained client IDs. Server identity replaces awareness-supplied identity. Deletions are allowed edits to others’ text; their author is recorded in the transaction envelope, rather than inferred from inserted items.

Extend the existing document frames with these logical shapes, encoded through the shared Go/Rust codecs:

```text
update {epoch, client_lease, update_seq, update_bytes}
saved  {epoch, sv, accepted:[{client_lease, through_seq}], digest, generation}
awareness {relative_anchor, relative_head, line}  // actor/colour supplied by host
```

`update_seq` is monotonic within a lease; duplicate identity with different bytes is refused. Persist the receipt frontier with document state. A Yjs state vector alone cannot prove a deletion-only transaction was saved: deleting existing items does not necessarily advance the author’s insertion clock. The current `LiveDocProvider` coverage test must therefore use the explicit transaction receipt as well as the vector. “Saved to the machine” means every local transaction is covered by a daemon receipt for the current epoch.

**Document to disk.** Trigger at 200 ms idle or 500 ms from the oldest unsaved edit, leaving room inside the one-second end-to-end budget. Under the daemon’s FIFO mutation boundary: reconcile completed outside writes; prepare a journal containing complete CRDT state, receipt frontier, target bytes, prior digest and generation; fsync it; replace the target while preserving mode; fsync file/directory; durably mark settlement; emit `saved`. Recover prepared transactions before admitting sessions. The journal retains each attributed update and transaction identity, with delete data or before/after versions sufficient for recovery; CRDT garbage collection cannot discard that evidence. Every Smithers transaction is recoverable individually even when disk projections are coalesced.

The exchange-and-rollback algorithm in spec §9.4.1 is already disproved by ADR 0003’s outside-replacement and moved-ancestor counterexamples. Reuse the repaired bounded transaction and managed-writer exclusion contract, not that old algorithm. Briefly freeze all admitted outside writers while comparing and settling a disk replacement; the mutation worker remains outside the frozen tree. New session starts share that fence. Pending journal recovery retains exclusion until settlement. Open-file-descriptor, hardlink, outstanding kernel-I/O and path-move races must qualify on the actual guest filesystem before enablement.

**Disk to document.** On close-write/atomic rename, preserve the observed external bytes before any daemon projection replaces them. Three-way merge base = last disk projection, ours = current Yrs text, theirs = external bytes. Apply nonoverlapping hunks as one attributed CRDT transaction; for overlap retain live text, preserve the complete external version, and expose the specified “Changed outside Smithers · Compare”. A stale SSH save has no editor base protocol, so it cannot receive the same stale refusal as a routed agent write. Its bytes remain recoverable.

Agent `write_file` compares its base against current document text when open, otherwise against disk under exclusion. A patch is one validated batch; stale refusal changes nothing. The agent re-reads instead of blindly retrying. Restore writes a historical version as a new attributed edit with a current-state precondition; it does not rewind document identities.

Use Yjs `UndoManager` for local editor origins only, with CodeMirror history disabled. Recovery across epoch changes presents retained edits for Reapply/Copy; reapplication must merge against current text or open Compare, replacing the current whole-file reapply behavior. Persist unacknowledged code and wiki operations in the existing browser storage abstraction, scoped to origin/member/branch/epoch, until receipts cover them. This is a recovery buffer, not permission to edit indefinitely offline.

Reject OT because central transformation and reconnect history would duplicate the wiki’s merge system. Reject Automerge/Loro because changing libraries adds migration and interop work without solving disk synchronization. Reject pure machine fan-out because the measured route is risky; reject host-only authority because terminals still consume guest bytes and save acknowledgements must survive machine restart. Binary/non-UTF-8 and >1 MiB files remain readable but not co-editable.

## 4. Attribution and change tracking

Routed writes obtain their actor from authenticated host context or `SO_PEERCRED` plus registered-run cgroup on the agent socket. Neither browser payloads nor filenames choose an author. The daemon tracks its own write transaction/digest, so delayed watcher notifications cannot turn it into an outside edit.

For outside writes, replace CPU-activity inference with a **kernel observation interface** owned by the broker:

```text
ObservedMutation {observer_seq, object_id, path_or_rename,
                  session_id, actor_binding, operation, monotonic_time}
```

The collector captures session/cgroup identity at the mutation boundary, while the process exists. A UID establishes the person; a cgroup establishes SSH versus terminal and a registered agent lifetime. The unprivileged daemon receives bounded facts, not arbitrary privileged file access. Prototype a small image-pinned eBPF/VFS observer for writes, truncates, renames, unlink, asynchronous I/O and shared writable mappings; retain inotify for recursive discovery, close notifications and overflow reconciliation. Kernel observation is net new and a launch-critical feasibility gate, not an existing capability.

Do not pretend `stat` ownership, `/proc` lookup after process exit, shell command strings or the single busy session prove authorship. Fanotify PID reporting is useful but not sufficient for the whole contract: its documented limitations include mapped writes, and lifetime resolution needs care ([upstream manual](https://kernel.googlesource.com/pub/scm/docs/man-pages/man-pages/+/master/man/man7/fanotify.7)). FUSE would change filesystem semantics, caching and execution performance; do not build it before this narrower observer is falsified.

A collector gap freezes new mutation admission, captures/rescans and records an explicit outside/system recovery actor; it never invents a person. Launch must prove ordinary simultaneous SSH/editor/formatter cases have exact bindings. If required operation classes cannot be observed reliably, either enforce a qualified denial of that class before mutation or escalate the requirement; heuristic labels do not satisfy the brief.

Group attributable writes by participant and transport: close after 1.5 s idle, cap at 10 s, and close a file’s previous group before another actor touches it. Concurrent writers to one inode yield a multi-actor change when byte ownership cannot be separated, preserving all observed contributors rather than assigning the last one the entire diff. “Maya via SSH changed 12 files” counts distinct paths, not watcher events.

Keep parentless versions commits with `a/<path>` and `b/<path>`, per-file before/after blobs, event IDs and pinned refs. Preserve external versions involved in live merge immediately; ordinary external changes retain burst end states, not every transient byte written inside a burst. Ignored build/dependency paths produce no activity. Delete and rename pause the affected editor and reuse Restore/Follow. Host receipts and object availability commit before acknowledging the outbox; activity remains available while the machine sleeps.

## 5. Sessions, identity and terminals

Reuse the root broker/unprivileged daemon split. Assign stable member UIDs ≥20000, agent 19999 and daemon 19998. Homes are private 0700 directories on each machine’s disk, never shared or token-copied; `/workspace` is the shared `team` working copy. Provision a newly joined member before spawning their first process. Remove sudo, privileged groups, setuid helpers and file capabilities from the image.

All PTY, exec, SFTP and language-server processes enter broker-owned cgroups. Preserve ADR 0004 session frames, 256 KiB directional credit, EOF, exit, signals, resize and received-byte offsets. Reconnect within 30 seconds can attach to existing sessions; daemon or host restart ends terminals under the existing contract. The coding agent’s commands use its own registered exec/PTY session and ordinary Terminal card output.

Keep terminal WebSockets separate from `/api/live`. Any member can watch; only the owner can send input, resize or close. Enforce this on every frame, including a revoked attachment, not just at socket creation. A stalled watcher cannot block the owner: retain bounded replay and detach/gap that watcher when its budget is exhausted.

Compose existing `internal/ssh/server.go` on port 2222. The branch username selects the workspace; the authenticated GitHub/manual key selects the member. Forward shell/exec/SFTP and loopback `direct-tcpip` through the same session RPC. Refuse guest root, password bypass, agent forwarding, X11 and remote forwarding. Real VS Code/Cursor Remote must prove this route, including background server children.

Revocation commits member state, token revocations and a durable event together. Host stream closure and guest `kill_sessions` must finish within five seconds of commit, including queued wakes and background descendants. Renew a guest authorization lease every second with an expiry leaving time for killing processes inside that bound; a partition cannot extend access using the ordinary 30-second transport grace. Once revoked, takeover or reconnect never revives an old credential.

## 6. Presence and live updates

Use the existing `sse.Broker`/DurableStream adapter and one `/api/live` WebSocket per tab, subprotocol `smithers.live.v1`; code/wiki use binary Yjs sync and awareness kinds. Keep `home`, `todo`, `branch`, branch `activity`/`files`, `conversation`, `members`, private `view` and private `confirmations` topics. Topics identify stable branch IDs; paths require canonical encoding and traversal validation.

Continue the `BranchPresence` roster through `BranchProtocol` and `runtimebridge`, with 10-second heartbeats and 30-second leases per branch/participant/session. Coalesce branch location deltas to four per second; relative-position cursor awareness runs independently, throttled to 20 Hz. SSH presence reports the last reliably attributed save, not an inferred live caret. Render one avatar per participant with its sessions, keeping agents distinct from sponsors.

For durable topics, obtain snapshot plus cursor from a consistent source, subscribe to replay before releasing that snapshot boundary, then deduplicate deltas by cursor. PostgreSQL committed events are the source; NOTIFY is only a wakeup. Reconnect resumes stored cursors; unavailable history produces `gap` and a fresh snapshot. Documents resume through Yjs state exchange plus pending transaction replay, not projection cursors. Presence uses a fresh roster because it is ephemeral. Host-start presence remains unknown for 30 seconds and cannot justify machine release.

Start load qualification at 16 people × two tabs, eight open documents each, four active typists at 30 Hz and a busy agent. These are test profiles, not invented product caps. Enforce existing participant limits, document byte bounds, a 2 MiB send budget and bounded native handles. Disconnect slow readers explicitly; control, save receipts and revocation outrank bulk terminal/object data.

## 7. Shared conversation

Keep one conversation key per repository/branch in the existing chat journal. Submission durably records author, prompt, branch, idempotency key and admission order, then returns “Requested” without awaiting model work. Drafts and queued prompt editing remain private to their author; started prompts and outputs become shared facts. One running app-agent turn per conversation is enforced by the landed database uniqueness constraint and claim/lease dispatcher, not a browser lock.

Mint an author-bound delegated credential at execution time, checking current membership and role again. The host executes command tools through the shared typed flow catalog; model keys stay on the host. UI-only actions go only to that author’s browser. Private confirmations never enter shared topics or model context. Coding runs retain their separate run-scoped permissions and cannot approve, merge or move `main`.

Build context from a fresh versioned preflight selecting files, wiki revisions, TODOs and runs; the shared transcript is not the model’s context window. Deliver attributed external-change facts to the active coding run before its next tool call, using existing durable signals. Imported external-agent transcripts remain read-only data, never executable prompts or tool commands.

Revocation cancels queued/running author turns and revokes their credentials within five seconds. Persist lease/credential cleanup before admitting the next turn. Preserve old private conversations under Earlier with existing decoders; migrate no private content into the branch. Delete `app_timelines` only after archived history has a durable readable representation and the shell has one chat-journal reader.

## 8. Failure and durability

| Failure | Required behavior |
| --- | --- |
| Sleep/wake | Stop admission, flush documents, close bursts, capture head and versions, drain outbox, then stop VM. Retain disk. Reads use host snapshots without wake; edits request wake through the existing people-first scheduler. Reconcile host head before opening sessions. |
| Daemon/machine crash | Broker kills old session trees before admitting new ones. Recover journals and full CRDT state before reconnecting. An unreadable record starts a new epoch only after preserving its bytes and recovery evidence. |
| Network drop | Browser retains pending operations; no new Saved claim. Mirror retains unsaved state while alive. Guest authorization leases expire independently. Outbox and object refs remain pinned. |
| Host restart | Reconcile machines/capacity, rebuild mirrors from daemon, then replay browser buffers. Restore shared conversation from PostgreSQL; recover turn leases and revoke abandoned credentials. |
| Rebase while typing | Publish rewrite generation; drain updates through a barrier, freeze all machine writers, flush/capture/pin, perform jj rewrite, merge its disk result into the same document, then apply later queued edits and thaw after settlement. Browsers keep typing, but saves wait. |

A rewrite freezes process writers, not the host mirror’s editor input. Captured pre-rewrite state and the journal make interruptions recoverable; stale queued tool writes refuse against the new generation. A freeze timeout returns busy with the blocking session and leaves rebase pending. Conflicts enter Needs you, preserving local and external versions. Do not follow the old “always thaw” instruction when mutation recovery is unsettled.

Never lose an acknowledged document transaction, accepted prompt, completed flow step, durable burst version or queued outbox object. Before acknowledgement, browser buffers or the machine journal preserve accepted edits across recoverable failures. Destruction of every copy of unacknowledged data cannot be guaranteed; Saved promises restart durability, not protection against physical disk loss. Outside intermediate states within a burst retain the existing limited guarantee.

## 9. Reuse map

| Piece | Keep / reshape / delete / new |
| --- | --- |
| Branches/admission | Reshape `internal/services/workspace_branch_machine*.go`, `workspace_machine_queue.go`, `workspace_access.go`, existing `workspace_shares` and active-workspace key. Audit every provisioner; reject competing copies without deleting disks. Keep runtime capacity reconciliation. |
| Daemon | Compose `crates/smithers-machined/src/main.rs`, `broker/`, `rpc.rs`, `hooks.rs`, `lock.rs`, `credit.rs`, `outbox_store.rs`, `versions.rs`, `watch.rs` and `doc/`. New production lifecycle/link/capture wiring where absent. No fixture/no-op hooks in admitted production paths. |
| Session/SSH | Implement existing `internal/machined/sessions.go` RPC and broker supervisor; reshape `internal/routes/terminal_session_manager.go` and `internal/ssh/server.go`. Delete direct terminal/SSH process-launch bypasses at cutover. |
| Documents | Keep `smithers-ffi/src/document_core.rs`, `wiki_document.rs`, daemon `doc/` and `internal/machined/wire/`. Reshape `internal/live/docrelay.go`; new `codedoc.go` resident mirror adapter and shared-native handle API. Delete selected-out relay-only document behavior. |
| Browser | Keep `runtime/LiveChannel.ts`, `LiveDocProvider.ts`, `cards/liveDoc.ts`, `CodeEditorSurface.tsx`, `views/CodeEditorView.tsx`. Fix receipt, recovery and cursor semantics; bind the production channel. Delete duplicate text-reload/editing surfaces. |
| Wiki | Reshape `internal/services/wiki_collaboration.go` to the same live provider/persistence adapter. Delete old update POST/SSE-refetch callers and routes together; retain old revisions. |
| Presence/changes | Keep `compose/presence.go`, sync `BranchPresence.ts`/`BranchProtocol.ts` and revocation bus. Replace `attrib.rs` inference with kernel facts. New observer only; keep existing burst/version engine. |
| Chat | Keep `internal/chat/{store,queue,shared,preflight,dispatcher}.go`, migration `0121_branch_conversations.sql` and `compose/conversation_branch.go`. Finish shared shell/revocation; remove `internal/services/app_timeline.go` writers/store after archive conversion. |
| Capture | Replace `internal/services/workspace_head.go` polling/report duties with daemon capture/outbox. No second reporter remains. |

All abbreviated backend paths are beneath `packages/backend/`; app paths are beneath `apps/app/src/mainview/`. Plue’s read-only composition confirms it consumes the shared backend. It receives deployment adapters later, not multiplayer product code.

## 10. Build plan

These are implementation proposals, not work started by this design. Reuse/claim existing ticket issues before execution; split large integration tasks rather than treating a dark component landing as completion.

| Order / parallel lane | Work, effort | Proof |
| --- | --- | --- |
| 1 | Contract amendment, 2 days: participant binding, update receipts, rewrite barrier, observer facts, private/shared projection boundaries; extend ADR 0004/golden frames and scoped ticket exclusions. | Go/Rust/TS literal interop fixtures; delete-only stale-ack, spoofed-author, duplicate-ID and old-record decoding tests. |
| 2A | Attribution feasibility, 3 days; new subitem under external-change work. | Real guest two-UID editors, formatter, short-lived writes, rename/unlink, mmap, io_uring, PID reuse and observer overflow. Reject false attribution. |
| 2B | T-COL-11 rerun/kernel qualification, 2 days. | Existing spike harness on reference Mac with second laptop; raw latency samples, fsync/capture growth, actual filesystem race probes. |
| 3 | T-COL-03a/03 startup and authenticated session RPC, split into two 3-day items. | Unit lifecycle/credit faults; real PostgreSQL boot fencing and transactional receipts; actual microVM init/daemon kill and restart. |
| 4A | T-MCH-04/06/11 identity, grants and admission, split into 2–3-day items. | Real PostgreSQL simultaneous joins/revocation/migration; real machine one disk, separate homes, no sudo, capacity release and read-without-wake. |
| 4B | T-TRM-07/01/03/05 sessions/SSH/agent terminal, separate 3-day items. | Unit protocol/ownership; real SSH/SFTP/forwarding and VS Code Remote; forged watcher input and background-child revocation within five seconds. |
| 4C | T-COL-04a/04/05/12 capture, attribution integration and signals, separate 3-day items. | Real PostgreSQL dedup/object receipts, guest overflow/burst faults, moved-off recovery and agent stale-read refusal. |
| 5A | T-COL-08a/08b durable documents/mirror, separate 4-day items. | Real Linux transaction crash boundaries, outside-write races, Unicode/CRDT fuzz fixtures, restart and deletion-only receipts. |
| 5B | T-APP-14a/T-UI-19 provider/editor/cursors, separate 3-day items against fixed interfaces. | Browser two-tab convergence, same-line edits, local-only undo, persisted pending deletion and safe Reapply; keyboard/light/dark checks. |
| 5C | T-APP-16 shared shell/turn revocation, 3 days. | Real PostgreSQL ordered two-author prompts, one running turn, credential mint/launch failures, private archives and confirmation isolation. |
| 6A | T-COL-09 wiki cutover, 2 days. | Real database commit-before-saved; two-browser co-edit/restart; old routes absent and revisions readable. |
| 6B | T-COL-08/T-APP-14 final integration, split into 3-day items. | Browser plus real machine outside save during typing, host/VM kills, rebase while typing, real reference-host performance recordings. |

Step 1 fixes interfaces; steps 2A/2B run independently; after startup, lanes 4 and then 5 can proceed in parallel. Components can build against contract fixtures sooner, but activation waits for their real dependencies. Target remote character arrival <1 s, outside save to card <1 s, durable save <1 s, warm wake <5 s and rewrite hold <2 s at p95. Run latency under the stated typing/load profile, not an echo-only control. An unresolved launch and a running remote job must leave Chat usable, deduplicate requests and keep the shared debounced toast running until real completion.

Unit and real-dependency integration suites each need meaningful independent assertions; retain regressions and fuzz counterexamples. Release uses production flows/routes on a fresh reference-host install, second laptop and both themes, with restart and upgrade receipts. Check-command mappings need authenticated provenance and manual owner receipts where specified; this design waives none. No long suites were run for this document.

## 11. Risks and open questions

- **Kernel observation may be the largest scope change.** Falsify with the three-day guest matrix before UI integration. If it cannot bind concurrent SSH saves correctly, the strengthened brief remains blocked; an anonymous fallback is incident handling, not acceptance.
- **Freezing outside writers may break save latency or tool responsiveness.** Measure 30 Hz typing with formatter/build/LSP activity, including queued kernel I/O. Failure means repair the transaction boundary, not weaken stale refusal or claim Saved early.
- **Mirror fan-out may help display but leave saves slow.** Measure viewer latency and disk receipt latency separately through production transport. Start saving at 500 ms maximum age; if guest queues still miss one second, fix transport/priority before launch.
- **Document memory, IDs and recovery logs can grow.** Measure 1 MiB files, 1,000 captures and reconnect churn. Compact only acknowledged state while retaining item identities needed by offline buffers; never reseed to save memory.
- **Rebase semantics may yield valid CRDT text that is invalid code.** A three-person rebase/formatter adversarial fixture must preserve all inputs, expose conflict/Compare and stop the coding run when appropriate. Convergence alone is insufficient.
- **Revocation under partition and SSH descendants is unproved.** Drop host connectivity immediately after removal and inspect guest cgroup emptiness independently. This falsifies any mistaken dependence on a successful host kill RPC.
- **Historical conversation migration may leak private data.** Two-member/archive/confirmation fixtures through the real shell must show literal inaccessible IDs and no shared content. Keep old history readable before deleting the old store.
