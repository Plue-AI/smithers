/**
 * The assembled cell path, run end-to-end outside a unit test's hand-wiring.
 *
 * Every collaborator here is the production one: the real durable engine, the
 * real QuickJS sandbox, the real registry-backed call bridge, the real
 * controller. Only the provider is recorded, because a smoke test that calls a
 * provider is not a smoke test.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as DurableClock from "@smthrs/flow/DurableClock"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import type * as CellCalls from "@smthrs/harness/CellCalls"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Monitor from "@smthrs/harness/Monitor"
import type * as Relevance from "@smthrs/harness/Relevance"
import * as Supervisor from "@smthrs/harness/Supervisor"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as MemoryError from "@smthrs/memory/MemoryError"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import type * as SnapshotRecorder from "@smthrs/memory/SnapshotRecorder"
import * as MemorySource from "@smthrs/memory/Source"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import * as ObservabilityMetric from "@smthrs/observability/Metric"
import { Node } from "@smthrs/plan"
import { make as makePlugin } from "@smthrs/plugin"
import type { FlowsHooks, PluginInput } from "@smthrs/plugin"
import type { FlowsConfig } from "@smthrs/plugin/Config"
import type { PluginError } from "@smthrs/plugin/PluginError"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Metric,
  Option,
  Path,
  References,
  Schedule,
  Schema,
  Scope,
  Stream
} from "effect"
import type * as Crypto from "effect/Crypto"
import * as TestClock from "effect/testing/TestClock"
import { describe, expect, it, vi } from "vitest"
import * as Agent from "../src/Agent.ts"
import type * as Budget from "../src/Budget.ts"
import * as Checkpointed from "../src/Checkpointed.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as MemoryMine from "../src/MemoryMine.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import { layer as scriptedCompletionJudge, layerAll as scriptedJudgeAll } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as StandardFlows from "../src/StandardFlows.ts"
import * as Safety from "./Safety.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const cell = `const listed = await ctx.call("fs/list", { path: "." })
const written = await ctx.call("fs/write", { path: listed[0], text: "done" })
ctx.done(written)`

/** A recorded model that replies with exactly one cell and records its prompt. */
const recorded = (requests: Array<string>): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(
          request.system.map((part) => part.text).join("\n") +
            "\n" +
            request.messages.flatMap((message) =>
              message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            ).join("\n")
        )
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: "cell",
            text: "```cell\n" + cell + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

const recordedWithSeatSamples = (requests: Array<string>, samples: Array<number>): Model.Model => {
  const delegate = recorded(requests)
  return Model.make({
    stream: (request) =>
      Stream.unwrap(
        Effect.map(Metric.value(ObservabilityMetric.activeSeats), (state) => {
          samples.push(state.value)
          return delegate.stream(request)
        })
      )
  })
}

const recordedCells = (requests: Array<string>, cells: ReadonlyArray<string>): Model.Model => {
  let index = 0
  return Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(
          request.system.map((part) => part.text).join("\n") +
            "\n" +
            request.messages.flatMap((message) =>
              message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            ).join("\n")
        )
        const source = cells[index++] ?? cells.at(-1) ?? "ctx.done(\"done\")"
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

const descriptor = (
  name: string,
  options: { readonly tier: Descriptor.EffectTier; readonly modelInvocable?: boolean }
): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name,
    description: `The ${name} flow.`,
    body: new Descriptor.BodyRefModule({ path: `/flows/${name}/flow.ts` }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: options.tier },
    placement: Option.none(),
    modelInvocable: options.modelInvocable ?? true,
    path: `/flows/${name}`,
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

/**
 * An in-memory registry over a fixed descriptor set.
 *
 * The same instance answers both `visible` — which is what the model is shown —
 * and `getOption` — which is what the boundary resolves against. That is the
 * property the composition depends on, so the fixture must not fake it apart.
 */
const registryOf = (entries: ReadonlyArray<Descriptor.FlowDescriptor>): Registry.Registry => {
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  return Registry.makeNoop({
    list: () => Effect.succeed(entries),
    visible: () => Effect.succeed(entries),
    getOption: (name) => Effect.succeed(Option.fromNullishOr(byName.get(name)))
  })
}

const implementations = (
  executed: Array<string>
): ReadonlyMap<string, CellCalls.Implementation> =>
  new Map<string, CellCalls.Implementation>([
    [
      "fs/list",
      (call) =>
        Effect.sync(() => {
          executed.push(`fs/list#${call.identity.ordinal}`)
          return new Cell.CallResult({ outcome: "success", value: ["alpha.md"] })
        })
    ],
    [
      "fs/write",
      (call) =>
        Effect.sync(() => {
          executed.push(`fs/write#${call.identity.ordinal}`)
          return new Cell.CallResult({
            outcome: "success",
            value: `wrote ${(call.input as { readonly path: string }).path}`
          })
        })
    ]
  ])

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
const driveFlow = Flow.make("agent/test/agent", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

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

/** Runs one body as the whole of one real durable flow execution. */
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
    yield* awaitParked(engine, flow)
    settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.resume(flow, "exec-1")
    return yield* Deferred.await(settled)
  }).pipe(
    Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, Safety.layer)),
    Effect.provideService(Metric.MetricRegistry, new Map()),
    Effect.scoped,
    Effect.runPromise
  )

const flows = [descriptor("fs/list", { tier: "sealed" }), descriptor("fs/write", { tier: "irreversible" })]

const collect = (options: {
  readonly maxFrames?: number | undefined
  readonly seat?: Seat.Seat | undefined
  readonly fallbackSeats?: ReadonlyArray<Seat.Seat> | undefined
  readonly capacity?: Agent.Options["capacity"]
  readonly modelRetryPolicy?: Agent.Options["modelRetryPolicy"]
  readonly registry: Registry.Registry
  readonly model: Model.Model
  readonly implementations?: ReadonlyMap<string, CellCalls.Implementation> | undefined
  readonly authorize?: ((call: Cell.Call) => Effect.Effect<void, HarnessError>) | undefined
  readonly plugins?: PluginInput<FlowsHooks> | undefined
  readonly config?: FlowsConfig | undefined
  readonly memory?: MemorySource.Declared | undefined
  readonly activeSeatSamples?: Array<number> | undefined
  /** Receives every event as it arrives, so a run that fails still shows what it emitted. */
  readonly sink?: Array<AgentEvent.AgentEvent> | undefined
  readonly observe?: ((event: AgentEvent.AgentEvent) => Effect.Effect<void>) | undefined
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  readonly supervisor?: Agent.Options["supervisor"]
  /** Where the host pins trees; absent means it pins none. */
  readonly checkpoints?: Checkpoints.Checkpoints | undefined
  readonly flows?: Agent.Options["flows"]
  readonly judged?: boolean | undefined
  readonly instructions?: Agent.Options["instructions"]
  readonly pinnedSources?: Agent.Options["pinnedSources"]
  readonly capabilityEnvelope?: Agent.Options["capabilityEnvelope"]
}) =>
  Effect.gen(function*() {
    const agent = yield* Agent.Agent
    const events: Array<AgentEvent.AgentEvent> = []
    yield* agent.run({
      session: "session-1",
      seat: options.seat ?? Seat.make({
        id: "anthropic:test-model",
        modelId: "test-model",
        model: options.model,
        route,
        contextWindowTokens: 0
      }),
      ...(options.fallbackSeats === undefined ? {} : { fallbackSeats: options.fallbackSeats }),
      ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
      ...(options.modelRetryPolicy === undefined ? {} : { modelRetryPolicy: options.modelRetryPolicy }),
      prompt: "write the first file",
      system: ["You are running inside a smoke test."],
      registry: options.registry,
      implementations: options.implementations,
      authorize: options.authorize,
      plugins: options.plugins,
      config: options.config,
      memory: options.memory,
      supervisor: options.supervisor,
      maxFrames: options.maxFrames ?? 3,
      flows: options.flows,
      judged: options.judged,
      instructions: options.instructions,
      pinnedSources: options.pinnedSources,
      ...(options.capabilityEnvelope === undefined ? {} : { capabilityEnvelope: options.capabilityEnvelope })
    }).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event)
          options.sink?.push(event)
        }).pipe(Effect.andThen(options.observe?.(event) ?? Effect.void))
      ),
      Effect.provide(Layer.merge(Agent.layerDefaults, options.evaluator ?? scriptedCompletionJudge)),
      (effect) =>
        options.checkpoints === undefined
          ? effect
          : Effect.provideService(effect, Checkpoints.Checkpoints, options.checkpoints)
    )
    if (options.activeSeatSamples !== undefined) {
      const state = yield* Metric.value(ObservabilityMetric.activeSeats)
      options.activeSeatSamples.push(state.value)
    }
    return events
  }).pipe(Effect.provide(Agent.layer), Effect.provide(Safety.layer))

describe("capacity seat chain", () => {
  it("keeps the seat identity when a route cannot resolve", async () => {
    let prepared = 0
    let contacted = 0
    const model = Model.make({
      stream: () =>
        Stream.suspend(() => {
          contacted++
          return Stream.empty
        })
    })
    const missing = {
      prepare: () =>
        Effect.sync(() => {
          prepared++
        }).pipe(Effect.andThen(Effect.fail(
          new ModelError({ code: "no_route", message: "no route" })
        )))
    }
    const outcome = await drive(collect({
      model,
      registry: registryOf([]),
      seat: Seat.make({ id: "missing", modelId: "missing", model, route: missing, contextWindowTokens: 0 })
    }))
    expect(outcome._tag).toBe("failed")
    expect(prepared).toBeGreaterThan(0)
    expect(contacted).toBe(0)
  })
  it("streams a transport retry and keeps the settled reply free of the failed attempt", async () => {
    let calls = 0
    const completed = recordedCells([], ["ctx.done('complete')"])
    const model = Model.make({
      stream: (request) =>
        calls++ === 0
          ? Stream.concat(
            Stream.make(ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "partial", text: "partial" })),
            Stream.fail(new ModelError({ code: "transport", message: "socket closed" }))
          )
          : completed.stream(request)
    })
    const events: AgentEvent.AgentEvent[] = []
    const outcome = await drive(collect({
      model,
      registry: registryOf([]),
      sink: events,
      modelRetryPolicy: Schedule.recurs(1)
    }))
    expect(outcome._tag).toBe("completed")
    expect(calls).toBe(2)
    expect(events.map((event) => event._tag)).toContain("model-retried")
    const settled = events.find((event) => event._tag === "model-settled")
    expect(JSON.stringify(settled)).not.toContain("partial")
  })
  it("delivers a model delta before the provider stream settles", async () => {
    let release!: () => void
    let sawDelta!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const delta = new Promise<void>((resolve) => {
      sawDelta = resolve
    })
    const answer = recordedCells([], ["ctx.done('streamed')"])
    const model = Model.make({
      stream: (request) =>
        Stream.concat(
          Stream.make(ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "early", text: "early" })),
          Stream.unwrap(Effect.promise(() => gate).pipe(Effect.as(answer.stream(request))))
        )
    })
    const running = drive(collect({
      model,
      registry: registryOf([]),
      observe: (event) =>
        Effect.sync(() => {
          if (
            event._tag === "model-delta" && event.delta.type === "text-delta" && event.delta.text === "early"
          ) sawDelta()
        })
    }))
    try {
      await Promise.race([
        delta,
        new Promise((_, reject) => setTimeout(() => reject(new Error("delta was buffered")), 2000))
      ])
    } finally {
      release()
    }
    expect((await running)._tag).toBe("completed")
  })

  it("resets a partial reply before streaming the fallback seat", async () => {
    const first = Model.make({
      stream: () =>
        Stream.concat(
          Stream.make(ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "partial", text: "partial" })),
          Stream.fail(
            new ModelError({ code: "rate_limited", message: "limited", retryAfterMillis: 60_000, httpStatus: 429 })
          )
        )
    })
    const second = recordedCells([], ["ctx.done('fallback')"])
    const events: AgentEvent.AgentEvent[] = []
    const outcome = await drive(collect({
      model: first,
      registry: registryOf([]),
      sink: events,
      seat: Seat.make({ id: "first", modelId: "first", model: first, route, contextWindowTokens: 0 }),
      fallbackSeats: [Seat.make({
        id: "second",
        modelId: "second",
        model: second,
        route: { prepare: () => Effect.succeed({ ...prepared, routeId: "route-b" }) },
        contextWindowTokens: 0
      })]
    }))
    expect(outcome._tag).toBe("completed")
    const tags = events.map((event) => event._tag)
    const partial = events.findIndex((event) =>
      event._tag === "model-delta" && event.delta.type === "text-delta" && event.delta.text === "partial"
    )
    const retried = tags.indexOf("model-retried", partial + 1)
    const fallback = events.findIndex((event, index) =>
      index > retried && event._tag === "model-delta" && event.delta.type === "text-delta"
    )
    expect(partial).toBeGreaterThanOrEqual(0)
    expect(retried).toBeGreaterThan(partial)
    expect(fallback).toBeGreaterThan(retried)
    expect(tags.filter((tag) => tag === "model-retried")).toHaveLength(1)
    const settled = events.find((event) => event._tag === "model-settled")
    expect(settled?._tag === "model-settled" ? settled.message.content : []).toEqual([
      { type: "text", text: "```cell\nctx.done('fallback')\n```" }
    ])
  })
  it.each([
    new ModelError({ code: "context_overflow", message: "prompt too long" }),
    new ModelError({ code: "authentication", message: "signed out" }),
    ...(["no_route", "transport", "call_timeout", "invalid_provider_output", "unknown"] as const).map((code) =>
      new ModelError({ code, message: "seat failed" })
    ),
    ...[500, 502, 503, 504].map((httpStatus) =>
      new ModelError({ code: "provider_internal", message: "provider failed", httpStatus })
    )
  ])("fails over without parking on $code / $httpStatus", async (error) => {
    const contacted: Array<string> = []
    const first = Model.make({
      stream: () => {
        contacted.push("first")
        return Stream.fail(error)
      }
    })
    const second = recordedCells([], ["ctx.done('fallback')"])
    const events: AgentEvent.AgentEvent[] = []
    const outcome = await drive(collect({
      model: first,
      seat: Seat.make({ id: "first", modelId: "first", model: first, route, contextWindowTokens: 0 }),
      fallbackSeats: [Seat.make({ id: "second", modelId: "second", model: second, route, contextWindowTokens: 0 })],
      registry: registryOf([]),
      sink: events,
      modelRetryPolicy: Schedule.recurs(0)
    }))
    expect(outcome._tag).toBe("completed")
    expect(contacted).toEqual(["first"])
    expect(events.filter((event) => event._tag === "seat-failed-over")).toMatchObject([{
      from: "first",
      to: "second",
      code: error.code
    }])
    expect(events.some((event) => event._tag === "model-parked")).toBe(false)
  })

  it.each(["invalid_request", "content_policy"] as const)(
    "does not fail over on %s: another seat gets the same request",
    async (code) => {
      const contacted: Array<string> = []
      const first = Model.make({
        stream: () => {
          contacted.push("first")
          return Stream.fail(new ModelError({ code, message: "refused" }))
        }
      })
      const second = Model.make({
        stream: (request) => {
          contacted.push("second")
          return recordedCells([], ["ctx.done('fallback')"]).stream(request)
        }
      })
      const outcome = await drive(collect({
        model: first,
        seat: Seat.make({ id: "first", modelId: "first", model: first, route, contextWindowTokens: 0 }),
        fallbackSeats: [Seat.make({ id: "second", modelId: "second", model: second, route, contextWindowTokens: 0 })],
        registry: registryOf([]),
        modelRetryPolicy: Schedule.recurs(0)
      }))
      expect(outcome._tag).toBe("failed")
      expect(contacted).toEqual(["first"])
    }
  )

  it("fails with the final provider error when every fallback fails, without an invented reset", async () => {
    const requests: Array<string> = []
    const model = Model.make({
      stream: (request) => {
        requests.push(request.modelId)
        return Stream.fail(new ModelError({ code: "provider_internal", message: "still unavailable", httpStatus: 503 }))
      }
    })
    const events: AgentEvent.AgentEvent[] = []
    const outcome = await drive(collect({
      model,
      seat: Seat.make({ id: "first", modelId: "first", model, route, contextWindowTokens: 0 }),
      fallbackSeats: [Seat.make({ id: "second", modelId: "second", model, route, contextWindowTokens: 0 })],
      registry: registryOf([]),
      sink: events,
      modelRetryPolicy: Schedule.recurs(0)
    }))
    expect(outcome._tag).toBe("failed")
    expect(JSON.stringify(outcome)).toContain("still unavailable")
    expect(requests).toEqual(["first", "second"])
    expect(events.some((event) => event._tag === "model-parked")).toBe(false)
  })

  it("cools every seat bound to the refused route", async () => {
    const contacted: Array<string> = []
    const refused = Model.make({
      stream: () =>
        Stream.suspend(() => {
          contacted.push("first")
          return Stream.fail(
            new ModelError({
              code: "rate_limited",
              message: "account limit",
              resetAtEpochMillis: Date.now() + 3_600_000,
              httpStatus: 429
            })
          )
        })
    })
    const second = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          contacted.push("second")
          return recordedCells([], ["ctx.done('wrong account')"]).stream(request)
        })
    })
    const outcome = await drive(collect({
      model: refused,
      registry: registryOf([]),
      seat: Seat.make({ id: "first", modelId: "first", model: refused, route, contextWindowTokens: 0 }),
      fallbackSeats: [Seat.make({ id: "second", modelId: "second", model: second, route, contextWindowTokens: 0 })],
      capacity: { park: false }
    }))
    expect(outcome._tag).toBe("failed")
    expect(contacted).toEqual(["first"])
  })

  it("contacts the next seat and completes the same frame with its REPL state", async () => {
    const contacted: Array<string> = []
    const events: Array<AgentEvent.AgentEvent> = []
    const firstAnswer = recordedCells([], ["globalThis.kept = 41; console.log('ready')"])
    let firstCalls = 0
    const first = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          contacted.push("first")
          return firstCalls++ === 0
            ? firstAnswer.stream(request)
            : Stream.fail(
              new ModelError({
                code: "rate_limited",
                message: "usage limit",
                resetAtEpochMillis: Date.now() + 3_600_000,
                httpStatus: 429
              })
            )
        })
    })
    const secondAnswer = recordedCells([], ["ctx.done(globalThis.kept + 1)"])
    const second = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          contacted.push("second")
          return secondAnswer.stream(request)
        })
    })
    const outcome = await drive(collect({
      model: first,
      registry: registryOf([]),
      sink: events,
      seat: Seat.make({ id: "first", modelId: "first", model: first, route, contextWindowTokens: 0 }),
      fallbackSeats: [Seat.make({
        id: "second",
        modelId: "second",
        model: second,
        route: { prepare: () => Effect.succeed({ ...prepared, routeId: "route-b" }) },
        contextWindowTokens: 0
      })]
    }))
    expect(outcome._tag).toBe("completed")
    expect(contacted).toEqual(["first", "first", "second"])
    expect(events.find((event) => event._tag === "seat-failed-over")).toMatchObject({ from: "first", to: "second" })
    expect(events.some((event) => event._tag === "resolved")).toBe(true)
  })

  it("parks when both seats refuse, then un-parks on the test clock and completes", async () => {
    const contacted: Array<string> = []
    const events: Array<AgentEvent.AgentEvent> = []
    let firstCalls = 0
    const completed = recordedCells([], ["ctx.done('done')"])
    const refusal = () =>
      new ModelError({
        code: "rate_limited",
        message: "usage limit",
        resetAtEpochMillis: 6_000,
        httpStatus: 429
      })
    const first = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          contacted.push("first")
          return firstCalls++ === 0 ? Stream.fail(refusal()) : completed.stream(request)
        })
    })
    const second = Model.make({
      stream: () =>
        Stream.suspend(() => {
          contacted.push("second")
          return Stream.fail(refusal())
        })
    })
    const outcome = await Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const scope = yield* Effect.scope
      yield* TestClock.setTime(1_000)
      let settled = Deferred.makeUnsafe<Outcome>()
      yield* engine.register(driveFlow, () =>
        Effect.onExit(
          collect({
            model: first,
            registry: registryOf([]),
            sink: events,
            seat: Seat.make({ id: "first", modelId: "first", model: first, route, contextWindowTokens: 0 }),
            fallbackSeats: [Seat.make({
              id: "second",
              modelId: "second",
              model: second,
              route: { prepare: () => Effect.succeed({ ...prepared, routeId: "route-b" }) },
              contextWindowTokens: 0
            })]
          }),
          (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit)))
        )).pipe(Scope.provide(scope))
      yield* engine.execute(driveFlow, { executionId: "exec-1", payload: {}, discard: true })
      const firstExit = yield* Deferred.await(settled)
      expect(firstExit._tag).toBe("suspended")
      expect(events.some((event) => event._tag === "model-parked")).toBe(true)
      yield* awaitParked(engine, driveFlow)
      settled = Deferred.makeUnsafe<Outcome>()
      yield* TestClock.adjust("5 seconds")
      return yield* Deferred.await(settled)
    }).pipe(
      Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, Safety.layer)),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.scoped,
      Effect.runPromise
    )
    expect(outcome._tag).toBe("completed")
    expect(contacted).toEqual(["first", "second", "first"])
    const transitions = events.map((event) => event._tag).filter((tag) =>
      tag === "model-parked" || tag === "model-unparked"
    )
    expect(transitions).toEqual(["model-parked", "model-unparked"])
    expect(events.find((event) => event._tag === "model-parked")).toMatchObject({ wakeAt: 6_000, source: "reset" })
    expect(events.find((event) => event._tag === "model-unparked")).toMatchObject({ at: 6_000 })
  })

  it("fails with the provider's typed refusal once its parks run out", async () => {
    const events: Array<AgentEvent.AgentEvent> = []
    let calls = 0
    const model = Model.make({
      stream: () =>
        Stream.suspend(() => {
          calls++
          return Stream.fail(
            new ModelError({ code: "rate_limited", message: "wait", retryAfterMillis: 5_000, httpStatus: 429 })
          )
        })
    })
    const outcome = await Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const scope = yield* Effect.scope
      yield* TestClock.setTime(1_000)
      let settled = Deferred.makeUnsafe<Outcome>()
      yield* engine.register(driveFlow, () =>
        Effect.onExit(
          collect({ model, registry: registryOf([]), sink: events, capacity: { park: true, maxParks: 1 } }),
          (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit)))
        ).pipe(Scope.provide(scope)))
      yield* engine.execute(driveFlow, { executionId: "exec-1", payload: {}, discard: true })
      expect((yield* Deferred.await(settled))._tag).toBe("suspended")
      yield* awaitParked(engine, driveFlow)
      settled = Deferred.makeUnsafe<Outcome>()
      yield* TestClock.adjust("5 seconds")
      return yield* Deferred.await(settled)
    }).pipe(
      Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, Safety.layer)),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.scoped,
      Effect.runPromise
    )
    expect(outcome._tag).toBe("failed")
    expect(Option.getOrUndefined(QuotaPolicy.modelErrorOf(outcome._tag === "failed" ? outcome.error : undefined)))
      .toMatchObject({ code: "rate_limited" })
    expect(events.filter((event) => event._tag === "model-parked")).toHaveLength(1)
    expect(events.filter((event) => event._tag === "model-unparked")).toHaveLength(1)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it("parks at most QuotaPolicy.defaultMaxParks times by default", async () => {
    const events: Array<AgentEvent.AgentEvent> = []
    const model = Model.make({
      stream: () =>
        Stream.fail(new ModelError({ code: "rate_limited", message: "wait", retryAfterMillis: 1_000, httpStatus: 429 }))
    })
    const outcome = await Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const scope = yield* Effect.scope
      yield* TestClock.setTime(1_000)
      let settled = Deferred.makeUnsafe<Outcome>()
      yield* engine.register(driveFlow, () =>
        Effect.onExit(
          collect({ model, registry: registryOf([]), sink: events }),
          (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit)))
        ).pipe(Scope.provide(scope)))
      yield* engine.execute(driveFlow, { executionId: "exec-1", payload: {}, discard: true })
      let result = yield* Deferred.await(settled)
      while (result._tag === "suspended") {
        yield* awaitParked(engine, driveFlow)
        settled = Deferred.makeUnsafe<Outcome>()
        yield* TestClock.adjust("1 second")
        result = yield* Deferred.await(settled)
      }
      return result
    }).pipe(
      Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, Safety.layer)),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.scoped,
      Effect.runPromise
    )
    expect(outcome._tag).toBe("failed")
    expect(events.filter((event) => event._tag === "model-parked")).toHaveLength(QuotaPolicy.defaultMaxParks)
  })

  it("records one park across a durable resume with retry-after", async () => {
    const events: Array<AgentEvent.AgentEvent> = []
    let calls = 0
    const completed = recordedCells([], ["ctx.done('done')"])
    const model = Model.make({
      stream: (request) =>
        Stream.suspend(() =>
          ++calls === 1
            ? Stream.fail(
              new ModelError({ code: "rate_limited", message: "wait", retryAfterMillis: 5_000, httpStatus: 429 })
            )
            : completed.stream(request)
        )
    })
    const outcome = await Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const scope = yield* Effect.scope
      yield* TestClock.setTime(1_000)
      let settled = Deferred.makeUnsafe<Outcome>()
      yield* engine.register(driveFlow, () =>
        Effect.onExit(
          collect({ model, registry: registryOf([]), sink: events }),
          (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit)))
        ).pipe(Scope.provide(scope)))
      yield* engine.execute(driveFlow, { executionId: "exec-1", payload: {}, discard: true })
      expect((yield* Deferred.await(settled))._tag).toBe("suspended")
      expect(events.filter((event) => event._tag === "model-parked")).toHaveLength(1)
      yield* awaitParked(engine, driveFlow)
      settled = Deferred.makeUnsafe<Outcome>()
      yield* TestClock.adjust("5 seconds")
      return yield* Deferred.await(settled)
    }).pipe(
      Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, Safety.layer)),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.scoped,
      Effect.runPromise
    )
    expect(outcome._tag).toBe("completed")
    expect(events.map((event) => event._tag).filter((tag) => tag === "model-parked" || tag === "model-unparked"))
      .toEqual(["model-parked", "model-unparked"])
  })

  it("starts retry-after at refusal time after a slow provider call", async () => {
    const events: AgentEvent.AgentEvent[] = []
    const completed = recordedCells([], ["ctx.done('done')"])
    let calls = 0
    const model = Model.make({
      stream: (request) =>
        Stream.unwrap(Effect.gen(function*() {
          if (calls++ > 0) return completed.stream(request)
          yield* TestClock.adjust("10 seconds")
          return Stream.fail(
            new ModelError({
              code: "rate_limited",
              message: "slow refusal",
              retryAfterMillis: 5_000,
              httpStatus: 429
            })
          )
        }))
    })
    const outcome = await Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const scope = yield* Effect.scope
      yield* TestClock.setTime(1_000)
      let settled = Deferred.makeUnsafe<Outcome>()
      yield* engine.register(driveFlow, () =>
        Effect.onExit(
          collect({ model, registry: registryOf([]), sink: events }),
          (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit)))
        ).pipe(Scope.provide(scope)))
      yield* engine.execute(driveFlow, { executionId: "exec-1", payload: {}, discard: true })
      expect((yield* Deferred.await(settled))._tag).toBe("suspended")
      expect(events.find((event) => event._tag === "model-parked")).toMatchObject({
        wakeAt: 16_000,
        source: "retry-after"
      })
      return yield* Deferred.await(settled)
    }).pipe(
      Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, Safety.layer)),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.scoped,
      Effect.runPromise
    )
    expect(outcome._tag).toBe("suspended")
    expect(events.map((event) => event._tag).filter((tag) => tag === "model-parked" || tag === "model-unparked"))
      .toEqual(["model-parked"])
  })

  it("pairs park and unpark when the provider's reset time is already past", async () => {
    const events: AgentEvent.AgentEvent[] = []
    const completed = recordedCells([], ["ctx.done('done')"])
    let calls = 0
    const model = Model.make({
      stream: (request) =>
        calls++ === 0
          ? Stream.fail(
            new ModelError({ code: "rate_limited", message: "window reopened", resetAtEpochMillis: 0, httpStatus: 429 })
          )
          : completed.stream(request)
    })
    const outcome = await drive(collect({ model, registry: registryOf([]), sink: events }))
    expect(outcome._tag).toBe("completed")
    expect(calls).toBe(2)
    expect(events.map((event) => event._tag).filter((tag) => tag === "model-parked" || tag === "model-unparked"))
      .toEqual(["model-parked", "model-unparked"])
  })

  it("refuses a park beyond the caller's wait ceiling", async () => {
    let calls = 0
    const model = Model.make({
      stream: () =>
        Stream.suspend(() => {
          calls++
          return Stream.fail(
            new ModelError({
              code: "rate_limited",
              message: "long window",
              resetAtEpochMillis: Date.now() + 60_000,
              httpStatus: 429
            })
          )
        })
    })
    const outcome = await drive(
      collect({ model, registry: registryOf([]), capacity: { park: true, maxParkMillis: 1000 } })
    )
    expect(outcome._tag).toBe("failed")
    expect(calls).toBe(1)
  })

  it("reports a text-derived reset as a default park", async () => {
    const events: AgentEvent.AgentEvent[] = []
    const model = Model.make({
      stream: () =>
        Stream.fail(
          new ModelError({
            code: "rate_limited",
            message: "retry after 30 seconds",
            httpStatus: 429
          })
        )
    })
    const outcome = await drive(collect({ model, registry: registryOf([]), sink: events }))
    expect(outcome._tag).toBe("suspended")
    expect(events.find((event) => event._tag === "model-parked")).toMatchObject({ source: "default" })
  })

  it("backs off when a seat refuses again immediately after an in-memory park", async () => {
    const events: AgentEvent.AgentEvent[] = []
    let calls = 0
    const model = Model.make({
      stream: () =>
        Stream.suspend(() => {
          calls++
          return Stream.fail(
            new ModelError(
              calls === 1
                ? { code: "rate_limited", message: "short wait", retryAfterMillis: 1, httpStatus: 429 }
                : { code: "rate_limited", message: "still limited", resetAtEpochMillis: 0, httpStatus: 429 }
            )
          )
        })
    })
    const outcome = await drive(collect({ model, registry: registryOf([]), sink: events }))
    expect(outcome._tag).toBe("suspended")
    expect(calls).toBe(2)
    const parks = events.filter((event) => event._tag === "model-parked")
    expect(parks).toHaveLength(2)
    expect(parks[1]!.wakeAt - parks[0]!.wakeAt).toBeGreaterThan(60_000)
  })

  it("waits twice when two parks use the same wake time", async () => {
    const names: string[] = []
    const originalSleep = DurableClock.sleep
    const sleep = vi.spyOn(DurableClock, "sleep").mockImplementation((options) => {
      names.push(options.name)
      return originalSleep(options)
    })
    try {
      const events: AgentEvent.AgentEvent[] = []
      const firstPark = Deferred.makeUnsafe<void>()
      const secondPark = Deferred.makeUnsafe<void>()
      const settled = Deferred.makeUnsafe<Outcome>()
      const completed = recordedCells([], ["ctx.done('done')"])
      let calls = 0
      let parksSeen = 0
      const model = Model.make({
        stream: (request) =>
          Stream.unwrap(Effect.gen(function*() {
            if (++calls === 3) return completed.stream(request)
            yield* TestClock.setTime(1_000)
            return Stream.fail(
              new ModelError({
                code: "rate_limited",
                message: "same reset",
                resetAtEpochMillis: 1_001,
                httpStatus: 429
              })
            )
          }))
      })
      const outcome = await Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const scope = yield* Effect.scope
        yield* TestClock.setTime(1_000)
        yield* engine.register(driveFlow, () =>
          Effect.onExit(
            collect({
              model,
              registry: registryOf([]),
              sink: events,
              observe: (event) =>
                event._tag === "model-parked"
                  ? Effect.sync(() => ++parksSeen).pipe(
                    Effect.flatMap((count) => Deferred.succeed(count === 1 ? firstPark : secondPark, undefined))
                  )
                  : Effect.void
            }),
            (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit)))
          ).pipe(Scope.provide(scope)))
        yield* Effect.forkScoped(engine.execute(driveFlow, { executionId: "exec-1", payload: {}, discard: true }))
        yield* Deferred.await(firstPark)
        yield* TestClock.adjust("1 millis")
        yield* Deferred.await(secondPark)
        yield* Effect.yieldNow
        expect(events.filter((event) => event._tag === "model-unparked")).toHaveLength(1)
        yield* TestClock.adjust("1 millis")
        return yield* Deferred.await(settled)
      }).pipe(
        Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, Safety.layer)),
        Effect.provide(TestClock.layer()),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.scoped,
        Effect.runPromise
      )
      expect(outcome._tag).toBe("completed")
      expect(calls).toBe(3)
      expect(events.filter((event) => event._tag === "model-parked").map((event) => event.wakeAt)).toEqual([
        1_001,
        1_001
      ])
      expect(events.map((event) => event._tag).filter((tag) => tag === "model-parked" || tag === "model-unparked"))
        .toEqual(["model-parked", "model-unparked", "model-parked", "model-unparked"])
      expect(names).toHaveLength(2)
      expect(new Set(names).size).toBe(2)
    } finally {
      sleep.mockRestore()
    }
  })
})

describe("supervisor memory through Agent.run", () => {
  it.each(
    [
      { mode: "recall", options: { banks: ["agent-repository"], remember: true } },
      { mode: "absent", options: { banks: ["agent-repository"], remember: true } },
      { mode: "failed", options: { banks: ["agent-repository"], remember: true } },
      { mode: "typed-failed", options: { banks: ["agent-repository"], remember: true } },
      // No namespace: no bank is read or written, never one global bank.
      { mode: "unnamed", options: { remember: true } },
      // A namespace but no opt-in: recalled, never written.
      { mode: "unopted", options: { banks: ["agent-repository"] } },
      // No declared bank: the envelope's exact memory grant names it, a glob
      // grant names none, and a read-only grant writes nothing even opted in.
      {
        mode: "enveloped",
        options: { remember: true },
        envelope: [
          new Capability.CapabilityPattern({ action: "memory:read", resource: "agent-repository" }),
          new Capability.CapabilityPattern({ action: "memory:read", resource: "agent-*" })
        ]
      }
    ] as const
  )("binds the host memory port when recall is $mode", async (row) => {
    const { mode, options } = row
    const envelope = "envelope" in row ? row.envelope : undefined
    const settled = Deferred.makeUnsafe<void>()
    const notes: Array<MemoryStore.PutNoteInput> = []
    const recalls: Array<Recall.Input> = []
    const snapshots: Array<Supervisor.Snapshot> = []
    const judged: Array<ReadonlyArray<Relevance.Item>> = []
    const warnings: Array<string> = []
    const failures: Array<AgentEvent.SupervisorMemoryFailed> = []
    const namespace = "repository"
    const sentence = "The repository runs its checks with tox and the key sk-live-abcdefghijklmnop."
    const stored = "The repository runs its checks with tox and the key [REDACTED_API_KEY]."
    const store = MemoryStore.makeNoop({
      getNote: () => Effect.succeed(undefined),
      putNote: (input) =>
        Effect.suspend(() => {
          notes.push(input)
          if (mode === "failed") return Effect.die(new Error("recorded memory write failure"))
          if (mode === "typed-failed") {
            return Effect.fail(new MemoryError.MemoryError({ code: "store", message: "notes locked" }))
          }
          return Effect.succeed({
            ...input,
            namespace: { kind: "agent" as const, id: namespace },
            status: "accepted" as const,
            createdAtMs: 1
          })
        })
    })
    const recall = Recall.Recall.of({
      recall: (input) =>
        Effect.suspend(() => {
          recalls.push(input)
          if (mode === "typed-failed") {
            return Effect.fail(new MemoryError.MemoryError({ code: "store", message: "recall locked" }))
          }
          return mode === "failed"
            ? Effect.die(new Error("recorded memory recall failure"))
            : Effect.succeed(Array.from({ length: 8 }, (_, index) => ({
              bank: `agent-${namespace}`,
              key: `note-${index}`,
              text: `Fact ${index}`,
              score: 1
            })))
        })
    })
    const mined: Array<ReadonlyArray<{ readonly text: string }>> = []
    const evaluator = Evaluator.layerScripted((request) => {
      if (Object.hasOwn(request.questions, "unnecessary_0")) {
        const items = (request.state as { readonly items: ReadonlyArray<Relevance.Item> }).items
        judged.push(items)
        return Object.fromEntries(items.map((_, index) => [`unnecessary_${index}`, { probability: 0.1 }]))
      }
      if (Object.hasOwn(request.questions, "durable_0")) {
        const items = (request.state as { readonly items: ReadonlyArray<{ readonly text: string }> }).items
        mined.push(items)
        return Object.fromEntries(
          items.flatMap((
            _,
            index
          ) => [[`durable_${index}`, { probability: 0.99 }], [`issue_${index}`, { probability: 0.01 }]])
        )
      }
      if (!Object.hasOwn(request.questions, "thrashing")) {
        return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
      }
      snapshots.push(Schema.decodeUnknownSync(Supervisor.Snapshot)(request.state))
      return Object.fromEntries(
        Object.keys(request.questions).map((key) => [
          key,
          key === "needs_help" ?
            { choice: "none" }
            : ["frustrated", "anxious", "scared", "confused", "confident"].includes(key) ?
            { score: 0 }
            : { probability: key === "on_target" ? 0.99 : 0.01 }
        ])
      )
    })
    const delegate = recordedCells([], ["console.log('observed')", "ctx.done('done')"])
    let calls = 0
    const model = Model.make({
      stream: (request) => {
        const first = calls++ === 0
        const response = delegate.stream(request).pipe(Stream.map((event) =>
          first && event.type === "text-delta"
            ? ModelEvent.ModelEvent.TextDelta({ ...event, text: `${sentence}\n\n${event.text}` })
            : event
        ))
        return first ? response : Stream.unwrap(Deferred.await(settled).pipe(Effect.as(response)))
      }
    })
    const outcome = await drive(
      collect({
        registry: registryOf([]),
        model,
        evaluator,
        supervisor: options,
        capabilityEnvelope: envelope,
        observe: (event) =>
          Effect.suspend(() => {
            if (event._tag === "supervisor-memory-failed") failures.push(event)
            return event._tag === "supervisor-settled" && event.frame === 0
              ? Deferred.succeed(settled, undefined).pipe(Effect.asVoid) :
              Effect.void
          })
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        mode === "absent" ? (effect) => effect : Effect.provideService(Recall.Recall, recall),
        Effect.provide(
          Logger.layer([Logger.make((entry) => warnings.push(String(entry.message)))], { mergeWithExisting: false })
        )
      )
    )
    expect(outcome._tag).toBe("completed")
    expect(snapshots.length).toBeGreaterThan(0)
    // Mined once, at run end, only where a bank can be written and the host opted in.
    const writes = mode !== "unnamed" && mode !== "unopted" && mode !== "enveloped"
    expect(mined).toEqual(writes ? [[{ text: stored }]] : [])
    // The recalled rows go through relevance, capped, as memory items keyed by row.
    expect(judged[0] ?? []).toEqual(
      mode === "recall" || mode === "unopted" || mode === "enveloped"
        ? Array.from(
          { length: Supervisor.recalledLimit },
          (_, index) => ({ kind: "memory", id: `note-${index}`, text: `Fact ${index}` })
        ) :
        []
    )
    // Written only when a namespace names the bank and the host opted in, and
    // then through the journal's secret redaction.
    expect(notes).toEqual(
      writes
        ? [{
          namespace: { kind: "agent", id: namespace },
          id: MemoryMine.noteId("agent-repository", stored),
          text: stored,
          tags: ["source:transcript"],
          provenance: { runId: "session-1" },
          status: "accepted"
        }]
        : []
    )
    expect(recalls).toEqual(
      mode === "absent" || mode === "unnamed" ? [] : [{
        banks: [`agent-${namespace}`],
        query: `The task for this run:\n\nwrite the first file\n${sentence}`,
        maxTokens: Supervisor.recalledLimit * 256
      }]
    )
    // A store that failed is journaled, typed, for a scorecard to count.
    const failed = mode === "failed" || mode === "typed-failed"
    expect(failures.map((event) => [event.operation, event.frame])).toEqual(
      failed ? [["recall", 0], ["remember", 1]] : []
    )
    expect(failures.map((event) => event.detail)).toEqual(
      mode === "typed-failed" ?
        ["store: recall locked", "store: notes locked"] :
        mode === "failed"
        ? ["The memory store failed unexpectedly", "The memory store failed unexpectedly"]
        : []
    )
    expect(warnings.filter((message) => message.includes("could not"))).toEqual(
      failed
        ? ["The supervisor could not recall memory", "The transcript miner could not write memory"] :
        []
    )
  })
})

describe("the run-start relevance reading through Agent.run", () => {
  it("never judges a core flow, judges a host source unless it is pinned, and shows instructions after the host system", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const evaluator = Evaluator.layerScripted((request) => {
      if (!Object.keys(request.questions).some((id) => id.startsWith("unnecessary_"))) {
        return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
      }
      const items = (request.state as { readonly items: ReadonlyArray<Relevance.Item> }).items
      asked.push(items.map((item) => item.id))
      return Object.fromEntries(items.map((_, index) => [`unnecessary_${index}`, { probability: 0.1 }]))
    })
    const path = Effect.runSync(Effect.provide(Effect.context<Path.Path>(), NodePath.layer))
    const host = (source: string, name: string) =>
      FlowBinding.source(source, [
        FlowBinding.make({ flow: StandardFlows.askFlow, name, handler: () => Effect.die("unused") })
      ])
    const requests: Array<string> = []
    const sink: Array<AgentEvent.AgentEvent> = []
    const outcome = await drive(collect({
      registry: registryOf([]),
      model: recordedCells(requests, ["ctx.done(\"done\")"]),
      evaluator,
      judged: true,
      sink,
      flows: [
        StandardFlows.filesystem(Context.merge(Context.make(FileSystem.FileSystem, FileSystem.makeNoop({})), path)),
        StandardFlows.shell(
          Context.merge(Context.make(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.makeNoop()), path)
        ),
        StandardFlows.jev(Effect.runSync(Effect.provide(Effect.context<Evaluator.Evaluator>(), evaluator))),
        host("host/lookup", "lookup"),
        host("host/pinned", "pinned")
      ],
      pinnedSources: ["host/pinned"],
      instructions: [{ path: "AGENTS.md", text: "- Use pnpm.\n" }]
    }))

    expect(outcome._tag).toBe("completed")
    expect(asked).toEqual([["lookup", "AGENTS.md#0"]])
    const pinned = sink.find((event) => event._tag === "discipline-armed")?.relevance?.pinned ?? []
    expect(pinned).toEqual(expect.arrayContaining(["read", "bash", "jev", "pinned"]))
    expect(pinned).not.toContain("lookup")
    const opening = requests[0] ?? ""
    expect(opening.indexOf("You are running inside a smoke test.")).toBeLessThan(opening.indexOf("- Use pnpm."))
    expect(opening.indexOf("- Use pnpm.")).toBeLessThan(opening.indexOf("The task for this run"))
  })
})

describe("Agent.run", () => {
  it.each([false, true])(
    "uses the resolved provider model id for an opaque seat alias (compaction: %s)",
    async (compact) => {
      const modelIds: Array<string> = []
      const routeModelIds: Array<string> = []
      const delegate = recordedCells([], [
        compact ? "throw new Error(\"detail \".repeat(12000))" : "ctx.done(\"done\")"
      ])
      const model = Model.make({
        stream: (request) => {
          modelIds.push(request.modelId)
          return delegate.stream(request)
        }
      })
      const resolver = SeatResolver.make({
        resolve: (id) =>
          Effect.succeed(Seat.make({
            id,
            modelId: "provider-model",
            model,
            route: {
              prepare: (request) => {
                routeModelIds.push(request.modelId)
                return Effect.succeed(prepared)
              }
            },
            contextWindowTokens: compact ? 40_000 : 200_000
          }))
      })
      const seat = await Effect.runPromise(resolver.resolve("reviewer"))
      const outcome = await drive(collect({ seat, registry: registryOf([]), model, maxFrames: 5 }))

      expect(outcome._tag).toBe("completed")
      expect(seat.id).toBe("reviewer")
      const events = outcome._tag === "completed" ? outcome.value as ReadonlyArray<AgentEvent.AgentEvent> : []
      expect(events.some((event) => event._tag === "compaction-settled")).toBe(compact)
      expect(modelIds.length).toBeGreaterThan(0)
      expect(new Set(modelIds)).toEqual(new Set(["provider-model"]))
      expect(routeModelIds.length).toBeGreaterThan(0)
      expect(new Set(routeModelIds)).toEqual(new Set(["provider-model"]))
    }
  )

  it("runs a whole cell frame on the assembled production stack", async () => {
    const requests: Array<string> = []
    const executed: Array<string> = []
    const activeSeatSamples: Array<number> = []
    const outcome = await drive(
      collect({
        registry: registryOf(flows),
        model: recordedWithSeatSamples(requests, activeSeatSamples),
        implementations: implementations(executed),
        activeSeatSamples
      })
    )

    expect(outcome._tag).toBe("completed")
    const events = outcome._tag === "completed" ? outcome.value as ReadonlyArray<AgentEvent.AgentEvent> : []
    const tags = events.map((event) => event._tag)

    // Two data-dependent calls in one frame, each its own boundary, and one
    // provider round trip for the whole thing.
    expect(tags.filter((tag) => tag === "cell-call-started")).toHaveLength(2)
    expect(executed).toEqual(["fs/list#0", "fs/write#1"])
    expect(requests).toHaveLength(1)
    expect(activeSeatSamples).toEqual([1, 0])

    // The composition taught the model the cell contract and disclosed exactly
    // the registry's model-invocable catalog.
    expect(requests[0]).toContain("You are running inside a smoke test.")
    expect(requests[0]).toContain("fs/list")
    expect(requests[0]).toContain("fs/write")
    expect(requests[0]).toContain("write the first file")

    const resolved = events.find((event) => event._tag === "resolved")
    expect(resolved?._tag === "resolved" ? resolved.message.content : []).toEqual([
      { type: "text", text: "wrote alpha.md" }
    ])
  })

  it("tells a run on a host that pins no trees that ctx.base is refused, and how to take a baseline", async () => {
    // Workers copied the contract's `{ at: ctx.base }` baseline eleven times on
    // a host with no store and were refused every time.
    const opening = async (checkpoints?: Checkpoints.Checkpoints) => {
      const requests: Array<string> = []
      await drive(collect({
        registry: registryOf(flows),
        model: recorded(requests),
        implementations: implementations([]),
        checkpoints
      }))
      return requests[0] ?? ""
    }
    expect(await opening()).toContain(Checkpointed.unpinnedFact)
    const store = Checkpoints.make({
      capture: (id) => Effect.succeed(new Checkpoints.Snapshot({ id, ref: "0".repeat(40) })),
      materialize: () => Effect.die("unused")
    })
    expect(await opening(store)).not.toContain(Checkpointed.unpinnedFact)
  })

  it("hides a flow the registry does not disclose, and refuses it catchably at the boundary", async () => {
    const requests: Array<string> = []
    const executed: Array<string> = []
    // `fs/write` exists but is not model-invocable: it must be absent from the
    // catalog, and calling it anyway must be a failure the cell could catch —
    // never a crash and never an execution.
    const outcome = await drive(
      collect({
        registry: registryOf([
          descriptor("fs/list", { tier: "sealed" }),
          descriptor("fs/write", { tier: "irreversible", modelInvocable: false })
        ]),
        model: recorded(requests),
        implementations: implementations(executed)
      })
    )

    expect(outcome._tag).toBe("completed")
    const events = outcome._tag === "completed" ? outcome.value as ReadonlyArray<AgentEvent.AgentEvent> : []
    expect(requests[0]).not.toContain("fs/write")
    expect(executed).toEqual(["fs/list#0"])

    // The refused call resolved with the failure envelope, so the cell ran to
    // its own end: durable evidence and a further frame, not a failed run.
    const settled = events.filter((event) => event._tag === "cell-settled")
    expect(settled.at(0)?._tag === "cell-settled" ? settled.at(0)?.outcome._tag : undefined).toBe("settled")
  })

  it("carries every declaration the host supplies through to the boundary", async () => {
    const requests: Array<string> = []
    const executed: Array<string> = []
    const authorized: Array<string> = []
    const outcome = await drive(
      Effect.gen(function*() {
        const agent = yield* Agent.Agent
        const events: Array<AgentEvent.AgentEvent> = []
        yield* agent.run({
          session: "session-2",
          seat: Seat.make({
            // A resolver may choose the declared name as the provider model id.
            id: "test-model",
            modelId: "test-model",
            model: recorded(requests),
            route,
            contextWindowTokens: 200_000
          }),
          prompt: "write the first file",
          registry: registryOf(flows),
          implementations: implementations(executed),
          promptRunner: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: "unused" })),
          authorize: (call) => Effect.sync(() => void authorized.push(call.flowName)),
          modelParams: ModelRequest.GenerationParams.make({ maxTokens: 512 }),
          layers: ["layer-a"],
          capabilityEnvelope: [],
          placement: Option.some("local"),
          maxFrames: 2,
          readOnlyCap: 5,
          modelCallMs: 45_000,
          repeatCap: 0,
          claimCap: 0,
          limits: { calls: 8 },
          judged: true
        }).pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.provide(Layer.merge(Agent.layerDefaults, scriptedCompletionJudge))
        )
        return events
      }).pipe(Effect.provide(Agent.layer))
    )

    expect(outcome._tag).toBe("completed")
    const events = outcome._tag === "completed" ? outcome.value as ReadonlyArray<AgentEvent.AgentEvent> : []

    // Authority is decided before each boundary opens, for every call.
    expect(authorized).toEqual(["fs/list", "fs/write"])
    expect(executed).toEqual(["fs/list#0", "fs/write#1"])

    // The resolved seat's id — not the record — is what the turn runs under.
    const opened = events.find((event) => event._tag === "turn-opened")
    expect(opened?._tag === "turn-opened" ? opened.seat : "").toBe("test-model")

    // Every armed budget the host declared reaches the controller and is
    // journaled as the host's number. A budget this surface cannot set is a
    // constant the run records as if it were a choice, and a grader reading
    // `discipline-armed` cannot tell the two apart.
    const armed = events.find((event) => event._tag === "discipline-armed")
    expect(armed).toMatchObject({
      readOnlyCap: 5,
      modelCallMs: 45_000,
      repeatCap: 0,
      claimCap: 0,
      maxFrames: 2,
      judged: true
    })

    // The declared layer set and session reach the call identity, which is what
    // the durable key is derived from.
    const started = events.filter((event) => event._tag === "cell-call-started")
    const settlements = events.filter((event) => event._tag === "cell-call-settled")
    expect(settlements.map((event) => event.identity)).toEqual(started.map((event) => event.call.identity))
    expect(started.map((event) => event._tag === "cell-call-started" ? event.call.identity.session : "")).toEqual([
      "session-2",
      "session-2"
    ])
    const identities = started.map((event) => event._tag === "cell-call-started" ? event.call.identity.layers : [])
    expect(identities.every((layers) => layers.includes("layer-a"))).toBe(true)
    expect(
      identities.every((layers) => layers.some((layer) => layer.startsWith("flows/cell-composition/v1:")))
    ).toBe(true)
  })

  it("dispatches ordered harness plugins with apply and enforce semantics", async () => {
    const requests: Array<string> = []
    const decorate = (registry: Registry.Registry, label: string): Registry.Registry => {
      const transform = (entry: Descriptor.FlowDescriptor): Descriptor.FlowDescriptor =>
        new Descriptor.FlowDescriptor({ ...entry, description: `${entry.description}|${label}` })
      return Registry.makeNoop({
        list: () => Effect.map(registry.list(), (entries) => entries.map(transform)),
        visible: () => Effect.map(registry.visible(), (entries) => entries.map(transform)),
        get: (name) => Effect.map(registry.get(name), transform),
        getOption: (name) => Effect.map(registry.getOption(name), Option.map(transform)),
        loadBody: registry.loadBody,
        runPrompt: registry.runPrompt,
        refresh: registry.refresh,
        warnings: registry.warnings
      })
    }
    const plugin = (
      name: string,
      label: string,
      options: {
        readonly enforce?: "pre" | "post" | undefined
        readonly apply?: "engine" | "harness" | ((config: FlowsConfig) => boolean) | undefined
      } = {}
    ) =>
      makePlugin<FlowsHooks>({
        name,
        ...(options.enforce === undefined ? {} : { enforce: options.enforce }),
        ...(options.apply === undefined ? {} : { apply: options.apply }),
        hooks: {
          cellRegistry: (registry) => Effect.succeed(decorate(registry, label)),
          cellModelRequest: (request) =>
            Effect.succeed(ModelRequest.ModelRequest.make({
              ...request,
              system: [...request.system, ModelRequest.SystemPart.make({ text: `plugin:${label}` })]
            }))
        }
      })

    const outcome = await drive(
      collect({
        registry: registryOf(flows),
        model: recorded(requests),
        implementations: implementations([]),
        config: { enableNormal: true },
        plugins: [
          plugin("normal", "normal", { apply: (config) => config.enableNormal === true }),
          plugin("excluded", "excluded", { apply: "engine" }),
          plugin("pre", "pre", { enforce: "pre", apply: "harness" }),
          plugin("post-excluded", "post-excluded", { enforce: "post", apply: () => false })
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain("The fs/list flow.|pre|normal")
    expect(requests[0]).toContain("plugin:pre\nplugin:normal")
    expect(requests[0]).not.toContain("excluded")
  })

  it("journals the request a plugin rewrote, and runs that plugin once per model call", async () => {
    const requests: Array<string> = []
    const events: Array<AgentEvent.AgentEvent> = []
    let rewrites = 0
    const outcome = await drive(
      collect({
        registry: registryOf([]),
        model: recorded(requests),
        maxFrames: 1,
        capacity: { park: false },
        plugins: [makePlugin<FlowsHooks>({
          name: "request-addendum",
          hooks: {
            cellModelRequest: (request) =>
              Effect.sync(() => {
                rewrites++
                return ModelRequest.ModelRequest.make({
                  ...request,
                  system: [...request.system, ModelRequest.SystemPart.make({ text: "plugin:addendum" })]
                })
              })
          }
        })]
      }).pipe(Effect.tap((collected) => Effect.sync(() => events.push(...collected))))
    )

    expect(outcome._tag).toBe("completed")
    const asked = events.filter((event) => event._tag === "model-requested")
    expect(asked).toHaveLength(requests.length)
    // The record is of the call that was made. The controller never saw the
    // addendum; the provider did, and so does whoever reopens this step.
    expect(asked[0]?.request.system.at(-1)?.text).toBe("plugin:addendum")
    expect(requests[0]).toContain("plugin:addendum")
    expect(asked[0]?.binding).toEqual(new EngineLike.Binding({ routeId: "route-a", protocolId: "test-protocol" }))
    // Recording the request must not cost the composition a second run of its
    // hooks: a plugin that counts, meters or logs sees one call per model call.
    expect(rewrites).toBe(requests.length)
  })

  it("fails the step on a request plugin that fails once, runs it once, and records no request it never sent", async () => {
    const requests: Array<string> = []
    const events: Array<AgentEvent.AgentEvent> = []
    let runs = 0
    const outcome = await drive(
      collect({
        registry: registryOf([]),
        model: recorded(requests),
        maxFrames: 1,
        capacity: { park: false },
        sink: events,
        plugins: [makePlugin<FlowsHooks>({
          name: "fails-once",
          hooks: {
            // The first ask fails and every later one would rewrite: a second
            // run of the waterfall would send a request no record describes.
            cellModelRequest: (request) =>
              Effect.suspend(() =>
                ++runs === 1
                  ? Effect.fail(new Error("lookup failed"))
                  : Effect.succeed(ModelRequest.ModelRequest.make({
                    ...request,
                    system: [...request.system, ModelRequest.SystemPart.make({ text: "plugin:addendum" })]
                  }))
              )
          }
        })]
      })
    )

    expect(outcome).toMatchObject({
      _tag: "failed",
      error: { code: "engine_failed", cause: { code: "hook_failed", plugin: "fails-once", hook: "cellModelRequest" } }
    })
    expect(runs).toBe(1)
    expect(requests).toHaveLength(0)
    expect(events.filter((event) => event._tag === "model-requested")).toHaveLength(0)
  })

  it("runs every request plugin once for a model call the waterfall fails", async () => {
    const events: Array<AgentEvent.AgentEvent> = []
    let metered = 0
    const outcome = await drive(
      collect({
        registry: registryOf([]),
        model: recorded([]),
        maxFrames: 1,
        sink: events,
        plugins: [
          makePlugin<FlowsHooks>({
            name: "meter",
            hooks: { cellModelRequest: () => Effect.sync(() => void metered++) }
          }),
          makePlugin<FlowsHooks>({
            name: "failing-request",
            hooks: { cellModelRequest: () => Effect.fail(new Error("request hook failed")) }
          })
        ]
      })
    )

    expect(outcome).toMatchObject({
      _tag: "failed",
      error: { code: "engine_failed", cause: { code: "hook_failed", plugin: "failing-request" } }
    })
    expect(metered).toBe(1)
    // The un-rewritten request was never sent, so no record presents it as sent.
    expect(events.filter((event) => event._tag === "model-requested")).toHaveLength(0)
  })

  it("reports config observer failures without exposing their causes or failing the run", async () => {
    const logs: Array<{
      readonly message: unknown
      readonly annotations: Readonly<Record<string, unknown>>
      readonly renderedCause: string
    }> = []
    const capture = Logger.make((entry) => {
      if (String(entry.message).includes("plugin configuration observer")) {
        logs.push({
          message: entry.message,
          annotations: entry.fiber.getRef(References.CurrentLogAnnotations),
          renderedCause: String(entry.cause)
        })
      }
    })
    const outcome = await drive(
      collect({
        registry: registryOf([]),
        model: recorded([]),
        plugins: [makePlugin<FlowsHooks>({
          name: "failing-observer",
          hooks: { configResolved: () => Effect.fail({ secret: "must-not-log" }) }
        })]
      }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })))
    )

    expect(outcome._tag).toBe("completed")
    expect(logs).toHaveLength(1)
    expect(logs[0]?.annotations).toMatchObject({
      pluginErrorCode: "hook_failed",
      pluginName: "failing-observer",
      pluginHook: "configResolved"
    })
    expect(JSON.stringify(logs)).not.toContain("must-not-log")
  })

  it("injects only an explicitly selected memory snapshot and keeps it across a durable restart", async () => {
    const rows: ReadonlyArray<SnapshotRecorder.Row> = [
      { origin: "primer", bank: "selected", key: "note-1", text: "use pnpm" },
      { origin: "recall", bank: "selected", key: "deploy", text: "deploy from release" },
      { origin: "recall", bank: "selected", key: "fact", text: "exact memory" }
    ]
    const selected = await Effect.runPromise(
      MemorySource.declared(
        { read: () => Effect.succeed({ rows }) },
        { lineageId: "lineage-1", iteration: 0, banks: ["selected"], query: "task" }
      ).pipe(
        // The source is a literal; the declared store and recall services are
        // required by the signature but never reached.
        Effect.provideService(MemoryStore.MemoryStore, MemoryStore.makeNoop()),
        Effect.provideService(Recall.Recall, Recall.makeNoop())
      )
    )
    const kept = MemorySource.render([rows[0]!, rows[2]!])
    // Jev withholds the deploy row; every other item is kept.
    const asked: Array<ReadonlyArray<Relevance.Item>> = []
    const evaluator = Evaluator.layerScripted((request) => {
      if (!Object.keys(request.questions).some((id) => id.startsWith("unnecessary_"))) {
        return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
      }
      const items = (request.state as { readonly items: ReadonlyArray<Relevance.Item> }).items
      asked.push(items)
      return Object.fromEntries(
        items.map((item, index) => [`unnecessary_${index}`, { probability: item.id === "deploy" ? 0.95 : 0.1 }])
      )
    })
    const selectedRequests: Array<string> = []
    let permitted = false
    const selectedOutcome = await drive(
      collect({
        registry: registryOf([descriptor("fs/write", { tier: "irreversible" })]),
        model: recordedCells(selectedRequests, [
          "await ctx.call(\"fs/write\", { path: \"alpha.md\", text: \"done\" }); console.log(\"next\")",
          "ctx.done(\"done\")"
        ]),
        implementations: implementations([]),
        authorize: () =>
          Effect.suspend(() => {
            if (permitted) return Effect.void
            permitted = true
            return Effect.fail(
              new HarnessError({
                code: "engine_failed",
                message: "permission required",
                cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(
                  new Permission.PermissionRequired({
                    requestId: "memory-restart",
                    capability: Capability.make("fs:write", "**"),
                    tier: "irreversible",
                    meta: {}
                  })
                )
              })
            )
          }),
        memory: selected,
        judged: true,
        evaluator
      }),
      { resume: true }
    )
    const unselectedRequests: Array<string> = []
    const unselectedOutcome = await drive(
      collect({
        registry: registryOf([]),
        model: recordedCells(unselectedRequests, ["ctx.done(\"done\")"])
      })
    )

    expect(selectedOutcome._tag).toBe("completed")
    expect(unselectedOutcome._tag).toBe("completed")
    expect(selectedRequests).toHaveLength(2)
    expect(selectedRequests.every((request) => request.includes(kept))).toBe(true)
    // The resumed frame opens on the byte-identical prefix the first attempt sent.
    const opening = (request: string) => request.slice(0, request.indexOf("The task for this run"))
    expect(opening(selectedRequests[1]!)).toBe(opening(selectedRequests[0]!))
    expect(selectedRequests.every((request) => !request.includes("deploy from release"))).toBe(true)
    // One reading across the first attempt and the resume.
    expect(asked).toHaveLength(1)
    expect(asked[0]!.filter((item) => item.kind === "memory").map((item) => item.id)).toEqual([
      "note-1",
      "deploy",
      "fact"
    ])
    expect(unselectedRequests.every((request) => !request.includes("exact memory"))).toBe(true)
  })

  const noTestEdits = Monitor.make({
    _tag: "Questioned",
    id: "no_test_edits",
    kind: "lint",
    question: Classifier.boolean({
      instructions: "Did the newest frames edit a test?",
      criteria: { true: "a test file was edited", false: "no test file was edited" }
    }),
    say: () => "Leave the tests alone."
  })

  it("arms and asks a monitor a cellMonitors plugin adds", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const read = Deferred.makeUnsafe<void>()
    const judge = Effect.runSync(Effect.provide(Effect.context<Evaluator.Evaluator>(), scriptedJudgeAll))
    const evaluator = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
      evaluate: (request) => {
        const ids = Object.keys(request.questions)
        if (ids.includes(Monitor.questionId("no_test_edits"))) {
          asked.push(ids)
          Deferred.doneUnsafe(read, Exit.void)
        }
        return Context.get(judge, Evaluator.Evaluator).evaluate(request)
      }
    }))
    const cells = recordedCells([], ["console.log(\"one\")", "ctx.done(\"done\")"])
    let ordinal = 0
    const model = Model.make({
      stream: (request) =>
        ordinal++ === 0 ? cells.stream(request) : Stream.unwrap(Effect.as(Deferred.await(read), cells.stream(request)))
    })
    const sink: Array<AgentEvent.AgentEvent> = []
    const outcome = await drive(collect({
      registry: registryOf([]),
      model,
      evaluator,
      judged: true,
      sink,
      plugins: [makePlugin<FlowsHooks>({
        name: "monitors",
        hooks: { cellMonitors: (monitors) => Effect.succeed([...monitors, noTestEdits]) }
      })]
    }))

    expect(outcome._tag).toBe("completed")
    const armed = sink.find((event) => event._tag === "discipline-armed")?.monitors?.map((monitor) => monitor.id)
    expect(armed).toEqual([...Monitor.defaults().map((monitor) => monitor.id), "no_test_edits"])
    expect(asked[0]).toContain("monitor_no_test_edits")
  })

  it("fails a run whose monitors repeat an id before any model request", async () => {
    const requests: Array<string> = []
    const outcome = await drive(collect({
      registry: registryOf([]),
      model: recorded(requests),
      supervisor: { monitors: [noTestEdits] },
      plugins: [makePlugin<FlowsHooks>({
        name: "duplicate",
        hooks: { cellMonitors: (monitors) => Effect.succeed([...monitors, noTestEdits]) }
      })]
    }))

    expect(outcome).toMatchObject({
      _tag: "failed",
      error: { code: "assembly_failed", message: "id is declared twice", cause: { id: "no_test_edits" } }
    })
    expect(requests).toEqual([])
  })

  it("preserves a request-hook failure as typed plugin cause at the harness boundary", async () => {
    const outcome = await drive(
      collect({
        registry: registryOf([]),
        model: recorded([]),
        plugins: [makePlugin<FlowsHooks>({
          name: "failing-request",
          hooks: {
            cellModelRequest: () => Effect.fail(new Error("request hook failed"))
          }
        })]
      })
    )

    expect(outcome).toMatchObject({
      _tag: "failed",
      error: {
        code: "engine_failed",
        cause: { code: "hook_failed", plugin: "failing-request", hook: "cellModelRequest" }
      }
    })
  })

  it("rejects non-JSON config before it enters durable composition identity", async () => {
    const outcome = await drive(
      collect({
        registry: registryOf([]),
        model: recorded([]),
        config: { invalidIdentity: () => "not-json" } as unknown as FlowsConfig
      })
    )

    // What this package owes its caller is that a config value the composition
    // identity cannot hash never reaches the identity at all, and that the
    // refusal names the key. `@smthrs/plugin` owns the admission gate that now
    // raises it and owns the wording, so the sentence itself is asserted
    // loosely: pinning a sibling's prose here turns a copy edit there into a
    // red suite in this package.
    expect(outcome).toMatchObject({
      _tag: "failed",
      error: { code: "config_invalid", path: "$.invalidIdentity" }
    })
    expect((outcome as { readonly error: { readonly message: string } }).error.message).toContain("JSON")
  })

  it("puts ordered plugin and config semantics into every cell-call identity", async () => {
    const first = makePlugin<FlowsHooks>({ name: "first" })
    const second = makePlugin<FlowsHooks>({ name: "second" })
    const identityFor = async (
      plugins: PluginInput<FlowsHooks>,
      config: FlowsConfig
    ): Promise<ReadonlyArray<string>> => {
      const outcome = await drive(
        collect({
          registry: registryOf(flows),
          model: recorded([]),
          implementations: implementations([]),
          plugins,
          config
        })
      )
      expect(outcome._tag).toBe("completed")
      const events = outcome._tag === "completed" ? outcome.value as ReadonlyArray<AgentEvent.AgentEvent> : []
      const started = events.find((event) => event._tag === "cell-call-started")
      return started?._tag === "cell-call-started" ? started.call.identity.layers : []
    }

    const a = await identityFor([first, second], { semantic: { mode: "a" } })
    const replay = await identityFor([first, second], { semantic: { mode: "a" } })
    const reordered = await identityFor([second, first], { semantic: { mode: "a" } })
    const reconfigured = await identityFor([first, second], { semantic: { mode: "b" } })

    expect(replay).toEqual(a)
    expect(reordered).not.toEqual(a)
    expect(reconfigured).not.toEqual(a)
  })
})

describe("Agent service", () => {
  /**
   * `Service.run` declares the four services the production loop needs, so a
   * noop's stream carries them in its type even though it touches none of
   * them. Erasing the requirement is safe here and nowhere else.
   */
  type Collected = Effect.Effect<Array<AgentEvent.AgentEvent>, HarnessError | PluginError>

  const collect = (
    stream: ReturnType<Agent.Service["run"]>
  ): Promise<Array<AgentEvent.AgentEvent>> => Effect.runPromise(Stream.runCollect(stream) as Collected)

  const options: Agent.Options = {
    session: "session-noop",
    seat: Seat.make({
      id: "anthropic:test-model",
      modelId: "test-model",
      model: recorded([]),
      route,
      contextWindowTokens: 0
    }),
    prompt: "nothing to do",
    registry: registryOf([])
  }
  const aborted = new AgentEvent.Aborted({
    eventType: "flows.harness.aborted.v1",
    reason: "the scripted agent stopped"
  })

  it("emits nothing from the noop, and takes an override for the one method", async () => {
    const noop = await collect(Agent.makeNoop().run(options))
    expect(noop).toEqual([])

    const scripted = Agent.makeNoop({ run: () => Stream.fromIterable([aborted]) })
    expect(await collect(scripted.run(options))).toEqual([aborted])
  })

  it("provides the noop as a layer, so a composition can be built without a model", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function*() {
        const agent = yield* Agent.Agent
        return yield* Stream.runCollect(agent.run(options))
      }).pipe(Effect.provide(Agent.layerNoop())) as Collected
    )
    expect(collected).toEqual([])
  })
})
