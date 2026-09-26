# Coordinator-owned request feedback

`steering.ts` is private repository configuration over the existing notification
queue. It adds no coding table, event type, or message transport. The two small
public library extensions used by this recipe are called out below.
The gateway keeps its existing `Control.steer` operation and actor attribution.

The configured request host supplies a queue decorator to the private native
composition:

```ts
const native = NativeControl.make(platform, resolveSeats, routeMessages)
// Include feedbackLayer in the existing module registrations.
```

`NativeControl.make` has one new optional third argument. It forwards the same
private `NotificationDecorator` to `LocalControl.layer`'s optional fourth
argument:

```ts
type NotificationDecorator = (
  queue: NotificationQueue.Service,
  control: ControlRuntime.Service,
  journal: Journal.Service
) => NotificationQueue.Service
```

The third decorator parameter is the already materialized **control journal**,
which is separate from the native engine's execution journal but contains its
mirrored `control.engine.event` records. A long native run therefore creates a
large control history too. The default
composition is unchanged. One decorated queue instance is shared by ControlLive
and the native executor. Admission runs in the caller's fiber and joins the
existing journal transaction; it opens no second database or transaction system.

For a root-addressed Message, the decorator reads the existing control run and
approved plan. Only an active `coding/request` run whose recorded digest and
`coding/Request` flow match receives the private coordinator lineage.
Lookup failures and invalid coding ownership refuse admission. Other flow roots,
explicit leaf addresses, Seat, Thinking and Tools retain their existing routes.
This is an all-Message coding policy: a provenance string is not proof that the
sender is a human. Cancellation and approvals keep their established paths.
The configured Message route also turns the queue's `rejected-full` decision
into `NotificationError(notification_full)`, so Control cannot acknowledge feedback that
the queue did not retain. The caller can retry after a coordinator boundary.

`ModuleOwner` is new private invocation data containing `{rootId, flowId}`. It
is installed by ModuleAuthority only after the existing native ancestry,
approved executable and active-run checks succeed again for that handler,
including on resume. The action never accepts ownership from a payload or
infers it from a native child ID. No construction-time owner is invented.

The coordinator composes an ordinary durable action at its safe boundaries:

```ts
ReceiveFeedback.call({ boundary: "after-poc", revision: 0 })
ReceiveFeedback.call({ boundary: "before-implementation", revision: 1 })
ReceiveFeedback.call({ boundary: "after-correction", revision: 1 })
```

The result is `FeedbackReceipt {boundary: string, messages: Notification[]}`.
Its boundary is the JSON tuple of actual native execution ID, named boundary
and revision. The queue's existing durable promotion receipt makes repeated
reads, including after reopening SQLite, return the same message identities.
Messages arriving later remain pending for a newer boundary. Empty receipts are
durable too. Model turns cannot consume the coordinator lineage; they still
receive ordinary settings at their existing turn boundaries.

After the action result is recorded, `appendFeedback(previous, receipt)` returns
an Effect containing the combined planning feedback or a `CodingError`. It
retains each notification's ID, actor and source provenance. The receipt matches
the queue's default bound of 128 pending notifications. The queue itself has no
byte limit; Control applies its existing mutation-size admission bound. The
planner's existing 65,538-character feedback bound is checked without silent
truncation. An overflow refuses planning and names the retained IDs: admission,
promotion and native receipt remain inspectable in the existing journals.

Receiving feedback is not a plan revision. A following `PrepareRequest` child
must complete with an actual validated Plan before the UI can show a revised
plan. Feedback during implementation waits for the coordinator's next safe
linear mutation boundary; this helper does not preempt an executing atom or
claim to pause on every prototype. The request recipe owns those transitions.
An empty `after-correction` receipt closes this coordinator to new messages.
Before admitting a Message, the decorator reads the existing promotion receipts
for this control run inside the same writer transaction as admission. The native
queue's final drain uses that writer too. The database therefore orders the two:
a message committed first is delivered by that drain; a new message after the
empty final receipt is refused, even while control completion is still being
projected. A retry of an already accepted notification retains its original
receipt. The caller starts a new request for a newly refused message.

Closure uses the queue's existing `Promoted` event, not a new event or status.
Only the exclusive coordinator lineage, a canonical
`[executionId, "after-correction", revision]` boundary, the matching native drain
source ID, source sequence zero, and an empty ID list prove closure. Non-final
boundaries and nonempty final receipts stay open. Other lineages do not close
this coordinator. Unreadable proof in its own lineage refuses admission.

**New public API: `Journal.entries` has an optional `eventTypes` filter.**
The nonempty list accepts up to 64 exact types. Filtering runs before pagination and uses the journal's new
`(run_id, event_type, seq)` index. The recipe calls it as follows:

```ts
const page = yield * journal.entries({
  runId: JournalEvent.RunId.make(rootId),
  eventTypes: [NotificationEvent.PromotedEventType],
  limit: 1000
})
```

The read remains inside the existing writer transaction, keeps canonical run
sequence cursors, and refuses compacted history. It reads at most 100 pages of
1,000 **promotion** entries and rejects oversized or non-advancing pages.
Projected engine records no longer consume that bound or get decoded for this
closure query. Other lineages' promotion receipts still undergo the normal
lineage check. The index is over the existing journal table; there is no new
store or projection cache. Custom journal adapters must implement the new
option before this configuration relies on it.

The existing notification queue also filters its cold/warm fold to Admitted and
Promoted events. Its 64-run cache retains the same pending state, historical
admission/promotion identity maps, and post-commit publication rules. Its cursor
is the last matching canonical sequence; a noise-only tail leaves it unchanged.
Saved-receipt `entryAt` reads still use the original exact sequence semantics.
No notification identity, duplicate proof, or promotion receipt is discarded.
If a future compaction policy advances the floor past that matching cursor, a
warm queue conservatively refuses the next read with `compacted`; it cannot
reconstruct notification identities from a deleted prefix. Current production
compositions do not enable compaction. Enabling it requires a queue-aware
retention or checkpoint policy first.

A synthetic SQLite fixture with 100,005 `control.engine.event` rows exercises
both the closure query and a full cold admission. The regression verifies that
volume in SQL, observes the real queue and closure reads, and requires their
event filters before decoding a page. A cold admission reads zero old rows and
then its one newly committed notification. The complete scenario bounds queue
reads and decoded rows by notification count, verifies one closure page per
steer, drains the five exact messages, and retains typed refusal after the final
empty receipt. Timings are local diagnostics, not a production latency promise.

The regression no longer executes the obsolete unfiltered queue as a timing
baseline. That artificial admission decoded 200,011 rows across 392 pages and
could exhaust the test's 60-second budget. Checking filters and read counts
directly catches the same regression without repeating that historical scan.

**New public error channel: `Control.steer` preserves `NotificationError`.**
The existing notification error schema gains stable `notification_closed` and
`notification_full` codes. Closing this coordinator returns the former;
capacity refusal returns the latter. A closed receiver requires a new request.
A full receiver permits retry after pending work drains. Ordinary Control
steering also checks `rejected-full`, so it cannot accept an unretained message.
Journal I/O errors still become `PersistenceError`.
The existing `notification_unavailable`, `notification_id_reused`, and
`notification_invalid` codes also now reach Control callers as
`NotificationError`, replacing the previous `PersistenceError` wrapper with
operation `control.steer.notification`.

The public service type, `ControlErrorSchema`, and the authenticated Steer RPC
declaration carry this existing error class. Deploy updated clients/UI with the
server: an older exhaustive RPC decoder can reject the unfamiliar variant, so
this is not fully wire-compatible with old error decoders. Successful receipts,
older error codes and source event shapes stay unchanged. See the owning
[control API](../../packages/smithers/control/docs/api.md) for an Effect example
branching on these codes without parsing messages.

Validation covers real SQLite queue reopen, repeated and empty boundaries,
mixed Message/Seat/Thinking/Tools delivery, unrelated roots and leaf lineages,
lookup/digest/approval refusal, rollback inside the caller's transaction, an
actual Action execution requiring invocation ownership, capacity refusal and
attributed overflow. Node and Bun both pass the eight focused cases, including
independent SQLite connections racing final drains with new admissions,
malformed closure evidence, and bounded pagination. The native module host test
asserts each executed child's actual approved root identity; its latest bounded
narrow-mode diagnostic passed with a temporary longer fixture timeout, which
was then restored. That diagnostic does not claim the normal three-mode gate
passed.
