/**
 * A join answers the result the admitted authority produced, so the in-memory
 * engine admits a join only when the caller's ceiling covers the one the
 * execution was admitted with (#2852). The durable driver applies the same
 * `FlowEngine.joinable` rule; its cases live in `@smthrs/engine-store`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const secret = new Capability({ action: "fs:read", resource: "secret/key" })
const readSecret = [new CapabilityPattern({ action: "fs:read", resource: "secret/**" })]
const readSource = [new CapabilityPattern({ action: "fs:read", resource: "src/**" })]
const everything = [new CapabilityPattern({ action: "*", resource: "**" })]

const conflictOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined

const setup = (capabilities?: ReadonlyArray<string>) => {
  let runs = 0
  const Read = Action.make("join-authority/read", { payload: {}, success: Schema.String })
  const flow = Flow.make("join-authority/flow", {
    payload: { id: Schema.String },
    success: Schema.String,
    ...(capabilities === undefined ? {} : { capabilities }),
    body: () => Read.call({})
  })
  const layer = Layer.mergeAll(
    Read.toLayer(() =>
      Effect.map(CapabilitySet.current, (set) => {
        runs++
        return CapabilitySet.allows(set, secret) ? "secret contents" : "denied"
      })
    ),
    Interpreter.layer(flow)
  ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory))
  return { flow, layer, runs: () => runs }
}

const under = CapabilitySet.attenuate

describe("joining an execution under a capability ceiling", () => {
  it.effect("refuses a narrower caller the result a wider run produced", () =>
    withCrypto(Effect.gen(function*() {
      const { flow, layer, runs } = setup()
      yield* Effect.gen(function*() {
        expect(yield* flow.execute({ id: "a" }, { executionId: "wide" })).toBe("secret contents")
        for (const narrower of [readSource, []]) {
          const exit = yield* Effect.exit(under(narrower)(flow.execute({ id: "a" }, { executionId: "wide" })))
          expect(conflictOf(exit)).toBeInstanceOf(FlowEngine.ExecutionIdentityConflict)
          expect(conflictOf(exit)).toMatchObject({
            code: "execution_identity_conflict",
            executionId: "wide",
            field: "capabilities"
          })
          const discarded = yield* Effect.exit(
            under(narrower)(flow.execute({ id: "a" }, { executionId: "wide", discard: true }))
          )
          expect(conflictOf(discarded)).toMatchObject({ field: "capabilities" })
        }
        expect(runs()).toBe(1)
      }).pipe(Effect.provide(layer))
    })))

  it.effect("lets the same, an equivalent, or a wider caller join a narrower run", () =>
    withCrypto(Effect.gen(function*() {
      const { flow, layer, runs } = setup()
      yield* Effect.gen(function*() {
        expect(yield* under(readSource)(flow.execute({ id: "a" }, { executionId: "narrow" }))).toBe("denied")
        expect(yield* under(readSource)(flow.execute({ id: "a" }, { executionId: "narrow" }))).toBe("denied")
        expect(yield* flow.execute({ id: "a" }, { executionId: "narrow" })).toBe("denied")
        expect(yield* under(everything)(flow.execute({ id: "a" }, { executionId: "narrow" }))).toBe("denied")
        // A declared `*` is the whole authority, so it joins an omitted admission.
        expect(yield* under(everything)(flow.execute({ id: "b" }, { executionId: "universal" })))
          .toBe("secret contents")
        expect(yield* flow.execute({ id: "b" }, { executionId: "universal" })).toBe("secret contents")
        expect(runs()).toBe(2)
      }).pipe(Effect.provide(layer))
    })))

  it.effect("compares both sides narrowed by the flow's own declaration", () =>
    withCrypto(Effect.gen(function*() {
      // The declaration already excludes the secret, so a caller who also
      // lacks it could have produced exactly this result and may join.
      const { flow, layer, runs } = setup(["fs:read:src/**"])
      yield* Effect.gen(function*() {
        expect(yield* flow.execute({ id: "a" }, { executionId: "declared" })).toBe("denied")
        expect(yield* under(readSource)(flow.execute({ id: "a" }, { executionId: "declared" }))).toBe("denied")
        const exit = yield* Effect.exit(under(readSecret)(flow.execute({ id: "a" }, { executionId: "declared" })))
        expect(conflictOf(exit)).toMatchObject({ field: "capabilities" })
        expect(runs()).toBe(1)
      }).pipe(Effect.provide(layer))
    })))

  it("joinable treats a flow this process does not declare as undeclared", () => {
    const narrow = CapabilitySet.fromPatterns(readSource).groups
    expect(FlowEngine.joinable(undefined, narrow, [])).toBe(true)
    expect(FlowEngine.joinable(undefined, [], narrow)).toBe(false)
    expect(FlowEngine.joinable(undefined, [[]], narrow)).toBe(true)
  })
})
