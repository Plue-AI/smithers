/**
 * Control requests against a run the ENGINE owns: a resume, and a signal.
 *
 * Both defects are the same mistake from two directions. The control plane
 * assumed every run in the database was one it had launched, so `resume`
 * claimed an engine-created run under the control fence — overwriting the
 * engine's own `state_json` and owner columns, after which the engine's
 * `scheduleResume` no longer recognized the row and the run stayed `suspended`
 * with its waiting reason set forever (control-plane example 38, triage B-10).
 * And `signal` recorded a `control_run_messages` row that nothing read, so a
 * flow parked on `WaitFor.action` was never woken by the verb whose whole job
 * is to wake it (triage B-13).
 *
 * The engine here is the real durable one over real SQLite, sharing one
 * database with the control plane, because the claim under test is about two
 * writers of one row.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, DurableDeferred, Flow, type FlowRuntime, Interpreter, RetryPolicy, WaitFor } from "@smthrs/flow"
import * as Jj from "@smthrs/jj"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Registry } from "@smthrs/registry"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Effect, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { NoMatchingWait } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as ControlLive from "../src/ControlLive.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"

/**
 * No elapsed-poll resume within a case. A caller following a parked run
 * re-drives it on that timer as the fallback for a lost wake, and a re-drive
 * clears the waiting row until replay parks again: a signal that lands inside
 * it finds no open wait, is recorded as `unknown`, and waits for a host inbox
 * this bridge does not run. Every wake here is delivered, so only a wake may
 * re-drive a run.
 */
const suspendedRetryPolicy = RetryPolicy.make({ initialMs: 3_600_000, factor: 1, maxMs: 3_600_000 })

/** One step before the wait, so a replay after the wake is observable. */
const Mark = Action.make("engine-waits/mark", { payload: { label: Schema.String }, success: Schema.String })

const Gated = Flow.make("engine-waits/gated", {
  payload: { name: Schema.String },
  suspendedRetryPolicy,
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: ({ name }) =>
    Mark.call({ label: "before" }).pipe(
      Node.bindPlanned(() => WaitFor.action.call({ name }))
    )
})

/**
 * Two wait points in one run, so a second signal has something to land on.
 *
 * release policy 5.1 words the acceptance as "two different signals to ONE run
 * are two mutations". Two runs each parked once prove the idempotency key is
 * per payload; they do not prove a run that has already taken one signal can
 * take another, which is the part a shared `cli:signal:<runId>` key broke.
 */
const Twice = Flow.make("engine-waits/twice", {
  payload: {},
  suspendedRetryPolicy,
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: () =>
    WaitFor.action.call({ name: "first" }).pipe(
      Node.bindPlanned(() => WaitFor.action.call({ name: "second" }))
    )
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "engine-waits" as never, changeId: "engine-waits" as never }),
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

const marks: Array<string> = []

const engine = Layer.mergeAll(
  Mark.toLayer(({ label }) => Effect.sync(() => (marks.push(label), label))),
  WaitFor.layer,
  Interpreter.layer(Gated),
  Interpreter.layer(Twice)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(
    EngineStore.layer({
      owner: { hostId: "engine-waits-test" },
      journalSource: "engine-waits-test",
      isAlive: () => Effect.succeed(false)
    })
  ),
  Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj, jj), OwnerIdentity.layer))
)

/**
 * The delivery half of `Control.signal`, as a host implements it.
 *
 * It reads the run's own waiting row — the engine writes the `WaitFor` token
 * there when it parks — so it needs to know nothing about which flow the run
 * is, and it refuses a signal whose name addresses a different wait point. A
 * run with no waiting row at all is `unknown` rather than `no-match`: this
 * executor cannot see an open wait point, which is not the same as knowing
 * there is none.
 */
const deliver = (
  input: ControlExecutor.Signal
): Effect.Effect<
  ControlExecutor.SignalDelivery,
  never,
  DurableEngineState.DurableEngineState | FlowRuntime.FlowRuntime
> =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const waiting = yield* state.waiting(input.runId)
    if (Option.isNone(waiting)) return "unknown" as const
    const row = waiting.value
    if (row.reason !== "event" || row.token === null) return "no-match" as const
    const parsed = yield* Schema.decodeEffect(DurableDeferred.TokenParsed.FromString)(row.token).pipe(Effect.orDie)
    if (parsed.deferredName !== `WaitFor/${input.signal.name}`) return "no-match" as const
    yield* DurableDeferred.succeed(WaitFor.deferred(input.signal.name), {
      token: row.token as DurableDeferred.Token,
      value: input.signal.payload
    }).pipe(Effect.orDie)
    return "delivered" as const
  })

/** The executor port, holding the engine services the bridge reads through. */
const signalBridge = Layer.effect(ControlExecutor.ControlExecutor)(
  Effect.gen(function*() {
    const services = yield* Effect.context<
      DurableEngineState.DurableEngineState | FlowRuntime.FlowRuntime
    >()
    return ControlExecutor.makeNoop({
      deliverSignal: Effect.fn("TestExecutor.deliverSignal")((input) => Effect.provide(deliver(input), services))
    })
  })
)

/** The control plane over whichever executor the case installs. */
const plane = (bridged: boolean) =>
  Layer.provideMerge(
    ControlLive.layer,
    Layer.mergeAll(
      SqlControlRuntime.layer({}).pipe(Layer.orDie),
      NotificationQueue.layer,
      bridged ? signalBridge : ControlExecutor.layerNoop(),
      Registry.layerNoop()
    )
  )

const stack = (bridged: boolean) => Layer.merge(plane(bridged), engine).pipe(Layer.provideMerge(database))

const run = <A, E, R>(body: Effect.Effect<A, E, R>, bridged = false): Promise<A> =>
  Effect.runPromise(
    Effect.provide(body, stack(bridged) as unknown as Layer.Layer<R>).pipe(Effect.scoped, Effect.orDie)
  )

/** Polls until the run reaches a terminal state, or gives up and reports it. */
const settled = (runId: string, attempts = 2_000): Effect.Effect<string, unknown, RunStore.RunStore> =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const row = yield* store.get(runId)
    if (!["suspended", "running", "pending"].includes(row.status) || attempts <= 0) return row.status
    yield* Effect.yieldNow
    return yield* settled(runId, attempts - 1)
  })

/**
 * Polls the run's waiting row until it names `deferredName`, or gives up.
 *
 * A wake is not instantaneous: completing the first deferred re-drives the
 * execution, and the second `WaitFor` call parks it again a few storage writes
 * later. Reading the row once would race that replay.
 */
const waitingOn = (
  runId: string,
  deferredName: string,
  attempts = 2_000
): Effect.Effect<string, unknown, DurableEngineState.DurableEngineState> =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const waiting = yield* state.waiting(runId)
    const token = Option.isSome(waiting) ? waiting.value.token : null
    if (token !== null) {
      const parsed = yield* Schema.decodeEffect(DurableDeferred.TokenParsed.FromString)(token).pipe(Effect.orDie)
      if (parsed.deferredName === deferredName) return token
    }
    if (attempts <= 0) return yield* Effect.die(`run ${runId} never parked on ${deferredName}`)
    yield* Effect.yieldNow
    return yield* waitingOn(runId, deferredName, attempts - 1)
  })

/** Starts the gated flow and returns once it is parked on its wait point. */
const parkedRun = (runId: string, name: string) =>
  Effect.gen(function*() {
    yield* Gated.execute({ name }, { executionId: runId, discard: true })
    const state = yield* DurableEngineState.DurableEngineState
    const waiting = yield* state.waiting(runId)
    if (Option.isNone(waiting)) return yield* Effect.die(`run ${runId} did not park`)
    const runs = yield* RunStore.RunStore
    yield* TestDatabase.until(runs.get(runId).pipe(Effect.map((row) => row.status === "suspended")))
    return waiting.value
  })

describe("resuming a run the engine owns", () => {
  it("delegates to the owning driver instead of claiming the row", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const store = yield* RunStore.RunStore
      const state = yield* DurableEngineState.DurableEngineState
      const waiting = yield* parkedRun("engine-parked", "approval")
      const writer = yield* DurableWriter.DurableWriter
      let snapshot: { before: RunStore.RunRow; after: RunStore.RunRow; receipt: { _tag: string } } | undefined
      yield* TestDatabase.until(writer.write(Effect.gen(function*() {
        const before = yield* store.get("engine-parked")
        if (before.status !== "suspended") return false
        const receipt = yield* control.resume({ runId: "engine-parked", idempotencyKey: "resume:engine-parked" })
        snapshot = { before, receipt, after: yield* store.get("engine-parked") }
        return true
      })))
      const { before, after, receipt } = snapshot!

      // The engine's own wake still works, which is the whole point: the
      // control plane did not take the row away from the driver that parked it.
      yield* DurableDeferred.succeed(WaitFor.deferred("approval"), {
        token: waiting.token as DurableDeferred.Token,
        value: { approved: true }
      })
      const status = yield* settled("engine-parked")
      return { receipt, before, after, status, stillWaiting: yield* state.waiting("engine-parked") }
    }))

    expect(observed.receipt._tag).toBe("Accepted")
    // Not claimed: the engine's state and owner survive the resume, so the row
    // is still the one the driver parked rather than a control-plane summary
    // wearing its id.
    expect(observed.after.stateJson).toBe(observed.before.stateJson)
    // No wedge: the wait ended and the run finished.
    expect(observed.status).toBe("completed")
    expect(Option.isNone(observed.stillWaiting)).toBe(true)
  })
})

describe("signalling a run parked on a wait point", () => {
  it("completes the wait and settles the run", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        yield* parkedRun("signal-settles", "approval")

        const receipt = yield* control.signal({
          runId: "signal-settles",
          signal: { name: "approval", payload: { approved: true } },
          idempotencyKey: "signal:approval"
        })
        return {
          receipt,
          status: yield* settled("signal-settles"),
          recorded: yield* runtime.deliveredSignals("signal-settles")
        }
      }),
      true
    )

    expect(observed.receipt._tag).toBe("Accepted")
    expect(observed.status).toBe("completed")
    // The control row records the delivery too: an operator reading the run
    // afterwards can see what was sent, not only that it woke.
    expect(observed.recorded).toEqual([{ name: "approval", payload: { approved: true } }])
  })

  it("refuses an incompatible signal and excludes rejected admission from delivered signals", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        yield* parkedRun("signal-no-match", "approval")

        const failure = yield* Effect.flip(control.signal({
          runId: "signal-no-match",
          signal: { name: "shipped", payload: null },
          idempotencyKey: "signal:shipped"
        }))
        return { failure, recorded: yield* runtime.deliveredSignals("signal-no-match") }
      }),
      true
    )

    expect(observed.failure).toBeInstanceOf(NoMatchingWait)
    expect(observed.recorded).toEqual([])
  })

  /**
   * How that refusal reads to the operator who caused it.
   *
   * `smithers signal run-3 '{"name":"go", ...}'` against a timer-parked run
   * exited 1 with `go: ` on stderr and nothing else (release validation, defect
   * D3). The class declared a `name` field, which shadows
   * `Error.prototype.name`, and declared no message, and `bin.ts` `report`
   * prints `${name}: ${message}`. The operator was handed back the word they
   * had typed.
   */
  it("renders the refusal as the failure it is, not as the signal's own name", async () => {
    const failure = await run(
      Effect.gen(function*() {
        const control = yield* Control
        yield* parkedRun("signal-render", "approval")
        return yield* Effect.flip(control.signal({
          runId: "signal-render",
          signal: { name: "shipped", payload: null },
          idempotencyKey: "signal:render"
        }))
      }),
      true
    ) as NoMatchingWait

    // The two halves every renderer in the tree reads. `name` was the signal's
    // own name and `message` was empty.
    expect(failure.name).toBe("/control/NoMatchingWait")
    expect(failure.message).toContain(`no wait point named "shipped"`)
    expect(failure.message).toContain("signal-render")
    expect(failure.waitName).toBe("shipped")
    // Which is what the CLI prints, and it is no longer the operator's word
    // followed by an empty message.
    expect(`${failure.name}: ${failure.message}`).not.toBe("shipped: ")
  })

  it("lands two different signals, each on its own wait point", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        yield* parkedRun("signal-two-a", "first")
        yield* control.signal({
          runId: "signal-two-a",
          signal: { name: "first", payload: { step: 1 } },
          idempotencyKey: "signal:two-a"
        })
        yield* settled("signal-two-a")
        yield* parkedRun("signal-two-b", "second")
        const second = yield* control.signal({
          runId: "signal-two-b",
          signal: { name: "second", payload: { step: 2 } },
          idempotencyKey: "signal:two-b"
        })
        return {
          second,
          firstRecorded: yield* runtime.deliveredSignals("signal-two-a"),
          secondRecorded: yield* runtime.deliveredSignals("signal-two-b"),
          secondStatus: yield* settled("signal-two-b")
        }
      }),
      true
    )

    expect(observed.second._tag).toBe("Accepted")
    expect(observed.firstRecorded).toEqual([{ name: "first", payload: { step: 1 } }])
    expect(observed.secondRecorded).toEqual([{ name: "second", payload: { step: 2 } }])
    expect(observed.secondStatus).toBe("completed")
  })

  it("lands two different signals on ONE run, each on its own wait point", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        yield* Twice.execute({}, { executionId: "signal-one-run", discard: true })
        yield* waitingOn("signal-one-run", "WaitFor/first")

        const first = yield* control.signal({
          runId: "signal-one-run",
          signal: { name: "first", payload: { step: 1 } },
          idempotencyKey: "signal:one-run:first"
        })
        // The run has to reach its SECOND park before the second signal can
        // land: that is the state a shared idempotency key never let it use.
        yield* waitingOn("signal-one-run", "WaitFor/second")
        const second = yield* control.signal({
          runId: "signal-one-run",
          signal: { name: "second", payload: { step: 2 } },
          idempotencyKey: "signal:one-run:second"
        })
        return {
          first,
          second,
          status: yield* settled("signal-one-run"),
          recorded: yield* runtime.deliveredSignals("signal-one-run")
        }
      }),
      true
    )

    expect(observed.first._tag).toBe("Accepted")
    expect(observed.second._tag).toBe("Accepted")
    // Both mutations landed, in order, against one run.
    expect(observed.recorded).toEqual([
      { name: "first", payload: { step: 1 } },
      { name: "second", payload: { step: 2 } }
    ])
    expect(observed.status).toBe("completed")
  })

  it("records a signal no executor could deliver, for the next start to pick up", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const store = yield* RunStore.RunStore
      yield* parkedRun("signal-executor-down", "approval")
      const receipt = yield* control.signal({
        runId: "signal-executor-down",
        signal: { name: "approval", payload: { approved: true } },
        idempotencyKey: "signal:down"
      })
      return {
        receipt,
        recorded: yield* runtime.deliveredSignals("signal-executor-down"),
        status: (yield* store.get("signal-executor-down")).status
      }
    }))

    // The composition's executor drives nothing, so the record is all the
    // control plane can do — and it is exactly what a later executor start
    // replays.
    expect(observed.receipt._tag).toBe("Accepted")
    expect(observed.recorded).toEqual([{ name: "approval", payload: { approved: true } }])
    expect(observed.status).toBe("suspended")
  })
})
