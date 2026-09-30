/**
 * The production engine port, exercised against the real flow engine.
 *
 * Every case runs inside a registered `Flow` on `FlowEngine.layerMemory`, so
 * the activity identity, replay, and suspension behaviour asserted here is the
 * engine's own, not a stand-in.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as CellTurn from "@smthrs/harness/CellTurn"
import * as ContextWindow from "@smthrs/harness/ContextWindow"
import * as EngineLike from "@smthrs/harness/EngineLike"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Plan from "@smthrs/harness/Plan"
import { CallFact } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as StepKey from "@smthrs/plan/StepKey"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import * as StdError from "@smthrs/std/StdError"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  PlatformError,
  Redacted,
  References,
  Result,
  Schedule,
  Schema,
  Scope,
  Stream
} from "effect"
import * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { describe, expect, it, vi } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"
import * as Budget from "../src/Budget.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as InternalFlowEngineLike from "../src/internal/FlowEngineLike.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import * as WorkspaceObservation from "../src/WorkspaceObservation.ts"

/**
 * Everything `FlowEngineLike.make` reads, the two safety policies included.
 *
 * The port requires a budget and a quota classifier outright, so every helper
 * here carries them: a composition that names neither cannot build the port,
 * which is the whole point of them not being optional.
 */
type PortServices =
  | Crypto.Crypto
  | FlowRuntime.FlowRuntime
  | FlowRuntime.FlowInstance
  | Budget.Budget
  | QuotaPolicy.QuotaClassifier

const preparedFor = (routeId: string, body: string): Route.PreparedRequest => ({
  routeId,
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode(body),
  bodyText: body
})

const staticRoute = (routeId = "route-a", body = "{}"): FlowEngineLike.RouteResolver => ({
  prepare: () => Effect.succeed(preparedFor(routeId, body))
})

const failingRoute: FlowEngineLike.RouteResolver = {
  prepare: () => Effect.fail(new ModelError({ code: "invalid_request", message: "no route" }))
}

const request = (text: string): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    modelId: "test-model",
    system: [],
    messages: [ModelRequest.Message.user(text)],
    tools: [],
    params: ModelRequest.GenerationParams.make()
  })

const step = (
  text: string,
  overrides: Partial<EngineLike.SealedModelStep["keyMaterial"]> = {}
): EngineLike.SealedModelStep => ({
  request: request(text),
  keyMaterial: {
    version: "flows/key-material/v2",
    kind: "sealed",
    body: { _tag: "ModelCall", request: request(text) },
    inputs: [{
      _tag: "Literal",
      value: { contextDigest: ContextWindow.make({ modelId: "m", segments: [] }).digest }
    }],
    layers: [],
    capabilities: [],
    effects: undefined,
    placement: undefined,
    ...overrides
  }
})

/** A model that records every provider call and replies with one text delta. */
const countingModel = (calls: Array<string>): Model.Model =>
  Model.make({
    stream: (input) =>
      Stream.suspend(() => {
        calls.push(input.modelId)
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "0" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "0", text: "reply" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

const child = (flowName = "alpha"): Plan.Child =>
  new Plan.Child({
    flowName,
    callId: "call-1",
    args: { value: "x" },
    capabilities: [],
    effects: {
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none()
  })

type Outcome =
  | { readonly _tag: "completed"; readonly value: unknown }
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "suspended" }

const classify = (exit: Exit.Exit<unknown, unknown>): Outcome =>
  Exit.isSuccess(exit)
    ? { _tag: "completed", value: exit.value }
    : Cause.hasInterruptsOnly(exit.cause)
    ? { _tag: "suspended" }
    : { _tag: "failed", error: Cause.squash(exit.cause) }

/**
 * The one flow every `drive` execution registers. Its body is inert: the
 * behaviour under test is the `execute` handed to `register`.
 */
const driveFlow = Flow.make("agent/test/engine-like", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/** Waits, boundedly, for the engine to publish a parked execution. */
const awaitParked = (
  engine: FlowRuntime.FlowRuntime["Service"],
  flow: typeof driveFlow,
  attempts = 100
): Effect.Effect<void, FlowRuntime.FlowExecutionNotFound> =>
  Effect.gen(function*() {
    const polled = yield* engine.poll(flow, "exec-1")
    if (Option.isSome(polled) && polled.value._tag === "Suspended") return
    if (attempts <= 0) throw new Error("the engine never published the parked execution")
    yield* Effect.yieldNow
    return yield* awaitParked(engine, flow, attempts - 1)
  })

/**
 * Registers `body` as a real flow, executes it, and settles on the attempt's
 * own exit.
 *
 * `discard: true` is deliberate: a suspended execution never produces a value,
 * so the completion latch — not the `execute` effect — is the signal. With
 * `resume: true` the harness re-enters the parked execution once and reports
 * the second attempt's outcome, which is how the replay assertions observe a
 * recorded step surviving a park.
 */
const drive = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | Crypto.Crypto
    | FlowRuntime.FlowRuntime
    | FlowRuntime.FlowInstance
    | Budget.Budget
    | QuotaPolicy.QuotaClassifier
  >,
  options: { readonly resume?: boolean } = {}
): Promise<Outcome> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const flow = driveFlow
    let settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.register(flow, () =>
      Effect.onExit(body, (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit))))).pipe(
        Scope.provide(scope)
      )
    yield* engine.execute(flow, { executionId: "exec-1", payload: {}, discard: true })
    const first = yield* Deferred.await(settled)
    if (options.resume !== true || first._tag !== "suspended") {
      return first
    }
    // The latch fires from the body's own exit, a few scheduler steps before
    // the engine publishes the parked result. `resume` refuses to re-enter an
    // execution whose previous fiber has not settled, so wait for publication.
    yield* awaitParked(engine, flow)
    settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.resume(flow, "exec-1")
    return yield* Deferred.await(settled)
  }).pipe(
    // Both safety services are declared outright rather than defaulted: the
    // port requires them, so a suite states the policy it runs under. These
    // are the explicit "no ceiling, no park" choices, which is what these
    // cases were always exercising.
    Effect.provide(
      Layer.mergeAll(
        FlowEngine.layerMemory,
        NodeCrypto.layer,
        Budget.layerUnbounded(),
        QuotaPolicy.layerUnclassified()
      )
    ),
    Effect.scoped,
    Effect.runPromise
  )

const completed = (outcome: Outcome): unknown => {
  expect(outcome._tag).toBe("completed")
  return (outcome as { readonly value: unknown }).value
}

const failure = (outcome: Outcome): unknown => {
  expect(outcome._tag).toBe("failed")
  return (outcome as { readonly error: unknown }).error
}

describe("FlowEngineLike conversions", () => {
  it("normalizes absolute declarations to workspace-relative paths", () => {
    expect(["/**", "/a/b", "a/b"].map(FlowEngineLike.workspaceRelative)).toEqual(["**", "a/b", "a/b"])
  })

  it("converts call effects to the engine file boundary", () => {
    const boundary = (mode: "hermetic" | "expected") =>
      FlowEngineLike.callBoundary(
        new Cell.Call({
          flowName: "notes/save",
          input: {},
          capabilities: [],
          effects: {
            reads: ["/**", "/a/b", "a/b"],
            writes: ["/output/result.md", "output/index.md"],
            mode,
            onConflict: "serialize",
            tier: "sealed"
          },
          placement: Option.none(),
          identity: new Cell.CallIdentity({
            session: "boundary-session",
            frame: 0,
            cell: "cell-digest",
            ordinal: 0,
            declaration: "declaration-digest",
            layers: []
          })
        })
      )

    expect(boundary("hermetic")).toEqual({
      readSet: [
        { path: "**", digest: "declaration-digest" },
        { path: "a/b", digest: "declaration-digest" },
        { path: "a/b", digest: "declaration-digest" }
      ],
      writeSet: ["output/result.md", "output/index.md"],
      boundaryMode: "hard"
    })
    expect(boundary("expected").boundaryMode).toBe("expected")
  })
})

describe("FlowEngineLike.make", () => {
  it("keeps pre-retry array records decodable for resumed sealed steps", () => {
    const legacy = [
      ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "0" }),
      ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ]

    const decoded = Schema.decodeUnknownSync(FlowEngineLike.RecordedModelStep)(legacy)
    expect(decoded).toEqual(legacy)
    expect(InternalFlowEngineLike.normalizeRecordedModelStep(decoded)).toEqual({ events: legacy, error: undefined })

    const current = { events: legacy }
    expect(InternalFlowEngineLike.normalizeRecordedModelStep(current)).toBe(current)
  })

  it("streams the model events of a sealed step and records them for replay", async () => {
    const calls: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: countingModel(calls),
        route: staticRoute()
      })
      const first = yield* Stream.runCollect(engine.sealStep(step("hello")))
      const second = yield* Stream.runCollect(engine.sealStep(step("hello")))
      return { first, second }
    }))

    const { first, second } = completed(outcome) as {
      readonly first: ReadonlyArray<ModelEvent.ModelEvent>
      readonly second: ReadonlyArray<ModelEvent.ModelEvent>
    }
    expect(first.map((event) => event.type)).toEqual(["text-start", "text-delta", "settle"])
    expect(second).toEqual(first)
    // Same sealed step key, so the engine replayed the recorded events instead
    // of calling the provider a second time.
    expect(calls).toEqual(["test-model"])
  })

  it("reserves budget before a provider call so concurrent callers cannot spend the same allowance", async () => {
    let calls = 0
    const outcome = await drive(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 1_000 } })
      yield* budget.record("seed", { totalTokens: 400 })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const model = Model.make({
        stream: () =>
          Stream.unwrap(Effect.gen(function*() {
            calls++
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return Stream.make(
              ModelEvent.ModelEvent.Usage({ totalTokens: 400 }),
              ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
            )
          }))
      })
      const engine = yield* FlowEngineLike.make({ model, route: staticRoute() }).pipe(
        Effect.provideService(Budget.Budget, budget)
      )
      const first = yield* Stream.runCollect(engine.sealStep(step("first"))).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const second = yield* Stream.runCollect(engine.sealStep(step("second"))).pipe(Effect.exit)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      return { second: classify(second), usage: yield* budget.usage }
    }))
    const result = completed(outcome) as { second: Outcome; usage: Budget.Usage }
    expect(result.second._tag).toBe("failed")
    expect(JSON.stringify(failure(result.second))).toContain("reserved")
    expect(result.usage).toEqual({ tokens: 800, calls: 2, largestCall: 400 })
    expect(calls).toBe(1)
  })

  it("sums final usage per retry attempt without replaying partial text or leaking recorder state", async () => {
    let calls = 0
    const model = Model.make({
      stream: () =>
        Stream.suspend((): Stream.Stream<ModelEvent.ModelEvent, ModelError> => {
          calls++
          return calls % 2 === 1
            ? Stream.concat(
              Stream.make(
                ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "failed", text: "unsafe partial text" }),
                ModelEvent.ModelEvent.Usage({ inputTokens: 100 }),
                ModelEvent.ModelEvent.Usage({ inputTokens: 200, totalTokens: 260 }),
                ModelEvent.ModelEvent.Usage({ inputTokens: undefined })
              ),
              Stream.fail(new ModelError({ code: "transport", message: "dropped after usage" }))
            )
            : Stream.make(
              ModelEvent.ModelEvent.Usage({ outputTokens: 40 }),
              ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
            )
        })
    })
    const recording = InternalFlowEngineLike.recordModelStep(model, request("retry usage"), Schedule.recurs(1))
    for (let i = 0; i < 2; i++) {
      const recorded = InternalFlowEngineLike.normalizeRecordedModelStep(await Effect.runPromise(recording))
      expect(recorded.events.map((event) => event.type)).toEqual(["retry", "usage", "settle"])
      expect(ModelEvent.ModelEvent.settledMessage(recorded.events).usage).toEqual({
        inputTokens: 200,
        outputTokens: 40,
        totalTokens: 300
      })
      expect(JSON.stringify(recorded.events)).not.toContain("unsafe partial text")
    }
    expect(calls).toBe(4)
  })

  it("cannot cancel invalid negative usage against a later positive retry", async () => {
    let calls = 0
    const model = Model.make({
      stream: () =>
        Stream.suspend(() => {
          calls++
          return calls === 1
            ? Stream.concat(
              Stream.make(ModelEvent.ModelEvent.Usage({ totalTokens: -600 })),
              Stream.fail(new ModelError({ code: "transport", message: "retry after malformed usage" }))
            )
            : Stream.make(
              ModelEvent.ModelEvent.Usage({ totalTokens: 700 }),
              ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
            )
        })
    })
    const recorded = InternalFlowEngineLike.normalizeRecordedModelStep(
      await Effect.runPromise(
        InternalFlowEngineLike.recordModelStep(model, request("malformed usage"), Schedule.recurs(1))
      )
    )
    const usage = ModelEvent.ModelEvent.settledMessage(recorded.events).usage
    // Previously this became an apparently valid 100-token bill. Preserve the
    // invalid accounting signal so Budget.record cannot durably accept it.
    expect(Number.isNaN(usage.totalTokens)).toBe(true)
    const budget = await Effect.runPromise(Budget.make({ tokens: { max: 1_000 } }))
    expect((await Effect.runPromiseExit(budget.record("malformed", usage)))._tag).toBe("Failure")
    expect((await Effect.runPromiseExit(budget.check("next")))._tag).toBe("Failure")
  })

  it("accounts provider-reported usage even when the model stream fails", async () => {
    const outcome = await drive(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 1_000 } })
      const model = Model.make({
        stream: () =>
          Stream.concat(
            Stream.make(
              ModelEvent.ModelEvent.Usage({ totalTokens: 300 })
            ),
            Stream.fail(new ModelError({ code: "invalid_request", message: "failed after usage" }))
          )
      })
      const engine = yield* FlowEngineLike.make({ model, route: staticRoute() }).pipe(
        Effect.provideService(Budget.Budget, budget)
      )
      const result = yield* Stream.runCollect(engine.sealStep(step("failed"))).pipe(Effect.exit)
      return { result: classify(result), usage: yield* budget.usage }
    }))
    const result = completed(outcome) as { result: Outcome; usage: Budget.Usage }
    expect(result.result._tag).toBe("failed")
    expect(result.usage).toEqual({ tokens: 300, calls: 1, largestCall: 300 })
  })

  it("durably charges an unsealed capacity failure without marking its retry paid", async () => {
    let calls = 0
    const outcome = await drive(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 1_000 } })
        const model = Model.make({
          stream: () =>
            Stream.suspend(() => {
              calls++
              return Stream.concat(
                Stream.make(ModelEvent.ModelEvent.Usage({ totalTokens: 600 })),
                Stream.fail(new ModelError({ code: "rate_limited", message: "capacity after usage" }))
              )
            })
        })
        const engine = yield* FlowEngineLike.make({ model, route: staticRoute() }).pipe(
          Effect.provideService(Budget.Budget, budget)
        )
        const first = yield* Stream.runCollect(engine.sealStep(step("capacity"))).pipe(Effect.exit)
        const retry = yield* Stream.runCollect(engine.sealStep(step("capacity"))).pipe(Effect.exit)
        const fresh = yield* Budget.make({ tokens: { max: 1_000 } })
        return { first: classify(first), retry: classify(retry), live: yield* budget.usage, fresh: yield* fresh.usage }
      }).pipe(Effect.provide(TestJournal.layer()))
    )
    const result = completed(outcome) as { first: Outcome; retry: Outcome; live: Budget.Usage; fresh: Budget.Usage }
    expect(failure(result.first)).toMatchObject({ code: "rate_limited" })
    expect(failure(result.retry)).toMatchObject({ code: "model_failed" })
    expect(result.live).toEqual({ tokens: 600, calls: 1, largestCall: 600 })
    expect(result.fresh).toEqual(result.live)
    expect(calls).toBe(1)
  })

  it("counts a successful retry separately from its unsealed predecessor and replays it once", async () => {
    let calls = 0
    const outcome = await drive(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 2_000 } })
        const model = Model.make({
          stream: () =>
            Stream.suspend((): Stream.Stream<ModelEvent.ModelEvent, ModelError> => {
              calls++
              return calls === 1
                ? Stream.concat(
                  Stream.make(ModelEvent.ModelEvent.Usage({ totalTokens: 300 })),
                  Stream.fail(new ModelError({ code: "rate_limited", message: "capacity" }))
                )
                : Stream.make(
                  ModelEvent.ModelEvent.Usage({ totalTokens: 400 }),
                  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
                )
            })
        })
        const invoke = Effect.gen(function*() {
          const engine = yield* FlowEngineLike.make({ model, route: staticRoute() }).pipe(
            Effect.provideService(Budget.Budget, budget)
          )
          return yield* Stream.runCollect(engine.sealStep(step("retry")))
        })
        // A retry is a new engine attempt; simply re-reading attempt 1 correctly
        // replays its failure. Keep the model's sealed content key unchanged.
        yield* invoke.pipe(Action.retry({ times: 1 }))
        yield* invoke.pipe(Effect.provideService(Action.CurrentAttempt, 2))
        const fresh = yield* Budget.make({})
        return { live: yield* budget.usage, fresh: yield* fresh.usage }
      }).pipe(Effect.provide(TestJournal.layer()))
    )
    expect(completed(outcome)).toEqual({
      live: { tokens: 700, calls: 2, largestCall: 400 },
      fresh: { tokens: 700, calls: 2, largestCall: 400 }
    })
    expect(calls).toBe(2)
  })

  it("flushes reported spend when a stream is interrupted before it can seal", async () => {
    const outcome = await drive(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 1_000 } })
        const reported = yield* Deferred.make<void>()
        const model = Model.make({
          stream: () =>
            Stream.concat(
              Stream.make(ModelEvent.ModelEvent.Usage({ totalTokens: 600 })),
              Stream.fromEffect(Effect.andThen(Deferred.succeed(reported, undefined), Effect.never))
            )
        })
        const engine = yield* FlowEngineLike.make({ model, route: staticRoute() }).pipe(
          Effect.provideService(Budget.Budget, budget)
        )
        const running = yield* Stream.runCollect(engine.sealStep(step("interrupted"))).pipe(Effect.forkChild)
        yield* Deferred.await(reported)
        yield* Fiber.interrupt(running)
        const fresh = yield* Budget.make({ tokens: { max: 1_000 } })
        return {
          live: yield* budget.usage,
          fresh: yield* fresh.usage,
          next: (yield* Effect.scoped(fresh.reserve("new-call")))._tag
        }
      }).pipe(Effect.provide(TestJournal.layer()))
    )
    expect(completed(outcome)).toEqual({
      live: { tokens: 600, calls: 1, largestCall: 600 },
      fresh: { tokens: 600, calls: 1, largestCall: 600 },
      next: "refuse"
    })
  })

  it("fails before dispatch if a usage receipt cannot be allocated", async () => {
    const calls: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const engine = yield* FlowEngineLike.make({ model: countingModel(calls), route: staticRoute() }).pipe(
        Effect.provideService(Crypto.Crypto, {
          ...crypto,
          randomUUIDv4: Effect.fail(PlatformError.systemError({
            module: "Crypto",
            method: "randomUUIDv4",
            _tag: "Unknown",
            description: "injected entropy failure"
          }))
        })
      )
      return yield* Stream.runCollect(engine.sealStep(step("no-identity")))
    }))
    expect(failure(outcome)).toMatchObject({
      code: "engine_failed",
      message: "Could not allocate a model usage receipt"
    })
    expect(calls).toEqual([])
  })

  it("retains reported spend from earlier attempts when interrupted during retry backoff", async () => {
    const outcome = await drive(
      Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 1_000 } })
        const waiting = yield* Deferred.make<void>()
        const model = Model.make({
          stream: () =>
            Stream.concat(
              Stream.make(
                ModelEvent.ModelEvent.Usage({ inputTokens: 200 }),
                ModelEvent.ModelEvent.Usage({ totalTokens: 300 })
              ),
              Stream.fail(new ModelError({ code: "transport", message: "partial response" }))
            )
        })
        const engine = yield* FlowEngineLike.make({
          model,
          route: staticRoute(),
          modelRetryPolicy: Schedule.spaced("1 hour").pipe(Schedule.tap(() => Deferred.succeed(waiting, undefined)))
        }).pipe(Effect.provideService(Budget.Budget, budget))
        const running = yield* Stream.runCollect(engine.sealStep(step("backoff"))).pipe(Effect.forkChild)
        yield* Deferred.await(waiting)
        yield* Fiber.interrupt(running)
        const fresh = yield* Budget.make({})
        return { live: yield* budget.usage, fresh: yield* fresh.usage }
      }).pipe(Effect.provide(TestJournal.layer()))
    )
    expect(completed(outcome)).toEqual({
      live: { tokens: 300, calls: 1, largestCall: 300 },
      fresh: { tokens: 300, calls: 1, largestCall: 300 }
    })
  })

  it("measures the workspace through the composition's observer, and reports it unobserved without one", async () => {
    const measurement = new EngineLike.Observation({ digest: "tree-1", paths: 3 })
    const outcome = await drive(Effect.gen(function*() {
      const equipped = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: staticRoute()
      }).pipe(
        Effect.provideService(WorkspaceObservation.Observer, {
          observe: Effect.as(Effect.sleep("40 millis"), measurement)
        })
      )
      const bare = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
      return { equipped: yield* equipped.observe, bare: yield* bare.observe }
    }))

    // A composition either equips its runs with a way to measure their
    // workspace or it does not. The second answer is `None` and not an empty
    // tree, because the controller must be able to tell "nothing changed" from
    // "nobody looked" — the first drives the read-only cap and the second
    // leaves it on declared writes.
    const { equipped, bare } = completed(outcome) as {
      equipped: Option.Option<EngineLike.Observation>
      bare: Option.Option<EngineLike.Observation>
    }
    expect(bare).toEqual(Option.none())
    const observed = Option.getOrThrow(equipped)
    expect({ digest: observed.digest, paths: observed.paths, complete: observed.complete }).toEqual({
      digest: "tree-1",
      paths: 3,
      complete: true
    })
    // The measurement carries what it cost, so a slow frame is attributable.
    expect(Number.isInteger(observed.elapsedMs)).toBe(true)
    expect(observed.elapsedMs).toBeGreaterThanOrEqual(35)
  })

  it("pins through the composition's store, and reports it unpinnable without one", async () => {
    const outcome = await drive(Effect.gen(function*() {
      const equipped = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: staticRoute()
      }).pipe(
        Effect.provideService(
          Checkpoints.Checkpoints,
          Checkpoints.make({
            capture: (id) => Effect.succeed(new Checkpoints.Snapshot({ id, ref: `refs/flows/checkpoints/${id}` })),
            materialize: (_id, use) => use({ id: "x", host: "/h/x", guest: "/g/x", root: "/h", guestRoot: "/g" })
          })
        )
      )
      const bare = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
      const request = { id: "cp-0-0", identity: { session: "s", frame: 0, boundary: "cell" } } as const
      return { equipped: yield* equipped.capture(request), bare: yield* bare.capture(request) }
    }))

    // The same shape `observe` takes, and for the same reason: a composition
    // either equips its runs with somewhere to pin a tree or it does not, and
    // "nowhere to pin" is a catchable refusal the cell routes around rather
    // than a failed run.
    expect(completed(outcome)).toEqual({
      equipped: Option.some(new EngineLike.Snapshot({ id: "cp-0-0", ref: "refs/flows/checkpoints/cp-0-0" })),
      bare: Option.none()
    })
  })

  it("reports a store that failed as nothing pinned, and says why in the log", async () => {
    const logs: Array<{ message: unknown; annotations: Readonly<Record<string, unknown>>; cause: string }> = []
    const capture = Logger.make((entry) => {
      logs.push({
        message: entry.message,
        annotations: entry.fiber.getRef(References.CurrentLogAnnotations),
        cause: String(entry.cause)
      })
    })
    const outcome = await drive(
      Effect.gen(function*() {
        const engine = yield* FlowEngineLike.make({
          model: countingModel([]),
          route: staticRoute()
        }).pipe(
          Effect.provideService(
            Checkpoints.Checkpoints,
            Checkpoints.make({
              capture: () =>
                Effect.fail(new StdError.StdError({ code: "command_failed", message: "git could not run" })),
              materialize: () => Effect.fail(new StdError.StdError({ code: "not_found", message: "no such ref" }))
            })
          )
        )
        return yield* engine.capture({ id: "cp-0-0", identity: { session: "s", frame: 0, boundary: "cell" } })
      }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })))
    )

    // The cell is told nothing was pinned, which is what happened and what it
    // can act on. The reason is not thrown away — it is logged, so a run whose
    // checkpoints never work says why rather than only stopping.
    expect(completed(outcome)).toEqual(Option.none())
    expect(logs).toHaveLength(1)
    expect(String(logs[0]!.message)).toContain("A checkpoint could not be pinned")
    expect(logs[0]!.annotations).toMatchObject({ checkpoint: "cp-0-0" })
    expect(logs[0]!.cause).toContain("StdError")
    expect(logs[0]!.cause).toContain("git could not run")
  })

  it("seals a 1 MiB wire body without numeric-array key material, even before budget refusal", async () => {
    const derive = vi.spyOn(StepKey, "fromKeyMaterial")
    const calls: Array<string> = []
    try {
      const outcome = await drive(Effect.gen(function*() {
        const budget = yield* Budget.make({ tokens: { max: 0 } })
        const port = yield* FlowEngineLike.make({
          model: countingModel(calls),
          route: staticRoute("large-wire", "x".repeat(1024 * 1024))
        }).pipe(Effect.provideService(Budget.Budget, budget))
        return yield* Stream.runCollect(port.sealStep(step("small declaration")))
      }))
      expect(outcome._tag).toBe("failed")
      expect(calls).toEqual([])
      expect(derive).toHaveBeenCalled()
      for (const [material] of derive.mock.calls) {
        expect(JSON.stringify(material).length).toBeLessThan(4096)
      }
    } finally {
      derive.mockRestore()
    }
  })

  it.each([
    new Uint8Array(),
    Uint8Array.from({ length: 256 }, (_, index) => index),
    new Uint8Array([99, 0, 127, 255, 88]).subarray(1, 4)
  ])("preserves historical key bytes for wire body %j, including marker collisions", async (body) => {
    const keys: Array<string> = []
    const declared = step("historical", {
      body: { nested: ["flows/agent/wire-body/0", "flows/agent/wire-body/1"], escaped: "\"flows/agent/wire-body/2\"" }
    })
    const prepared = { ...preparedFor("historical", "not the wire bytes"), body }
    const outcome = await drive(Effect.gen(function*() {
      // Independent legacy derivation, including its numeric array. The
      // reservation sees the actual key passed to the durable activity.
      const expected = yield* StepKey.fromKeyMaterial({
        ...declared.keyMaterial,
        body: {
          _tag: "PreparedModelCall",
          declaration: declared.keyMaterial.body,
          request: {
            routeId: prepared.routeId,
            protocolId: prepared.protocolId,
            method: prepared.method,
            url: prepared.url,
            publicHeaders: prepared.publicHeaders,
            body: Array.from(body)
          }
        }
      }, {})
      const port = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: { prepare: () => Effect.succeed(prepared) }
      }).pipe(Effect.provideService(Budget.Budget, {
        ...Budget.makeUnbounded(),
        reserve: (key) =>
          Effect.sync(() => {
            keys.push(key)
            return { _tag: "proceed" } as const
          })
      }))
      yield* Stream.runDrain(port.sealStep(declared))
      yield* Stream.runDrain(port.sealStep(declared))
      return expected
    }))
    expect(keys).toEqual([completed(outcome), completed(outcome)])
  })

  it("derives a different sealed key when the prepared wire request changes", async () => {
    const calls: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const first = yield* FlowEngineLike.make({
        model: countingModel(calls),
        route: staticRoute("route-a")
      })
      const second = yield* FlowEngineLike.make({
        model: countingModel(calls),
        route: staticRoute("route-b")
      })
      yield* Stream.runCollect(first.sealStep(step("hello")))
      yield* Stream.runCollect(second.sealStep(step("hello")))
      return calls.length
    }))

    expect(completed(outcome)).toBe(2)
  })

  it.each(
    [
      ["transport", "connection reset"],
      ["provider_internal", "provider overloaded"]
    ] as const
  )("retries one transient %s model failure inside the sealed step", async (code, message) => {
    let attempts = 0
    const transient = new ModelError({ code, message })
    const model = Model.make({
      stream: () =>
        Stream.suspend(() => {
          attempts++
          return attempts === 1
            ? Stream.fail(transient)
            : Stream.fromIterable([
              ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "0" }),
              ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "0", text: "reply" }),
              ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
            ])
        })
    })
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model,
        route: staticRoute(),
        modelRetryPolicy: Schedule.recurs(2)
      })
      return Array.from(yield* Stream.runCollect(engine.sealStep(step("hello"))))
    }))

    expect(completed(outcome)).toMatchObject([
      { type: "retry", attempt: 1, code },
      { type: "text-start" },
      { type: "text-delta" },
      { type: "settle" }
    ])
    expect(attempts).toBe(2)
  })

  it.each(["invalid_provider_output", "quota_exceeded"] as const)(
    "does not retry terminal %s failures",
    async (code) => {
      let attempts = 0
      const original = new ModelError({ code, message: `terminal ${code}` })
      const outcome = await drive(Effect.gen(function*() {
        const engine = yield* FlowEngineLike.make({
          model: Model.make({
            stream: () =>
              Stream.suspend(() => {
                attempts++
                return Stream.fail(original)
              })
          }),
          route: staticRoute(),
          modelRetryPolicy: Schedule.recurs(2)
        })
        return yield* Stream.runCollect(engine.sealStep(step(code)))
      }))
      expect(failure(outcome)).toStrictEqual(original)
      expect(attempts).toBe(1)
    }
  )

  it("lets an explicit classifier add a non-capacity refusal to parking policy", async () => {
    const original = new ModelError({ code: "invalid_provider_output", message: "provider-specific wait" })
    const quota = QuotaPolicy.make({
      classify: () => Option.some({ wakeAt: 1, source: "default" })
    })
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: Model.make({ stream: () => Stream.fail(original) }),
        route: staticRoute(),
        modelRetryPolicy: Schedule.recurs(0)
      }).pipe(Effect.provideService(QuotaPolicy.QuotaClassifier, quota))
      return yield* Stream.runCollect(engine.sealStep(step("provider-specific wait")))
    }))

    expect(failure(outcome)).toStrictEqual(original)
  })

  it("surfaces the original typed transport error after bounded retries are exhausted", async () => {
    let attempts = 0
    const original = new ModelError({ code: "transport", message: "destroyed HTTP/2 session" })
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: Model.make({
          stream: () =>
            Stream.suspend(() => {
              attempts++
              return Stream.fail(original)
            })
        }),
        route: staticRoute(),
        modelRetryPolicy: Schedule.recurs(2)
      })
      return yield* Stream.runCollect(engine.sealStep(step("exhausted")))
    }))
    expect(failure(outcome)).toStrictEqual(original)
    expect(attempts).toBe(3)
  })

  it("retries a body that dies after the headers, and keeps the frame the socket would have ended", async () => {
    // The r91 wave lost two instances outright to one dropped HTTP/2 session on
    // `POST /v1/responses`. This is the half of that class no classification
    // ever saw: a response whose body stops arriving mid-stream *succeeds* at
    // `Stream.runCollect` — the deltas that did arrive are returned, and only
    // the settlement is missing. Nothing failed, so nothing was retried, and
    // the controller then raised `model_failed` and ended the run.
    //
    // The scripted abort is the shape a real one takes: some text, then the end
    // of the stream, with no settle event behind it.
    let attempts = 0
    const model = Model.make({
      stream: () =>
        Stream.suspend(() => {
          attempts++
          const partial = [
            ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "0" }),
            ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "0", text: "const found = await" })
          ]
          return attempts === 1
            ? Stream.fromIterable(partial)
            : Stream.fromIterable([...partial, ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })])
        })
    })
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model,
        route: staticRoute(),
        modelRetryPolicy: Schedule.recurs(2)
      })
      return Array.from(yield* Stream.runCollect(engine.sealStep(step("hello"))))
    }))

    // The abort is journaled as the transport failure it is, and the frame the
    // socket would have ended settles on the attempt after it.
    expect(completed(outcome)).toMatchObject([
      { type: "retry", attempt: 1, code: "transport" },
      { type: "text-start" },
      { type: "text-delta" },
      { type: "settle" }
    ])
    expect(attempts).toBe(2)
  })

  it("surfaces an unsettled stream as a transport failure once the ladder is spent", async () => {
    // Exhaustion is still exhaustion — but it arrives as a typed `transport`
    // error the caller can branch on, rather than as the harness's own
    // "ended without a recorded settlement", which is terminal for the run.
    let attempts = 0
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: Model.make({
          stream: () =>
            Stream.suspend(() => {
              attempts++
              return Stream.fromIterable([ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "0" })])
            })
        }),
        route: staticRoute(),
        modelRetryPolicy: Schedule.recurs(2)
      })
      return yield* Stream.runCollect(engine.sealStep(step("aborted")))
    }))
    expect(failure(outcome)).toMatchObject({
      code: "transport",
      message: "The model response stream ended without a settlement"
    })
    expect(attempts).toBe(3)
  })

  it("surfaces an authentication failure without retrying or replacing it", async () => {
    let attempts = 0
    const authentication = new ModelError({ code: "authentication", message: "invalid API key" })
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: Model.make({
          stream: () =>
            Stream.suspend(() => {
              attempts++
              return Stream.fail(authentication)
            })
        }),
        route: staticRoute()
      })
      return yield* Stream.runCollect(engine.sealStep(step("hello")))
    }))

    const error = failure(outcome)
    expect(error).toBeInstanceOf(ModelError)
    expect(error).toStrictEqual(authentication)
    expect(attempts).toBe(1)
  })

  it("surfaces a route failure before the activity is dispatched", async () => {
    const calls: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: countingModel(calls),
        route: failingRoute
      })
      return yield* Stream.runCollect(engine.sealStep(step("hello")))
    }))

    expect(failure(outcome)).toMatchObject({ code: "invalid_request" })
    expect(calls).toEqual([])
  })

  it("reports unsealable key material as a typed harness failure", async () => {
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: staticRoute()
      })
      return yield* Stream.runCollect(engine.sealStep(step("hello", { kind: "irreversible" })))
    }))

    expect(failure(outcome)).toMatchObject({
      _tag: "/harness/HarnessError",
      code: "engine_failed",
      message: "The prepared model request could not be sealed"
    })
  })

  it("seals a declaration that is not a model call", async () => {
    const calls: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: countingModel(calls),
        route: staticRoute()
      })
      const events = yield* Stream.runCollect(
        engine.sealStep(step("hello", { body: { _tag: "Opaque", note: "no request" } }))
      )
      return events.length
    }))

    expect(completed(outcome)).toBe(3)
    expect(calls).toEqual(["test-model"])
  })

  it("seals a request whose optional parameters are explicitly undefined", async () => {
    // Canonical serialization rejects `undefined` outright, so an optional
    // parameter the harness left present-but-undefined has to be dropped
    // before the declaration is hashed.
    const sparse = ModelRequest.ModelRequest.make({
      modelId: "test-model",
      system: [],
      messages: [ModelRequest.Message.user("hello")],
      tools: [],
      params: ModelRequest.GenerationParams.make({ maxTokens: undefined, temperature: 0.5 })
    })
    const calls: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: countingModel(calls),
        route: staticRoute()
      })
      const events = yield* Stream.runCollect(engine.sealStep({
        request: sparse,
        keyMaterial: { ...step("hello").keyMaterial, body: { _tag: "ModelCall", request: sparse } }
      }))
      return events.length
    }))

    expect(completed(outcome)).toBe(3)
  })

  it("refuses an elaborated child because the superseded path has no runner", async () => {
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: staticRoute()
      })
      return yield* Stream.runCollect(engine.splice(
        new Plan.Batch({ children: [child("review/unsupported")] })
      ))
    }))

    const error = failure(outcome)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({
      code: "engine_failed",
      message: "No child runner is configured",
      cause: "review/unsupported"
    })
  })

  it("produces no events and no failure for an empty elaborated batch", async () => {
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: staticRoute()
      })
      return Array.from(yield* Stream.runCollect(engine.splice(new Plan.Batch({ children: [] }))))
    }))

    expect(completed(outcome)).toEqual([])
  })

  it("suspends the execution durably instead of failing", async () => {
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: staticRoute()
      })
      return yield* engine.suspend(
        new EngineLike.SuspendReason({ code: "waiting-input", message: "needs an answer" })
      )
    }))

    expect(outcome._tag).toBe("suspended")
  })

  it("resumes a suspended execution and replays the sealed step it already recorded", async () => {
    const calls: Array<string> = []
    let park = true
    const outcome = await drive(
      Effect.gen(function*() {
        const engine = yield* FlowEngineLike.make({
          model: countingModel(calls),
          route: staticRoute()
        })
        const events = yield* Stream.runCollect(engine.sealStep(step("hello")))
        if (park) {
          park = false
          yield* engine.suspend(new EngineLike.SuspendReason({ code: "engine", message: "park" }))
        }
        return events.length
      }),
      { resume: true }
    )

    expect(completed(outcome)).toBe(3)
    // The provider was called once; the resumed attempt replayed the record.
    expect(calls).toEqual(["test-model"])
  })
})

describe("FlowEngineLike.layer", () => {
  it("provides the harness engine port", async () => {
    const outcome = await drive(
      Effect.gen(function*() {
        const engine = yield* EngineLike.EngineLike
        return typeof engine.sealStep
      }).pipe(
        Effect.provide(
          FlowEngineLike.layer({
            model: countingModel([]),
            route: staticRoute()
          })
        )
      )
    )

    expect(completed(outcome)).toBe("function")
  })
})

/**
 * Runs two bodies as two distinct executions of one flow, on one engine.
 *
 * Sharing the engine is the whole point: two executions with separate journals
 * could never alias, so the aliasing question only has meaning when both write
 * to the same store.
 */
const driveBoth = <A, E>(
  first: Effect.Effect<A, E, PortServices>,
  second: Effect.Effect<A, E, PortServices>
): Promise<ReadonlyArray<Outcome>> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const bodies = [first, second]
    let index = 0
    const settled = [Deferred.makeUnsafe<Outcome>(), Deferred.makeUnsafe<Outcome>()]
    const flow = Flow.make("agent/test/two-runs", {
      payload: {},
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: () => Node.succeed(undefined)
    })
    yield* engine.register(flow, () => {
      const slot = index++
      return Effect.onExit(
        bodies[slot]!,
        (exit) => Effect.asVoid(Deferred.succeed(settled[slot]!, classify(exit)))
      )
    }).pipe(Scope.provide(scope))
    yield* engine.execute(flow, { executionId: "run-a", payload: {}, discard: true })
    const a = yield* Deferred.await(settled[0]!)
    yield* engine.execute(flow, { executionId: "run-b", payload: {}, discard: true })
    const b = yield* Deferred.await(settled[1]!)
    return [a, b]
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FlowEngine.layerMemory,
        NodeCrypto.layer,
        Budget.layerUnbounded(),
        QuotaPolicy.layerUnclassified()
      )
    ),
    Effect.scoped,
    Effect.runPromise
  )

describe("FlowEngineLike.record", () => {
  it("journals a controller boundary once and replays the recorded value after a park", async () => {
    const drains: Array<string> = []
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
        // Sessionless identity, the legacy loop's shape: the boundary label
        // and frame are the whole controller-supplied identity.
        yield* port.record({
          name: "steering-drain",
          identity: { frame: 0, boundary: "context-digest" },
          success: Schema.Struct({ inserts: Schema.Array(Schema.String) }),
          execute: Effect.sync(() => {
            drains.push("drain")
            return { inserts: ["steer: keep it short"] }
          })
        })
        return yield* port.suspend(new EngineLike.SuspendReason({ code: "waiting-input", message: "park" }))
      }),
      { resume: true }
    )

    // The body parks every attempt; what matters is that the resumed attempt
    // re-executed it and the drain did not run a second time.
    expect(outcome._tag).toBe("suspended")
    expect(drains).toEqual(["drain"])
  })

  it("hands a resumed frame the tree it pinned, not the one now standing", async () => {
    // The kill-and-restore question, asked of the thing a checkpoint is: a
    // handle names a tree, so a run that parks holding one and comes back must
    // be handed that tree and not whatever the workspace has become. The store
    // below records a different ref every time it is asked, so a second capture
    // is visible in the answer rather than merely counted.
    const pinned: Array<string> = []
    let park = true
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() }).pipe(
          Effect.provideService(
            Checkpoints.Checkpoints,
            Checkpoints.make({
              capture: (id) =>
                Effect.sync(() => {
                  pinned.push(id)
                  return new Checkpoints.Snapshot({ id, ref: `tree-${pinned.length}` })
                }),
              materialize: (id, use) => use({ id, host: `/h/${id}`, guest: `/h/${id}`, root: "/h", guestRoot: "/h" })
            })
          )
        )
        // Exactly what `CellTurn.pin` builds: the mint rides a journaled
        // boundary keyed on the cell digest and the ordinal, which is the pair
        // a re-executed cell re-derives.
        const held = yield* port.record({
          name: "checkpoint",
          identity: { session: "session-1", frame: 0, boundary: "cell-digest:0" },
          success: Schema.Option(EngineLike.Snapshot),
          execute: port.capture({
            id: "cp-0-0",
            identity: { session: "session-1", frame: 0, boundary: "cell-digest" }
          })
        })
        if (park) {
          park = false
          yield* port.suspend(new EngineLike.SuspendReason({ code: "engine", message: "killed" }))
        }
        return held
      }),
      { resume: true }
    )

    // One capture, and the resumed attempt is served the tree the first one
    // pinned. Without the journaled boundary the second attempt would pin the
    // workspace as it stands now and the handle would silently change meaning.
    expect(pinned).toEqual(["cp-0-0"])
    expect(completed(outcome)).toEqual(Option.some(new EngineLike.Snapshot({ id: "cp-0-0", ref: "tree-1" })))
  })

  it("charges what a boundary's record says it paid once, across a park and its replay (#2681)", async () => {
    const readings: Array<string> = []
    let park = true
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
        const judged = Schema.Struct({
          usage: Schema.NullOr(Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number }))
        })
        const paying = (
          boundary: string,
          usage: { readonly inputTokens: number; readonly outputTokens: number } | null
        ) =>
          port.record({
            name: "completion-judgement",
            identity: { session: "session-1", frame: 0, boundary },
            success: judged,
            usage: (value) => value.usage === null ? undefined : [{ usage: value.usage }],
            execute: Effect.sync(() => {
              readings.push(boundary)
              return { usage }
            })
          })
        yield* paying("metered", { inputTokens: 90, outputTokens: 10 })
        yield* paying("unmetered", null)
        if (park) {
          park = false
          yield* port.suspend(new EngineLike.SuspendReason({ code: "engine", message: "killed" }))
        }
        const budget = yield* Budget.Budget
        return yield* budget.usage
      }).pipe(Effect.provide(Budget.layer({ tokens: { max: 1_000 } }))),
      { resume: true }
    )

    // Each reading ran once; the replay was served the record and charged
    // nothing more for it.
    expect(readings).toEqual(["metered", "unmetered"])
    expect((completed(outcome) as Budget.Usage).tokens).toBe(100)
  })

  /** A paid boundary whose record says it paid `shares`, and which logs each live reading. */
  const payingBoundary = (
    port: EngineLike.EngineLike,
    readings: Array<string>,
    boundary: string,
    shares: ReadonlyArray<EngineLike.Paid>
  ) =>
    port.record({
      name: "completion-judgement",
      identity: { session: "session-1", frame: 0, boundary },
      success: Schema.Struct({ paid: Schema.Number }),
      usage: () => shares,
      execute: Effect.sync(() => {
        readings.push(boundary)
        return { paid: shares.length }
      })
    })

  it("prices each model's share of a boundary under its own id (#3010)", async () => {
    const entries: Array<Budget.LedgerEntry> = []
    const ledger = Budget.memoryLedger()
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
        yield* payingBoundary(port, [], "two-judges", [
          { usage: { inputTokens: 900_000, outputTokens: 100_000 }, modelId: "judge-a" },
          { usage: { inputTokens: 5, outputTokens: 1 } }
        ])
        return yield* (yield* Budget.Budget).usage
      }).pipe(Effect.provide(Budget.layer(
        { tokens: { max: 10_000_000 }, prices: { "judge-a": { input: 2, cacheRead: 0, cacheWrite: 0, output: 10 } } },
        {
          ledger: {
            ...ledger,
            record: (entry) => Effect.andThen(Effect.sync(() => void entries.push(entry)), ledger.record(entry))
          }
        }
      )))
    )
    expect(completed(outcome)).toMatchObject({ tokens: 1_000_006, calls: 2 })
    expect(entries).toHaveLength(2)
    const [priced, unpriced] = entries
    // $2 per million input tokens and $10 per million output tokens.
    expect(priced).toMatchObject({ spent: 1_000_000, costSource: "estimated" })
    expect(priced!.costUsd).toBeCloseTo(2.8)
    expect(unpriced).toMatchObject({ spent: 6, stepKey: `${priced!.stepKey}#1` })
    expect(unpriced!.costUsd).toBeUndefined()
  })

  it("takes a paid reading while any allowance is left, though a primary call would be refused (#3010)", async () => {
    const readings: Array<string> = []
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
        const budget = yield* Budget.Budget
        yield* payingBoundary(port, readings, "first", [{ usage: { inputTokens: 60, outputTokens: 0 } }])
        // A primary call is projected at the largest call so far: 60 + 60 > 100.
        expect((yield* budget.check(undefined))._tag).toBe("refuse")
        yield* payingBoundary(port, readings, "second", [{ usage: { inputTokens: 30, outputTokens: 0 } }])
        return yield* budget.usage
      }).pipe(Effect.provide(Budget.layer({ tokens: { max: 100 } })))
    )
    expect(readings).toEqual(["first", "second"])
    expect(completed(outcome)).toMatchObject({ tokens: 90 })
  })

  it.each(
    [
      ["fail", Budget.BudgetExceeded],
      ["skip-remaining", Budget.Skipped]
    ] as const
  )(
    "refuses a paid reading under %s once the ceiling is spent, without taking it (#3010)",
    async (onExceeded, refusal) => {
      const readings: Array<string> = []
      const outcome = await drive(
        Effect.gen(function*() {
          const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
          yield* payingBoundary(port, readings, "spends-it", [{ usage: { inputTokens: 100, outputTokens: 0 } }])
          // A boundary that declares no usage pays for nothing and is never gated.
          yield* port.record({
            name: "steering-drain",
            identity: { session: "session-1", frame: 0, boundary: "free" },
            success: Schema.Null,
            execute: Effect.sync(() => {
              readings.push("free")
              return null
            })
          })
          const refused = yield* Effect.flip(
            payingBoundary(port, readings, "over", [{ usage: { inputTokens: 1, outputTokens: 0 } }])
          )
          return { refused, usage: yield* (yield* Budget.Budget).usage }
        }).pipe(Effect.provide(Budget.layer({ tokens: { max: 100, onExceeded } })))
      )
      const { refused, usage } = completed(outcome) as { refused: HarnessError; usage: Budget.Usage }
      expect(readings).toEqual(["spends-it", "free"])
      expect(refused).toBeInstanceOf(HarnessError)
      expect(refused.code).toBe("model_failed")
      expect(refused.cause).toBeInstanceOf(refusal)
      expect(usage.tokens).toBe(100)
    }
  )

  it("charges what a paid boundary's typed evaluator failure paid, once across its replay (#3010)", async () => {
    const readings: Array<string> = []
    const entries: Array<Budget.LedgerEntry> = []
    const ledger = Budget.memoryLedger()
    let park = true
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
        const unjudged = (boundary: string, usage: Evaluator.EvaluatorError["usage"], paid: boolean) =>
          port.record({
            name: "completion-judgement",
            identity: { session: "session-1", frame: 0, boundary },
            success: Schema.Null,
            ...(paid ? { usage: () => undefined } : {}),
            execute: Effect.suspend(() => {
              readings.push(boundary)
              return Effect.fail(
                new HarnessError({
                  code: "completion_unjudged",
                  message: "unjudged",
                  cause: new Evaluator.EvaluatorError({
                    code: "invalid_answer",
                    message: "bad",
                    ...(usage === undefined ? {} : { usage })
                  })
                })
              )
            })
          }).pipe(Effect.flip)
        yield* unjudged("metered", { inputTokens: 40, outputTokens: 2, modelId: "judge-a" }, true)
        yield* unjudged("unmetered", undefined, true)
        // A boundary that declares no usage pays for nothing, whatever it failed with.
        yield* unjudged("unpaid", { inputTokens: 1_000, outputTokens: 0 }, false)
        if (park) {
          park = false
          yield* port.suspend(new EngineLike.SuspendReason({ code: "engine", message: "killed" }))
        }
        return yield* (yield* Budget.Budget).usage
      }).pipe(Effect.provide(Budget.layer(
        { tokens: { max: 10_000 }, prices: { "judge-a": { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } } },
        {
          ledger: {
            ...ledger,
            record: (entry) => Effect.andThen(Effect.sync(() => void entries.push(entry)), ledger.record(entry))
          }
        }
      ))),
      { resume: true }
    )
    expect(readings).toEqual(["metered", "unmetered", "unpaid"])
    expect(completed(outcome)).toMatchObject({ tokens: 42, calls: 1 })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ spent: 42, costSource: "estimated" })
  })

  it("charges an advisory reading past a spent ceiling without admitting it (#3010)", async () => {
    const readings: Array<string> = []
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
        yield* payingBoundary(port, readings, "spends-it", [{ usage: { inputTokens: 100, outputTokens: 0 } }])
        yield* port.record({
          name: "supervisor",
          identity: { session: "session-1", frame: 0, boundary: "background" },
          success: Schema.Null,
          advisory: true,
          usage: () => [{ usage: { inputTokens: 7, outputTokens: 0 } }],
          execute: Effect.sync(() => {
            readings.push("background")
            return null
          })
        })
        return yield* (yield* Budget.Budget).usage
      }).pipe(Effect.provide(Budget.layer({ tokens: { max: 100, onExceeded: "park" } })))
    )
    expect(readings).toEqual(["spends-it", "background"])
    expect(completed(outcome)).toMatchObject({ tokens: 107 })
  })

  it("parks a paid reading refused by a spent park budget, and declares the wait on suspend (#3010)", async () => {
    const readings: Array<string> = []
    const exceeded: Array<Budget.BudgetExceeded> = []
    const parkedOn: Budget.Parked = {
      waiting: { reason: "budget", token: "budget/run-1/tokens" },
      failure: new HarnessError({ code: "engine_failed", message: "Budget approval required" })
    }
    let declared: FlowRuntime.WaitingAnnotation | undefined
    const outcome = await drive(
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
        yield* payingBoundary(port, readings, "spends-it", [{ usage: { inputTokens: 100, outputTokens: 0 } }])
        const refused = yield* Effect.flip(
          payingBoundary(port, readings, "over", [{ usage: { inputTokens: 1, outputTokens: 0 } }])
        )
        expect(refused).toBe(parkedOn.failure)
        return yield* port.suspend(new EngineLike.SuspendReason({ code: "engine", message: "parked" })).pipe(
          Effect.ensuring(Effect.sync(() => {
            declared = instance.waiting
          }))
        )
      }).pipe(
        Effect.provide(Budget.layer({ tokens: { max: 100, onExceeded: "park" } })),
        Effect.provideService(Budget.Parking, {
          guardsTimeouts: false,
          park: (failure) =>
            Effect.sync(() => {
              exceeded.push(failure)
              return parkedOn
            }),
          trip: () => Effect.die("no timeout trips here"),
          admit: () => Effect.succeed({ _tag: "proceed" as const, continued: 0 })
        })
      )
    )
    expect(outcome._tag).toBe("suspended")
    expect(readings).toEqual(["spends-it"])
    expect(exceeded).toMatchObject([{ scope: "tokens", used: 100, max: 100, next: 0 }])
    expect(declared).toEqual(parkedOn.waiting)
  })

  it("replays a reading the ledger already charged past a spent ceiling (#3010)", async () => {
    const readings: Array<string> = []
    // The resumed attempt builds a fresh budget, which recovers the spend.
    const ledger = Budget.memoryLedger()
    let park = true
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
        yield* payingBoundary(port, readings, "spends-it", [{ usage: { inputTokens: 100, outputTokens: 0 } }])
        if (park) {
          park = false
          yield* port.suspend(new EngineLike.SuspendReason({ code: "engine", message: "killed" }))
        }
        const refused = yield* Effect.flip(
          payingBoundary(port, readings, "over", [{ usage: { inputTokens: 1, outputTokens: 0 } }])
        )
        return { refused, usage: yield* (yield* Budget.Budget).usage }
      }).pipe(Effect.provide(Budget.layer({ tokens: { max: 100 } }, { ledger }))),
      { resume: true }
    )
    const { refused, usage } = completed(outcome) as { refused: HarnessError; usage: Budget.Usage }
    // The charged reading replayed without asking again; the next one was refused.
    expect(readings).toEqual(["spends-it"])
    expect(refused.cause).toBeInstanceOf(Budget.BudgetExceeded)
    expect(usage).toMatchObject({ tokens: 100, calls: 1 })
  })

  it("reports a boundary whose identity has no canonical form as a typed harness failure", async () => {
    const drains: Array<string> = []
    // A lone surrogate has no UTF-8 encoding, so the boundary identity has no
    // canonical serialization and therefore no key. The controller supplies
    // these names, so the refusal has to be a typed harness failure rather
    // than a defect thrown out of the port.
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
        return yield* port.record({
          name: "steering-\uD800",
          identity: { frame: 0, boundary: "context-digest", session: "session-1" },
          success: Schema.Struct({ inserts: Schema.Array(Schema.String) }),
          execute: Effect.sync(() => {
            drains.push("drain")
            return { inserts: [] }
          })
        })
      })
    )

    expect(failure(outcome)).toMatchObject({
      code: "engine_failed",
      message: "Boundary steering-\uD800 could not be keyed"
    })
    // The boundary never opened, so its read never ran.
    expect(drains).toEqual([])
  })
})

describe("cell call identity across runs", () => {
  /** Byte-for-byte the same irreversible call in both runs: one shared session, one cell, one ordinal. */
  const sharedCellCall = (tier: "sealed" | "irreversible"): Cell.Call =>
    new Cell.Call({
      flowName: "fs/write",
      input: { path: "out.txt", text: "done" },
      capabilities: [],
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier },
      placement: Option.none(),
      identity: new Cell.CallIdentity({
        session: "shared-session",
        frame: 0,
        cell: "cell-digest",
        ordinal: 0,
        declaration: "declaration-digest",
        layers: []
      })
    })

  const countingCalls = (executed: Array<string>): FlowEngineLike.CallRunner => ({
    run: (call) =>
      Effect.sync(() => {
        executed.push(`${call.flowName}#${call.identity.ordinal}`)
        return new Cell.CallResult({ outcome: "success", value: executed.length })
      })
  })

  it("includes the live tree epoch in a sealed call's cache material", () => {
    const initial = sharedCellCall("sealed")
    const afterWrite = new Cell.Call({ ...initial, epoch: { frames: 1, calls: 0 } })

    expect(FlowEngineLike.callMaterial(initial).body).not.toHaveProperty("epoch")
    expect(FlowEngineLike.callMaterial(afterWrite).body).toMatchObject({ epoch: { frames: 1, calls: 0 } })
  })

  it("annotates only authorized calls and their exact delivered record, without changing the action key", async () => {
    const annotations: Array<CallFact.Annotation["Service"]> = []
    let authorized = false
    let executions = 0
    const request = sharedCellCall("irreversible")
    const outcome = await drive(Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      const observed: FlowRuntime.FlowRuntime["Service"] = {
        ...runtime,
        actionExecute: (action, attempt) => {
          const annotation = Context.getOption(action.annotations, CallFact.Annotation)
          if (annotation._tag === "Some") {
            expect(authorized).toBe(true)
            annotations.push(annotation.value)
          }
          return runtime.actionExecute(action, attempt)
        }
      }
      const port = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: staticRoute(),
        calls: {
          authorize: () =>
            authorized
              ? Effect.void
              : Effect.fail(new HarnessError({ code: "engine_failed", message: "not authorized" })),
          run: () =>
            Effect.sync(() => {
              executions++
              return new Cell.CallResult({ outcome: "success", value: "host" })
            })
        }
      }).pipe(Effect.provideService(FlowRuntime.FlowRuntime, observed))
      expect((yield* Effect.exit(port.call(request)))._tag).toBe("Failure")
      expect(annotations).toHaveLength(0)
      authorized = true
      yield* port.call(request)
      const delivered = { outcome: "failure" as const, value: null, code: "timeout" as const, message: "deadline" }
      return yield* port.record({
        name: "cell-call",
        call: request,
        identity: { session: request.identity.session, frame: 0, boundary: "cell-call:cell-digest:0" },
        success: Cell.CallResultVariant,
        execute: Effect.succeed(delivered)
      })
    }))
    expect(completed(outcome)).toMatchObject({ outcome: "failure", code: "timeout" })
    expect(executions).toBe(1)
    expect(annotations.map((annotation) => annotation.phase)).toEqual(["invoked", "settled"])
    expect(annotations[0]?.call).toEqual(annotations[1]?.call)
    const { session, ...identity } = request.identity
    expect(annotations[0]?.call.identity).toEqual({ runId: session, ...identity })
  })

  it("keeps the sandbox cache key separate from the durable activity key", async () => {
    const call = sharedCellCall("sealed")
    const outcome = await drive(Effect.gen(function*() {
      const sandboxKey = yield* StepKey.fromKeyMaterial(
        FlowEngineLike.callMaterial(call, ["host-layer"]),
        {}
      )
      const port = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: staticRoute(),
        layers: ["host-layer"],
        capabilities: {},
        calls: {
          run: () =>
            Effect.map(
              Action.CurrentInvocationKey,
              (key) => new Cell.CallResult({ outcome: "success", value: key ?? "missing" })
            )
        }
      })
      const result = yield* port.call(call)
      return { sandboxKey, activityKey: result.value }
    }))

    // `callMaterial` keys the workspace sandbox declaration; the dispatched
    // activity also carries the durable scope and composition layers.
    expect(completed(outcome)).toMatchObject({ activityKey: expect.stringMatching(/^key1_/) })
    expect((completed(outcome) as { readonly activityKey: string; readonly sandboxKey: string }).activityKey)
      .not.toBe((completed(outcome) as { readonly activityKey: string; readonly sandboxKey: string }).sandboxKey)
  })

  /**
   * `capabilities` is a required argument, never a defaulted one: an omitted
   * capability identity is the behaviour under test, and a default parameter
   * would silently rewrite an explicit `undefined` back into `{}`.
   */
  const callOnce = (
    executed: Array<string>,
    tier: "sealed" | "irreversible",
    capabilities: Readonly<Record<string, ReadonlyArray<string>>> | undefined
  ): Effect.Effect<unknown, unknown, PortServices> =>
    Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: staticRoute(),
        calls: countingCalls(executed),
        ...(capabilities === undefined ? {} : { capabilities })
      })
      return (yield* port.call(sharedCellCall(tier))).value
    })

  it("never aliases one irreversible cell call across two runs sharing a session", async () => {
    const executed: Array<string> = []
    const outcomes = await driveBoth(callOnce(executed, "irreversible", {}), callOnce(executed, "irreversible", {}))

    expect(outcomes.map((outcome) => outcome._tag)).toEqual(["completed", "completed"])
    // Two runs, two executions of the irreversible effect: the engine keys
    // every non-sealed activity by ordinal under the execution id, and this
    // pins the port's contract to that property — one session, one frame, one
    // cell, one ordinal is still two boundaries in two runs.
    expect(executed).toEqual(["fs/write#0", "fs/write#0"])
    expect(outcomes[0]).toMatchObject({ value: 1 })
    expect(outcomes[1]).toMatchObject({ value: 2 })
  })

  it("still shares one sealed cell call across runs, because that is what sealed means", async () => {
    const executed: Array<string> = []
    const outcomes = await driveBoth(callOnce(executed, "sealed", {}), callOnce(executed, "sealed", {}))

    expect(outcomes.map((outcome) => outcome._tag)).toEqual(["completed", "completed"])
    expect(executed).toEqual(["fs/write#0"])
    expect(outcomes[0]).toMatchObject({ value: 1 })
    expect(outcomes[1]).toMatchObject({ value: 1 })
  })

  it("never shares a sealed cell call across runs when the composition's authority is unknown", async () => {
    const executed: Array<string> = []
    const outcomes = await driveBoth(
      callOnce(executed, "sealed", undefined),
      callOnce(executed, "sealed", undefined)
    )

    // Issue #75: a port that declared `capabilities: {}` on its own behalf
    // asserted "this composition grants nothing" for every host, including
    // hosts holding a capability envelope. A sealed result computed under a
    // broad envelope was then cross-run reusable by a run with an attenuated
    // one. Undeclared authority now pins the key to its execution.
    expect(outcomes.map((outcome) => outcome._tag)).toEqual(["completed", "completed"])
    expect(executed).toEqual(["fs/write#0", "fs/write#0"])
  })

  it("never shares a sealed cell call between two differently-authorized compositions", async () => {
    const executed: Array<string> = []
    const outcomes = await driveBoth(
      callOnce(executed, "sealed", { envelope: ["fs:read:/workspace/**"] }),
      callOnce(executed, "sealed", { envelope: ["fs:read:/workspace/a/**"] })
    )

    // Same declaration, same declared call capabilities, different envelope:
    // the envelope is what attenuates the call, so it is part of what the
    // boundary means.
    expect(outcomes.map((outcome) => outcome._tag)).toEqual(["completed", "completed"])
    expect(executed).toEqual(["fs/write#0", "fs/write#0"])
  })
})

/**
 * The transport backoff, driven on the test clock.
 *
 * `recordModelStep` is exercised directly rather than through `drive` because
 * the assertion is about time: the sealed step has to be forked so the test
 * clock can advance past every scheduled sleep, and the flow engine's own
 * execution is not what is under test here.
 */
describe("FlowEngineLike.CallReadings (#3010)", () => {
  const readingCall = (ordinal: number): Cell.Call =>
    new Cell.Call({
      flowName: "jev",
      input: { state: { ordinal } },
      capabilities: [],
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "irreversible" },
      placement: Option.none(),
      identity: new Cell.CallIdentity({
        session: "session-1",
        frame: 0,
        cell: "cell-digest",
        ordinal,
        declaration: "declaration-digest",
        layers: []
      })
    })

  type Answer = Effect.Effect<Evaluator.Response, Evaluator.EvaluatorError>
  const request: Evaluator.Request = { state: {}, questions: { q: { type: "boolean", instructions: "?" } } }
  const answered = (usage?: Evaluator.Usage): Answer =>
    Effect.succeed({
      answers: { q: { type: "boolean", probability: 0.5 } },
      latencyMs: 0,
      ...(usage === undefined ? {} : { usage })
    })

  /** A judge that answers each reading from `script`, in order, counting them. */
  const judging = (script: ReadonlyArray<Answer>) => {
    const asked = { count: 0 }
    const services = FlowEngineLike.metered(Context.make(
      Evaluator.Evaluator,
      Evaluator.Evaluator.of({ evaluate: () => Effect.suspend(() => script[asked.count++]!) })
    ))
    return { asked, evaluate: Context.get(services, Evaluator.Evaluator).evaluate }
  }

  /** A cell-call runner whose flow asks the metered judge once per scripted answer. */
  const reading = (judge: ReturnType<typeof judging>, readings: number): FlowEngineLike.CallRunner => ({
    run: () =>
      Effect.forEach(Array.from({ length: readings }), () => Effect.result(judge.evaluate(request))).pipe(
        Effect.map((results) =>
          new Cell.CallResult({
            outcome: "success",
            value: results.map((result) => result._tag === "Success" ? "answered" : result.failure.code)
          })
        )
      )
  })

  it("charges each reading a call's flow paid, taken or failed, priced by model, and nothing on replay", async () => {
    const judge = judging([
      answered({ inputTokens: 900_000, outputTokens: 100_000, modelId: "judge-a" }),
      Effect.fail(
        new Evaluator.EvaluatorError({
          code: "invalid_answer",
          message: "bad",
          usage: { inputTokens: 5, outputTokens: 1 }
        })
      ),
      answered()
    ])
    const entries: Array<Budget.LedgerEntry> = []
    const ledger = Budget.memoryLedger()
    let park = true
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({
          model: countingModel([]),
          route: staticRoute(),
          calls: reading(judge, 3)
        })
        const result = yield* port.call(readingCall(0))
        if (park) {
          park = false
          yield* port.suspend(new EngineLike.SuspendReason({ code: "engine", message: "killed" }))
        }
        return { value: result.value, usage: yield* (yield* Budget.Budget).usage }
      }).pipe(Effect.provide(Budget.layer(
        { tokens: { max: 10_000_000 }, prices: { "judge-a": { input: 2, cacheRead: 0, cacheWrite: 0, output: 10 } } },
        {
          ledger: {
            ...ledger,
            record: (entry) => Effect.andThen(Effect.sync(() => void entries.push(entry)), ledger.record(entry))
          }
        }
      ))),
      { resume: true }
    )
    expect(judge.asked.count).toBe(3)
    expect(completed(outcome)).toEqual({
      value: ["answered", "invalid_answer", "answered"],
      usage: { tokens: 1_000_006, calls: 2, largestCall: 1_000_000 }
    })
    expect(entries.map((entry) => entry.stepKey)).toEqual([
      expect.stringMatching(/^call-reading\/.+\/0$/),
      expect.stringMatching(/^call-reading\/.+\/1$/)
    ])
    expect(entries[0]!.costUsd).toBeCloseTo(2.8)
    expect(entries[1]!.costUsd).toBeUndefined()
  })

  it("takes no reading once the run's ceiling is spent", async () => {
    const judge = judging([answered({ inputTokens: 1, outputTokens: 0 })])
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({
          model: countingModel([]),
          route: staticRoute(),
          calls: reading(judge, 1)
        })
        yield* (yield* Budget.Budget).record("spent", { totalTokens: 100 })
        return (yield* port.call(readingCall(0))).value
      }).pipe(Effect.provide(Budget.layer({ tokens: { max: 100 } })))
    )
    expect(completed(outcome)).toEqual(["refused"])
    expect(judge.asked.count).toBe(0)
  })

  it("takes no reading when the ledger cannot say what the run spent", async () => {
    const judge = judging([answered()])
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({
          model: countingModel([]),
          route: staticRoute(),
          calls: reading(judge, 1)
        })
        return yield* port.call(readingCall(0))
      }).pipe(Effect.provideService(Budget.Budget, {
        ...Budget.makeUnbounded(),
        admitReading: () =>
          Effect.fail(new Budget.AccountingUnavailable({ phase: "recover", runId: "exec-1", message: "no ledger" }))
      }))
    )
    expect((completed(outcome) as Cell.CallResult).value).toEqual(["refused"])
    expect(judge.asked.count).toBe(0)
  })

  it("is the judge unchanged outside a call", async () => {
    const judge = judging([answered({ inputTokens: 1, outputTokens: 0 })])
    const response = await Effect.runPromise(judge.evaluate(request))
    expect(response.usage).toEqual({ inputTokens: 1, outputTokens: 0 })
    expect(judge.asked.count).toBe(1)
  })

  it("fails a call before its flow runs if a reading receipt cannot be allocated", async () => {
    const judge = judging([answered()])
    const outcome = await drive(Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const port = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: staticRoute(),
        calls: reading(judge, 1)
      })
        .pipe(
          Effect.provideService(Crypto.Crypto, {
            ...crypto,
            randomUUIDv4: Effect.fail(PlatformError.systemError({
              module: "Crypto",
              method: "randomUUIDv4",
              _tag: "Unknown",
              description: "injected entropy failure"
            }))
          })
        )
      return yield* port.call(readingCall(0))
    }))
    expect(failure(outcome)).toMatchObject({
      code: "engine_failed",
      message: "Could not allocate a call reading receipt"
    })
    expect(judge.asked.count).toBe(0)
  })
})

describe("FlowEngineLike.defaultModelRetryPolicy", () => {
  /** What the provider actually saw: how often it was called, and how far apart. */
  interface Observed {
    attempts: number
    readonly gaps: Array<number>
  }

  /**
   * Fails every attempt with `code`, timing itself on the injected clock.
   *
   * The gaps are read off the clock the run slept on, so they are the delays
   * the schedule really took rather than the ones it claims to have taken.
   */
  const alwaysFailing = (
    code: "transport" | "quota_exceeded",
    observed: Observed
  ): { readonly model: Model.Model; readonly error: ModelError } => {
    const error = new ModelError({ code, message: `always ${code}` })
    let previous: number | undefined
    return {
      error,
      model: Model.make({
        stream: () =>
          Stream.fromEffect(
            Effect.gen(function*() {
              const now = yield* Clock.currentTimeMillis
              observed.attempts++
              if (previous !== undefined) observed.gaps.push(now - previous)
              previous = now
              return yield* Effect.fail(error)
            })
          )
      })
    }
  }

  /**
   * Runs one sealed model step to exhaustion on the test clock.
   *
   * A single large adjustment settles every sleep the schedule asks for in
   * order, so the delays the run actually took are whatever the policy chose,
   * not a cadence the test imposed.
   */
  const exhaust = (model: Model.Model): Promise<typeof FlowEngineLike.RecordedModelStep.Type> =>
    Effect.gen(function*() {
      const fiber = yield* InternalFlowEngineLike.recordModelStep(
        model,
        request("hello"),
        FlowEngineLike.defaultModelRetryPolicy
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("10 minutes")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)

  const retriesOf = (
    recorded: typeof FlowEngineLike.RecordedModelStep.Type
  ): ReadonlyArray<ModelEvent.Retry> =>
    InternalFlowEngineLike.normalizeRecordedModelStep(recorded).events.filter(
      (event): event is ModelEvent.Retry => event.type === "retry"
    )

  const nominalMillis = (index: number): number =>
    FlowEngineLike.defaultModelRetryBaseMillis * Math.pow(FlowEngineLike.defaultModelRetryFactor, index)

  it("waits a growing, jittered delay before each transport attempt", async () => {
    const observed: Observed = { attempts: 0, gaps: [] }
    const { model } = alwaysFailing("transport", observed)
    const recorded = await exhaust(model)

    const retries = retriesOf(recorded)
    expect(retries.map((retry) => retry.attempt)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(retries.map((retry) => retry.code))).toEqual(new Set(["transport"]))

    // The defect this closes is two attempts inside one provider incident.
    // Every delay is real, and each is larger than the one before it: with
    // jitter bounded to [0.8, 1.2] and a factor of two, 1.2x one delay is
    // still below 0.8x the next, so the growth is guaranteed, not luck.
    const delays = retries.map((retry) => retry.delayMillis)
    delays.reduce((previous, delay) => {
      expect(delay).toBeGreaterThan(previous)
      return delay
    }, 0)
    delays.forEach((delay, index) => {
      expect(delay).toBeGreaterThanOrEqual(nominalMillis(index) * 0.8)
      expect(delay).toBeLessThanOrEqual(nominalMillis(index) * 1.2)
    })
    // Jitter, not a fixed ladder: at least one delay is off its nominal value.
    expect(delays.some((delay, index) => delay !== nominalMillis(index))).toBe(true)

    // The recorded delays are the delays the run actually slept on the injected
    // clock, so a report reading the journaled events reads the real schedule.
    expect(observed.gaps.map((gap) => Math.round(gap))).toEqual(delays)
    // Roughly thirty seconds of cover, long enough to outlast a provider blip.
    expect(observed.gaps.reduce((total, gap) => total + gap, 0)).toBeGreaterThan(24_000)
  })

  it("stops at the declared budget and surfaces the original transport error", async () => {
    const observed: Observed = { attempts: 0, gaps: [] }
    const { error, model } = alwaysFailing("transport", observed)
    const recorded = await exhaust(model)

    // One first attempt plus the budget, and not one call more.
    expect(observed.attempts).toBe(FlowEngineLike.defaultModelRetryTimes + 1)
    expect(retriesOf(recorded)).toHaveLength(FlowEngineLike.defaultModelRetryTimes)
    // Exhaustion returns the provider's own typed error, never a wrapper.
    expect(InternalFlowEngineLike.normalizeRecordedModelStep(recorded).error).toStrictEqual(error)
  })

  it("puts a scripted stream abort on the same ladder, at the same delays", async () => {
    // The delays are the assertion, so the abort is driven on the injected
    // clock beside the failures it now shares a classification with. A body
    // that stops arriving is a transport failure whether the socket said so or
    // simply stopped, and 32 seconds of jittered cover is what a dropped
    // HTTP/2 session needs to outlast.
    const observed: Observed = { attempts: 0, gaps: [] }
    let previous: number | undefined
    const aborting = Model.make({
      stream: () =>
        Stream.fromEffect(
          Effect.gen(function*() {
            const now = yield* Clock.currentTimeMillis
            observed.attempts++
            if (previous !== undefined) observed.gaps.push(now - previous)
            previous = now
            // Text arrives; the settlement never does.
            return ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "0", text: "partial" })
          })
        )
    })
    const recorded = await exhaust(aborting)

    const retries = retriesOf(recorded)
    expect(retries.map((retry) => retry.attempt)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(retries.map((retry) => retry.code))).toEqual(new Set(["transport"]))
    expect(observed.attempts).toBe(FlowEngineLike.defaultModelRetryTimes + 1)
    expect(observed.gaps.map((gap) => Math.round(gap))).toEqual(retries.map((retry) => retry.delayMillis))
    expect(observed.gaps.reduce((total, gap) => total + gap, 0)).toBeGreaterThan(24_000)
    expect(InternalFlowEngineLike.normalizeRecordedModelStep(recorded).error).toMatchObject({
      code: "transport",
      message: "The model response stream ended without a settlement"
    })
  })

  it("stops the ladder when the wall clock, rather than the count, runs out", async () => {
    // The count bounds attempts; it does not bound what they cost. r92 burned
    // ten `transport` retries against a socket that stayed dead for half a
    // minute, and each of those attempts re-sent a whole prompt and streamed a
    // partial body before dying. Here every attempt spends ten seconds of the
    // injected clock before failing, so the declared window closes before the
    // fifth rung arrives and the ladder stops early instead of charging for
    // rungs the policy never budgeted the time for.
    const observed: Observed = { attempts: 0, gaps: [] }
    let previous: number | undefined
    const slow = Model.make({
      stream: () =>
        Stream.fromEffect(
          Effect.gen(function*() {
            const now = yield* Clock.currentTimeMillis
            observed.attempts++
            if (previous !== undefined) observed.gaps.push(now - previous)
            previous = now
            yield* Effect.sleep("10 seconds")
            return yield* Effect.fail(new ModelError({ code: "transport", message: "slow dead socket" }))
          })
        )
    })
    const recorded = await exhaust(slow)

    const retries = retriesOf(recorded)
    // Four rungs, not five, and it is not luck: the fourth is granted at
    // 40 s of attempts plus 7 s of jittered sleeping, which is past the window
    // however the jitter falls, and `Schedule.upTo` reads elapsed time at the
    // following step — so the window is detected there and the fifth is never
    // granted. Under jitter alone the third rung is granted at 33 s and the
    // fourth at 47 s, so neither side of this is close.
    expect(retries).toHaveLength(4)
    expect(retries.length).toBeLessThan(FlowEngineLike.defaultModelRetryTimes)
    expect(observed.attempts).toBe(retries.length + 1)
    // Every rung it did run is still the declared, jittered one — the window
    // ends the ladder, it does not reshape it.
    retries.map((retry) => retry.delayMillis).forEach((delay, index) => {
      expect(delay).toBeGreaterThanOrEqual(nominalMillis(index) * 0.8)
      expect(delay).toBeLessThanOrEqual(nominalMillis(index) * 1.2)
    })
    // What the bound is worth, in the currency the r92 report priced it in: one
    // whole attempt — one prompt re-sent, one partial body streamed, one more
    // charge — that the count alone would have allowed.
    const unbounded = (FlowEngineLike.defaultModelRetryTimes + 1) * 10_000
    expect(observed.attempts * 10_000).toBeLessThan(unbounded)
    expect(InternalFlowEngineLike.normalizeRecordedModelStep(recorded).error).toMatchObject({ code: "transport" })
  })

  it("runs every declared rung when the attempts themselves are cheap", async () => {
    // The window is headroom over the ladder's own jittered ceiling, not a
    // second, tighter budget: a transport that fails fast still gets all five
    // rungs and the roughly thirty seconds of cover they were chosen for.
    const observed: Observed = { attempts: 0, gaps: [] }
    const { model } = alwaysFailing("transport", observed)
    const recorded = await exhaust(model)

    expect(retriesOf(recorded)).toHaveLength(FlowEngineLike.defaultModelRetryTimes)
    expect(observed.gaps.reduce((total, gap) => total + gap, 0))
      .toBeLessThan(FlowEngineLike.defaultModelRetryWindowMillis)
  })

  it("spends no delay and no attempt on a terminal failure", async () => {
    const observed: Observed = { attempts: 0, gaps: [] }
    const { error, model } = alwaysFailing("quota_exceeded", observed)
    await expect(exhaust(model)).rejects.toStrictEqual(error)

    // Widening the backoff must not widen what it applies to: an exhausted
    // quota is terminal for the request as written, and waiting on it is pure
    // latency. The step is not retried, and — because the classification stops
    // the schedule before the tap — it does not journal a retry that never
    // happened either.
    expect(observed.attempts).toBe(1)
    expect(observed.gaps).toEqual([])
    // Capacity is not a recorded value at all: the sealed action fails so no
    // later run can inherit this provider window as a durable success.
  })

  it.each(
    [
      ["provider_internal", undefined],
      ["unknown", 503]
    ] as const
  )("never records capacity spelled as %s / %s", async (code, httpStatus) => {
    const error = new ModelError({
      code,
      message: "provider overloaded",
      ...(httpStatus === undefined ? {} : { httpStatus })
    })
    const model = Model.make({ stream: () => Stream.fail(error) })

    await expect(
      Effect.runPromise(
        InternalFlowEngineLike.recordModelStep(model, request("hello"), Schedule.recurs(0))
      )
    ).rejects.toStrictEqual(error)
  })
})

/**
 * The model-call budget, driven on the test clock.
 *
 * The defect it closes is one call: wave 7 of the SWE-bench harness journaled
 * a `model-settled` with `durationMillis` 667,067 — eleven minutes, 55% of the
 * run's whole budget, 60,703 output tokens — for a cell that raised on its
 * first property access. Every other budget the run armed was enforced; the
 * model call was capped at nothing.
 *
 * Time is the whole assertion here, so `recordModelStep` is exercised directly
 * and forked, the way the backoff cases above are: the test clock advances
 * past the budget and past every scheduled sleep, and no case waits on a real
 * millisecond.
 */
describe("FlowEngineLike model-call budget", () => {
  /** Short enough to advance past several times, long enough to see delays inside. */
  const budgetMillis = 5_000

  /** What the provider saw: the requests issued, and whether each finished. */
  interface Seen {
    readonly requests: Array<ModelRequest.ModelRequest>
    /** Attempts whose stream ran to its end rather than being torn down. */
    readonly completed: Array<number>
    /** The injected clock when each attempt opened, which bounds the step. */
    readonly startedAt: Array<number>
  }

  const settlement: ReadonlyArray<ModelEvent.ModelEvent> = [
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "0" }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "0", text: "answer" }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ]

  /**
   * A model whose nth attempt takes `takesMillis[n]` on the injected clock.
   *
   * The sleep is the model's own work, so interrupting the attempt interrupts
   * it: an attempt that never reaches the end of its stream never records
   * itself as completed, which is how a case proves the call was torn down
   * rather than merely ignored.
   */
  const slow = (takesMillis: ReadonlyArray<number>, seen: Seen): Model.Model =>
    Model.make({
      stream: (issued) =>
        Stream.unwrap(
          Effect.gen(function*() {
            const index = seen.requests.length
            seen.requests.push(issued)
            seen.startedAt.push(yield* Clock.currentTimeMillis)
            return Stream.fromEffect(
              Effect.sleep(takesMillis[Math.min(index, takesMillis.length - 1)]!).pipe(
                Effect.andThen(Effect.sync(() => seen.completed.push(index)))
              )
            ).pipe(Stream.flatMap(() => Stream.fromIterable(settlement)))
          })
        )
    })

  /** Runs one sealed step to settlement on the test clock, budget armed. */
  const drive = (
    model: Model.Model,
    budget: number | undefined = budgetMillis
  ): Promise<typeof FlowEngineLike.RecordedModelStep.Type> =>
    Effect.gen(function*() {
      const fiber = yield* InternalFlowEngineLike.recordModelStep(
        model,
        request("hello"),
        FlowEngineLike.defaultModelRetryPolicy,
        budget
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("30 minutes")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)

  const retriesOf = (
    recorded: typeof FlowEngineLike.RecordedModelStep.Type
  ): ReadonlyArray<ModelEvent.Retry> =>
    InternalFlowEngineLike.normalizeRecordedModelStep(recorded).events.filter(
      (event): event is ModelEvent.Retry => event.type === "retry"
    )

  it("interrupts a call that runs past the budget and re-issues it with the teaching", async () => {
    const seen: Seen = { requests: [], completed: [], startedAt: [] }
    // One attempt that would take twice the budget, then one that answers.
    const recorded = await drive(slow([budgetMillis * 2, budgetMillis / 5], seen))

    // The overrun is a retry on the existing transport schedule, journaled
    // with the delay it slept, so the same wave report that reads a backoff
    // reads this without learning a second vocabulary.
    const retries = retriesOf(recorded)
    expect(retries.map((retry) => retry.code)).toEqual(["call_timeout"])
    expect(retries[0]!.attempt).toBe(1)
    expect(retries[0]!.delayMillis).toBeGreaterThanOrEqual(
      FlowEngineLike.defaultModelRetryBaseMillis * 0.8
    )
    expect(retries[0]!.delayMillis).toBeLessThanOrEqual(
      FlowEngineLike.defaultModelRetryBaseMillis * 1.2
    )
    // Interrupted, not abandoned in flight: the first attempt's stream never
    // reached its end, and only the second one did.
    expect(seen.completed).toEqual([1])
    // The step still settles. An overrun costs one attempt, not the frame.
    expect(InternalFlowEngineLike.normalizeRecordedModelStep(recorded).error).toBeUndefined()

    // The re-issue teaches. Waiting alone cannot fix an answer that is too
    // long, so the second request says what happened and what to do instead —
    // prepended to the system context, ahead of teaching the run already has.
    expect(seen.requests).toHaveLength(2)
    expect(seen.requests[0]!.system).toEqual([])
    const teaching = seen.requests[1]!.system[0]!.text
    expect(teaching).toContain("5-second budget")
    expect(teaching).toContain("Answer directly")
    // Only the system context changes; the model is asked the same question.
    expect(seen.requests[1]!.messages).toEqual(seen.requests[0]!.messages)
  })

  it("leaves a call that answers inside the budget alone", async () => {
    const seen: Seen = { requests: [], completed: [], startedAt: [] }
    const recorded = await drive(slow([budgetMillis - 1], seen))

    // A generous ceiling is not a latency target: a call that spends almost
    // all of it is an ordinary call, retried nothing and taught nothing.
    expect(retriesOf(recorded)).toEqual([])
    expect(seen.requests).toHaveLength(1)
    expect(seen.requests[0]!.system).toEqual([])
    expect(seen.completed).toEqual([0])
    expect(InternalFlowEngineLike.normalizeRecordedModelStep(recorded).error).toBeUndefined()
  })

  it("runs unbounded when the controller disarms the budget", async () => {
    const seen: Seen = { requests: [], completed: [], startedAt: [] }
    const recorded = await drive(slow([budgetMillis * 100], seen), 0)

    // Zero is the explicit opt-out, and it must really opt out: a call far
    // past the default ceiling settles untouched.
    expect(retriesOf(recorded)).toEqual([])
    expect(seen.completed).toEqual([0])
    expect(InternalFlowEngineLike.normalizeRecordedModelStep(recorded).error).toBeUndefined()
  })

  it("surfaces the typed error once the re-issue has overrun too", async () => {
    const seen: Seen = { requests: [], completed: [], startedAt: [] }
    const recorded = await drive(slow([budgetMillis * 2], seen))

    // Exhaustion ends the frame the way any other exhausted model failure
    // does: the typed error reaches the caller, with the code that says the
    // budget — not the provider — is what stopped it.
    const retries = retriesOf(recorded)
    expect(retries).toHaveLength(FlowEngineLike.defaultModelOverruns)
    expect(new Set(retries.map((retry) => retry.code))).toEqual(new Set(["call_timeout"]))
    expect(seen.completed).toEqual([])
    const error = InternalFlowEngineLike.normalizeRecordedModelStep(recorded).error
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).code).toBe("call_timeout")
    expect((error as ModelError).message).toContain("5-second budget")
  })

  it("spends at most twice the budget on a provider that stalls every attempt", async () => {
    const seen: Seen = { requests: [], completed: [], startedAt: [] }
    await drive(slow([budgetMillis * 2], seen))

    // The bound the budget exists to state. An overrun is the one retryable
    // failure whose every attempt costs a whole ceiling, so it does not get
    // the transport codes' five retries: on the shipped 300 s default those
    // would let one sealed step spend 1,800 s — 150% of the 1,200 s the wave
    // gave a whole run, and 2.7x the single 667 s call the budget was written
    // to bound.
    expect(seen.requests).toHaveLength(FlowEngineLike.defaultModelOverruns + 1)
    // Measured on the injected clock rather than counted: the last attempt
    // opens one budget plus one jittered backoff in, so the step's total model
    // time is two budgets and change, whatever the schedule's other codes do.
    const opened = seen.startedAt[seen.startedAt.length - 1]! - seen.startedAt[0]!
    expect(opened).toBeLessThanOrEqual(
      budgetMillis + FlowEngineLike.defaultModelRetryBaseMillis * 1.2
    )
    expect(opened).toBeGreaterThanOrEqual(budgetMillis)
  })

  /** A thinking delta, the event a long think streams on the ChatGPT route. */
  const thought = ModelEvent.ModelEvent.ThinkingDelta({ type: "thinking-delta", id: "r", text: "…" })

  /**
   * A model that streams one thought every `everyMillis` for `forMillis`,
   * then answers; after `silentAfter` attempts it goes quiet forever instead.
   */
  const thinking = (
    everyMillis: number,
    forMillis: number,
    seen: Seen,
    silentAttempts = 0
  ): Model.Model =>
    Model.make({
      stream: (issued) =>
        Stream.unwrap(
          Effect.gen(function*() {
            const index = seen.requests.length
            seen.requests.push(issued)
            seen.startedAt.push(yield* Clock.currentTimeMillis)
            if (index < silentAttempts) {
              return Stream.concat(Stream.make(thought), Stream.fromEffect(Effect.never))
            }
            const ticks = Math.floor(forMillis / everyMillis)
            return Stream.range(1, ticks).pipe(
              Stream.mapEffect(() => Effect.as(Effect.sleep(everyMillis), thought)),
              Stream.concat(Stream.fromEffect(Effect.sync(() => seen.completed.push(index))).pipe(Stream.drain)),
              Stream.concat(Stream.fromIterable(settlement))
            )
          })
        )
    })

  /**
   * `drive`, with the clock advanced a minute at a time. A stall's timer is
   * armed on a fiber the re-issued attempt forks, and one large adjustment can
   * finish before that fiber has armed it.
   */
  const driveStepped = (model: Model.Model, budget: number): Promise<typeof FlowEngineLike.RecordedModelStep.Type> =>
    Effect.gen(function*() {
      const fiber = yield* InternalFlowEngineLike.recordModelStep(
        model,
        request("hello"),
        FlowEngineLike.defaultModelRetryPolicy,
        budget
      ).pipe(Effect.forkChild({ startImmediately: true }))
      for (let minute = 0; minute < 60; minute++) yield* TestClock.adjust("1 minute")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)

  it("lets a max-effort call that keeps streaming run past the old 300 s ceiling", async () => {
    // photonic-waveguide-routing, 2026-09-24: Codex's decisive turn took 735 s.
    const seen: Seen = { requests: [], completed: [], startedAt: [] }
    const recorded = await drive(thinking(10_000, 735_000, seen), CellTurn.modelCallMsFor("max"))

    expect(retriesOf(recorded)).toEqual([])
    expect(seen.completed).toEqual([0])
    expect(InternalFlowEngineLike.normalizeRecordedModelStep(recorded).error).toBeUndefined()
  })

  it("cuts off a stream that goes silent and re-issues it without the overrun teaching", async () => {
    const seen: Seen = { requests: [], completed: [], startedAt: [] }
    const recorded = await driveStepped(thinking(10_000, 20_000, seen, 1), CellTurn.modelCallMsFor("max"))

    // A silent stream is a dead socket, not a model that talked too long: it
    // is re-issued on the transport ladder after the idle window, not after
    // the whole 30-minute ceiling, and the model is not told to hurry.
    expect(retriesOf(recorded).map((retry) => retry.code)).toEqual(["transport"])
    expect(seen.requests).toHaveLength(2)
    expect(seen.requests[1]!.system).toEqual([])
    const reopened = seen.startedAt[1]! - seen.startedAt[0]!
    expect(reopened).toBeGreaterThanOrEqual(FlowEngineLike.defaultModelIdleMs)
    expect(reopened).toBeLessThan(FlowEngineLike.defaultModelIdleMs + 5_000)
    expect(InternalFlowEngineLike.normalizeRecordedModelStep(recorded).error).toBeUndefined()
  })

  it("names the silence when every attempt stalls", async () => {
    const seen: Seen = { requests: [], completed: [], startedAt: [] }
    const recorded = await driveStepped(thinking(10_000, 20_000, seen, 10), CellTurn.modelCallMsFor("max"))

    // Like an overrun, a stall costs a whole window, so it is re-issued once
    // and not on the transport ladder's five rungs.
    expect(seen.requests).toHaveLength(FlowEngineLike.defaultModelOverruns + 1)
    const error = InternalFlowEngineLike.normalizeRecordedModelStep(recorded).error
    expect(error).toMatchObject({ code: "transport" })
    expect((error as ModelError).message).toContain("sent nothing for 300 seconds")
  })
})

describe("FlowEngineLike.routeResolver", () => {
  it("prepares a request through a configured route without leaking the credential", async () => {
    const route = Route.anthropic({ apiKey: Redacted.make("test-key") })
    expect(Result.isSuccess(route)).toBe(true)
    if (!Result.isSuccess(route)) return
    const prepared = await Effect.runPromise(
      FlowEngineLike.routeResolver(route.success).prepare(request("hello"))
    )
    expect(prepared.routeId).toBe("anthropic")
    // The api key is signed on by the route after the digest, never here.
    expect(Object.keys(prepared.publicHeaders)).not.toContain("x-api-key")
  })
})

describe("FlowEngineLike.resolve", () => {
  it("names the route a request goes to, and never the credential the route authorizes with", async () => {
    const secret = "sk-ant-api03-credential-value-that-must-never-be-journaled"
    const route = Route.anthropic({ apiKey: Redacted.make(secret) })
    if (!Result.isSuccess(route)) throw new Error("the anthropic route did not build")
    const asked = request("hello")
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({
        model: countingModel([]),
        route: FlowEngineLike.routeResolver(route.success)
      })
      return Option.getOrThrow(yield* engine.resolve!(asked))
    }))
    const resolved = completed(outcome) as EngineLike.Resolved
    // The port rewrites nothing: the request is the one it was handed.
    expect(resolved.request).toBe(asked)
    expect(Option.getOrUndefined(resolved.binding)).toEqual(
      new EngineLike.Binding({ routeId: "anthropic", protocolId: route.success.protocol.id })
    )

    // Through the event, its durable encoding, and the row the executor
    // journals: a `Redacted` key was on the route the whole time, and none of
    // the three holds its value or the header it is signed onto.
    const event = new AgentEvent.ModelRequested({
      eventType: AgentEvent.eventType.modelRequested,
      scope: "session-1",
      frame: 0,
      attempt: 1,
      purpose: "frame",
      seat: "anthropic:test-model",
      binding: Option.getOrUndefined(resolved.binding),
      request: resolved.request
    })
    const written = JSON.stringify([
      resolved,
      Schema.encodeSync(AgentEvent.AgentEvent)(event),
      AgentSession.trace(event)
    ])
    expect(written).toContain("\"routeId\":\"anthropic\"")
    expect(written).not.toContain(secret)
    expect(written.toLowerCase()).not.toContain("x-api-key")
    expect(written).not.toContain("<redacted>")
    // There is nowhere for one to go: the binding is two names and no more.
    expect(Object.keys(Schema.encodeSync(EngineLike.Binding)(Option.getOrThrow(resolved.binding)))).toEqual([
      "routeId",
      "protocolId"
    ])
  })

  it("resolves a request no route accepts to none, and leaves the failure to the sealed step", async () => {
    const asked = request("hello")
    const outcome = await drive(Effect.gen(function*() {
      const engine = yield* FlowEngineLike.make({ model: countingModel([]), route: failingRoute })
      const resolved = yield* engine.resolve!(asked)
      const sealed = yield* Stream.runCollect(engine.sealStep(step("hello"))).pipe(Effect.exit)
      return { resolved, sealed: classify(sealed) }
    }))
    const { resolved, sealed } = completed(outcome) as {
      resolved: Option.Option<EngineLike.Resolved>
      sealed: Outcome
    }
    // Nothing true can be said of where it goes, so no record says it went.
    expect(resolved).toEqual(Option.none())
    expect(sealed._tag).toBe("failed")
  })
})

describe("FlowEngineLike timeout guard", () => {
  const parked: Budget.Parked = {
    waiting: { reason: "approval", token: "guard/run-1/timeout" },
    failure: new HarnessError({ code: "engine_failed", message: "The run is parked on a timeout" })
  }

  /** A host guard that answers every subject with `answer` and records what it was asked. */
  type Admitted =
    | { readonly _tag: "proceed"; readonly continued: number }
    | { readonly _tag: "park"; readonly parked: Budget.Parked }

  const guardedBy = (
    answer: Admitted,
    asked: Array<string>
  ): Budget.Parking["Service"] => ({
    guardsTimeouts: true,
    park: () => Effect.die("no budget park is expected"),
    trip: () => Effect.die("no timeout trips here"),
    admit: (subject) =>
      Effect.sync(() => {
        asked.push(subject)
        return answer
      })
  })

  it("parks a model call whose timeout question is open, without contacting the provider", async () => {
    const calls: Array<string> = []
    const asked: Array<string> = []
    let declared: FlowRuntime.WaitingAnnotation | undefined
    const outcome = await drive(
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        const port = yield* FlowEngineLike.make({ model: countingModel(calls), route: staticRoute() })
        const refused = yield* Effect.flip(Stream.runCollect(port.sealStep(step("hello"))))
        expect(refused).toBe(parked.failure)
        // The wait is declared when the frame suspends, not when the call is refused.
        expect(instance.waiting).toBeUndefined()
        return yield* port.suspend(new EngineLike.SuspendReason({ code: "engine", message: "parked" })).pipe(
          Effect.ensuring(Effect.sync(() => {
            declared = instance.waiting
          }))
        )
      }).pipe(Effect.provideService(Budget.Parking, guardedBy({ _tag: "park", parked }, asked)))
    )

    expect(outcome._tag).toBe("suspended")
    expect(calls).toEqual([])
    // The guard was asked about the sealed call's own key.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/\S/)
    expect(declared).toEqual(parked.waiting)
  })

  it("admits controller work through the port's guard: parks an open subject, proceeds otherwise", async () => {
    const asked: Array<string> = []
    let declared: FlowRuntime.WaitingAnnotation | undefined
    const outcome = await drive(Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      const port = yield* FlowEngineLike.make({ model: countingModel([]), route: staticRoute() })
      const guard = port.guard!
      // No host guard: every subject proceeds and nobody is asked.
      yield* guard.admit("cell/unguarded")
      const proceeded = yield* guard.admit("cell/answered").pipe(
        Effect.provideService(Budget.Parking, guardedBy({ _tag: "proceed", continued: 1 }, asked))
      )
      const refused = yield* Effect.flip(
        guard.admit("cell/open").pipe(
          Effect.provideService(Budget.Parking, guardedBy({ _tag: "park", parked }, asked))
        )
      )
      expect(proceeded).toBeUndefined()
      expect(refused).toBe(parked.failure)
      return yield* port.suspend(new EngineLike.SuspendReason({ code: "engine", message: "parked" })).pipe(
        Effect.ensuring(Effect.sync(() => {
          declared = instance.waiting
        }))
      )
    }))

    expect(outcome._tag).toBe("suspended")
    expect(asked).toEqual(["cell/answered", "cell/open"])
    expect(declared).toEqual(parked.waiting)
  })

  it("ignores a host guard that does not guard timeouts", async () => {
    const asked: Array<string> = []
    const calls: Array<string> = []
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: countingModel(calls), route: staticRoute() })
        yield* port.guard!.admit("cell/open")
        return (yield* Stream.runCollect(port.sealStep(step("hello")))).length
      }).pipe(
        Effect.provideService(Budget.Parking, { ...guardedBy({ _tag: "park", parked }, asked), guardsTimeouts: false })
      )
    )

    expect(completed(outcome)).toBe(3)
    expect(asked).toEqual([])
    expect(calls).toEqual(["test-model"])
  })
})

describe("FlowEngineLike budget resume", () => {
  it("records a resume that failed at construction before its first call, then does not ask again", async () => {
    const resumes: Array<number | undefined> = []
    const calls: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: countingModel(calls), route: staticRoute() }).pipe(
        Effect.provideService(Budget.Budget, {
          ...Budget.makeUnbounded(),
          resume: (at) =>
            Effect.suspend(() => {
              resumes.push(at)
              return resumes.length === 1
                ? Effect.fail(
                  new Budget.AccountingUnavailable({ phase: "record", runId: "run-1", message: "ledger busy" })
                )
                : Effect.void
            })
        })
      )
      // Construction tried once and failed; the port has done no work yet.
      expect(resumes).toHaveLength(1)
      expect(calls).toEqual([])
      yield* Stream.runDrain(port.sealStep(step("first")))
      yield* Stream.runDrain(port.sealStep(step("second")))
      return resumes
    }))

    const recorded = completed(outcome) as Array<number | undefined>
    // One retry before the first call, at the instant the run resumed, and none after.
    expect(recorded).toHaveLength(2)
    expect(recorded[1]).toBe(recorded[0])
    expect(calls).toEqual(["test-model", "test-model"])
  })
})
