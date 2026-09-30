import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Fiber, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { FlowEngine, FlowProxy } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body().pipe(Effect.provide(TestClock.layer()))))

describe("FlowProxy", () => {
  const flow = Flow.make("FlowProxy/round-trip", {
    payload: { value: Schema.Number },
    success: Schema.Number,
    error: Schema.Literal("invalid"),
    idempotencyKey: ({ value }) => String(value),
    body: () => Node.succeed(0)
  })

  effect("uses an envelope that forwards executionId for execute and discard", () =>
    Effect.gen(function*() {
      const group = FlowProxy.toRpcGroup([flow])
      const execute = group.requests.get("FlowProxy/round-trip")!
      const discard = group.requests.get("FlowProxy/round-tripDiscard")!
      const executePayload = execute.payloadSchema.make({
        payload: { value: 1 },
        executionId: "client-execution"
      })
      const discardPayload = discard.payloadSchema.make({
        payload: { value: 1 },
        executionId: "client-discard"
      })
      expect(executePayload).toMatchObject({ executionId: "client-execution", payload: { value: 1 } })
      expect(discardPayload).toMatchObject({ executionId: "client-discard", payload: { value: 1 } })
    }))

  it("carries capability ceilings through each RPC and HTTP request", () => {
    const rpcGroup = FlowProxy.toRpcGroup([flow])
    const httpGroup = FlowProxy.toHttpApiGroup("flows", [flow])
    const capabilityCeilings = [[{ action: "fs:write", resource: "/workspace/**" }], []]
    for (const operation of [flow._tag, `${flow._tag}Discard`, `${flow._tag}Resume`] as const) {
      const schemas = [
        rpcGroup.requests.get(operation)!.payloadSchema,
        httpGroup.endpoints[operation]!.payload.get("application/json")!.schemas[0]
      ]
      for (const schema of schemas) {
        const decode = Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)
        const request = {
          executionId: "remote-1",
          ...(operation === `${flow._tag}Resume` ? {} : { payload: { value: 1 } }),
          capabilityCeilings
        }
        expect(decode(request)).toMatchObject({ capabilityCeilings })
      }
    }
  })

  it("rejects malformed execution ids in every RPC and HTTP payload schema", () => {
    const rpcGroup = FlowProxy.toRpcGroup([flow])
    const httpGroup = FlowProxy.toHttpApiGroup("flows", [flow])
    for (const operation of [flow._tag, `${flow._tag}Discard`, `${flow._tag}Resume`] as const) {
      const schemas = [
        rpcGroup.requests.get(operation)!.payloadSchema,
        httpGroup.endpoints[operation]!.payload.get("application/json")!.schemas[0]
      ]
      for (const schema of schemas) {
        const decode = Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)
        for (const executionId of ["", "\ud800", "root-\udbff", "\udc00", "a".repeat(4097)]) {
          expect(() => decode({ payload: { value: 1 }, executionId })).toThrow()
        }
        for (const executionId of ["a".repeat(4096), "round-🚀", "e\u0301"]) {
          expect(decode({ payload: { value: 1 }, executionId })).toMatchObject({ executionId })
        }
      }
    }
  })

  it("rejects a trailing high surrogate in an HTTP flow tag", () => {
    for (const tag of ["\ud800", "FlowProxy/\udbff"]) {
      const invalid = Flow.make(tag, { payload: {}, body: () => Node.succeed(undefined) })
      expect(() => FlowProxy.toHttpApiGroup("flows", [invalid])).toThrow(FlowProxy.InvalidFlowTag)
    }
  })

  effect("keeps schema-encoded exits typed at the proxy boundary", () =>
    Effect.gen(function*() {
      const group = FlowProxy.toRpcGroup([flow])
      const execute = group.requests.get("FlowProxy/round-trip")!
      const error = Schema.decodeUnknownSync(execute.errorSchema)("invalid")
      expect(error).toBe("invalid")
    }))

  effect("polling fallback wakes a suspended flow under TestClock", () => {
    const signal = DurableDeferred.make("FlowProxy/poll-signal", { success: Schema.Number })
    const suspendedActionDeclaration = Action.make("FlowProxy/suspended/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const suspended = Flow.make("FlowProxy/suspended", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id,
      body: (payload) => suspendedActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      suspendedActionDeclaration.toLayer(() => DurableDeferred.await(signal)),
      Interpreter.layer(suspended)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const running = yield* suspended.execute({ id: "one" }, { executionId: "suspended" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      const result = yield* suspended.poll("suspended")
      expect(Option.isSome(result)).toBe(true)
      yield* Fiber.interrupt(running)
    }).pipe(Effect.provide(layer))
  })
})
