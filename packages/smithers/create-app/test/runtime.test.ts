/**
 * `materializeFlow` is where a flow file's declaration and its resolved
 * `AGENT.ts` meet, so what it names and in which order it stacks the system
 * teaching is the contract. `layerFor` must also carry declared budgets into
 * the real host and refuse cells and runs at those boundaries.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as EventSink from "@smthrs/agent/EventSink"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as Capability from "@smthrs/capability/Capability"
import { Interpreter } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { defineAgent, defineFlow, defineSandbox, defineTools, type ToolsGrant, type ToolsSpec } from "../src/app.ts"
import { emptyRegistry, LayerError, layerFor, materializeFlow } from "../src/runtime.ts"
import { preparedRequest } from "../src/testing.ts"

const spec = defineFlow({
  description: "Answers a topic in one line.",
  payload: { topic: Schema.String },
  output: Schema.Struct({ answer: Schema.String }),
  prompt: ({ topic }) => `Answer in one line: ${topic}`,
  system: ["Keep it to one sentence."]
})

const agent = defineAgent({ seat: "test:scripted", system: ["You are a test agent."] })

describe("materializeFlow", () => {
  it("names the action and the flow after the routed id", () => {
    const materialized = materializeFlow("build/plan", spec, agent)
    expect(materialized.id).toBe("build/plan")
    expect(materialized.action.name).toBe("app/build/plan/agent")
    expect(materialized.flow._tag).toBe("app/build/plan")
  })

  it("accepts a flow that adds no teaching of its own", () => {
    const bare = defineFlow({
      description: "Echoes.",
      payload: { topic: Schema.String },
      output: Schema.Struct({ answer: Schema.String }),
      prompt: ({ topic }) => topic
    })
    expect(materializeFlow("echo", bare, agent).action.name).toBe("app/echo/agent")
  })
})

describe("layer inputs", () => {
  it("composes without a separate judge credential and refuses a missing seat", async () => {
    const options = {
      agent,
      sandbox: defineSandbox({ limits: {} }),
      tools: defineTools({ sources: [] }),
      seats: { resolve: () => Effect.fail(new Seat.SeatUnresolved({ seat: agent.seat, message: "missing" })) },
      crypto: NodeCrypto.layer
    }
    const result = await Effect.runPromise(Effect.result(
      Effect.flatMap(Evaluator.Evaluator, (judge) => judge.evaluate({ state: {}, questions: {} }))
        .pipe(Effect.provide(layerFor(options)))
    ))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure).toMatchObject({ code: "unreachable" })
  })

  for (
    const { name, declaredAgent, sandbox, limits, maxFrames } of [
      {
        name: "explicit",
        declaredAgent: defineAgent({ seat: "s", system: [], limits: { calls: 4 }, maxFrames: 3 }),
        sandbox: defineSandbox({ limits: { heapBytes: 1024, interruptChecks: 10, wallClockMs: 5 } }),
        limits: { calls: 4, memoryBytes: 1024, steps: 10, totalMs: 5 },
        maxFrames: 3
      },
      {
        name: "zero",
        declaredAgent: defineAgent({ seat: "s", system: [], limits: { calls: 0 }, maxFrames: 0 }),
        sandbox: defineSandbox({ limits: { heapBytes: 0, interruptChecks: 0, wallClockMs: 0 } }),
        limits: { calls: 0, memoryBytes: 0, steps: 0, totalMs: 0 },
        maxFrames: 0
      },
      {
        name: "omitted",
        declaredAgent: defineAgent({ seat: "s", system: [] }),
        sandbox: defineSandbox({ limits: {} }),
        limits: { calls: 16, memoryBytes: undefined, steps: undefined, totalMs: undefined },
        maxFrames: 8
      }
    ]
  ) {
    it(`projects ${name} budgets onto the built AgentAction.Host`, async () => {
      const host = await Effect.runPromise(
        AgentAction.Host.pipe(Effect.provide(layerFor({
          agent: declaredAgent,
          sandbox,
          tools: defineTools({ sources: [] }),
          seats: { resolve: () => Effect.die("host inspection must not resolve a seat") },
          evaluator: ScriptedJudge.layer,
          crypto: NodeCrypto.layer
        })))
      )
      expect(host.limits).toStrictEqual(limits)
      expect(host.maxFrames).toBe(maxFrames)
      expect(host.flows).toEqual([])
    })
  }

  it("compiles the QuickJS build a host names through sandboxVariant", async () => {
    const options = {
      agent: defineAgent({ seat: "s", system: [] }),
      sandbox: defineSandbox({ limits: {} }),
      tools: defineTools({ sources: [] }),
      seats: { resolve: () => Effect.die("host inspection must not resolve a seat") },
      evaluator: ScriptedJudge.layer,
      crypto: NodeCrypto.layer
    }
    const named = await Effect.runPromise(
      AgentAction.Host.pipe(Effect.provide(layerFor({ ...options, sandboxVariant: QuickJSSandbox.layerVariantLive })))
    )
    expect(named.flows).toEqual([])
    // A build that cannot load must fail the host, which proves the option is
    // what the sandbox compiles rather than an ignored field.
    const unloadable = {} as Parameters<typeof QuickJSSandbox.layerVariant>[0]
    await expect(
      Effect.runPromise(
        AgentAction.Host.pipe(
          Effect.provide(layerFor({ ...options, sandboxVariant: QuickJSSandbox.layerVariant(unloadable) }))
        )
      )
    ).rejects.toThrow()
  })

  it("shows a cell an empty catalog", async () => {
    const registry = emptyRegistry()
    expect(await Effect.runPromise(registry.list())).toEqual([])
    expect(await Effect.runPromise(registry.visible())).toEqual([])
    expect(Option.isNone(await Effect.runPromise(registry.getOption("anything")))).toBe(true)
  })
})

describe("runtime budget boundaries", () => {
  for (const exceedsCalls of [true, false]) {
    it(`refuses a flow at its ${exceedsCalls ? "call and frame" : "frame"} budget`, async () => {
      let modelCalls = 0
      const toolCalls: Array<number> = []
      const events: Array<AgentEvent.AgentEvent> = []
      const tool = FlowBinding.make({
        flow: {
          name: "test/tick",
          input: Schema.Struct({ index: Schema.Number }),
          output: Schema.Number,
          capabilities: [],
          effects: undefined
        },
        handler: ({ index }) =>
          Effect.sync(() => {
            toolCalls.push(index)
            return index
          })
      })
      // The over-budget cell would complete if its second call were admitted.
      // The other cell stays within the call budget but never completes, so
      // only the frame budget prevents another model request.
      const cell = exceedsCalls
        ? `for (let index = 0; index < 2; index++) await ctx.call("test/tick", { index });
           await ctx.done({ answer: "over budget" })`
        : `await ctx.call("test/tick", { index: 0 })`
      const model = Model.make({
        stream: () =>
          Stream.suspend(() => {
            modelCalls++
            return Stream.fromIterable([
              ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
              ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
              ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
              ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
            ])
          })
      })
      const declaredAgent = defineAgent({ seat: "test:scripted", system: [], limits: { calls: 1 }, maxFrames: 2 })
      const materialized = materializeFlow("budget", spec, declaredAgent)
      const host = layerFor({
        agent: declaredAgent,
        sandbox: defineSandbox({ limits: { heapBytes: 32 * 1024 * 1024, wallClockMs: 10_000 } }),
        tools: defineTools({ sources: [FlowBinding.source("test", [tool])] }),
        seats: { resolve: () => Effect.succeed({ model, route: { prepare: () => Effect.succeed(preparedRequest) } }) },
        evaluator: ScriptedJudge.layer,
        crypto: NodeCrypto.layer
      })
      const runtime = Layer.mergeAll(materialized.action.layer, Interpreter.layer(materialized.flow)).pipe(
        Layer.provideMerge(host)
      )
      const exit = await Effect.runPromise(
        materialized.flow.execute({ topic: "budgets" }, { executionId: `budget/${exceedsCalls}` }).pipe(
          Effect.provide(runtime),
          Effect.provideService(EventSink.EventSink, {
            emit: (event) =>
              Effect.sync(() => {
                events.push(event)
              })
          }),
          Effect.exit
        )
      )

      expect(modelCalls).toBe(2)
      expect(toolCalls).toEqual([0, 0])
      expect(exit).toMatchObject({ _tag: "Failure" })
      expect(JSON.stringify(exit)).toContain("FramesExhausted")
      expect(JSON.stringify(exit)).toContain("ended without a completed answer after 2 frames")
      const outcomes = events.filter((event) => event._tag === "cell-settled").map((event) => event.outcome)
      expect(outcomes).toHaveLength(2)
      if (exceedsCalls) {
        for (const outcome of outcomes) {
          expect(outcome).toMatchObject({
            _tag: "rejected",
            code: "limit_exceeded",
            message: "This cell exceeded its limit of 1 flow calls"
          })
        }
      } else {
        expect(outcomes.every((outcome) => outcome._tag === "settled")).toBe(true)
      }
    })
  }
})

/**
 * `defineTools` without a grant is the empty envelope, so a bound tool's
 * declared capability is refused until `TOOLS.ts` grants it. The all-action
 * grant is an explicit opt-in.
 */
describe("defineTools default envelope", () => {
  const run = async (grant: ReadonlyArray<ToolsGrant> | undefined) => {
    const calls: Array<string> = []
    const events: Array<AgentEvent.AgentEvent> = []
    const tool = FlowBinding.make({
      flow: {
        name: "test/read",
        input: Schema.Struct({ path: Schema.String }),
        output: Schema.String,
        capabilities: ["fs:read:**"],
        effects: undefined
      },
      handler: ({ path }) =>
        Effect.sync(() => {
          calls.push(path)
          return path
        })
    })
    // A refused call resolves to the refusal, so the answer carries it.
    const cell = `const result = await ctx.call("test/read", { path: "a" });
       await ctx.done({ answer: JSON.stringify(result) })`
    const model = Model.make({
      stream: () =>
        Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
    })
    const declaredAgent = defineAgent({ seat: "test:scripted", system: [], maxFrames: 1 })
    const materialized = materializeFlow("grant", spec, declaredAgent)
    const sources = [FlowBinding.source("test", [tool])]
    const host = layerFor({
      agent: declaredAgent,
      sandbox: defineSandbox({ limits: { heapBytes: 32 * 1024 * 1024, wallClockMs: 10_000 } }),
      tools: grant === undefined ? defineTools({ sources }) : defineTools({ sources, grant }),
      seats: { resolve: () => Effect.succeed({ model, route: { prepare: () => Effect.succeed(preparedRequest) } }) },
      evaluator: ScriptedJudge.layer,
      crypto: NodeCrypto.layer
    })
    const runtime = Layer.mergeAll(materialized.action.layer, Interpreter.layer(materialized.flow)).pipe(
      Layer.provideMerge(host)
    )
    await Effect.runPromise(
      materialized.flow.execute({ topic: "grants" }, { executionId: `grant/${grant === undefined}` }).pipe(
        Effect.provide(runtime),
        Effect.provideService(EventSink.EventSink, {
          emit: (event) =>
            Effect.sync(() => {
              events.push(event)
            })
        }),
        Effect.exit
      )
    )
    const outcomes = events.filter((event) => event._tag === "cell-settled").map((event) => event.outcome)
    return { calls, outcomes }
  }

  it("refuses a bound tool's declared capability when TOOLS.ts omits the grant", async () => {
    const { calls, outcomes } = await run(undefined)
    expect(calls).toEqual([])
    expect(JSON.stringify(outcomes)).toContain("capability_refused")
  })

  it("admits the declared capability under an explicit all-action grant", async () => {
    const { calls, outcomes } = await run([{ action: "*", resource: "*" }])
    expect(calls).toEqual(["a"])
    expect(JSON.stringify(outcomes)).not.toContain("capability_refused")
  })
})

/**
 * A `TOOLS.ts` grant reaches the kernel's pattern grammar, and the two ways it
 * can be wrong are refused where the author can act on them.
 *
 * `defineTools` types `action` as the capability package's closed
 * `PatternAction`, so a `TOOLS.ts` cannot express an unknown action. A spec
 * built by hand can: the aomi Worker rebuilds one from a routed table's
 * sources, and a JSON round trip erases the union. That is the path these
 * cases drive, through the public `layerFor` seam rather than the private
 * decoder, because `layerFor` is what a host calls.
 */
describe("grant refusals", () => {
  const seats = { resolve: () => Effect.die("unused") as never }
  const sandbox = defineSandbox({ limits: { heapBytes: 1024, interruptChecks: 10, wallClockMs: 5 } })
  const host = (grant: ReadonlyArray<ToolsGrant>): unknown => {
    const tools: ToolsSpec = { _tag: "ToolsSpec", sources: [], grant }
    return layerFor({
      agent: defineAgent({ seat: "s", system: [] }),
      sandbox,
      tools,
      seats,
      evaluator: ScriptedJudge.layer,
      crypto: NodeCrypto.layer
    })
  }
  const refusal = (grant: ReadonlyArray<ToolsGrant>): LayerError => {
    try {
      host(grant)
    } catch (cause) {
      if (cause instanceof LayerError) return cause
      throw cause
    }
    throw new Error(`layerFor accepted ${JSON.stringify(grant)}`)
  }

  it("refuses an action the kernel's grammar does not know", () => {
    const error = refusal([{ action: "summon" as never, resource: "*" }])
    expect(error).toBeInstanceOf(LayerError)
    expect(error.name).toBe("LayerError")
    expect(error.code).toBe("invalid_grant")
    expect(error.message).toContain("grant[0].action")
    expect(error.message).toContain("\"summon\"")
  })

  it("routes a refused grant to its catchTag handler with the code", () => {
    const error = refusal([{ action: "summon" as never, resource: "*" }])
    const handled = Effect.runSync(
      Effect.fail(error).pipe(Effect.catchTag("create-app/LayerError", (caught) => Effect.succeed(caught.code)))
    )
    expect(handled).toBe("invalid_grant")
  })

  it("names the offending grant's own index, not the first", () => {
    const error = refusal([{ action: "*", resource: "*" }, { action: "summon" as never, resource: "*" }])
    expect(error.message).toContain("grant[1].action")
    expect(error.message).not.toContain("grant[0]")
  })

  it("refuses a resource longer than the kernel matches", () => {
    const resource = "a".repeat(Capability.maxResourceLength + 1)
    const error = refusal([{ action: "*", resource }])
    expect(error.code).toBe("invalid_grant")
    expect(error.message).toContain("grant[0].resource")
    expect(error.message).toContain(String(Capability.maxResourceLength + 1))
    expect(error.message).toContain(String(Capability.maxResourceLength))
  })

  it("accepts a resource at exactly the limit, so the bound is not off by one", () => {
    expect(host([{ action: "*", resource: "a".repeat(Capability.maxResourceLength) }])).toBeDefined()
  })
})
