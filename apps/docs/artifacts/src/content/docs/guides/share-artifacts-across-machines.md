---
title: "Share artifacts across machines"
description: "Compose a local filesystem store behind an HTTP cache with CombinedArtifacts, choose a download policy, and set the deadlines and chunk size the shared tier needs."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/artifacts/docs/guides/share-artifacts-across-machines.md"
---

A machine that reads an artifact another machine produced needs two tiers: the
fast local one it owns, and a shared HTTP one it does not. `CombinedArtifacts`
composes them so a read tries local first and a write is durable locally before
the network is involved at all.

## Before you start

- A shared cache endpoint that speaks the artifact protocol. It must be HTTPS,
  unless its host is loopback, and it may carry no userinfo, query, or fragment. If you are standing one up,
  see [Serve the artifact protocol](/guides/serve-the-artifact-protocol/).
- The credential the endpoint expects, as a header value.
- An `HttpClient` in scope. `FetchHttpClient.layer` from `effect` is enough.

## 1. Build the shared tier

`RemoteArtifacts.make` validates its options and returns a store. The endpoint
and its headers are construction options, never step inputs: a credential that
arrived as an input would be hashed into a step key and persisted everywhere
the journal goes.

```ts
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as CombinedArtifacts from "@smthrs/artifacts/CombinedArtifacts"
import * as RemoteArtifacts from "@smthrs/artifacts/RemoteArtifacts"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

declare const token: string

const combined = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const local = ArtifactStore.makeFileSystem(fileSystem, yield* Path.Path)
  const remote = yield* RemoteArtifacts.make({
    endpoint: "https://cas.example.com",
    headers: { authorization: `Bearer ${token}` }
  })
  return yield* CombinedArtifacts.make({ local, remote })
})
```

Construction fails with `invalid_configuration` for a value that is not a
string, one no `URL` parser accepts, a scheme other than `https:`, and an
endpoint carrying userinfo, a query, or a fragment. The refusal names only the
violated rule and never echoes the endpoint, so a rejected
`https://user:secret@host` cannot leak its credential into a log line.

Your own headers are applied first and the protocol's are applied after, so no
configuration can strip the `content-type`, `content-length`, or
`content-range` the tier needs to interpret the body.

## 2. Provide the composition as a layer

`CombinedArtifacts.layer` takes both tiers as effects rather than layers,
because both inhabit the `ArtifactStore` tag and merging two layers of one tag
would shadow one with the other:

```ts
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as CombinedArtifacts from "@smthrs/artifacts/CombinedArtifacts"
import * as RemoteArtifacts from "@smthrs/artifacts/RemoteArtifacts"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

declare const token: string

export const sharedArtifacts = CombinedArtifacts.layer({
  local: Effect.map(
    Effect.all([FileSystem.FileSystem, Path.Path]),
    ([fs, path]) => ArtifactStore.makeFileSystem(fs, path, { directory: ".flows/objects" })
  ),
  remote: RemoteArtifacts.make({
    endpoint: "https://cas.example.com",
    headers: { authorization: `Bearer ${token}` },
    downloadPolicy: "toplevel",
    chunkBytes: 8 * 1024 * 1024
  })
})
```

The layer requires whatever its two effects require, here a `FileSystem`, a
`Path`, and an `HttpClient`, and it provides `ArtifactStore` to everything above it.

## 3. Choose a download policy

The policy answers one question: how eagerly does this machine copy other
machines' artifacts onto its own disk?

| Choose     | When                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all`      | The default. A long-lived machine that will read most of what it fetches, and wants replay to read local bytes.                                   |
| `toplevel` | A machine that should not prefetch a whole run's artifacts, but should keep the ones it actually reads.                                           |
| `minimal`  | An ephemeral or disk-constrained host: a CI container, a sandbox. Reads are served straight from the shared tier and the local store never grows. |

Declare it once on the shared tier, as above, and every composition reading
through that tier inherits it. `CombinedArtifacts.Options.downloadPolicy`
overrides it for one composition when a single host needs to differ.

`minimal` still writes back after local corruption. That is repair of an
address the local tier already claims, not growth.

## 4. Set the deadlines

Every remote exchange is bounded, and every bound defaults to 60 seconds,
Bazel's `--remote_timeout` default for the same protocol:

| Option                                    | Covers                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `RemoteArtifacts.Options.downloadTimeout` | One download, including the complete response body                                |
| `RemoteArtifacts.Options.uploadTimeout`   | One upload, including every resume probe and chunk                                |
| `RemoteArtifacts.Options.requestTimeout`  | One `HEAD` probe, or one `findMissing` batch and its response                     |
| `CombinedArtifacts.Options.uploadTimeout` | How long a combined `put` waits for its opportunistic upload before abandoning it |

Two more bounds protect this process from a mis-serving tier.
`maxDownloadBytes` defaults to 256 MiB: a `Content-Length` past the bound is
refused before a body byte is read, and an incremental read stops the moment it
crosses. `maxFindMissingResponseBytes` defaults to the protocol's 256 KiB and
may only lower that bound.

## 5. Turn on chunked uploads, if your tier supports them

With `chunkBytes` set, a blob past that size travels as a sequence of
`Content-Range` `PUT` requests, preceded by a `HEAD` existence probe and an
empty `bytes */{total}` probe that asks what prefix the tier already holds.

| Tier's answer                 | Client action                                              |
| ----------------------------- | ---------------------------------------------------------- |
| `308`                         | Continue after the reported `Range: bytes=0-{last}` prefix |
| `2xx` on the completing chunk | Confirm the stored length with `HEAD`                      |
| `2xx` before completion       | Treat the tier as range-unaware and send the whole blob    |
| `400`, `411`, or `416`        | Send the whole blob                                        |
| Anything else                 | Fail the upload as a transport error                       |

The offset never moves backward, and a tier that ignores ranges, omits a
confirming length, or keeps only part of the body gets one whole-blob `PUT`
that overwrites whatever the sequence left behind. So the cost of turning the
dial on against a server that never learned about it is round trips, never a
digest published over bytes the server does not hold.

Set it when a proxy caps request bodies, or when artifacts are large enough
that losing a transfer partway is expensive. It is absent by default.

The hosted and self-hosted Smithers cache services do not implement the
resumable sequence: both answer a ranged `PUT` with `400` and cap one request
body at 16 MiB. Against them `chunkBytes` costs the probe round trip
and the blob travels whole, and a blob past 16 MiB is refused with `413` in
either mode.

## What you get

A read that misses locally reaches the shared tier, and the fetched bytes are
digest verified before they are returned, because the shared tier is the least
trusted store there is: it is written by machines this one has never met. A
mis-serving or compromised cache can waste a round trip; it can never
substitute content.

A write is durable locally before the upload starts, and the upload's failure
is dropped rather than propagated. Ordering between the artifact tier and the
step cache is not this package's job:
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `ArtifactSync` enforces that a
cache entry is never observable in the shared tier while an artifact it
references is missing from the shared artifact tier.

## Related

- [The three tiers](/concepts/tiers/): what falls through, what does not,
  and why.
- [Serve the artifact protocol](/guides/serve-the-artifact-protocol/): the HTTP
  surface a conforming shared tier owes.
- [Share results with artifacts and the step cache](https://smithers.sh/docs/guides/artifacts-cache/):
  the end-to-end composition on smithers.sh, including the step cache's own
  shared tier.
