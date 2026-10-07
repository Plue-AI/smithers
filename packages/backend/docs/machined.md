# Machine host admission

The runtime owns the host registry. Single-owner composition binds its roster
and bundle import/export to the embedded repository engine. Store selection uses
the admitted branch's database binding; remote repository clients grant no local
filesystem path. Bundle operations hold the engine’s repository writer lock
through verification and ref updates, excluding maintenance and GC. Daemon
planting, connection pumping and durable capture-policy
composition remain unavailable, so the existing reporter remains mounted.

Wake reconciliation transfers a bounded Git bundle over the authenticated
connection before sending `wake_reconcile`. The host waits for the daemon's
object-stream `close`; writing EOF alone is not a receipt. Stream IDs survive
reconnects within a boot, credit bounds memory, and cancellation, premature close
or refused transfer fences the connection. Missing object-store composition
refuses wake. File replies and write receipts must match the bytes' SHA-256.

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
authorization or serialize an RPC with boot rotation. The eventual dispatcher
must use this connection's stream, never look up a replacement after admission.

Activation still requires T-MCH-04's branch binding, T-INS-02's real microVM,
T-ACC-03's authenticated branch authority, T-COL-03r's codec, T-COL-03a's daemon,
T-COL-02's live publication, T-STK-12's durable pending-work delivery,
T-COL-10's digest-aware routes, T-SEC-01's hardened installer, T-INS-01's
main-pinned packaged binary and T-MCH-11's trusted guest identities/no-sudo
image. There is no activation entry point in this increment.

Boot authority is minted and published atomically before the old connection is
closed. Its ADR 0004 serialization is available to the installer, but no boot
file or credential is yet written to a guest. No new root step is active.
Working-together I6 installs `machine_event_receipts(workspace_id, event_id,
outcome, at)` with a primary key on `(workspace_id, event_id)`, and
`burst_files(event_id, path, change, before_blob, after_blob, post_digest,
renamed_to)` keyed by `(event_id, path)`. File rows reference the canonical
`product_job_events.event_id`; receipts survive activity retention and are
removed only with their workspace. Ingest must claim the receipt and insert
activity plus file rows in one transaction before acknowledgment. The tables
alone do not activate ingest or prove producer coverage. W3 and W6 own that
composition. The install migration command and migration replay constraints
are tested against PostgreSQL.

Unit tests cover registry
leases, revocation, reconnect admission and concurrent replacement; they are
not C-COL-01, C-COL-04 or C-DUR-04 acceptance receipts.

The durable event dispatcher owns its authenticated lease. Every exit closes
that lease, including cancellation, persistence failure and missing writer or
database composition. Awake operations then refuse until a new connection
reconciles and replays the outbox. An exiting old dispatcher cannot evict a
replacement connection. Receipts commit before acknowledgements; projection
failures leave unacknowledged events retryable.

The shared reporter, public head route and helper file commands must be removed
in the same change that migrates every supported provisioning caller to real
capture ingest. That cutover also moves pending-work detection into the
transactional captured-event path. It cannot use this registry alone.

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
process owner in `broker/spawn.rs`. Its environment/credential admission
provider remains unavailable: trusted account provisioning, daemon composition
and reference-host qualification must land before customer sessions can start.
S1 terminal ownership remains until that replacement passes its real checks.

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
Owner acceptance and root validation receipts remain pending. No helper or
terminal ownership code is replaced until the actual cutover.


## Watcher changes and recovery

`session::samples` derives candidate identity from the authenticated broker:
all sessions of a member share `Person(uid)`, and registered agent PTY commands
share `Run(run_id)`. Agent exec hosts are excluded from CPU-window candidates;
their socket writes already have exact attribution. Missing counters, unknown
actors, changed bindings and overlapping participants remain outside changes.
The wire actor remains a session reference for host resolution, not a grant.

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
while the machine sleeps and do not wake it.

`POST /api/branches/{b}/files/{path}` accepts the File seam's
`{action: "restore" | "restore-deleted", version, base_digest}`. The catalog
resolves the member; unknown fields, including actor overrides, are refused.
Only that branch's retained version can supply the before bytes. Its blob hash
is checked before the shared guarded write, using the recorded post-digest (or
`absent` for deletion). A stale file returns 409 without a retry or overwrite.

The object-store adapters are composed; the host connection pump is still
uncomposed. Component
PostgreSQL, HTTP and live-socket evidence does not qualify the real watcher,
object transfer, formatter or reference-host timing checks.
