# UI persistence

The UI derives its state from a versioned local event stream. The same pure
projector drives live dispatch, replay and verification; TanStack collections
are materialized views. SQLite and the localStorage fallback commit the event,
its projection changes and applied head together. See
[state events and verification](state-events.md) for the cross-system migration
contract and remaining work.

## Event authority and recovery

`AppProjection.ts` owns the 41 domain projections (38 persisted and three
per-launch collections) and their 149 validated transition types. `AppTransitionValidation.ts` validates the input and actor;
`AppEventStream.ts` gives an accepted event its stream identity, position,
versions, recorded time and SHA-256 integrity linkage. `EventValue.ts` preserves
explicit `undefined` clears in patches. A missing field is a different input.
Replay never invokes the dispatcher, network, model, host appearance or clock.

Four private persisted collections support the stream:

| Storage ID | Purpose |
| --- | --- |
| `app-events` | Accepted semantic facts after the covered checkpoint |
| `app-event-heads` | Applied position, event hash and projected-state hash |
| `app-event-checkpoints` | Verified baseline or compacted projection and its coverage |
| `app-event-retirements` | Content-free hashes of retired stream identities |

The app schema is now 16 (`APP_SCHEMA_VERSION`). Existing installations receive an explicit
`legacy-baseline` checkpoint of validated current state. It does not claim to
reconstruct earlier missing history. Once a journal exists, boot replays its
checkpoint and complete suffix, then repairs disposable materializations.
Missing positions, conflicting identities, unsupported versions or broken
hashes refuse recovery; cached rows cannot replace damaged event authority.
The two per-launch caches are cleared by a recorded boot projection.

The event format remains version 1; `APP_PROJECTOR_VERSION` is 32. Account-scoped saved conversation replay adds
`conversation.restored` at 32. The terminal and harness tabs and their `pty.*`
transitions retired at 23 (smithersai/smithers#2229); an older store's stale tab
rows fail `TabSchema`, are quarantined, and the surviving rows seed the fresh
stream. Bump the
projector version whenever an `APP_PROJECTION_SCHEMAS` row shape or the
transition set changes. Checkpoint reasons are `created`, `legacy-baseline`,
`compaction`, `privacy-reset`, and `projector-upgrade`. On an older-projector
head/checkpoint pair, boot seeds the validated persisted collection rows into
a fresh stream with a `projector-upgrade` checkpoint. The same atomic commit
replaces the head/checkpoint, clears old events, and retires the old stream;
failed commits preserve the old authority. Privacy markers follow the
new stream only after its commit; interrupted marker updates resume on boot.
This boundary does not replay old
transitions with new schemas. Newer projectors are refused with a typed version
error. Same-version replay retains all integrity checks, including rejection
when normalization removes an unknown field from a hashed checkpoint.

`store.eventHistory()` returns a detached host-only checkpoint, suffix and head.
`store.verifyState()` replays committed evidence and compares it with current
collections, returning hashes and row identities for discrepancies without
row payloads. Neither method is included in model context. Hashes detect
inconsistency; they are not signatures or protection against an actor who can
rewrite the entire database and its hashes.

`store.compactEvents()` verifies the projection, writes a covering checkpoint
and deletes the covered suffix in one commit. It defers while a prepared form
input still needs an older verified prefix; retry after that command settles.
The diagnostic 500-transition
and 250-tool-call limits never delete uncovered authoritative app events.
After 64 committed events, an idle one-second maintenance task uses the same
atomic checkpoint path. It waits for pending writes, preserves every projected
row, and defers when a prepared edit still requires the old prefix. Startup
schedules the same maintenance for an existing long suffix; failures preserve
the authoritative suffix and retry after a later committed write. Signout, account replacement and app
reset rotate the journal to a checkpoint of permitted state, erase old live
event bytes and retain retired identities.

Direct collection writes are refused. Draft keystrokes can replace one
provisional event before its commit starts; after acceptance that fact is
immutable. Its receipt resolves only after the final draft is saved. Disposal
flushes accepted writes before releasing the store and rejects later dispatch.

Pending composer, Wiki and supported entity recovery records live separately
in origin localStorage. They carry actor, command/input identity, stream and
verified-prefix binding, plus workspace/branch/conversation scope. Boot admits
validated pending input through semantic events before exposing it; those
records cannot replace authoritative history. Human form fields can prepare
validated input before their command receipt, but form submission remains
receipt-gated. See the [state architecture guide](state-architecture.md) for
rapid edits, inactive-branch recovery and privacy boundaries.

SQLite checks expected row versions and bytes inside its write transaction.
Even a repair or compaction includes the head in its compare-and-swap read
set. A stale independent writer is refused, along with its dependent work.
Browser AppStores hold an exclusive origin-wide Web Lock for their lifetime,
across both persistence backends. Boot waits up to 1500 ms for a closing tab
before showing “Smithers is open in another tab”, with **Use Smithers here**
and **Reload**. Taking over reloads with a one-use, tab-local request to steal
the lock; that new boot keeps the lease. The losing tab fences queued commits
and local recovery writes, disposes its store, and replaces the app with
“Smithers moved to another tab” and **Use Smithers here**. Neither ownership
panel offers reset, recovery download, or an internal stack trace. Reset uses
the same bounded wait and still reports held storage if it expires. Opening
without Web Locks remains refused. The localStorage envelope also checks the
previous committed bytes. Explicitly
injected isolated test stores use their host contract and the same stale-base
checks.

The degraded memory backend is explicitly nonsaving. It uses the same event
and projection functions, but a receipt only acknowledges an in-memory write.
Commands are not categorically blocked in this mode; local intent history and
chat replay capabilities do not survive reload. The warning shown for this
mode is therefore part of its contract, not a physical durability guarantee.

This stream records local intent and backend observations. It does not make
unreceived chat frames replayable, certify remote command acceptance, or replace
the Wiki CRDT, runtime execution store, native process manager or Plue's domain
authorities. Those migration boundaries remain explicit in the state-events
completion ledger.

## Backend selection

`createAppStore()` chooses a backend before creating any TanStack collection:

- **OPFS SQLite** is preferred. `SqliteRowStorage.ts` stores one physical row
  per entity and uses a real SQLite transaction for each logical dispatch.
- **localStorage** is the compatibility fallback. `TransactionalStorage.ts`
  stores a versioned envelope and uses a staged write-ahead key so a dispatch
  has one recoverable commit point.
- **memory** is a read/write-isolated degraded session. It is used when the
  recorded OPFS store cannot be opened, so a transient failure cannot fork or
  overwrite the durable conversation.

The selected durable backend is recorded separately in localStorage. Once a
browser has data in OPFS, failure to open OPFS never silently falls back to a
possibly stale localStorage database.
An unknown backend stamp stops startup without probing or selecting another
store. An absent stamp permits first-launch selection; an invalid one does not.

An absent stamp is not necessarily a first launch: older per-key/envelope
localStorage data is checked first. When it is the only existing store, boot
validates and adopts it, then records localStorage after successful
initialization. It does not open a fresh OPFS database over that history. If
an OPFS database also exists (or its existence cannot be established), boot
refuses to choose between potentially different histories. Appearance mirrors
and bookkeeping stamps alone do not count as another live store.

Theme and palette mirrors are best-effort. A refused localStorage accessor or
write does not stop appearance changes or memory-backend initialization. The
session remains the authority for both values.

Fallback applies only when the browser cannot acquire the database. Once
SQLite opens, a schema, validation, read, migration or commit failure stops
startup and closes that handle. It does not stamp a different backend, start
an empty memory session, or reinterpret a refused execution journal as new
work. A failed cleanup preserves the original refusal as the startup error.

Unreadable SQLite addressing metadata (including binary row keys, versions,
collection names or legacy registry entries) also refuses opening. Skipping
those records could hide authoritative evidence or permanently stamp an
incomplete legacy import. Ordinary row quarantine requires readable addressing
metadata and an explicit validation failure; a validator/key-check exception
stops opening without changing or quarantining that source.

The acquired SQLite handle also belongs to AppStore during initialization:
seed or later boot failures attempt closure before rejecting, retaining the
original boot error. A successful store transfers that responsibility to its
caller. Await `store.dispose?.()` or `controller.dispose()` when releasing it.
Controller disposal stops workflow pumps and releases resources in reverse
acquisition order, awaiting asynchronous dependents before their hosts. It
attempts every finalizer and reports failures together; repeated calls share
the same completion or rejection. A resource registered after disposal must
be released by its acquiring caller awaiting `onDispose`'s returned completion.

Each active explanation belongs to that scope. Disposal clears its timeout,
removes its agent listener, and cancels its side turn. Disposal and late stream
or start-request callbacks do not publish explanation card patches. Completed
explanations need no further cancellation.

Native sign-in disposal clears the polling wait, aborts start, claim and session
requests, and prevents late responses or browser opens from changing the store.
A repeated sign-in click while its start request is pending reports preparation;
it reopens the browser only after the handoff URL exists.

## Answered sign-in steps

A successful `identity.session.loaded` or usable `cloud.session.loaded`
observation answers outstanding sign-in actions in the same durable transaction.
The message keeps its original text, id, timestamp, and position. Its action
moves to `answeredAction`, with the sign-in result and observation time; both
the transcript and guide render that answer instead of a button. This is a
historical receipt, not a claim that a parked command ran successfully.
Unavailable sessions and degraded Cloud scopes leave their steps pending.
Web Cloud actions carry `signInRequirement: "cloud"` because their GitHub
button alone does not identify which session must become usable. Older actions
without that field use their door (`auth.sign-in` or `cloud.sign-in`). Boot
waits for an observed session; it does not infer a new success from cached state.
Restoring a conversation captured before a later successful session observation
also answers its live projection. The recorded archive stays unchanged; a
reauthentication prompt newer than that observation remains pending.

This covers explicit identity/Cloud prompts, required seam prompts, chat refusals,
OAuth retry messages, and repository onboarding. Failure toasts answer their
sign-in actions too; normal command resumption still replaces the ephemeral
requirement toast with its continuation notice. The anonymous-limit card uses
its persisted `acted` status, and the connector card updates its existing GitHub
connection state. The web opening message is a live projection, never persisted;
the guide login lesson already records its own completion. Account removal
continues to apply the existing privacy cleanup to the whole transcript.

## Controller request bounds

`controller/context.ts` bounds non-streaming requests, including target listing,
with one 30-second deadline (`seamTimeoutMs`) covering headers and body EOF.
It buffers at most 8 MiB of response bytes before returning a Response for
JSON or text decoding. Timeout rejects with `seam timeout`, aborts the fetch,
and cancels the reader without awaiting transport cleanup. Oversized bodies
reject with `seam response exceeds 8 MiB` and cancel the reader. Failed target
queries settle the pending card with the error. Turn and model relay streams
use their own streaming paths.

## Deferred public repository commands

`Session.repositoryEntry` belongs to the current URL. A cold explicit command
target uses the optional `repositoryCommandEntry` instead; opening `/` on reload
must not erase its admission or replace another URL's repository. One
`command.deferred` commit records the exact payload and command-target receipt
with a request ID and account owner. Catalog lookup starts after that commit,
or reconnects from hydrated state after this boot's identity answer. Session
changes before that answer cannot start a saved catalog or file read. Repeated requests share the lookup; newer
arguments retain only the latest command. Command admission never selects a
repository, opens its tree, or reads its default bookmark.

Catalog absence retains the sign-in gate; an unavailable catalog remains
retryable. After admission, the original payload re-enters the command registry
and the shared progress toast follows the actual read. Request ID, account
owner and account epoch fence late responses. The account epoch counts owner
changes only (sign-in, sign-out, another login); a re-probe of the same owner
on focus, from a sibling tab or after a 401, and an identity outage, leave it
unchanged. Account replacement removes the
command receipt; route admission keeps its existing selection fence. Projector
version 4 uses the existing atomic upgrade checkpoint, preserving prior cards,
route receipts and deferred commands.

## Collection contract

`PERSISTED_COLLECTION_SPECS` in `state/AppStore.ts` is the authority for every
persisted collection and its Standard Schema validator. Both backends expose
a `StorageApi` view for loading validated rows. `DurableCollection.ts` seeds
TanStack local-only collections from that view and persists transaction
mutations before confirming them through the collection's sync interface.
SQLite commits use `applyRows(collectionId, deltas)` directly; only changed
rows are encoded and written. The coordinator retains committed rows for
stale-state checks and rewinds tentative changes after a refused commit.
Retained collection history is neither parsed nor serialized on an append.
localStorage and older injected hosts without `applyRows` retain the full
collection envelope path. Their coordinator re-reads each touched collection's
exact stored string before every transaction. An unchanged immutable string
may reuse its private parsed rows; a changed string, including a same-version
external edit, is parsed again. The cache advances only after successful
persistence and is never shared with collection registration callers. This
removes repeated parsing without skipping stale-row checks or durable writes.
The store remains the only write authority: UI components project collections
and mutations enter through the controller/dispatcher.

## Bounded load

`chain/PersistenceBudget.ts` holds the one size bound, with the reason: V8 caps
a JavaScript string at about 512 MiB, and the loader used to hand TanStack each
collection as one JSON string. A profile with 890 MB of OPFS SQLite could not
start at all — `prepare runtime and persisted state: Invalid string length`,
with a recovery download as the only offered action.

`SqliteRowStorage.ts` loads in two passes. It first reads metadata in chunks
of 512 rows, newest first (descending rowid), and counts UTF-8 key/value bytes
in SQLite before transferring any normalized values into JavaScript. Admission
is limited to `PERSISTED_COLLECTION_BUDGET_BYTES` (64 MiB) per collection.
The second pass fetches admitted values in pages of at most 512 rows and
`PERSISTED_LOAD_PAGE_BYTES` (4 MiB of UTF-8 key/value bytes). An admitted row
larger than the page target is read alone. Both passes hold one SQLite writer
transaction, so the source cannot change between size admission and decoding.
No whole collection is serialized for the TanStack adapter: `DurableCollection.ts` uses detached `readRows` instead.
The localStorage envelope and older injected hosts retain their string view.

Every persisted app collection requires a complete load. If any collection
exceeds the budget, boot refuses before repairs or a new baseline; the source
stays intact. This includes heads, checkpoints, events, retirement tombstones,
and projected rows. A partial cache must never become an invented legacy
baseline, and a missing terminal suffix cannot be treated as a fresh run.
A one-second idle maintenance task compacts a retained suffix; explicit
compaction uses the same verified checkpoint path. Failures report their
consecutive streak and retain the suffix for retry after the next write.
Compaction cannot shrink an oversized domain checkpoint; there is no streaming
replay of an oversized checkpoint. An oversized store requires recovery or an explicit
human reset. Recovery downloads have their own size limit and may also refuse;
refusal does not delete the database.

Generic hosts may opt into partial admission for disposable collections.
Their `loadReport` reports admitted/skipped counts without row contents, and
skipped rows stay on disk for recovery. AppStore's complete-load policy never
silently enters this partial mode. Its load report and existing notice remain
available for explicitly injected hosts.

## Recovery actions

Reset first disposes the complete production AppStore, fences late dispatches,
and releases its writer lease. It then reacquires the same origin-wide lease
before deleting any bytes. Another tab's ownership refuses the erase. A pending
private download finishes before reset, and new downloads are fenced while the
erase runs. Before deleting raw local sources, reset copies any already-validated remote
turn deletion proofs into `smithers-mvp.resetErasures` and verifies the written
bytes. This separate delete-only queue survives both raw reset and subsequent
privacy sweeps. It carries no app baseline, old privacy marker, read token or
approval capability, and recovery downloads omit it. The normal erasure worker
drains it after fresh boot alongside current retirement obligations; only an
exact typed retirement receipt removes a proof. Failed staging prevents erasure,
and failed acknowledgement leaves the obligation for retry. Raw reset cannot
reconstruct unknown remote identities from corrupt authority or an unreadable
old privacy marker. That limit differs from event-driven `app.reset`, which
stages proofs from its verified current HTTP legs before erasure.

Filesystem erasure is not a multi-file transaction: an I/O failure
can leave a partial reset, so the failure copy never claims unchanged bytes.

For failures other than writer ownership, the startup failure panel offers two
acts, both flows with their actor recorded
(`state/StorageRecoveryAction.ts`, `flows/StorageRecoveryFlow.ts`), never DOM
code of their own:

- `storage.recovery.export` prepares the private local recovery download.
- `storage.recovery.reset` erases this browser's saved Smithers data and
  reloads. It takes two presses: the first arms the act and says what it will
  take with it, the second runs it.

The erase releases this document's store handles first. wa-sqlite's
OPFSCoopSyncVFS holds sync access handles for the life of the connection, and
`removeEntry` from a page that still owns them throws
`NoModificationAllowedError`; a pool released a moment ago can still be held
for a tick, so removal retries with a short backoff before reporting that
another tab holds the data. It then removes only this app's OPFS entries
(`smithers-mvp.sqlite`, its `-wal`/`-journal` sidecars and the `.ahp-*` pools)
and only the app's own localStorage prefixes. Nothing else on the origin is
touched. Both acts are user-only, for the reason each names in the registry.

Each durable commit is serialized with the others. A failed commit rolls back
optimistic collection state; queued transitions derived from that failed state
also reject. Each mutation checks its original row against durable data, so a
dispatch started during another transaction's rollback cannot persist stale
optimistic fields. A fresh dispatch after rollback may retry. Direct collection
inserts used during seeding follow the same durable-before-confirm order.

`store.dispatch(transition)` applies the change optimistically and returns its
TanStack transaction. `transaction.isPersisted.promise` is the durability
receipt: it resolves after the commit, and after `flush()` on SQLite, and it
rejects when the commit fails and the change rolls back. A transition the
reducer refuses resolves at once with no change.

```ts
await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
```

The durable navigation collections are `app-workspaces`, `app-branches`, and
`app-frames`. Frames refer to existing card records; maximizing a card changes
navigation state rather than copying or remounting the card.

A maximized frame records the conversation, cards, world documents, and draft
at its revision. Later card updates change the card row only; the recorded
snapshot keeps its revision. Forking restores that snapshot into a new branch.
Switching branches saves the outgoing branch's current projection and restores
the incoming one atomically, so edits and conversation resets stay in their
branch. Branch switches and forks wait until an active turn finishes.
Account-state removal also clears archived snapshots.

## Composer drafts

With the normal OPFS/SQLite backend, every `composer.changed` edit starts its
durable transaction in the input event. The same event writes a versioned
draft-recovery record synchronously to localStorage. The record is a temporary
write-ahead slot, not app-state authority: boot compares its revision with the
SQLite session, replays it through a TanStackDB transaction only when SQLite is
older, and removes it after the matching SQLite transaction is durable. An
older acknowledgement cannot remove a newer draft record.

The composer overlay remains transient and closed after reload, while reopening
it reads the independently recovered draft from the session collection. A
departing page cannot rely on `pagehide` to finish an asynchronous worker write,
so SQLite draft commits are never deliberately delayed.

The localStorage fallback still coalesces keystrokes because each commit
rewrites the whole saved envelope. Its draft is visible at once; the commit
lands 250 ms after the last keystroke, at most 1 s after the first unsaved one,
or earlier on the next other dispatch, `pagehide` or `store.dispose()`. Every
keystroke in that window returns the same receipt, and the journal holds one
`composer.changed` record with the final draft. The synchronous draft-recovery
record also bridges that batching window and is reconciled into the envelope
on boot.

## Clearing and recovering a conversation

`/chat.clear` archives the current conversation locally and starts a new one.
It requires neither sign-in nor a model request. The confirmation contains a
durable frame URL for opening the old conversation, including after reload;
browser Back/Forward also traverse these branches. The snapshot preserves
messages, cards, the unsent draft, and the World documents at that revision.
World is branch-owned: opening an archive restores its historical notes, not
the current branch's notes. This does not cancel independent workflow runs.

`/chat.clear --summarize` additionally requests model-generated World notes.
They are new documents with `chat-sweep` and source-conversation provenance;
no generated title selects or overwrites an existing document. Case-folded,
Unicode-normalized path collisions receive numeric suffixes. Existing notes
retain their content, attribution and revision. The archive, optional notes,
new branch/root frame, cleared projection and journal record commit together.
A failed write rolls back all of them; success is reported only after commit.
An active chat turn is stopped separately and cannot be revived by rollback.
Agent-requested clearing asks the human for confirmation through the same Flow.

Summarization accepts at most 768 KiB of UTF-8 request JSON and 256 KiB of
response bytes, with a 30-second deadline covering headers and body. It never
silently truncates the transcript. A valid response must end with an explicit
successful `done`/`stop` frame and EOF; partial, malformed, failed or cancelled
responses save nothing. A summary contains at most 50 schema-validated notes.
Concurrent conversation/identity changes invalidate it; unrelated toasts and
user note edits do not. A local clear cancels a pending summary. Oversized or
unavailable summaries leave the local archive/start-new path available.

Archives are retained as branch snapshots, not as the bounded transition log.
In a degraded memory session they last only until the session closes, and the
confirmation explicitly says so. They are local history, not a backup or a
secure deletion mechanism. Deleting account state also removes the snapshots.

## OPFS SQLite layout

`SqliteRowStorage.ts` owns three tables:

- `smithers_collection_rows(collection_id, row_key, version_key, value)`;
  primary key `(collection_id, row_key)`.
- `smithers_metadata(key, value)` for schema/import bookkeeping and
  non-collection storage keys.
- `smithers_row_quarantine(...)` for rejected rows and pre-normalization originals.

`beginBatch()` buffers the coordinator's synchronous row deltas.
`commitBatch()` schedules exactly one `BEGIN IMMEDIATE` transaction that
inserts, updates, and deletes all changed rows; any error rolls it back.
A dispatch's receipt, `transaction.isPersisted.promise`, resolves only after
`flush()` completes.

At open, every known row is JSON-decoded and schema-validated. Validation reads,
recovery copies, normalization, imports and version stamps share one
`BEGIN IMMEDIATE` transaction, including asynchronous validators. Another
writer cannot replace the checked source before the migration writes it.
Ordinary invalid
rows move to quarantine and leave the live table in one transaction. Execution
journal and lineage-retirement rows instead use `invalidRows: "refuse"`:
unreadable rows or mismatched row keys stop opening before their evidence can
be removed. A newer app schema throws `FutureSqliteSchemaError`; malformed
current, legacy or per-collection schema stamps also refuse upgrade instead of
being guessed as current. A malformed import-completion marker cannot restart
legacy import, and binary version/envelope metadata cannot masquerade as absent.
Live source rows are preserved on refusal.

Local, legacy and normalized SQLite paths use the same decoder output and
check row keys against that decoded value. Defaults and compatible
normalizations are committed before returning the store. A changed normalized
SQLite row first saves a verified `schema-normalization` recovery copy whose
`value` is JSON `{ versionKey, value }`: the original version key and the exact
original row JSON string. These copies are not invalid-row reports. An error
in a later row rolls back earlier normalization and copies too.

Stored schemas must be pure, JSON-closed, idempotent normalizers. Changed
output is decoded again from its JSON representation before committing; a
decoder that changes it again or rejects its own output refuses the whole
open rather than quarantining valid source data. Use an explicit versioned
migration for one-shot transformations. Dates, BigInts, non-finite numbers,
undefined values, cycles, accessors, hidden/symbol properties and sparse arrays
are not stored JSON values; the opener refuses instead of silently dropping
or converting them. An unchanged JSON value does not require a second decode.

The one-time importer reads both historical formats: the `smithers_kv`
envelope and the former `collection_registry` tables. It validates before
copying and leaves source tables untouched for recovery. It also reads the
pre-envelope per-collection keys in `smithers_kv`. Existing normalized rows
win; a current envelope is authoritative over older per-collection/registry
data, including when its collection is empty. Invalid legacy rows move into
quarantine. Import, quarantine, and the `legacy-import-complete` marker commit
in one transaction, so an interrupted import can retry and a later deletion
cannot resurrect a legacy row. Future schema versions and unreadable legacy
envelopes fail closed, preserving their sources.

## localStorage fallback

`TransactionalStorage.ts` stores a versioned `smithers-mvp.store` envelope.
A batch writes the new bytes to `.staged`, writes the live key (the commit
point), then removes `.staged`. On boot:

- equal staged/live bytes mean commit completed; the staged marker is cleared;
- different bytes mean commit did not complete; staged bytes are discarded;
- ordinary malformed rows are quarantined rather than adopted;
- unreadable app envelopes or authoritative journal/retirement rows refuse
  opening, before any staged cleanup or quarantine writes;
- future envelope versions refuse open before touching live or staged bytes.

A failed stage cleanup after the live write still reports a successful commit;
its matching stage is recoverable on the next open.

Unchanged collection strings may also reuse their JSON escaping inside the
envelope serializer. The complete staged/live bytes remain identical to
`JSON.stringify({ version, entries })`, including numeric-looking keys and
Unicode escaping. Only the current string/encoding per key is retained; removed
keys are evicted. Every accepted transition still commits its full envelope.
The four application-journal collections remain strict.

Legacy per-collection keys (or a historical version-zero envelope) are
migrated through the same schema registry. Every known collection is also
validated when opening a current envelope. Invalid rows retain their original
bytes in quarantine, while valid rows use the schema's decoded value. Legacy
host keys stay untouched as recovery copies; the committed current envelope
is authoritative on later opens, so removed rows remain removed. If migration
cannot commit, the original keys remain available for retry.

If decoding changes a valid row or strips extra row-envelope fields, the
current localStorage envelope is retained in full before it is rewritten.
Backup writes are read back and verified. Mutating validators cannot replace
the rejected row's recovery original. Observable source changes while an async
validator is waiting refuse open before replacement. That final comparison is
not an atomic cross-tab lock; concurrent independent stores still require an
ownership protocol.

Authoritative collections are the exception to generic row quarantine. Their
row IDs must agree with their storage keys, and any rejected row refuses the
whole open. Losing a replay prefix or retirement marker can make old work look
new; boot must not continue with a silently incomplete execution history.

If an earlier release already created a current envelope while skipping its
legacy keys, those keys remain recovery copies; automatic open cannot
distinguish skipped historical rows from rows intentionally deleted from the
current envelope and does not merge them back in.

For app-schema upgrades, `AppStore` preserves compatible older rows and stamps
the current schema only after the validated envelope commits. A future or
invalid app-schema stamp refuses open without changing stored bytes. The
standalone `enforceSchemaVersion` now defaults to read-only validation too:
an absent/older stamp waits for the validated opener to commit, and a newer
stamp refuses. Only explicit `onMismatch: "reset"` permits destructive reset
with recovery copies; app boot explicitly uses `onMismatch: "validate"`.

Recovery copies preserve every distinct rejected original. LocalStorage keeps
the first historical backup key and puts later differing originals under a
SHA-256-suffixed key; identical repeats reuse a saved copy. SQLite binds new
quarantine IDs to collection, row key and exact original bytes, and verifies
the saved copy before removing a source row. Existing older backup IDs remain.
A failed/conflicting backup refuses recovery rather than overwriting a saved
copy or discarding its source. Recovery copies are private local data, not
anonymized by their hashed keys; there is no automatic pruning.

Imports support the historical formats recorded in repository history; they
do not guess at arbitrary database layouts or transform incompatible records
beyond the current schema's decoder. Unknown collections stay in the original
source. Special tagged TanStack values that do not satisfy the current app's
JSON schemas are retained for recovery rather than coerced into another type.

## Private local recovery files

Run `/storage.recovery` to show the download step inside the conversation. The
startup-failure panel offers the same action before AppStore is available.
Both invoke the `storage.recovery.export` Flow. Its browser gesture is
human-only; the agent may offer the prompt but cannot execute the raw download,
even through a direct binding. Nothing in the file enters model/tool results,
the transcript, operation status, or an HTTP upload.

The warning matters: a file can contain private conversations, authored notes,
quarantine copies, and older account data. Keep it local. The filename is
`smithers-local-recovery.json`; “download prepared” means a browser handoff,
not proof the human saved a file. Capture/download failure is visible, safe to
retry, and never clears the source. Closing the owning panel/controller
suppresses a late download and releases its subscription and object URLs.

The versioned JSON artifact contains raw localStorage keys from only the live
and quarantine namespaces, plus table schemas and typed SQLite cells when an
existing database is accessible. Integers use decimal strings; blobs and
invalid UTF-8 use tagged hex. Sources remain separate: capture does not choose
or merge unstamped histories. `session` names the exporting session's backend
or `unopened`, `memory` separately contains a degraded session's unsaved keys,
and `unavailable` explicitly names APIs the browser cannot offer. No `sqlite`
field with an available API means no database existed at inspection time.

A live SQLite store exports on its owning connection, serialized between
writes. After failed boot, recovery checks for the existing database before
opening it and never runs application migrations or schema validation. This
is not a filesystem-read-only open: the vendor VFS may manage temporary files
or SQLite journals. It does not protect against another tab deleting the file
between inspection and opening. Observable localStorage changes across capture
refuse the result, but there is no cross-backend atomic snapshot or cross-tab
lock. A source read failure refuses the download rather than silently omitting
that source.

Limits are 64 MiB encoded output and 128 SQLite tables. No partial/truncated
file is produced. This is a logical data-recovery dump, not a byte-for-byte
SQLite backup: physical rowids and all index/trigger/extension layouts are not
preserved. There is no automatic restore, backend chooser, or streaming/native
large-export path yet. Recovery also needs the app's recovery bundle and an
answering storage worker; a never-answering worker remains a lifecycle limit.

### Privacy retirement of recovery copies

Schema 13 makes account signout, definitive account replacement and app reset
retire application-accessible recovery copies as well as rotate the live event
journal. The browser owner holds the same origin Web Lock before opening either
backend and until its writes and close finish. The durable, private
`smithers-mvp.privacyRetirement` boot marker names an operation, account/reset
policy, selected backend and target stream, plus pending delete-only remote
capabilities. It is written and reread **before**
the privacy checkpoint is committed. It never contains an account name,
transcript, saved projection, raw execution lineage label or remote read token.

The accepted target stream/checkpoint proves whether rotation committed. After
that commit, cleanup rewrites the active store from exactly the verified
permitted collection values plus its event authority and retirement tombstones.
It preserves row version identities needed by the current persistence owner,
and removes unknown current entries, legacy localStorage keys, every quarantine
variant, SQLite key/value and registry source tables, old schemas/views and
SQLite analysis samples. SQLite recreates its fixed two-table live schema in
one transaction; the inactive app database is emptied. LocalStorage deletes
only the two app-owned namespaces. Public version/backend/appearance stamps
are written from explicit current values, not copied from opaque old bytes.
Account boundaries preserve verified machine-owned local notes and resources;
app reset applies its existing stronger cleanup. An inactive old envelope is
never merged into the permitted state.

Only successful local cleanup leaves the marker's `pending` phase. There is no
transaction spanning SQLite and localStorage: a crash or unavailable inactive
backend leaves the marker pending, and startup/recovery cannot adopt or export
those copies.
Reload retries the same retirement. If rotation did not commit, boot first
verifies existing event authority and applies the pending safe cleanup policy;
missing/corrupt authority refuses instead of importing an older backup. Once
locally erased, the marker pins the selected backend and current stream against stale
backend adoption. Unknown marker versions refuse. Older schema-aware clients
must refuse schema 13; an already-running older writer is not retroactively
covered by the new lease protocol.

A failed privacy receipt blocks further writes and public state/model reads in
that owner until reload. A degraded-memory session can persist a pending intent
for its unavailable OPFS backend but cannot report completed erasure. When the
boot record itself cannot be written, durable privacy completion cannot be
claimed. Production always supplies the privacy host capability; an explicitly
injected legacy storage host without it retains that host's own lifecycle
contract and is not evidence of browser-wide retirement.

The marker's second phase is `remote-pending`. Before raw HTTP capabilities
leave the verified projection, the same atomic intent stores one deletion
obligation for every known `httpTurnLeg`, including prepared legs whose initial
POST might still arrive. The proof is
`SHA256(agentTurnJournalDigestInput("access", readToken))`; it cannot replay
output. New boundaries atomically merge older unacknowledged obligations with
new legs. When a degraded intent could not read its original backend, boot adds
the verified legs before rotating away their tokens. The private intent key is
excluded from recovery files and never enters app events or model context.

After local erasure, the clean app and a new owner can proceed offline. A small
owner-scoped worker sends up to 32 delete requests per pass, with a five-second
pass budget and ten-second retry interval. It starts during browser boot using
the existing same-origin fetch host, independently of account login or agent
startup. `/api/agent/turn/erase` accepts only `{runId, legId, retirementProof}`
and installs an absent-leg tombstone, so delayed initial acceptance cannot
create output after erasure. The older authenticated retire route remains a
separate compatibility path. A 404, unknown success body, lost response or
network failure keeps the obligation pending; only typed `retired` success
removes the exact scoped proof from the current durable intent. An old response
cannot overwrite a newly merged intent. Lost acknowledgement writes retry the
same idempotent erasure. Disposal aborts the worker and waits before releasing
the storage lease; late responses cannot mutate a released owner.

`complete` means both local cleanup and all staged remote acknowledgements are
durable. `privacyRetirementStatus()` exposes only the phase and pending count;
it does not expose scope IDs or proofs. Remote failure alone does not reject
signout or block the clean local state. Scope coverage is the verified current
HTTP leg history, not unidentified remote journals whose capability was already
lost before this protocol existed.

Recovery captures check the marker before reading and again after reading; the
same capture guard runs immediately before browser download. A signout/reset
invalidates already-captured old bytes even if retirement completed before the
download callback. Pending Blob URLs are revoked on same-document retirement
and cross-document storage events. The browser's recovery path refuses if it
cannot read the durable privacy fence.

Boot validates execution authority before repairing projected rows. Missing,
malformed, future, inconsistent or incomplete authority refuses opening with
its source preserved. AppStore verifies the journal and reconstructs projections
before exposing the store.

This is logical erasure of app-addressable data, not forensic disk erasure.
SQLite free pages/WAL remnants, browser internals, OS snapshots and backups are
outside the claim. Previously returned JavaScript values cannot be recalled;
new guarded public reads refuse a failed retirement. User-downloaded files
cannot be deleted or recalled by this protocol, and revoking a Blob URL does
not undo a completed download. The retained current lineage tombstones prevent
reusing those execution identities; erasure does not invent replay evidence
for an opaque inactive history that was never admitted as the current authority.

`PrivacyRetirement.test.ts` uses synthetic storage and isolated SQLite to cover
intent/checkpoint/completion failures, restart repair, inactive-store failure,
unknown rows/columns and legacy/quarantine copies, rollback, permitted notes,
reset/tombstones, capture races and Blob URL invalidation. No real user storage
is touched by these tests.
`RemoteRetirement.test.ts` covers pre-acceptance legs, interrupted/merged
outboxes, lost acknowledgements, offline and unknown responses, bounded passes,
worker disposal and proof exclusion. These tests use fake network hosts.

## Recommendations

The `app-recommendations` collection persists one `current` row validated by
`RecommendationSchema` in `src/mainview/state/AppState.ts`. It contains ordered
flow bindings, their source (`rule` or `agent`), the session revision and a
creation timestamp. `src/mainview/state/controller/recommend.ts` dispatches
`recommendations.updated` with the rule's suggestions first, then a validated
server answer when available. `App.tsx` projects the stored suggestions; before
that row exists it uses the repository-step fallback. Reload retains the last
recommendation while regeneration is pending.

The row's optional `retry` field is the recommender's own retry window. When
`POST /api/recommend` answers 429, the controller reads the window the server
states (`retryAt` in the body first, then `Retry-After`; `recommendRetryAt` in
`Recommend.ts`) and dispatches `recommendations.deferred`. The projection binds
the window to the current account owner (`accountOwnerLogin`, which outlives an
identity outage; a visitor is `null`; an unknown owner retains nothing). Before
the window passes, a material change and a reload still write the rule's
suggestions but send no request. A rule write keeps the window; an agent answer
clears it; `forgetAccountState` drops the row with the account. A window whose
owner differs from the current owner does not apply, so a visitor's spent
bucket never closes the login that follows. A 429 without a usable window
retains nothing: the next material change asks again, as before. A window past
`RECOMMEND_RETRY_MAX_MS` (24h) is clamped.

The retry also records its normalized service origin. Browser boot uses the
page's origin; an injected `AppServices.baseUrl` resolves against that page.
Changing hosts cannot reuse another service's cooldown, including when the
same store is reopened. An old row without an origin does not block requests.
An invalid or opaque origin retains no window.

Only one request per current owner/epoch runs at once. New material revisions
update the rule immediately and invalidate an older success; settlement may
schedule the latest revision once. A 429 still closes the same owner's bucket
even if the rule revision changed while waiting. Response-body reads recheck
the owner and epoch before publication, and an old request cannot clear a newer
owner's in-flight token. `controller/recommend.test.ts` pins these held-response
and held-body boundaries with real controller/store dispatch.

## HumanTask answer drafts

Human question input enters through `form.set` with `answer:<questionHash>`.
The field key binds the currently displayed question, and the shared handler
checks the independently retained runtime approval before changing text.
`approval.answer.changed` records the human actor; the pure projector derives
`runtimeApprovals.answerDraft`. A matching grant envelope is never inferred
from the draft, and typing never submits a decision.

Before its command receipt, a human edit synchronously prepares only the
normalized gate ID, question fingerprint and text in `EntityRecovery`.
Reopen checks the same verified stream ancestor, command identity and active
workspace/branch/conversation scope used by other pending inputs. It also
requires the same still-pending question. Newer typing and explicit empty text
survive older acknowledgements; failed persistence removes its pending slot.
A changed question, decision, account or command outcome cannot resurrect it.
The pending record contains no approval request, resolver token or capability
envelope. Explicit event compaction defers when this input still needs an
older event hash to prove its origin.

## Retention

`/debug.errors` reads recent app failures without a repository, sign-in or
admin access. The agent uses the same Flow for questions about errors and
toasts. It searches retained toast transitions (including dismissed notices),
failed app/flow/card events, failed tool results, active toasts and the network
tap. It returns newest matches first with timestamps and coverage information.
For example, `/debug.errors timeout --source toast --limit 10` filters by text
and source; `--since 2026-09-14T13:00:00-07:00` sets an inclusive time bound.
`--all` includes running/successful notifications and successful requests.
Sources are `toast`, `network`, `event` and `tool`; the default limit is 20,
the maximum is 100, and result rows are bounded to 24 KB with long text clipped.
The result reports omitted matches so the caller can narrow its filters.

This reads existing local evidence, not console or server logs. Dismissed
toasts cannot be recovered after their transitions age out. The last 100
network requests exist only for the current controller, are cleared on account
changes, and late responses from an old account cannot restore them. The
agent read excludes tool arguments, arbitrary card/transition payloads, request
and response bodies, and URL credentials, query strings and fragments. It
returns only failure text from unsuccessful tools. An empty result means no
matches in the retained evidence, not that no failures happened.

Diagnostic compaction is part of the same dispatch as the append. The store
keeps the newest 500 transition records and 250 tool-call records. Entity
collections are not time-trimmed.

Each diagnostic transition payload is capped at 2 KiB of UTF-8 bytes by
`TransitionDiagnostics.journalPayload`. Larger payloads preserve short scalar
fields and elide long strings and arrays; a still-wide payload records only
its original byte size. These are the bounded `transitions` rows used for
recent diagnostics. The canonical `appEvents` input stays complete, so a large
file, transcript or run observation can still be replayed exactly.

Unchanged run polling is filtered at the normalized observation boundary,
after validation and before dispatch. New transcript suffixes are anchored to
the applied transcript length and optional cursor; a changed base refuses.
Health changes caused by crossing an observed expiry remain recorded facts.
Identical generic collection updates avoid redundant physical writes, while
explicit application-head guards retain their compare-and-swap check.

An idle poll that learns nothing adds no event. An explicit accepted command
still adds a durable fact even if its visible value is unchanged. The 500-row
diagnostic limit therefore does not bound the canonical event history;
verified checkpoints and event compaction handle that history separately.
The 64 MiB load budget is an admission ceiling, not a steady-state size target.


Account sign-out, expiry and replacement scrub private journal contents,
transcript cards and snapshots, composer drafts, deferred commands,
recommendations, billing, repository inventory, working copies, cloud
workspaces, integration status, and repository tree and flow projections.
Card tabs close. Search history and repository selection
reset. Local World notes and local host resources remain machine-owned.

The identity row persists `accountOwnerLogin` independently of availability.
An unavailable answer retains that owner and its data, including across reload.
A definitive sign-out or different login scrubs in the same transaction that
publishes the new identity. Missing ownership on a legacy unavailable row is
unknown, so the next definitive answer scrubs conservatively. Fresh anonymous
sessions retain deferred sign-in intent until their first login.

Explainer answers belong to the account that asked the question. Confirmed
sign-out or account replacement cancels the explanation and disconnects its
output. Delayed launches, saved output and recovery reads cannot restore cleared
questions, answers or local cleanup records. Command history also drops late
results and private input after its accepting account is cleared. Rechecking
the same account keeps its active explanations running. The app requests
deletion of old saved answers without restoring local cleanup records.

## Verification

- `SqliteRowStorage.test.ts`: normalized rows, atomic commit/rollback,
  validation, quarantine, legacy import, and future-version refusal.
- `TransactionalStorage.test.ts`: staged-write crash recovery and migrations.
- `DurableCollection.test.ts` and `Persistence.test.ts`: failed-write rollback,
  stale optimistic state rejection, independent overlapping SQLite commits,
  direct collection writes, and query metadata during pending persistence.
- `AppStore.test.ts` and controller suites: reducer projections and retention.
- `e2e/playwright/frames.spec.ts`: durable frame URL/history/reload behavior.
- `StorageRecovery.test.ts`, `BrowserStorageRecovery.test.ts`, and
  `RecoveryIntegration.test.ts`: raw capture, host cleanup, actor refusal, and
  private bytes absent from the real controller's results/transitions.
- `StartupRecovery.test.ts`: failure/retry and cancellation of the non-React
  projection, including a failed recovery-bundle load.
- `e2e/playwright/storage-refusal.spec.ts`: physical OPFS refusal/reopen,
  unstamped legacy adoption/ambiguity, and actual recovery downloads from both
  failed boot and a running app.

### Native target run receipts

The native target topic publishes only after the run journal has accepted and fsynced the corresponding frame. `TargetRunHistory.event` returns the exact retained frame, so live and replay readers receive the same redacted output and the same journal-cap marker; a capped frame or failed append returns no publishable frame. Once an append fails, later frames cannot hide the missing suffix, and `flush` rejects. Startup refuses to overwrite an existing journal, and append refuses to recreate a missing prefix. Cancel and shutdown await pending terminal receipts. Output logs remain bounded (including explicit truncation); lifecycle frames remain retained.

New exit events include `at`, making terminal status/time a pure reduction of the initial run metadata and accepted events. The trailing RunRecord is a compatibility cache: deleting or changing it cannot override a timestamped exit. Legacy untimed exits still use their final record. This is a filesystem journal, with each accepted append fsynced; it is not a remote transactional execution guarantee. Execution that happened before a failed append is not fabricated into successful replay history.

## Fresh-browser conversation restoration

A signed-in Cloud browser with no local conversation reads the account's server
conversation index and committed replay pages. Each page is account fenced and
each batch is checked before the single `conversation.restored` transition folds
through the existing transcript reducer. Existing branch/root-frame snapshots
and frame URLs provide navigation; public run links use `runs.open` and its normal
authorization. No HTTP execution row, device capability, private tool output or
pending tool execution is reconstructed.

The shared account epoch rejects late pages after account/provider replacement
or disposal. New user intent in the existing transition tail, draft, queued input
or an active/local conversation prevents replacement. A compacted tail that
cannot prove the absence of newer intent also refuses replacement. Persisted
restored branch snapshots reload through the same local event journal. Server
retirement still refuses a new replay; previously read local copies follow the
existing local privacy-retirement path.
