# C-PERF-06 occupied-rebase seam (T-STK-08 / T-REL-01)

The production adapter is `rebase-production.mjs`. The authenticated install
owns `POST /api/install/ack-delay {branch, delay_ms: 0|10000}` and
`GET /api/install/ack-delay?branch=<uuid>`. It delays one capture's wire ACK
**after** its transaction commits, without holding SQL, mutation or registry
locks. It binds to one ready connection, expires unused after 30 seconds, and
records `{id, branch, boot, event, sequence, state, withheld_ms}`. Reconnection
cannot consume an older window. An acknowledged host receipt does not prove
guest thaw or outbox drain.

The committed TODO `rebase_pending` now carries `onto_revision` (the stored
actual SHA) alongside its existing `onto` display label. The composed HTTP
admission test checks that binding against the independently created main
commit. This completes the pending-target seam; it is not a guest hold receipt.

T-STK-08's occupied-rebase producer still needs these evidence bindings before
the adapter can qualify C-PERF-06:

- The guest's exported JSONL observer records `phase: held` before the hold
  ends, then exactly one `phase: thawed` record for that same `{id, branch,
  onto}`. Its `clock` is `guest monotonic:<boot>`, and `start`/`end` are
  milliseconds from that clock. No client stopwatch qualifies a guest hold.
- A successful thaw record retains `failed: false`, `headChanged`,
  `approvalsCleared`, `localSnapshotQueued`, `acknowledgedBeforeThaw`, the
  exact local `capture: {boot, event, sequence}`, and
  `marker: {text, member, typedDuringHold: true}` from the guest document
  observer. The member is the authenticated numeric user ID as a string.
  Marker attribution cannot be inferred from the browser fixture filename.
- The public Branch activity entry binds `receipt_id` to that guest hold and
  `onto_revision` to the actual target. The adapter requires one new rebase
  entry and committed clearing of Rebase pending.
- A subsequent `phase: drained` guest record binds the same hold ID and
  capture event and reports `outboxDepth: 0`. The adapter independently reads
  the authenticated host delay receipt, matches boot/event/sequence, and
  records its observed duration. It never substitutes host ACK for guest drain.

The driver arms each delayed window after push/sync/pending and immediately
before Rebase now. It validates queued/thawed evidence before waiting for
acknowledgement. Once drain completes, the unified verdict also verifies the
host receipt and rejects reused windows or capture events. The production
adapter also binds the host receipt to the armed window and branch, and checks
the drain record against the hold branch, target, clock and full capture triple.
Scratch Git commands run only over the member's authenticated SSH connection, in the dedicated guest
clone `.smithers-perf-main`, whose main branch and configured GitHub remote are
checked before pushes. No Mac executes scratch repository commands.

These fields are a coordination contract, not fabricated observations or a
passing receipt. The guest producer, occupied execution and real lifecycle/root
qualification remain required. No machine qualification flag is added and the
browser C-PERF-06 fixme remains until its real guest path is proved.
