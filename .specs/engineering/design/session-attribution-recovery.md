# Session attribution through recovery

Status: implementation plan from the integration audit at `a80b8b447ab4`,
2026-10-07. Tracked under [#3532](https://github.com/smithersai/smithers/issues/3532).
This records an unfinished dependency of production machine-event activation;
it is not an acceptance receipt or a change to product scope.

Implemented: immutable actor-reference storage, commit-before-launch member
terminal admission, protocol-3 session references and pre-spawn run binding,
principal-reference resolution in the burst/hint transaction, and broker-owned
reference inheritance for local PTYs and local writes. The installed sampler
emits the reference instead of a numeric session actor. Failed launches retain
ownership until confirmed cleanup, without granting local launch authority.

The terminal host commits before acquiring the roster transaction held through
spawn, then rechecks membership and machine lineage. Older live peers refuse
attributed launches; old request and actor recordings still decode. Late
`register_run` requests can only confirm the already-admitted run.

Still unfinished: migrate the coding launcher that uses the older execution
adapter, direct host writes, document edits and rewrites to these same committed
references; prove the installed cgroup/restart path on a real
machine. These component checks are not installed recovery acceptance.

The production event consumer no longer resolves legacy session/run actors from
live presence or mutable run checkpoints. Exact completed legacy bursts replay
against their committed payload digest without creating new activity. Split
bursts recover the original author from retained staged parts only when the
logical burst, actor envelope, immutable versions and part count all match.
Unknown legacy identities and hints return an explicit historical-authority
recovery error; their durable outbox entries remain unacknowledged. Old recorded
activity remains readable. This is historical recovery, never new authorization.

Protocol 4 adds broker-confirmed cancellation of one session cgroup. Coding
command migration must use this receipt, rather than treating stream close or a
process-group signal as proof that detached children stopped. Failed cleanup
retains the original actor and fences further use without killing sibling
commands in the same run. This is a required execution primitive; the older
coding launcher has not yet been replaced.

Protocol 5 makes document author maps and awareness use lossless hexadecimal
keys for opaque principal bytes. The host sends the admitting actor on open and
synchronization, preserves each subscriber's actor on edits, and discards cached
unreceipted edits when the authenticated boot changes. Stored author maps remain
readable. The installed Rust document service exists. Go composition now binds
its document host to committed member attribution, current write-share/lane
authority and the authenticated machine registry. The former injectable relay
authorizer/connection is removed. The host stays unmounted by default until the
real-machine document activation checks pass; component tests are not activation
evidence. These cross-language component receipts
do not complete that wiring or prove installed save/restart behavior.

## Required behavior

[Engineering spec §9](../spec.md) requires observed edits and external-agent
records to retain their real attribution through close, revocation, reconnect
and replay. Attribution describes an earlier action. It must never grant
permission to start another action. Current membership and the ordinary command
authorizer still control writes and reads.

The host must commit the attribution identity before admitting a process that
can produce an event. An event must remain attributable after both processes
restart, after a member is removed, and after numeric session IDs are reused.

## Recovery findings and remaining gaps

- [SessionPresence](../../../packages/backend/internal/machined/session_presence.go)
  requires a ready connection and an open in-memory session. That is correct for
  live presence, but cannot resolve queued historical events before wake readiness.
- Legacy [session RPC](../../../packages/backend/internal/machined/rpc_streams.go) records
  user, run and transport after receiving the daemon reply. Close and kill remove
  the transport entry; reconnect constructs a new link. Saving this same mapping
  to SQL after the reply would still lose attribution if the host crashed between
  process launch and that save.
- [The broker supervisor](../../../crates/smithers-machined/src/broker/supervisor.rs)
  allocates IDs from `next = 1`. Its counter survives a daemon-child restart while
  the broker lives, but resets when the broker is reconstructed. Retained outbox
  entries outlive that counter. `(branch, session number)` is therefore not a
  durable identity. The daemon instance in the handshake does not accompany each
  retained event and cannot identify an older event after restart.
- [Installed observed-write attribution](../../../crates/smithers-machined/src/installed.rs)
  now emits the committed principal reference from broker entries. Legacy
  `Actor::Session(id)` recordings use retained receipts only in production;
  current presence is never an authority for their earlier authors.

Do not use `SessionPresence` as the durable resolver, infer a former identity
from today's roster, label an unresolved actor as outside, or treat the next
handshake's instance as the origin of every queued event.

## Implementation contract

Use the existing [ADR 0004 actor envelope](../../../docs/architecture/0004-machined-wire.md#identity-never-comes-from-the-machine).
The host creates an opaque attribution reference before launching a session.
The reference identifies an immutable row in the product PostgreSQL database;
it is neither a bearer credential nor a new authorization service.

The row binds the reference to the workspace and machine lineage, authenticated
person or already-authorized run, and transport. A run binding also retains its
sponsor and product role at admission. Bind from the existing authorizer and
runtime checkpoint, never from browser JSON, guest login, UID or transcript text.
Store no bearer bytes. Keep enough historical identity for removed members and
finished runs; current membership is not a prerequisite for replay attribution.

The session admission carries that reference to the broker before spawn. The
broker retains it with its existing session entry, including after close while
background children survive. The observed-write sampler and inherited local
sessions use this admission identity. Durable events retain it inside the
existing principal actor variant. Numeric session IDs remain transport and
presence identifiers and may be reused without changing historical attribution.

The launch ordering is:

1. Authorize the real request and resolve its current person/run and workspace.
2. Commit its immutable attribution reference in the product database.
3. Send session admission with that reference on the authenticated machine link.
4. Broker validates the request and current roster, binds attribution, then spawns.
5. Observed writes retain the reference in their durable event before delivery.
6. Host resolves that reference in the authenticated event's workspace/machine
   scope, verifies objects and commits the normal event receipt before ACK.

A lost launch reply can leave an unused reference, but cannot leave a launched
process whose events require an uncommitted host mapping. Reconnect and restart
reuse the recorded reference; they never mint replacement attribution for old
bytes. Unknown or cross-scope references refuse the event and retain its outbox
entry for recovery.

Run registration needs the same ordering. Do not start an unbound coding process
and repair its identity with a later `register_run` reply. Bind the authorized run
before execution, and make local child sessions inherit the parent binding.
External agents in member terminals retain their member-session identity;
transcript semantics cannot override observed-write ownership.

All actor-producing host paths must use the same immutable reference mechanism:
session admission, direct file writes, document edits and attributed rewrites.
Complete that migration together. Preserve decoding of old recorded actor
variants, with explicit legacy resolution from retained authoritative data.
An unresolved legacy session number must remain a visible recovery failure;
recording compatibility does not authorize guessing a person.

Adding the admission field requires a coordinated live protocol version update,
Go and Rust schemas, independent golden frames, broker request validation and
installed composition. Keep decoding existing recorded protocols. Require the
new capability before production session launch; never silently drop attribution
when talking to an older daemon. The session portion is implemented in connection protocol 3; the remaining producer paths still require migration.

## Required evidence before activation

| Boundary | Proof |
| --- | --- |
| Admission persistence | SQL failure/cancellation sends no launch; lost reply and host restart still resolve an event from the launched process. |
| Identity isolation | Another branch/machine, guessed reference, mismatched run/sponsor and revoked request cannot acquire attribution or launch authority. |
| Process lifetime | Close with surviving children, kill, revocation, exit and reconnect preserve past identity while enforcing current process permissions. |
| Counter reuse | Reconstruct broker, reuse numeric session 1 for another person, replay the earlier outbox and credit the earlier person. |
| Delivery ordering | Replay before readiness resolves without calling the live presence registry or deadlocking its lease fence. |
| Receipts | Duplicate, split-burst replay and failed ACK retain one activity entry and the same actor. |
| Runs and local children | The first write after spawn already has the bound run; child sessions inherit it; a replacement attempt cannot relabel old events. |
| Compatibility | Old records decode; missing historical authority is explicit; older live peers refuse the new launch contract. |
| Installed behavior | Real broker/cgroups, machine restart, authenticated Go/Rust transport and PostgreSQL prove the path beyond scripted peers. |

The remaining capture/reconciliation, moved-off and transcript writers must all
be mounted on the existing event pump before global activation. Keep the full
product and formal acceptance requirements open until their actual receipts
exist. This design is one dependency of that work, not completion of it.
