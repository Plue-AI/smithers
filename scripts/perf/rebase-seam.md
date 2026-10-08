# C-PERF-06 occupied-rebase seam (T-STK-08 / T-REL-01)

The production adapter is `rebase-production.mjs`. The authenticated install
owns `POST /api/install/ack-delay {branch, delay_ms: 0|10000}` and
`GET /api/install/ack-delay?branch=<uuid>`. Restoration (`delay_ms: 0`)
requires the armed `id` and `boot`: the registry compares them atomically before
release. A stale client cannot release a replacement window. A client that
never armed a window performs no restoration request. It delays one capture's wire ACK
**after** its transaction commits, without holding SQL, mutation or registry
locks. It binds to one ready connection, expires unused after 30 seconds, and
records `{id, branch, boot, event, sequence, state, withheld_ms}`. Reconnection
cannot consume an older window. An acknowledged host receipt does not prove
guest thaw or outbox drain.

The committed TODO `rebase_pending` now carries `onto_revision` (the stored
actual SHA) alongside its existing `onto` display label. The composed HTTP
admission test checks that binding against the independently created main
commit. This completes the pending-target seam. Main also contains the retained occupied
rebase path, public receipt attribution and automatic rebase coverage from
T-STK-08; pending-target/activity availability is no longer a dependency blocker.
It is not reference-host freeze or timing evidence.

The installed guest now writes `/var/lib/smithers-machined/rebase.jsonl` as
UID 19998 into daemon-owned state. It records `held` before freeze/capture,
`thawed` only after a successful rewrite/reconcile/thaw, and `failed` on an
RPC refusal. `start` and `end` use the kernel monotonic clock, which survives
restarts within the same guest boot. The clock and capture carry the trusted
boot ID; secrets and member-selected paths never enter the log. Diagnostic IO
failure or the 100 MiB bound stops observations without changing a rewrite or
ACK. Missing evidence cannot qualify a benchmark.

The local durable outbox append supplies the exact capture event and sequence.
The observer checks that sequence is still pending at thaw, then emits `drained`
only when actual authenticated ACK handling has emptied the durable outbox. A
rewrite that reuses an already acknowledged snapshot does not invent a new
capture receipt. The hold ID is `<boot>:<onto SHA>:<existing RPC request ID in eight hex digits>`.
Both authenticated peers already know those fields; the wire bytes and protocol
are unchanged. The stack retains that ID and the
actual target in its committed TODO fact and one public Branch `rebase` activity
entry, with system attribution and head-change/approval facts.

The adapter binds exported guest records to the branch using the owner-only
ACK endpoint's authenticated boot (including its idle response), then checks the
public activity receipt ID and target. `SMITHERS_PERF_REBASE_LOG` names an export
of the daemon-owned JSONL. The composed Linux proof runs the real installed
daemon and native jj through the person HTTP action, arms the owner-authenticated
ten-second window, observes thaw while the ACK is outstanding, and matches the
subsequent host receipt, guest capture and drained record. Its empty session
broker does not qualify cgroup writer freezing or a reference-host timing.

Still required before C-PERF-06 can qualify:

- Stage-3 document evidence `marker: {text, member, typedDuringHold: true}` from
  the guest document observer, with the authenticated numeric member ID.
- Export and qualification on the installed reference microVM, including real
  broker freezing, fresh/retained lifecycle and the root inventories/receipts.
- The second Mac and scratch GitHub run, with 100 samples in each ACK cohort.

The driver arms each delayed window after push/sync/pending and immediately
before Rebase now. Its authenticated client polls through armed/withheld to
acknowledged, requires the exact boot/event/sequence, and refuses cancelled,
expired, failed, replaced or prematurely restored windows. The composed HTTP
test drives this client through the full automatic ten-second restoration using
the real event transaction and wire ACK; its scripted peer is not guest proof.
The adapter also retains the observed held barrier and binds thaw to its exact
ID, branch, target, clock and start; duplicate held observations are refused. It validates queued/thawed
evidence before waiting for
acknowledgement. Once drain completes, the unified verdict also verifies the
host receipt and rejects reused windows or capture events. The production
adapter also binds the host receipt to the armed window and branch, and checks
the drain record against the hold branch, target, clock and full capture triple.
Scratch Git commands run only over the member's authenticated SSH connection, in the dedicated guest
clone `.smithers-perf-main`, whose main branch and configured GitHub remote are
checked before pushes. No Mac executes scratch repository commands.

These observations are diagnostic evidence, not a passing C-PERF-06 receipt.
Marker attribution and real lifecycle/root qualification remain required. No machine qualification flag is added and the
browser C-PERF-06 fixme remains until its real guest path is proved.

The artifact verdict and live adapter now share `lib/rebase-receipts.mjs`.
The adapter retains the originally armed window alongside held, thawed and drain
observations. Recomputing a verdict checks the held barrier against the thaw,
requires a successful rewrite and a marker observed during the hold, and binds
the ACK to that armed window and the drain to the complete capture identity.
Removing or changing these records fails the budget while preserving raw samples.
The composed native-daemon HTTP test also runs this verifier on actual guest and
owner ACK records and rejects changed branch, window, boot, sequence and thaw
facts. It supplies no document marker or reference-host qualification.
