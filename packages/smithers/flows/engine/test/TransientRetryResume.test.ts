import { describe, expect, it } from "@effect/vitest"
import { Action, Fault, Flow, FlowRuntime } from "@smthrs/flow"
import { Unreachable } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { Clock, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const flow = Flow.make("TransientResume/flow", { payload: {}, success: Schema.Number, body: () => Node.succeed(0) })
const action = (name: string) =>
  Action.make({
    name,
    idempotencyKey: name,
    success: Schema.Number,
    error: Unreachable.Unreachable,
    execute: Effect.die("durable fixture dispatches the action")
  })

describe("default retry durable resume", () => {
  it.effect("derives backoff from the persisted latest attempt", () => {
    const attempts: Array<{ attempt: number; at: number }> = []
    const engine = scriptedEngine({
      actionLatestAttempt: () => Effect.succeedSome(4),
      actionRetryOrigin: () => Effect.succeedSome(0),
      actionExecute: (input) =>
        Effect.gen(function*() {
          attempts.push({ attempt: input.attempt, at: yield* Clock.currentTimeMillis })
          return new Flow.Complete({
            exit: input.attempt === 5 ?
              Exit.succeed(5)
              : Exit.fail(new Unreachable.Unreachable({ message: "EAI_AGAIN" }))
          })
        })
    })
    return withCrypto(
      Effect.gen(function*() {
        const fiber = yield* engine.actionExecute(action("TransientResume/attempt"), 1).pipe(Effect.forkChild)
        yield* TestClock.adjust(39999)
        expect(attempts).toEqual([{ attempt: 4, at: 0 }])
        yield* TestClock.adjust(1)
        const result = yield* Fiber.join(fiber)
        expect(result._tag).toBe("Complete")
        expect(result._tag === "Complete" && result.exit).toEqual(Exit.succeed(5))
        expect(attempts).toEqual([{ attempt: 4, at: 0 }, { attempt: 5, at: 40000 }])
      }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "transient-resume-attempt")),
        Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    )
  })

  it.effect("keeps the two-hour expiration origin across a late resume with exactly one initial interval remaining", () => {
    const attempts: Array<{ attempt: number; at: number }> = []
    const engine = scriptedEngine({
      actionLatestAttempt: () => Effect.succeedSome(7),
      actionRetryOrigin: () => Effect.succeedSome(0),
      actionExecute: (input) =>
        Effect.gen(function*() {
          attempts.push({ attempt: input.attempt, at: yield* Clock.currentTimeMillis })
          return new Flow.Complete({
            exit: Exit.fail(new Unreachable.Unreachable({ message: `EAI_AGAIN ${input.attempt}` }))
          })
        })
    })
    return withCrypto(
      Effect.gen(function*() {
        yield* TestClock.adjust(7195000)
        const fiber = yield* engine.actionExecute(action("TransientResume/origin"), 1).pipe(Effect.forkChild)
        yield* TestClock.adjust(4999)
        expect(attempts).toEqual([{ attempt: 7, at: 7195000 }])
        yield* TestClock.adjust(1)
        const result = yield* Fiber.join(fiber)
        expect(attempts).toEqual([{ attempt: 7, at: 7195000 }, { attempt: 8, at: 7200000 }])
        expect(result._tag).toBe("Complete")
        if (result._tag === "Complete" && Exit.isFailure(result.exit)) {
          const reason = result.exit.cause.reasons.find((reason) => reason._tag === "Fail")
          expect(Fault.of(reason?._tag === "Fail" ? reason.error : undefined).class).toBe("infra")
          expect(reason?._tag === "Fail" && reason.error).toMatchObject({ message: "EAI_AGAIN 8" })
        } else {
          expect.fail("expected the final original infrastructure failure")
        }
      }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "transient-resume-origin")),
        Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    )
  })
  it.effect("refuses a resumed retry when less than the initial interval remains", () => {
    const attempts: number[] = []
    const engine = scriptedEngine({
      actionLatestAttempt: () => Effect.succeedSome(7),
      actionRetryOrigin: () => Effect.succeedSome(0),
      actionExecute: (input) =>
        Effect.sync(() => {
          attempts.push(input.attempt)
          return new Flow.Complete({ exit: Exit.fail(new Unreachable.Unreachable({ message: "EAI_AGAIN final" })) })
        })
    })
    return withCrypto(
      Effect.gen(function*() {
        yield* TestClock.adjust(7199990)
        const result = yield* engine.actionExecute(action("TransientResume/no-interval"), 1)
        expect(attempts).toEqual([7])
        expect(yield* Clock.currentTimeMillis).toBe(7199990)
        if (result._tag === "Complete" && Exit.isFailure(result.exit)) {
          const reason = result.exit.cause.reasons.find((reason) => reason._tag === "Fail")
          expect(Fault.of(reason?._tag === "Fail" ? reason.error : undefined).class).toBe("infra")
        } else {
          expect.fail("expected the final infrastructure failure")
        }
      }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "transient-resume-no-interval")),
        Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    )
  })
})
