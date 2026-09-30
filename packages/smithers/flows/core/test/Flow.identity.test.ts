import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Flow as Canonical, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import * as Result from "effect/Result"
import { expect, it } from "vitest"
import { Flow, Graph, Node } from "../src/index.ts"

it("executes canonical and compatibility declarations with the same payload, errors and metadata", async () => {
  const Input = Schema.Struct({ text: Schema.String })
  const Failure = Schema.Struct({ _tag: Schema.Literal("Rejected"), text: Schema.String })
  const body = Node.capture(
    {},
    ({ text }: typeof Input.Type) =>
      text === "reject" ? Node.fail({ _tag: "Rejected" as const, text }) : Node.succeed(text.toUpperCase())
  )
  const signature = Flow.make({
    name: "identity/parity-adapter",
    description: "Public compatibility",
    input: Input,
    output: Schema.String,
    error: Failure,
    capabilities: [],
    model: "smart",
    flows: ["helper"],
    prompt: "Retained metadata",
    body
  })
  const canonical = Canonical.make("identity/parity-canonical", {
    description: signature.description,
    payload: Input,
    success: Schema.String,
    error: Failure,
    capabilities: [],
    body
  })
  expect(Canonical.isFlow(signature.flow)).toBe(true)
  expect(signature.flow.body).toBe(canonical.body)
  expect(signature.flow.payloadSchema).toBe(canonical.payloadSchema)
  expect(signature.flow.successSchema).toBe(canonical.successSchema)
  expect(signature.flow.errorSchema).toBe(canonical.errorSchema)
  expect(signature.flow.description).toBe(canonical.description)
  expect(signature.model).toBe("smart")
  expect(signature.flows).toEqual(["helper"])
  expect(signature.prompt).toBe("Retained metadata")
  for (const flow of [signature.flow, canonical]) {
    const runtime = Interpreter.layerWithImplementations(flow, Layer.empty).pipe(
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
    const results = await Effect.runPromise(
      Effect.gen(function*() {
        const success = yield* flow.execute({ text: "accepted" }, { executionId: `${flow._tag}/success` })
        const failure = yield* flow.execute({ text: "reject" }, { executionId: `${flow._tag}/failure` }).pipe(
          Effect.result
        )
        return { success, failure }
      }).pipe(Effect.provide(runtime), Effect.scoped)
    )
    expect(results.success).toBe("ACCEPTED")
    expect(Result.isFailure(results.failure)).toBe(true)
    if (Result.isFailure(results.failure)) {
      expect(results.failure.failure).toEqual({ _tag: "Rejected", text: "reject" })
    }
  }
})

it("executes a captured struct body under the canonical interpreter policy", async () => {
  const body = Node.capture({}, ({ text }: { readonly text: string }) => Node.succeed(text))
  const signature = Flow.make({
    name: "identity/struct",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.String,
    body
  }).pipe(Flow.withFlows(["helper"]))
  const runtime = Interpreter.layerWithImplementations(signature.flow, Layer.empty).pipe(
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

  expect(signature.flow.body).toBe(body)
  expect(
    await Effect.runPromise(
      signature.flow.execute({ text: "stable" }, { executionId: "stable-struct" }).pipe(
        Effect.provide(runtime),
        Effect.scoped
      )
    )
  ).toBe("stable")
})

it("preserves a captured scalar body's semantics and identity through its input adapter", async () => {
  const make = (suffix: string) =>
    Flow.make({
      name: "identity/scalar",
      input: Schema.String,
      output: Schema.String,
      body: Node.capture({ suffix }, function(text: string) {
        return Node.succeed(text + this.suffix)
      })
    })
  const signature = make("!")
  const runtime = Interpreter.layerWithImplementations(signature.flow, Layer.empty).pipe(
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

  expect(Graph.diagnostics(Graph.build(signature.flow, { input: "stable" }, { callbackIdentity: "stable" }))).toEqual(
    []
  )
  expect(Node.functionIdentity(signature.flow.body)).toEqual(Node.functionIdentity(make("!").flow.body))
  expect(Node.functionIdentity(signature.flow.body)).not.toEqual(Node.functionIdentity(make("?").flow.body))
  expect(
    await Effect.runPromise(
      signature.flow.execute({ input: "stable" }, { executionId: "stable-scalar" }).pipe(
        Effect.provide(runtime),
        Effect.scoped
      )
    )
  ).toBe("stable!")
})

it("still refuses uncaptured author callbacks and unproven action-only wrappers in a stable graph", () => {
  const signatures = [
    Flow.make({ name: "identity/uncaptured-scalar", input: Schema.String, body: (text) => Node.succeed(text) }).flow,
    Flow.make({ name: "identity/uncaptured-struct", input: Schema.Struct({}), body: () => Node.succeed("value") }).flow,
    Flow.make({ name: "identity/declared", input: Schema.Struct({}) }).flow
  ]
  for (const flow of signatures) {
    expect(Graph.diagnostics(Graph.build(flow, { input: "value" }, { callbackIdentity: "stable" }))).toContainEqual(
      expect.objectContaining({ code: "unstable_callback" })
    )
  }
})
