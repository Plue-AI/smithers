---
title: "Handle a compacted run"
description: "Restore a checkpoint and return its exact cursor before replaying the remaining history."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/guides/handle-a-compacted-run.md"
---

A cursor below a run's compaction floor names deleted history. The server
refuses it with `compacted` and `resync: { runId, checkpointSeq, generation }`.
The client fails without moving its cursor unless you supply `onResync`.

The handler must restore the missing prefix and return
`{ runId, afterSeq }` for the snapshot actually applied. A newer snapshot can
have a sequence above the reported floor. Returning the older floor after
applying that snapshot would replay part of its state twice. The client binds
the returned cursor to `resync.generation`, the run's history after any rewinds,
so a fresh follower needs no earlier cursor to resume it.

## Restore a remote public projection

The host must configure `SyncServer.SnapshotSource` with a provider that selects
only public state for the requested run, lineage, projection and schema version.
All authorized readers of that run can fetch it. Narrower or private data needs
its own authorization boundary. A raw `Journal.latestCheckpoint` passthrough is
unsafe because execution checkpoints are intentionally unredacted.

The client can fetch that projection in its recovery handler:

```ts
import type * as SyncClient from "@smthrs/sync/SyncClient"
import type { SyncError } from "@smthrs/sync/SyncError"
import type * as SyncProtocol from "@smthrs/sync/SyncProtocol"
import * as Effect from "effect/Effect"

const recoverPublic = <E>(
  sync: SyncClient.Service,
  identity: Pick<SyncProtocol.SnapshotRequest, "lineageId" | "projection" | "projectionVersion" | "capability">,
  applySnapshot: (snapshot: SyncProtocol.Snapshot) => Effect.Effect<void, E>
) =>
(resync: SyncProtocol.Resync): Effect.Effect<SyncProtocol.RunCursor, SyncError | E> =>
  Effect.gen(function*() {
    const snapshot = yield* sync.snapshot({
      ...identity,
      protocolVersion: 1,
      runId: resync.runId,
      atLeastSeq: resync.checkpointSeq
    })
    const cursor = { runId: snapshot.runId, afterSeq: snapshot.seq }
    yield* applySnapshot(snapshot)
    return cursor
  })
```

`snapshot` validates identity, version, sequence and byte limits; your callback
must still decode the projection's application schema and transactionally apply
its state and durable cursor. The handler fails with `snapshot`'s `SyncError`
or with your callback's own error `E`, and the subscription carries either
unchanged. A fetch alone never acknowledges missing history.
The host must retain a snapshot covering the compaction floor. If the floor
moves again before replay, recovery runs again for the newer floor.

## Restore through an authorized local source

A trusted local follower may alternatively read its execution checkpoint from
the journal and supply its own application callback:

```ts
import { Journal } from "@smthrs/journal"
import type * as SyncProtocol from "@smthrs/sync/SyncProtocol"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

class CheckpointUnavailable extends Data.TaggedError("CheckpointUnavailable")<{
  readonly message: string
  readonly resync: SyncProtocol.Resync
}> {}

const recoverFromJournal = <E>(
  journal: Journal.Service,
  applySnapshot: (checkpoint: Journal.Checkpoint) => Effect.Effect<void, E>
) =>
(resync: SyncProtocol.Resync): Effect.Effect<SyncProtocol.RunCursor, CheckpointUnavailable | E> =>
  Effect.gen(function*() {
    const saved = yield* journal.latestCheckpoint(resync.runId).pipe(
      Effect.mapError(() => new CheckpointUnavailable({ message: "Could not read the checkpoint", resync }))
    )
    if (
      Option.isNone(saved) ||
      saved.value.runId !== resync.runId ||
      saved.value.seq < resync.checkpointSeq
    ) {
      return yield* Effect.fail(
        new CheckpointUnavailable({ message: "No checkpoint covers the requested history", resync })
      )
    }
    const checkpoint = saved.value
    const cursor = { runId: checkpoint.runId, afterSeq: checkpoint.seq }
    yield* applySnapshot(checkpoint)
    return cursor
  })
```

Pass the returned function as `onResync`. `CheckpointUnavailable` is the
follower's own error, not a wire code, so the subscription reports it as a
local restoration failure rather than as the server's `compacted` refusal. The
required `applySnapshot` callback must actually decode and restore the
projection; logging a checkpoint is not restoration. Validate its run/lineage
and projection schema/version before using the state. Journal checkpoints are generic and intentionally
unredacted: never expose raw execution checkpoints to a remote follower merely
because that follower can read redacted history.

For a durable projection, commit the restored state **and its durable cursor**
in one application-owned transaction. On restart, seed a fresh sync client with
that committed cursor. The sync client's cursor is only in memory; its
interruption mask cannot make writes to separate stores atomic. Make recovery
idempotent so a crash or a moving compaction floor can safely repeat it.

Apply the same rule to every suffix entry: the `apply` callback must commit its
projection changes and durable cursor together before returning. Keep the
cursor with its run/lineage and projection version, so a cursor for one
projection cannot skip the history needed by another. On restart, read that
durable cursor, not a cursor cached separately before the crash.

| Crash point                                                | Durable recovery                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Between state and cursor writes, before transaction commit | Both writes roll back; restore the snapshot again.                                |
| After snapshot commit, before `onResync` returns           | Seed the fresh client with the committed snapshot cursor; replay only its suffix. |
| After an event commit, before `apply` returns              | Seed from that event's committed cursor; do not apply the event twice.            |

These are application-store transaction guarantees. The sync client does not
make arbitrary callbacks or external side effects exactly-once.

The client validates the receipt's run and sequence before advancing. Missing,
invalid, foreign-run or behind-floor receipts fail with the cursor unchanged.
If compaction moves again before the next read, recovery runs again for the
new floor.

## Refuse when restoration is unavailable

Omit `onResync` to preserve the original `compacted` refusal and cursor.
A handler may also fail with its own error if its snapshot is missing,
unauthorized, incompatible, or cannot be applied; the subscription fails with
that error unchanged. Failed or interrupted application never acknowledges the
deleted prefix.

A browser or remote follower without a configured public snapshot source must
not pretend to have rebuilt complete state. The RPC fails closed when the
host has not provided the requested public projection.

Returning the reported floor without restoring state would claim application
of deleted history. Keep the typed `compacted` result when reconstruction is
unavailable; clearing a projection does not recreate its missing prefix.

## Related pages

- [Compaction and resync](/concepts/compaction/): scope and failure semantics.
- [Checkpoints and compaction](https://journal.smithers.sh/concepts/compaction/): journal retention.
