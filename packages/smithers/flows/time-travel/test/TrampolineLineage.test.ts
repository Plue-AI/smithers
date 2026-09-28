/**
 * The lineage tree over a REAL trampoline, driven by `@smthrs/engine-store`.
 *
 * `SqlTimeTravelStoreOperations` pins the continuation edge against
 * hand-authored journal rows, which proves the SQL but not the contract: the
 * shape of a handoff decision belongs to the engine, and a projection agreeing
 * with a fixture the same commit wrote agrees with nothing. This suite runs the
 * engine's own trampoline and asks the lineage tree what it sees.
 *
 * @since 0.1.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Node } from "@smthrs/plan"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import type * as TimeTravelStore from "../src/TimeTravelStore.ts"

const rootRunId = "trampoline-lineage"

const Increment = Action.make("trampoline-lineage/increment", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

/**
 * The declaration shape the counter has, written out because the body names
 * the flow it is declaring.
 */
type CounterFlow = Flow.Flow<
  string,
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never,
  Action.Requirement<"trampoline-lineage/increment">
>

/** The recursion edge a body cannot name inside its own declaration. */
// eslint-disable-next-line prefer-const -- the body reads `self` before the assignment below binds it.
let self: CounterFlow

const Counter: CounterFlow = Flow.make("trampoline-lineage/counter", {
  payload: { value: Schema.Number, target: Schema.Number },
  success: Schema.Number,
  body: ({ target, value }: { readonly value: number; readonly target: number }) =>
    Increment.call({ value }).pipe(
      Node.branch({
        if: (next) => next >= target,
        then: (next) => Flow.done(next),
        else: (next) => self.to({ value: next, target })
      })
    )
})
self = Counter

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "trampoline-lineage" as never, changeId: "trampoline-lineage" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const stores = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  AttemptStore.layer,
  CacheStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)))

const engineLayer = Layer.mergeAll(
  Increment.toLayer(({ value }) => Effect.succeed(value + 1)),
  Interpreter.layer(Counter)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(
    EngineStore.layer({
      owner: { hostId: "trampoline-lineage-test" },
      journalSource: "trampoline-lineage-test",
      isAlive: () => Effect.succeed(false)
    })
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      stores,
      StepBoundary.layerTest(),
      Layer.succeed(Jj.Jj, jj),
      OwnerIdentity.layer
    ).pipe(Layer.provideMerge(NodeCrypto.layer))
  ),
  Layer.provideMerge(TestDatabase.layer)
)

/** Runs the two-round lineage, then hands the body the durable evidence. */
const drive = <A, E>(
  body: (input: {
    readonly store: TimeTravelStore.Service
    readonly entries: ReadonlyArray<JournalEvent.Entry>
  }) => Effect.Effect<A, E, SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    // Counts 0 -> 1 -> 2: round 0 hands off, round 1 finishes.
    yield* Counter.execute({ value: 0, target: 2 }, { executionId: rootRunId, discard: true })
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: rootRunId as JournalEvent.RunId, limit: 200 })
    const store = yield* SqlTimeTravelStore.make
    return yield* body({ store, entries: page.entries })
  }).pipe(
    Effect.provide(engineLayer),
    Effect.scoped
  )

const handoffSeq = (entries: ReadonlyArray<JournalEvent.Entry>): number => {
  const handoff = entries.find((entry) =>
    entry.eventType === "flows.engine.run-decision" &&
    (entry.payload as { readonly decision?: unknown }).decision === "handed-off"
  )
  if (handoff === undefined) throw new Error("the engine journaled no handoff decision")
  return handoff.seq
}

describe("the lineage tree over an engine-driven trampoline", () => {
  it.effect("reports the next round as a detached continuation of the round that handed off", () =>
    Effect.gen(function*() {
      const observed = yield* drive(({ entries, store }) =>
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const rounds = yield* sql<{ readonly runId: string; readonly roundOrdinal: number }>`
            SELECT run_id AS "runId", round_ordinal AS "roundOrdinal"
            FROM flows_runs
            WHERE lineage_id = ${rootRunId}
            ORDER BY round_ordinal
          `
          const descendants = yield* store.descendants(rootRunId, {
            lineageId: `${rootRunId}/root`,
            // One before the handoff: a frame the handoff is still ahead of.
            seq: handoffSeq(entries) - 1
          })
          return { rounds, descendants, handoff: handoffSeq(entries) }
        })
      )

      // The engine really ran two rounds under one lineage.
      expect(observed.rounds.map((row) => row.roundOrdinal)).toEqual([0, 1])
      expect(observed.rounds[0]?.runId).toBe(rootRunId)

      // And the tree reports the second one as a detached continuation: a
      // round is its own run row with its own claim and its own journal, so
      // rewinding past the handoff orphans it rather than undoing it.
      expect(observed.descendants.attached).toEqual([])
      expect(observed.descendants.detached).toEqual([{
        parentRunId: rootRunId,
        parentSeq: observed.handoff,
        childRunId: observed.rounds[1]?.runId,
        kind: "continuation",
        attached: false
      }])
    }))

  it.effect("leaves the continuation out of a frame that already follows the handoff", () =>
    Effect.gen(function*() {
      const observed = yield* drive(({ entries, store }) =>
        store.descendants(rootRunId, {
          lineageId: `${rootRunId}/root`,
          seq: handoffSeq(entries)
        })
      )

      expect(observed).toEqual({ attached: [], detached: [] })
    }))
})
