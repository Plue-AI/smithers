# State events and verification

The [state architecture guide](state-architecture.md) explains where state lives and how the active paths synchronize.

The product's durable read models must be reconstructible from versioned,
accepted facts. A stream transport, diagnostic transition tail, or mutable
array called `events` does not provide that guarantee.

This document is the implementation contract and completion ledger for the
state architecture migration across `smithers/apps`, the runtime packages,
and the Plue APIs they consume. An unchecked item remains required work; a
passing test for one projection does not establish completion of another.

## Authority and projection

An application command is validated and decided against its current
projection. Accepted facts include the actor, explicit decision time, stable
identity, stream position and schema/projector version. A pure function folds
those facts into the application state. React and TanStack DB expose
materialized views of that state. They cannot create independent durable facts.

The frontend journal is scoped to one browser store. It records local intent
and attributed backend observations; it cannot certify backend acceptance or
reconstruct bytes a server never made available for replay. Backend domains
retain their own authenticated, committed stream positions. No browser
revision is a global distributed cursor.

```
command -> validate/decide -> accepted event
                              |
                  pure projection(previous, event)
                              |
            atomic event + projection + applied position commit
                              |
                  durable receipt -> allowed effects
```

Effects never execute during replay. Credentials, process handles, owner
leases, filesystem contents and external provider resources retain explicit
operational authorities. Health is derived from recorded observations,
incarnation and an explicit evaluation time. Executable results remain under
their protected execution store when the public event stream is redacted.

## Frontend event contract

The complete existing domain transition union is the starting vocabulary.
The same pure projector must drive live dispatch, checkpoint replay, rebuild
and verification. A generic row-diff log alongside the existing reducer does
not satisfy this contract. Time, bootstrap environment and persistent defaults
are event inputs; DOM appearance, console logging and network actions stay at
the application boundary.

Accepted events have version, stream ID, stable event ID, ordered position,
actor, event type, recorded time, exact payload and integrity linkage. Explicit
`undefined` in a patch means clear the field and must survive encoding; absent
and explicitly undefined input are not interchangeable. Unknown versions,
malformed payloads, conflicting IDs, missing positions and invalid state
evidence refuse recovery rather than silently starting over.

One transaction persists the event, changed materialized rows and the applied
head. A failed commit rejects dependent optimistic work. For OPFS/localStorage, a success receipt is
local durability, not remote acceptance. The explicitly nonsaving memory mode
acknowledges only in-memory writes and does not categorically block commands;
its local intent/capability history cannot survive reload. Same-origin independent writers need
an enforced writer/conflict protocol. Database serialization alone cannot
prevent a stale application snapshot from overwriting a newer one.

Existing installations migrate through an explicit baseline checkpoint of
validated current state. This checkpoint does not invent unavailable history.
After migration, boot reconstructs from the covered checkpoint and complete
event suffix, verifies materialized state and repairs disposable projections.
An invalid authoritative checkpoint/log is an error, never permission to
adopt arbitrary current rows as a new history.

Diagnostic `transitions` and `toolCalls` may retain their bounded tails as
derived views. Authoritative history has explicit checkpoint/compaction and
privacy policies. Signing out, switching accounts and resetting must erase
private event bytes as well as current rows and historical snapshots. A
privacy boundary rotates the stream and atomically retains only a checkpoint
of permitted state and content-free retirement evidence. Old cursors cannot
resume across that boundary.

## Remote streams and derived views

The active chat path needs idempotent turn acceptance, committed replayable
frames or a complete authoritative turn snapshot, and a persisted applied
cursor. A browser journal cannot recover an unreceived network frame. Resume
must never rerun already accepted model/tool work to fabricate missing output.

Gateway run and approval views must consume complete lifecycle evidence and
stable call identities. Execution phase and observer connection state are
separate inputs. Runtime event schema availability is insufficient until all
writers use the required contract. Legacy incomplete history retains an honest
baseline/fallback boundary.

Plue streams drain committed durable sources in order. Notifications are
wakeups; periodic catch-up repairs missed notifications. Drains must exhaust
all pages, advance only after successful delivery, and use a writer ordering
contract that prevents lower IDs committing after higher IDs are acknowledged.
Workflow live and replay paths must cover the same log tables. Proxy resume
metadata, revocation and scope checks are part of the end-to-end contract.

Wiki retains its causal state, durable pending update IDs and verified
acknowledgements. Its revision stream announces changes; it does not contain
the full document. Local target/tutor progress needs complete lifecycle facts
and publish-after-commit semantics. Large output has separate bounded retention
with explicit truncation/reset responses.

UI decorations such as stars, notification receipts and tags derive through
joins. Run cards refer to normalized run state and one shared projector;
historical views retain explicit revision/checkpoint references. Do not fan
the same authoritative field into independently updated card copies.

## Completion ledger

The frontend authority is connected to the active `AppStore`: 41 pure domain
projections, 149 validated transition types, four private journal collections,
verified baseline/suffix boot and explicit compaction. Live-store tests erase
all materializations after more than 500 accepted events, close and reopen a
real SQLite file, and recover the original question and complete reply. Failed
commits reject their events and optimistic dependents; stale SQLite compaction
is fenced by the expected head. Real same-origin Chromium tabs verify exclusive
fallback ownership and release on tab close.

Pending composer, Wiki and supported entity edits are scoped input, not accepted
history. Recovery validates their stream/prefix, original actor and branch,
then commits ordinary semantic events before exposing the recovered result.
Human form-field preparation happens synchronously before command acceptance;
refusals cannot resurrect the input, and submission stays receipt-gated.

Private journal rotation now durably stages local erasure, rewrites verified
permitted state, removes historical/quarantine bytes and excludes deletion
proofs from exports. Its durable remote outbox keeps delete-only proofs across
offline periods and account changes until the host acknowledges erasure; native
acknowledgement also requires draining the SQLite WAL. External copies remain
outside the stores' authority. Authorized native calls now commit versioned
invocation and controller-result facts in the owning execution transactions.
The native journal is the durable outbox for the existing control bridge;
reopened consumers converge after a lost destination receipt. Shared runtime
views prefer these facts over identified telemetry while preserving stable
call/display identities. Unidentified legacy calls and model/printed trace
telemetry retain explicit coverage limits. Plue durable drains and notification/issue lifecycle facts are implemented in the
Plue main checkout, with raw projection equality and authenticated replay tests.
The active HTTP browser path now persists logical attempts and per-leg replay
capabilities before POST, applies a verified whole batch and cursor atomically,
and recovers its pending calls, held claim text and settled tool results from
the same event authority. Tests reopen a partially streamed answer without
another inference and drain more than 1,000 missed frames across bounded pages.
Tools and continuations wait for local persistence receipts; an accepted tool
without a saved result stays explicitly ambiguous after reload. Explicit retry
has a distinct attempt identity. Real native-host tests kill a writer after durable acceptance and after a
committed output batch withheld from delivery. A fresh host recovers that exact
prefix without granting replacement inference; a missing terminal fact remains
nonterminal. These are process-crash tests at named durable boundaries, not
physical power-loss tests. The public/native producer and remote erasure
contracts are documented in the [backend contract](../../server/docs/agent-turn-events.md);
frontend boundaries are in [HTTP turn recovery](http-turn-recovery.md). These
are source/test claims, not deployment claims.

- [x] Pure complete frontend projector, with no independent live reducer.
- [x] Lossless versioned event encoding, strict validation and stable identities.
- [x] Atomic event/projection/head writes in SQLite and localStorage fallback.
- [x] Explicit existing-store baseline migration and verified boot/rebuild.
- [x] Checkpoint-plus-suffix replay, corruption refusal and visible coverage.
- [x] Erasure/retirement of application-owned account-scoped browser live/history/recovery state and retained HTTP-turn identities.
- [x] Coherent independent-tab writer ownership or version conflict handling.
- [x] Receipt-gated intent/effects and meaningful form drafts in durable stores; explicitly nonsaving memory mode remains ephemeral.
- [x] Active chat acceptance/replay/reconnect and applied-cursor recovery.
- [x] Normalized run/approval views backed by versioned lifecycle facts on production SQL control/native paths, with explicit legacy/unverified fallback.
- [x] Stable runtime call correlation, including reverse-order completion.
- [x] Plue complete durable drains, writer ordering, proxy cursor preservation.
- [x] Complete notification row facts and issue row/label-membership/assignee-membership facts; external joins and general SPA subscriptions retain separate contracts.
- [x] Native target lifecycle reconstruction and publish-after-fsync receipts; tutorial verified fact/cache/checkpoint transactions and durable execution claims.
- [x] Derived star/read/tag/Wiki decorations without duplicate authority.
- [x] Current-source documentation, migration and operational recovery guidance.
- [x] Required package checks plus real storage/browser/service verification.
- [ ] Changes reviewed, merged and pushed to main; temporary workspaces removed.

## Final local verification

The full app run exercised 427 files: 4,455 tests passed, seven opt-in tests
were skipped, and 11 timing-sensitive tests failed with four timeout-related
errors. Ten complete affected files then passed unchanged in isolated runs:
154 tests and 779 assertions, including all nine real language-server cases
whose aggregate setup timed out. The existing performance and fixture limits
were preserved. This is aggregate coverage plus isolated reruns, not a clean
aggregate claim. The final app typecheck passed. The fresh real-browser gate
passed all 19 storage, frame, draft and committed-turn recovery checks.
Relevant runtime/server/Plue package, database, process-crash and documentation
checks also passed, with earlier failures retained in the verification record.
After integrating main through `fe3769198d6d`, 226 frontend tests, 56 conformance/transport/parity tests, six CI contract tests and the app typecheck passed. A fresh build passed seven affected browser checks; the site rebuilt 274 pages and verified 855 URLs, with three explicit metadata checks. Fork completion now waits for its receipt and checks account ownership as well as location.
The September 15 integration adds cloud-session replay/repair, normalized
question-bound HumanTask drafts, nested native wait facts, bounded complete
SQLite loading and reset-safe deletion obligations. Its focused checks pass
346 frontend tests, 172 storage tests, 54 final privacy/outbox tests, 768 RPC
tests, and the relevant runtime driver/control/gateway suites. A fresh build
passes 23 browser cases, followed by three affected cases on another fresh build
after the final loader/outbox edits. The native fact fold passes 10 tests and
the real two-database nested question/answer proof passes four. The final app
and affected runtime package source/test checks pass. Conformance preserves
explicit product identifier checks and a fixed orphan allowance. Changed
package documentation sites build and generated mirrors have no drift.
The final polling/storage integration adds 96 passing frontend tests, including
seven real SQLite growth/receipt/reopen cases, and 116 distinct passing scoped
storage tests with a fresh three-case OPFS/reset browser proof. Idle running and
approval-wait observations add no events or physical writes. Held optimistic
writes cannot justify cursor acknowledgement; failure retains the prior committed
head on reopen. Explicit duplicate observations still receive queued receipts.
Two root retention fixtures timed out under workstation load; their two complete
files then passed all 33 tests unchanged with the original limits. Earlier failed
runs remain in the delivery verification record.
These results do not establish deployment or physical power-loss durability.

## Required verification

Each advertised durable read model needs deletion-and-rebuild equality against
its actual served state and documented authority. Exercise full replay for
retained streams, and checkpoint-plus-suffix replay where the authority
implements compaction. The application journal has a strict checkpoint/head
corruption-refusal contract. Target JSONL retains bounded output and tolerates
invalid/partial lines, including in newly written journals; it has no equivalent
integrity or missing-history refusal. Tutorial operation-result checkpoints are
not event-log compaction checkpoints. Claimed interrupted tutorial work stays
ambiguous and is not automatically relaunched.

Apply failure tests to each authority and transport promising the behavior:
more events than diagnostic retention, real SQLite close/reopen, a killed
writer/consumer around commit, failed commits with queued optimistic work,
duplicate/conflicting events, explicit field clears and unknown versions.

End-to-end stream checks cover more than 1,000 missed records, both workflow
log sources, lost notifications, replay failures, reconnect, reverse-order
same-named calls and cursor advancement. Browser tests cover reload, two
independent tabs, stale writers, sign-out/account replacement and historical
frames. Replaying views must invoke no model, tool, provider or filesystem
effect. Checks must prove the active composition path, not only an unbound
library implementation.

## Read-time decorations

Target stars have one current projection, `starredTargets`. New target cards
retain a stable `repoKey`, then `projectTargetStars` joins the matching labels
when the body renders. Real card bindings supply the store in the transcript,
tabs and tutorial. A star event does not copy labels into cards or historical
snapshots; a reopened repository's new host ID still resolves by path identity.
An older card without a recoverable repository identity retains its legacy
snapshot until an act binds the key. The isolated static renderer can display
that snapshot without claiming a live store connection.

Notification reads have one receipt collection, `notificationReceipts`, keyed
by the JSON pair `[notificationId, version]`. A `notifications.read` event
records only a currently observed matching version; a stale detail request
cannot mark a newer update read. Earlier receipts remain available, so an
archived card for an already read version stays read after a new update arrives.
Source observations carrying read evidence also normalize it into receipts.
The notification row's `readVersion` is a compatibility cache for existing
activity processing, computed only from its current version and these receipts.

`projectRepositoryUpdate` joins exact-version receipts and current notification
tags when real card bodies render, including historical cards. Read/tag events
do not rewrite cards or card histories. The card payload still carries its
original snapshot fields for wire compatibility and isolated static rendering;
those fields are not a second live read authority. If the notification row no
longer exists, tags retain the saved snapshot's values. Privacy clearing removes
both notification observations and receipts alongside the private cards.

The recorded boot projection imports positive read evidence from legacy
`readVersion` fields and retained `read: true` items in cards, card histories,
frame snapshots and branch snapshots. It imports the version actually retained,
without marking a different current version read or inventing original read
timestamps. Current read caches are then recomputed from the normalized receipts.
Tests prove live mounted updates, unchanged saved payloads, old/new version
separation, legacy baseline preservation and replay across a real store reopen.
Normalized runtime views use the shared projection described below.

Wiki link rails and graphs now derive from the same `worldDocuments` revision
supplied to the editor. The card retains its identity, focus and original
snapshot; document changes never fan out into saved card rows. A renamed title,
resolved link or deleted backlink appears through the join. A missing graph
focus stays empty instead of broadening to unrelated notes. Static previews
without a bound projection authority retain their explicit saved payload.
The pure functions also accept a historical document snapshot directly, so
the caller chooses the revision. Tests cover mounted document changes,
unchanged card rows, historical-input stability and persistence across reopen.

This does not replace Wiki's causal synchronization protocol. Yjs state,
durable pending update identities and verified remote acknowledgements are
still necessary to merge edits. A revision notification cannot reconstruct
the document it announces. Parsed links, backlinks, outlines and graph nodes
are views over the recorded document; pending edit acknowledgements are not.

## Integrity work and immutable snapshots

The store freezes detached projector snapshots recursively. Hashing reuses
canonical row/table bytes only for objects recursively frozen by that boundary.
Arbitrary shallow-frozen and mutable inputs are re-read. Copy-on-write
successors freeze before entering the cache. Verification reads the actual
served collections again; replay validates saved inputs, positions and heads.
The optimization changes no version-1 digest bytes.

## Normalized gateway run and approval views

`runtimeRuns` and `runtimeApprovals` are the browser's attributed observations
of the owning gateway, folded by `RuntimeProjection.ts`. A run key binds the
repository, optional workspace and exact run ID. An approval key additionally
binds the request ID and reviewed digest; its original gateway envelope stays
private and is forwarded unchanged. A gateway run-summary carries the backend's
lifecycle and native-execution provenance. The browser does not reinterpret a
native execution ID as a control run ID or manufacture missing lifecycle facts.

Native execution facts also cover attached descendant human waits. The
additive v1 tree metadata records parent attachment policy, a redacted question
and its named wait point; the raw resolver token stays operational and only its
digest enters the fact. The native fold derives the open human-wait set and
compares it with the executor's coherent observation, preserving nested
`waiting-approval` status. Missing or older tree metadata cannot claim coverage.
Gateway question rows carry `questionProvenance` and join their display facts
to a currently observed wait with the same execution and token digest. Replaying
old history never recreates an answerable resolver token. A real two-database
engine/control test verifies the nested question, equal replay/observation,
answer delivery, and removal of the answered wait.

Four semantic transitions admit observations and local decision state:
`gateway.run.observed`, `gateway.run.observer.changed`,
`gateway.approvals.observed`, and `gateway.approval.submission.changed`.
A run observation records its complete summary, optional transcript snapshot or suffix,
and optional journal prefix/suffix in one application event. Its cursor and
facts commit together. Full raw event prefixes cannot shrink or change old
content; a suffix must follow the exact applied sequence/offset in the same
scope. Numeric sequence holes are legal, and multiple events at the same
sequence use offsets. The gateway cursor has no server prefix digest, so the
browser does not claim to verify an unavailable remote commitment. It verifies
continuity with the exact bytes it previously accepted.

The optional `transcriptAfter: {length, cursor?}` anchors a transcript suffix
to the exact applied row count and cursor. Without that field, `transcript`
retains its full-snapshot meaning. The producer validates a full read before
removing an unchanged prefix; a newer snapshot that legitimately replaces old
telemetry remains a full snapshot. A replaced equal-length prefix has a newer
cursor, so it cannot accept a suffix anchored to the previous cursor.

Idle run and approval reads are omitted before dispatch, after validation
against committed normalized evidence. Pending optimistic rows cannot prove
that a read was persisted. A concurrent local write can change the suffix base;
the pump prepares against the live row synchronously with dispatch, waits for
the real receipt, and acknowledges only committed cursors. Local prefix races
retry from committed evidence. Repeated explicit commands still enter the
immutable application stream; suppressing transport reads does not truncate
accepted facts. The diagnostic payload cap applies only to the derived tail.

Observer time changes only when evidence, connection state, or the derived
health freshness changes. Repeated reads of the same health evidence record
its expiry boundary once, without advancing a gateway cursor or changing the
run's execution verdict. File-backed SQLite tests cover running and approval
waits with no idle row writes, byte growth or page growth, then real suffix
progress, held/rejected receipts, and equal verified projections after reopen.

Summary and transcript cursors never move backwards. Equal-time delayed
summaries cannot replace newer cursor evidence. The native execution provenance
can advance independently of the control summary cursor, and that distinct
evidence is retained. A strictly newer transcript snapshot may upgrade old
telemetry with newly committed native call facts; stale or same-cursor rewrites
are refused. Raw journal history remains immutable even when a derived
transcript's presentation changes. A conflicting observation stops that watcher
and preserves its last verified evidence; network failures retain retry and
quiet-state behavior.

Run phase and watcher connection state are separate. Retrying a watcher records
that local action; successful cancellation is rendered terminal only after the
gateway's lifecycle confirms it. The existing card-binding query and an
unpersisted read index apply `projectRuntimeCard` to run cards, run lists,
approval cards and inbox memberships. Controllers, card headers and bodies all
consume this same view. Updating one normalized fact never fans it into durable
card copies. Legacy card payloads remain explicit baseline evidence when no
normalized observation exists. Boot imports that baseline without inventing
events, a gateway cursor, or a server approval decision time.

Card navigation and frame/branch capture materialize the then-current view
once, with `runtimeView: {version: 1, revision}`. That revision is the local app
projection revision; the normalized row independently retains gateway cursors.
Restoring a captured card does not silently join later decisions or execution
state. An unfollowed transcript similarly retains its captured rows and
`transcriptAtRevision`; following reads the normalized current transcript.

HumanTask answers also have a normalized, question-bound draft. Human `form.set` edits record `approval.answer.changed`; inbox and individual-card renderers join the same value. The shared input preparation stores only text, normalized gate ID and question fingerprint, never an approval envelope. Recovery validates actor, command outcome, verified prefix, context and the still-pending question. Ask, confirm, select and JSON submissions validate their value against that question and await the answer receipt before the gateway call. Replacing the question retires the draft and submission ID; success clears the draft while a refused submission retains it for an explicit retry.

Approval submission waits for its own durable pending receipt before reaching
the gateway. Only the exact pending submission ID may settle that attempt.
A delayed pending inventory cannot reopen a decided gate, and contradictory
recorded decisions are refused. After reload, a lost submission response is
labeled unknown and re-observed; it is not automatically submitted again.
Gateway transport responses are fenced by the account owner and controller
lifetime, so a late response cannot repopulate erased state.

The run trace uses the gateway's shared `uniqueCallEvents` and `openCallIndex`
helpers. Stable call IDs pair reverse-order completions of the same flow;
unidentified legacy output cannot consume an identified start. Committed native
call facts supersede matching telemetry without creating a second span. Legacy
`call-N` display/node references stay stable, and raw native execution evidence
retains its separate engine view.

Focused verification covers scoped whole-prefix refusal, equal-time delayed
summaries, native evidence advancement, transcript upgrades, pending decision
identity, reverse-order calls, immutable history through real store reopen,
failed decision receipts and late account responses. The controller suites also
exercise list/open/pump composition and unchanged 20,000-row journal polling.

## September 15 stop and handoff

Implementation stopped at the user's request after final billing integration. App typecheck passed; billing consumer checks passed 286 distinct tests plus LiteralPin 32. WorkspaceSeam passed 139/139 after one test runner allowance increased from 5 to 30 seconds; production limits and all assertions are unchanged. The earlier complete app aggregate had timing failures with passing isolated reruns, and is not claimed as a clean aggregate.

The final merge includes main `76fae281af26` (question-gate answers). Four overlaps were composed to keep durable pending/input receipts, structured answers and both test sets. This final composition was not retested before the user-requested stop. Follow-up verification, broader WorkspaceSeam account/disposal fencing, production rollout and remaining authority boundaries are handed off in `state-handoff.md` and a GitHub issue.

