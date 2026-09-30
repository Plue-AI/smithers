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
import { Action, DurableDeferred, Flow, FlowRuntime, HumanTask, Interpreter, RetryPolicy, WaitFor } from "@smthrs/flow"
import * as Jj from "@smthrs/jj"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Registry } from "@smthrs/registry"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type * as ApprovalAuthority from "../src/ApprovalAuthority.ts"
import { Control } from "../src/Control.ts"
import { Unauthorized } from "../src/ControlError.ts"
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

/** A plain `WaitFor` gate: an event, not a question, so any signal answers it. */
const Gate = Flow.make("nested/Gate", {
  payload: {},
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: () => WaitFor.action.call({ name: "shipped" })
})

/**
 * No elapsed-poll resume within a case. A caller following a parked run
 * re-drives it on that timer as the fallback for a lost wake, and a re-drive
 * clears the waiting row until replay parks again. Each shared parent's replay
 * also re-drives the shared child, so every poll briefly leaves both parents
 * without an open question below them. Nothing here is ever answered, so no
 * re-drive may land between the barrier and the reads.
 */
const quietFollower = RetryPolicy.make({ initialMs: 3_600_000, factor: 1, maxMs: 3_600_000 })

const SharedParent = Flow.make("nested/SharedParent", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const SharedApproval = Flow.make("nested/SharedApproval", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
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
  Interpreter.layer(PreparePlan),
  WaitFor.layer,
  Interpreter.layer(Gate)
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

const plane = (options: SqlControlRuntime.Options = {}) =>
  Layer.provideMerge(
    ControlLive.layer,
    Layer.mergeAll(
      SqlControlRuntime.layer(options).pipe(Layer.orDie),
      NotificationQueue.layer,
      signalBridge,
      Registry.layerNoop()
    )
  )

const stackWith = (options: SqlControlRuntime.Options = {}) =>
  Layer.merge(plane(options), engine).pipe(Layer.provideMerge(database))

const runWith = (options: SqlControlRuntime.Options) => <A, E, R>(body: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(body, stackWith(options) as unknown as Layer.Layer<R>).pipe(Effect.scoped, Effect.orDie)
  )

const run = runWith({})

/** A host policy that lets nobody approve anything. */
const refusingAuthority: ApprovalAuthority.Service = {
  authorize: () => Effect.fail(new Unauthorized({ message: "no approver is delegated" }))
}

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
  it("shows a shared attached question once under each parent in every public reader", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const state = yield* DurableEngineState.DurableEngineState
      const flowRuntime = yield* FlowRuntime.FlowRuntime
      const token = DurableDeferred.tokenFromExecutionId(WaitFor.deferred("approval"), {
        flow: SharedApproval,
        executionId: "shared-approval"
      })
      yield* flowRuntime.register(SharedApproval, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          instance.waiting = {
            reason: "approval",
            token,
            request: JSON.stringify({
              task: "human",
              name: "shared-question",
              kind: "ask",
              prompt,
              attempt: 1,
              maxAttempts: 3
            })
          }
          return yield* Flow.suspend(instance)
        }))
      yield* flowRuntime.register(SharedParent, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          yield* flowRuntime.execute(SharedApproval, {
            executionId: "shared-approval",
            payload: {}
          }).pipe(Effect.orDie)
          instance.waiting = { reason: "event", token: `${instance.executionId}-event` }
          return yield* Flow.suspend(instance)
        }))

      const runs = yield* RunStore.RunStore
      for (const parentId of ["parent-A", "parent-B"]) {
        yield* flowRuntime.execute(SharedParent, {
          executionId: parentId,
          payload: {},
          discard: true,
          suspendedRetryPolicy: quietFollower
        })
        // `discard: true` answers at admission (#2932). The child parks first
        // and the parent a few writes later, so wait for the parent's own park
        // too: a reader in between sees a running or bare parked parent.
        yield* TestDatabase.until(Effect.gen(function*() {
          const parent = yield* runs.get(parentId)
          const tree = yield* state.waitingTree(parentId)
          return parent.status === "suspended" &&
            tree.some((row) => row.runId === parentId) &&
            tree.some((row) => row.runId === "shared-approval")
        }))
      }
      const parents = (yield* state.runParents("shared-approval")).map((edge) => edge.parentId)
      const reads = yield* Effect.forEach(parents, (id) => AgentSession.readExecution(id))
      const summaries = yield* Effect.forEach(parents, (id) => runtime.getRun(id))
      const page = yield* control.list({ _tag: "runs", filters: { status: "waiting-approval" } })
      return { parents, reads, summaries, page }
    }))

    expect(observed.parents).toEqual(["parent-A", "parent-B"])
    for (const read of observed.reads) {
      expect(read).toMatchObject({ _tag: "Observed", status: "waiting-approval" })
      expect(read._tag === "Observed" ? read.pendingWaits?.map((wait) => wait.runId) : []).toEqual(["shared-approval"])
    }
    for (const summary of observed.summaries) {
      expect(summary.status).toBe("waiting-approval")
      expect(summary.pendingWaits?.map((wait) => wait.runId)).toEqual(["shared-approval"])
      expect(summary.pendingWaits?.[0]?.request).toMatchObject({ prompt })
    }
    expect(observed.page._tag).toBe("runs")
    if (observed.page._tag === "runs") {
      const parents = observed.page.items.filter((item) => observed.parents.includes(item.runId))
      expect(parents.map((item) => item.runId).sort()).toEqual(["parent-A", "parent-B"])
      for (const parent of parents) {
        expect(parent.pendingWaits?.map((wait) => wait.runId)).toEqual(["shared-approval"])
      }
    }
  })

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

describe("a signal addressed to a human wait", () => {
  it("is refused when ApprovalAuthority refuses its principal, and the wait stays open", async () => {
    const observed = await runWith({ approvalAuthority: refusingAuthority })(Effect.gen(function*() {
      const control = yield* Control
      const state = yield* DurableEngineState.DurableEngineState
      yield* Request.execute({}, { executionId: "run-7", discard: true })
      const parked = yield* parkedBelow("run-7")
      const exit = yield* Effect.exit(control.signal({
        runId: "run-7",
        signal: { name: "coding-clarification", payload: "the scheduler owns it" },
        idempotencyKey: "signal:run-7:clarify"
      }))
      const open = yield* state.waitingTree("run-7")
      return { exit, token: parked.token, open: open.map((row) => row.token) }
    }))

    expect(Exit.isFailure(observed.exit)).toBe(true)
    if (Exit.isFailure(observed.exit)) {
      expect(String(observed.exit.cause)).toContain("/control/Unauthorized")
    }
    expect(observed.open).toContain(observed.token)
  })

  it("still delivers a plain WaitFor event signal under that same refusing authority", async () => {
    const observed = await runWith({ approvalAuthority: refusingAuthority })(Effect.gen(function*() {
      const control = yield* Control
      const state = yield* DurableEngineState.DurableEngineState
      yield* Gate.execute({}, { executionId: "run-8", discard: true })
      yield* TestDatabase.until(state.waitingTree("run-8").pipe(Effect.map((rows) => rows.length > 0)))
      const receipt = yield* control.signal({
        runId: "run-8",
        signal: { name: "shipped", payload: "v1" },
        idempotencyKey: "signal:run-8:shipped"
      })
      return { receipt, status: yield* settled("run-8") }
    }))

    expect(observed.receipt._tag).toBe("Accepted")
    expect(observed.status).toBe("completed")
  })
})
