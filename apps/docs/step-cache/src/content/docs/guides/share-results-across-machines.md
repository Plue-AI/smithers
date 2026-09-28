---
title: "Share results across machines"
description: "Put an HTTP tier behind the local step cache with CombinedCacheStore: build the remote client, choose inline or deferred publication, and know what read-through, write-back, and eviction do once there are two tiers."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/step-cache/docs/guides/share-results-across-machines.md"
---

One machine's step cache makes a rerun cheap. A shared tier makes another
machine's work reusable. `CombinedCacheStore` composes the two so a lookup
tries the local store first and a recording is durable locally before the
network is involved.

## Before you start

- A cache endpoint that speaks the action-cache protocol. It must be HTTPS,
  unless its host is loopback, and it may carry no userinfo, query, or
  fragment. A path prefix is fine and a trailing slash is ignored. To stand one
  up, see [implement a shared cache server](/guides/implement-a-shared-tier/).
- The credential the endpoint expects, as a header value.
- An `HttpClient` in scope. `FetchHttpClient.layer` from `effect` is enough.
- The local store's database and migrations, as in
  [compose a durable step cache](/guides/compose-a-store/).

:::caution
Cached results are published verbatim. The cache never redacts a step's
`result` or `meta`, so with inline publication every machine and operator with
read access to the shared tier can read what the step returned. Steps whose
results contain secrets must not be cached on a shared tier. The server must
also authenticate every request and limit writes to trusted callers; see
[implement a shared cache server](/guides/implement-a-shared-tier/#authenticate-and-authorize-every-request).
:::

## 1. Build the shared tier

`RemoteCacheStore.make` validates its options and answers a
`CacheStore.Service` that speaks `GET`, `PUT`, and `DELETE` on
`/ac/{keyDigest}`:

```ts
import * as RemoteCacheStore from "@smthrs/step-cache/RemoteCacheStore"

declare const token: string

const remote = RemoteCacheStore.make({
  endpoint: "https://cache.example.com",
  headers: { authorization: `Bearer ${token}` }
})
```

| Option             | Effect                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`         | The cache root. `/ac/{keyDigest}` resolves beneath it.                                                                     |
| `headers`          | Sent with every request. The record is copied and frozen when the store is built, so a later mutation changes nothing.     |
| `requestTimeout`   | One deadline for a whole operation: its request, its response body, and the decoding between them. Defaults to 60 seconds. |
| `maxResponseBytes` | Largest cache-entry response accepted. Defaults to 4 MiB, and may not exceed it.                                           |

The client never follows a redirect, so a tier that answers `3xx` fails the
operation with `persistence_failed` instead of sending `headers` to another
origin. Do not wrap the `HttpClient` in `HttpClient.followRedirects`.

The endpoint and its credentials are a capability, never an input. They are not
hashed into a step key and never journaled, which is why they arrive as
construction options rather than as arguments to a lookup.

A bad option fails `make` with `invalid_cache` naming only the violated rule,
so a rejected `https://user:secret@host` cannot leak its credential into a log
line.

## 2. Compose the two tiers as one service

Both tiers inhabit the `CacheStore` tag, so `CombinedCacheStore.layer` takes
them as effects. Merging two `Layer<CacheStore>` values would shadow one with
the other:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as CombinedCacheStore from "@smthrs/step-cache/CombinedCacheStore"
import * as Migrations from "@smthrs/step-cache/Migrations"
import * as RemoteCacheStore from "@smthrs/step-cache/RemoteCacheStore"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

declare const token: string

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "flows.sqlite" })
)

export const sharedCache = CombinedCacheStore.layer({
  local: CacheStore.make,
  remote: RemoteCacheStore.make({
    endpoint: "https://cache.example.com",
    headers: { authorization: `Bearer ${token}` }
  })
}).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)
```

The result is one `Layer<CacheStore.CacheStore>`. Nothing above it knows there
are two tiers.

## 3. Choose when the shared copy is written

| Mode         | What `put` does                                                                  |
| ------------ | -------------------------------------------------------------------------------- |
| `"inline"`   | Writes both tiers before returning. The default.                                 |
| `"deferred"` | Writes the local tier only. Publishing to the shared tier belongs to the caller. |

The local outcome is the caller's answer in both modes, because
first-writer-wins conflict detection has to be decided against the durable row
this machine will replay from. A local `Conflict`, from either stage, is never
published upward: it would spread bytes the caller is about to fail the run
over.

:::danger
A write transaction must never span a host call. A caller that records the
cache row and the record explaining it in one transaction takes `"deferred"`,
and publishes after the transaction commits. An inline `put` inside a
transaction holds a network round trip in it and blocks every other writer for
its duration.
:::

That caller is [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/). It composes this
store in `"deferred"` mode and publishes through its own `CacheSync` seam once
the transaction has committed. If you are running flows rather than building an
engine, prefer that composition to this one.

## What you get

A lookup tries the local tier, falls through to the shared tier on a miss, and
writes a shared hit back into the local store before the caller sees it. Your
`GetOptions` travel to both tiers, so a provenance fence or an age bound means
the same thing at each.

If the shared tier refuses a lookup, the composition counts the refusal and
answers a miss so the step can execute. If an inline publication is refused,
it counts the refusal and returns the successful local outcome. A shared cache
outage never fails a run.

The write-back can lose a race with a sibling run on this machine. The
composition then re-reads the local tier and serves the durable local row,
because that is the row this machine replays from and the row a fenced eviction
must name.

`evict` and `sweepExpired` stay local. `RemoteCacheStore.sweepExpired`
validates its argument, issues no request, and answers `0`: the shared tier
owns its own retention.

Read the counters knowing that `RemoteCacheStore` updates none. A lookup served
from the shared tier registers one local `miss` plus the write-back's
`Inserted`, so a two-tier hit rate measures how often this machine already held
the entry. See [observe cache outcomes](/guides/observe-cache-outcomes/).

## Publish artifacts before entries

A cache entry must never be observable in the shared tier while an artifact it
references is missing from the shared artifact tier. This store cannot enforce
that: it does not know what an entry references.
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `ArtifactSync` enforces it around
`put`, over a shared [`@smthrs/artifacts`](https://artifacts.smithers.sh/reference/api/) tier. See
[share artifacts across machines](https://artifacts.smithers.sh/guides/share-artifacts-across-machines/)
and [share results with artifacts and the step cache](https://smithers.sh/docs/guides/artifacts-cache/).

## Where to go next

- [Local and shared tiers](/concepts/tiers/): read-through, write-back, and
  what the composition decides in each race.
- [Implement a shared cache server](/guides/implement-a-shared-tier/): the three
  verbs a conforming tier owes.
