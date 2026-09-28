/**
 * The authoring model of `docs/specs/Concepts/Unified Flow Authoring.md` and
 * `docs/specs/Concepts/Trampoline Loops.md`, end to end, through the barrel
 * package and over the DURABLE engine.
 *
 * Every other suite in this tree proves one package's contract. This one buys
 * the claim the two notes actually make to an author: that the nouns compose —
 * an `Action` that does work, a `Flow` whose pure `body` is planned before it
 * runs, a branch that decides on real values, a lineage that keeps outputting
 * flows — and that the result of composing them survives a process that dies in
 * the middle. So each case here drives the real SQLite-backed stores rather
 * than a double: what a lineage leaves behind, what a re-drive does with it,
 * and what a plan-time mistake costs, are exactly the facts a double cannot
 * establish (`docs/pages/contributing.md`, "Adding a test").
 *
 * The host seams come from the program, not the library. `@smthrs/flows`
 * deliberately re-exports no `platform-*` bundle — a platform is chosen by the
 * program that runs — so this suite supplies the two host services it needs
 * itself: SHA-256 over `node:crypto`, and the in-memory SQLite database every
 * store binds to.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { createHash, webcrypto } from "node:crypto"
import {
  Action,
  DurableDeferred,
  EngineStore as EngineStorePackage,
  Flow,
  FlowRuntime,
  Graph,
  Interpreter,
  Journal as JournalPackage,
  Kernel,
  Plan as PlanPackage,
  PlanStore as PlanStorePackage,
  RunStore as RunStorePackage,
  Sleep,
  StepCache,
  WaitFor
} from "../src/index.ts"

/**
 * The barrel groups each engine package under one namespace, so a module of a
 * package is one level down from it. Naming the modules here is what makes the
 * rest of this file read like the sibling suites, which import those modules
 * from their own packages directly.
 */
const { GraphBuildError, Node, Plan, PlanDiff } = PlanPackage
const { PlanStore } = PlanStorePackage
const { DurableEngineState, EngineStore, Migrations, OwnerIdentity, StepBoundary } = EngineStorePackage
const { AttemptStore, RunStore } = RunStorePackage
const { SqlJournal } = JournalPackage
const { CacheStore } = StepCache
const { Jj } = Kernel

/** SHA-256 over `node:crypto`, the way a Node program supplies the seam. */
const hostCrypto: Layer.Layer<Crypto.Crypto> = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => webcrypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.succeed(
        new Uint8Array(createHash(algorithm.replace("-", "").toLowerCase()).update(data).digest())
      )
  })
)

/** The same digest, synchronously, so a test can name a derived round id. */
const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex")

/** The execution id round `ordinal` of `lineageId` is derived under. */
const roundId = (lineageId: string, ordinal: number): string =>
  sha256(JSON.stringify(["flow-round/v2", lineageId, ordinal]))

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "e2e-snapshot" as never, changeId: "e2e-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/** Every durable store an engine composes, over one fresh in-memory database. */
const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  AttemptStore.layer,
  CacheStore.layer,
  PlanStore.layer,
  DurableEngineState.layer
).pipe(
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)),
  Layer.merge(OwnerIdentity.layer),
  Layer.merge(StepBoundary.layerTest()),
  Layer.merge(Layer.succeed(Jj.Jj, jj))
)

/** Everything {@link services} provides, read off the composition itself. */
type DurableServices = Layer.Success<typeof services>

/** Runs one body against a fresh database and the given durable stores. */
const durableWith = <A, E, ROut>(
  body: Effect.Effect<A, E, NoInfer<ROut> | Crypto.Crypto | Scope.Scope>,
  layer: Layer.Layer<ROut, unknown, Crypto.Crypto>
) => Effect.scoped(body.pipe(Effect.provide(layer), Effect.provide(hostCrypto)))

/** Runs one body against a fresh database and the real durable stores. */
const durable = <A, E>(body: Effect.Effect<A, E, DurableServices | Crypto.Crypto | Scope.Scope>) =>
  durableWith(body, services)

/** The same, with time under the test's control so a durable timer can fire. */
const durableTimed = <A, E>(
  body: Effect.Effect<A, E, DurableServices | Crypto.Crypto | TestClock.TestClock | Scope.Scope>
) =>
  Effect.scoped(
    body.pipe(Effect.provide(services), Effect.provide(hostCrypto), Effect.provide(TestClock.layer()))
  )

/** The layer type an action implementation registers itself through. */
type Implementation = Layer.Layer<never, never, Crypto.Crypto | Action.Implementations | FlowRuntime.FlowRuntime>

/**
 * What a wired incarnation provides an execution: the engine, the
 * implementation registry, and every registered action's requirement.
 */
type Wired = FlowRuntime.FlowRuntime | Action.Implementations | Action.Requirement<string>

const wiringFor = (
  engine: FlowRuntime.FlowRuntime["Service"],
  flows: ReadonlyArray<Flow.Any>,
  implementations: ReadonlyArray<Implementation>
): Layer.Layer<Wired, never, Crypto.Crypto> =>
  [
    ...implementations,
    // A body's registration cannot state the schema services its own
    // topology hides, which is the erasure every sibling suite makes here.
    ...flows.map((flow) => Interpreter.layer(flow as never) as Implementation)
  ].reduce<Implementation>((left, right) => Layer.merge(left, right), Layer.empty).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine)),
    // The same erasure, stated once: the registered implementations answer
    // every `Action.Requirement` the listed flows call.
    (wired) => wired as Layer.Layer<Wired, never, Crypto.Crypto>
  )

/**
 * One engine incarnation over already-provided stores, with the flows it can
 * drive and the implementations their bodies call. A second incarnation over
 * the same storage is what a restarted process looks like.
 */
const incarnation = (options: {
  readonly hostId: string
  readonly flows: ReadonlyArray<Flow.Any>
  readonly implementations: ReadonlyArray<Implementation>
}) =>
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: options.hostId },
      journalSource: `e2e-${options.hostId}`,
      isAlive: () => Effect.succeed(false)
    })
    const wiring = wiringFor(engine, options.flows, options.implementations)
    return { engine, wiring }
  })

/** Polls a run row until it leaves `suspended`, or gives up and reports it. */
const settledRow = (runId: string) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    let row = yield* store.get(runId)
    for (let attempt = 0; attempt < 2_000 && ["suspended", "running", "pending"].includes(row.status); attempt++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 milli")
      row = yield* store.get(runId)
    }
    return row
  })

/** Waits for a round the engine opens asynchronously, and reports it if it never does. */
const openedRound = (runId: string) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    for (let attempt = 0; attempt < 2_000; attempt++) {
      const row = yield* Effect.exit(store.get(runId))
      if (Exit.isSuccess(row)) return row.value
      yield* Effect.yieldNow
    }
    return yield* store.get(runId)
  })

/** The value a settled poll answered with, and `undefined` while it has none. */
const completedValue = (result: Option.Option<Flow.Result<unknown, unknown>>): unknown =>
  Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)
    ? result.value.exit.value
    : undefined

/** The refusal a plan-time build raised, or a failure saying it did not. */
const refused = (build: () => unknown): PlanPackage.GraphBuildError.GraphBuildError => {
  try {
    build()
  } catch (caught) {
    if (caught instanceof GraphBuildError.GraphBuildError) return caught
    throw caught
  }
  throw new Error("the build was expected to be refused, and was not")
}

const Increment = Action.make("e2e/increment", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

/** Records every dispatch, so a re-drive that re-ran a step is visible. */
const incrementing = (calls: Array<number>): Implementation =>
  Increment.toLayer(({ value }) =>
    Effect.sync(() => {
      calls.push(value)
      return value + 1
    })
  )

/** The declaration shape every counter in this suite shares. */
type CounterFlow = Flow.Flow<
  string,
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never,
  // `.to()` drops the callee's requirements, so a lineage that hands off to
  // itself names only what one round calls and the type stays finite.
  Action.Requirement<"e2e/increment">
>

/** The recursion edge a body cannot name inside its own declaration. */
const counters = new Map<string, CounterFlow>()

/**
 * `docs/specs/Concepts/Trampoline Loops.md`'s counter, verbatim: one action,
 * one branch, and a handoff to itself in the arm that has not arrived yet.
 */
const counter = (tag: string, maxRounds?: number): CounterFlow => {
  const flow = Flow.make(tag, {
    payload: { value: Schema.Number, target: Schema.Number },
    success: Schema.Number,
    ...(maxRounds === undefined ? {} : { maxRounds }),
    body: ({ target, value }: { readonly value: number; readonly target: number }) =>
      Increment.call({ value }).pipe(
        Node.branch({
          if: (next) => next >= target,
          then: (next) => Flow.done(next),
          else: (next) => counters.get(tag)!.to({ value: next, target })
        })
      )
  })
  counters.set(tag, flow)
  return flow
}

const CountTo = counter("e2e/count-to")
const Bounded = counter("e2e/bounded", 3)

// A hundred real-database rounds measured about 30 s on a loaded host, the
// whole default budget. The contract is the count, not the latency.
describe("a lineage counts to 100", { timeout: 180_000 }, () => {
  it.effect("chains one execution per round under the lineage, and answers with the target", () =>
    Effect.gen(function*() {
      const calls: Array<number> = []
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const { wiring } = yield* incarnation({
          hostId: "century",
          flows: [CountTo],
          implementations: [incrementing(calls)]
        })

        const value = yield* CountTo.execute({ value: 0, target: 100 }, {
          executionId: "century-lineage"
        }).pipe(Effect.provide(wiring))

        const ids = [
          "century-lineage",
          ...Array.from({ length: 99 }, (_, index) => roundId("century-lineage", index + 1))
        ]
        const rows = yield* Effect.forEach(ids, (runId) => store.get(runId))
        const edges = yield* Effect.forEach(ids, (runId) => state.runParents(runId))
        const beyond = yield* Effect.exit(store.get(roundId("century-lineage", 100)))
        return { beyond, edges, ids, rows, value }
      }))

      expect(observed.value).toBe(100)
      // One dispatch per round, on the value that round was handed: a hundred
      // rounds, not a hundred copies of one round.
      expect(calls).toEqual(Array.from({ length: 100 }, (_, index) => index))
      expect(observed.rows).toHaveLength(100)
      expect(observed.rows.every((row) => row.status === "completed")).toBe(true)
      // The chain is `parent_run_id` plus the lineage pair. Round 0 carries the
      // pair too; only its continue-as-new parent is absent.
      expect(observed.rows.map((row) => row.roundOrdinal)).toEqual(Array.from({ length: 100 }, (_, index) => index))
      expect(observed.rows.every((row) => row.lineageId === "century-lineage")).toBe(true)
      expect(observed.rows[0]?.parentRunId).toBeNull()
      expect(observed.rows.slice(1).map((row) => row.parentRunId)).toEqual(observed.ids.slice(0, 99))
      // A round is the same run continuing, not a spawned child, so the subflow
      // edge table stays empty for every one of them.
      expect(observed.edges.every((edge) => edge.length === 0)).toBe(true)
      // The lineage stopped at the round that answered: no hundred-and-first.
      expect(Exit.isFailure(observed.beyond)).toBe(true)
    }))

  it.effect("takes the exit arm on the first round when the target is already met", () =>
    Effect.gen(function*() {
      const calls: Array<number> = []
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const { wiring } = yield* incarnation({
          hostId: "exit-first",
          flows: [CountTo],
          implementations: [incrementing(calls)]
        })
        const value = yield* CountTo.execute({ value: 100, target: 100 }, {
          executionId: "exit-first-lineage"
        }).pipe(Effect.provide(wiring))
        return {
          root: yield* store.get("exit-first-lineage"),
          successor: yield* Effect.exit(store.get(roundId("exit-first-lineage", 1))),
          value
        }
      }))

      // The predicate ran on the REAL value the action produced, and the arm it
      // did not take opened no round at all.
      expect(observed.value).toBe(101)
      expect(calls).toEqual([100])
      expect(observed.root.status).toBe("completed")
      expect(observed.root.roundOrdinal).toBe(0)
      expect(Exit.isFailure(observed.successor)).toBe(true)
    }))

  it("shows both arms as topology before any of it runs", () => {
    const graph = Graph.build(CountTo, { value: 0, target: 2 })
    const ids = Graph.nodes(graph).map((node) => node.id)

    // The exit condition and the handoff site are in the plan of round one,
    // side by side, before the first action has run.
    expect(graph.diagnostics).toEqual([])
    expect(ids).toContain("root.flow.then")
    expect(ids).toContain("root.flow.else")
    const handoff = Graph.nodes(graph).find((node) => node.id === "root.flow.else")
    expect(handoff?.ast).toMatchObject({ _tag: "FlowCall", flow: "e2e/count-to", mode: "handoff" })
  })
})

const Stage = Action.make("e2e/stage", {
  payload: { label: Schema.String, value: Schema.Number },
  success: Schema.Number
})

/** Records `label:value`, so a round that ran twice is visible as a duplicate. */
const staging = (calls: Array<string>): Implementation =>
  Stage.toLayer(({ label, value }) =>
    Effect.sync(() => {
      calls.push(`${label}:${value}`)
      return value + 1
    })
  )

const StageThree = Flow.make("e2e/stage-three", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Stage.call({ label: "three", value })
})

const StageTwo = Flow.make("e2e/stage-two", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) =>
    Stage.call({ label: "two", value }).pipe(
      Node.bindPlanned((next) => StageThree.to({ value: next }))
    )
})

const StageOne = Flow.make("e2e/stage-one", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) =>
    Stage.call({ label: "one", value }).pipe(
      Node.bindPlanned((next) => StageTwo.to({ value: next }))
    )
})

describe("a lineage survives the process that was driving it", () => {
  it.effect("re-drives the round the dead worker opened, and re-runs nothing it settled", () =>
    Effect.gen(function*() {
      const first: Array<string> = []
      const second: Array<string> = []
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        // A worker that knows the first two legs only. It settles rounds 0 and 1,
        // opens round 2 durably, and then has nothing that can drive it — the
        // crash window the derived round id exists for.
        const partial = yield* incarnation({
          hostId: "crash-partial",
          flows: [StageOne, StageTwo],
          implementations: [staging(first)]
        })
        const stranded = yield* Effect.gen(function*() {
          yield* StageOne.execute({ value: 0 }, {
            executionId: "crash-lineage",
            discard: true
          })
          // `discard: true` answers when round 0 is ADMITTED, and the engine
          // follows the handoffs afterwards in the registration's scope
          // (`engine/docs/concepts/trampoline-rounds.md`). So the registration
          // has to stay open until this worker has run out of legs, and the
          // round it could not drive is what says it did: wait for the row,
          // rather than assume the lineage stopped the instant admission
          // answered.
          return yield* openedRound(roundId("crash-lineage", 2))
        }).pipe(Effect.provide(partial.wiring))

        const settled = yield* Effect.forEach(
          ["crash-lineage", roundId("crash-lineage", 1)],
          (runId) => store.get(runId)
        )

        // The replacement knows every leg and picks the lineage up from its root.
        const whole = yield* incarnation({
          hostId: "crash-whole",
          flows: [StageOne, StageTwo, StageThree],
          implementations: [staging(second)]
        })
        const value = yield* StageOne.execute({ value: 0 }, {
          executionId: "crash-lineage"
        }).pipe(Effect.provide(whole.wiring))

        const finished = yield* Effect.forEach(
          ["crash-lineage", roundId("crash-lineage", 1), roundId("crash-lineage", 2)],
          (runId) => store.get(runId)
        )
        return { finished, settled, stranded, value }
      }))

      expect(observed.settled.map((row) => row.status)).toEqual(["completed", "completed"])
      expect(observed.stranded.status).toBe("pending")
      expect(observed.stranded.roundOrdinal).toBe(2)
      // At most once: the first worker's two rounds ran on IT, and the second
      // worker ran only the round nobody had run.
      expect(first).toEqual(["one:0", "two:1"])
      expect(second).toEqual(["three:2"])
      expect(observed.value).toBe(3)
      expect(observed.finished.map((row) => row.status)).toEqual(["completed", "completed", "completed"])
      // The re-drive landed on the round that already existed, so the chain is
      // the one the dead worker started.
      expect(observed.finished.map((row) => row.parentRunId)).toEqual([
        null,
        "crash-lineage",
        roundId("crash-lineage", 1)
      ])
      expect(observed.finished.map((row) => row.roundOrdinal)).toEqual([0, 1, 2])
    }))
})

describe("a lineage may not open more rounds than it declared", () => {
  it.effect("ends the lineage with the typed refusal when the round budget is spent", () =>
    Effect.gen(function*() {
      const calls: Array<number> = []
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const { wiring } = yield* incarnation({
          hostId: "bounded",
          flows: [Bounded],
          implementations: [incrementing(calls)]
        })
        const exit = yield* Bounded.execute({ value: 0, target: 99 }, {
          executionId: "bounded-lineage"
        }).pipe(Effect.exit, Effect.provide(wiring))
        return {
          beyond: yield* Effect.exit(store.get(roundId("bounded-lineage", 3))),
          exit,
          last: yield* store.get(roundId("bounded-lineage", 2))
        }
      }))

      // Three rounds are all a lineage bounded at three may open, and the request
      // for a fourth is what fails — terminally, on the round that asked for it.
      expect(calls).toEqual([0, 1, 2])
      expect(Exit.isFailure(observed.exit)).toBe(true)
      expect(Exit.isFailure(observed.exit) && observed.exit.cause.toString()).toContain("MaxRoundsExceeded")
      expect(observed.last.status).toBe("failed")
      expect(Exit.isFailure(observed.beyond)).toBe(true)
    }))
})

describe("a body is refused for computing on a value that does not exist yet", () => {
  it("refuses arithmetic on a step result, naming the node and the fix", () => {
    const Arithmetic = Flow.make("e2e/trap-arithmetic", {
      payload: { value: Schema.Number },
      success: Schema.Number,
      body: ({ value }) =>
        Increment.call({ value }).pipe(
          // The cast is the point: the brand makes this a compile error, and
          // the proxy is what stops it when a cast has erased the brand.
          Node.bindPlanned((next) => Increment.call({ value: (next as unknown as number) + 1 }))
        )
    })

    const error = refused(() => Graph.build(Arithmetic, { value: 0 }))

    expect(error.code).toBe("planned_value_computed")
    expect(error.node).toBe("root.flow.andThen")
    expect(error.path).toEqual([])
    expect(error.message).toContain("Symbol.toPrimitive")
    expect(error.message).toContain("Use Node.map to compute, Node.branch to decide")
  })

  it("refuses serializing a step result inside a branch arm", () => {
    const Serialized = Flow.make("e2e/trap-json", {
      payload: { value: Schema.Number },
      success: Schema.Number,
      body: ({ value }) =>
        Increment.call({ value }).pipe(
          Node.branch({
            if: (next) => next > 0,
            then: (next) => Node.succeed(JSON.parse(JSON.stringify(next)) as number),
            else: (next) => Flow.done(next)
          })
        )
    })

    const error = refused(() => Graph.build(Serialized, { value: 0 }))

    expect(error.code).toBe("planned_value_computed")
    expect(error.message).toContain("toJSON")
  })

  it("refuses reaching for a step result's own conversions, or calling it", () => {
    const method = refused(() =>
      Graph.build(
        Flow.make("e2e/trap-valueof", {
          payload: { value: Schema.Number },
          success: Schema.Number,
          body: ({ value }) =>
            Increment.call({ value }).pipe(
              Node.bindPlanned((next) => Node.succeed((next as unknown as { valueOf: () => number }).valueOf()))
            )
        }),
        { value: 0 }
      )
    )
    const stringified = refused(() =>
      Graph.build(
        Flow.make("e2e/trap-tostring", {
          payload: { value: Schema.Number },
          success: Schema.Number,
          body: ({ value }) =>
            Increment.call({ value }).pipe(
              Node.bindPlanned((next) =>
                Node.succeed(Number((next as unknown as { toString: () => string }).toString()))
              )
            )
        }),
        { value: 0 }
      )
    )
    const applied = refused(() =>
      Graph.build(
        Flow.make("e2e/trap-apply", {
          payload: { value: Schema.Number },
          success: Schema.Number,
          body: ({ value }) =>
            Increment.call({ value }).pipe(
              Node.bindPlanned((next) => Node.succeed((next as unknown as () => number)()))
            )
        }),
        { value: 0 }
      )
    )

    // The four named conversions plus application are the whole refusal set of
    // `Planned`; a body that reaches any of them is computing, not referring.
    expect(method.message).toContain("valueOf")
    expect(stringified.message).toContain("toString")
    expect(stringified.node).toBe("root.flow.andThen")
    expect(applied.message).toContain("function application")
    expect(applied.node).toBe("root.flow.andThen")
  })

  it("names the field path the body reached through before it computed", () => {
    const Shaped = Action.make("e2e/shaped", {
      payload: { value: Schema.Number },
      success: Schema.Struct({ count: Schema.Number })
    })
    const error = refused(() =>
      Graph.build(
        Flow.make("e2e/trap-field", {
          payload: { value: Schema.Number },
          success: Schema.Number,
          body: ({ value }) =>
            Shaped.call({ value }).pipe(
              Node.bindPlanned((shaped) => Node.succeed((shaped.count as unknown as number) + 1))
            )
        }),
        { value: 0 }
      )
    )

    // Reaching the field is legal and records a reference path; computing on
    // what it reached is not, and the refusal reports the whole reference
    // rather than only the node that produced it.
    expect(error.code).toBe("planned_value_computed")
    expect(error.node).toBe("root.flow.andThen")
    expect(error.path).toEqual(["count"])
    expect(error.message).toContain("root.flow.andThen.count")
  })

  it.effect("allows the same value to be passed, and reads the field it named", () =>
    Effect.gen(function*() {
      const Counted = Action.make("e2e/counted", {
        payload: { value: Schema.Number },
        success: Schema.Struct({ count: Schema.Number })
      })
      const seen: Array<number> = []
      const Passing = Flow.make("e2e/passing", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        // Field access records a reference path; the value itself is never
        // touched at plan time. This is the half of the rule that must WORK.
        body: ({ value }) =>
          Counted.call({ value }).pipe(
            Node.bindPlanned((counted) => Increment.call({ value: counted.count }))
          )
      })

      const value = yield* durable(Effect.gen(function*() {
        const { wiring } = yield* incarnation({
          hostId: "passing",
          flows: [Passing],
          implementations: [
            Counted.toLayer(({ value }) => Effect.succeed({ count: value + 10 })),
            Increment.toLayer(({ value }) =>
              Effect.sync(() => {
                seen.push(value)
                return value + 1
              })
            )
          ]
        })
        return yield* Passing.execute({ value: 1 }, { executionId: "passing-run" }).pipe(
          Effect.provide(wiring)
        )
      }))

      expect(seen).toEqual([11])
      expect(value).toBe(12)
    }))
})

/** A one-field counter, which is all a self-call needs to be refused. */
type InlineFlow = Flow.Flow<
  string,
  Schema.Struct<{ value: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never
>

/** The recursion edge a self-calling body cannot name in its own declaration. */
const recursive = new Map<string, InlineFlow>()

const Inline: InlineFlow = Flow.make("e2e/recursive-inline", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }: { readonly value: number }) => recursive.get("e2e/recursive-inline")!.call({ value })
})
recursive.set("e2e/recursive-inline", Inline)

describe("a flow that calls itself is sent to a boundary", () => {
  it("refuses an inline self-call at build time, and names both ways out", () => {
    const error = refused(() => Graph.build(Inline, { value: 0 }))

    expect(error.code).toBe("recursion_requires_boundary")
    expect(error.node).toBe("root.flow")
    expect(error.message).toContain("cannot call itself inline")
    expect(error.message).toContain("e2e/recursive-inline.to(payload)")
    expect(error.message).toContain(".child(payload)")
  })

  it("accepts the trampoline handoff the refusal points at", () => {
    // The same recursion, written as the note says to write it, plans without
    // a murmur: the edge is a leaf node, not an expansion.
    const graph = Graph.build(CountTo, { value: 0, target: 2 })
    const handoff = Graph.nodes(graph).find((node) => node.id === "root.flow.else")

    expect(graph.diagnostics).toEqual([])
    expect(handoff?.dependencies).toEqual(["root.flow.branch"])
  })
})

const Child = Flow.make("e2e/child", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Increment.call({ value })
})

const Parent = Flow.make("e2e/parent", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Child.child({ value }).pipe(Node.map((settled) => settled * 10))
})

const Gate = Flow.make("e2e/gate", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: () => Flow.park({ reason: "approval", token: "child-gate" })
})

const GateParent = Flow.make("e2e/gate-parent", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Gate.child({ value })
})

describe("a child boundary is a real execution", () => {
  it.effect("runs the child under its own derived id, with the parent edge recorded", () =>
    Effect.gen(function*() {
      const calls: Array<number> = []
      const replayed: Array<number> = []
      const observed = yield* durable(Effect.gen(function*() {
        const childId = yield* Interpreter.childExecutionId("boundary-parent", "root.flow.map", Child._tag, {
          value: 4
        })
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const first = yield* incarnation({
          hostId: "boundary",
          flows: [Child, Parent],
          implementations: [incrementing(calls)]
        })
        const value = yield* Parent.execute({ value: 4 }, { executionId: "boundary-parent" }).pipe(
          Effect.provide(first.wiring)
        )

        // A second incarnation over the same storage asks for the same parent:
        // both executions are settled, so this is a read.
        const second = yield* incarnation({
          hostId: "boundary-replay",
          flows: [Child, Parent],
          implementations: [incrementing(replayed)]
        })
        const again = yield* Parent.execute({ value: 4 }, { executionId: "boundary-parent" }).pipe(
          Effect.provide(second.wiring)
        )

        return {
          again,
          child: yield* store.get(childId),
          edges: yield* state.runParents(childId),
          parent: yield* store.get("boundary-parent"),
          value
        }
      }))

      expect(observed.value).toBe(50)
      expect(calls).toEqual([4])
      // One node in the parent's plan, one execution of its own underneath, and
      // the ancestry edge a cycle walk reads.
      expect(observed.child.status).toBe("completed")
      expect(observed.parent.status).toBe("completed")
      expect(observed.edges.map((edge) => edge.parentId)).toEqual(["boundary-parent"])
      // Replay is flat: nothing under the boundary ran a second time.
      expect(observed.again).toBe(50)
      expect(replayed).toEqual([])
    }))

  it.effect("suspends the parent behind a child that parked", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const childId = yield* Interpreter.childExecutionId("gate-parent", "root.flow", Gate._tag, { value: 1 })
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const { wiring } = yield* incarnation({
          hostId: "gate",
          flows: [Gate, GateParent],
          implementations: []
        })
        yield* GateParent.execute({ value: 1 }, {
          executionId: "gate-parent",
          discard: true
        }).pipe(Effect.provide(wiring))
        return {
          child: yield* store.get(childId),
          parent: yield* store.get("gate-parent"),
          waiting: yield* state.waiting(childId)
        }
      }))

      // The nesting is genuine, so the child's suspension is the parent's.
      expect(observed.child.status).toBe("suspended")
      expect(observed.parent.status).toBe("suspended")
      expect(Option.isSome(observed.waiting)).toBe(true)
      expect(Option.isSome(observed.waiting) && observed.waiting.value.reason).toBe("approval")
      expect(Option.isSome(observed.waiting) && observed.waiting.value.token).toBe("child-gate")
    }))
})

const Mark = Action.make("e2e/mark", {
  payload: { label: Schema.String },
  success: Schema.String
})

/** The steps around a wait, so a resumed round that re-ran one is visible. */
const marking = (marks: Array<string>): Implementation =>
  Mark.toLayer(({ label }) =>
    Effect.sync(() => {
      marks.push(label)
      return label
    })
  )

const Napping = Flow.make("e2e/napping", {
  payload: { millis: Schema.Number },
  success: Schema.String,
  error: Sleep.SleepRequestInvalid,
  body: ({ millis }) =>
    Mark.call({ label: "before" }).pipe(
      Node.bindPlanned(() => Sleep.action.call({ millis })),
      Node.bindPlanned(() => Mark.call({ label: "after" }))
    )
})

const Gated = Flow.make("e2e/gated", {
  payload: { name: Schema.String },
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: ({ name }) =>
    Mark.call({ label: "before" }).pipe(
      Node.bindPlanned(() => WaitFor.action.call({ name }))
    )
})

// The timer round trip measured about 22 s on a loaded host.
describe("the system wait actions park and wake durably", { timeout: 120_000 }, () => {
  it.effect("parks a sleep under timer with its deadline, and the clock's fire resumes it", () =>
    Effect.gen(function*() {
      const marks: Array<string> = []
      const observed = yield* durableTimed(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const { wiring } = yield* incarnation({
          hostId: "napping",
          flows: [Napping],
          implementations: [marking(marks), Sleep.layer]
        })
        // The whole round-trip runs under one wiring: a clock fires on the
        // engine's own fiber, and a worker that unregistered the flow first
        // would leave the run parked for someone who has not.
        return yield* Effect.gen(function*() {
          yield* Napping.execute({ millis: 600_000 }, {
            executionId: "napping-run",
            discard: true
          })

          const parked = yield* store.get("napping-run")
          const waiting = yield* state.waiting("napping-run")
          const clocks = yield* state.dueClocks(Number.MAX_SAFE_INTEGER)

          // The wait is the durable clock's, so the way it ends is the clock
          // firing — not a second execution mechanism.
          yield* TestClock.adjust("10 minutes")
          const woken = yield* settledRow("napping-run")
          return { clocks, marks, parked, result: yield* Napping.poll("napping-run"), waiting, woken }
        }).pipe(Effect.provide(wiring))
      }))

      expect(observed.parked.status).toBe("suspended")
      expect(Option.isSome(observed.waiting) && observed.waiting.value.reason).toBe("timer")
      expect(observed.clocks).toHaveLength(1)
      expect(Option.isSome(observed.waiting) && observed.waiting.value.wakeAt).toBe(observed.clocks[0]?.dueAtMs)
      expect(observed.woken.status).toBe("completed")
      expect(completedValue(observed.result)).toBe("after")
      // The step before the wait was journaled on the first pass: the resumed
      // round replayed its recorded outcome instead of running it again.
      expect(marks).toEqual(["before", "after"])
    }))

  it.effect("parks a wait under event with its wake token, and its completion resumes it", () =>
    Effect.gen(function*() {
      const marks: Array<string> = []
      const token = DurableDeferred.tokenFromExecutionId(WaitFor.deferred("approval"), {
        flow: Gated,
        executionId: "gated-run"
      })
      const observed = yield* durableTimed(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const { wiring } = yield* incarnation({
          hostId: "gated",
          flows: [Gated],
          implementations: [marking(marks), WaitFor.layer]
        })
        return yield* Effect.gen(function*() {
          yield* Gated.execute({ name: "approval" }, {
            executionId: "gated-run",
            discard: true
          })

          const parked = yield* store.get("gated-run")
          const waiting = yield* state.waiting("gated-run")

          // Resolution is the ordinary durable deferred completion path: a
          // token, and `DurableDeferred.succeed`.
          yield* DurableDeferred.succeed(WaitFor.deferred("approval"), {
            token,
            value: { approved: true }
          })

          const woken = yield* settledRow("gated-run")
          return { marks, parked, result: yield* Gated.poll("gated-run"), waiting, woken }
        }).pipe(Effect.provide(wiring))
      }))

      expect(observed.parked.status).toBe("suspended")
      expect(Option.isSome(observed.waiting) && observed.waiting.value.reason).toBe("event")
      expect(Option.isSome(observed.waiting) && observed.waiting.value.token).toBe(token)
      expect(observed.woken.status).toBe("completed")
      // The node settles with the value that resolved the wait, and the step
      // before it replayed its recorded outcome rather than running again.
      expect(completedValue(observed.result)).toEqual({ approved: true })
      expect(marks).toEqual(["before"])
    }))
})

const Fallible = Action.make("e2e/fallible", {
  payload: { error: Schema.String },
  success: Schema.Number,
  error: Schema.String
})

/** Records each dispatch and fails with the error the payload names. */
const failing = (attempts: Array<string>): Implementation =>
  Fallible.toLayer(({ error }) =>
    Effect.suspend(() => {
      attempts.push(error)
      return Effect.fail(error)
    })
  )

const Guarded = Flow.make("e2e/guarded", {
  payload: { error: Schema.String },
  success: Schema.Number,
  error: Schema.String,
  body: ({ error }) =>
    Fallible.call({ error }).pipe(
      Node.catch({
        error: Schema.Literal("recoverable"),
        onFailure: () => Node.succeed(-1)
      })
    )
})

describe("a failure arm is topology like any other", () => {
  it.effect("takes the arm its schema matches and settles the run", () =>
    Effect.gen(function*() {
      const attempts: Array<string> = []
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const { wiring } = yield* incarnation({
          hostId: "recovered",
          flows: [Guarded],
          implementations: [failing(attempts)]
        })
        const value = yield* Guarded.execute({ error: "recoverable" }, {
          executionId: "recovered-run"
        }).pipe(Effect.provide(wiring))
        return { row: yield* store.get("recovered-run"), value }
      }))

      expect(observed.value).toBe(-1)
      expect(attempts).toEqual(["recoverable"])
      expect(observed.row.status).toBe("completed")
    }))

  it.effect("propagates a failure the arm does not match", () =>
    Effect.gen(function*() {
      const attempts: Array<string> = []
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const { wiring } = yield* incarnation({
          hostId: "propagated",
          flows: [Guarded],
          implementations: [failing(attempts)]
        })
        const exit = yield* Guarded.execute({ error: "fatal" }, {
          executionId: "propagated-run"
        }).pipe(Effect.exit, Effect.provide(wiring))
        return { exit, row: yield* store.get("propagated-run") }
      }))

      expect(Exit.isFailure(observed.exit)).toBe(true)
      expect(Exit.isFailure(observed.exit) && observed.exit.cause.toString()).toContain("fatal")
      expect(attempts).toEqual(["fatal"])
      expect(observed.row.status).toBe("failed")
    }))
})

describe("a plan is a value that grows round over round", () => {
  it.effect("compiles a round, persists it, and appends the next round's nodes to it", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* PlanStore.PlanStore
        // Round one, planned from the real payload the lineage starts with.
        const first = Graph.build(CountTo, { value: 0, target: 2 })
        const round0 = yield* Plan.compile({
          planId: "e2e-lineage-plan",
          flow: CountTo._tag,
          nodes: Graph.drafts(first)
        })
        const recorded = yield* store.record(round0, 1_000)

        // Round two is the same body planned with what round one handed on. It
        // grows the SAME plan: append-only, pre-keyed against what is there.
        const second = Graph.build(CountTo, { value: 1, target: 2 }, { root: "round-1" })
        const round1 = yield* Plan.append(round0, Graph.drafts(second))
        yield* store.append(round1)

        return {
          appended: Plan.generationNodes(round1).map((node) => node.id),
          diff: PlanDiff.diff(round0, round1),
          read: yield* store.get("e2e-lineage-plan"),
          recorded,
          round0,
          round1
        }
      }))

      expect(observed.recorded._tag).toBe("Recorded")
      // Growth, not invalidation: round one's nodes keep their keys byte for
      // byte, and the diff is exactly what round two added.
      expect(observed.diff.removed).toEqual([])
      expect(observed.diff.rekeyed).toEqual([])
      expect(observed.diff.unchanged).toEqual(observed.round0.nodes.map((node) => node.id))
      expect(observed.diff.added).toEqual(observed.appended)
      expect(observed.diff.added.every((id) => id.startsWith("round-1"))).toBe(true)
      expect(observed.diff.added.length).toBeGreaterThan(0)
      // The digest an approval binds to advanced; the base it was approved at
      // did not.
      expect(observed.round1.generation).toBe(1)
      expect(observed.round1.baseDigest).toBe(observed.round0.baseDigest)
      expect(observed.round1.digest).not.toBe(observed.round0.digest)
      // And the whole thing round-trips through storage unchanged.
      expect(Option.isSome(observed.read)).toBe(true)
      expect(Option.isSome(observed.read) && observed.read.value).toEqual(observed.round1)
    }))

  it.effect("re-keys the nodes a changed payload moved, and says which input moved them", () =>
    Effect.gen(function*() {
      const observed = yield* durable(Effect.gen(function*() {
        const first = Graph.build(CountTo, { value: 0, target: 2 })
        const second = Graph.build(CountTo, { value: 1, target: 2 })
        const before = yield* Plan.compile({
          planId: "e2e-rekey-plan",
          flow: CountTo._tag,
          nodes: Graph.drafts(first)
        })
        const after = yield* Plan.compile({
          planId: "e2e-rekey-plan",
          flow: CountTo._tag,
          nodes: Graph.drafts(second)
        })
        return PlanDiff.diff(before, after)
      }))

      expect(observed.added).toEqual([])
      expect(observed.removed).toEqual([])
      // The round is the same shape with a different real payload, so every node
      // that reads the payload re-keys and the report names the input.
      const entry = observed.rekeyed.find((node) => node.id === "root.flow.branch")
      expect(entry?.changed).toContain("input[0]")
      expect(observed.rekeyed.map((node) => node.id)).toContain("root")
    }))
})

describe("journal admission is visible at the authoring boundary", () => {
  it.effect("surfaces a typed queue overflow and leaves the execution failed", () =>
    Effect.gen(function*() {
      const writeGate = Deferred.makeUnsafe<void>()
      const overflowSeen = Deferred.makeUnsafe<JournalPackage.Journal.JournalError>()
      let blockWrites = false
      const gatedWriter = Layer.effect(
        DurableWriter.DurableWriter,
        Effect.gen(function*() {
          const writer = yield* DurableWriter.DurableWriter
          const write: DurableWriter.Service["write"] = (effect) =>
            Effect.suspend(() =>
              blockWrites
                ? Deferred.await(writeGate).pipe(Effect.andThen(writer.write(effect)))
                : writer.write(effect)
            )
          return DurableWriter.DurableWriter.of({ write })
        })
      )
      const gatedDatabase = Layer.provideMerge(gatedWriter, TestDatabase.layer)
      const overflowServices = Layer.mergeAll(
        SqlJournal.layer({ capacity: 1, overflow: "reject", batchSize: 1 }),
        RunStore.layer,
        AttemptStore.layer,
        CacheStore.layer,
        PlanStore.layer,
        DurableEngineState.layer
      ).pipe(
        Layer.provideMerge(Layer.provideMerge(Migrations.layer, gatedDatabase)),
        Layer.merge(OwnerIdentity.layer),
        Layer.merge(StepBoundary.layerTest()),
        Layer.merge(Layer.succeed(Jj.Jj, jj))
      )

      const Saturate = Action.make("e2e/saturate-journal", {
        payload: {},
        success: Schema.String,
        error: JournalPackage.Journal.JournalError
      })
      const SaturatingFlow = Flow.make("e2e/saturating-flow", {
        payload: {},
        success: Schema.String,
        error: JournalPackage.Journal.JournalError,
        body: () => Saturate.call({})
      })
      const implementation = Saturate.toLayer(() =>
        Effect.gen(function*() {
          const journal = yield* JournalPackage.Journal.Journal
          blockWrites = true
          const event = (index: number) =>
            new JournalPackage.JournalEvent.Input({
              runId: "overflow-run" as never,
              sourceId: "overflow-action" as never,
              sourceSeq: index as never,
              eventType: "author.telemetry",
              payload: { index }
            }, { disableChecks: true })
          yield* journal.emitLossy(event(0))
          // Let the writer take the first entry and block on persistence; the
          // next admission then occupies the queue's sole remaining slot.
          yield* Effect.yieldNow
          yield* journal.emitLossy(event(1))
          const overflow = yield* Effect.flip(journal.emitLossy(event(2))).pipe(Effect.orDie)
          yield* Deferred.succeed(overflowSeen, overflow)
          return yield* Effect.fail(overflow)
        })
      ) as Implementation

      const observed = yield* durableWith(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const { wiring } = yield* incarnation({
            hostId: "journal-overflow",
            flows: [SaturatingFlow],
            implementations: [implementation]
          })
          const fiber = yield* Effect.forkChild(
            SaturatingFlow.execute({}, { executionId: "overflow-run" }).pipe(
              Effect.provide(wiring),
              Effect.exit
            ),
            { startImmediately: true }
          )
          const overflow = yield* Deferred.await(overflowSeen)
          const during = yield* store.get("overflow-run")
          yield* Deferred.succeed(writeGate, undefined)
          const exit = yield* Fiber.join(fiber)
          return { during, exit, overflow, settled: yield* store.get("overflow-run") }
        }).pipe(Effect.ensuring(Deferred.succeed(writeGate, undefined))),
        overflowServices
      )

      expect(observed.overflow._tag).toBe("@smthrs/journal/JournalError")
      expect(observed.overflow.code).toBe("queue_overflow")
      expect(observed.overflow.message).toContain("journal admission queue is full")
      expect(observed.during.status).toBe("running")
      expect(Exit.isFailure(observed.exit)).toBe(true)
      if (Exit.isFailure(observed.exit)) {
        const reason = observed.exit.cause.reasons.find((candidate) => candidate._tag === "Fail")
        expect(reason?._tag === "Fail" ? reason.error : undefined).toMatchObject({
          _tag: "@smthrs/journal/JournalError",
          code: "queue_overflow"
        })
      }
      expect(observed.settled.status).toBe("failed")
      expect(observed.settled.owner).toBeNull()
    }))
})

describe("wide authored graphs stay linear enough for the suite budget", () => {
  it.effect("builds, compiles, and diffs 300 parallel steps as 302 plan nodes", () =>
    Effect.gen(function*() {
      const WideStep = Action.make("e2e/wide-step", {
        payload: { index: Schema.Number },
        success: Schema.Number
      })
      const members = Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [
          `step-${index}`,
          WideStep.call({ index })
        ])
      )
      const Wide = Flow.make("e2e/wide-flow", {
        payload: {},
        success: Schema.Any,
        body: () => Node.all(members)
      })

      const graph = Graph.build(Wide, {})
      const before = yield* (
        Plan.compile({
          planId: "e2e-wide-plan",
          flow: Wide._tag,
          nodes: Graph.drafts(graph)
        }).pipe(Effect.provide(hostCrypto))
      )
      const rebuilt = Graph.build(Wide, {})
      const after = yield* (
        Plan.compile({
          planId: "e2e-wide-plan",
          flow: Wide._tag,
          nodes: Graph.drafts(rebuilt)
        }).pipe(Effect.provide(hostCrypto))
      )
      const diff = PlanDiff.diff(before, after)

      expect(Graph.nodes(graph)).toHaveLength(302)
      expect(before.nodes).toHaveLength(302)
      expect(after.nodes).toHaveLength(302)
      expect(diff).toEqual({
        added: [],
        removed: [],
        rekeyed: [],
        unchanged: before.nodes.map((node) => node.id)
      })
    }), 10_000)
})

describe("live ownership races stay fenced", () => {
  it.effect(
    "lets one incarnation drive each round while the loser observes unsettled owned state",
    () =>
      Effect.gen(function*() {
        const calls: Array<string> = []
        const probes: Array<RunStorePackage.Ownership.OwnerId> = []
        const started = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
        const release = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]

        const observed = yield* durable(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const noHeartbeat = RunStore.makeNoop({
            ...store,
            // Keep the owner fiber alive without refreshing the persisted
            // timestamp, so the competing incarnation can observe a stale
            // lease while the first action is still blocked.
            heartbeat: () => Effect.succeed({ _tag: "Updated" })
          })
          const isAlive = (owner: RunStorePackage.Ownership.OwnerId) =>
            Effect.sync(() => {
              probes.push(owner)
              return true
            })
          const first = yield* EngineStore.make({
            owner: { hostId: "race-first" },
            journalSource: "e2e-race-first",
            isAlive
          }).pipe(Effect.provideService(RunStore.RunStore, noHeartbeat))
          const second = yield* EngineStore.make({
            owner: { hostId: "race-second" },
            journalSource: "e2e-race-second",
            isAlive
          })
          const firstWiring = wiringFor(first, [CountTo], [
            Increment.toLayer(({ value }) =>
              Effect.gen(function*() {
                calls.push(`first:${value}`)
                yield* Deferred.succeed(started[value]!, undefined)
                yield* Deferred.await(release[value]!)
                return value + 1
              })
            ) as Implementation
          ])
          const secondWiring = wiringFor(second, [CountTo], [
            Increment.toLayer(({ value }) =>
              Effect.sync(() => {
                calls.push(`second:${value}`)
                return value + 1
              })
            ) as Implementation
          ])

          const rootFiber = yield* Effect.forkChild(
            CountTo.execute({ value: 0, target: 2 }, {
              executionId: "ownership-race",
              discard: true
            }).pipe(Effect.provide(firstWiring)),
            { startImmediately: true }
          )
          yield* Deferred.await(started[0]!)
          yield* TestClock.adjust("31 seconds")
          yield* CountTo.execute({ value: 0, target: 2 }, {
            executionId: "ownership-race",
            discard: true
          }).pipe(Effect.provide(secondWiring))
          const rootWhileContended = yield* store.get("ownership-race")
          const rootPoll = yield* CountTo.poll("ownership-race").pipe(Effect.provide(secondWiring))

          yield* Deferred.succeed(release[0]!, undefined)
          yield* Fiber.join(rootFiber)
          yield* Deferred.await(started[1]!)
          const successorId = roundId("ownership-race", 1)
          yield* TestClock.adjust("31 seconds")
          yield* second.resume(CountTo, successorId)
          const successorWhileContended = yield* store.get(successorId)
          const successorPoll = yield* CountTo.poll(successorId).pipe(Effect.provide(secondWiring))

          yield* Deferred.succeed(release[1]!, undefined)
          let successor = yield* store.get(successorId)
          for (let attempt = 0; attempt < 50 && successor.status !== "completed"; attempt++) {
            yield* Effect.yieldNow
            successor = yield* store.get(successorId)
          }
          return {
            root: yield* store.get("ownership-race"),
            rootPoll,
            rootWhileContended,
            successor,
            successorPoll,
            successorWhileContended
          }
        }))

        expect(calls).toEqual(["first:0", "first:1"])
        expect(probes.some((owner) => owner.hostId === "race-first")).toBe(true)
        expect(observed.rootWhileContended.status).toBe("running")
        expect(observed.rootWhileContended.owner?.hostId).toBe("race-first")
        expect(Option.isNone(observed.rootPoll)).toBe(true)
        expect(observed.successorWhileContended.status).toBe("running")
        expect(observed.successorWhileContended.owner?.hostId).toBe("race-first")
        expect(Option.isNone(observed.successorPoll)).toBe(true)
        expect(observed.root.status).toBe("completed")
        expect(observed.successor.status).toBe("completed")
        expect(observed.successor.owner).toBeNull()
      }),
    20_000
  )
})
