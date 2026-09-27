/**
 * A question parked on a nested execution, answered from the run an operator
 * knows about.
 *
 * On Smithers Cloud, `run-3` of `coding/request` asked a person a
 * clarifying question through `HumanTask` and then parked forever. The park
 * landed on `coding/PreparePlan`, four `.child()` boundaries below the run the
 * product shows, so:
 *
 * - `Control.list` with `status: "waiting-approval"` returned nothing, and the
 *   approvals inbox said "No approvals are pending" while the run card said
 *   "WAITING FOR EVENT";
 * - `Signal` addressed to `run-3` failed `/control/NoMatchingWait`, because
 *   the delivery bridge read the root's own waiting row and found an `event`
 *   wait that no signal named.
 *
 * Both are the same mistake: a run tree was asked a question about one row.
 * This suite is that tree, over the real durable engine and the real control
 * plane sharing one database.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, Flow, type FlowRuntime, HumanTask, Interpreter } from "@smthrs/flow"
import * as Jj from "@smthrs/jj"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Registry } from "@smthrs/registry"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as ControlLive from "../src/ControlLive.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"

const prompt = "Which service owns the retry budget?"

/** The execution that actually asks the person, four boundaries down. */
const PreparePlan = Flow.make("nested/PreparePlan", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => HumanTask.action.call({ name: "coding-clarification", kind: "ask", prompt, maxAttempts: 3 })
})

const PrepareWithWiki = Flow.make("nested/PrepareWithWiki", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => PreparePlan.child({})
})

const Request = Flow.make("nested/Request", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => PrepareWithWiki.child({})
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "nested-human-waits" as never, changeId: "nested-human-waits" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/** One database, provided once, so the engine and the control plane share rows. */
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
  HumanTask.layer,
  Interpreter.layer(Request),
  Interpreter.layer(PrepareWithWiki),
  Interpreter.layer(PreparePlan)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(
    EngineStore.layer({
      owner: { hostId: "nested-human-waits" },
      journalSource: "nested-human-waits",
      isAlive: () => Effect.succeed(false)
    })
  ),
  Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj, jj), OwnerIdentity.layer))
)

/**
 * The PRODUCTION delivery bridge, not a test double.
 *
 * `AgentSession.deliverSignal` is what a host installs, and the routing under
 * test lives inside it: the signal is addressed to the root and has to reach
 * the execution holding the wait.
 */
const signalBridge = Layer.effect(ControlExecutor.ControlExecutor)(
  Effect.gen(function*() {
    const services = yield* Effect.context<
      DurableEngineState.DurableEngineState | FlowRuntime.FlowRuntime
    >()
    return ControlExecutor.makeNoop({
      deliverSignal: Effect.fn("NestedExecutor.deliverSignal")((input) =>
        Effect.provide(AgentSession.deliverSignal(input), services).pipe(Effect.orDie)
      )
    })
  })
)

const plane = Layer.provideMerge(
  ControlLive.layer,
  Layer.mergeAll(
    SqlControlRuntime.layer({}).pipe(Layer.orDie),
    NotificationQueue.layer,
    signalBridge,
    Registry.layerNoop()
  )
)

const stack = Layer.merge(plane, engine).pipe(Layer.provideMerge(database))

const run = <A, E, R>(body: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(body, stack as unknown as Layer.Layer<R>).pipe(Effect.scoped, Effect.orDie)
  )

/** Polls until some execution below the root is parked on the human wait. */
const parkedBelow = (
  rootId: string,
  attempts = 4_000
): Effect.Effect<DurableEngineState.WaitingRow, unknown, DurableEngineState.DurableEngineState> =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const open = yield* state.waitingTree(rootId)
    const human = open.find((row) => row.reason === "approval" && row.runId !== rootId)
    if (human !== undefined) return human
    if (attempts <= 0) return yield* Effect.die(`no execution below ${rootId} parked on a human wait`)
    yield* Effect.yieldNow
    return yield* parkedBelow(rootId, attempts - 1)
  })

const settled = (runId: string, attempts = 4_000): Effect.Effect<string, unknown, RunStore.RunStore> =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const row = yield* store.get(runId)
    if (!["suspended", "running", "pending"].includes(row.status) || attempts <= 0) return row.status
    yield* Effect.yieldNow
    return yield* settled(runId, attempts - 1)
  })

describe("a human wait parked on a nested execution", () => {
  it("rolls the root run up to waiting-approval and names the question", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      yield* Request.execute({}, { executionId: "run-3", discard: true })
      const parked = yield* parkedBelow("run-3")

      const summary = yield* runtime.getRun("run-3")
      const inbox = yield* control.list({ _tag: "runs", filters: { status: "waiting-approval" } })
      return { parked, summary, inbox: inbox._tag === "runs" ? inbox.items.map((item) => item.runId) : [] }
    }))

    // The root's OWN row is not parked on the human wait; a descendant's is.
    expect(observed.parked.runId).not.toBe("run-3")
    // What the run card and the inbox filter both read.
    expect(observed.summary.status).toBe("waiting-approval")
    expect(observed.inbox).toContain("run-3")

    const waits = observed.summary.pendingWaits ?? []
    expect(waits.map((wait) => wait.runId)).toEqual([observed.parked.runId])
    expect(waits[0]).toMatchObject({
      reason: "approval",
      name: "coding-clarification",
      attempt: 1,
      token: observed.parked.token,
      // Renderable: the inbox can put the question and an answer box on screen
      // without opening the execution that asked it.
      request: { kind: "ask", prompt, name: "coding-clarification", maxAttempts: 3 }
    })
  })

  it("answers the descendant's wait from a signal addressed to the root run", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      yield* Request.execute({}, { executionId: "run-4", discard: true })
      yield* parkedBelow("run-4")

      // Exactly the call that used to fail /control/NoMatchingWait: the run an
      // operator names, and the question's own name.
      const receipt = yield* control.signal({
        runId: "run-4",
        signal: { name: "coding-clarification", payload: "the scheduler owns it" },
        idempotencyKey: "signal:run-4:clarify"
      })
      return { receipt, status: yield* settled("run-4") }
    }))

    expect(observed.receipt._tag).toBe("Accepted")
    expect(observed.status).toBe("completed")
  })

  it("reports the wait on the execution holding it and on every ancestor", async () => {
    const observed = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const store = yield* RunStore.RunStore
      yield* Request.execute({}, { executionId: "run-6", discard: true })
      const parked = yield* parkedBelow("run-6")
      let rootRow = ""
      yield* TestDatabase.until(
        store.get("run-6").pipe(Effect.map((row) => {
          rootRow = row.status
          return row.status === "suspended"
        }))
      )
      return {
        root: yield* runtime.getRun("run-6"),
        rootRow,
        holder: yield* runtime.getRun(parked.runId)
      }
    }))

    // Both the root and the execution holding the wait report it. Only
    // ATTACHED waits travel: `.child()` means the ancestor is waiting for that
    // child's value, while a `detach` spawn outlives the run that started it
    // and its question stops at its own execution.
    expect(observed.rootRow).toBe("suspended")
    expect(observed.root.status).toBe("waiting-approval")
    expect(observed.holder.status).toBe("waiting-approval")
    expect((observed.holder.pendingWaits ?? []).map((wait) => wait.runId)).toEqual([observed.holder.runId])
  })

  it("still refuses a signal that names no open wait in the tree", async () => {
    const failure = await run(Effect.gen(function*() {
      const control = yield* Control
      yield* Request.execute({}, { executionId: "run-5", discard: true })
      yield* parkedBelow("run-5")
      return yield* Effect.flip(control.signal({
        runId: "run-5",
        signal: { name: "shipped", payload: null },
        idempotencyKey: "signal:run-5:shipped"
      }))
    }))

    expect(failure.name).toBe("/control/NoMatchingWait")
  })
})
