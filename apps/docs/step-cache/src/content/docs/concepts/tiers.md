---
title: "Local and shared tiers"
description: "How CombinedCacheStore composes a durable local store with a shared HTTP tier: read-through, write-back, first-writer-wins on the local row, and why eviction, sweeps, and publication order stay where they are."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/step-cache/docs/concepts/tiers.md"
---

One machine's step cache makes a rerun cheap. A shared tier makes another
machine's work reusable. `CombinedCacheStore` composes the two, and its shape
is Bazel's `CombinedCache.downloadActionResult`: consult the local store, fall
back to the shared one only on a miss, and write what the shared one returned
back into the local store so the next lookup is local.

## Reads: local, then shared, then local again

A lookup tries the local tier first and returns its answer if it has one. On a
miss it asks the shared tier, and a shared hit is written back locally before
the caller sees it. The caller's `GetOptions` travel to both tiers, so a
provenance fence or an age bound means the same thing at each. If an exact
local `recordedBy` ledger row exists but `maxAgeMs` refuses it, the lookup
returns a miss without consulting the shared tier. An absent exact record
still permits fallback.

The write-back can lose: a sibling run on this machine may record its own row
under the digest while the lookup was inside the shared tier. The composition
then re-reads the local tier and serves the durable local row, because that is
the row this machine replays from and the row a fenced eviction must name.
Handing out the shared entry over a local `Conflict` would be a cache collision
the caller could not detect. If the local winner is already gone again, the
shared entry is the only row anyone holds and it stands. An expired exact
local record still stops this fallback with a miss.

## Writes: the local outcome is the answer

`put` snapshots the candidate once, then records locally. The local outcome is
what the caller receives, because first-writer-wins conflict detection has to
be decided against the durable row this machine will replay from. A local
`Conflict` is never published upward: publishing a result the caller is about
to fail the run over would spread the divergence.

Publication itself has two modes.

| Mode         | What `put` does                                                                  |
| ------------ | -------------------------------------------------------------------------------- |
| `"inline"`   | Writes both tiers before returning. The default.                                 |
| `"deferred"` | Writes the local tier only. Publishing to the shared tier belongs to the caller. |

`"deferred"` exists for one caller shape, and it is the common one in the
engine. [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) commits the cache row and
the journal record that explains it inside a single `DurableWriter`
transaction, and a host call must never be held across a write transaction: an
inline `put` would hold a network round trip inside it, block every other
writer for its duration. That engine composes this store in `"deferred"` mode
and publishes through its own `CacheSync` seam once the transaction has
committed.

The shared tier is only an accelerator. A refused read is treated as a miss;
a refused inline publication is counted and the local outcome is returned.

:::danger
A write transaction must never span a host call. A caller holding one wants
`"deferred"`.
:::

## The shared tier sees results verbatim

Cached results are never redacted (see [what the cache admits](/concepts/admission/)),
so a publication sends the step's `result` and `meta` verbatim to the shared
tier, and every host and operator with read access there can read them. Steps
whose results contain secrets must not be cached on a shared tier. In the other
direction, a shared hit is written back locally and replayed as the step's own
output, so whoever can write to the tier decides what other machines replay:
[authenticate and authorize every request](/guides/implement-a-shared-tier/#authenticate-and-authorize-every-request).

## Publication order is the caller's job

A cache entry must never be observable in the shared tier while an artifact it
references is missing from the shared artifact tier. That is Bazel's REAPI
ordering constraint, stated in its `UploadManifest.java` as "action results may
fail to validate server-side if they are accessed before all blobs they refer
to are present". `@smthrs/engine-store`'s `ArtifactSync` enforces it around
`put`. This store cannot: it does not know what an entry references. See
[`@smthrs/artifacts`](https://artifacts.smithers.sh/reference/api/).

## Eviction and sweeps stay local

`evict` and `sweepExpired` never reach across. Every eviction in the engine is
a "this host observed this row to be poison" judgement, and none of those
observations generalize to a tier where another machine may still hold the
artifacts this one lost. Reclaiming shared entries is an explicit retention
operation on the tier that owns them, never a side effect of one host's failed
replay. `RemoteCacheStore.sweepExpired` says so directly: it validates its
argument, issues no request, and answers `0`.

## What the counters mean once there are two tiers

`RemoteCacheStore` updates no counters. A lookup the composition serves from
the shared tier therefore registers one `miss`, for the local tier that did not
hold it, plus the write-back's `Inserted`. A two-tier hit rate measures how
often this machine already held the entry, not how often a result was reused.
A bounded provenance miss also performs an unbounded local read to distinguish
an absent exact record from an expired one. That read contributes its own
lookup counter even when the combined result remains a miss.

The composition adds one count of its own: when a shared `put` answers
`Conflict`, it records a `conflict`. That answer means the shared tier refused
to overwrite bytes it already holds under this digest, which on the head stage
is cross-host determinism divergence, and counting it is the only way an
operator sees it, because nothing else on that path returns, fails, or records
it.

## Related

- [Share results across machines](/guides/share-results-across-machines/):
  the composition as a task.
- [Implement a shared cache server](/guides/implement-a-shared-tier/): the
  three verbs a tier owes.
- [Observe cache outcomes](/guides/observe-cache-outcomes/): reading the
  counters this page describes.
