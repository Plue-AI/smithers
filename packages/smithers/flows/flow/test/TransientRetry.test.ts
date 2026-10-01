import { describe, expect, it } from "@effect/vitest"
import { Fault, RetryPolicy } from "@smthrs/flow"
import { Clock, Effect, Exit, Fiber, Option, Schema } from "effect"
import { TestClock } from "effect/testing"

class Outage extends Schema.TaggedError<Outage>()("test/TransientOutage", { attempt: Schema.Number }) {}
Fault.register("test/TransientOutage", "infra")

const finalError = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail") :
    undefined

describe("bounded transient retries", () => {
  it("publishes the frozen two-hour exponential envelope", () => {
    expect(Object.isFrozen(RetryPolicy.transient)).toBe(true)
    expect(RetryPolicy.transient).toMatchObject({ initialMs: 5000, factor: 2, maxMs: 300000, expirationMs: 7200000 })
    for (const [attempt, delay] of [[1, 5000], [2, 10000], [3, 20000], [7, 300000], [100, 300000]]) {
      expect(RetryPolicy.nextDelay(RetryPolicy.transient, attempt!)).toEqual(Option.some(delay))
    }
  })

  it.effect("retries infrastructure failures at 5, 10 and 20 seconds before succeeding", () =>
    Effect.gen(function*() {
      const times: number[] = []
      const operation = Effect.gen(function*() {
        times.push(yield* Clock.currentTimeMillis)
        return times.length === 4 ? "recovered" : yield* Effect.fail(new Outage({ attempt: times.length }))
      })
      const fiber = yield* Fault.retryTransient(operation).pipe(Effect.forkChild)
      yield* TestClock.adjust(34999)
      expect(times).toEqual([0, 5000, 15000])
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(fiber)).toBe("recovered")
      expect(times).toEqual([0, 5000, 15000, 35000])
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("stops immediately when recovery yields a non-infrastructure failure", () =>
    Effect.gen(function*() {
      let attempts = 0
      const operation = Effect.suspend<never, string | Outage, never>(() =>
        ++attempts === 1
          ? Effect.fail(new Outage({ attempt: attempts })) :
          Effect.fail("invalid work")
      )
      const fiber = yield* Fault.retryTransient(operation).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(5000)
      const exit = yield* Fiber.join(fiber)
      expect(attempts).toBe(2)
      expect(finalError(exit)).toEqual(expect.objectContaining({ _tag: "Fail", error: "invalid work" }))
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("preserves the final infrastructure error when the two-hour budget expires", () =>
    Effect.gen(function*() {
      const times: number[] = []
      let last: Outage | undefined
      const fiber = yield* Fault.retryTransient(Effect.gen(function*() {
        times.push(yield* Clock.currentTimeMillis)
        last = new Outage({ attempt: times.length })
        return yield* Effect.fail(last)
      })).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(7200000)
      const reason = finalError(yield* Fiber.join(fiber))
      expect(times.length).toBeGreaterThan(20)
      expect(times.every((at) => at <= 7200000)).toBe(true)
      expect(times.at(-1)).toBe(7200000)
      expect(reason?._tag === "Fail" && reason.error).toBe(last)
      expect(Fault.of(reason?._tag === "Fail" ? reason.error : undefined).class).toBe("infra")
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("never retries an initial unregistered failure or a defect", () =>
    Effect.gen(function*() {
      const failure = { _tag: "test/Unregistered", message: "invalid work" }
      let attempts = 0
      const exit = yield* Fault.retryTransient(Effect.suspend(() => {
        attempts++
        return Effect.fail(failure)
      })).pipe(Effect.exit)
      expect(attempts).toBe(1)
      const reason = finalError(exit)
      expect(reason?._tag === "Fail" && reason.error).toBe(failure)
      const defect = new Error("broken invariant")
      const defectExit = yield* Fault.retryTransient(Effect.suspend(() => {
        attempts++
        return Effect.die(defect)
      })).pipe(Effect.exit)
      expect(attempts).toBe(2)
      expect(Exit.isFailure(defectExit) && defectExit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
      expect(yield* Clock.currentTimeMillis).toBe(0)
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("cancellation prevents every later retry", () =>
    Effect.gen(function*() {
      let attempts = 0
      const fiber = yield* Fault.retryTransient(Effect.suspend(() => {
        attempts++
        return Effect.fail(new Outage({ attempt: attempts }))
      })).pipe(Effect.forkChild)
      yield* TestClock.adjust(4999)
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust(7200000)
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(TestClock.layer())))
})
