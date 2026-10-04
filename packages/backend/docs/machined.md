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
