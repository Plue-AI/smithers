# Machine host admission

T-COL-03's host registry is unmounted. It does not plant a binary, accept a
wire connection, dispatch an RPC, publish awake state or replace the reporter.
The existing reporter cannot supply boot authentication or connection leases;
the registry is new for those duties.

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

No root step is added. No boot file or credential is written to a guest.
The proposed `machine_event_receipts,product,planned:T-COL-03 owner:smithers-3f`
reservation awaits T-PRC-02's planned-row support and owner acceptance; the
current ownership checker treats it as an absent installed table. There is no
migration or transaction/ack implementation yet. Unit tests cover registry
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
running daemon; it does not implement a disconnect timer or session lifecycle.

### Activation prerequisites

Admission requires authenticated/reconciled transport (T-COL-03), the wire
codec (T-COL-03r), measured protocol (T-TRM-06), trusted accounts (T-MCH-11),
trusted root startup (T-SEC-01), session environment (T-MCH-12) and credentials
(T-TRM-02). Each unavailable provider must refuse through the production
root dispatcher. Agent-local admission additionally requires SO_PEERCRED and
a registered run. A host-interface test cannot prove these properties.

The broker must create processes only after privilege drop, retain lingering
cgroups after close, confirm `populated 0` before kill responses, and clear all
sessions before daemon restart. These operations, stream-frame dispatch and
the 30-second grace timer remain unimplemented in this slice. Terminal and SSH
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
