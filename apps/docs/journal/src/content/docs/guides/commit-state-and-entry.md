---
title: "Commit state and its entry together"
description: "Use Journal.transact to append a lifecycle entry in the same write transaction as the state transition it describes, and learn the three rules that keeps."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/journal/docs/guides/commit-state-and-entry.md"
---

Committing an entry makes that entry durable. It does not by itself make a
host's whole view crash-consistent, because the executable state lives in other
stores: `RunStore` and `AttemptStore` in
[`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/), `CacheStore` in
[`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/), and `DurableEngineState` in
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/).

`transact` closes that seam. It runs a state transition and the `emitDurable`
calls describing it in one write transaction, so either both land or neither
does.

## Wrap the transition and the entry

```ts
import { Journal, JournalEvent } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"

const finish = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const runs = yield* RunStore.RunStore

  return yield* journal.transact(Effect.gen(function*() {
    const receipt = yield* journal.emitDurable({
      runId,
      sourceId,
      sourceSeq: 7 as JournalEvent.SourceSeq,
      eventType: "run.finished",
      payload: { outcome: "succeeded" }
    }, owner)
    const result = yield* runs.transitionOwned(runId, owner, "completed")
    if (result._tag !== "Transitioned") return yield* Effect.fail(result)
    return receipt
  }))
})
```

The fenced append runs while the owned row is still running. Transitioning to
`completed` first invalidates the journal fence. Both stores write through
the same `DurableWriter`, so the entry and terminal transition join this
transaction as savepoints and commit or roll back together. If the transition
is rejected, the entry rolls back too.

## Three rules the transaction keeps

**Publication follows commit.** Inside a transaction, `emitDurable` returning
means a savepoint was released, not that anything is visible. The `changes` and
`stream` publish and the in-process producer index update are parked until the
outermost transaction commits. A subscriber therefore never sees an entry that
later rolls back, and a rolled-back producer identity stays re-emittable
instead of deduplicating against a sequence that does not exist.

**Only storage work belongs inside.** The transaction is held for the whole
body. No flow bodies, no host calls, no waits. In particular, never call
`flush` inside `transact`: it waits on the lossy writer, which is waiting on
the transaction you are holding.

**Nesting is a savepoint.** An inner `transact` becomes a savepoint of the
outer one and defers its publication to the outermost commit. If its failure
is caught by the outer transaction, its publication is discarded even when
the outer transaction succeeds. This also holds when another store opens the
outer transaction through the same `DurableWriter` and SQL client.

Projections can register short, non-failing cache updates with the service's
`journal.whenCommitted(update)`. It uses the shared database commit owner and
is bound to this journal's database: an unrelated database's nested commit
cannot publish its updates. Outside a transaction the update runs immediately;
inside a managed transaction it waits for the outer commit. Its `true` result
means the update was accepted, not necessarily already executed. A `false`
result means ownership is unknown; skip optional cache updates then. Raw
`sql.withTransaction` and raw savepoints are not owned by this hook. Journal
writes in them remain durable on commit, but skip process-local publication;
`entries` and the polling `stream` still read the authoritative SQL history.
Use `transact` or `DurableWriter.write` when immediate `changes` notifications
are required.

The lower-level `Journal.afterCommit` re-export has the database helper's
different outside-transaction contract: it returns `false` without publishing.
Test doubles implementing transactions must preserve commit/rollback semantics
for `whenCommitted`, not run updates immediately from transaction bodies.

## What a transaction does not buy

A crash before COMMIT loses the whole unit, so work that had already run, an
action body for instance, re-executes on the next drive. Design the body to
tolerate that.

And no local transaction makes a remote effect atomic. External effects still
need idempotency keys, fencing tokens, or compensation.

## A note on retries

The pinned Node SQLite driver uses `BEGIN IMMEDIATE`, acquiring its writer
lock before reading allocation floors. A caller-supplied SQL client may use
DEFERRED transactions; under WAL its lock upgrade can fail with
`SQLITE_BUSY_SNAPSHOT`. The shared writer retries transient contention at the
whole-transaction boundary in either case, floor read included.

A `transact` body must therefore be safe to run more than once. Process-local
publication belongs in `afterCommit`, outside that retry loop.

## Next steps

- [The two channels](/concepts/two-channels/) for why the durable channel
  returns only after commit.
- [Durable execution](https://smithers.sh/docs/concepts/durable-execution/) for the execution
  model this transaction supports.
