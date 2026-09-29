import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const host = Flow.make("CapabilityCacheKeys/host", {
  payload: {},
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})
const environment: Action.CacheEnvironment = { layers: ["host"], capabilities: {} }

const action = (idempotencyKey: Action.IdempotencyKey) =>
  Action.make({
    name: "CapabilityCacheKeys/action",
    success: Schema.Void,
    idempotencyKey,
    metadata: { readSet: [{ path: "src/input.ts", digest: "digest" }], writeSet: [], boundaryMode: "hard" },
    execute: Effect.void
  })

const keyUnder = (
  declaration: Action.Action,
  groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>,
  cached: boolean
) => {
  let captured: string | undefined
  const engine = scriptedEngine({
    actionExecute: (input) =>
      Effect.sync(() => {
        captured = input.key
        return new Flow.Complete({ exit: Exit.void })
      })
  })
  return CapabilitySet.attenuateGroups(groups)(
    Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      yield* runtime.actionExecute(declaration, 1)
      return captured!
    }).pipe(
      (self) => cached ? Effect.provideService(self, Action.CurrentCacheEnvironment, environment) : self,
      Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(host, "same-run")),
      Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
    )
  )
}

const read = new CapabilityPattern({ action: "fs:read", resource: "src/**" })
const write = new CapabilityPattern({ action: "fs:write", resource: "src/**" })
const narrow = new CapabilityPattern({ action: "fs:read", resource: "src/input.ts" })

describe("capability-scoped action keys", () => {
  for (const idempotencyKey of ["row", { row: "one" }] as const) {
    it.effect(`partitions ${typeof idempotencyKey} cache keys by effective authority`, () =>
      withCrypto(Effect.gen(function*() {
        const declaration = action(idempotencyKey)
        const broad = yield* keyUnder(declaration, [[read, write]], true)
        const sameReordered = yield* keyUnder(declaration, [[write, read]], true)
        const narrower = yield* keyUnder(declaration, [[read, write], [narrow]], true)
        const denied = yield* keyUnder(declaration, [[]], true)
        expect(broad).toBe(sameReordered)
        expect(narrower).not.toBe(broad)
        expect(denied).not.toBe(narrower)
      })))
  }

  it.effect("distinguishes an explicit empty action ceiling from omission in cache keys", () =>
    withCrypto(Effect.gen(function*() {
      const omitted = action("row")
      const empty = omitted.annotate(Flow.Capabilities, [])
      const inherited = yield* keyUnder(omitted, [], true)
      const denied = yield* keyUnder(empty, [], true)
      expect(denied).not.toBe(inherited)
    })))

  it.effect("keeps run-scoped replay keys stable as ambient authority changes", () =>
    withCrypto(Effect.gen(function*() {
      const declaration = action("row")
      const broad = yield* keyUnder(declaration, [[read, write]], false)
      const narrower = yield* keyUnder(declaration, [[read, write], [narrow]], false)
      expect(broad).toBe(narrower)
    })))
})
