import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentAction from "../src/AgentAction.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
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

/**
 * A model that answers with one scripted cell per call and records the prompt
 * it was given, so the test can assert what the schema teaching contained.
 */
const scripted = (cells: ReadonlyArray<string>, requests: Array<string>): Model.Model => {
  let index = 0
  return Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(
          request.system.map((part) => part.text).join("\n") + "\n" +
            request.messages.flatMap((message) =>
              message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            ).join("\n")
        )
        const source = cells[index] ?? cells.at(-1)!
        index++
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

/** A cell that completes immediately with a literal answer. */
const answering = (output: string): string => `ctx.done(${JSON.stringify(output)})`

const emptyRegistry: Registry.Registry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})

const host: AgentAction.Host = {
  registry: emptyRegistry,
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 3
}

/** The other half of the seam: a scripted model behind the host's resolver. */
const seats = (model: Model.Model): Layer.Layer<SeatResolver.SeatResolver> =>
  SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 }))
  })

const stack = <ROut, RIn>(
  step: Layer.Layer<ROut, never, RIn>,
  host: AgentAction.Host,
  model: Model.Model
) =>
  step.pipe(
    Layer.provideMerge(AgentAction.layerHost(host)),
    Layer.provideMerge(seats(model)),
    Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
    Layer.provideMerge(Safety.layer),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

// The provider is scripted; engine, cell controller, and QuickJS are real.
const execute = <S extends Schema.Top>(
  output: S,
  cells: ReadonlyArray<string>,
  requests: Array<string>,
  id: string,
  options: { corrections?: number; repair?: { prompt: () => string } } = {}
) => {
  const step = AgentAction.make(`agent/test/TypedBoundary/${id}`, {
    payload: {},
    output,
    seat: "anthropic:test-model",
    prompt: () => "Return the requested typed value.",
    corrections: 0,
    ...options
  })
  const flow = Flow.make(`agent/test/TypedBoundaryFlow/${id}`, {
    payload: {},
    success: output,
    error: AgentAction.AgentFailure,
    body: () => step.call({})
  })
  return flow.execute({}, { executionId: id }).pipe(
    Effect.provide(stack(Layer.mergeAll(step.layer, Interpreter.layer(flow)), host, scripted(cells, requests)))
  )
}

describe("typed completion public boundary", () => {
  it("preserves a numeric-looking string when numbers are also valid", async () => {
    const requests: Array<string> = []
    const result = await Effect.runPromise(execute(
      Schema.Union([Schema.String, Schema.Number]),
      [answering("12")],
      requests,
      "union-string"
    ))
    expect(result).toBe("12")
    expect(requests).toHaveLength(1)
  })

  it.each(["", "12"])("retains string refinement diagnostics for %j", async (value) => {
    const result = await Effect.runPromise(Effect.result(execute(
      Schema.String.check(Schema.isMinLength(3)),
      [answering(value)],
      [],
      `refinement-${value.length}`
    )))
    expect(result._tag).toBe("Failure")
    expect(result._tag === "Failure" ? result.failure : undefined).toMatchObject({
      _tag: "/harness/StructuredOutputFailure",
      issues: [{ code: "constraint", path: "", message: "Expected a value with a length of at least 3" }]
    })
  })

  it("preserves nested scalar types in a container", async () => {
    const value = { values: ["12", 12, "null", null, "true", true, "", false] }
    const result = await Effect.runPromise(execute(
      Schema.Struct({
        values: Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]))
      }),
      [`ctx.done(${JSON.stringify(value)})`],
      [],
      "container-scalars"
    ))
    expect(result).toEqual(value)
  })

  it("preserves the typed string after correcting in the same realm", async () => {
    const requests: Array<string> = []
    const result = await Effect.runPromise(execute(
      Schema.Union([Schema.String, Schema.Number]),
      ["const saved = \"12\"; ctx.done({ invalid: true })", "ctx.done(saved)"],
      requests,
      "same-realm-string",
      { corrections: 1 }
    ))
    expect(result).toBe("12")
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain("did not validate")
    expect(requests[1]).toContain("saved (string")
  })

  it("preserves the typed string returned by a repair", async () => {
    const requests: Array<string> = []
    const result = await Effect.runPromise(execute(
      Schema.Union([Schema.String, Schema.Number]),
      ["ctx.done({ invalid: true })", answering("12")],
      requests,
      "repair-string",
      { repair: { prompt: () => "Repair the answer preserving its type." } }
    ))
    expect(result).toBe("12")
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain("Repair the answer preserving its type.")
  })
})
