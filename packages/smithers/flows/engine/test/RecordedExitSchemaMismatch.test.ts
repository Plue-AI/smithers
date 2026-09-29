/**
 * A recorded action outcome that does not match the action's declared schemas
 * is a defect either way, but `orDie` alone reports only the schema mismatch
 * and never the error that actually occurred. The log line below is the one
 * place the recorded exit is named, so it is pinned here.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Logger, References, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const flow = Flow.make("RecordedExitSchemaMismatch/flow", {
  payload: { id: Schema.String },
  success: Schema.Number,
  error: Schema.String,
  body: () => Node.succeed(0)
})

describe("a recorded outcome that fails the action's exit schema", () => {
  effect("dies, and logs the action and the exit that could not be decoded", () => {
    const logs: Array<
      { readonly message: unknown; readonly logLevel: string; readonly annotations: Readonly<Record<string, unknown>> }
    > = []
    const capture = Logger.make((options) => {
      logs.push({
        message: options.message,
        logLevel: options.logLevel,
        annotations: options.fiber.getRef(References.CurrentLogAnnotations)
      })
    })
    const action = Action.make({
      name: "RecordedExitSchemaMismatch/undeclared-error",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.die("scripted driver dispatches instead")
    })
    const engine = scriptedEngine({
      // The driver hands back an outcome the action never declared: the error
      // channel is a string, and this one is a number.
      actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.fail(42 as never) })),
      actionRetryOrigin: () => Effect.succeedNone
    })
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(engine.actionExecute(action, 1))
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const reported = logs.filter((entry) =>
        entry.logLevel === "Error" &&
        String(entry.message).includes("does not match the action's declared schemas")
      )
      expect(reported.length).toBe(1)
      expect(reported[0]?.annotations["action"]).toBe("RecordedExitSchemaMismatch/undeclared-error")
      expect(String(reported[0]?.annotations["exit"])).toContain("42")
    }).pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        FlowEngine.makeInstance(flow, "recorded-exit-schema-mismatch-run")
      ),
      Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
      Effect.provide(Logger.layer([capture]))
    )
  })

  effect("bounds a circular recorded action failure while preserving the schema-mismatch defect", () => {
    const logs: Array<
      { readonly message: unknown; readonly logLevel: string; readonly annotations: Readonly<Record<string, unknown>> }
    > = []
    const capture = Logger.make((options) => {
      logs.push({
        message: options.message,
        logLevel: options.logLevel,
        annotations: options.fiber.getRef(References.CurrentLogAnnotations)
      })
    })
    const action = Action.make({
      name: "RecordedExitSchemaMismatch/circular-error",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.die("scripted driver dispatches instead")
    })
    const circular: { self?: unknown } = {}
    circular.self = circular
    const engine = scriptedEngine({
      actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.fail(circular as never) }))
    })
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(engine.actionExecute(action, 1))
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const reported = logs.filter((entry) =>
        entry.logLevel === "Error" &&
        String(entry.message).includes("does not match the action's declared schemas")
      )
      expect(reported.length).toBe(1)
      expect(reported[0]?.annotations["action"]).toBe("RecordedExitSchemaMismatch/circular-error")
      expect(String(reported[0]?.annotations["exit"])).toContain("[object]")
      expect(String(reported[0]?.annotations["exit"])).not.toContain("self")
    }).pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        FlowEngine.makeInstance(flow, "recorded-exit-circular-run")
      ),
      Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
      Effect.provide(Logger.layer([capture]))
    )
  })
})
