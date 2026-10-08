# Machine host admission

The composed install binds the authenticated daemon registry to the repository
engine, durable capture receiver and current member roster. The installed native
broker supplies member terminal, SSH, SFTP and loopback forwarding sessions.
The former head reporter and unbound PTY path are retired on this install.

The runtime registers a host-authoritative branch, machine, boot id and newly
minted machine credential before planting. A new boot atomically revokes the
previous boot's authority. Boot ids cannot be reused in the registry lifetime.
Host restart loses this authority and requires fresh registration; retained
guest credentials must never be adopted from guest files.

The ADR 0004 adapter must verify the nonce proof through
`internal/machined/wire` before calling `Registry.Admit`. Admission compares the
credential with the registered boot and derives identity from that binding.
Invalid credentials close only the newcomer. A successful admission immediately
replaces and closes the previous connection without waiting for its reader.
Stream close must promptly interrupt outstanding I/O, as the existing runtime
relay does. The registry never holds its mutex during stream close.

Every admitted connection starts unready. The production adapter may call
`Reconciled` only after transferring the host head's objects, receiving the
object-stream close, completing `wake_reconcile`, and observing `status.ready`.
Stale replies and reader cleanup cannot affect a replacement lease.
`RequireReady` checks the lease and branch; it does not replace request
authorization or serialize an RPC with boot rotation. The dispatcher
must use this connection's stream, never look up a replacement after admission.

Admission requires the main-pinned bundle, the approved guest helper, current
branch and member authority, and a reconciled link. Missing providers or a stale
lease refuse before guest execution. The reference-host terminal chain check
compares source, bundle and approved helper before booting a VM; component and
HTTP fixtures do not substitute for that installed acceptance receipt.

The durable event dispatcher owns its authenticated lease. Every exit closes
that lease, including cancellation, persistence failure and missing writer or
database composition. Awake operations then refuse until a new connection
reconciles and replays the outbox. An exiting old dispatcher cannot evict a
replacement connection. Receipts commit before acknowledgements; projection
failures leave unacknowledged events retryable.

## Session seam (T-TRM-07)

### Current status

`internal/machined/sessions.go` provides host calls for `open_session`,
`tcp_connect`, `close_session`, `kill_sessions`, `register_run` and
`attach_session`. `Registry.Sessions` encodes these calls through the admitted
host connection. Wrong-branch, stale and unreconciled connections refuse before
sending. A nil transport returns `unsupported` without effects.
`SessionTransport.Stream` (also exposed by `Sessions.Stream`) uses that same
connection pump for bounded session frames. It enforces input credit without
blocking control replies, caps queued output at the credit bound, and accepts
output windows only for bytes delivered to the consumer. `Reattach` on a retained
stream reports delivered output and resends only stdin beyond the broker's
received offset; it refuses replacement boots. Close and confirmed user/run
kills wake readers. Window frames remain visible for gateway mapping.

The installed root launcher composes `broker/supervisor.rs` with the Linux
process owner in `broker/spawn.rs` and one-use installed admission. The child
permanently drops identity before reading the opaque binding, team environment
or exact delegated token. Members use private uid directories under
`/run/smithers`; the agent keeps the existing S1 credential location.
The generic unbound `msb exec -t` terminal path is removed. Missing installed
artifacts, authenticated links, current membership or credentials fail closed.

The Go `Terminal` consumer returns output credit when `Read` delivers bytes,
preserves exit status and signals, and sends stdin EOF separately from close.
Its reader and writer reattach within the broker's 30-second grace. Unread
output is replayed from the delivered offset; stdin resumes at the broker's
consumed offset. A replacement boot or revoked session cannot reattach.

The native repository adapter reuses `flows-jj` snapshot and operation restore,
and jj's native tree merge for local deltas. Rewrite checkpoints are private,
durable, and refuse symlinks, replacement and malformed operation IDs. The
composed host supplies authoritative heads, imports and transactional capture
and burst projection through its existing repository engine capability.

### Process ownership and stream replay

The supervisor uses the existing registry and `session_stream::Pipe`; it does
not add another process or credit model. It authorizes the current roster,
checks account binding and asks the session environment/credential provider
before creating a cgroup. The Linux process owner binds each child to that
held cgroup, creates a process group, installs only the team supplementary
group, permanently drops uid/gid, sets umask 002 and enters `/workspace` before
executing session argv. Account lookup reads protected passwd/group files;
it does not load NSS modules in the root process.

PTY allocation uses a held master and kernel-resolved slave. Resize and allowed
signals target broker-owned descriptors and process groups. SFTP uses the fixed
image server. TCP uses an unprivileged image relay restricted to a nonzero
loopback port, with stdin EOF mapped to socket write-half closure.

Each stream direction has 262,144 bytes of credit. Nonblocking descriptor reads
stop at zero credit. Input receives a window only after bytes reach the kernel;
blocked input and control frames need no immediate wire reply. Output polling
rotates between sessions and returns one frame per socketpair exchange. Exit
follows stdout/stderr EOF. Reattachment validates offsets before clearing the
grace timer, discards undelivered stdin before replay, and preserves descriptor
labels and terminal controls. Local streams drain only through their socket's
scoped polling path, never through host polling.

The root socketpair retains ADR 0004 control encoding. Its private stream
operations carry one validated frame or bounded registry query per exchange;
these are not new host wire messages. Agent-local admission uses SO_PEERCRED
and the kernel cgroup, and atomically inherits the parent session's registered
run. Only host `register_run` establishes that binding.

### Activation prerequisites

Admission requires authenticated/reconciled transport (T-COL-03), the wire
codec (T-COL-03r), measured protocol (T-TRM-06), trusted accounts (T-MCH-11),
trusted root startup (T-SEC-01), session environment (T-MCH-12) and credentials
(T-TRM-02). An unavailable provider refuses before spawning. Test-only kernels
exercise refusal and stream behavior; they do not qualify real users/cgroups.

Closed/exited registry entries remain attributable until confirmed cgroup
cleanup. PTY close sends HUP; exec/SFTP close drops stdin. Lingering descendants
are killed by user/run revocation or restart. `cgroup.kill` must reach
`populated 0` within the shared five-second deadline before removal or reply.
Failed cleanup retains the registry for retry and fences roster admission.
Root socketpair ticks enforce the 30-second reconnect grace even without host
traffic. Startup also cleans retained groups before starting another daemon.

C-COL-04, C-J3-06, the terminal cutover and installed root execution remain
unqualified until their real-host receipts pass. A cross-build or fixture
kernel is not evidence for privileged execution.

### Reuse decision (E-04)

A long-lived mode of `microsandbox/guest/smithers-guest.py` would retain its
one-shot managed-child lifecycle and separate JSON control path. Its `relay`
and `bridge` are transports, not authenticated session dispatchers. Reshaping
that helper would duplicate the specified daemon supervisor and shared credit
pipe. Use the Rust broker's lifetime module and shared credit pipe, retaining
validated descriptor cleanup and privilege-drop ordering from the helper.
Root qualification remains pending until the helper built from landed main
is approved. Source packaging and supplemental tests are not root receipts.


## Watcher changes and recovery

`session::samples` derives candidate identity from the authenticated broker:
all sessions of a member share `Person(uid)`, and registered agent PTY commands
share `Run(run_id)`. Agent exec hosts are excluded from CPU-window candidates;
their socket writes already have exact attribution. Missing counters, unknown
actors, changed bindings and overlapping participants remain outside changes.
The installed sampler emits the immutable host actor reference admitted before
spawn. Numeric session and run actors still decode for historical recovery;
neither representation grants authorization.

The shared `Ingestor` event pump routes bursts to `BurstIngest.Apply` with its
admitted connection and a scope derived from the host workspace row. Its
object provider must verify the parentless versions commit, indexed blobs,
`a/` and `b/` paths and post-digests. Missing objects produce no receipt.
The existing product event writer, file rows and machine receipt commit in one
transaction; post-commit notifications rebuild `:activity` and `:files` through
the shared live broker. Burst identity and payload fingerprints reject divergent
replays. Retaining the branch-scoped burst ref precedes the SQL commit and
acknowledgement. A ref failure rolls back all projected rows; a later SQL failure
leaves a safe immutable pin that replay reuses. Split parts stage in the existing
receipt table, bounded to 32 MiB and 4,096 parts. Staging acknowledges durable
receipt only; no activity is visible until the complete burst verifies and
commits. Reconnect recovers staging from PostgreSQL.

Activity uses persisted stream cursors on `/api/live`: a fresh subscription gets
the last 200 entries, reconnect gets subsequent deltas, and a missing cursor or
more than 200 replay entries yields `gap`. File projections remain readable
while the machine sleeps and do not wake it. File snapshots include each path's
last committed post-digest; open File cards re-read changed paths after a missed
hint or reconnect, without replacing unrelated cards.

Authenticated `file_written` hints go through the same event pump and shared
PostgreSQL LISTEN broker. They never create activity, file-version rows, receipts
or acknowledgements. The live adapter rebuilds and reauthorizes the branch before
attaching a bounded batch of transient invalidations. Missing attribution or an
unreconciled/replaced boot refuses publication. Hint loss is repaired by the
next committed burst snapshot. The single-owner install binds this consumer and
session-where publishing to its runtime registry. The installed launcher reads
its authoritative head from the locked host store and requires the consumer
before guest effects; it does not start a second event reader. Burst verification
and ref retention share the event transaction and repository maintenance lock,
including with a one-connection writer pool.

Person and agent attribution resolve committed host references within the event
transaction, scoped to the branch and machine. Session close, member revocation
and reused session counters do not change an earlier admitted author. Unknown
references refuse publication; bytes cannot name a member. Exact legacy burst
replays use their committed payload digest, and split bursts recover authors only
from matching retained parts. New legacy session/run events and legacy hints
without historical evidence refuse publication rather than consulting live
presence. The installed native coding host now commits an actor reference before
opening its agent broker session, binds the run before spawn, confirms it through
`register_run`, and requires broker-confirmed termination during cleanup. Direct
writes still need their dependency-owned admission migration. The document relay binds
committed member references to current membership, write-share, lane and machine
authority. An install mounts the document host only when `app.Config`
sets `LiveCodeDocuments`; the shipped install leaves it unset until ADR 0003 is
accepted and C-J3-04, C-DUR-04 K7 and C-PERF-03 pass on the reference host.
The host shares the wiki's native library and applies daemon receipts while it
sends, because the link closes when one document stream's queue overflows.
`TestLiveCodeDocumentsComposedInstall` drives two members through the composed
install with a scripted daemon peer; it is not disk or latency evidence.
The T-COL-05 moved-off event remains unavailable without its transactional writer.

`POST /api/branches/{b}/files/{path}` accepts the File seam's
`{action: "restore" | "restore-deleted", version, base_digest}`. The catalog
resolves the member; unknown fields, including actor overrides, are refused.
Only that branch's retained version can supply the before bytes. Its blob hash
is checked before the shared guarded write, using the recorded post-digest (or
`absent` for deletion). A stale file returns 409 without a retry or overwrite.

The install composes the authenticated object receiver, burst/capture consumer,
and live notifications. PostgreSQL, native Git, HTTP and live-socket fixtures
exercise these bindings, but do not qualify the real watcher, VM faults, root
broker, formatter or reference-host timing checks. Restore still requires the
runtime's qualified WorkspaceCompareWriter; it has no blind-write fallback.

The existing Git backing-store provider writes literal per-file blobs and parentless version commits without filters or hooks. The private watcher checkpoint pins its current and previous version sets before atomic replacement, and recovery validates burst identities, paths, modes and rename relationships. Corrupt or unsafe recovery files refuse startup instead of resetting history. Installed watcher composition remains required.

## Composed install consumers

`POST /api/terminals` persists a current member's branch request and terminal
reservation before launching machine or coding-host work. The idempotency key
recovers the same request after reload. The existing authenticated workspace
terminal WebSocket attaches owner input or watcher output; a watcher never
starts a terminal. Native-link and reservation state determine frozen cards.

The SSH gateway reserves each member channel before waking the machine,
consumes the same delegated credential and admitted session client, and closes
its persisted reservation on disconnect. SFTP runs the bundled unprivileged
server; forwarding runs the installed member loopback relay. The agent-only
TCP primitive cannot select a member identity.

Installed coding hosts run as registered agent sessions under the same broker.
Authorization locks cover spawn and run registration. An ambiguous registration
is repaired or fenced with confirmed revocation; process close alone is never
accepted as proof that an unregistered agent process was terminated. Shared
native branch access requires current membership and admitted host receipts;
legacy private boxes keep their single-writer restriction.

The current repository secret projection updates the protected tmpfs team
environment on authenticated ready links. New processes consume the latest
literal projection after dropping identity. Existing process environments are
unchanged. Link replacement, source refusal or membership revocation prevents
new admission; credential cleanup remains bound to its exact bearer digest.
