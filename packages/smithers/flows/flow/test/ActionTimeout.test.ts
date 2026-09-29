/**
 * `attemptTimeoutMs` and `heartbeatTimeoutMs` bound one action attempt: an
 * expired bound interrupts the body and dies with `AttemptTimedOut`
 * (issue #1804). The engine's retry decision is pinned in
 * `@smthrs/engine`'s `ActionTimeout.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Cause, Clock, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { effectOnTestClock } from "./Harness.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

const defectOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined

/**
 * An inline action's raw body. Its type names the runtime services a dispatch
 * could use, and these bodies use none, so they run directly.
 */
const body = <A, E>(effect: Effect.Effect<A, E, any>) => effect as Effect.Effect<A, E>

const timed = (options: {
  readonly attemptTimeoutMs?: number
  readonly heartbeatTimeoutMs?: number
  readonly execute: Effect.Effect<number>
}) => Action.make({ name: "Timeout/inline", success: Schema.Number, ...options })

describe("attemptTimeoutMs", () => {
  it.effect("interrupts a body still running at the bound", () =>
    Effect.gen(function*() {
      let interrupted = false
      const action = timed({
        attemptTimeoutMs: 100,
        execute: Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))))
      })
      const fiber = yield* body(action.execute).pipe(
        Effect.provideService(Action.CurrentAttempt, 3),
        Effect.exit,
        Effect.forkChild
      )
      yield* TestClock.adjust(99)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      const defect = defectOf(yield* Fiber.join(fiber))
      expect(interrupted).toBe(true)
      expect(defect).toBeInstanceOf(Action.AttemptTimedOut)
      expect(defect).toMatchObject({
        code: "attempt_timed_out",
        actionName: "Timeout/inline",
        attempt: 3,
        bound: "attempt",
        timeoutMs: 100,
        message: "Action \"Timeout/inline\" attempt 3 ran past 100ms"
      })
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("keeps a defect the body raises while being interrupted", () =>
    Effect.gen(function*() {
      const action = timed({
        attemptTimeoutMs: 10,
        execute: Effect.never.pipe(Effect.onInterrupt(() => Effect.die("cleanup failed")))
      })
      const fiber = yield* body(action.execute).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(10)
      const exit = yield* Fiber.join(fiber)
      const defects = Exit.isFailure(exit)
        ? exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)
        : []
      expect(defects).toHaveLength(2)
      expect(defects[0]).toBeInstanceOf(Action.AttemptTimedOut)
      expect(defects[1]).toBe("cleanup failed")
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("waits out an uninterruptible body before reporting the timeout", () =>
    Effect.gen(function*() {
      let finished = false
      const action = timed({
        attemptTimeoutMs: 10,
        execute: Effect.uninterruptible(
          Effect.as(Effect.andThen(Effect.sleep(20), Effect.sync(() => void (finished = true))), 9)
        )
      })
      const fiber = yield* body(action.execute).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(10)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(10)
      expect(defectOf(yield* Fiber.join(fiber))).toBeInstanceOf(Action.AttemptTimedOut)
      expect(finished).toBe(true)
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("passes a body's own failure through untouched", () =>
    Effect.gen(function*() {
      const action = Action.make({
        name: "Timeout/fails",
        success: Schema.Number,
        error: Schema.String,
        attemptTimeoutMs: 10,
        execute: Effect.fail("nope")
      })
      expect(yield* body(action.execute).pipe(Effect.flip)).toBe("nope")
    }))

  it.effect("returns a body that settles within the bound unchanged", () =>
    Effect.gen(function*() {
      const action = timed({ attemptTimeoutMs: 100, execute: Effect.as(Effect.sleep(100), 7) })
      const fiber = yield* body(action.execute).pipe(Effect.forkChild)
      yield* TestClock.adjust(100)
      expect(yield* Fiber.join(fiber)).toBe(7)
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("also bounds the encoded execution the engine runs", () =>
    Effect.gen(function*() {
      const action = timed({ attemptTimeoutMs: 5, execute: Effect.never })
      const fiber = yield* body(action.executeEncoded).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(5)
      expect(defectOf(yield* Fiber.join(fiber))).toBeInstanceOf(Action.AttemptTimedOut)
    }).pipe(Effect.provide(TestClock.layer())))
})

describe("heartbeatTimeoutMs", () => {
  it.effect("fails an attempt one gap after its last heartbeat", () =>
    Effect.gen(function*() {
      const action = timed({
        heartbeatTimeoutMs: 100,
        execute: Effect.gen(function*() {
          yield* Effect.sleep(60)
          yield* Action.heartbeat
          yield* Effect.sleep(60)
          yield* Action.heartbeat
          return yield* Effect.never
        })
      })
      const fiber = yield* body(action.execute).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(219)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      expect(defectOf(yield* Fiber.join(fiber))).toMatchObject({
        bound: "heartbeat",
        attempt: 1,
        timeoutMs: 100,
        message: "Action \"Timeout/inline\" attempt 1 sent no heartbeat for 100ms"
      })
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("lets a steadily beating attempt run past one gap", () =>
    Effect.gen(function*() {
      const action = timed({
        heartbeatTimeoutMs: 100,
        execute: Effect.gen(function*() {
          for (let beat = 0; beat < 4; beat++) {
            yield* Effect.sleep(99)
            yield* Action.heartbeat
          }
          return yield* Clock.currentTimeMillis
        })
      })
      const fiber = yield* body(action.execute).pipe(Effect.forkChild)
      yield* TestClock.adjust(396)
      expect(yield* Fiber.join(fiber)).toBe(396)
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("the earlier bound wins when both are declared", () =>
    Effect.gen(function*() {
      const beating = Effect.forever(Effect.andThen(Effect.sleep(10), Action.heartbeat))
      const action = timed({ attemptTimeoutMs: 50, heartbeatTimeoutMs: 20, execute: beating })
      const fiber = yield* body(action.execute).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(50)
      expect(defectOf(yield* Fiber.join(fiber))).toMatchObject({ bound: "attempt", timeoutMs: 50 })
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("a nested action's heartbeats do not feed the caller's watchdog", () =>
    Effect.gen(function*() {
      const inner = timed({
        execute: Effect.as(Effect.forever(Effect.andThen(Effect.sleep(10), Action.heartbeat)), 0)
      })
      const outer = timed({ heartbeatTimeoutMs: 100, execute: body(inner.execute) })
      const fiber = yield* body(outer.execute).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(100)
      expect(defectOf(yield* Fiber.join(fiber))).toMatchObject({ bound: "heartbeat" })
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("is a no-op outside a heartbeat-bounded attempt", () => Action.heartbeat)
})

describe("declaration", () => {
  it("rejects a bound that is not a positive safe integer", () => {
    for (const bad of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => Action.make({ name: "Timeout/bad", attemptTimeoutMs: bad, execute: Effect.void })).toThrow(
        new RangeError(`Action.make: "Timeout/bad" attemptTimeoutMs must be a positive safe integer`)
      )
      expect(() => Action.make("Timeout/bad-declared", { payload: {}, heartbeatTimeoutMs: bad })).toThrow(RangeError)
    }
  })

  it("carries both bounds through annotated copies", () => {
    const declared = Action.make("Timeout/declared", { payload: {}, attemptTimeoutMs: 250, heartbeatTimeoutMs: 50 })
    expect([declared.attemptTimeoutMs, declared.heartbeatTimeoutMs]).toEqual([250, 50])
    const annotated = declared.annotate(Flow.Capabilities, [])
    expect([annotated.attemptTimeoutMs, annotated.heartbeatTimeoutMs]).toEqual([250, 50])
    const inline = Action.make({ name: "Timeout/plain", execute: Effect.void })
    expect([inline.attemptTimeoutMs, inline.heartbeatTimeoutMs]).toEqual([undefined, undefined])
    expect(timed({ heartbeatTimeoutMs: 10, execute: Effect.succeed(1) }).annotate(Flow.Capabilities, []))
      .toMatchObject({ heartbeatTimeoutMs: 10 })
  })

  const Hangs = Action.make("Timeout/Hangs", { payload: {}, success: Schema.Number, attemptTimeoutMs: 100 })
  const Host = Flow.make("Timeout/Host", {
    payload: {},
    success: Schema.Number,
    body: (payload) => Hangs.call(payload)
  })

  effectOnTestClock("a declared action's implementation runs under its bound", () =>
    Effect.gen(function*() {
      const fiber = yield* Host.execute({}, { executionId: "timeout-host" }).pipe(
        Effect.provide(layerWired(Layer.mergeAll(Hangs.toLayer(() => Effect.never), Interpreter.layer(Host)))),
        Effect.exit,
        Effect.forkChild
      )
      yield* TestClock.adjust(100)
      expect(defectOf(yield* Fiber.join(fiber))).toMatchObject({ actionName: "Timeout/Hangs", bound: "attempt" })
    }))
})
