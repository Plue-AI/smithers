/**
 * An action implemented with `PlacedAction.layer` runs its body here, or on
 * the holder that serves `PlacedAction.served(action)`, under its invocation
 * key. The secret-holder scenario over two durable engines is
 * `examples/test/42-placed-deploy.test.ts`.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Placement from "@smthrs/plan/Placement"
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpClientErrorSchema } from "effect/unstable/http/HttpClientError"
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { FlowEngine, FlowProxy, FlowProxyServer, Hosts, PlacedAction } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const Sign = Action.make("placed-action/sign", {
  payload: { document: Schema.String },
  success: Schema.String
})

const Signs = Flow.make("placed-action/signs", {
  payload: { document: Schema.String },
  success: Schema.String,
  body: (payload) => Sign.call(payload)
})

const holderPlacement = Placement.remote({ target: "holder" })

/** The holder: serves `Sign` over HTTP; its step runs `sign`. */
const holderWith = (sign: (document: string) => Effect.Effect<string>) =>
  Layer.build(
    HttpRouter.serve(
      RpcServer.layerHttp({
        group: FlowProxy.toRpcGroup([PlacedAction.served(Sign)]),
        path: "/",
        protocol: "http"
      }).pipe(
        Layer.provide(FlowProxyServer.layerRpcHandlers([PlacedAction.served(Sign)])),
        Layer.provide(RpcSerialization.layerJson)
      )
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Sign.toLayer(({ document }) => sign(document)),
          Interpreter.layer(PlacedAction.served(Sign))
        ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory))
      ),
      Layer.provideMerge(NodeHttpServer.layerTest)
    )
  )

/** The holder: serves `Sign` over HTTP and signs with its own key. */
const holder = (signed: Array<string>) =>
  holderWith((document) => Effect.sync(() => (signed.push(document), `holder signed ${document}`)))

/** A proxy binding to the holder reached through `http`. */
const toHolder = (http: Context.Context<HttpClient.HttpClient>, sent: Array<string> = []): Hosts.Binding => ({
  _tag: "Proxy",
  connect: (group) =>
    RpcClient.make(group as never).pipe(
      Effect.provide(
        RpcClient.layerProtocolHttp({
          url: "",
          transformClient: (client) =>
            HttpClient.tapRequest(client, (request) =>
              Effect.sync(() => {
                const message = JSON.parse(
                  new TextDecoder().decode((request.body as { readonly body?: Uint8Array }).body)
                ) as { readonly _tag: string; readonly tag?: string }
                if (message._tag === "Request") sent.push(message.tag!)
              }))
        }).pipe(
          Layer.provide(RpcSerialization.layerJson),
          Layer.provide(Layer.succeedContext(http))
        )
      )
    )
})

/** The caller: implements `Sign` placed on the holder, with `local` as the body run here. */
const caller = (table: Record<string, Hosts.Binding>, local: Array<string>) =>
  Layer.mergeAll(
    PlacedAction.layer(Sign, holderPlacement, ({ document }) =>
      Effect.sync(() => (local.push(document), `caller signed ${document}`))),
    Interpreter.layer(Signs)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(Hosts.layer(table))
  )

describe("PlacedAction", () => {
  it.effect("runs the body here when the table binds the placement here", () =>
    withCrypto(
      Effect.gen(function*() {
        const local: Array<string> = []
        const signed = yield* Signs.execute({ document: "memo" }, { executionId: "here-1" }).pipe(
          Effect.provide(caller({}, local))
        )
        expect(signed).toBe("caller signed memo")
        expect(local).toEqual(["memo"])
      }).pipe(Effect.scoped)
    ))

  it.effect("runs the body on the holder, never here, when the table binds it there", () =>
    withCrypto(
      Effect.gen(function*() {
        const signed: Array<string> = []
        const local: Array<string> = []
        const held = yield* holder(signed)
        const http = Context.make(HttpClient.HttpClient, Context.get(held, HttpClient.HttpClient))
        const result = yield* Signs.execute({ document: "contract" }, { executionId: "there-1" }).pipe(
          Effect.provide(caller({ holder: toHolder(http) }, local))
        )
        expect(result).toBe("holder signed contract")
        expect(signed).toEqual(["contract"])
        expect(local).toEqual([])
      }).pipe(Effect.scoped)
    ))

  it("serves one flow per action, tagged <action>/remote", () => {
    expect(PlacedAction.served(Sign)).toBe(PlacedAction.served(Sign))
    expect(PlacedAction.served(Sign)._tag).toBe("placed-action/sign/remote")
  })

  it.live(
    "asks the holder again under the same key when the reply is lost, and the body runs once",
    () =>
      withCrypto(
        Effect.gen(function*() {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const signed: Array<string> = []
          const held = yield* holderWith((document) =>
            Effect.sync(() => signed.push(document)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(`holder signed ${document}`)
            )
          )
          const http = Context.make(HttpClient.HttpClient, Context.get(held, HttpClient.HttpClient))
          const direct = toHolder(http) as Extract<Hosts.Binding, { _tag: "Proxy" }>
          let lost = false
          const lossy: Hosts.Binding = {
            _tag: "Proxy",
            connect: (group) =>
              Effect.map(direct.connect(group), (client) =>
                new Proxy(client as Record<string, (request: object) => Effect.Effect<unknown, unknown>>, {
                  get: (target, operation: string) =>
                  (request: object) =>
                    Effect.suspend(() =>
                      lost
                        ? target[operation]!(request)
                        // The reply is lost once the holder has started the body.
                        : Effect.raceFirst(
                          target[operation]!(request),
                          Effect.andThen(
                            Deferred.await(started),
                            Effect.suspend(() => ((lost = true), Effect.fail(transportLost)))
                          )
                        )
                    )
                }))
          }
          const signing = yield* Effect.forkChild(
            Signs.execute({ document: "lease" }, { executionId: "lossy-1" }).pipe(
              Effect.provide(caller({ holder: lossy }, []))
            )
          )
          yield* Deferred.await(started)
          yield* Effect.sleep("600 millis")
          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(signing)).toBe("holder signed lease")
          expect(lost).toBe(true)
          expect(signed).toEqual(["lease"])
        }).pipe(Effect.scoped)
      ),
    30_000
  )

  it.live(
    "leaves the holder's run going when the caller is cancelled while the holder runs the body",
    () =>
      withCrypto(
        Effect.gen(function*() {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const finished = yield* Deferred.make<string>()
          const held = yield* holderWith((document) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Deferred.succeed(finished, document)),
              Effect.as(`holder signed ${document}`)
            )
          )
          const http = Context.make(HttpClient.HttpClient, Context.get(held, HttpClient.HttpClient))
          const sent: Array<string> = []
          const callerContext = yield* Layer.build(caller({ holder: toHolder(http, sent) }, []))
          const signing = yield* Effect.forkChild(
            Signs.execute({ document: "draft" }, { executionId: "cancel-1" }).pipe(Effect.provide(callerContext))
          )
          yield* Deferred.await(started)
          yield* Context.get(callerContext as Context.Context<FlowRuntime.FlowRuntime>, FlowRuntime.FlowRuntime)
            .interrupt(Signs, "cancel-1").pipe(Effect.provide(callerContext))
          yield* Fiber.await(signing)
          yield* Deferred.succeed(release, undefined)
          expect(yield* Deferred.await(finished)).toBe("draft")
          expect(sent).toEqual(["placed-action/sign/remote"])
        }).pipe(Effect.scoped)
      ),
    30_000
  )
})

/** A connection the transport lost, as a reset tunnel reports it. */
const transportLost = new RpcClientError({
  reason: new HttpClientErrorSchema({ _tag: "HttpError", kind: "TransportError", cause: undefined })
})
