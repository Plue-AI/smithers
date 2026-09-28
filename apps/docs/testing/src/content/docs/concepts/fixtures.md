---
title: "Fixtures and replay identity"
description: "How a recorded model call is identified: the canonical request encoding rather than a hash, what a recorder copies, which calls are never recorded, and how CachedModel and RecordedModel differ."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/concepts/fixtures.md"
---

A fixture is a portable recording of model calls. It is a JSON file with one
field, `calls`, and each call carries the request that was made, the model it
was recorded against, the events that came back, and the provider failure if
there was one.

Because a fixture is executable state, the rules around it are strict.

## File persistence and recovery

`FixtureStore.makeFile(path)` reads the JSON fixture and recovers completed
records from `path.journal`. Each `append` asynchronously writes one numbered
call followed by a newline to that journal. It does not rewrite earlier calls
or the JSON fixture. `load` returns the store's immutable in-memory snapshot.

Call the file store's `flush()` after recording to materialize the committable
JSON. `FixtureStore.layerFile(path)` flushes automatically when its scope closes,
including on test failure. Direct callers can use
`Effect.acquireRelease(FixtureStore.makeFile(path), (store) => store.flush())`.
A flush writes a unique temporary file beside the target and renames it over
the target only when complete. The JSON path always contains the previous or
next complete fixture. Commit the JSON file, not the journal or temporary files.
Read it first: it holds every recorded request verbatim, and the recorder
refuses only token-shaped credentials, not bearer tokens, URL credentials, or
private user content.

A fixture path permits one active writer. The first append acquires the
`path.lock` directory until `flush` releases it. Concurrent appends through one
store are serialized. Competing stores or processes fail with a defect naming
the path instead of overwriting calls. Construction also takes this lock while
reading, so open another store after the current writer flushes. An idle store
refreshes from disk before its next recording session; `load` alone does not
refresh changes from other stores. Do not address the same fixture through
symlink aliases.

The store opens `path.journal` with `O_NOFOLLOW` for every read, append, and
truncation. A symlink at that path fails with a defect naming it, so a planted
link cannot aim a recording run at another file. Windows has no `O_NOFOLLOW`.

After a killed process, confirm that no writer remains, remove `path.lock`,
and reopen the store. Complete journal lines are recovered; an unfinished last
line is discarded. Numbered records prevent duplication if the process died
after publishing JSON but before deleting the journal. Flush the recovered
store to publish those calls. Abandoned `path.*.tmp` files can then be removed.
These guarantees cover process interruption, not power loss: writes do not
issue `fsync`. Never edit or delete the JSON or journal while a writer is active.

Read, parse, and schema failures are defects whose messages name the failing
file and whose `cause` retains the underlying error.

## Identity is the canonical encoding, not a hash

`Fixture.canonicalRequestDigest` sorts object keys recursively, retains array
order, and rejects anything that is not JSON with a typed
`FixtureEncodingError` naming the path of the offending value. It returns the
canonical **encoding** rather than a fixed-length hash.

The name says digest and the value is the encoding, and the mismatch is
deliberate. A cache selects the recorded call to replay by this value, and a
hash collision would replay another conversation's response as this one's. The
package owns no synchronous cryptographic hash, and a non-cryptographic one
buys shorter keys at the cost of a wrong answer nothing would detect.

The cost that made length matter, re-encoding every recorded call on every
lookup, is paid once per fixture instead. `Fixture.index` builds a digest-keyed
map and memoizes it on the fixture object, so a hundred-turn agent fixture
encodes its calls once rather than O(n squared) times per run.

The memo is keyed by object identity. `FixtureStore` replaces the whole fixture
on every append rather than mutating it, so a recorded call is visible to the
next lookup. A caller that instead mutates a fixture's `calls` in place would
read a stale index.

That replacement is why the index alone was not enough while a run was still
recording. Every append published a fixture the memo had never seen, and the
rebuild re-encoded every call already recorded, so recording a hundred-turn
agent charged the whole transcript to every turn. Each recorded request is
therefore also memoized on its own identity, and that memo outlives the append.
It applies only to a frozen request, which is what a store's copy of a recorded
call is and what a fixture the caller still owns is not: an unfrozen request is
re-encoded, because nothing stops the caller rewriting it between two lookups.

Strings are compared by code unit throughout, never by locale, and
`canonicalRequestDigest` rejects a value nested more than 128 levels deep
rather than overflowing the stack.

## A recorder copies, and copies at the right moment

`RecordingModel` projects the request when the stream is **acquired**, not
after the exchange ends, and snapshots each event as it is emitted.
`Fixture.recordedRequest` deep-copies every collection it stores, tool
`parameters`, `stopSequences`, `itemIds`, and `addedToolNames` included.

Both details answer the same failure. A caller that mutates its own request
while an exchange is in flight would otherwise have recorded a request the
provider never saw, and an event object the provider reused or the caller
mutated would change what the fixture recorded after the fact.

The projection also exists because the production `ModelRequest` is a
`Schema.Class` whose messages, tools, and params are class instances. A
recorder that stored one verbatim would write a fixture whose shape depends on
the class, and the digest rejects any value that is not a plain object. The
copy keeps the recorded request, the decoded fixture, and the digest input the
same value.

A fixture loaded through `Fixture.decode` is a plain value. Nothing in this
package mutates it, so holding one fixture across many replays is the intended
use.

## Two calls are never recorded

**An interrupted call, one that died, or one the consumer abandoned.** A
truncated stream has no `settle` event and would replay as an aborted turn,
poisoning any cache built from the same fixture. The recorder flushes only when
the consumer pulled the stream to its end, or when the provider failed, and
stays silent otherwise. A consumer that stops early, such as `Stream.runHead` or
`Stream.take`, closes the stream's scope with a success but leaves the exchange
unfinished, so nothing is recorded.

**A call the kernel refused.** `PermissionRequired`, `PermissionDenied`, and
`GrantStoreError` are decisions made before the provider saw the request, so
there is no exchange to record. Replaying one would hand the code under test a
provider refusal the provider never made. The failure still reaches the caller
unchanged.

## A credential is never recorded

A fixture is meant to be committed, and a recorded call holds the system
prompt, every message, tool arguments and results, and the provider's error
text verbatim. Before `RecordingModel` hands a call to its sink, it scans the
serialized call with the token-shaped rules from `@smthrs/journal/Redaction`:
private key blocks, JWTs, and `sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox`, and
`AIza` keys. It also joins each text, thinking, and tool-call argument stream
in event order and scans the joined string, because a provider streams a key a
few characters per delta. A match fails the stream with a defect that names the
rule, not the value, and nothing is recorded.

The scan does not cover opaque bearer tokens, such as an `Authorization: Bearer`
header echoed in a tool result, or credentials embedded in a URL, such as
`https://user:password@host` in a request. Those are recorded verbatim.

The recorder refuses rather than redacts, because a redacted request no longer
has the digest its replay looks up. Remove the credential from the request,
tool output, or provider response, then record again.

## Two doubles, two questions

`CachedModel` and `RecordedModel` both replay, and they answer different
questions.

|                         | `CachedModel`                                         | `RecordedModel`                              |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------- |
| Matches on              | the whole canonical request, `modelId` included       | the request **shape**, with `modelId` erased |
| A call it does not have | runs against the live model and appends the recording | dies with `UnscriptedModelError`             |
| Reuse                   | serves one recording to every matching request        | claims each recorded call once               |
| Wrong model             | an ordinary miss, recorded as a second entry          | dies with `ReplayHarnessMismatchError`       |

Use `CachedModel` when a test only needs its calls to be free and
deterministic. Use `RecordedModel` when a test must assert that exactly the
recorded calls happened, which `RecordedModel.unconsumed()` reports.

The `model` field on a recorded call is the same value as `request.modelId`,
and decoding enforces that. It is stored separately because `RecordedModel`
matches by shape: once the shape has matched, `model` is what answers "was this
recorded against the model now asking?".

## The doubles die rather than fail

`UnscriptedModelError` and `ReplayHarnessMismatchError` are raised as defects,
not as typed failures, and they are deliberately absent from
`ModelLike.ModelLikeError`.

Both say the same thing: the fixture does not describe this run. That is a
defect in the test, not an outcome the code under test can handle, and neither
is a member of the production `ModelFailure` union. A replay model that failed
with one could not be adapted to the production seam without laundering it into
a provider code, and code that retries or falls back on provider failures would
then retry against a fixture that will never match. The test would pass or hang
for the wrong reason.

A defect cannot be caught by `Effect.catchTag` or a retry schedule, and it
fails the test at the call that has no recording. That is the intended
behavior.

## The package reads no environment

`CachedModel` records whatever the fixture is missing, so how a consumer
decides to record is the consumer's business: an environment flag such as
`SMTHRS_RECORD=1` that swaps the live model for one with no credentials, a
separate `test:record` script, or deleting the fixture file and re-running.
This package has no opinion and reads no environment variable.

[Replay a model instead of calling one](/guides/replay-a-model/) builds the
loop end to end.
