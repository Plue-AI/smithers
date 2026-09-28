/**
 * Run lineage as the ENGINE produces it.
 *
 * `ControlLineage` drives the projection with run rows a test wrote, which
 * proves the SQL and nothing about the contract: the columns a child and a
 * trampoline round are recorded in belong to `@smthrs/engine-store`, and a
 * projection that agrees with a fixture the same commit wrote agrees with
 * nothing. This suite runs a real flow that starts two child runs and a real
 * three-round trampoline over one SQLite database, then asks the control plane
 * what it sees.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Jj from "@smthrs/jj"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Node } from "@smthrs/plan"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as SqlTimeTravelStore from "@smthrs/time-travel/SqlTimeTravelStore"
import * as TimeTravel from "@smthrs/time-travel/TimeTravel"
import { Effect, Layer, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import type { ControlEvent, ListResponse, RunSummary } from "../src/ControlSchema.ts"
import * as Lineage from "../src/Lineage.ts"
import { controlPlane, type DurableStack } from "./DurableStack.ts"

const parentRunId = "engine-lineage-parent"
const trampolineRunId = "engine-lineage-counter"
const childIds = ["engine-lineage-child-a", "engine-lineage-child-b"] as const

/** A child run: its own row, its own claim, its own journal. */
const Child = Flow.make("engine-lineage/child", {
  payload: { label: Schema.String },
  success: Schema.String,
  body: ({ label }: { readonly label: string }) => Node.succeed(label)
})

/**
 * The action a parent's handler starts its children from.
 *
 * A body is planned rather than run, so the execution that makes one run the
 * parent of another happens inside a handler, where the parent's own
 * `FlowInstance` is the ambient one (`docs/pages/concepts/subflows.md`).
 */
const StartChildren = Action.make("engine-lineage/start-children", {
  payload: {},
  success: Schema.String
})

const Parent = Flow.make("engine-lineage/parent", {
  payload: {},
  success: Schema.String,
  body: () => StartChildren.call({})
})

/** The step a trampoline round advances by. */
const Increment = Action.make("engine-lineage/increment", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

/**
 * The counter's declaration shape, written out because the body names the flow
 * it is declaring.
 */
type CounterFlow = Flow.Flow<
  string,
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never,
  Action.Requirement<"engine-lineage/increment">
>

/** The recursion edge a body cannot name inside its own declaration. */
let self: CounterFlow

const Counter: CounterFlow = Flow.make("engine-lineage/counter", {
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
  snapshot: () => Effect.succeed({ commitId: "engine-lineage" as never, changeId: "engine-lineage" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/**
 * One database, shared by the engine and the control plane.
 *
 * `Layer.provideMerge` builds what it provides privately, so the database is
 * provided ONCE, to both halves at the end. Providing it inside each half
 * would build two in-memory SQLite databases with no rows in common.
 */
const database = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  AttemptStore.layer,
  CacheStore.layer,
  DurableEngineState.layer
).pipe(
  Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)),
  Layer.provideMerge(Layer.merge(TestDatabase.layer, NodeCrypto.layer))
)

const engine = Layer.mergeAll(
  StartChildren.toLayer(() =>
    Effect.forEach(
      childIds,
      (executionId) => Child.execute({ label: executionId }, { executionId, discard: true }).pipe(Effect.orDie)
    ).pipe(
      Effect.as("started")
    )
  ),
  Increment.toLayer(({ value }) => Effect.succeed(value + 1)),
  Interpreter.layer(Parent),
  Interpreter.layer(Child),
  Interpreter.layer(Counter)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(
    EngineStore.layer({
      owner: { hostId: "engine-lineage-test" },
      journalSource: "engine-lineage-test",
      isAlive: () => Effect.succeed(false)
    })
  ),
  Layer.provideMerge(
    Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj, jj), OwnerIdentity.layer)
  )
)

/**
 * Time travel over the same rows, so a fork in this suite is a real fork.
 *
 * A `fork-created` marker is the only thing separating a fork from an ordinary
 * child in the projection, and only `@smthrs/time-travel` writes one.
 */
const timeTravel = TimeTravel.layer.pipe(
  Layer.provideMerge(SqlTimeTravelStore.layer),
  Layer.provideMerge(engine)
)

const stack = Layer.merge(controlPlane(), timeTravel).pipe(
  Layer.provideMerge(database)
)

const summaries = (listed: ListResponse): ReadonlyArray<RunSummary> => listed._tag === "runs" ? listed.items : []

/** Runs the engine work, then hands the body the control plane over its rows. */
const observe = <A>(
  body: (control: Control["Service"]) => Effect.Effect<A, unknown, DurableStack>
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      yield* Parent.execute({}, { executionId: parentRunId })
      // Counts 0 -> 1 -> 2 -> 3: rounds 0 and 1 hand off, round 2 finishes.
      yield* Counter.execute({ value: 0, target: 3 }, { executionId: trampolineRunId })
      return yield* body(yield* Control)
    }).pipe(Effect.provide(stack), Effect.scoped, Effect.orDie)
  )

const forkOriginId = "engine-lineage-fork-origin"

/**
 * Runs one flow, forks it at its last committed frame, and hands the body the
 * control plane over both runs.
 */
const observeFork = <A>(
  body: (control: Control["Service"], forkRunId: string) => Effect.Effect<A, unknown, DurableStack>
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      yield* Child.execute({ label: forkOriginId }, { executionId: forkOriginId })
      const journal = yield* Journal.Journal
      yield* journal.flush
      const page = yield* journal.entries({ runId: JournalEvent.RunId.make(forkOriginId), limit: 200 })
      const service = yield* TimeTravel.TimeTravel
      // The frame is read off the run's own last committed record rather than
      // spelled. A journal lineage id is a versioned encoded tuple the ENGINE
      // mints (`FlowEngine.Lineage`), not `<runId>/root`, and this suite spelled
      // the second: time travel now refuses a frame that addresses no record, so
      // the invented coordinate failed `not_found` where it used to copy
      // whatever `seq <= frame.seq` matched and fork from the parent's state NOW.
      const last = page.entries.at(-1)
      const fork = yield* service.fork({
        runId: forkOriginId,
        frame: {
          lineageId: (last?.meta as { readonly lineageId?: string } | undefined)?.lineageId ?? "",
          seq: last?.seq ?? 0
        }
      })
      return yield* body(yield* Control, fork.runId)
    }).pipe(Effect.provide(stack), Effect.scoped, Effect.orDie)
  )

describe("control run lineage over engine-created rows", () => {
  it("lists the two children the parent really started under the parent", async () => {
    const listed = await observe((control) => control.list({ _tag: "runs", filters: { parentRunId } }))

    expect(summaries(listed).map((item) => item.runId)).toEqual([...childIds])
    expect(summaries(listed).map((item) => item.origin)).toEqual(["child", "child"])
    expect(summaries(listed)[0]).toMatchObject({ flowId: Child._tag, parentRunId })
  })

  it("lists the trampoline's three rounds under one lineage with ascending ordinals", async () => {
    const listed = await observe((control) => control.list({ _tag: "runs", filters: { lineageId: trampolineRunId } }))
    const rounds = summaries(listed)

    expect(rounds.map((item) => [item.roundOrdinal, item.origin])).toEqual([
      [0, undefined],
      [1, "continuation"],
      [2, "continuation"]
    ])
    // Every round names the round before it, and the first names nothing.
    expect(rounds[0]?.runId).toBe(trampolineRunId)
    expect(rounds[0]?.parentRunId).toBeUndefined()
    expect(rounds[1]?.parentRunId).toBe(rounds[0]?.runId)
    expect(rounds[2]?.parentRunId).toBe(rounds[1]?.runId)
  })

  it("keeps the trampoline's rounds and the parent's children in separate lineages", async () => {
    const listed = await observe((control) =>
      Effect.all({
        children: control.list({ _tag: "runs", filters: { parentRunId } }),
        rounds: control.list({ _tag: "runs", filters: { lineageId: trampolineRunId } })
      })
    )

    const children = summaries(listed.children).map((item) => item.runId)
    const rounds = summaries(listed.rounds).map((item) => item.runId)
    expect(children.some((id) => rounds.includes(id))).toBe(false)
  })

  it("derives one continuation delta per round and never contradicts it with a child edge", async () => {
    // The engine journals a round's `created` decision and the previous
    // round's `handed-off` decision in ONE transaction, and both name the same
    // pair. Watching every round of the lineage is what exposes a projection
    // that derives an edge from each: the two entries land on two different
    // runs' journals, so a suite that watched one round would see only one of
    // the contradicting halves.
    const observed = await observe((control) =>
      Effect.gen(function*() {
        const listed = yield* control.list({ _tag: "runs", filters: { lineageId: trampolineRunId } })
        const rounds = summaries(listed).map((item) => item.runId)
        const perRound = yield* Effect.forEach(rounds, (runId) =>
          control.watch({ runId, follow: false }).pipe(
            Stream.filter((event) => event.kind === Lineage.lineageEventType),
            Stream.runCollect
          ))
        return { rounds, deltas: perRound.flatMap((events) => [...events] as ReadonlyArray<ControlEvent>) }
      })
    )

    expect(observed.rounds).toHaveLength(3)
    // Two handoffs in a three-round lineage, and nothing else.
    expect(observed.deltas.map((delta) => delta.payload)).toEqual([
      {
        runId: observed.rounds[1],
        parentRunId: observed.rounds[0],
        lineageId: trampolineRunId,
        roundOrdinal: 1,
        origin: "continuation"
      },
      {
        runId: observed.rounds[2],
        parentRunId: observed.rounds[1],
        lineageId: trampolineRunId,
        roundOrdinal: 2,
        origin: "continuation"
      }
    ])
  })

  it("derives a child edge from a real spawn and reports no continuation for it", async () => {
    const observed = await observe((control) =>
      Effect.forEach(childIds, (runId) =>
        control.watch({ runId, follow: false }).pipe(
          Stream.filter((event) => event.kind === Lineage.lineageEventType),
          Stream.runCollect
        )).pipe(Effect.map((perChild) => perChild.flatMap((events) => [...events] as ReadonlyArray<ControlEvent>)))
    )

    expect(observed.map((delta) => delta.payload)).toEqual([
      { runId: childIds[0], parentRunId, origin: "child" },
      { runId: childIds[1], parentRunId, origin: "child" }
    ])
  })

  it("reports a run TimeTravel really forked as a fork, not as an ordinary child", async () => {
    // A fork records `parent_run_id` exactly as a spawn does. Without the
    // marker time travel writes, every fork in a deployment would be listed as
    // an ordinary child, silently.
    const observed = await observeFork((control, forkRunId) =>
      Effect.map(
        control.list({ _tag: "runs", filters: { parentRunId: forkOriginId } }),
        (listed) => ({ forkRunId, items: summaries(listed) })
      )
    )

    expect(observed.items.map((item) => item.runId)).toEqual([observed.forkRunId])
    expect(observed.items[0]).toMatchObject({ parentRunId: forkOriginId, origin: "fork" })
  })
})
