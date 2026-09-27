---
title: "API reference"
description: "Every export of @smthrs/artifacts: the store contract and its errors, the filesystem, memory, no-op, HTTP, and combined implementations, the sweep, backup lease, and file lease, and the two metrics."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/artifacts/docs/api.md"
---

`@smthrs/artifacts` exports seven modules. Each is available from the root as a
namespace and from its own subpath:

```ts
import { ArtifactStore } from "@smthrs/artifacts"
import * as ArtifactStoreSubpath from "@smthrs/artifacts/ArtifactStore"
```

Addresses are the SHA-256 digests [`@smthrs/crypto`](https://crypto.smithers.sh/reference/api/) computes
through the injected `Crypto` service, which with `effect` is the whole
dependency list.

## Example

```ts
import { ArtifactStore } from "@smthrs/artifacts"

const program = Effect.gen(function*() {
  const store = yield* ArtifactStore.ArtifactStore
  const address = yield* store.put(new TextEncoder().encode("build output"))
  return yield* store.get(address)
})
```

## ArtifactStore

`@smthrs/artifacts/ArtifactStore`. The contract, its errors, and the three
local implementations.

### The contract

```ts
interface Service {
  readonly put: (bytes: Uint8Array) => Effect<Digest, ArtifactStoreError, Crypto>
  readonly get: (
    digest: string
  ) => Effect<Uint8Array, ArtifactMissing | ArtifactCorruption | ArtifactStoreError, Crypto>
  readonly has: (digest: string) => Effect<boolean, ArtifactStoreError>
  readonly findMissing: (digests: Iterable<string>) => Effect<Array<string>, ArtifactStoreError>
}
```

| Member        | Behavior                                                                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `put`         | Measures `bytes`, publishes them under that address, and returns it. Idempotent: storing the same bytes twice returns the same address and stores one copy. Every implementation snapshots the caller's buffer when the Effect begins and never retains the caller's reference.      |
| `get`         | Returns the bytes at `digest`, having verified that they still hash to it. Every successful read returns a new array. Fails with `ArtifactMissing` for a valid address with no bytes, `ArtifactCorruption` for a mismatch, and `ArtifactStoreError` for a host or transport refusal. |
| `has`         | Whether this tier holds an artifact at `digest`. Does not read or hash the bytes, so it needs no `Crypto`.                                                                                                                                                                           |
| `findMissing` | Which of `digests` this tier does not hold. The result is guaranteed to be a subset of the input, deduplicated in first-seen order.                                                                                                                                                  |

`ArtifactStore` is the service tag, with identity
`@smthrs/artifacts/ArtifactStore`.

Read operations accept a plain `string` rather than the `Digest` brand on
purpose: an address read back out of a durable row is untrusted input, so the
store validates it instead of asking every caller to re-brand a persisted
column. `put` returns the brand, because it measured the bytes itself.

### Digests

| Export                             | Meaning                                                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Digest`                           | Schema and branded type for exactly 64 lowercase hexadecimal SHA-256 characters, re-exported from `@smthrs/crypto`.                                                                                                                     |
| `validateDigest(digest: string)`   | `Effect<Digest, ArtifactStoreError>`. Refuses anything other than the canonical representation with code `invalid_digest`. The failure text is a bounded constant, so a hostile value cannot copy itself into a log or a durable error. |
| `measureBytes(bytes: Uint8Array)`  | `Effect<Digest, ArtifactStoreError, Crypto>`. Computes an address with the injected `Crypto` service, never retaining the bytes in an error.                                                                                            |
| `snapshotBytes(bytes: Uint8Array)` | `Effect<Uint8Array, ArtifactStoreError>`. Copies a caller-owned buffer when the Effect begins. A refused copy fails as `unavailable`, the code for a host refusal, because `Crypto` has not been consulted yet.                         |

Every implementation validates an address before logging it or interpolating it
into a path or a URL.

### Errors

| Export                   | Shape                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `ArtifactStoreError`     | Tag `@smthrs/artifacts/ArtifactStoreError`, fields `code`, `message`, optional `cause`.                               |
| `ArtifactMissing`        | Tag `@smthrs/artifacts/ArtifactMissing`, fields `code: "artifact_missing"` and `digest`.                              |
| `ArtifactCorruption`     | Tag `@smthrs/artifacts/ArtifactCorruption`, fields `code: "artifact_corruption"`, `recordedDigest`, `measuredDigest`. |
| `ArtifactStoreErrorCode` | Schema and type for the five stable codes.                                                                            |

A miss and a corruption are separate tags rather than codes because a
read-through composition acts on them differently: a miss is an ordinary
outcome a second tier may satisfy, and a corruption is a violation of the
store's strongest invariant.

| Code                    | Retryable | Meaning                                                     |
| ----------------------- | --------- | ----------------------------------------------------------- |
| `invalid_configuration` | No        | The caller supplied an option the store refuses. Permanent. |
| `invalid_digest`        | No        | The value is not a canonical SHA-256 address. Permanent.    |
| `digest_failed`         | Depends   | The `Crypto` service failed to compute a digest.            |
| `unavailable`           | Depends   | A host refused, or a no-op store has no implementation.     |
| `transport_failed`      | Depends   | The shared tier refused, answered unusably, or timed out.   |

### The filesystem store

```ts
declare const makeFileSystem: (fs: FileSystem, path: Path, options?: FileSystemOptions) => Service
declare const layerFileSystem: (
  options?: FileSystemOptions
) => Layer<ArtifactStore, never, FileSystem | Path>
```

`path` is the host's `Path` service (`NodePath.layer` on Node). The directory
sync walks the objects directory's ancestors with it, so a Windows drive path
syncs its real parents.

Publishes at `${directory}/${digest.slice(0, 2)}/${digest}`. Bytes land at a
unique temp path in the destination fanout directory, are synced when required,
and are renamed into place. Every deduplicated `put` verifies the existing blob
and rewrites an unreadable or mismatched address atomically, then freshens the
blob's modification time so a retention sweep reads it as recently referenced.

`findMissing` deduplicates and validates the full input before filesystem
probes, then checks at most 16 addresses concurrently. Missing digests retain
first-request order; a failed probe fails the batch as `unavailable`.

| `FileSystemOptions` field | Default            | Meaning                                                                                                                                                                                                                     |
| ------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directory`               | `defaultDirectory` | Where blobs are stored. Workspace-relative, so a workspace can be moved or copied whole. An `ArtifactSweep` over the same store must name the same directory.                                                               |
| `fileMode`                | `0o600`            | Creation mode for new payload files, restricted by the host umask. Existing blobs are unchanged.                                                                                                                            |
| `directoryMode`           | `0o700`            | Creation mode for objects and fanout directories, restricted by the host umask. Lock directories remain `0700`.                                                                                                             |
| `durability`              | `"required"`       | `required` syncs the blob, fanout directory, objects directory, and its ancestors and propagates any refusal. `best-effort` tolerates sync refusals. Both modes require exclusive writable handles and symlink inspection.  |
| `coordination`            | `"required"`       | `required` combines an in-process semaphore with heartbeat-backed lock files shared by every cooperating process. `process` keeps only the semaphore, giving up cross-process exclusion between writers and sweep deletion. |

`defaultDirectory` is `.flows/objects`. It is exported because the store and
its sweep must name the same directory, and a second private copy of the
literal is exactly how they would drift apart.

`required` bounds the writer-versus-sweeper race rather than eliminating it. A
lock is heartbeated every 10 seconds, reclaimed once it is 60 seconds stale, and
acquisition gives up after 2 minutes. Contenders that find the same stale lock
race for a claim file named after its owner, so the lock is moved at most once
and a fresh replacement is never displaced. A holder whose host stalls past 60
seconds is still reaped while running. Neither
`ArtifactSweep.RemoveOptions.ifUnmodifiedSinceMs` nor the backup lease protects
against that, because both depend on the same lock. Build a
store and its sweep with the same directory and coordination mode; no runtime
check can detect a mismatch. See
[Coordination between processes](/concepts/coordination/).

The store also sweeps its own crash orphans, `.tmp-*` payloads and `.locks/`
entries older than one hour, once per store instance on its first publication.
That is scratch reclamation, never garbage collection of published blobs.

### The memory store

```ts
declare const makeMemory: () => Service
declare const layerMemory: Layer<ArtifactStore>
```

For tests and for a browser host with no durable filesystem. It copies at both
boundaries around a private map, so no reference a caller can still mutate
aliases the stored content. It does not rehash a read, because its address
space is private and cannot disagree with itself.

`layerMemory` is a value, not a function.

### The no-op store

```ts
declare const makeNoop: (overrides?: Partial<Service>) => Service
declare const layerNoop: (overrides?: Partial<Service>) => Layer<ArtifactStore>
```

Every operation fails with an `unavailable` `ArtifactStoreError` whose message
is `<method> is unavailable`. Overrides replace individual methods, which is
how a test states the one behavior it cares about.

## RemoteArtifacts

`@smthrs/artifacts/RemoteArtifacts`. The shared tier, spoken over Effect's
`HttpClient`.

```ts
declare const make: (options: Options) => Effect<Service, ArtifactStoreError, HttpClient>
declare const layer: (
  options: Options
) => Layer<ArtifactStore.ArtifactStore, ArtifactStoreError, HttpClient>
```

`Service` extends `ArtifactStore.Service` with one field, `downloadPolicy`.
Composing `layer` alone makes every read and write a network round trip; the
intended production shape is `CombinedArtifacts.layer` with this as its remote
tier.

The wire protocol is `GET`, `PUT`, and `HEAD` at `/cas/{digest}` and `POST` at
`/cas/findMissing`, resolved beneath the endpoint. Every download is bounded and
digest-verified before it is returned. The complete server-side contract is in
[Serve the artifact protocol](/guides/serve-the-artifact-protocol/).

### Options

| Field                         | Default    | Meaning                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`                    | required   | The cache root, for example `https://cache.example.com`. A trailing slash is ignored. Refused at construction as `invalid_configuration` when it is not a string, when no `URL` parser accepts it, when the scheme is not `https:`, and when it carries userinfo, a query, or a fragment. The refusal names only the violated rule and never echoes the endpoint. |
| `headers`                     | none       | Headers sent with every request: this is the credential seam. Construction-time on purpose, because a credential arriving as a step input would be hashed into a step key and persisted everywhere the journal goes. Applied before the protocol's own headers, so no configuration can strip a `content-type`, `content-length`, or `content-range`.             |
| `downloadTimeout`             | 60 seconds | One download, including the complete response body.                                                                                                                                                                                                                                                                                                               |
| `uploadTimeout`               | 60 seconds | One upload, including every resume probe and chunk.                                                                                                                                                                                                                                                                                                               |
| `requestTimeout`              | 60 seconds | One `HEAD` probe, or one `findMissing` batch and its response.                                                                                                                                                                                                                                                                                                    |
| `maxDownloadBytes`            | 256 MiB    | The largest download buffered. A `Content-Length` past the bound is refused before a body byte is read; an incremental read stops at most one chunk past it.                                                                                                                                                                                                      |
| `maxFindMissingResponseBytes` | 256 KiB    | The largest `findMissing` response accepted. May only lower the protocol bound.                                                                                                                                                                                                                                                                                   |
| `chunkBytes`                  | absent     | Above this many bytes an upload travels as `Content-Range` requests, resuming from the prefix the tier kept.                                                                                                                                                                                                                                                      |
| `downloadPolicy`              | `"all"`    | How eagerly a composition reading through this tier materializes blobs locally.                                                                                                                                                                                                                                                                                   |

`findMissing` validates its input before sending anything, sends at most 1,000
digests per batch, and filters the response back to requested digests, so a
tier answering with an unrequested digest cannot make a caller upload bytes it
never asked about.

### Download policy

| Export                    | Meaning                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DownloadPolicy`          | Schema and type for `"all"`, `"toplevel"`, `"minimal"`.                                                                                  |
| `downloadPolicies`        | A frozen array of all three, in materialization order.                                                                                   |
| `downloadPolicyOf(store)` | Reads the policy a store declares, or `undefined` for one that declares none, which is every local store and any foreign implementation. |

`all` prefetches every referenced blob when a replay is admitted. `toplevel`
prefetches nothing and materializes a blob on the first read that needs it.
`minimal` prefetches nothing and materializes nothing.
`CombinedArtifacts.get` honors the last two;
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `ArtifactSync.hydrate` honors the
first.

### Chunked uploads

With `chunkBytes` set, the client sends a `HEAD` existence probe, then an empty
`Content-Range: bytes */{total}` probe to discover a retained prefix, then
ranged chunks:

| Response                      | Client action                                               |
| ----------------------------- | ----------------------------------------------------------- |
| `308`                         | Continue after the reported `Range: bytes=0-{last}` prefix. |
| `2xx` on the completing chunk | Confirm the complete length with `HEAD`.                    |
| `2xx` before completion       | Treat the tier as range-unaware and send the whole blob.    |
| `400`, `411`, or `416`        | Send the whole blob.                                        |
| Any other status              | Fail the upload as a transport error.                       |

The offset never moves backward. If a server ignores ranges, omits a confirming
length, or stores a partial body, the whole-blob `PUT` overwrites the partial
result. Both Smithers cache services answer a ranged `PUT` with `400` and cap
one request body at 16 MiB, so `chunkBytes` against them degrades
to one whole-blob `PUT` and a larger artifact is refused with `413`.

## CombinedArtifacts

`@smthrs/artifacts/CombinedArtifacts`. Local first, shared second, with
write-back.

```ts
declare const make: (options: Options) => Effect<RemoteArtifacts.Service, ArtifactStoreError>
declare const layer: <EL, RL, ER, RR>(
  options: LayerOptions<EL, RL, ER, RR>
) => Layer<ArtifactStore.ArtifactStore, EL | ER | ArtifactStoreError, RL | RR>
```

| `Options` field    | Default                         | Meaning                                                                                                                              |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `local`            | required                        | The fast, machine-local tier, as a `Service`. Every read tries this one first.                                                       |
| `remote`           | required                        | The shared tier, as a `Service`. Consulted only on a local miss or corruption.                                                       |
| `uploadTimeout`    | 60 seconds                      | How long a `put` waits for its opportunistic upload before abandoning it. An abandoned upload is dropped exactly like a refused one. |
| `writeBackTimeout` | 60 seconds                      | How long a `get` waits for opportunistic local write-back before interrupting it and returning the verified remote bytes.            |
| `downloadPolicy`   | the remote tier's, else `"all"` | Overrides the shared tier's declared policy for this composition.                                                                    |

`LayerOptions` is the same shape with `local` and `remote` as `Effect`s. Both
tiers are supplied as effects rather than layers because they inhabit the same
tag: composing two `Layer<ArtifactStore>` would shadow one with the other. Pair
`Effect.map(Effect.all([FileSystem.FileSystem, Path.Path]), ([fs, path]) => ArtifactStore.makeFileSystem(fs, path))`
with `RemoteArtifacts.make`.

Both timeout options must be finite, positive durations. Invalid values fail
construction with `ArtifactStoreError` code `invalid_configuration`.

**Reads.** The local tier answers first. A hit returns. `ArtifactMissing` and
`ArtifactCorruption` both fall through to the shared tier, and they are kept
apart because only corruption earns a write-back that `minimal` would otherwise
skip. A local `ArtifactStoreError` fails the read rather than falling through:
a host that refused has not answered the question, and paying for the network
instead would hide a broken local tier behind a working shared one.
Local write-back after a remote read is opportunistic. A typed failure or
`writeBackTimeout` expiry returns the verified remote bytes. Timeout interrupts
the write-back and waits for its interruption cleanup before returning.

**Writes.** `put` publishes locally first and returns the local digest. The
remote upload is opportunistic, deduplicated in flight by digest, and bounded by
`uploadTimeout`. A remote refusal or timeout does not fail the operation that
produced the bytes. The shared-cache publication protocol uses `findMissing`,
upload, and confirmation before it publishes a cache entry, so an abandoned
upload costs another transfer rather than correctness.

**Probes.** `has` asks local, then remote. `findMissing` asks the remote tier
only about what the local tier could not answer, so the result stays a subset of
the input because each stage filters the previous stage's output.

`minimal` still writes back after local corruption, because replacing an
address the local tier already claims is repair rather than growth.

## ArtifactSweep

`@smthrs/artifacts/ArtifactSweep`. Host-local enumeration and fenced deletion.
This surface is deliberately not part of `ArtifactStore.Service`: a remote tier
can neither enumerate its address space nor accept a delete, and only the
filesystem store implements it.

```ts
interface Service {
  readonly inventory: Effect<Array<BlobStat>, ArtifactStoreError>
  readonly remove: (digest: string, options?: RemoveOptions) => Effect<boolean, ArtifactStoreError>
}

declare const makeFileSystem: (fs: FileSystem, options?: SweepOptions) => Service
declare const layerFileSystem: (options?: SweepOptions) => Layer<ArtifactSweep, never, FileSystem>
declare const makeNoop: (overrides?: Partial<Service>) => Service
declare const layerNoop: (overrides?: Partial<Service>) => Layer<ArtifactSweep>
```

`ArtifactSweep` is the service tag, with identity
`@smthrs/artifacts/ArtifactSweep`.

| Export          | Fields                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BlobStat`      | `digest`, `modifiedAtMs`, `sizeBytes`.                                                                                                                        |
| `RemoveOptions` | `ifUnmodifiedSinceMs`: delete only while the blob's mtime is at or before this bound.                                                                         |
| `SweepOptions`  | `directory` (defaults to `ArtifactStore.defaultDirectory`) and `coordination` (defaults to `required`). No `durability`, because a sweep never writes a blob. |

`inventory` returns a `BlobStat` only for canonical fanout files whose
modification time is measurable. It skips temp files, lock files, foreign
paths, nested paths, directories sitting at blob addresses, and entries that
disappear during the scan. A directory that was never created is an empty
inventory, not a failure.

Candidate metadata reads run with concurrency 16 and retain directory-listing
order. Each candidate keeps its path checks; a failed metadata read skips only
that candidate.

`remove` returns `false` for three outcomes a caller cannot tell apart, all of
which mean nothing was reclaimed and retrying later is safe: the blob was
already gone, it failed the `ifUnmodifiedSinceMs` fence, or a live backup lease
fenced the deletion. The last one is not progress, so a collector counting
reclaimed bytes must not count it.

Under `required`, one deletion costs two lock acquisitions, the per-digest lock
and the workspace-global backup-lease gate, which is roughly ten filesystem
operations and two forked heartbeat fibers per blob. The gate is one file for
the whole workspace, so concurrent deletions serialize through it.

The policy this mechanism serves, which digests are live and how long a dead
blob is kept, belongs to [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s
`ArtifactGc`. See [Reclaim disk space](/guides/reclaim-disk-space/).

## ArtifactBackupLease

`@smthrs/artifacts/ArtifactBackupLease`. Cross-process exclusion between a
filesystem backup and sweep deletion.

```ts
declare const withLease: <A, E, R, E2>(
  fs: FileSystem,
  directory: string,
  effect: Effect<A, E, R>,
  failure: (cause: unknown) => E2
) => Effect<A, E | E2, R>

declare const unlessActive: <A, E, R, E2>(
  fs: FileSystem,
  directory: string,
  effect: Effect<A, E, R>,
  failure: (cause: unknown) => E2
) => Effect<Option<A>, E | E2, R>
```

`withLease` holds a heartbeat-backed marker while `effect` runs, so no sweep in
any process using `directory` can delete a blob. Publication stays
unconstrained: new blobs may appear during a backup, but a blob already
referenced by the frozen database cannot disappear underneath it. Acquisition
gives up after 2 minutes and fails through `failure`. A crashed lease becomes
reclaimable once its heartbeat is 60 seconds stale, and finding no marker to
release is the ordinary end of a slow lease rather than a fault.

`unlessActive` checks the marker and runs `effect` under the same
workspace-global gate, so the check and the operation cannot be separated. It
returns `None` when a live backup deliberately fenced the operation, which
`ArtifactSweep.remove` reports as `false`.

`failure` maps an unknown host cause into the caller's error type, which is how
these combinators stay usable from a tool with its own error channel. See
[Fence a backup against the sweep](/guides/fence-a-backup/).

## FileLease

`@smthrs/artifacts/FileLease`. The cross-process lock-file lease under the
per-digest locks and `ArtifactBackupLease`, exported for other packages that
need the same fence; `@smthrs/engine-store` uses it for the workspace commit
lock.

```ts
declare const withLease: <A, E, R, E2>(
  fs: FileSystem,
  lockPath: string,
  effect: Effect<A, E, R>,
  failure: (cause: unknown) => E2,
  options?: Options
) => Effect<A, E | E2, R>

declare const hold: <A, E, R, E2>(
  fs: FileSystem,
  lockPath: string,
  effect: Effect<A, E, R>,
  failure: (cause: unknown) => E2,
  options?: HoldOptions
) => Effect<A, E | E2, R>
```

`withLease` creates `lockPath` with `wx`, writes a unique owner token, and
refreshes its mtime while `effect` runs. It reclaims a lock whose mtime is
older than the stale bound, at most once per lock generation, and fails with
`failure(TimeoutError)` when acquisition misses its deadline. Every other host
refusal reaches `failure` as the `PlatformError`. A directory at `lockPath` is
treated as a lock with no readable owner and reclaimed on the same bound.
`hold` is the same lease without a deadline, for a caller that bounds a wider
wait itself; `onAcquired` runs once the lease is held.

| Option           | Default        | Meaning                                          |
| ---------------- | -------------- | ------------------------------------------------ |
| `heartbeatEvery` | `"10 seconds"` | How often the holder refreshes the lock's mtime. |
| `staleAfterMs`   | `60_000`       | Age past which a lock or reclaim claim is stale. |
| `acquireWithin`  | `"2 minutes"`  | Acquisition deadline (`withLease` only).         |
| `retryEvery`     | `"25 millis"`  | Sleep between attempts while contended.          |
| `label`          | `"File lease"` | Names the lock in the reclaimed-holder warning.  |
| `annotations`    | none           | Extra fields logged with that warning.           |

The host needs exclusive `wx` file creation, `readFileString`, `stat` with an
mtime, `utimes`, `rename`, and `remove`. Reclaim writes siblings named
`<lockPath>.reclaim-<token>` and `<lockPath>.stale-<token>`. The fence is
bounded: see [Coordination](/concepts/coordination/).

## ArtifactStoreMetrics

`@smthrs/artifacts/ArtifactStoreMetrics`. Metric handles only; no exporter
ships in this package.

| Export           | Counter                          | Updated by                                                                                              |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `puts`           | `flows_artifact_puts`            | Successful filesystem and memory puts, including deduplicated ones.                                     |
| `gets`           | `flows_artifact_gets`            | Successful filesystem and memory gets.                                                                  |
| `remoteFailures` | `flows_artifact_remote_failures` | Shared uploads and local write-backs `CombinedArtifacts` dropped, by `operation` (`put`, `write_back`). |

`remoteFailure.put` and `remoteFailure.write_back` are the attributed views.
Drops also log a warning naming the operation and error code, at most once a
minute per operation.

`RemoteArtifacts` is deliberately uninstrumented and the counters carry no tier
attribute, so read them as local artifact store traffic. A combined read the
shared tier serves increments no get; the write-back that materializes it
increments a put indistinguishable from a producer publishing new bytes.
Missing and corrupt reads are counted nowhere: they are error evidence, not
throughput.

## Reclaiming published blobs

Reclaiming published blobs never happens as a side effect of a store call. The
filesystem store sweeps only stale scratch and lock files. The mark policy and
grace period for published blobs belong to
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/), which also owns artifact
publication ordering.
