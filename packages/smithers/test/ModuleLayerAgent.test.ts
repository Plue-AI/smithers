/** The discovered AgentAction layer receives the resolver composed by its host. */
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Model from "@smthrs/model/Model"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Schema, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("./fixtures/module-layer-agent", import.meta.url))
const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)

describe("a discovered AgentAction implementation", () => {
  it("resolves its declared seat through the existing host and returns structured output", async () => {
    const resolved: Array<string> = []
    const questions: Array<string> = []
    // The provider is the only scripted dependency. The registry, action,
    // engine, sandbox, structured-output decoder and seat service are real.
    const model = Model.make({
      stream: (request) => {
        questions.push(JSON.stringify({ messages: request.messages, system: request.system }))
        return Stream.fromIterable([
          ModelEvent.TextStart({ type: "text-start", id: "answer" }),
          ModelEvent.TextDelta({
            type: "text-delta",
            id: "answer",
            text: "```cell\nctx.done(\"{\\\"accepted\\\":true}\")\n```"
          }),
          ModelEvent.TextEnd({ type: "text-end", id: "answer" }),
          ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      }
    })
    const resolver = SeatResolver.layer({
      resolve: (id) =>
        Effect.sync(() => {
          resolved.push(id)
          return Seat.make({
            id,
            modelId: "host-model",
            model,
            contextWindowTokens: 200_000,
            route: {
              prepare: () =>
                Effect.succeed({
                  routeId: "fixture",
                  protocolId: "fixture",
                  method: "POST",
                  url: "https://fixture.invalid",
                  publicHeaders: {},
                  body: new Uint8Array(),
                  bodyText: ""
                })
            }
          })
        })
    })
    const host = Layer.mergeAll(
      Agent.layer,
      Agent.layerDefaults,
      ScriptedJudge.layer,
      AgentAction.layerHost({
        registry: Registry.makeNoop(),
        limits: { calls: 3 },
        capabilityEnvelope: [],
        maxFrames: 2,
        claimCap: 0
      }),
      resolver,
      Action.layerImplementations,
      FlowEngine.layerMemory,
      platform
    ).pipe(Layer.provideMerge(Layer.merge(Budget.layerUnbounded(), QuotaPolicy.layerUnclassified())))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const executable = yield* Executable.fromDescriptor(yield* registry.get("agent"), { delegates: [] })
        const runtime = yield* FlowRuntime.FlowRuntime
        return yield* runtime.execute(executable.flow, {
          payload: { input: { question: "Accept the fixture?" } },
          executionId: "module-agent-seat"
        }).pipe(Effect.provide(executable.layer))
      }).pipe(
        Effect.provide(Registry.layerProject({ root }).pipe(Layer.provide(Discovery.layer))),
        Effect.provide(host),
        Effect.scoped
      )
    )
    expect(Schema.decodeUnknownSync(Schema.Struct({ accepted: Schema.Boolean }))(result)).toEqual({ accepted: true })
    expect(resolved).toEqual(["test:host-seat"])
    expect(questions).toHaveLength(1)
    expect(questions[0]).toContain("Accept the fixture?")
  })
})
