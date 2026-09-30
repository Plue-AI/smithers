---
title: "The head and the ledger"
description: "Why one put writes two rows: a mutable head an ordinary lookup serves, and an append-only provenance ledger a replay reads, plus the two stages that decide Inserted, ExistingSame, and Conflict."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/step-cache/docs/concepts/head-and-ledger.md"
---

The step cache owns two tables, and the difference between them is the whole
design.

| Table                       | What it is                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flows_step_cache`          | The mutable head. One row per `key_digest`. This is what an ordinary lookup serves and what an eviction or a sweep reclaims.                                                                |
| `flows_step_cache_recorded` | The append-only ledger. One row per `(key_digest, recorded_run_id, recorded_event_seq)`. This is what a replay of that exact event reads. Collection requires an explicit reference policy. |

One `put` writes both, inside a single `DurableWriter` transaction. A crash
between the two would leave a head a lookup serves without the provenance a
replay reads, and the two answers would disagree forever, so the transaction is
the contract: a process killed mid-`put` leaves neither row, and the file still
takes the next write.

## Why the head may be a cache and the ledger may not

Evicting the head is a judgement about the future: this host observed this
result to be poison, so no later execution should reuse it. Deleting a ledger
row would be a claim about the past, and a past run's projection is a function
of what that run recorded. Rewriting the evidence would change a replayed
answer, so eviction protects future executions without touching recorded
history.

That is why `get(keyDigest, { recordedBy })` reads the ledger first and falls
back to the head only when the ledger holds no row for that provenance. The
fallback exists for entries recorded under some other provenance: a fork
sharing its parent's keys, or a shared-tier write-back.

## The head is rebuildable

Every head the engine inserts is journalled: an `admitted` provenance entry
commits with the inserting `put`, and each engine eviction is journalled before
its fenced `evict`. `@smthrs/engine-store`'s `StepCacheFold.rebuild` folds those
entries and `rebuildHeads` copies the surviving ledger rows back into the head.
The ledger stays the content store, so results never enter the journal.

## The two stages of a recording

`put` decides its answer in two stages, and both matter.

1. **The provenance stage.** The ledger insert runs first, `ON CONFLICT DO
   NOTHING`. If a row already exists under that exact
   `(keyDigest, recordedRunId, recordedEventSeq)`, its complete bytes decide
   the outcome: identical `result`, `meta`, and `createdAtMs` mean this is a
   retry, and anything else is `Conflict`. That record is immutable, so an
   evicted head can be restored from the same bytes and never rewritten with
   different ones.
2. **The head stage.** The head insert runs next, also `ON CONFLICT DO
   NOTHING`. A fresh insert is `Inserted`. An existing row is arbitrated on the
   canonical `result` alone: a second run recording the same result under its
   own provenance carries a different `meta`, `createdAtMs`, and run identity
   without being a conflict, so that is `ExistingSame`.

`Conflict` therefore names either refusal: an immutable provenance record asked
to hold different bytes, or a head asked to hold a different `result`. Only the
head stage needs two runs, so a retry that changes `meta` or `createdAtMs`
alone conflicts inside one run. That is the signal an inconsistency receiver
acts on, and reporting it where it has not happened fails a run over a
divergence that does not exist.

Whether an insert conflicted, and whether a fenced delete hit, are read through
`affectedRows` from [`@smthrs/database`](https://database.smithers.sh/reference/api/) rather than a
driver-specific `changes` cast, so the outcomes hold on every backend.

## Why canonical form is load bearing

The head stage compares stored text. `JSON.stringify` output depends on key
insertion order, so two structurally equal results built in different orders
compared unequal and produced a `Conflict` that named a divergence that had not
happened. The store canonicalizes `result` and `meta` on the way in, through
[`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/), which makes the text comparison a
structural one. The HTTP tier encodes the same way before it puts an entry on
the wire, so a value with no JSON form is refused identically by both tiers.

## First writer wins, across connections

Two connections putting different results under one digest at the same moment
produce exactly one `Inserted` and one `Conflict`, and the surviving row is one
writer's entry end to end, never a mix of one writer's result with the other's
provenance. Readers racing a writer and a stale fenced eviction see whole
entries or nothing: there is no torn row and no `decode_failed`.

## What reclaims a ledger row

By default, whole-run reclamation belongs to
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/), whose retention pass erases a
terminal run's ledger rows by `recorded_run_id` together with its journal.

Remote write-back preserves the original provenance because local frames can
replay it. A foreign run id matches no local run-scoped delete. To bound these
imports, supply `canReclaimRecorded` to `sweepExpired`. The callback authorizes
collection of each old provenance only after all local references are released.
It also applies to existing imports, without a schema migration. An omitted
policy preserves every ledger row.

Reference checks and deletion share a writer transaction. Hosts must also
quiesce execution and replay so an in-flight lookup cannot publish a reference
after collection. See [ledger retention](/troubleshooting/#flows_step_cache_recorded-grows-and-nothing-reclaims-it)
for the policy contract and coordination requirements.

## Related

- [Read the result one event recorded](/guides/read-a-recorded-result/):
  the provenance fence as a task.
- [Expire cached results](/guides/expire-cached-results/): the head's
  retention and optional ledger collection.
- [Content addressing](https://smithers.sh/docs/concepts/content-addressing/): where a
  `keyDigest` comes from.
