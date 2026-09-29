import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Queue,
  References,
  Schema,
  Scope
} from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiTest } from "effect/unstable/httpapi"
import { Rpc, RpcClient, RpcGroup, RpcMessage, RpcSerialization, RpcServer, RpcTest } from "effect/unstable/rpc"
import { readFileSync } from "node:fs"
import { FlowEngine, FlowProxy, FlowProxyServer } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Scope.Scope>) =>
  it.effect(name, () => withCrypto(Effect.scoped(body())))

const EchoActionDeclaration = Action.make("Proxy/Echo/action", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  error: Schema.Literal("invalid")
})
const Echo = Flow.make("Proxy/Echo", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  error: Schema.Literal("invalid"),
  idempotencyKey: ({ value }) => String(value),
  body: (payload) => EchoActionDeclaration.call(payload)
})

const Gate = DurableDeferred.make("Proxy/Gate", { success: Schema.Number })

const SuspendsActionDeclaration = Action.make("Proxy/Suspends/action", {
  payload: { id: Schema.String },
  success: Schema.Number
})
const Suspends = Flow.make("Proxy/Suspends", {
  payload: { id: Schema.String },
  success: Schema.Number,
  idempotencyKey: ({ id }) => id,
  body: (payload) => SuspendsActionDeclaration.call(payload)
})

const flows = [Echo, Suspends] as const

const makeLayer = (echo: (value: number) => Effect.Effect<number, "invalid">) => {
  let calls = 0
  let suspendsCalls = 0
  const counted = (value: number) =>
    Effect.suspend(() => {
      calls++
      return echo(value)
    })
  const waitForGate = () =>
    Effect.suspend(() => {
      suspendsCalls++
      return DurableDeferred.await(Gate)
    })
  const layer = Layer.mergeAll(
    Layer.mergeAll(EchoActionDeclaration.toLayer(({ value }) => counted(value)), Interpreter.layer(Echo)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ),
    Layer.mergeAll(SuspendsActionDeclaration.toLayer(waitForGate), Interpreter.layer(Suspends))
      .pipe(
        Layer.provideMerge(Action.layerImplementations)
      )
  ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
  return { layer, calls: () => calls, suspendsCalls: () => suspendsCalls }
}

describe("FlowProxyServer.layerRpcHandlers", () => {
  effect("dispatches execute requests to the registered flow", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const result = yield* client["Proxy/Echo"]({
        payload: { value: 41 },
        executionId: "echo-1"
      })
      expect(result).toBe(42)
      expect(calls()).toBe(1)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect(
    "rejects malformed wire ids without aborting another request on the same RPC client",
    () =>
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const { calls, layer } = makeLayer((value) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(value + 1)
          )
        )
        const requests = yield* Queue.unbounded<readonly [number, RpcMessage.FromClientEncoded]>()
        const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>()
        const disconnects = yield* Queue.unbounded<number>()
        const codecFor = RpcSerialization.json.codecFor
        // Exercise server-side decoding. RpcTest skips serialization, and the
        // ordinary generated client would reject these ids before sending them.
        const unchecked = RpcGroup.make(Rpc.make("Proxy/Echo", {
          payload: { payload: Echo.payloadSchema, executionId: Schema.String },
          success: Schema.Number,
          error: Schema.Literal("invalid")
        }))
        yield* RpcServer.make(FlowProxy.toRpcGroup(flows)).pipe(
          Effect.provideService(RpcServer.Protocol, {
            run: (receive) =>
              Queue.take(requests).pipe(
                Effect.flatMap(([clientId, request]) => receive(clientId, request)),
                Effect.forever
              ),
            send: (_, response) => Queue.offer(responses, response).pipe(Effect.asVoid),
            disconnects,
            end: () => Effect.void,
            clientIds: Effect.succeed(new Set([0])),
            initialMessage: Effect.succeed(Option.none()),
            supportsAck: false,
            supportsTransferables: false,
            supportsSpanPropagation: false,
            supportsNotifications: false,
            codecFor
          }),
          Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer))),
          Effect.forkScoped
        )
        const client = yield* RpcClient.make(unchecked).pipe(
          Effect.provideService(RpcClient.Protocol, {
            run: (_, receive) => Queue.take(responses).pipe(Effect.flatMap(receive), Effect.forever),
            send: (clientId, request) => Queue.offer(requests, [clientId, request]).pipe(Effect.asVoid),
            supportsAck: false,
            supportsTransferables: false,
            codecFor
          })
        )
        const legitimate = yield* client["Proxy/Echo"]({
          payload: { value: 41 },
          executionId: "legitimate"
        }).pipe(Effect.exit, Effect.forkScoped)
        yield* Deferred.await(started)
        const rejected = yield* client["Proxy/Echo"]({
          payload: { value: 0 },
          executionId: ""
        }).pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(legitimate)).toEqual(Exit.succeed(42))
        expect(calls()).toBe(1)
      })
  )

  effect("deduplicates repeated execute requests for one execution id", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const first = yield* client["Proxy/Echo"]({ payload: { value: 1 }, executionId: "dedupe" })
      const second = yield* client["Proxy/Echo"]({ payload: { value: 1 }, executionId: "dedupe" })
      expect([first, second]).toEqual([2, 2])
      // the second request replays the completed execution instead of re-running it
      expect(calls()).toBe(1)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("namespaces RPC execute identity independently for two tenant clients", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    const observed: Array<{
      readonly flowTag: string
      readonly operation: string
      readonly clientValue: string | undefined
      readonly payload: unknown
    }> = []
    const callAsTenant = (tenant: string, repeats: number) =>
      Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
        for (let index = 0; index < repeats; index++) {
          expect(yield* client["Proxy/Echo"]({ payload: { value: 1 }, executionId: "shared" })).toBe(2)
        }
      }).pipe(
        Effect.provide(
          FlowProxyServer.layerRpcHandlers(flows, {
            executionId: (input) => {
              observed.push({
                flowTag: input.flow._tag,
                operation: input.operation,
                clientValue: input.clientValue,
                payload: input.payload
              })
              return `${tenant}:${input.clientValue}`
            }
          })
        )
      )

    return Effect.gen(function*() {
      yield* callAsTenant("tenant-a", 2)
      expect(calls()).toBe(1)
      yield* callAsTenant("tenant-b", 1)

      expect(calls()).toBe(2)
      const tenantA = yield* Echo.poll("tenant-a:shared")
      const tenantB = yield* Echo.poll("tenant-b:shared")
      expect(Option.isSome(tenantA) && tenantA.value._tag).toBe("Complete")
      expect(Option.isSome(tenantB) && tenantB.value._tag).toBe("Complete")
      expect(observed).toEqual([
        {
          flowTag: "Proxy/Echo",
          operation: "execute",
          clientValue: "shared",
          payload: { value: 1 }
        },
        {
          flowTag: "Proxy/Echo",
          operation: "execute",
          clientValue: "shared",
          payload: { value: 1 }
        },
        {
          flowTag: "Proxy/Echo",
          operation: "execute",
          clientValue: "shared",
          payload: { value: 1 }
        }
      ])
    }).pipe(Effect.provide(layer))
  })

  effect("lets RPC execute fall back to the flow idempotency key", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    const observed: Array<{
      readonly flowTag: string
      readonly operation: string
      readonly clientValue: string | undefined
      readonly payload: unknown
    }> = []
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const first = yield* client["Proxy/Echo"]({
        payload: { value: 41 },
        executionId: "ignore-this-id"
      })
      const repeat = yield* client["Proxy/Echo"]({ payload: { value: 41 }, executionId: "ignore-repeat-id" })

      expect([first, repeat]).toEqual([42, 42])
      expect(calls()).toBe(1)
      expect(observed).toEqual([
        {
          flowTag: "Proxy/Echo",
          operation: "execute",
          clientValue: "ignore-this-id",
          payload: { value: 41 }
        },
        {
          flowTag: "Proxy/Echo",
          operation: "execute",
          clientValue: "ignore-repeat-id",
          payload: { value: 41 }
        }
      ])
    }).pipe(
      Effect.provide(
        FlowProxyServer.layerRpcHandlers(flows, {
          executionId: (input) => {
            observed.push({
              flowTag: input.flow._tag,
              operation: input.operation,
              clientValue: input.clientValue,
              payload: input.payload
            })
            return undefined
          }
        }).pipe(Layer.provide(layer))
      )
    )
  })

  effect("concurrent execute requests share a single execution", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value * 2))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const call = client["Proxy/Echo"]({ payload: { value: 5 }, executionId: "concurrent" })
      const results = yield* Effect.all([call, call, call], { concurrency: "unbounded" })
      expect(results).toEqual([10, 10, 10])
      expect(calls()).toBe(1)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("surfaces flow failures as typed rpc errors", () => {
    const { layer } = makeLayer(() => Effect.fail("invalid" as const))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      const exit = yield* Effect.exit(
        client["Proxy/Echo"]({ payload: { value: 7 }, executionId: "failing" })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain("invalid")
      }
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )
  })

  effect("discard starts the flow without awaiting it, and resume drives it forward", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      yield* client["Proxy/SuspendsDiscard"]({
        payload: { id: "resume-me" },
        executionId: "resume-me"
      })
      yield* Effect.yieldNow
      const suspended = yield* Suspends.poll("resume-me")
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")

      // resume is a no-op while the deferred is unresolved
      yield* client["Proxy/SuspendsResume"]({ executionId: "resume-me" })
      yield* Effect.yieldNow
      const stillSuspended = yield* Suspends.poll("resume-me")
      expect(Option.isSome(stillSuspended) && stillSuspended.value._tag).toBe("Suspended")

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow: Suspends,
        executionId: "resume-me"
      })
      yield* DurableDeferred.succeed(Gate, { token, value: 9 })
      yield* client["Proxy/SuspendsResume"]({ executionId: "resume-me" })
      let result = yield* Suspends.poll("resume-me")
      for (let i = 0; i < 20 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
        yield* Effect.yieldNow
        result = yield* Suspends.poll("resume-me")
      }
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(9)
      }
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provideMerge(layer)))
    )
  })

  effect("scopes RPC discard and resume requests", () => {
    const { layer, suspendsCalls } = makeLayer((value) => Effect.succeed(value))
    const observed: Array<{
      readonly flowTag: string
      readonly operation: string
      readonly clientValue: string | undefined
      readonly payload: unknown
    }> = []
    const rawId = "scoped-resume"
    const namespacedId = `tenant-a:${rawId}`
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      yield* client["Proxy/SuspendsDiscard"]({
        payload: { id: rawId },
        executionId: rawId
      })
      yield* Effect.yieldNow
      const suspended = yield* Suspends.poll(namespacedId)
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")
      expect(suspendsCalls()).toBe(1)

      yield* client["Proxy/SuspendsResume"]({ executionId: rawId })
      yield* Effect.yieldNow
      const stillSuspended = yield* Suspends.poll(namespacedId)
      expect(Option.isSome(stillSuspended) && stillSuspended.value._tag).toBe("Suspended")
      expect(suspendsCalls()).toBe(1)

      yield* client["Proxy/SuspendsResume"]({ executionId: namespacedId })
      yield* Effect.yieldNow
      const resumed = yield* Suspends.poll(namespacedId)
      expect(Option.isSome(resumed) && resumed.value._tag).toBe("Suspended")
      expect(suspendsCalls()).toBe(2)

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow: Suspends,
        executionId: namespacedId
      })
      yield* DurableDeferred.succeed(Gate, { token, value: 12 })
      let result = yield* Suspends.poll(namespacedId)
      for (let index = 0; index < 20 && (Option.isNone(result) || result.value._tag !== "Complete"); index++) {
        yield* Effect.yieldNow
        result = yield* Suspends.poll(namespacedId)
      }
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(12)
      }
      expect(observed).toEqual([
        {
          flowTag: "Proxy/Suspends",
          operation: "discard",
          clientValue: rawId,
          payload: { id: rawId }
        },
        {
          flowTag: "Proxy/Suspends",
          operation: "resume",
          clientValue: rawId,
          payload: undefined
        },
        {
          flowTag: "Proxy/Suspends",
          operation: "resume",
          clientValue: namespacedId,
          payload: undefined
        }
      ])
    }).pipe(
      Effect.provide(
        FlowProxyServer.layerRpcHandlers(flows, {
          executionId: (input) => {
            observed.push({
              flowTag: input.flow._tag,
              operation: input.operation,
              clientValue: input.clientValue,
              payload: input.payload
            })
            if (input.operation === "discard") {
              return namespacedId
            }
            if (input.clientValue === rawId) {
              return `tenant-b:${rawId}`
            }
            return input.clientValue
          }
        }).pipe(Layer.provideMerge(layer))
      )
    )
  })

  effect("refuses an RPC resume that the scope declines to namespace", () => {
    const { layer, suspendsCalls } = makeLayer((value) => Effect.succeed(value))
    const rawId = "unscoped-resume"
    const namespacedId = `tenant-a:${rawId}`
    // A scope that reads its tenant from the authenticated payload, the first
    // pattern the namespacing guide describes. A resume request carries no
    // payload, so this scope names no id for it.
    const scope = ((input) =>
      input.payload === undefined ? undefined : namespacedId) satisfies FlowProxyServer.ExecutionIdScope
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      yield* client["Proxy/SuspendsDiscard"]({ payload: { id: rawId }, executionId: rawId })
      yield* Effect.yieldNow
      expect(suspendsCalls()).toBe(1)

      const exit = yield* client["Proxy/SuspendsResume"]({ executionId: namespacedId }).pipe(Effect.exit)
      yield* Effect.yieldNow
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("ExecutionIdRequired")).toBe(true)
      // the id never reached the engine, so tenant A's parked body did not re-run
      expect(suspendsCalls()).toBe(1)
      const state = yield* Suspends.poll(namespacedId)
      expect(Option.isSome(state) && state.value._tag).toBe("Suspended")
    }).pipe(
      Effect.provide(
        FlowProxyServer.layerRpcHandlers(flows, { executionId: scope }).pipe(Layer.provideMerge(layer))
      )
    )
  })

  effect(
    "derives the execution identity from the flow's idempotency key when the server scope chooses derivation",
    () => {
      const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
      return Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
        const first = yield* client["Proxy/Echo"]({ payload: { value: 41 }, executionId: "ignore-repeat-id" })
        const repeat = yield* client["Proxy/Echo"]({ payload: { value: 41 }, executionId: "ignore-repeat-id" })
        expect([first, repeat]).toEqual([42, 42])
        // Echo declares `idempotencyKey: String(value)`, so both requests
        // derive one identity and the second replays instead of re-running.
        expect(calls()).toBe(1)
        // A different payload derives a different identity and runs.
        expect(yield* client["Proxy/Echo"]({ payload: { value: 10 }, executionId: "ignore-other-id" })).toBe(11)
        expect(calls()).toBe(2)
      }).pipe(
        Effect.provide(
          FlowProxyServer.layerRpcHandlers(flows, { executionId: () => undefined }).pipe(Layer.provide(layer))
        )
      )
    }
  )

  effect("resume with an unknown execution id is a no-op and an empty id is rejected", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value))
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      yield* client["Proxy/EchoResume"]({ executionId: "proxy-never-started" })
      const rejected = yield* client["Proxy/SuspendsResume"]({ executionId: "" }).pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBe(true)
      // Nothing was started, dispatched, or invented for the unknown id: the
      // engine still reports it as a typed not-found.
      const error = yield* Effect.flip(Echo.poll("proxy-never-started"))
      expect(error).toMatchObject({
        _tag: "@smthrs/flow/FlowExecutionNotFound",
        executionId: "proxy-never-started"
      })
      expect(calls()).toBe(0)
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provideMerge(layer)))
    )
  })

  effect("registers execute, discard, resume, and interrupt under the rpc keys the group publishes", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value + 100))
    const group = FlowProxy.toRpcGroup(flows, { prefix: "v1/" })
    return Effect.gen(function*() {
      const context = yield* Layer.build(
        FlowProxyServer.layerRpcHandlers(flows, { prefix: "v1/" }).pipe(Layer.provide(layer))
      )
      // Every address is read off the rpc the client calls. A server that
      // rebuilt one by appending to a restated key format answers execute and
      // leaves discard and resume unregistered the moment either convention
      // moves.
      const registered = [...group.requests.values()].map((rpc) => ({
        tag: rpc._tag,
        key: rpc.key,
        entry: context.mapUnsafe.get(rpc.key)
      }))
      expect(registered.map((found) => found.tag)).toEqual([
        "v1/Proxy/Echo",
        "v1/Proxy/EchoDiscard",
        "v1/Proxy/EchoResume",
        "v1/Proxy/EchoInterrupt",
        "v1/Proxy/Suspends",
        "v1/Proxy/SuspendsDiscard",
        "v1/Proxy/SuspendsResume",
        "v1/Proxy/SuspendsInterrupt"
      ])
      for (const found of registered) {
        expect(found.entry, found.key).toBeDefined()
        expect(found.entry).toMatchObject({ tag: found.tag, handler: expect.any(Function) })
      }
    })
  })

  effect("serves prefixed rpc tags when a prefix is configured", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value + 100))
    const group = FlowProxy.toRpcGroup(flows, { prefix: "v1/" })
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(group)
      const result = yield* client["v1/Proxy/Echo"]({
        payload: { value: 1 },
        executionId: "prefixed"
      })
      expect(result).toBe(101)
    }).pipe(
      Effect.provide(
        FlowProxyServer.layerRpcHandlers(flows, { prefix: "v1/" }).pipe(Layer.provide(layer))
      )
    )
  })
})

describe("FlowProxyServer handler addresses", () => {
  const source = readFileSync(new URL("../src/FlowProxyServer.ts", import.meta.url), "utf8")

  // `Rpc.key` is effect's own service key for a handler and
  // `FlowProxy.operationAddresses` owns the three operation names. Restating
  // either one here reads correct and breaks silently on the next effect
  // release or address change, so the layer has to come from the generated
  // group instead of from a hand-assembled context.
  it("restates neither effect's handler key format nor the operation suffixes", () => {
    expect(source).not.toContain("effect/rpc/Rpc/")
    expect(source).not.toMatch(/\$\{key[^}]*\}(Discard|Resume)/)
    expect(source).toMatch(/group\.toLayer\(/)
  })
})

describe("serving a flow is executing it", () => {
  // Serving happens on the side of the boundary that drives the body, so the
  // compile-time gate on a missing action implementation has to hold here
  // too. A type test: `tsc -p tsconfig.test.json` in `pnpm run check` fails on
  // a red assertion whether or not the suite is run.
  it("requires the action implementations of every flow it serves", () => {
    type Served = Layer.Services<ReturnType<typeof FlowProxyServer.layerRpcHandlers<typeof flows>>>

    expectTypeOf<Action.Requirement<"Proxy/Echo/action">>().toExtend<Served>()
    expectTypeOf<Action.Requirement<"Proxy/Suspends/action">>().toExtend<Served>()

    const engineOnly = Interpreter.layer(Echo).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    const unmet = Effect.void.pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(engineOnly)))
    )

    // An engine and a table satisfy everything except the implementations, and
    // those are exactly what is left over.
    expectTypeOf<Effect.Services<typeof unmet>>().toEqualTypeOf<
      Action.Requirement<"Proxy/Echo/action"> | Action.Requirement<"Proxy/Suspends/action">
    >()

    // Never invoked: the assertion is that this expression does not compile.
    // `Effect.runPromise` is the point — the Promise boundary is what refuses
    // an Effect whose requirements are unmet.
    // @ts-expect-error -- the served bodies name two actions, and nothing in
    // this composition implements either.
    const unimplemented = () => Effect.runPromise(unmet)

    expectTypeOf(unimplemented).toBeFunction()
  })

  it("has them erased by the composition the suites serve with", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value))
    const served = Effect.void.pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(layer)))
    )

    expectTypeOf<Effect.Services<typeof served>>().toEqualTypeOf<never>()
  })
})

const HttpTestServices = Layer.mergeAll(
  Path.layer,
  Etag.layerWeak,
  HttpPlatform.layer
).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

class Unprovided extends Context.Service<Unprovided, { readonly value: string }>()(
  "test/flows-engine/FlowProxyServer/Unprovided"
) {}

class ProxyApi extends HttpApi.make("proxy").add(
  FlowProxy.toHttpApiGroup("flows", flows)
) {}

describe("FlowProxyServer.layerHttpApi", () => {
  const client = HttpApiTest.groups(ProxyApi, ["flows"])

  const provide = <ROut>(
    layer: Layer.Layer<ROut>,
    options?: { readonly executionId?: FlowProxyServer.ExecutionIdScope }
  ) => {
    const served = FlowProxyServer.layerHttpApi(ProxyApi, "flows", flows, options).pipe(
      Layer.provideMerge(layer),
      Layer.provideMerge(HttpTestServices)
    )
    return <A, E>(self: Effect.Effect<A, E, NoInfer<Layer.Success<typeof served>> | Scope.Scope>) =>
      Effect.scoped(Effect.provide(self, served))
  }

  effect("routes the execute endpoint to the flow handler", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    return Effect.gen(function*() {
      const api = yield* client
      const result = yield* api.flows["Proxy/Echo"]({
        payload: { payload: { value: 1 }, executionId: "http-execute" }
      })
      expect(result).toBe(2)
      expect(calls()).toBe(1)
    }).pipe(provide(layer))
  })

  effect("interrupts the run the execution id scope names, not the client's id", () => {
    let interrupted = false
    const started = Deferred.makeUnsafe<void>()
    const { layer } = makeLayer(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => (interrupted = true)))
      )
    )
    const observed: Array<{ readonly operation: string; readonly clientValue: string | undefined }> = []
    const scope = ((input) => {
      observed.push({ operation: input.operation, clientValue: input.clientValue })
      return `tenant:${input.clientValue}`
    }) satisfies FlowProxyServer.ExecutionIdScope
    return Effect.gen(function*() {
      const api = yield* client
      yield* api.flows["Proxy/EchoDiscard"]({ payload: { payload: { value: 7 }, executionId: "http-interrupt" } })
      yield* Deferred.await(started)
      yield* api.flows["Proxy/EchoInterrupt"]({ payload: { executionId: "http-interrupt" } })
      expect(observed).toContainEqual({ operation: "interrupt", clientValue: "http-interrupt" })
      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 200 && !interrupted; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      })
      expect(interrupted).toBe(true)
    }).pipe(provide(layer, { executionId: scope }))
  })

  effect("matches execution id scoping over the HTTP adapter", () => {
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    const observed: Array<{
      readonly flowTag: string
      readonly operation: string
      readonly clientValue: string | undefined
      readonly payload: unknown
    }> = []
    const scope = ((input) => {
      observed.push({
        flowTag: input.flow._tag,
        operation: input.operation,
        clientValue: input.clientValue,
        payload: input.payload
      })
      return input.clientValue === "http-raw" ? "tenant-http:http-raw" : undefined
    }) satisfies FlowProxyServer.ExecutionIdScope
    return Effect.gen(function*() {
      const api = yield* client
      const first = yield* api.flows["Proxy/Echo"]({
        payload: { payload: { value: 41 }, executionId: "ignore-http-id" }
      })
      const repeat = yield* api.flows["Proxy/Echo"]({
        payload: { payload: { value: 41 }, executionId: "ignore-repeat-id" }
      })
      const scoped = yield* api.flows["Proxy/Echo"]({
        payload: { payload: { value: 10 }, executionId: "http-raw" }
      })

      expect([first, repeat, scoped]).toEqual([42, 42, 11])
      expect(calls()).toBe(2)
      const namespaced = yield* Echo.poll("tenant-http:http-raw")
      expect(Option.isSome(namespaced) && namespaced.value._tag).toBe("Complete")
      expect(observed).toEqual([
        {
          flowTag: "Proxy/Echo",
          operation: "execute",
          clientValue: "ignore-http-id",
          payload: { value: 41 }
        },
        {
          flowTag: "Proxy/Echo",
          operation: "execute",
          clientValue: "ignore-repeat-id",
          payload: { value: 41 }
        },
        {
          flowTag: "Proxy/Echo",
          operation: "execute",
          clientValue: "http-raw",
          payload: { value: 10 }
        }
      ])
    }).pipe(provide(layer, { executionId: scope }))
  })

  effect("returns the declared error from the execute endpoint", () => {
    const { layer } = makeLayer(() => Effect.fail("invalid" as const))
    return Effect.gen(function*() {
      const api = yield* client
      const exit = yield* Effect.exit(
        api.flows["Proxy/Echo"]({
          payload: { payload: { value: 2 }, executionId: "http-error" }
        })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain("invalid")
      }
    }).pipe(provide(layer))
  })

  effect("discard and resume endpoints drive a suspended execution", () => {
    const { layer } = makeLayer((value) => Effect.succeed(value))
    return Effect.gen(function*() {
      const api = yield* client
      yield* api.flows["Proxy/SuspendsDiscard"]({
        payload: { payload: { id: "http-resume" }, executionId: "http-resume" }
      })
      yield* Effect.yieldNow
      const suspended = yield* Suspends.poll("http-resume")
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow: Suspends,
        executionId: "http-resume"
      })
      yield* DurableDeferred.succeed(Gate, { token, value: 3 })
      yield* api.flows["Proxy/SuspendsResume"]({ payload: { executionId: "http-resume" } })
      let result = yield* Suspends.poll("http-resume")
      for (let i = 0; i < 20 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
        yield* Effect.yieldNow
        result = yield* Suspends.poll("http-resume")
      }
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(3)
      }
    }).pipe(provide(layer))
  })

  effect("scopes HTTP discard and resume requests", () => {
    const { layer, suspendsCalls } = makeLayer((value) => Effect.succeed(value))
    const observed: Array<{
      readonly flowTag: string
      readonly operation: string
      readonly clientValue: string | undefined
      readonly payload: unknown
    }> = []
    const rawId = "http-scoped-resume"
    const namespacedId = `tenant-http:${rawId}`
    const scope = ((input) => {
      observed.push({
        flowTag: input.flow._tag,
        operation: input.operation,
        clientValue: input.clientValue,
        payload: input.payload
      })
      if (input.operation === "discard") {
        return namespacedId
      }
      if (input.clientValue === rawId) {
        return `other-tenant:${rawId}`
      }
      return input.clientValue
    }) satisfies FlowProxyServer.ExecutionIdScope
    return Effect.gen(function*() {
      const api = yield* client
      yield* api.flows["Proxy/SuspendsDiscard"]({
        payload: { payload: { id: rawId }, executionId: rawId }
      })
      yield* Effect.yieldNow
      const suspended = yield* Suspends.poll(namespacedId)
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")
      expect(suspendsCalls()).toBe(1)

      yield* api.flows["Proxy/SuspendsResume"]({ payload: { executionId: rawId } })
      yield* Effect.yieldNow
      const stillSuspended = yield* Suspends.poll(namespacedId)
      expect(Option.isSome(stillSuspended) && stillSuspended.value._tag).toBe("Suspended")
      expect(suspendsCalls()).toBe(1)

      yield* api.flows["Proxy/SuspendsResume"]({ payload: { executionId: namespacedId } })
      yield* Effect.yieldNow
      const resumed = yield* Suspends.poll(namespacedId)
      expect(Option.isSome(resumed) && resumed.value._tag).toBe("Suspended")
      expect(suspendsCalls()).toBe(2)

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow: Suspends,
        executionId: namespacedId
      })
      yield* DurableDeferred.succeed(Gate, { token, value: 8 })
      let result = yield* Suspends.poll(namespacedId)
      for (let index = 0; index < 20 && (Option.isNone(result) || result.value._tag !== "Complete"); index++) {
        yield* Effect.yieldNow
        result = yield* Suspends.poll(namespacedId)
      }
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(8)
      }
      expect(observed).toEqual([
        {
          flowTag: "Proxy/Suspends",
          operation: "discard",
          clientValue: rawId,
          payload: { id: rawId }
        },
        {
          flowTag: "Proxy/Suspends",
          operation: "resume",
          clientValue: rawId,
          payload: undefined
        },
        {
          flowTag: "Proxy/Suspends",
          operation: "resume",
          clientValue: namespacedId,
          payload: undefined
        }
      ])
    }).pipe(provide(layer, { executionId: scope }))
  })

  effect("refuses an HTTP resume that the scope declines to namespace", () => {
    const { layer, suspendsCalls } = makeLayer((value) => Effect.succeed(value))
    const rawId = "http-unscoped-resume"
    const namespacedId = `tenant-http:${rawId}`
    const scope = ((input) =>
      input.payload === undefined ? undefined : namespacedId) satisfies FlowProxyServer.ExecutionIdScope
    return Effect.gen(function*() {
      const api = yield* client
      yield* api.flows["Proxy/SuspendsDiscard"]({
        payload: { payload: { id: rawId }, executionId: rawId }
      })
      yield* Effect.yieldNow
      expect(suspendsCalls()).toBe(1)

      const exit = yield* api.flows["Proxy/SuspendsResume"]({ payload: { executionId: namespacedId } }).pipe(
        Effect.exit
      )
      yield* Effect.yieldNow
      expect(Exit.isFailure(exit)).toBe(true)
      // the id never reached the engine, so the parked body did not re-run
      expect(suspendsCalls()).toBe(1)
      const state = yield* Suspends.poll(namespacedId)
      expect(Option.isSome(state) && state.value._tag).toBe("Suspended")
    }).pipe(provide(layer, { executionId: scope }))
  })

  effect("logs annotated execute defects through both HTTP and RPC adapters", () => {
    const DyingAction = Action.make("Proxy/Dies/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const Dying = Flow.make("Proxy/Dies", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => DyingAction.call(payload)
    })
    const dyingFlows = [Dying] as const
    class DyingApi extends HttpApi.make("dying").add(
      FlowProxy.toHttpApiGroup("flows", dyingFlows)
    ) {}
    const dyingLayer = Layer.mergeAll(
      DyingAction.toLayer(() => Effect.die("proxy-handler-defect")),
      Interpreter.layer(Dying)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    const logs: Array<{
      readonly message: unknown
      readonly logLevel: string
      readonly annotations: Readonly<Record<string, unknown>>
    }> = []
    const capture = Logger.make((entry) => {
      logs.push({
        message: entry.message,
        logLevel: entry.logLevel,
        annotations: entry.fiber.getRef(References.CurrentLogAnnotations)
      })
    })
    const proxyErrors = () =>
      logs.filter((entry) =>
        entry.logLevel === "Error" &&
        entry.annotations["module"] === "FlowProxyServer" &&
        entry.annotations["method"] === FlowProxy.operationAddresses(Dying._tag).execute
      )
    return Effect.gen(function*() {
      const httpExit = yield* Effect.gen(function*() {
        const httpClient = yield* HttpApiTest.groups(DyingApi, ["flows"])
        return yield* httpClient.flows["Proxy/Dies"]({
          payload: { payload: { id: "http" }, executionId: "proxy-dies-http" }
        })
      }).pipe(
        Effect.exit,
        Effect.provide(
          FlowProxyServer.layerHttpApi(DyingApi, "flows", dyingFlows).pipe(Layer.provideMerge(dyingLayer))
        ),
        Effect.provide(HttpTestServices)
      )
      expect(Exit.isFailure(httpExit)).toBe(true)
      expect(proxyErrors().length).toBe(1)

      const rpcExit = yield* Effect.gen(function*() {
        const rpcClient = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(dyingFlows))
        return yield* rpcClient["Proxy/Dies"]({
          payload: { id: "rpc" },
          executionId: "proxy-dies-rpc"
        })
      }).pipe(
        Effect.exit,
        Effect.provide(FlowProxyServer.layerRpcHandlers(dyingFlows).pipe(Layer.provideMerge(dyingLayer)))
      )
      expect(Exit.isFailure(rpcExit)).toBe(true)
      expect(proxyErrors().length).toBe(2)
      expect(proxyErrors().every((entry) => String(entry.message).includes("proxy-handler-defect"))).toBe(true)
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([capture])))
  })

  effect("redacts quoted passwords in RPC defects and server logs (#2452)", () => {
    const SecretAction = Action.make("Proxy/QuotedSecret/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const SecretFlow = Flow.make("Proxy/QuotedSecret", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => SecretAction.call(payload)
    })
    const secretFlows = [SecretFlow] as const
    let password = ""
    const layer = Layer.mergeAll(
      SecretAction.toLayer(() => Effect.die(new Error(JSON.stringify({ password })))),
      Interpreter.layer(SecretFlow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    const logs: Array<unknown> = []
    const capture = Logger.make((entry) => {
      if (entry.logLevel === "Error" &&
        entry.fiber.getRef(References.CurrentLogAnnotations)["module"] === "FlowProxyServer") {
        logs.push(entry.message)
      }
    })
    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(secretFlows))
      const suffix = "suffix-sensitive-XYZ123"
      const passwords = [
        `prefix-sensitive ${suffix}`,
        `prefix-sensitive,${suffix}`,
        `prefix-sensitive;${suffix}`,
        `prefix-sensitive"${suffix}`,
        `prefix-sensitive\\${suffix}`,
        JSON.stringify({ nested: `prefix-sensitive ${suffix}` })
      ]
      for (const [index, value] of passwords.entries()) {
        password = value
        const exit = yield* Effect.exit(client["Proxy/QuotedSecret"]({
          payload: { id: String(index) },
          executionId: `quoted-secret-${index}`
        }))
        expect(Exit.isFailure(exit)).toBe(true)
        const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(defect).toBeInstanceOf(FlowProxyServer.FlowHandlerDefect)
        const wire = JSON.stringify(Schema.encodeSync(Schema.toCodecJson(Schema.Defect()))(defect))
        expect(wire).toContain("[REDACTED]")
        yield* Effect.yieldNow
        expect(logs.length).toBe(index + 1)
        for (const diagnostic of [wire, String(logs[index])]) {
          expect(diagnostic).not.toContain("prefix-sensitive")
          expect(diagnostic).not.toContain(suffix)
        }
      }
    }).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(secretFlows).pipe(Layer.provideMerge(layer))),
      Effect.provideService(Logger.CurrentLoggers, new Set([capture]))
    )
  })

  /** Never called; tsc checks it (#2704). */
  const unprovidedServiceProbe = () => {
    const { layer } = makeLayer((value) => Effect.succeed(value))
    // @ts-expect-error the proxy layer and HTTP test services do not provide Unprovided
    provide(layer)(Effect.map(Unprovided, (service) => service.value))
    provide(layer)(Effect.map(Path.Path, (path) => path.sep))
  }

  it("rejects a body that needs a service its layer does not provide (#2704)", () => {
    // The assertion is the `@ts-expect-error` directive above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})

describe("FlowProxy.toHttpApiGroup path lowering", () => {
  it("keeps case-distinct and reserved-character tags in distinct path segments", () => {
    const CaseUpper = Flow.make("Proxy/Collide", {
      payload: { value: Schema.Number },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const caseLower = Flow.make("proxy/collide", {
      payload: { value: Schema.Number },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const group = FlowProxy.toHttpApiGroup("collide", [CaseUpper, caseLower])
    const endpoints = group.endpoints as Record<string, { readonly path: string; readonly method: string }>

    expect(Object.keys(endpoints).sort()).toEqual([
      "Proxy/Collide",
      "Proxy/CollideDiscard",
      "Proxy/CollideInterrupt",
      "Proxy/CollideResume",
      "proxy/collide",
      "proxy/collideDiscard",
      "proxy/collideInterrupt",
      "proxy/collideResume"
    ])
    expect(endpoints["Proxy/Collide"]!.path).toMatch(/^\/flow-[0-9a-f]+$/)
    expect(endpoints["Proxy/Collide"]!.path).not.toBe(endpoints["proxy/collide"]!.path)
    expect(endpoints["Proxy/CollideDiscard"]!.path).not.toBe(endpoints["proxy/collideDiscard"]!.path)
    expect(endpoints["Proxy/CollideResume"]!.path).not.toBe(endpoints["proxy/collideResume"]!.path)
    expect(endpoints["Proxy/CollideInterrupt"]!.path).toBe(`${endpoints["Proxy/Collide"]!.path}/interrupt`)
    expect(endpoints["Proxy/Collide"]!.path.slice(1)).not.toContain("/")

    const Reserved = Flow.make("Proxy/%?#/\ud83d\ude80", {
      payload: {},
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const reserved = FlowProxy.toHttpApiGroup("reserved", [Reserved])
    const reservedEndpoints = reserved.endpoints as Record<string, { readonly path: string }>
    expect(reservedEndpoints["Proxy/%?#/\ud83d\ude80"]!.path).toMatch(/^\/flow-[0-9a-f]+$/)
  })

  it("refuses operation names that suffix expansion makes ambiguous", () => {
    const Foo = Flow.make("Foo", {
      payload: {},
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const FooDiscard = Flow.make("FooDiscard", {
      payload: {},
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    expect(() => FlowProxy.toRpcGroup([Foo, FooDiscard])).toThrow(FlowProxy.FlowProxyCollision)
    expect(() => FlowProxy.toHttpApiGroup("ambiguous", [Foo, FooDiscard])).toThrow(
      FlowProxy.FlowProxyCollision
    )
  })

  it("refuses ill-formed UTF-16 tags before constructing a route", () => {
    for (const tag of ["Proxy/\ud800A", "Proxy/\ud800\uffff", "Proxy/\udc00"]) {
      const Invalid = Flow.make(tag, {
        payload: {},
        success: Schema.Void,
        body: () => Node.succeed(undefined)
      })
      let error: unknown
      try {
        FlowProxy.toHttpApiGroup("invalid", [Invalid])
      } catch (cause) {
        error = cause
      }
      expect(error).toBeInstanceOf(FlowProxy.InvalidFlowTag)
      expect(error).toMatchObject({ code: "invalid_flow_tag", tag })
    }
  })
})

describe("FlowProxyServer over a real HTTP listener", () => {
  effect("round-trips execute through a live server, with wire identity deduplication", () => {
    // Unlike `HttpApiTest`, this serves the API on a real Node listener on an
    // ephemeral port and calls it through a real fetch-backed client: the
    // payload and result cross genuine wire serialization.
    const { calls, layer } = makeLayer((value) => Effect.succeed(value + 1))
    const served = HttpRouter.serve(
      HttpApiBuilder.layer(ProxyApi).pipe(
        Layer.provide(
          FlowProxyServer.layerHttpApi(ProxyApi, "flows", flows).pipe(Layer.provideMerge(layer))
        )
      )
    ).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
    return Effect.gen(function*() {
      const client = yield* HttpApiClient.make(ProxyApi)
      const result = yield* client.flows["Proxy/Echo"]({
        payload: { payload: { value: 41 }, executionId: "wire-execute" }
      })
      expect(result).toBe(42)
      expect(calls()).toBe(1)
      // The same wire identity dedupes across a second real HTTP request.
      const repeat = yield* client.flows["Proxy/Echo"]({
        payload: { payload: { value: 41 }, executionId: "wire-execute" }
      })
      expect(repeat).toBe(42)
      expect(calls()).toBe(1)
    }).pipe(Effect.provide(served))
  })
})

it("requires an execution id in both execute and discard proxy payload schemas", () => {
  const group = FlowProxy.toRpcGroup(flows)
  for (const operation of ["Proxy/Echo", "Proxy/EchoDiscard"]) {
    const rpc = group.requests.get(operation)!
    const decode = Schema.decodeUnknownSync(rpc.payloadSchema)
    expect(() => decode({ payload: { value: 1 } })).toThrow()
    expect(decode({ payload: { value: 1 }, executionId: "explicit" })).toEqual({
      payload: { value: 1 },
      executionId: "explicit"
    })
  }
})
