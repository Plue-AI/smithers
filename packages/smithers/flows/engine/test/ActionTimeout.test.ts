import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Clock, Effect, Exit, Fiber, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const flow = Flow.make("ActionTimeout/test", {
  payload: {},
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

const effect = (
  name: string,
  body: () => Effect.Effect<
    void,
    unknown,
    Crypto.Crypto | Scope.Scope | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
  >
) =>
  it.effect(name, () =>
    withCrypto(
      body().pipe(
        Effect.provide(FlowEngine.layerMemory),
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "action-timeout")),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    ))

const retryTwice = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 2 })

const isTimedOut = (defect: unknown) => defect instanceof Action.AttemptTimedOut

const timedOutDefect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined

describe("attemptTimeoutMs", () => {
  effect("interrupts a hung attempt at 100ms and retries it", () =>
    Effect.gen(function*() {
      let attempts = 0
      let interrupted = 0
      const action = Action.make({
        name: "ActionTimeout/hung",
        success: Schema.Number,
        attemptTimeoutMs: 100,
        retryPolicy: retryTwice,
        execute: Effect.suspend(() => {
          attempts++
          return attempts === 1
            ? Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupted++)))
            : Effect.succeed(42)
        })
      })
      const fiber = yield* action.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(99)
      expect(attempts).toBe(1)
      expect(interrupted).toBe(0)
      yield* TestClock.adjust(2)
      expect(yield* Fiber.join(fiber)).toBe(42)
      expect(attempts).toBe(2)
      expect(interrupted).toBe(1)
    }))

  effect("dies with AttemptTimedOut when the policy is exhausted", () =>
    Effect.gen(function*() {
      let attempts = 0
      const action = Action.make({
        name: "ActionTimeout/exhausted",
        success: Schema.Number,
        attemptTimeoutMs: 100,
        retryPolicy: retryTwice,
        execute: Effect.suspend(() => {
          attempts++
          return Effect.never
        })
      })
      const fiber = yield* action.pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(1_000)
      const exit = yield* Fiber.join(fiber)
      expect(attempts).toBe(2)
      const defect = timedOutDefect(exit)
      expect(defect).toBeInstanceOf(Action.AttemptTimedOut)
      expect(defect).toMatchObject({
        code: "attempt_timed_out",
        actionName: "ActionTimeout/exhausted",
        attempt: 2,
        bound: "attempt",
        timeoutMs: 100
      })
    }))

  effect("does not retry an attempt whose interruption cleanup died", () =>
    Effect.gen(function*() {
      let attempts = 0
      const action = Action.make({
        name: "ActionTimeout/cleanup-defect",
        success: Schema.Number,
        attemptTimeoutMs: 100,
        retryPolicy: retryTwice,
        execute: Effect.suspend(() => {
          attempts++
          return attempts === 1
            ? Effect.never.pipe(Effect.onInterrupt(() => Effect.die("cleanup failed")))
            : Effect.succeed(42)
        })
      })
      const fiber = yield* action.pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(1_000)
      const exit = yield* Fiber.join(fiber)
      expect(attempts).toBe(1)
      expect(
        Exit.isFailure(exit) && exit.cause.reasons.some((r) => Cause.isDieReason(r) && r.defect === "cleanup failed")
      )
        .toBe(true)
    }))

  effect("does not retry without a retry policy", () =>
    Effect.gen(function*() {
      let attempts = 0
      const action = Action.make({
        name: "ActionTimeout/no-policy",
        success: Schema.Number,
        attemptTimeoutMs: 100,
        execute: Effect.suspend(() => {
          attempts++
          return Effect.never
        })
      })
      const fiber = yield* action.pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(1_000)
      const exit = yield* Fiber.join(fiber)
      expect(attempts).toBe(1)
      expect(isTimedOut(timedOutDefect(exit))).toBe(true)
    }))

  effect("a policy can list AttemptTimedOut as nonRetryable", () =>
    Effect.gen(function*() {
      let attempts = 0
      const action = Action.make({
        name: "ActionTimeout/non-retryable",
        success: Schema.Number,
        attemptTimeoutMs: 100,
        retryPolicy: RetryPolicy.make({
          initialMs: 1,
          factor: 1,
          maxMs: 1,
          maxAttempts: 5,
          nonRetryable: ["@smthrs/flow/AttemptTimedOut"]
        }),
        execute: Effect.suspend(() => {
          attempts++
          return Effect.never
        })
      })
      const fiber = yield* action.pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(1_000)
      expect(isTimedOut(timedOutDefect(yield* Fiber.join(fiber)))).toBe(true)
      expect(attempts).toBe(1)
    }))

  effect("leaves an attempt that finishes in time and other defects alone", () =>
    Effect.gen(function*() {
      let attempts = 0
      const quick = Action.make({
        name: "ActionTimeout/quick",
        success: Schema.Number,
        attemptTimeoutMs: 100,
        retryPolicy: retryTwice,
        execute: Effect.as(Effect.sleep(99), 7)
      })
      const fiber = yield* quick.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(99)
      expect(yield* Fiber.join(fiber)).toBe(7)

      const dying = Action.make({
        name: "ActionTimeout/defect",
        success: Schema.Number,
        attemptTimeoutMs: 100,
        retryPolicy: retryTwice,
        execute: Effect.suspend(() => {
          attempts++
          return Effect.die("boom")
        })
      })
      const exit = yield* dying.pipe(Effect.exit)
      expect(attempts).toBe(1)
      expect(timedOutDefect(exit)).toBe("boom")
    }))
})

describe("a flow that does not capture defects", () => {
  const uncaptured = Flow.make("ActionTimeout/uncaptured", {
    payload: {},
    success: Schema.Void,
    body: () => Node.succeed(undefined)
  }).annotate(Flow.CaptureDefects, false)

  it.effect("still retries an attempt that timed out", () =>
    withCrypto(
      Effect.gen(function*() {
        let attempts = 0
        const action = Action.make({
          name: "ActionTimeout/uncaptured",
          success: Schema.Number,
          attemptTimeoutMs: 100,
          retryPolicy: retryTwice,
          execute: Effect.suspend(() => {
            attempts++
            return attempts === 1 ? Effect.never : Effect.succeed(42)
          })
        })
        const fiber = yield* action.pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust(101)
        expect(yield* Fiber.join(fiber)).toBe(42)
        expect(attempts).toBe(2)
      }).pipe(
        Effect.provide(FlowEngine.layerMemory),
        Effect.provideService(
          FlowRuntime.FlowInstance,
          FlowEngine.makeInstance(uncaptured, "action-timeout-uncaptured")
        ),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    ))

  it.effect("lets any other defect escape unretried", () =>
    withCrypto(
      Effect.gen(function*() {
        let attempts = 0
        const action = Action.make({
          name: "ActionTimeout/uncaptured-defect",
          success: Schema.Number,
          attemptTimeoutMs: 100,
          retryPolicy: retryTwice,
          execute: Effect.suspend(() => {
            attempts++
            return Effect.die("boom")
          })
        })
        const exit = yield* action.pipe(Effect.exit)
        expect(attempts).toBe(1)
        expect(timedOutDefect(exit)).toBe("boom")
      }).pipe(
        Effect.provide(FlowEngine.layerMemory),
        Effect.provideService(
          FlowRuntime.FlowInstance,
          FlowEngine.makeInstance(uncaptured, "action-timeout-uncaptured")
        ),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    ))
})

describe("heartbeatTimeoutMs", () => {
  effect("fails an attempt that misses its heartbeat and retries it", () =>
    Effect.gen(function*() {
      let attempts = 0
      const action = Action.make({
        name: "ActionTimeout/silent",
        success: Schema.Number,
        heartbeatTimeoutMs: 100,
        retryPolicy: retryTwice,
        execute: Effect.suspend(() => {
          attempts++
          return attempts === 1 ? Effect.never : Effect.succeed(42)
        })
      })
      const fiber = yield* action.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(99)
      expect(attempts).toBe(1)
      yield* TestClock.adjust(2)
      expect(yield* Fiber.join(fiber)).toBe(42)
      expect(attempts).toBe(2)
    }))

  effect("each heartbeat restarts the gap", () =>
    Effect.gen(function*() {
      const beats: Array<number> = []
      const action = Action.make({
        name: "ActionTimeout/beating",
        success: Schema.Number,
        heartbeatTimeoutMs: 100,
        execute: Effect.gen(function*() {
          for (let beat = 0; beat < 5; beat++) {
            yield* Effect.sleep(80)
            yield* Action.heartbeat
            beats.push(yield* Clock.currentTimeMillis)
          }
          return beats.length
        })
      })
      const fiber = yield* action.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(400)
      expect(yield* Fiber.join(fiber)).toBe(5)
      expect(beats).toEqual([80, 160, 240, 320, 400])
    }))

  effect("a heartbeat that stops fails the attempt one gap after the last beat", () =>
    Effect.gen(function*() {
      const action = Action.make({
        name: "ActionTimeout/stops",
        success: Schema.Number,
        heartbeatTimeoutMs: 100,
        execute: Effect.gen(function*() {
          yield* Effect.sleep(50)
          yield* Action.heartbeat
          return yield* Effect.never
        })
      })
      const fiber = yield* action.pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(149)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      const defect = timedOutDefect(yield* Fiber.join(fiber))
      expect(defect).toMatchObject({ bound: "heartbeat", timeoutMs: 100, attempt: 1 })
    }))

  it.effect("is a no-op outside a heartbeat-bounded attempt", () => Action.heartbeat)
})
