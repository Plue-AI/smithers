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

The shared reporter, public head route and helper file commands must be removed
in the same change that migrates every supported provisioning caller to real
capture ingest. That cutover also moves pending-work detection into the
transactional captured-event path. It cannot use this registry alone.

## Session seam (T-TRM-07)

### Current status

`internal/machined/sessions.go` provides host calls for `open_session`,
`tcp_connect`, `close_session`, `kill_sessions`, `register_run` and
`attach_session`. It has no installed transport. A nil transport returns the
ADR 0004 `unsupported` refusal before effects; cancellation returns the context
error. This seam is unmounted. S1 terminals still use the existing runtime.

The transport adapter must use `internal/machined/wire` on an authenticated,
wake-reconciled connection. The wire codec and daemon dispatcher own decoding
and their error envelope. The client uses the registry connection lease to refuse wrong-branch, stale
and unreconciled connections before calling its transport. The adapter must
bind RPC to that same stream; it must not look up a replacement connection.
Host validation checks login syntax, non-root uid,
request kind, argument encoding, sizes, port and stream-id range. It cannot
verify guest account bindings, local peer credentials or cgroup ownership.
Those checks belong to the root broker and daemon, before spawning.

### Stream replay

`crates/smithers-machined/src/stream.rs` wraps the shared `credit.rs` pipe.
Each sending direction retains at most 262,144 unacknowledged bytes and stops
reading at zero credit. Windows discard acknowledged bytes. Reattachment
uses cumulative consumer-delivered offsets, recovers lost windows and returns
only the remaining bytes without charging credit again. Offsets outside the
retained range fail without changing the buffer. Closing discards replay and
refuses further reads and reattachment. This module is not yet wired into a
running daemon. The separate broker lifetime module owns disconnect deadlines
and session lifecycle; transport mounting remains pending.

### Activation prerequisites

Admission requires authenticated/reconciled transport (T-COL-03), the wire
codec (T-COL-03r), measured protocol (T-TRM-06), trusted accounts (T-MCH-11),
trusted root startup (T-SEC-01), session environment (T-MCH-12) and credentials
(T-TRM-02). Each unavailable provider must refuse through the production
root dispatcher. Agent-local admission additionally requires SO_PEERCRED and
a registered run. A host-interface test cannot prove these properties.

The broker must create processes only after privilege drop, retain lingering
cgroups after close, confirm `populated 0` before kill responses, and clear all
sessions before daemon restart. The production library now provides the session registry, per-session 30-second
grace timer, immutable agent-run bindings and restart cleanup ordering in
`broker/sessions.rs`. Closed and exited entries remain available for watcher
attribution until confirmed cleanup. Reconnecting the host does not reattach
omitted sessions. `broker/cgroups.rs` holds protected cgroup-v2 directory
descriptors, writes `cgroup.kill`, and waits for `populated 0` against one
five-second deadline before removing each registry entry. Retained cgroups
are cleaned before restart; invalid retained names refuse startup.

The crate is now a buildable workspace library, including the existing credit,
replay, document and outbox components. It is not a runnable daemon. Spawn,
PTY allocation, signals, authenticated RPC/local-socket dispatch and transport
adaptation remain unavailable. The cgroup implementation has Linux cross-build
evidence only; no real-root integration acceptance is claimed. Terminal and SSH
cutover require C-COL-04 and C-J3-06 evidence; no root code from this branch is
installed or executed.

### Reuse decision (E-04)

A long-lived mode of `microsandbox/guest/smithers-guest.py` would retain its
single uid 1500, per-exec cleanup and separate JSON control path. Its `relay`
and `bridge` are transports, not authenticated session dispatchers. Reshaping
that helper would duplicate the specified daemon supervisor and shared credit
pipe. Use the Rust broker's lifetime module when its owning core lands, porting
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

The W3 event pump calls `BurstIngest.Apply` with its admitted connection. Its
object provider must verify the parentless versions commit, indexed blobs,
`a/` and `b/` paths and post-digests. Missing objects produce no receipt.
The existing product event writer, file rows and machine receipt commit in one
transaction; post-commit notifications rebuild `:activity` and `:files` through
the shared live broker. Burst identity and payload fingerprints reject divergent
replays. Retaining the branch-scoped burst ref precedes acknowledgement, and
replay repairs a failed ref publication. Split bursts are refused until their
complete assembly is supplied; no partial activity is acknowledged as complete.

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
