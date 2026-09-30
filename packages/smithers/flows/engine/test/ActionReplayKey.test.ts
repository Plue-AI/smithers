/**
 * A durable driver resolves a fork's copied attempt identity through
 * `actionReplayKey`. The engine hands the hook its canonical derivation and
 * dispatches under whatever key the hook answers, so a fork can reach the
 * attempt rows its ancestor recorded, and fresh fork work can refuse the
 * cross-run cache by asking for a run-scoped key.
 */
import { describe, expect } from "@effect/vitest"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { effect } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const flow = Flow.make("ActionReplayKey/flow", {
  payload: {},
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

const charge = Action.make({
  name: "ActionReplayKey/charge",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

const lookup = Action.make({
  name: "ActionReplayKey/lookup",
  success: Schema.Void,
  idempotencyKey: "lookup-1",
  execute: Effect.void
})

const environment: Action.CacheEnvironment = { layers: ["same-host"], capabilities: {} }

/** Dispatches `action` once in `executionId` and answers the key the driver received. */
const dispatchedKey = (
  action: Action.Action,
  executionId: string,
  actionReplayKey?: FlowEngine.Encoded["actionReplayKey"]
) => {
  const keys: Array<string> = []
  const engine = scriptedEngine({
    actionExecute: (input) =>
      Effect.sync(() => {
        keys.push(input.key)
        return new Flow.Complete({ exit: Exit.void })
      }),
    ...(actionReplayKey === undefined ? {} : { actionReplayKey })
  })
  return Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    yield* runtime.actionExecute(action, 1)
    expect(keys).toHaveLength(1)
    return keys[0]!
  }).pipe(
    Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, executionId)),
    Effect.provideService(Action.CurrentCacheEnvironment, environment),
    Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
  )
}

describe("actionReplayKey", () => {
  effect("dispatches a fork's action under the ancestor key the driver resolves", () =>
    Effect.gen(function*() {
      const ancestor = yield* dispatchedKey(charge, "ancestor-run")
      const own = yield* dispatchedKey(charge, "fork-run")
      let asks = 0
      const forked = yield* dispatchedKey(charge, "fork-run", (derive) => {
        asks++
        return derive("ancestor-run", false)
      })

      expect(own).not.toBe(ancestor)
      expect(forked).toBe(ancestor)
      expect(asks).toBe(1)
    }))

  effect("keys fresh fork work to its own run instead of the cross-run cache", () =>
    Effect.gen(function*() {
      const cached = yield* dispatchedKey(lookup, "fork-run")
      const cachedElsewhere = yield* dispatchedKey(lookup, "other-run")
      const fresh = yield* dispatchedKey(lookup, "fork-run", (derive) => derive("fork-run", true))
      const freshElsewhere = yield* dispatchedKey(lookup, "other-run", (derive) => derive("other-run", true))

      // Under a complete cache environment the ordinary key is shared by every
      // run, which is exactly what a fork's fresh work must not answer from.
      expect(cachedElsewhere).toBe(cached)
      expect(fresh).not.toBe(cached)
      expect(freshElsewhere).not.toBe(fresh)
    }))
})
