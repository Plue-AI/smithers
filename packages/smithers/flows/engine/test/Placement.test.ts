/**
 * A `.child()` whose placement the `Hosts` table binds to another engine runs
 * there, under the id the parent derived, and the parent keeps one leaf.
 *
 * Engine B serves `Release` through `FlowProxyServer`; engine A drives
 * `Parent` and reaches B through an RPC client the table's `Proxy` binding
 * opens. Nothing registers `Release` on A.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Placement from "@smthrs/plan/Placement"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpClientErrorSchema } from "effect/unstable/http/HttpClientError"
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { FlowEngine, FlowProxy, FlowProxyServer, Hosts } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const Step = Action.make("placement/step", {
  payload: { version: Schema.String },
  success: Schema.String
})

const Release = Flow.make("placement/release", {
  payload: { version: Schema.String },
  success: Schema.String,
  body: (payload) => Step.call(payload)
}).annotate(Flow.Placement, Placement.remote({ target: "b" }))

const Parent = Flow.make("placement/parent", {
  payload: { version: Schema.String },
  success: Schema.String,
  body: (payload) => Release.child(payload).pipe(Node.map((released) => `parent saw ${released}`))
})

/** Engine B: serves `Release` over a real HTTP listener; its step runs `step`. */
const engineB = (step: (version: string) => Effect.Effect<string>) =>
  Layer.build(
    HttpRouter.serve(
      RpcServer.layerHttp({ group: FlowProxy.toRpcGroup([Release]), path: "/", protocol: "http" }).pipe(
        Layer.provide(FlowProxyServer.layerRpcHandlers([Release])),
        Layer.provide(RpcSerialization.layerJson)
      )
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(Step.toLayer(({ version }) => step(version)), Interpreter.layer(Release)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory)
        )
      ),
      Layer.provideMerge(NodeHttpServer.layerTest)
    )
  )

/**
 * Engine A: drives `Parent`, with `b` bound to engine B's served group through
 * `client`. `sent` records the tag of every RPC that leaves A.
 */
const engineA = (
  client: Context.Context<HttpClient.HttpClient>,
  sent: Array<string> = [],
  wrap: (binding: Hosts.Binding) => Hosts.Binding = (binding) => binding
) =>
  Layer.build(
    Interpreter.layer(Parent).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(Hosts.layer({
        b: wrap({
          _tag: "Proxy",
          connect: (group) =>
            RpcClient.make(group as never).pipe(
              Effect.provide(
                // The test client already prefixes the listener address.
                RpcClient.layerProtocolHttp({
                  url: "",
                  transformClient: (http) =>
                    HttpClient.tapRequest(http, (request) =>
                      Effect.sync(() => {
                        const body = request.body as { readonly body?: Uint8Array }
                        const message = JSON.parse(new TextDecoder().decode(body.body)) as {
                          _tag: string
                          tag?: string
                        }
                        // Only requests; the client's own Interrupt messages name no operation.
                        if (message._tag === "Request") sent.push(message.tag!)
                      }))
                }).pipe(
                  Layer.provide(RpcSerialization.layerJson),
                  Layer.provide(Layer.succeedContext(client))
                )
              )
            )
        })
      }))
    )
  )

/** Runs `effect` on engine A. A placed flow's requirements are met on B, which the types cannot see. */
const onA = (a: Context.Context<any>) => <X, E>(effect: Effect.Effect<X, E, any>): Effect.Effect<X, E> =>
  Effect.provide(effect, a) as Effect.Effect<X, E>

/** A connection the transport lost, as a reset tunnel reports it. */
const transportLost = new RpcClientError({
  reason: new HttpClientErrorSchema({ _tag: "HttpError", kind: "TransportError", cause: undefined })
})

const runtimeOf = (context: Context.Context<never>) =>
  Context.get(context as Context.Context<FlowRuntime.FlowRuntime>, FlowRuntime.FlowRuntime)

const childId = (parent: string, version: string) =>
  Interpreter.childExecutionId(parent, "root.flow.map", Release._tag, { version })

describe("a placed .child()", () => {
  it.effect("runs on the engine its placement names, under the id the parent derived", () =>
    withCrypto(
      Effect.gen(function*() {
        const steps: Array<string> = []
        const b = yield* engineB((version) => Effect.sync(() => (steps.push(version), `released ${version}`)))
        const a = yield* engineA(b)
        const result = yield* Parent.execute({ version: "1.0" }, { executionId: "parent-1" }).pipe(onA(a))

        expect(result).toBe("parent saw released 1.0")
        expect(steps).toEqual(["1.0"])
        const id = yield* childId("parent-1", "1.0")
        const remote = yield* runtimeOf(b as never).poll(Release, id)
        expect(Option.map(remote, (settled) => settled._tag)).toEqual(Option.some("Complete"))
        const local = yield* Effect.flip(runtimeOf(a as never).poll(Release, id))
        expect(local._tag).toBe("@smthrs/flow/FlowExecutionNotFound")
      }).pipe(Effect.scoped)
    ))

  it.effect("joins the remote run when the parent asks again under the same id", () =>
    withCrypto(
      Effect.gen(function*() {
        const steps: Array<string> = []
        const b = yield* engineB((version) => Effect.sync(() => (steps.push(version), `released ${version}`)))
        const a = yield* engineA(b)
        const first = yield* Parent.execute({ version: "2.0" }, { executionId: "parent-2" }).pipe(onA(a))
        const again = yield* Release.execute({ version: "2.0" }, { executionId: yield* childId("parent-2", "2.0") })
          .pipe(onA(a))
        expect(first).toBe("parent saw released 2.0")
        expect(again).toBe("released 2.0")
        expect(steps).toEqual(["2.0"])
      }).pipe(Effect.scoped)
    ))

  it.effect("forwards the parent's cancellation to the remote run", () =>
    withCrypto(
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        let interrupted = false
        const b = yield* engineB(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => (interrupted = true)))
          )
        )
        const sent: Array<string> = []
        const a = yield* engineA(b, sent)
        const running = yield* Effect.forkChild(
          Parent.execute({ version: "3.0" }, { executionId: "parent-3" }).pipe(onA(a))
        )
        yield* Deferred.await(started)
        yield* runtimeOf(a as never).interrupt(Parent, "parent-3")
        const exit = yield* Fiber.await(running)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(interrupted).toBe(true)
        expect(sent).toEqual(["placement/release", "placement/releaseInterrupt"])
      }).pipe(Effect.scoped)
    ))

  it.effect("reaches the remote engine to interrupt a placed execution", () =>
    withCrypto(
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        let interrupted = false
        const b = yield* engineB(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => (interrupted = true)))
          )
        )
        const a = yield* engineA(b)
        const running = yield* Effect.forkChild(
          Release.execute({ version: "4.0" }, { executionId: "release-4" }).pipe(onA(a))
        )
        yield* Deferred.await(started)
        // A has no run named release-4, so only the forwarded request can reach B's step.
        yield* runtimeOf(a as never).interrupt(Release, "release-4").pipe(onA(a))
        yield* Fiber.await(running)
        expect(interrupted).toBe(true)
      }).pipe(Effect.scoped)
    ))

  it.effect("refuses another payload under an id the remote engine already holds", () =>
    withCrypto(
      Effect.gen(function*() {
        const steps: Array<string> = []
        const b = yield* engineB((version) => Effect.sync(() => (steps.push(version), `released ${version}`)))
        const a = yield* engineA(b)
        yield* Release.execute({ version: "5.0" }, { executionId: "release-5" }).pipe(onA(a))
        const exit = yield* Effect.exit(
          Release.execute({ version: "5.1" }, { executionId: "release-5" }).pipe(onA(a))
        )
        // The remote engine refuses it; the served boundary reports a redacted defect.
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          name: "@smthrs/engine/FlowHandlerDefect"
        })
        expect(steps).toEqual(["5.0"])
      }).pipe(Effect.scoped)
    ))

  it.effect("dies with the transport's error once the remote engine stays unreachable", () =>
    withCrypto(
      Effect.gen(function*() {
        let asks = 0
        const a = yield* Layer.build(
          Interpreter.layer(Parent).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(FlowEngine.layerMemory),
            Layer.provideMerge(Hosts.layer({
              b: {
                _tag: "Proxy",
                connect: (group) =>
                  RpcClient.make(group as never).pipe(
                    Effect.provide(
                      // Port 1 answers nothing.
                      RpcClient.layerProtocolHttp({
                        url: "http://127.0.0.1:1/",
                        transformClient: (http) => HttpClient.tapRequest(http, () => Effect.sync(() => asks++))
                      }).pipe(
                        Layer.provide(RpcSerialization.layerJson),
                        Layer.provide(FetchHttpClient.layer)
                      )
                    )
                  )
              }
            }))
          )
        )
        // The caller keeps asking for about six minutes before it gives up.
        const asking = yield* Effect.forkChild(
          Parent.execute({ version: "6.0" }, { executionId: "parent-6" }).pipe(onA(a))
        )
        // Each retry's sleep registers only after the failed fetch settles on
        // an I/O turn, so the clock moves one macrotask at a time until done.
        for (let step = 0; step < 60 && asking.pollUnsafe() === undefined; step++) {
          yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
          yield* TestClock.adjust("1 minute")
        }
        expect(asking.pollUnsafe()).toBeDefined()
        const exit = yield* Fiber.await(asking)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ _tag: "RpcClientError" })
        // The first ask and twelve more.
        expect(asks).toBe(13)
      }).pipe(Effect.scoped)
    ))

  it.live(
    "asks again under the same id when the transport drops mid-child, and the remote run answers once",
    () =>
      withCrypto(
        Effect.gen(function*() {
          const release = yield* Deferred.make<void>()
          const started = yield* Deferred.make<void>()
          const steps: Array<string> = []
          const b = yield* engineB((version) =>
            Effect.sync(() => steps.push(version)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(`released ${version}`)
            )
          )
          const sent: Array<string> = []
          // The first ask loses its connection once B's run is going, as a reset tunnel does.
          let dropped = false
          const flaky = (proxy: Hosts.Binding): Hosts.Binding => ({
            _tag: "Proxy",
            connect: (group) =>
              Effect.map((proxy as Extract<Hosts.Binding, { _tag: "Proxy" }>).connect(group), (client) =>
                new Proxy(client as Record<string, (request: object) => Effect.Effect<unknown, unknown>>, {
                  get: (target, operation: string) =>
                  (request: object) =>
                    // Decided per attempt: the caller's retry runs this effect again.
                    Effect.suspend(() =>
                      dropped || operation !== "placement/release"
                        ? target[operation]!(request)
                        : Effect.raceFirst(
                          target[operation]!(request),
                          Effect.andThen(
                            Deferred.await(started),
                            Effect.suspend(() => {
                              dropped = true
                              return Effect.fail(transportLost)
                            })
                          )
                        )
                    )
                }))
          })
          const a = yield* engineA(b, sent, flaky)
          const shipping = yield* Effect.forkChild(
            Parent.execute({ version: "9.0" }, { executionId: "parent-9" }).pipe(onA(a))
          )
          yield* Effect.sleep("1500 millis")
          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(shipping)).toBe("parent saw released 9.0")
          expect(dropped).toBe(true)
          expect(steps).toEqual(["9.0"])
          expect(sent).toEqual(["placement/release", "placement/release"])
        }).pipe(Effect.scoped)
      ),
    30_000
  )

  it.effect("fails with the remote flow's declared error, asked once", () =>
    withCrypto(
      Effect.gen(function*() {
        const Refuse = Action.make("placement/refuse-step", {
          payload: {},
          success: Schema.Void,
          error: Schema.Literal("refused")
        })
        const Refused = Flow.make("placement/refused", {
          payload: {},
          success: Schema.Void,
          error: Schema.Literal("refused"),
          body: () => Refuse.call({})
        }).annotate(Flow.Placement, Placement.remote({ target: "b" }))
        const served = yield* Layer.build(
          HttpRouter.serve(
            RpcServer.layerHttp({ group: FlowProxy.toRpcGroup([Refused]), path: "/", protocol: "http" }).pipe(
              Layer.provide(FlowProxyServer.layerRpcHandlers([Refused])),
              Layer.provide(RpcSerialization.layerJson)
            )
          ).pipe(
            Layer.provideMerge(
              Layer.mergeAll(Refuse.toLayer(() => Effect.fail("refused" as const)), Interpreter.layer(Refused)).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(FlowEngine.layerMemory)
              )
            ),
            Layer.provideMerge(NodeHttpServer.layerTest)
          )
        )
        const sent: Array<string> = []
        const a = yield* engineA(served, sent)
        const failure = yield* Effect.flip(Refused.execute({}, { executionId: "refused-1" }).pipe(onA(a)))
        expect(failure).toBe("refused")
        expect(sent).toEqual(["placement/refused"])
      }).pipe(Effect.scoped)
    ))

  it.live("does not ask again when the client cannot read the remote engine's answer", () =>
    withCrypto(
      Effect.gen(function*() {
        const b = yield* engineB((version) => Effect.succeed(`released ${version}`))
        const sent: Array<string> = []
        let asks = 0
        const unreadable = (proxy: Hosts.Binding): Hosts.Binding => ({
          _tag: "Proxy",
          connect: (group) =>
            Effect.map((proxy as Extract<Hosts.Binding, { _tag: "Proxy" }>).connect(group), () => ({
              "placement/release": () =>
                Effect.suspend(() => {
                  asks++
                  return Effect.fail(
                    new RpcClientError({
                      reason: new RpcClientDefect({ message: "not an RPC body", cause: undefined })
                    })
                  )
                })
            }))
        })
        const a = yield* engineA(b, sent, unreadable)
        const exit = yield* Effect.exit(
          Release.execute({ version: "11.0" }, { executionId: "release-11" }).pipe(onA(a))
        )
        // A defect, not a failure the flow declared.
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          _tag: "RpcClientError",
          reason: { _tag: "RpcClientDefect" }
        })
        expect(asks).toBe(1)
      }).pipe(Effect.scoped)
    ), 30_000)

  it.live("joins the remote run when a parent that died mid-child is driven again", () =>
    withCrypto(
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const steps: Array<string> = []
        const b = yield* engineB((version) =>
          Effect.sync(() => steps.push(version)).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as(`released ${version}`)
          )
        )
        // The first caller dies with its engine while the remote child runs.
        const firstScope = yield* Scope.make()
        const first = yield* engineA(b).pipe(Scope.provide(firstScope))
        yield* Effect.forkIn(
          Parent.execute({ version: "10.0" }, { executionId: "parent-10" }).pipe(onA(first)),
          firstScope
        )
        yield* Deferred.await(started)
        yield* Scope.close(firstScope, Exit.void)
        // A fresh caller re-derives the same child id and joins the remote run.
        const again = yield* engineA(b)
        const driven = yield* Effect.forkChild(
          Parent.execute({ version: "10.0" }, { executionId: "parent-10" }).pipe(onA(again))
        )
        yield* Effect.sleep("300 millis")
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(driven)).toBe("parent saw released 10.0")
        expect(steps).toEqual(["10.0"])
      }).pipe(Effect.scoped)
    ), 30_000)

  it.effect("starts a discarded placed execution on the remote engine and answers its id", () =>
    withCrypto(
      Effect.gen(function*() {
        const sent: Array<string> = []
        const released = yield* Deferred.make<string>()
        const b = yield* engineB((version) => Effect.as(Deferred.succeed(released, version), `released ${version}`))
        const a = yield* engineA(b, sent)
        const id = yield* Release.execute({ version: "8.0" }, { executionId: "release-8", discard: true }).pipe(onA(a))
        expect(id).toBe("release-8")
        expect(yield* Deferred.await(released)).toBe("8.0")
        expect(sent).toEqual(["placement/releaseDiscard"])
      }).pipe(Effect.scoped)
    ))

  it.effect("sends resume for a placed execution to the remote engine", () =>
    withCrypto(
      Effect.gen(function*() {
        const sent: Array<string> = []
        const b = yield* engineB((version) => Effect.succeed(`released ${version}`))
        const a = yield* engineA(b, sent)
        yield* Release.execute({ version: "7.0" }, { executionId: "release-7" }).pipe(onA(a))
        yield* runtimeOf(a as never).resume(Release, "release-7").pipe(onA(a))
        expect(sent).toEqual(["placement/release", "placement/releaseResume"])
      }).pipe(Effect.scoped)
    ))
})

describe("Hosts.layer", () => {
  it.effect("binds a named target and runs every other placement here", () =>
    Effect.gen(function*() {
      const box = { _tag: "Proxy" as const, connect: () => Effect.die("unused") }
      const hosts = yield* Hosts.Hosts.pipe(Effect.provide(Hosts.layer({ box })))
      expect(hosts.resolve(Placement.sandbox({ target: "box" }))).toBe(box)
      for (
        const placement of [
          undefined,
          Placement.local(),
          Placement.client(),
          Placement.remote({}),
          Placement.remote({ target: "elsewhere" }),
          Placement.remote({ target: "toString" })
        ]
      ) expect(hosts.resolve(placement)).toEqual({ _tag: "Here" })
      expect((yield* Hosts.Hosts).resolve(Placement.sandbox({ target: "box" }))).toEqual({ _tag: "Here" })
    }))
})
