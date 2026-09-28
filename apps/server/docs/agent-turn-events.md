# Durable turn output

`TurnJournal.ts` implements the acceptance and output store. The public Worker
turn POST and native Bun host use `DurableTurn.ts` to publish committed batches.
The native host keeps the same protocol in file SQLite. Browser integration
stores logical attempts, continuation legs and applied cursors in the local
event projection; its full browser and privacy composition is being verified.
Legacy requests without `journal` still use the original transient transport.
These source changes are not deployment claims.

## Three separate acknowledgements

1. A local intent receipt permits an initial request to leave the browser.
2. A backend acceptance receipt grants exactly one producer permission to
   invoke inference for a stable `(runId, legId, requestHash)`.
3. A local applied receipt means the browser committed an output batch and
   the resulting projection together with its backend cursor.

An HTTP connection is none of those acknowledgements. A tool continuation is
a new leg under the same conversation turn. A reconnect must read the existing
leg; it must never invoke the model again to manufacture its missing output.

## Implemented internal protocol

`packages/rpc/src/AgentTurnJournal.ts` contains versioned schemas and a pure
batch projection. Acceptance retains hashes of request, authenticated owner,
read capability and producer capability, an explicit acceptance time, and
stable turn/leg identities. Raw prompt/context bytes and raw capabilities do
not belong in acceptance metadata.

The host must compute the owner hash from validated identity, and require the
read capability as well. Public input must never be trusted to supply its own
owner hash. Anonymous turns need a fresh unpredictable capability persisted
before the initial request. Ownerless historical cancellation records do not
authorize output replay. A signed-out turn's cancel registration is owned by
the salted address bucket its anonymous ceiling spends, so only a visitor at
that address can cancel it. The current internal endpoint is reachable through
the namespace binding, not the public HTTP router.

Acceptance is one durable head write. A matching repeat returns `existing`,
including after completion, and never returns a producer capability. A changed
request under that identity conflicts. Retirement permanently refuses reuse
of that identity. No timeout converts an accepted request back into permission
to execute it.

Each batch contains its exact decoded frames, increasing batch and frame
positions, predecessor hash, scope and canonical SHA-256 digest. At most the
last frame is terminal. The pure fold produces a new cursor, total encoded
bytes and terminal state. `verifyTurnJournal` reconstructs this head from
acceptance and every committed batch and compares it with the served head.
Existing acceptance, reads and appends audit that prefix on the first request
in a recreated object and whenever its head is unknown. A cache advances only
after a successful protocol write under the same mutex; it relies on the
object's exclusive ownership of immutable accepted batches. Authorized
retirement can still erase a corrupt prefix.

Writes stage one batch and then replace the single head. The head is the
visibility commit: readers only inspect its accepted prefix. A crash before
that commit leaves a hidden staging batch; a retry may replace it. A crash
after that commit but before its receipt returns an exact duplicate receipt.
A different batch cannot overwrite accepted output.

The internal reader checks owner and capability before reading output, rejects
foreign or invented cursors, and drains bounded pages. Unknown versions,
missing batches, changed output, broken links and a mismatched head refuse
recovery. Failure responses contain no saved output. The current proof covers
1,006 frames across pages and a recreated durable-object instance.

Retirement first commits a content-free tombstone. Reads and producers then
refuse the old identity even if deletion is interrupted. It erases every batch
and the one possible staging batch, recording deletion progress so a later
attempt can finish. Hosts without delete support refuse the operation. The
delete-only route also handles absence: null owner/acceptance hashes record
that erasure won before acceptance. A delayed POST cannot create output under
that identity. The browser stages deletion proofs before discarding readable
tokens. There is no account-wide inventory of journals: erasure covers
identities the client retained. External backups and a lost client database
remain separate retention/recovery concerns.

## Platform and retention bounds

Every Worker journal object schedules a Durable Object alarm seven days
after its first write, before that write: acceptance for output, the
tombstone for an erasure that found no leg. The alarm deletes every batch,
then the head, so saved output and tombstones never outlive that window.
Retiring a live leg keeps its acceptance alarm. The native SQLite host has no
alarms; its device-local output lives until the browser retires it.

The native object's lifetime mutex covers both its legacy cancellation
protocol and the new journal. Production relies on the platform's unique
object ownership; a test that constructs two independent objects over one
uncoordinated memory map is not that deployment model. Cloudflare documents
[unique objects and concurrency rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
and its [storage limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

The logical encoded budget is 96 KiB per batch, 8 MiB of retained output and
8,192 batches. A storage host may reject a value below that JSON budget because
its serialized representation differs; a rejected stage never advances the
head. One small terminal frame is reserved beyond the ordinary total limit.
The producer must record the reason it stopped. It may not silently discard
output and claim a complete reply. The producer groups up to 64 frames or
250 ms per batch, with at most 768 ordinary append calls (including exact
lost-receipt retries), leaving room for cancellation monitoring and cleanup.

## Public and native transport

`POST /api/agent/turn` accepts optional `journal: {version: 1, legId, token}`.
Fresh acceptance returns NDJSON with `x-smithers-turn-journal: 1` and delivery
variants `accepted`, `batch`, and `caught-up`. A matching repeated POST returns
JSON `{status: "existing", cursor, terminal}` under the same protocol header.
Its cursor is the backend head, **not** evidence that the browser applied that
output. Reconnect reads from the browser's persisted cursor (or null).

`POST /api/agent/turn/replay` takes `{runId, journal, after?}` and returns up to
eight batches plus `after`, `next`, `head`, `more`, and `terminal`. Each bounded
Worker read checks current account identity and replay capability. Anonymous
output is bound to its capability. Native reads additionally require the
current authenticated loopback session; local ownership is device-based.
Neither replay nor repeated acceptance spends model capacity. The Worker reads
the leg first; only a leg with no saved head spends the existing abuse budget,
and it spends it before the acceptance write. A budget refusal is the ordinary
429 `turn_rate_limited` answer and leaves no journal object behind.

`POST /api/agent/turn/retire` remains the authenticated raw-capability route.
The deletion outbox uses `POST /api/agent/turn/erase` with
`{runId, legId, retirementProof}`. The proof is
`SHA256(agentTurnJournalDigestInput("access", replayToken))`. It permits only
erasure, works after account sign-out, and cannot authorize replay: replay
requires the original token and, for an owned Worker leg, its current account.
Both paths retain public origin checks. The native host also retains its
local session check. Only `{status: "retired"}` acknowledges completed erasure.
The Worker erase route needs no session, so it first spends a per-address
bucket (`erase:` plus the anonymous address digest, 600 per hour); a refusal
writes no tombstone, and the outbox keeps the obligation for its next pass.

Output batches commit before HTTP publication. Disconnect, malformed output,
truncation, and retention exhaustion record terminal observations when storage
remains available. After an uncertain append, the producer reads the actual
head before adding a failure; it cannot skip unseen output in the live response.
Producer death after acceptance without terminal evidence remains ambiguous.
No deadline or reconnect grants permission to execute it again.

Native storage lives at `<stateDir>/chat-journal/turns.sqlite`. A private
directory, kernel process lease, per-object mutex, WAL and synchronous FULL
writes enforce exclusive protocol ownership. Shutdown cancels producers and
awaits stream finalizers before closing SQLite. Completed retirement uses
secure deletion and truncates the local WAL. A reader holding an older SQLite
snapshot can prevent truncation without causing SQLite to throw; the host checks
the checkpoint result and returns retryable 503 until the WAL is drained. The
durable deletion outbox keeps its proof until that acknowledgement succeeds.
Retirement does not erase external copies.
Hosts without a configured persistent directory refuse durable turns before
model invocation. The headless launcher uses its own persistent `headless`
directory, overridable with `SMITHERS_LOCAL_STATE_DIR`.

Actual Worker route tests cover 1,006 output frames across pages/restart, lost
append receipts, publication held behind commit, disconnect, malformed output,
current identity and capability checks, delete-only proofs and delayed initial
acceptance after erasure. Native tests exercise the actual authenticated Bun
router and a file SQLite close/reopen, competing host lease refusal, shutdown
interruption, replay equality and deletion, including a pinned reader that
holds private WAL bytes through the first erasure attempt. A real Chromium
test drops every committed output batch from the actual native response,
reloads, and recovers the complete answer with exactly one inference POST;
a second reload preserves that single answer. Browser effect and applied-cursor
failure tests remain necessary alongside this transport composition proof.

## Active integration invariants

- Persist leg identity and read capability before sending a new request;
  hash the exact admitted inference inputs, excluding raw credentials.
- Keep legacy transport coverage explicit: it has no replay cursor.
- Commit output before publication. On interruption, record a terminal
  observation if possible; a killed producer without terminal evidence remains
  an explicit ambiguous outcome and cannot auto-restart.
- Apply a complete batch, its durable tool-call decision and its cursor in one
  local event transaction. Replayed batches must not duplicate text or run tools.
- Restore the turn's pending call, continuation items and held claim text from
  durable state. The current in-memory `ActiveTurn` is not a recovery source.
- Recheck account ownership during catch-up; connect sign-out/reset to durable
  remote retirement requests and document retention of failed recovery copies.
- Test the actual public Worker/native/browser composition through disconnect,
  reload, reverse-order tool replies, lost receipts and privacy boundaries.

No model, provider or tool call occurs in journal verification or replay.
The active producer invokes inference only after fresh durable acceptance.
