---
title: "Frames and lineage"
description: "How time travel addresses a run's past: a frame is a lineage and a journal sequence, a lineage is not a run, and the edges between them are the tree fork and rewind reason over."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/time-travel/docs/concepts/frames-and-lineage.md"
---

Every time-travel operation names a point in history the same way, and it is
worth understanding that address before anything else. Get the frame right and
the four verbs are one call each; get it wrong and every one of them answers
`not_found`.

## A frame is an address, not a snapshot

A `Frame` is two fields:

```ts
import type { Frame } from "@smthrs/time-travel"

const frame: Frame.Frame = { lineageId, seq: 17 }
```

`seq` is the zero-based journal sequence of the last record the frame
includes. Frame `n` covers every record with `seq <= n`, so frame `0` is the
state after the first record, and frame `1` folds the first two.

| History     | `replay` / `inspect` at frame `0` | `rewind` to frame `0`         |
| ----------- | --------------------------------- | ----------------------------- |
| Empty       | `not_found`                       | Accepted, nothing to truncate |
| One or more | Folds record `0`                  | Keeps record `0`              |

A fork at frame `0` copies record `0`. No frame addresses the state before a
written first record.

The frame stores no state. Time travel derives everything else by folding the
records the address covers, which is why history cannot drift from what was
recorded. [Derived state](/concepts/derived-state/) explains what that fold reads
and the two facts it cannot derive.

A `Position` pairs a frame with the run the operation acts on:

```ts
const position = { runId: "ledger-1", frame }
```

## A lineage is not a run

The frame carries `lineageId` rather than `runId`, and the difference matters
as soon as a run branches. A fork or a continuation starts a new run but may
keep walking the same lineage, so the run a frame belongs to is a property of
the tree, not of the coordinate.

A run's journal can also interleave several lineages. Every fold filters by
`meta.lineageId`, so a frame reads exactly the lineage it names and no other.

## The lineage id is minted, never spelled

`FlowEngine.Lineage` from [`@smthrs/engine`](https://engine.smithers.sh/reference/api/) is the one
constructor for a lineage id. The value is a versioned encoding rather than a
path, and the encoding has already changed once:

```ts
import { FlowEngine } from "@smthrs/engine"

const lineageId = FlowEngine.Lineage.root("ledger-1")
```

The engine stamps the result on every record a run writes, so an ordinary run
is addressable as it stands. A hand-assembled string addresses no record, and
every verb refuses it as `not_found`.

This package stores and compares the value and never parses it, which is why it
takes no dependency on the engine. A caller holding records rather than a run
id reads `meta.lineageId` off any entry the run committed instead.

## Edges make the tree

Every operation that creates a run from a frame records a `LineageEdge` back to
it:

| Field         | Meaning                                                           |
| ------------- | ----------------------------------------------------------------- |
| `parentRunId` | The run the child branched from.                                  |
| `parentSeq`   | The frame it branched at.                                         |
| `childRunId`  | The run that was created.                                         |
| `kind`        | `child`, `fork`, or `continuation`.                               |
| `attached`    | Whether the child still depends on the history under `parentSeq`. |

The three kinds are three different relationships:

- `child` is an ordinary nested run the parent spawned.
- `fork` is a time-travel branch that copied a prefix of the parent's journal
  and now runs alongside it. Only a fork produces two live runs sharing a past,
  which is why a rewind treats forked descendants differently from the rest.
- `continuation` is the parent carrying on under a new run id after a rewind
  truncated it.

`attached` is the flag a rewind's policy reads. An attached child still depends
on the history being truncated and must be resolved: cancelled, or the rewind
refused. A detached child has been cut loose already and survives the rewind as
an independent run, reported only so the operation can say what it left
running.

The store reads this as one tree across both producers: the fork edges this
package writes and the child spawns the engine writes. A descendant is a
descendant however it came to exist.

## A fork says so on its own journal

A forked run records its own origin, so a forensic walk can start from any
child and go back without consulting the edge table:

```ts
import { Frame } from "@smthrs/time-travel"

Frame.forkCreatedEventType // "flows.time-travel.fork-created"
```

The record sits directly above the copied prefix and carries `parentRunId`,
`childRunId`, and `forkJournalOffset`, the parent `seq` the fork was taken at.
Reading the offset back is how a walk maps a child sequence number onto the
parent's timeline.

## Where to go next

- [Replay a run into a view](/guides/replay-a-run/) uses a frame to read.
- [Fork a run at a frame](/guides/fork-a-run/) creates a `fork` edge.
- [Rewind a run to a frame](/guides/rewind-a-run/) is where `attached`
  decides the outcome.
