/**
 * A placed execution carries the caller's capability ceiling, narrowed by the
 * flow's own declaration, to the remote engine (#2852). These cases pin what
 * the client sends; `@smthrs/engine-store`'s `RemoteCapabilityCeiling` cases
 * prove the serving engine enforces it across two processes.
 */
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

type Sent = { readonly operation: string; readonly request: { readonly capabilityCeilings?: unknown } }

const proxy = (sent: Array<Sent>, tag: string = Remote._tag): Hosts.Binding => ({
  _tag: "Proxy",
  connect: () =>
    Effect.sync(() => {
      const operations = FlowProxy.operationAddresses(tag)
      const record = (operation: string, answer: unknown) => (request: Sent["request"]) =>
        Effect.sync(() => {
          sent.push({ operation, request })
          return answer
        })
      return {
        [operations.execute]: record("execute", "remote"),
        [operations.discard]: record("discard", undefined),
        [operations.resume]: record("resume", undefined),
        [operations.interrupt]: record("interrupt", undefined)
      } as never
    })
})

const layer = (flow: ReturnType<typeof parent>, sent: Array<Sent>) =>
  Interpreter.layer(flow).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(Hosts.layer({ remote: proxy(sent) }))
  )

const squashed = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

const pattern = (action: string, resource: string) => new CapabilityPattern({ action: action as never, resource })
const readSource = [pattern("fs:read", "src/**")]
const ceilingsOf = (sent: Sent) =>
  (sent.request.capabilityCeilings as ReadonlyArray<ReadonlyArray<CapabilityPattern>>).map((group) =>
    group.map(({ action, resource }) => `${action}:${resource}`)
  )

describe("remote placement capability ceiling", () => {
  it.effect("forwards a restricted caller's ceiling for execute and discard", () =>
    withCrypto(
      Effect.gen(function*() {
        const sent: Array<Sent> = []
        const Parent = parent("ceiling-placement/restricted-parent", ["fs:read:src/**"])
        expect(yield* Parent.execute({}, { executionId: "restricted-child" }).pipe(Effect.provide(layer(Parent, sent))))
          .toBe("remote")
        for (const discard of [false, true]) {
          yield* Remote.execute({}, { executionId: `restricted-${discard}`, discard }).pipe(
            CapabilitySet.attenuate(readSource),
            Effect.provide(layer(Parent, sent))
          )
        }
        expect(sent.map(({ operation }) => operation)).toEqual(["execute", "execute", "discard"])
        for (const request of sent) expect(ceilingsOf(request)).toEqual([["fs:read:src/**"]])
      }).pipe(Effect.scoped)
    ))

  it.effect("narrows the forwarded ceiling by the flow's own declaration", () =>
    withCrypto(
      Effect.gen(function*() {
        const sent: Array<Sent> = []
        const Own = Remote.annotate(Flow.Capabilities, ["fs:write:out/**"])
        yield* Own.execute({}, { executionId: "own-restricted" }).pipe(
          CapabilitySet.attenuate(readSource),
          Effect.provide(layer(parent("ceiling-placement/own-host"), sent))
        )
        const Denied = Remote.annotate(Flow.Capabilities, [])
        yield* Denied.execute({}, { executionId: "own-empty" }).pipe(
          Effect.provide(layer(parent("ceiling-placement/own-empty-host"), sent))
        )
        expect(sent.map(ceilingsOf)).toEqual([[["fs:read:src/**"], ["fs:write:out/**"]], [[]]])
      }).pipe(Effect.scoped)
    ))

  it.effect("forwards omitted and universal ceilings as they are", () =>
    withCrypto(
      Effect.gen(function*() {
        const sent: Array<Sent> = []
        for (
          const [tag, capabilities] of [
            ["ceiling-placement/omitted", undefined],
            ["ceiling-placement/universal", ["*"]]
          ] as const
        ) {
          const Parent = parent(tag, capabilities)
          expect(yield* Parent.execute({}, { executionId: tag }).pipe(Effect.provide(layer(Parent, sent)))).toBe(
            "remote"
          )
        }
        expect(sent.map(ceilingsOf)).toEqual([[], [["*:**"]]])
      }).pipe(Effect.scoped)
    ))

  it.effect("forwards a placed action's ceiling, including the action's own declaration", () =>
    withCrypto(
      Effect.gen(function*() {
        const Sign = Action.make("ceiling-placement/sign", {
          payload: {},
          success: Schema.String,
          capabilities: ["net:post:sign.example"]
        })
        const Parent = Flow.make("ceiling-placement/action-parent", {
          payload: {},
          success: Schema.String,
          capabilities: ["fs:read:src/**"],
          body: () => Sign.call({})
        })
        const sent: Array<Sent> = []
        const wired = Layer.mergeAll(
          PlacedAction.layer(Sign, remotePlacement, () => Effect.succeed("local")),
          Interpreter.layer(Parent)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(Hosts.layer({ remote: proxy(sent, PlacedAction.served(Sign)._tag) }))
        )
        expect(yield* Parent.execute({}, { executionId: "restricted-action" }).pipe(Effect.provide(wired)))
          .toBe("remote")
        expect(sent.map(ceilingsOf)).toEqual([[["fs:read:src/**"], ["net:post:sign.example"]]])
      }).pipe(Effect.scoped)
    ))

  it.effect("forwards the ceiling on remote resume and none on interrupt", () =>
    withCrypto(
      Effect.gen(function*() {
        const sent: Array<Sent> = []
        const runtime = yield* FlowRuntime.FlowRuntime.pipe(
          Effect.provide(layer(parent("ceiling-placement/resume-host"), sent))
        )
        yield* CapabilitySet.attenuate(readSource)(runtime.resume(Remote, "remote-run", { poll: true }))
          .pipe(Effect.provide(Hosts.layer({ remote: proxy(sent) })))
        yield* CapabilitySet.attenuate(readSource)(runtime.interrupt(Remote, "remote-run"))
          .pipe(Effect.provide(Hosts.layer({ remote: proxy(sent) })))
        expect(sent.map(({ operation }) => operation)).toEqual(["resume", "interrupt"])
        expect(ceilingsOf(sent[0]!)).toEqual([["fs:read:src/**"]])
        expect(sent[0]!.request).toMatchObject({ executionId: "remote-run", poll: true })
        // Cancellation needs no authority: it can only stop work.
        expect(sent[1]!.request).toEqual({ executionId: "remote-run" })
      }).pipe(Effect.scoped)
    ))

  it.effect("refuses a delegated remote resume before connecting", () =>
    withCrypto(
      Effect.gen(function*() {
        const sent: Array<Sent> = []
        const runtime = yield* FlowRuntime.FlowRuntime.pipe(
          Effect.provide(layer(parent("ceiling-placement/delegated-host"), sent))
        )
        // The remote resume API is operator recovery consent; a background
        // delegation must not be promoted to it by crossing the placement.
        const exit = yield* Effect.exit(
          runtime.resume(Remote, "remote-run", { delegated: true })
            .pipe(Effect.provide(Hosts.layer({ remote: proxy(sent) })))
        )
        expect(String(squashed(exit))).toContain("cannot cross a remote placement")
        expect(sent).toEqual([])
      }).pipe(Effect.scoped)
    ))

  it("bounds the ceiling a request may carry", () => {
    const group = FlowProxy.toRpcGroup([Remote])
    const rpc = [...group.requests.values()].find((candidate) => candidate._tag === Remote._tag)!
    const decode = Schema.decodeUnknownExit(rpc.payloadSchema as Schema.Codec<unknown>)
    const request = (capabilityCeilings: unknown) => ({ payload: {}, executionId: "id", capabilityCeilings })
    const one = { action: "fs:read", resource: "src/**" }
    expect(Exit.isSuccess(decode(request([Array(FlowProxy.maxCeilingPatterns).fill(one)])))).toBe(true)
    expect(Exit.isSuccess(decode(request(Array(FlowProxy.maxCeilingGroups).fill([one]))))).toBe(true)
    expect(Exit.isFailure(decode(request([Array(FlowProxy.maxCeilingPatterns + 1).fill(one)])))).toBe(true)
    expect(Exit.isFailure(decode(request(Array(FlowProxy.maxCeilingGroups + 1).fill([one]))))).toBe(true)
    expect(Exit.isFailure(decode(request([[{ action: "fs:read" }]])))).toBe(true)
    expect(Exit.isSuccess(decode({ payload: {}, executionId: "id" }))).toBe(true)
  })
})
