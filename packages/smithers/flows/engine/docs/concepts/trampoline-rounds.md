---
title: "Trampoline rounds and lineages"
description: "How a handoff opens the next round of a lineage, why the next round's execution id is derived rather than allocated, what maxRounds counts, and the two different ids this package calls a lineage."
sidebar:
  order: 6
---

A flow body can settle by naming the next round instead of returning a value.
That settlement is a handoff, and the chain of round executions it starts is a
lineage.

The lineage is the unit a user recognizes as "the run": a UI attaches to it, a
budget bounds it, and time travel addresses it. A round is one fully planned
graph inside it, with its own execution id and its own journal.

## Following a handoff is the caller's job

When a round settles as a handoff, the engine does not answer the caller with
it. It resolves the named target, decodes the handoff payload through that
target's own payload schema, derives the next round's execution id, and runs
it. One `execute` call therefore answers with the LINEAGE's value, and every
round underneath keeps its own identity.

With `discard: true`, admission returns round 0's execution id and the engine
follows handoffs in the flow registration's scope. Closing the submitting
caller's scope does not stop that work. Keep the registration open while the
lineage runs. A child lineage keeps its original parent on every round, so a
later round's completion wakes a parent parked behind it.

Two consequences follow from resolving the target by tag:

- The target must be registered with this engine. A handoff to an unregistered
  flow dies with `FlowNotRegistered`, naming both flows. The round itself is
  durable, so the lineage is not lost; what is wrong is the caller's wiring.
- The budget belongs to the lineage originator. A handoff to a flow with a
  different `maxRounds` cannot reset or replace the bound the lineage started
  with. The deadline is the originator's too: a round after a handoff runs
  under the lineage deadline the previous round stamped on its `Flow.Handoff`,
  which a durable store persists with the round it opens.

## The next round's id is derived, not allocated

Round 0's execution id is the one the caller executed, and it is also the
root execution id. Every later round's id is derived from the pair
`(rootExecutionId, ordinal)` through SHA-256.

Deriving rather than allocating is what makes the handoff at-most-once. A
process that dies between settling round N and opening round N+1 re-derives the
same id when it comes back, so the re-drive lands on the round that already
exists instead of starting a second copy of it.

Those derived ids are persisted as run rows, which makes the derivation a
compatibility surface rather than an implementation detail. Its preimage is
part of the package's durable contract, so an upgrade does not silently
re-address the rounds a lineage already opened.

## maxRounds counts rounds

`maxRounds` is declared on the flow and is a budget, not loop detection:
identical consecutive rounds are legal, and a runaway lineage is stopped by
counting rather than comparing.

It counts ROUNDS. A lineage bounded at `n` may open ordinals 0 through `n - 1`,
and the request for ordinal `n` is the one refused with
`Flow.MaxRoundsExceeded`. That makes `maxRounds: 1` mean "no handoff at all"
rather than "one handoff", which is what a reader of the number expects.

An absent budget is unbounded, which is the right default for a lineage whose
exit condition is its own branch. A budget that is not a positive safe integer
is refused with `InvalidRound`, as is a malformed root execution id or ordinal.

## Two ids are called a lineage

The word appears twice in this package, and they are different spaces.

| Name               | What it is                                                                                                                                                                         | Shape                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Trampoline lineage | Round 0's execution id, naming the chain of round executions one `execute` call follows. `Round` carries it as `rootExecutionId`.                                                  | A bare execution id.       |
| Journal lineage    | A run's position in its journal: the run id followed by the node path from the run root. `Lineage` mints it, and every durable record a run writes carries it as `meta.lineageId`. | A versioned encoded tuple. |

The shapes differ, so a value from one space is never an address in the other,
and `meta.lineageId` on an engine record always means the journal one. Each
space has its own brand, `Round.RootExecutionId` and `Lineage.JournalLineageId`,
so `Round.initial(Lineage.root(id))` does not compile.

A subflow is a separate run with its own journal, so nesting is a lineage EDGE
rather than a longer id: the node path only ever grows inside one run, and no
engine node contributes a segment today. `Lineage` therefore exports only
`root`; a path constructor arrives with the first node that contributes a
segment.

## Related

- [Execution identity](./execution-identity.md): why every round is a separate
  execution id, and what joining one means.
- [The API reference](../api.md) for `Round.initial`, `Round.next`,
  `Round.executionId`, and `Lineage.root`.
