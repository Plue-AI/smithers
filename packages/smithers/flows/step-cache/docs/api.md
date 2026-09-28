---
title: "API reference"
description: "Every public export of @smthrs/step-cache: the CacheStore service, its schemas, limits and validators, the metric handles, the combined and HTTP tiers, the migration set, and the in-memory test layer."
---

`@smthrs/step-cache` stores sealed step results by content digest. One service
contract, `CacheStore.Service`, has three implementations in this package: the
SQL store, the HTTP client for a shared tier, and the composition of the two.
For the model behind the two tables, see
[the head and the ledger](./concepts/head-and-ledger.md).

## Example

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as TestCacheStore from "@smthrs/step-cache/test/TestCacheStore"
const cached = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  yield* cache.put({
    keyDigest: "compile-v1",
    result: { bytes: 41_022 },
    meta: {},
    createdAtMs: Date.now(),
    recordedRunId: "run-a",
    recordedEventSeq: 7
  })
  return yield* cache.get("compile-v1")
}).pipe(Effect.provide(TestCacheStore.layer))
```

## Entry points

| Import                                   | Exports                                                                                                 | Platform |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/step-cache`                     | `CacheStore`, `CacheStoreMetrics`, `CombinedCacheStore`, `Migrations`, `RemoteCacheStore` as namespaces | any      |
| `@smthrs/step-cache/CacheStore`          | the service, its schemas, its validators, and its layers                                                | any      |
| `@smthrs/step-cache/CacheStoreMetrics`   | the lookup and recording counters                                                                       | any      |
| `@smthrs/step-cache/CombinedCacheStore`  | the two-tier composition                                                                                | any      |
| `@smthrs/step-cache/RemoteCacheStore`    | the HTTP action-cache client                                                                            | any      |
| `@smthrs/step-cache/Migrations`          | the namespaced migration set                                                                            | any      |
| `@smthrs/step-cache/test/TestCacheStore` | the migrated in-memory store                                                                            | Node     |

The root is written against the driver-neutral
[`@smthrs/database`](/api/database) contract and bundles for the browser. The
test double binds a Node SQLite database, so it lives at its own subpath.
`@smthrs/step-cache/internal/*`, `@smthrs/step-cache/migrations/*`, and
`@smthrs/step-cache/*/index` are blocked by the export map. See
[platform support](/docs/reference/api/#platform-support).

## CacheStore

Durable content-addressed step result storage. The store receives digests and
results that a caller already computed; it never interprets a step layer, a
capability, or result metadata.

### CacheStore

```ts
class CacheStore extends Context.Service<CacheStore, Service>()("@smthrs/step-cache/CacheStore") {}
```

The service tag. `yield* CacheStore.CacheStore` resolves the store. The
identity string equals the defining module path, so a persisted digest that
folds in service identity keeps naming this module.

### Service

```ts
interface Service {
  readonly get: (
    keyDigest: string,
    options?: GetOptions
  ) => Effect.Effect<Option.Option<CacheEntry>, CacheStoreError>
  readonly put: (entry: CacheEntry) => Effect.Effect<PutResult, CacheStoreError>
  readonly evict: (
    keyDigest: string,
    options?: EvictOptions
  ) => Effect.Effect<boolean, CacheStoreError>
  readonly sweepExpired: (olderThanMs: number, options?: SweepOptions) => Effect.Effect<number, CacheStoreError>
}
```

| Method         | Answers                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get`          | The entry under `keyDigest`: the mutable head by default, the version a named provenance recorded when `options.recordedBy` is set, `Option.none()` for a miss.   |
| `put`          | `Inserted`, `ExistingSame`, or `Conflict`. One call writes the head row and the provenance row in a single transaction.                                           |
| `evict`        | `true` when a row was deleted, `false` when none matched. With `options.ifRecordedBy` the delete is one fenced compare-and-swap.                                  |
| `sweepExpired` | How many head rows were deleted. Rows recorded strictly before the floor go; a row recorded exactly at it stays. Ledger collection requires `canReclaimRecorded`. |

`get` and `evict` validate their arguments before any statement is issued, so a
malformed key, provenance, or age bound fails with `invalid_cache` rather than
reading as an ordinary miss. See
[read the result one event recorded](./guides/read-a-recorded-result.md) and
[evict a poisoned entry](./guides/evict-a-poisoned-entry.md).

### SweepOptions

```ts
interface SweepOptions {
  readonly canReclaimRecorded?: (
    reference: Pick<CacheEntry, "keyDigest" | "recordedRunId" | "recordedEventSeq">
  ) => Effect.Effect<boolean, CacheStoreError>
}
```

Optional host policy for old ledger rows. Return `true` only after all local
references to that exact provenance have been released. No callback means no
ledger collection. It runs inside the sweep's writer transaction and a failure
rolls back the sweep. The head deletion count remains the return value.
`CombinedCacheStore` forwards these options to the local tier only.

Quiesce all execution and replay while checking references and sweeping. See
[ledger retention](./troubleshooting.md#flows_step_cache_recorded-grows-and-nothing-reclaims-it)
for coordination requirements. The callback must use local reads and preserve
rows when reference state is unknown.

### CacheEntry

```ts
const CacheEntry: Schema.Struct<{
  keyDigest: typeof KeyDigest
  result: Schema.Unknown
  meta: Schema.Unknown
  createdAtMs: Schema.Int
  recordedRunId: typeof RecordedRunId
  recordedEventSeq: Schema.Int
}>
type CacheEntry = typeof CacheEntry.Type
```

The durable data recorded for one cache key.

| Field              | Meaning                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `keyDigest`        | The content address. One `KeyDigest` token.                                                                   |
| `result`           | The step's result, stored as a value. The store canonicalizes it on the way in and decodes it on the way out. |
| `meta`             | Result metadata, admitted and stored under the same rules as `result`. The store never interprets it.         |
| `createdAtMs`      | When the result was recorded, in epoch milliseconds. Age bounds and sweeps measure from this field.           |
| `recordedRunId`    | The run whose journal recorded the result.                                                                    |
| `recordedEventSeq` | The event within that run. With `recordedRunId` it is the provenance a replay reads through.                  |

`createdAtMs` and `recordedEventSeq` are non-negative safe integers. For what
`result` and `meta` may contain, see
[what the cache admits](./concepts/admission.md).

### GetOptions

```ts
type GetOptions = {
  readonly recordedBy?: RecordedBy
  readonly maxAgeMs?: number
}
```

`recordedBy` prefers the append-only ledger row that exact `(runId, eventSeq)`
pair landed, falling back to the mutable head only when the ledger holds no row
for that provenance.

`maxAgeMs` refuses an entry recorded more than that many milliseconds before
the current clock reading, and counts the lookup as a miss. It bounds the
ledger read and the head read alike, and one lookup resolves its age floor
once, so a row cannot be fresh for one read and stale for the other. The bound
is a read policy, never a deletion: the row stays on disk, so a second caller
declaring a longer bound still reads it.

The two compose in one direction only. A lookup naming a provenance the ledger
holds and the bound refuses answers a miss; it never falls through to the head.

### EvictOptions

```ts
type EvictOptions = {
  readonly ifRecordedBy?: RecordedBy
}
```

Deletes the row only while it still carries that `(runId, eventSeq)` pair, both
halves. Omitting the predicate deletes unconditionally. The predicate rides
inside the `DELETE`, so a fresher row another process recorded between a
caller's lookup and its eviction is never dropped with the poison.

### PutResult

```ts
type PutResult =
  | { readonly _tag: "Inserted" }
  | { readonly _tag: "ExistingSame" }
  | { readonly _tag: "Conflict" }
```

`Inserted` created the head row. `ExistingSame` found a row that does not
disagree. `Conflict` found bytes the store will not overwrite: the same
provenance re-recorded with a different `result`, `meta`, or `createdAtMs`, or
a different `result` another run already recorded under this digest. How the
two stages arbitrate is in
[the head and the ledger](./concepts/head-and-ledger.md).

### RecordedBy

```ts
const RecordedBy: Schema.Struct<{ runId: typeof RecordedRunId; eventSeq: Schema.Int }>
type RecordedBy = typeof RecordedBy.Type
```

The exact journal event that recorded a cache result. Sequence numbers are per
run and collide across runs routinely, so both halves are load bearing.

### KeyDigest

```ts
const KeyDigest: Schema.String
type KeyDigest = typeof KeyDigest.Type
```

One URL-segment-safe cache-key digest: 1 to `maximumKeyDigestLength`
characters matching `[A-Za-z0-9_-]`. The grammar makes `.`, `..`, path
separators, control characters, and lone surrogates unrepresentable, so a key
can neither escape the shared tier's `/ac/` namespace nor reach SQL as anything
but one opaque token.

### RecordedRunId

```ts
const RecordedRunId: Schema.NonEmptyString
```

The run id carried by a provenance record: non-empty, NUL-free, well-formed
text of at most `maximumRecordedRunIdLength` UTF-16 code units. Other control
characters are admitted deliberately. The id is opaque here, it reaches SQL as
a bound parameter and the wire as a percent-encoded query value, and every
stored ledger row is read back through this schema, so a narrower grammar
would make rows already on disk undecodable.

### CacheStoreError

```ts
class CacheStoreError extends Schema.TaggedError<CacheStoreError>()(
  "@smthrs/step-cache/CacheStoreError",
  { code: CacheStoreErrorCode, message: Schema.String, cause: Schema.optional(Schema.Unknown) }
) {}
```

The one error every operation of every tier fails with. Boundary diagnostics
name the offending field and never retain the rejected payload.

### CacheStoreErrorCode

```ts
const CacheStoreErrorCode: Schema.Literals<
  readonly ["invalid_cache", "constraint", "decode_failed", "persistence_failed", "unknown"]
>
type CacheStoreErrorCode = typeof CacheStoreErrorCode.Type
```

| Code                 | Raised when                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_cache`      | An argument violated the boundary: the key grammar, the provenance contract, an age bound, the JSON budget, or a shell the store cannot read as inert data. |
| `constraint`         | The database refused the write with a constraint or unique violation.                                                                                       |
| `decode_failed`      | A stored row, or a shared tier's response, could not be decoded back into a `CacheEntry`.                                                                   |
| `persistence_failed` | The database or the shared tier failed: a transport refusal, an unexpected HTTP status, an oversized body, or a request that passed its deadline.           |
| `unknown`            | A row the store had just written was missing inside its own transaction, or a `makeNoop` method no test supplied was called.                                |

See [troubleshooting](./troubleshooting.md) for the message text each one
carries and what to change.

### maximumKeyDigestLength

```ts
const maximumKeyDigestLength = 256
```

Maximum characters accepted in one cache-key digest.

### maximumRecordedRunIdLength

```ts
const maximumRecordedRunIdLength = 1024
```

Maximum UTF-16 code units accepted in a recording run id.

### maximumJsonBytes

```ts
const maximumJsonBytes: number
```

Maximum encoded bytes admitted for one `result` or `meta` tree: 4 MiB. It also
bounds a single string inside a tree, and a stored row whose UTF-8 encoding is
longer than it is refused before it is parsed.

### maximumJsonDepth

```ts
const maximumJsonDepth = 128
```

Maximum nesting admitted for one cache JSON tree.

### maximumJsonNodes

```ts
const maximumJsonNodes = 100000
```

Maximum values admitted for one cache JSON tree.

### maximumJsonMembers

```ts
const maximumJsonMembers = 100000
```

Maximum members admitted by one cache JSON array or object.

### make

```ts
const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient>
```

Builds the SQL-backed store over the context's write boundary and SQL client.
Use it when a composition needs the service as a value, for example as one tier
of `CombinedCacheStore.make`.

### layer

```ts
const layer: Layer.Layer<CacheStore, never, DurableWriter | SqlClient.SqlClient>
```

Provides the SQL-backed store. Compose the migrations beneath it so the tables
exist before the service is exposed. See
[compose a durable step cache](./guides/compose-a-store.md).

### makeNoop

```ts
const makeNoop: (overrides?: Partial<Service>) => Service
```

A store whose every operation fails with `unknown` and a message naming the
method, with optional per-method overrides. A test that reaches an operation it
did not supply is told which one, instead of reading a silent miss.

### layerNoop

```ts
const layerNoop: (overrides?: Partial<Service>) => Layer.Layer<CacheStore>
```

Provides `makeNoop`. See [test against the step cache](./guides/test-with-the-cache.md).

### encodeCanonical

```ts
const encodeCanonical: (value: unknown, field: string) => Effect.Effect<string, CacheStoreError>
```

Admits `value` under the JSON budget and encodes it as RFC 8785 canonical JSON
through [`@smthrs/canonical`](/api/canonical), failing `invalid_cache` with
`field` named in the message. Canonical form is what makes `put`'s text
comparison a structural one: two results built in different key orders encode
identically.

### encodeEntryCanonical

```ts
const encodeEntryCanonical: (entry: CacheEntry) => Effect.Effect<string, CacheStoreError>
```

Encodes a whole entry as RFC 8785 canonical JSON for the wire. The entry is
admitted under each field's own budget plus the envelope, one nesting level
and the five shell nodes, with `maximumJsonBytes` bounding the whole
encoding. A remote `put` therefore never refuses an entry a remote `get`
could have returned.

### validateKey

```ts
const validateKey: (keyDigest: string) => Effect.Effect<void, CacheStoreError>
```

Refuses a digest that violates the `KeyDigest` grammar before any statement or
request is issued.

### validateRecordedBy

```ts
const validateRecordedBy: (
  recordedBy: RecordedBy | undefined,
  field?: string
) => Effect.Effect<RecordedBy | undefined, CacheStoreError>
```

Decodes a provenance selector and returns the detached copy, or `undefined`.
Returning the decoded value lets an operation read a caller-owned accessor once
and never again.

### validateFence

```ts
const validateFence: (
  fence: EvictOptions["ifRecordedBy"]
) => Effect.Effect<RecordedBy | undefined, CacheStoreError>
```

`validateRecordedBy` with the field named `eviction fence`. A fence naming an
empty run or an impossible sequence number is a compare-and-swap no row could
satisfy, so running it would misreport a caller mistake as "nothing matched".

### validateAge

```ts
const validateAge: (
  field: string,
  value: number | undefined
) => Effect.Effect<number | undefined, CacheStoreError>
```

Refuses an age bound that is not a non-negative safe integer, and returns the
checked primitive so an operation computes its floor from the value it
validated.

### snapshotEntry

```ts
const snapshotEntry: (input: CacheEntry) => Effect.Effect<CacheEntry, CacheStoreError>
```

Takes an inert, detached, frozen snapshot of a candidate entry at effect start,
then decodes it against `CacheEntry`. The shell is read through its own
descriptors, so any object carrying exactly the six fields as enumerable own
data properties is accepted, including a class instance whose prototype methods
are never called. Accessors, symbol keys, and extra enumerable own members on
the shell are refused with `invalid_cache` without running caller code, and the
nested `result` and `meta` trees must be plain.

## CacheStoreMetrics

The metric handles the SQL store updates. This module defines them and nothing
else; no exporter ships here. Provide one, for example
[`@smthrs/observability`](/api/observability), and the counters appear in it.
See [observe cache outcomes](./guides/observe-cache-outcomes.md).

### lookups

```ts
const lookups: Metric.Counter<number>
```

Counter over cache lookups, dimensioned by `outcome`, named
`flows_step_cache_lookups`. Every update carries the attribute, so this bare
handle aggregates nothing and always reads zero. Read `hit` and `miss`.

### hit

```ts
const hit: Metric.Metric<number, Metric.CounterState<number>>
```

The `lookups` view counting hits: a row existed for the key digest and the
caller's bounds accepted it.

### miss

```ts
const miss: Metric.Metric<number, Metric.CounterState<number>>
```

The `lookups` view counting misses. That covers a digest with no row at all and
a row a `maxAgeMs` bound refused, which is a miss rather than a stale hit.

### puts

```ts
const puts: Metric.Counter<number>
```

Counter over cache recordings, dimensioned by `outcome`, named
`flows_step_cache_puts`. Read the views on `put`; the bare handle always reads
zero.

### put

```ts
const put: {
  readonly [Tag in "Inserted" | "ExistingSame" | "Conflict"]: Metric.Metric<
    number,
    Metric.CounterState<number>
  >
}
```

The `puts` views keyed by the `PutResult` tag the recording resolved to. Their
`outcome` attributes are `inserted`, `existing_same`, and `conflict`. A
`conflict` is the signal an inconsistency receiver acts on.

### remoteFailures and remoteFailure

```ts
const remoteFailures: Metric.Counter<number>
const remoteFailure: {
  readonly [Operation in "get" | "put"]: Metric.Metric<
    number,
    Metric.CounterState<number>
  >
}
```

`flows_step_cache_remote_failures` counts shared-tier refusals by `operation`.
Read its `get` and `put` views; the bare handle always reads zero.

## CombinedCacheStore

Two tiers composed into one `CacheStore.Service`: local first, shared second,
with write-back into the local store. The shape is Bazel's
`CombinedCache.downloadActionResult`. See
[local and shared tiers](./concepts/tiers.md).

### Options

```ts
interface Options {
  readonly local: CacheStore.Service
  readonly remote: CacheStore.Service
  readonly publication?: "inline" | "deferred" | undefined
}
```

| Field         | Meaning                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`       | The machine-local, durable tier. Every lookup tries this one first.                                                                                 |
| `remote`      | The shared tier. Consulted only on a local miss, and written through on `put`.                                                                      |
| `publication` | `"inline"` (the default) writes both tiers before `put` returns. `"deferred"` writes the local tier only and leaves the shared write to the caller. |

Take `"deferred"` whenever the `put` runs inside a write transaction: an inline
publication would hold a network round trip inside it. Lookups stay
read-through in both modes.

### make

```ts
const make: (options: Options) => CacheStore.Service
```

Composes the two tiers. `get` reads local, then remote, and writes a remote hit
back locally. A refused remote read is a miss. `put` records locally and, in
`"inline"` mode, publishes; a refused publication preserves the local outcome.
The shared tier is an accelerator and cannot fail either operation. `evict`
and `sweepExpired` are local only.

### layer

```ts
const layer: <EL, RL, ER, RR>(options: {
  readonly local: Effect.Effect<CacheStore.Service, EL, RL>
  readonly remote: Effect.Effect<CacheStore.Service, ER, RR>
  readonly publication?: Options["publication"]
}) => Layer.Layer<CacheStore.CacheStore, EL | ER, RL | RR>
```

Provides the composition under the `CacheStore` tag. Both tiers arrive as
effects rather than layers because they inhabit the same tag: merging two
`Layer<CacheStore>` values would shadow one with the other.

## RemoteCacheStore

The same `CacheStore.Service` contract spoken over HTTP: `GET`, `PUT`, and
`DELETE` on `/ac/{keyDigest}` carrying the `CacheEntry` JSON. This is the
action-cache half of Bazel's dumb-HTTP remote cache protocol. To stand one up,
see [implement a shared cache server](./guides/implement-a-shared-tier.md).

### Options

```ts
interface Options {
  readonly endpoint: string
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly requestTimeout?: Duration.Input | undefined
  readonly maxResponseBytes?: number | undefined
}
```

| Field              | Meaning                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`         | The cache root, for example `https://cache.example.com`. `/ac/{keyDigest}` resolves beneath it and a trailing slash is ignored.         |
| `headers`          | Headers sent with every request. This is the credential seam. The record is copied and frozen when the store is built.                  |
| `requestTimeout`   | One deadline for a whole operation: its request, its response body, and the decoding between them. Defaults to `defaultRequestTimeout`. |
| `maxResponseBytes` | Largest cache-entry response accepted. Defaults to `maximumEntryBytes`, and may not exceed it.                                          |

The endpoint must be HTTPS unless its host is loopback, and it may carry no
userinfo, query, or fragment. Anything else fails `make` with `invalid_cache`.
The endpoint and its credentials are a capability, never an input: they are not
hashed into a step key and never journaled.

All names configured in `headers` are redacted case-insensitively in Effect
HTTP tracing spans. Each request extends the caller's existing header
redaction policy locally, preserving its defaults and custom matchers.

Each operation closes its HTTP response scope before returning, including
misses, errors, publications, evictions, deadlines, and caller interruption.
Unread responses are aborted when that scope closes.

Redirects are never followed. A fetch-backed client runs every request with
`redirect: "manual"`, keeping the caller's other `FetchHttpClient.RequestInit`
options, so a `3xx` fails the operation with `persistence_failed` and the
credential headers never reach the redirect target. Do not wrap the client in
`HttpClient.followRedirects`: that middleware forwards every header except
`authorization`, `proxy-authorization`, and `cookie` to another origin.

`maxResponseBytes` counts encoded UTF-8 bytes, inclusively. Declared lengths
above the bound are rejected before reading; streamed bodies stop at the first
chunk that crosses the bound, with a size-specific `persistence_failed` error.

### defaultRequestTimeout

```ts
const defaultRequestTimeout: Duration.Duration
```

The default deadline for one whole remote operation: 60 seconds.

### maximumEntryBytes

```ts
const maximumEntryBytes: number
```

The default and absolute maximum encoded cache-entry size, equal to
`CacheStore.maximumJsonBytes`.

### make

```ts
const make: (
  options: Options
) => Effect.Effect<CacheStore.Service, CacheStore.CacheStoreError, HttpClient.HttpClient>
```

Builds the client over Effect's `HttpClient`, validating `options` first.

Status mapping for `put`, the one operation with a three-way outcome: `201` is
`Inserted`, any other 2xx is `ExistingSame`, and `409` is `Conflict`. A lookup
maps `404` to a miss, and an eviction maps `404` to `false`. Every other
non-2xx status fails with `persistence_failed`.

`sweepExpired` validates its argument, issues no request, and answers `0`: the
shared tier owns its own retention.

### layer

```ts
const layer: (
  options: Options
) => Layer.Layer<CacheStore.CacheStore, CacheStore.CacheStoreError, HttpClient.HttpClient>
```

Provides the client under the `CacheStore` tag. Composing it alone makes every
lookup a network round trip and leaves the machine with no durable record; the
intended production shape is `CombinedCacheStore` with this as its remote tier.

## Migrations

This package owns two tables and nothing else: the mutable `flows_step_cache`
head and the append-only `flows_step_cache_recorded` ledger. Migration
`0002_created_at_index` indexes `created_at_ms` on both, so `sweepExpired`
reads only expired rows.

### set

```ts
const set: DatabaseMigrations.MigrationSet
```

The namespaced migration set, namespace `step-cache`, reserving migration id
block `2000` so its ids can never collide with the journal's or the run
store's. [`@smthrs/engine-store`](/api/engine-store) composes it with the other
storage sets in dependency order.

### run

```ts
const run: Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  SqlError | Migrator.MigrationError,
  SqlClient.SqlClient
>
```

Creates the step cache schema, answering the migrations it applied.

### layer

```ts
const layer: Layer.Layer<never, SqlError | Migrator.MigrationError, SqlClient.SqlClient>
```

Runs the migrations before the database is exposed to the cache service.
Compose it beneath `CacheStore.layer`.

## TestCacheStore

```ts
const layer: Layer.Layer<CacheStore.CacheStore, SqlError | Migrator.MigrationError, never>
```

Imported from `@smthrs/step-cache/test/TestCacheStore`. The production SQLite
store over an in-memory database, with migrations already run. Node only. It is
the store the [quickstart](./quickstart.md) uses.
