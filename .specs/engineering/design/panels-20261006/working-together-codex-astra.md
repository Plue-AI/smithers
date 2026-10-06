# Working together on one branch — Astra

## 1. Summary

Give each branch one retained machine, one working copy, one conversation, and one authenticated session broker for every person and agent. Use the existing Yjs/Yrs document core, with a host mirror for immediate fan-out and the machine as the sole authority for durable code saves. Treat filesystem reconciliation as a journaled transaction that preserves outside bytes before replacing them, rather than assuming a CRDT makes arbitrary disk writes safe. Bind permissions, attribution, presence, and process lifetime to the same authenticated session, and acknowledge a save only when its exact edit transactions survive restart. Finish the existing components through a thin production path, then qualify simultaneous editing, SSH, revocation, recovery, and latency on the reference Mac before launch.

## 2. Abstractions

| Object | Owner and source of truth |
| --- | --- |
| Branch | Host PostgreSQL records its repository, stable identity, stack item or scratch origin, and canonical `workspaces` binding; branch names are labels. GitHub owns `main`; only the stack service writes `mythical`. |
| Machine | Existing machine service and runtime own admission and lifecycle. One current boot generation holds write authority for a branch; retained guest disk owns awake working-copy bytes and homes. Host Git objects and captured refs serve sleeping reads. |
| Session | Host authorizes `{session, member/run, participant, branch, permissions, auth_generation}`; guest broker owns its UID, cgroup, processes, and streams. Daemon memory maps kernel identities to sessions. Sessions are execution identities, not new workspaces. |
| File | A confined branch-relative path and its exact byte digest. The machine owns current bytes; immutable Git blobs own recorded versions. Rename/delete are explicit events, not empty text updates. |
| Document | `{kind, branch/page, path, epoch}` names a collaborative replica set. Machine state records own code CRDT state and durable transaction receipts; host PostgreSQL owns wiki state/revisions. Host mirrors and browser documents are replicas. |
| Change | A durable attributed mutation or external burst, with immutable before/after objects. Machine journal/outbox precedes host PostgreSQL receipts and activity projections. Presence is never evidence that a change happened. |
| Conversation | Existing `chat_turns` and `chat_turn_batches`, scoped by `conversation_id`, own shared ordered output in PostgreSQL. `collaborators.view_state` owns each member's view. Browser-local drafts remain private. |

Reuse these objects; add no branch, terminal, conversation, or projection-event database beside their existing owners. Deleting a member removes access, never the shared machine or its history. A boot fence prevents an old connection or delayed capture from replacing a newer branch head.

The October 6 brief takes precedence over the earlier cursor exclusion: launch includes live remote carets, author colours, and gutter names. Exact outside attribution is also stronger than the current CPU-based session heuristic; section 4 names the required change explicitly.

## 3. Co-editing model

Choose pinned Yjs `13.6.32`, Yrs `0.27.4`, CodeMirror, and `y-codemirror.next`. Reuse `crates/smithers-ffi/src/document_core.rs`, already shared with `smithers-machined/src/doc/mod.rs`. Code uses `Y.Text("content")`; wiki uses `Y.Text("markdown")`. Both use one provider and protocol, parameterized by persistence authority.

Recommend the host mirror topology, subject to the existing T-COL-11 reference-host decision and ADR acceptance. This is a design recommendation, not a claim that the required rerun happened. The mirror integrates authenticated browser updates and immediately fans them out, then pipelines them to the daemon. It uses the shared Rust core through the existing binding, not a Go CRDT implementation. The daemon integrates the same item identities and alone emits code-save receipts. The host mirror has no independent authority to save code or create an epoch; after restart it loads the machine's state before serving subscriptions.

The two performance clocks are separate: remote visibility and durable disk save. The contended-laptop figures—197 ms relay p95 and 1,738 ms bridge keystroke p95—justify removing guest round trips from viewer fan-out, but prove neither launch budget. Pipeline updates, coalesce transport batches within a small bounded interval, prioritize document/control traffic over object bundles, and reserve daemon CPU. Flush after 200 ms quiet, with an earlier maximum-age deadline that leaves room for transport and fsync inside the one-second budget. A one-second timer alone cannot satisfy one-second end-to-end saving. Measure both clocks under continuous 30 Hz typing and loaded guests.

### Admission and acknowledgments

Extend the existing document contract, not the public file-write API:

```text
update {epoch, producer, seq, update_hash, yjs_update}
saved  {epoch, save_seq, digest, sv, receipts:[{producer, through_seq}]}
awareness {client_id, anchor: relative_position, head: relative_position}
```

These fields wrap the existing binary Yjs sync/update payload. Host authentication supplies the participant; it allocates and binds producer/client identities. The authenticated author map is server-controlled. Validate newly introduced Yjs structs and protected roots; never trust a client's `authors` map. Existing foreign structs may be replayed, but a client cannot mint new structs under another author's identity. Record deletion authors in transaction metadata because deleted characters no longer provide a visible author range.

State vectors remain synchronization aids, not sufficient durability receipts: a deletion-only update need not advance an insertion clock. Persist contiguous producer receipts with the full state, including delete sets; otherwise the current `saved{sv}` rule can mark a deletion saved before it reaches disk. A retried sequence with the same hash is idempotent; a different hash is refused. A reconnect keeps its authorized producer binding, or moves retained edits through recovery rather than forging the old identity.

### Disk consistency

One mutation executor owns document integration, observed outside versions, conditional writes, capture, and rebase. Before a Smithers replacement:

1. Establish a document ingress cutoff outside the lock, so prior mirror updates reach the daemon. Later edits remain queued and visibly unsaved.
2. Exclude unmanaged races using the qualified writer coordinator: prevent session admission, briefly freeze managed writers, and settle outstanding I/O on the actual guest filesystem. The daemon's transaction worker stays outside that tree.
3. Drain observations and read current bytes. Persist any displaced outside version, full CRDT state, exact output bytes, original modes, transaction identity, and receipts in a prepared journal; fsync before replacement.
4. Replace and fsync file/directory, durably settle the journal, then thaw. Only afterward emit `saved`.

Recovery settles or refuses an incomplete transaction before reopening writers. Do not unconditionally thaw on an exception; `machined.md`'s “always thaw” pseudocode is unsafe after a partial mutation. ADR 0003 already records both outside-save rollback loss and moved-parent escape counterexamples. Neither descriptor-relative lookup nor a daemon-only mutex excludes outside writers. Retain those counterexamples and extend them to document saves. Qualification must include hard links, moved ancestors, open descriptors, mmap, queued I/O, and services launched through IPC. Unsupported aliases must be refused explicitly.

Freezing every flush could violate the latency budget; it is a launch risk to measure immediately, not permission to substitute an unsafe swap. No network wait or Git capture belongs inside a ordinary file-save freeze. Routed multi-file patches use one bounded transaction and validate every source/destination before any mutation.

For outside saves, merge with `base = last durable document text`, `ours = current document`, `theirs = observed outside bytes`. Apply non-overlapping edits as minimal attributed CRDT transactions. On overlap, preserve the complete outside version before restoring live text, apply its non-overlapping hunks, and show **Changed outside Smithers · Compare**. Outside editors supply no trustworthy read base, so a stale whole-file save cannot always be recognized; recovery is the guarantee. A byte-for-byte copy of each conflicting outside save to an open document must survive even when the ordinary burst has not closed.

Smithers tools retain the mandatory full-file `base_digest` contract. Drain preceding document edits before comparison; reject a replacement based on old disk bytes if newer live edits would be overwritten. Return `stale_read` and require a fresh authoritative read. Successful writes enter Yrs through the same reconciliation adapter. Never auto-retry a destructive write merely with a newer digest.

Undo uses Yjs `UndoManager` scoped to the local binding's origin; CodeMirror's independent history is off. Undo becomes a new shared edit and never rewinds another person's history. **Restore this file** remains a conditional new mutation; stale restoration opens Compare. Keep immutable before/after versions independently of CRDT garbage collection. Deleted/renamed documents pause editing and retain pending edits for Restore/Follow. Binary and over-1-MiB files remain read-only in the File card.

Reject OT because it introduces another collaboration engine and transformation server; reject Automerge/Loro because migration adds no demonstrated benefit over the existing wiki core. Reject whole-text replacement over HTTP and browser-to-guest sockets because they respectively lose edit intent and duplicate authorization/transport. A host-only code document cannot honestly acknowledge a guest disk save.

## 4. Attribution and change tracking

Use one actor envelope throughout:

```text
{participant, kind: person|agent|outside, member?, for_member?,
 session?, run?, via: app|ssh|terminal|tool, evidence: routed|kernel|unknown}
```

Authenticated Smithers calls give exact attribution. Agent local calls require `SO_PEERCRED`, the agent UID, and a registered run cgroup; shell writes use the same kernel observation path as human commands. File ownership is not authorship: daemon saves deliberately change ownership, and shared files are writable by many members.

The current `attrib.rs` policy cannot meet exact simultaneous SSH attribution. CPU activity is correlation, and inotify supplies no writer identity. Keep inotify for invalidation and overflow reconciliation, but replace the heuristic with kernel-origin write observations that capture UID, cgroup identity, inode/mount identity, operation, and rename linkage while the writer exists. Use a main-pinned guest kernel probe to choose supported fanotify/audit/eBPF instrumentation before committing to one; delayed `/proc/<pid>` lookup alone is insufficient for short-lived formatters or PID reuse. The root broker owns observation setup; unprivileged code processes bounded metadata. This expands deferred kernel attribution specifically to satisfy this brief, not to restore Pair.

If evidence is incomplete, record `outside/unknown`, preserve bytes, and surface the monitoring failure; never invent Maya as the author. Exact attribution under normal supported SSH/editor operations is a launch check. If the kernel probe cannot establish it, report the contract blocker rather than silently declaring the old heuristic sufficient. Attribution identifies the executing principal, not who morally caused an agent or script to act.

Reuse `burst.rs`, `versions.rs`, and the outbox. Close bursts after 1.5 seconds quiet or ten seconds total, grouped by proven actor/session; close an intersecting burst before another actor takes over a file. Emit immediate `file_written{path, post_digest, actor}` hints within 200 ms. Durable activity waits for immutable versions and host commit: “Maya via SSH changed 12 files.” Preserve mixed provenance when several writers contribute to one file; do not assign the entire merged text to its last writer.

“Every change recoverable” means each routed mutation and each external burst end state, plus each displaced conflict version for an open document. It does not promise every intermediate byte inside a running formatter. Ignored dependency/build paths do not generate activity. Overflow rescans restore current truth and record uncertainty, never fabricated authors. Agent change notes use committed event identities and arrive before its next tool call.

## 5. Sessions, identity and terminals

Retain stable member UIDs from 20000, `agent=19999`, `machined=19998`, private per-machine 0700 homes, `root:team` working-copy directories, and umask 002. Provision newly admitted members safely; never mount a common writable home across machines or copy login tokens. Only the minimal broker runs as root. The image contains no sudo, member sshd, or privilege-escalating helpers.

Complete ADR 0004 `SessionRPC` once for PTY, exec, SFTP, and guest-loopback TCP. Every descendant remains in its broker-owned cgroup. Existing SSH authentication on port 2222 maps branch usernames and GitHub keys to this broker; preserve exit status, signals, resize, EOF, and credit windows. Do not put a second sshd or process supervisor behind it. SSH presence reports the last observed saved file, not an invented cursor position from VS Code.

Retain `TerminalSessionManager` fan-out and its 512-KiB replay ring. Only the owner may send input, resize, signals, or close; watchers consume output without controlling the process. Slow watchers are evicted independently. The agent's Bash tool uses its own run-owned PTY, with trusted command completion framing separate from printed output.

Revocation removes grants, credentials, subscriptions, queued turns, and active execution within five seconds. Add a short execution authorization lease renewed on the authenticated daemon connection; expiry must leave enough time for `cgroup.kill` and `populated 0` inside that bound. A transport's 30-second reattachment window cannot authorize a removed user's processes for 30 seconds. On lost authorization connectivity, terminate affected sessions and require fresh authorization; availability yields to revocation. Tokens in guest homes are session-bound delegated credentials only; person authority and provider secrets stay on the host.

## 6. Presence and live updates

Keep one `/api/live` WebSocket per tab and the existing broker/DurableStream machinery. Complete `branch:<id>`, `:activity`, `:files`, `conversation:<branch>`, `members`, private `view:<member>:<branch>`, and `doc:code:<branch>:<path>`/`doc:wiki:<page>` sources. Terminals keep their existing sockets. Machine traffic keeps ADR 0004's authenticated multiplexed byte stream and golden codecs.

Snapshot and replay need an atomic source watermark: subscribe/buffer changes, obtain snapshot plus cursor consistently, then replay strictly after that cursor. PostgreSQL notification is a hint, not durable history. On retention gaps or a 2-MiB socket budget overflow, send `gap` and rebuild; documents exchange state vectors and retransmit unacknowledged transactions. Deduplicate by event identity and reject old connection generations. Presence is intentionally ephemeral: reconnect obtains a fresh roster, not historical “online” deltas.

Reuse `BranchPresence.ts` and its bridge: leases keyed by branch/participant/session, ten-second heartbeats, thirty-second expiry, branch projection coalescing at four Hz. During startup or a missing source, presence is unknown and cannot trigger sleep. Remote carets use Yjs relative positions through awareness, separately throttled; server supplies actor/colour and strips spoofed identities. Presence aggregates avatars by participant while retaining session locations.

Qualify an initial envelope of eight active editors, twenty viewers, and ten open 1-MiB documents per branch, plus terminals and a busy agent. These are proposed test loads, not measured capacity claims. Measure CRDT metadata growth separately from text size; evict idle mirrors only after daemon synchronization and apply admission/backpressure before memory exhaustion.

## 7. Shared conversation

Finish `internal/chat/{branch,shared,store,history,dispatcher,preflight}.go`; do not create another chat store. Lock conversation admission and retain the database constraint for one running turn. Queue simultaneous prompts by durable admission order, deduplicate their idempotency keys, and order output with the existing replay cursor. Append prompts with their authors and replies as “Smithers for Ben.” Each queued turn revalidates its author when starting and mints its own delegated credential; it never borrows the previous speaker's role.

The host app agent dispatches through the shared catalog. Repository code and the coding agent remain in the branch machine. Context preflight reads a fresh authorized snapshot, relevant branch facts, pinned wiki revisions, and pending agent questions; the displayed transcript is not automatically fed back as privileged context. Outside file-change notices are untrusted data. A steer does not settle a question; an Answer records its author and settles the identified question once.

Shared reads require current branch membership on every request and reconnect. Stop/revoke invalidates the running credential and prevents late output from a fenced producer. Drafts, Confirm cards, and per-member view state never enter shared streams or model context. Legacy personal conversations remain owner-only read-only Earlier history. External-agent imports are read-only records, never executable prompts. Delete `app_timelines` and the browser tool loop at shell cutover; preserve the existing archive decoder.

## 8. Failure and durability

| Failure | Required outcome |
| --- | --- |
| Browser/network loss | Keep unacknowledged transactions and exact text in a branch/member/epoch-scoped local recovery store, extending the wiki persistence pattern to code. Reauthorize before replay; epoch mismatch offers Reapply/Copy. Never label locally retained text saved. |
| Host restart | Recover PostgreSQL turns/leases and event receipts; rebuild mirrors from daemon state. Host restart ends terminals under the existing contract. Presence starts unknown. |
| Daemon/VM crash | Kill orphan session cgroups before readiness; replay prepared file transactions and outbox, retain CRDT identities, reconcile disk, then admit sessions. Missing/corrupt records create an explicit recovery state, not silent reseeding. |
| Sleep/wake | Require safe idle, flush documents, close bursts, capture, transfer objects, and drain acknowledged outbox before stopping. Keep disk/homes. Reads use the host snapshot without waking; work requests admission asynchronously. |
| Rebase while typing | Establish a mirror cutoff, freeze writers, drain observations, and capture locally without waiting for host acknowledgment. Journal the rewrite, reconcile documents against the captured base, retain overlapping queued edits for Compare, then resume. Later tool writes recheck bases. Never replace Yjs state with freshly seeded text. |
| Disk full or persistence error | Refuse save acknowledgments and further destructive replacement; retain recovery material and show failure. Cleanup cannot delete a machine whose final capture is incomplete. |

Never lose an acknowledged document mutation, a committed turn/event, or an acknowledged capture under process restart with retained storage. Unacknowledged browser edits are recoverable while their local recovery store survives. Permanent loss of guest storage before host capture is outside that save guarantee and requires backup; do not describe guest fsync as off-machine replication. Rebase cannot promise semantic correctness, but can preserve both inputs and refuse ambiguous resolution.

## 9. Reuse map

Inspection used checkout `f28cbf01cf8c` and local `origin/frontrun` `c6cd368f7b11`; their only differences were three COL-01 control-harness files, also inspected read-only. Several “missing” statements in the brief are now partially outdated; no production readiness is inferred from component tests.

| Area | Keep / reshape / delete / net new |
| --- | --- |
| Machines | Keep `internal/services/workspace_branch_machine*.go`, `workspace_machine_queue.go`, `internal/compose/branch_machines.go`, `workspace_shares`, and runtime admission. Finish member access and canonical provisioning; remove remaining owner-only assumptions. Existing member integration tests mean this is not wholly new work. |
| Daemon | Keep `crates/smithers-machined/src/{broker,session,stream,credit,watch,burst,versions,doc}` and `internal/machined/{registry,sessions,wire}`. `main.rs` still exits 78; net new work is startup, authenticated dispatch, capture/outbox composition, and supervision. `SessionRPC` still requires a real provider. |
| Files | `internal/services/workspace_facets.go` already requires digest-based batches; qualify and compose its provider rather than adding another write API. Keep the agent read ledger and ADR 0003 race fixtures. Replace the interim guest mutation path at daemon cutover. |
| Live | Keep `internal/live/{conn,hub,docrelay}.go`, `internal/compose/live.go`, and `runtime/LiveChannel.ts`. Members, branch, and conversation source code now exists; verify actual composition. Net new host mirror uses the existing shared Yrs binding. |
| Editor/wiki | `runtime/{LiveDocProvider,FileDocuments}.ts`, `cards/liveDoc.ts`, and `views/CodeEditorView.tsx` already exist behind prerequisites. Extend receipts, recovery persistence, carets, and production wiring. Replace `wiki/CloudWiki.ts` POST/SSE transport with this provider and delete the replaced routes/queue at cutover. |
| Sessions/SSH | Keep `internal/routes/terminal_session_manager.go`, `CloudTerminalClient.ts`, and `internal/ssh/`. Replace branch terminal `msb exec -t` ownership with daemon sessions. Keep Plue's composition-selected private bridge; `~/plue/apps/backend/internal/composition/ssh.go` already imports the shared backend SSH package. Add no product code there. |
| Conversation | Keep existing `internal/chat/` storage, shared reads, queue, revocation, and preflight work. Finish shell migration and retire `routes/app_timelines.go`, its service/queries, and browser execution paths together. |

## 10. Build plan

These are implementation slices under existing tickets, not newly created issues. Each takes roughly one to four agent-days; estimates exclude waiting for reference-host access and owner qualification. Fix interfaces first, then assign disjoint files in parallel; this design performs no implementation or delegation.

| Order | Slice and ticket ownership | Proof required |
| --- | --- | --- |
| 1 | Two days: freeze actor/session binding, boot fences, exact save receipts, document cutoff, and failure contracts in ADR 0003/0004 and shared codecs; COL-03r/08b/10. | Literal Go/Rust/TS golden frames; deletion-only receipt, duplicate/hash mismatch, malicious author, stale boot tests. |
| 2a | Three days: reference-host topology and freeze/attribution feasibility; COL-01/11, TRM-06. | Real guest filesystem, second-device browsers, short-lived concurrent formatters, mmap/rename/rollback faults, raw latency samples. No acceptance from laptop numbers. |
| 2b | Three days: compose daemon startup and authenticated dispatch; COL-03a/03. | Real boot/restart, privilege drops, readiness refusal, object transfer, outbox replay, killpoints. |
| 2c | Two days: finish branch membership/canonical identity and admission; MCH-04/06/11. | Real PostgreSQL concurrent joins create one machine; member removal preserves disk; queue cancellation and capacity accounting. |
| 2d | Three days: complete conversation shell/source cutover; APP-16. | Real PostgreSQL simultaneous prompts, crash leases, revoked authors, private archive isolation; two-browser identical ordering and independent view state. |
| 3a | Three days: session RPC/broker and revocation lease; TRM-07/01/02. | Real process descendants, timeout, flow control, half-close, reload, watcher input rejection, partition plus revoke under five seconds. |
| 3b | Three days: journaled conditional mutation/capture; COL-10/03/05. | Real-disk stale multi-file refusal; process/VM death at every journal boundary; late outside save survives rollback. |
| 4a | Three days: SSH and agent terminal adapters; TRM-03/05. | Actual VS Code/Cursor connection, SFTP, local forwarding, command result framing, distinct homes, agent watch-only terminal. |
| 4b | Three days: kernel attribution and watcher/activity integration; COL-04a/04/06/12, APP-11. | Concurrent users/agent, rename, overflow, ignored paths, real PostgreSQL receipt deduplication; twelve-file SSH formatter and Restore in browser. |
| 5a | Four days: daemon documents plus host mirror; COL-08a/08b/08. | Shared Yrs differential/convergence tests; overlapping outside save; fsync crash matrix; transport fairness under saturated terminals. |
| 5b | Three days: File binding, carets, local recovery and wiki cutover; APP-14a/14, UI-19, COL-09. | Two-browser same-line typing, deletion-only save, selective undo, epoch change/reload, wiki revision durability, keyboard and both themes. |
| 6 | Three days: integrated release rehearsal and cleanup; existing J3/C-DUR/C-PERF owners. | Real Mac microVM plus second laptop; sleep/wake, rebase while typing, host restart, stale external save, permission revocation, no duplicate implementation remaining. |

Stage 1 blockers precede stage 2 acceptance; stage 3 acceptance follows the shared machine/session path. Component lanes may build against fixed contracts in parallel, but unavailable providers remain explicitly unavailable. Use meaningful unit/property tests first, real PostgreSQL integration independently, then browser and real-machine checks. Bind receipts to the actual landed SHA and host; automated lane passes and markers do not substitute for manual or reference-host evidence.

## 11. Risks and open questions

- **Writer exclusion may be too slow or incomplete.** Run the retained rollback/ancestor probes plus queued-I/O and mmap cases inside the production filesystem before broader implementation. If exclusion fails, neither stale-write nor document-save launch claims stand.
- **Exact outside attribution may require unavailable guest kernel support.** A one-day capability and two-user formatter probe must establish identity at operation time, rename linkage, and overflow behavior. Escalate a failure as a specific brief/spec conflict; do not disguise correlation as proof.
- **Host mirror may solve visibility but miss saving.** Measure separate browser-to-viewer and browser-to-fsynced-receipt histograms. The same sample must verify eventual byte/CRDT convergence. Keep the existing topology decision procedure authoritative.
- **Yjs authorization/receipts may mishandle deletion or replay.** Fuzz foreign client IDs, protected maps, deletion-only transactions, reconnect producer reuse, and reordered receipts against fixed expected text and durability state.
- **Revocation and reconnect semantics conflict.** Partition the daemon immediately before member removal; prove all descendants stop by five seconds. If the current 30-second session grace is retained unchanged, the requirement fails.
- **Metadata and recovery storage can grow without bound.** Replay a week-equivalent edit workload, measure full CRDT state and immutable versions, and exercise compaction with returning clients. Do not GC recovery data still referenced by unacknowledged transactions or Compare.
- **Shared source code may still be incorrectly composed.** Begin each lane with one request through the actual install entry point. Treat unsupported providers as an integration blocker, not a reason to create a fallback service.
