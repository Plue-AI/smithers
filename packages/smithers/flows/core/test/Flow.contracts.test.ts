import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow as Durable, Graph, Interpreter } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Annotations, Effects, Flow, Node } from "../src/index.ts"

class Request extends Schema.Class<Request>("CoreContractRequest")({ text: Schema.String }) {
  uppercase(): string {
    return this.text.toUpperCase()
  }
}

const run = (
  flow: { readonly execute: (payload: any, options: { readonly executionId: string }) => Effect.Effect<any, any, any> },
  payload: unknown,
  executionId: string,
  ...layers: ReadonlyArray<Layer.Layer<any, any, any>>
): Promise<unknown> =>
  Effect.runPromise(
    flow.execute(payload, { executionId }).pipe(
      Effect.provide(
        Layer.mergeAll(Interpreter.layer(flow as never), ...layers).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        ) as Layer.Layer<any, never, never>
      ),
      Effect.scoped
    ) as Effect.Effect<unknown, unknown, never>
  )

describe("lowered flow contracts", () => {
  it("uses an inherited class schema as the direct payload promised by its type", async () => {
    const signature = Flow.make({ name: "contracts/class", input: Request, output: Schema.String })
    const layer = signature.action!.toLayer((payload) => {
      expectTypeOf(payload).toEqualTypeOf<Request>()
      expect(payload).toBeInstanceOf(Request)
      return Effect.succeed(payload.uppercase())
    })

    expect(signature.flow.payloadSchema).toBe(Request)
    expect(await run(signature.flow, new Request({ text: "direct" }), "class-direct", layer)).toBe("DIRECT")
    const graph = Graph.build(signature.call({ text: "planned" }))
    expect(Graph.nodes(graph).find((node) => node.kind === "ActionCall")?.payload).toMatchObject({ text: "planned" })
  })

  it("lets a capability annotation narrow the grant of the declared body", () => {
    const shell = Action.make("contracts/shell", { payload: {}, capabilities: ["shell"] })
    const signature = Flow.make({
      name: "contracts/grant",
      capabilities: ["shell"],
      body: () => shell.call({})
    }).pipe(Flow.annotate(Durable.Capabilities, []))

    expect(signature.capabilities).toEqual([])
    expect(Graph.diagnostics(Graph.build(signature.flow, {}))).toContainEqual(
      expect.objectContaining({ code: "capability_outside_grant" })
    )
  })

  it("keeps effect overrides, action tiers, and later combinators consistent", () => {
    const before = Effects.make({ reads: ["src"], writes: [], mode: "expected", onConflict: "serialize" })
    const override = Effects.make({ reads: ["docs"], writes: [], mode: "hermetic", onConflict: "fail", tier: "sealed" })
    const original = Flow.make({ name: "contracts/effects", effects: before })
    const changed = Flow.annotate(original, Annotations.Effects, override)
    const rebuilt = changed.pipe(Flow.withFlows(["helper"]))
    expect(rebuilt.effects).toEqual(override)
    expect(Option.getOrThrow(Context.getOption(rebuilt.annotations, Annotations.Effects))).toEqual(override)
    expect(rebuilt.action?.tier).toBe("sealed")
    expect(original.effects).toEqual(before)
    expect(original.action?.tier).toBe("irreversible")
  })

  it("passes an inherited class payload to a declared body without a wrapper", async () => {
    const signature = Flow.make({
      name: "contracts/class-body",
      input: Request,
      output: Schema.String,
      body: (request) => Node.succeed(request.text)
    })

    expect(await run(signature.flow, new Request({ text: "body" }), "class-body")).toBe("body")
  })
})
