/**
 * The engine store's one lock order for engine state and the journal.
 *
 * @since 0.1.0
 */

import type { DatabaseError } from "@smthrs/database/DurableWriter"
import type { Journal } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import type * as DurableEngineState from "../DurableEngineState.ts"

/**
 * Binds one ordered transaction boundary to a pair of stores.
 *
 * **The order is part of the package's contract.** Every fiber that needs
 * both boundaries takes `DurableEngineState.transaction` FIRST and opens the
 * journal's write transaction inside it. Never the other way around. The SQL
 * engine state cannot tell the difference, because its transaction and the
 * journal's are the same `DurableWriter` transaction and one of them nests as
 * a savepoint of the other either way. The memory engine state has a gate of
 * its own, and the contract requires the two implementations to be
 * semantically equal. Taking the journal transaction first leaves a fiber
 * holding the writer while it waits for that gate, which deadlocks against
 * any fiber holding the gate while it waits for the writer. Both waits keep the
 * caller's interruptibility: the state gate is taken first, then DurableWriter
 * queues for its own permit before entering Effect SQL's masked connection
 * acquisition. A journal-only writer never takes the state gate, so the
 * writer's permit is what keeps a caller waiting behind it cancellable.
 *
 * Within that order the boundary is atomic in both directions: a failure
 * before COMMIT rolls the SQL transaction back AND restores the memory
 * snapshot, and the memory snapshot is accepted exactly at SQL COMMIT,
 * through the `onCommit` callback registered before the body can queue any
 * publication. The gate is therefore already released when the journal runs
 * its post-commit work: compaction capture runs in a CHILD fiber and must see
 * a released gate, just as it sees a committed SQL transaction. Publication
 * failures happen after both commits and cannot undo either.
 *
 * `transact` defaults to the journal's own transaction. A caller passes its
 * own only to change how the writer's Exit is read, never to change the order.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  state: Pick<DurableEngineState.Service, "transaction">,
  journal: Journal.Service
) =>
<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  transact: <B, F, S>(
    write: Effect.Effect<B, F, S>
  ) => Effect.Effect<B, F | Journal.JournalError | DatabaseError, S> = journal.transact
): Effect.Effect<A, E | Journal.JournalError | DatabaseError, R> =>
  Effect.suspend(() => {
    let commit = Effect.void
    let bodyCompleted = false
    return state.transaction(
      transact(Effect.gen(function*() {
        yield* journal.whenCommitted(Effect.suspend(() => bodyCompleted ? commit : Effect.void))
        const value = yield* effect
        bodyCompleted = true
        return value
      })),
      {
        onCommit: (accept) => {
          commit = accept
        }
      }
    )
  })
