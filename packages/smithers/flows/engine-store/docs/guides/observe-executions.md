---
title: "Observe executions and page runs"
description: "Coherent engine snapshots, bounded filtered pages, revisioned catch-up, cancellation acknowledgement and durable child catalogs."
---

`ExecutionSnapshot`, `RunChangeFeed`, and `RunCatalogRead` read the engine's
database. Each has a `layer` requiring `SqlClient`; apply `Migrations.layer`
before constructing it. They start no polling fibers and read no control tables.

## Observe one execution or a batch

```ts
import { ExecutionSnapshot } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"

const observe = Effect.gen(function*() {
  const executions = yield* ExecutionSnapshot.ExecutionSnapshot
  return yield* executions.read(["build-42", "build-42/round-1"])
})
```

`read` accepts at most 200 IDs and returns observations in request order,
including duplicates. An empty batch still reads the source and watermark.
Every batch carries the database `source` and the global `revision` observed by
one read transaction. Each `Observed` entry carries its own run revision,
lifecycle, flow, creation/start/finish timestamps, effective parent, lineage and
round ordinal, structured wait, cancellation intent, and acknowledgement.

Observations describe the requested execution row. A completed predecessor
remains completed after a trampoline handoff. `related({ runId, kind: "rounds" })`
enumerates that logical job's rounds from any member; a consumer implementing
latest-round job status must select that round explicitly. The requested root's
identity and parent do not become the successor's identity and parent.

`Missing` is a separate variant. `deleted: true` means the database retains a
tombstone; `false` means no tracked row or deletion was observed. Neither is a
pending, running or terminal lifecycle. Absence without a tombstone carries the
batch watermark, so a later creation has a greater revision.

Waiting conditions have `kind` equal to `timer`, `signal`, `approval`, `quota`,
`human`, or `other`, and preserve `reason` and `wakeAtMs`. The opaque wake
token resolves the wait, so snapshots and run listings carry only
`tokenDigest`, its SHA-256, the same digest `ExecutionFacts` records. The
durable `event` reason maps to `signal`. Unknown plugin reasons remain `other`;
they never imply approval. Nullable fields preserve old records that did not
supply a deadline or token. Opaque wait reasons and tokens keep the engine
writer's existing non-empty string contract; observing them does not impose
the run-ID length limit.

The effective parent is `parent_run_id` when present, otherwise the durable
spawn edge with lowest sequence, breaking sequence ties by parent ID. Fork
parents and trampoline predecessors do not themselves create spawn ownership
edges. An old root with null lineage columns is round zero of its own lineage.

Malformed stored lifecycle, wait, identity, ancestry or revision data fails
closed with `RunStoreError`; schema failures use `decode_failed`. SQL failures
and defects use `persistence_failed` with the original cause. Interruption
remains interruption and releases the reserved connection and transaction.

The read uses a deferred SQLite transaction, allowing a WAL writer to commit
while it reads. All fields still describe the same database snapshot. A read
inside an existing transaction joins that transaction and can see its writes;
publish such observations only after that transaction commits.

## Cancellation intent and acknowledgement

`cancellation.requestedAtMs` is the recorded request. Its separate
`acknowledgement` contains the first observing owner's `{ hostId, pid, nonce }`
and `observedAtMs`. The owning driver records it under its running fence before
the cancel poll interrupts the body, and in its cancellation settlement path.
Other processes can record intent but cannot acknowledge as that owner.

Acknowledgement means the driver observed intent. It does not prove user
cleanup finished or that an external effect was undone. Cancellation terminality
comes from lifecycle status. Old rows have an unknown, null acknowledgement;
migration does not invent an observation or change control receipt shapes.

## Filter before pagination

`RunCatalogRead.listRuns({ filters, cursor, limit })` returns `runs`, an optional
next `cursor` (null at exhaustion), and the transaction's `source` and `revision`.
The default page is 100 and the allowed limit is 1 through 200. It computes no
total count. All filters apply in SQL before the limit:

| Filter            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `status`          | One engine lifecycle status.                                |
| `flowName`        | Exact engine flow name.                                     |
| `parentRunId`     | Exact effective parent; null selects rows without a parent. |
| `lineageId`       | Exact trampoline lineage, including its original root.      |
| `waitingReason`   | Exact durable reason; null selects no stored wait.          |
| `createdAfterMs`  | Inclusive minimum creation time.                            |
| `createdBeforeMs` | Inclusive maximum creation time.                            |

Omitted filters are unconstrained. Pages order ascending by immutable
`(created_at_ms, run_id)`, using SQLite's binary string order for ties. The
version-1 cursor binds that last key to the canonical filter tuple and source
identity. Changing the limit is allowed; changing filters or source is not.
Malformed cursors fail with `invalid_cursor`, foreign sources with
`source_changed`, and unsupported options with `invalid_options`. Numeric
offsets are not accepted or reinterpreted. Cursors are opaque continuation
values, not authorization tokens.

Run IDs and text equality-filter inputs use durable, non-empty text of at most
1,024 UTF-16 code units, without NUL or lone surrogates. Cursor input is bounded
at 65,536 UTF-16 code units, including JSON escaping. This admits every generated
cursor even when all maximum-length filter values need escaping. Observations
preserve longer existing flow names and opaque waits; the filter input bound is
an explicit admission limit of this new query API.

Each page is coherent at its own revision. Successive pages are live reads:
an insert after the last key can appear, an insert before it is not revisited,
and a deletion or status change can remove a later match. Equal creation times
are safe because the run ID breaks ties. Exhaustion is exact for an unchanged
query result; it does not freeze future history. Use change-feed reconciliation
when a consumer must account for changes behind an issued cursor.

Migration 0006 creates creation-order indexes for all 32 subsets of the five
equality predicates. This trades index storage and write work for ordered
bounded queries, including rare combined filters. Reads decode only the page
plus one lookahead. Earliest-parent subqueries are indexed and scoped to those
rows. No whole-history ancillary map or temporary page sort is required.

`listRunIds` retains its existing sync-polling behavior: newest rows by physical
row order, returned oldest first, default bound 10,000, with zero returning an
empty set. Its ordering and numeric limit contract have not changed.

## Enumerate engine-created children and rounds

`ExecutionSnapshot.related({ runId, kind, cursor, limit })` returns the requested
`anchor` (including explicit Missing), a batch of related snapshots, and a
continuation cursor, all in the same engine read transaction. `kind: "children"`
walks durable spawn edges in `(seq, child_id)` order. `kind: "rounds"` reads
lineage columns in `(round_ordinal, run_id)` order, including legacy round zero.
Both use a default limit of 100 and maximum of 200. Cursors are bound to source,
anchor ID and relation kind. Missing child rows remain explicit observations.

This catalog includes children with no control admission row. It reads direct
children, not a recursive descendant tree, and does not treat a fork as a spawn.

## Catch up without losing deletions

`RunChangeFeed.current` returns the source and current revision.
`changesSince({ source, revision, limit })` returns changes in revision order,
the current source watermark, `nextRevision`, and `hasMore`. Limits are 1 through
1,000. Each change carries `runId`, `source`, its latest `revision`, and `deleted`.
Use `nextRevision` for the next page, including when coalescing creates gaps.

This is a coalesced state feed, not a lifecycle event log. Several writes to one
run may become one newer entry. Revisions are global per database, durable,
monotonic integers; timestamps and journal sequence numbers are not substitutes.
Every run-row mutation, including heartbeat and wait updates, advances the
revision in the same transaction. Spawn-edge changes refresh the affected
existing child's parent and revision. A mutation can advance multiple times;
consumers must not expect contiguous per-run revisions.

Tombstones are retained indefinitely, one entry per deleted run ID. Ordinary
run retention, journal compaction, and acknowledgement do not remove them.
There is no consumer-expiration or compaction API, so even an indefinitely
offline registered consumer cannot lose required deletion evidence. Recreating
the same ID replaces absence with a strictly newer live revision. Storage grows
with distinct run IDs, including deleted IDs. Any future tombstone compaction
requires a separate registered-consumer retention and rebuild protocol.

A consumer can start at revision zero and exhaust bounded feed pages. Apply each
live snapshot or tombstone only if `ExecutionSnapshot.isNewer(incoming, stored)`
returns true. Advance its durable applied watermark in the same local transaction
as projection updates. A delayed pre-terminal observation then cannot overwrite
a newer terminal observation. A snapshot fetched after a feed entry can be newer
than that entry; retain its actual revision and ignore older replays.

## Source replacement and cross-database limits

Migration assigns a random durable database identity, preserved across normal
reopens. A different source or a feed checkpoint ahead of the source revision requires an
explicit projection rebuild. A copied backup carries the original identity:
do not independently write divergent copies or resume a rewound source against
an existing projection. Source rotation and restore/rebuild orchestration remain
host responsibilities; this port does not silently reset a consumer.

The engine's transaction is not a transaction across `control.db` and
`engine.db`. Control still owns admission, actors and approval decisions.
An engine-only page cannot include control admissions that have no execution
yet. The control projection consumer and public control list routing are a
separate integration step. They must expose their durable applied revision and
the source revision observed during catch-up to represent lag. These ports
provide that information but do not claim the control projection is current.
