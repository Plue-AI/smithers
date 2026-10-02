/**
 * What a burndown round journals while it runs, in the real durable engine.
 *
 * A round is one dispatch action, so before #3346 an item's landing and
 * release reached the journal only when the whole round settled, which can
 * take hours. These cases run a round under `EngineStore` over SQLite and
 * read the journal it writes: an item that lands is journaled as it lands,
 * while the items beside it still work, and a round that runs again after a
 * crash replays a recorded landing instead of landing twice.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { describe, expect, it } from "vitest"
import * as Burndown from "../src/Burndown.ts"
import { PatternError } from "../src/PatternError.ts"

interface Issue {
  readonly id: string
}

const Dispatch = Burndown.dispatch("burndown-journal/dispatch")

/** One round over two items, as the lineage would dispatch it. */
const Round = Flow.make("burndown-journal/round", {
  payload: {},
  success: Burndown.RoundResult,
  error: Schema.Union([PatternError, Burndown.Stop]),
  body: () =>
    Dispatch.call({
      input: { repo: "acme/app" },
      round: 0,
      items: [{ id: "a" }, { id: "b" }],
      settled: []
    })
})

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "burndown", changeId: "burndown" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** A step record as this suite reads it back from the journal. */
interface Step {
  readonly eventType: string
  readonly nodeId: string
  readonly action: unknown
  readonly outcome: unknown
  readonly value: unknown
}

/** The round's per-item steps the journal holds for `runId`, oldest first. */
const steps = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1000 })
    return page.entries.flatMap((entry): ReadonlyArray<Step> => {
      const payload = entry.payload as Record<string, unknown>
      const action = payload["action"]
      if (action !== Burndown.LandStep && action !== Burndown.ReleaseStep) return []
      const result = payload["result"] as { readonly preview?: string } | undefined
      return [{
        eventType: entry.eventType,
        nodeId: String(payload["nodeId"]),
        action,
        outcome: payload["outcome"],
        value: result?.preview === undefined ? undefined : JSON.parse(result.preview)
      }]
    })
  })

/**
 * One engine incarnation over the shared stores, living in `scope`: closing
 * the scope is the process going away mid-run.
 */
const incarnation = (scope: Scope.Scope, dispatch: Layer.Layer<any, any, any>) =>
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: "burndown-journal" },
      journalSource: "burndown-journal-test",
      isAlive: () => Effect.succeed(false)
    }).pipe(Scope.provide(scope))
    return yield* Layer.buildWithScope(
      Layer.mergeAll(dispatch, Interpreter.layer(Round)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
      ) as Layer.Layer<any, never, any>,
      scope
    )
  })

/** Runs `body` over one set of durable stores, with real SQLite and real Node crypto. */
const durable = <A, E>(body: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(body).pipe(
      Effect.provide(jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(":memory:")),
      Effect.provide(NodeCrypto.layer)
    ) as Effect.Effect<A, E, never>
  )

/** Waits, on the real clock, until `ready` holds for the journal's steps. */
const awaitSteps = (runId: string, ready: (steps: ReadonlyArray<Step>) => boolean) =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 500; attempt++) {
      const found = yield* steps(runId)
      if (ready(found)) return found
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(
      new Error(`the journal never reached the awaited steps: ${JSON.stringify(yield* steps(runId))}`)
    )
  })

const isSettled = (step: Step, nodeId: string) =>
  step.eventType === "flows.engine.node-settled" && step.nodeId === nodeId

describe("Burndown journal", () => {
  it("journals the first item's landing and release before the second item's work finishes", async () => {
    const slow = Deferred.makeUnsafe<void>()
    const landed: Array<string> = []
    const dispatch = Burndown.layer(Dispatch, {
      key: "sweep",
      concurrency: 2,
      claim: () => Effect.void,
      // `b` works until the test has read `a`'s records from the journal.
      work: ({ item }: Burndown.ItemArgs<unknown, Issue>) =>
        item.id === "b" ? Effect.as(Deferred.await(slow), "fixed b") : Effect.succeed("fixed a"),
      land: ({ item }) => Effect.sync(() => (landed.push(item.id), `commit-${item.id}`)),
      detail: (output, commit) => `${commit} ${output}`,
      release: () => Effect.void
    })

    const observed = await durable(Effect.gen(function*() {
      const context = yield* incarnation(yield* Effect.scope, dispatch)
      const running = yield* Effect.forkChild(
        Round.execute({}, { executionId: "journal-run" }).pipe(Effect.provideContext(context))
      )
      const whileWorking = yield* awaitSteps(
        "journal-run",
        (found) => found.some((step) => isSettled(step, "sweep/a/release"))
      )
      yield* Deferred.succeed(slow, undefined)
      const result = yield* Fiber.join(running)
      return { whileWorking, result, after: yield* steps("journal-run") }
    }))

    // While `b` still worked, `a` had landed, been journaled, and been released.
    expect(observed.whileWorking.map((step) => [step.eventType, step.nodeId])).toEqual([
      ["flows.engine.node-scheduled", "sweep/a/land"],
      ["flows.engine.node-settled", "sweep/a/land"],
      ["flows.engine.node-scheduled", "sweep/a/release"],
      ["flows.engine.node-settled", "sweep/a/release"]
    ])
    expect(observed.whileWorking[1]).toMatchObject({
      action: Burndown.LandStep,
      outcome: "built",
      value: { id: "a", status: "landed", detail: "commit-a fixed a" }
    })
    expect(observed.whileWorking[3]).toMatchObject({
      action: Burndown.ReleaseStep,
      outcome: "built",
      value: { id: "a", status: "landed", detail: "commit-a fixed a" }
    })
    expect(observed.result.rows).toEqual([
      { id: "a", status: "landed", detail: "commit-a fixed a" },
      { id: "b", status: "landed", detail: "commit-b fixed b" }
    ])
    // What the journal recorded is what the round settled to.
    expect(
      observed.after.filter((step) =>
        step.eventType === "flows.engine.node-settled" && step.action === Burndown.ReleaseStep
      )
        .map((step) => step.value)
    ).toEqual(observed.result.rows)
    expect(landed).toEqual(["a", "b"])
  })

  it("replays a recorded landing when the round runs again after a crash, instead of landing twice", async () => {
    const landed: Array<string> = []
    const released: Array<string> = []
    let incarnations = 0
    const dispatch = Burndown.layer(Dispatch, {
      key: "sweep",
      concurrency: 2,
      claim: () => Effect.void,
      // In the first process `b` never finishes: the process dies under it.
      work: ({ item }: Burndown.ItemArgs<unknown, Issue>) =>
        item.id === "b" && incarnations === 1 ? Effect.never : Effect.succeed(`fixed ${item.id}`),
      land: ({ item }) => Effect.sync(() => (landed.push(item.id), `commit-${item.id}-${incarnations}`)),
      detail: (output, commit) => `${commit} ${output}`,
      release: ({ item, status }) => Effect.sync(() => void released.push(`${item.id}:${status}`))
    })

    const observed = await durable(Effect.gen(function*() {
      const first = yield* Scope.make()
      incarnations = 1
      const before = yield* incarnation(first, dispatch)
      yield* Effect.forkChild(
        Round.execute({}, { executionId: "crash-run" }).pipe(Effect.provideContext(before), Effect.exit)
      )
      const recorded = yield* awaitSteps(
        "crash-run",
        (found) => found.some((step) => isSettled(step, "sweep/a/release"))
      )
      // The process dies after `a` landed and was released, before the round was recorded.
      yield* Scope.close(first, Exit.void)
      incarnations = 2
      const after = yield* incarnation(yield* Effect.scope, dispatch)
      const result = yield* Round.execute({}, { executionId: "crash-run" }).pipe(Effect.provideContext(after))
      return { recorded, result, journaled: yield* steps("crash-run") }
    }))

    // `a` landed once, in the first process; the rerun replayed its recorded landing.
    expect(landed).toEqual(["a", "b"])
    expect(observed.result.rows).toEqual([
      { id: "a", status: "landed", detail: "commit-a-1 fixed a" },
      { id: "b", status: "landed", detail: "commit-b-2 fixed b" }
    ])
    // The rerun claimed `a` again, so it released it again; the dying round
    // released `b`'s open claim for the rerun to take.
    expect(released.filter((entry) => entry.startsWith("a:"))).toEqual(["a:landed", "a:landed"])
    expect(released.filter((entry) => entry.startsWith("b:"))).toEqual(["b:requeued", "b:landed"])
    expect(observed.recorded.filter((step) => step.nodeId.startsWith("sweep/b/"))).toEqual([])
    // One scheduled/settled pair per step: the rerun's records collapse onto the first process's.
    const landings = observed.journaled.filter((step) => step.action === Burndown.LandStep)
    expect(landings.map((step) => [step.eventType, step.nodeId])).toEqual([
      ["flows.engine.node-scheduled", "sweep/a/land"],
      ["flows.engine.node-settled", "sweep/a/land"],
      ["flows.engine.node-scheduled", "sweep/b/land"],
      ["flows.engine.node-settled", "sweep/b/land"]
    ])
    // The recorded landing agrees with the row the round settled.
    expect(landings.filter((step) => step.eventType === "flows.engine.node-settled").map((step) => step.value))
      .toEqual(observed.result.rows)
  })

  it("journals a failed landing and a failed release as failed steps carrying the item's row", async () => {
    const dispatch = Burndown.layer(Dispatch, {
      key: "sweep",
      concurrency: 2,
      claim: () => Effect.void,
      work: ({ item }: Burndown.ItemArgs<unknown, Issue>) => Effect.succeed(`fixed ${item.id}`),
      land: ({ item }) => item.id === "a" ? Effect.fail("merge conflict") : Effect.succeed(`commit-${item.id}`),
      release: ({ item }) => item.id === "a" ? Effect.fail("claims unreachable") : Effect.void
    })

    const observed = await durable(Effect.gen(function*() {
      const context = yield* incarnation(yield* Effect.scope, dispatch)
      const result = yield* Round.execute({}, { executionId: "failed-run" }).pipe(Effect.provideContext(context))
      return { result, journaled: yield* steps("failed-run") }
    }))

    expect(observed.result.rows[0]).toEqual({
      id: "a",
      status: "failed",
      detail: "land: merge conflict; release: claims unreachable"
    })
    const settled = observed.journaled.filter((step) =>
      step.eventType === "flows.engine.node-settled" && step.nodeId.startsWith("sweep/a/")
    )
    expect(settled).toEqual([
      {
        eventType: "flows.engine.node-settled",
        nodeId: "sweep/a/land",
        action: Burndown.LandStep,
        outcome: "failed",
        value: { id: "a", status: "failed", detail: "land: merge conflict" }
      },
      {
        eventType: "flows.engine.node-settled",
        nodeId: "sweep/a/release",
        action: Burndown.ReleaseStep,
        outcome: "failed",
        value: observed.result.rows[0]
      }
    ])
  })

  it("records a Stop a landing raises, as a Stop whatever its shape, and stops the round", async () => {
    let stop: unknown
    const dispatch = Burndown.layer(Dispatch, {
      key: "sweep",
      concurrency: 1,
      claim: () => Effect.void,
      work: ({ item }: Burndown.ItemArgs<unknown, Issue>) => Effect.succeed(`fixed ${item.id}`),
      land: () => Effect.fail(stop as Burndown.Stop),
      release: () => Effect.void
    })

    const observed = await durable(Effect.gen(function*() {
      const context = yield* incarnation(yield* Effect.scope, dispatch)
      const outcomes: Array<{ readonly exit: Exit.Exit<unknown, unknown>; readonly journaled: ReadonlyArray<Step> }> =
        []
      for (
        const [executionId, raised] of [
          ["instance-run", new Burndown.Stop({ message: "main is frozen" })],
          ["plain-run", { _tag: "flows/patterns/Burndown/Stop", message: "main is frozen" }]
        ] as const
      ) {
        stop = raised
        const exit = yield* Effect.exit(Round.execute({}, { executionId }).pipe(Effect.provideContext(context)))
        outcomes.push({ exit, journaled: yield* steps(executionId) })
      }
      return outcomes
    }))

    for (const { exit, journaled } of observed) {
      const error = Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined
      expect(error?._tag === "Fail" ? error.error : undefined).toBeInstanceOf(Burndown.Stop)
      expect(error?._tag === "Fail" ? (error.error as Burndown.Stop).message : undefined).toBe("main is frozen")
      expect(
        journaled.filter((step) => step.action === Burndown.LandStep).map((step) => [step.eventType, step.outcome])
      )
        .toEqual([["flows.engine.node-scheduled", undefined], ["flows.engine.node-settled", "failed"]])
      expect(journaled.at(-1)?.value).toMatchObject({ message: "main is frozen" })
    }
  })
})
