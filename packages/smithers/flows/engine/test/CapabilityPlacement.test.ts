import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Placement from "@smthrs/plan/Placement"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { FlowEngine, FlowProxy, Hosts, PlacedAction } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const remotePlacement = Placement.remote({ target: "remote" })
const Remote = Flow.make("ceiling-placement/remote", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("remote")
}).annotate(Flow.Placement, remotePlacement)

const parent = (tag: string, capabilities?: ReadonlyArray<string>) =>
  Flow.make(tag, {
    payload: {},
    success: Schema.String,
    ...(capabilities === undefined ? {} : { capabilities }),
    body: () => Remote.child({})
  })

const proxy = (calls: Array<string>): Hosts.Binding => ({
  _tag: "Proxy",
  connect: () =>
    Effect.sync(() => {
      calls.push("connect")
      const operations = FlowProxy.operationAddresses(Remote._tag)
      return {
        [operations.execute]: () => Effect.succeed("remote"),
        [operations.discard]: () => Effect.succeed(undefined),
        [operations.resume]: () => Effect.succeed(undefined)
      } as never
    })
})

const layer = (flow: ReturnType<typeof parent>, calls: Array<string>) =>
  Interpreter.layer(flow).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(Hosts.layer({ remote: proxy(calls) }))
  )

const squashed = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

const restricted = [new CapabilityPattern({ action: "fs:read", resource: "src/**" })]

describe("remote placement capability ceiling", () => {
  it.effect("refuses a restricted child before connecting for execute or discard", () =>
    withCrypto(
      Effect.gen(function*() {
        const calls: Array<string> = []
        const Parent = parent("ceiling-placement/restricted-parent", ["fs:read:src/**"])
        const child = yield* Effect.exit(
          Parent.execute({}, { executionId: "restricted-child" }).pipe(Effect.provide(layer(Parent, calls)))
        )
        expect(squashed(child)).toBeInstanceOf(FlowEngine.RemoteCapabilityCeilingUnsupported)
        for (const discard of [false, true]) {
          const exit = yield* Effect.exit(
            Remote.execute({}, { executionId: `restricted-${discard}`, discard }).pipe(
              CapabilitySet.attenuate(restricted),
              Effect.provide(layer(Parent, calls))
            )
          )
          expect(squashed(exit)).toBeInstanceOf(FlowEngine.RemoteCapabilityCeilingUnsupported)
        }
        expect(calls).toEqual([])
      }).pipe(Effect.scoped)
    ))

  it.effect("refuses remote execution constrained by its own declaration", () =>
    withCrypto(
      Effect.gen(function*() {
        const calls: Array<string> = []
        const RestrictedRemote = Remote.annotate(Flow.Capabilities, [])
        const exit = yield* Effect.exit(
          RestrictedRemote.execute({}, { executionId: "own-restricted" }).pipe(
            Effect.provide(layer(parent("ceiling-placement/own-host"), calls))
          )
        )
        expect(squashed(exit)).toBeInstanceOf(FlowEngine.RemoteCapabilityCeilingUnsupported)
        expect(calls).toEqual([])
      }).pipe(Effect.scoped)
    ))

  it.effect("allows omitted and universal ceilings to reach a remote child", () =>
    withCrypto(
      Effect.gen(function*() {
        const calls: Array<string> = []
        for (
          const [tag, capabilities] of [
            ["ceiling-placement/omitted", undefined],
            ["ceiling-placement/universal", ["*"]]
          ] as const
        ) {
          const Parent = parent(tag, capabilities)
          const result = yield* Parent.execute({}, { executionId: tag }).pipe(Effect.provide(layer(Parent, calls)))
          expect(result).toBe("remote")
        }
        expect(calls).toEqual(["connect", "connect"])
      }).pipe(Effect.scoped)
    ))

  it.effect("refuses a placed action under a restricted caller before connecting", () =>
    withCrypto(
      Effect.gen(function*() {
        const Sign = Action.make("ceiling-placement/sign", { payload: {}, success: Schema.String })
        const Parent = Flow.make("ceiling-placement/action-parent", {
          payload: {},
          success: Schema.String,
          capabilities: ["fs:read:src/**"],
          body: () => Sign.call({})
        })
        const calls: Array<string> = []
        const binding: Hosts.Binding = {
          _tag: "Proxy",
          connect: () =>
            Effect.sync(() => {
              calls.push("connect")
              return {} as never
            })
        }
        const wired = Layer.mergeAll(
          PlacedAction.layer(Sign, remotePlacement, () => Effect.succeed("local")),
          Interpreter.layer(Parent)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(Hosts.layer({ remote: binding }))
        )
        const exit = yield* Effect.exit(
          Parent.execute({}, { executionId: "restricted-action" }).pipe(Effect.provide(wired))
        )
        expect(squashed(exit)).toBeInstanceOf(FlowEngine.RemoteCapabilityCeilingUnsupported)
        expect(calls).toEqual([])
      }).pipe(Effect.scoped)
    ))

  it.effect("refuses remote resume under an ambient restriction before connecting", () =>
    withCrypto(
      Effect.gen(function*() {
        const calls: Array<string> = []
        const runtime = yield* FlowRuntime.FlowRuntime.pipe(
          Effect.provide(layer(parent("ceiling-placement/resume-host"), calls))
        )
        const exit = yield* Effect.exit(
          CapabilitySet.attenuate(restricted)(runtime.resume(Remote, "remote-run"))
            .pipe(Effect.provide(Hosts.layer({ remote: proxy(calls) })))
        )
        expect(squashed(exit)).toBeInstanceOf(FlowEngine.RemoteCapabilityCeilingUnsupported)
        expect(calls).toEqual([])
      }).pipe(Effect.scoped)
    ))

  it.effect("refuses a delegated remote resume before connecting", () =>
    withCrypto(
      Effect.gen(function*() {
        const calls: Array<string> = []
        const runtime = yield* FlowRuntime.FlowRuntime.pipe(
          Effect.provide(layer(parent("ceiling-placement/delegated-host"), calls))
        )
        // The remote resume API is operator recovery consent; a background
        // delegation must not be promoted to it by crossing the placement.
        const exit = yield* Effect.exit(
          runtime.resume(Remote, "remote-run", { delegated: true })
            .pipe(Effect.provide(Hosts.layer({ remote: proxy(calls) })))
        )
        expect(String(squashed(exit))).toContain("cannot cross a remote placement")
        expect(calls).toEqual([])
      }).pipe(Effect.scoped)
    ))
})
