/**
 * Issue #69: pins the ternary's `Option.none()` arm when the durable retry
 * origin hook is present and the policy declares `expirationMs`. A missing
 * durable origin falls back to the current clock — the schedule-to-close
 * budget restarts (with a logged warning) instead of failing the run — so
 * the #45 fix cannot silently regress into an untested branch.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Fiber, Layer, Logger, Option, References, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const flow = Flow.make("RetryOriginFallback/flow", {
  payload: { id: Schema.String },
  success: Schema.Number,
  error: Schema.String,
  body: () => Node.succeed(0)
})

describe("retry origin fallback when the durable hook yields none", () => {
  effect("restarts the expiration budget from the current clock instead of expiring or dying", () => {
    const attempts: Array<number> = []
    const logs: Array<{ readonly message: unknown; readonly logLevel: string }> = []
    const capture = Logger.make((options) => {
      logs.push({ message: options.message, logLevel: options.logLevel })
    })
    const action = Action.make({
      name: "RetryOriginFallback/pruned",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({
        initialMs: 1,
        factor: 1,
        maxMs: 1,
        expirationMs: 1
      }),
      execute: Effect.die("scripted driver dispatches instead")
    })
    let originRequests = 0
    const engine = scriptedEngine({
      actionExecute: (input) =>
        Effect.sync(() => {
          attempts.push(input.attempt)
          return new Flow.Complete({ exit: Exit.fail("still-failing") })
        }),
      // Every attempt row was pruned: the durable driver has no origin.
      actionRetryOrigin: () => Effect.sync(() => (originRequests++, Option.none()))
    })
    return Effect.gen(function*() {
      const fiber = yield* engine.actionExecute(action, 1).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      // Attempt 1 runs at elapsed 0 and schedules the 1ms backoff; the
      // adjusted clock spends the restarted window, so attempt 2 expires.
      yield* TestClock.adjust("1 millis")
      const result = yield* Fiber.join(fiber)
      expect(originRequests).toBe(1)
      // The budget restarted from the current clock: attempt 1 got its full
      // window (a durable origin of 0 would have expired it immediately with
      // a single dispatch), and the sequence expired only once the restarted
      // 1ms window elapsed across the backoff sleep.
      expect(attempts).toEqual([1, 2])
      // The restarted budget must be observable (issue #82): the fallback's
      // only operator signal is the warning naming the action, emitted
      // exactly once for the retry sequence — not once per attempt.
      const warnings = logs.filter((entry) =>
        entry.logLevel === "Warn" &&
        String(entry.message).includes("no durable retry origin") &&
        String(entry.message).includes("RetryOriginFallback/pruned")
      )
      expect(warnings.length).toBe(1)
      expect(result._tag).toBe("Complete")
      if (result._tag === "Complete") {
        expect(Exit.isFailure(result.exit)).toBe(true)
        if (Exit.isFailure(result.exit)) {
          expect(Cause.squash(result.exit.cause)).toBe("still-failing")
        }
      }
    }).pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        FlowEngine.makeInstance(flow, "retry-origin-fallback-run")
      ),
      Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
      Effect.provide(Logger.layer([capture])),
      Effect.provide(TestClock.layer())
    )
  })

  effect("keeps the implicit transient budget's restart out of the warnings", () => {
    const logs: Array<{ readonly message: unknown; readonly logLevel: string }> = []
    const capture = Logger.make((options) => {
      logs.push({ message: options.message, logLevel: options.logLevel })
    })
    // Repeat-safe and undeclared: the engine supplies RetryPolicy.transient,
    // whose expirationMs consults the durable origin on the first dispatch.
    const action = Action.make({
      name: "RetryOriginFallback/implicit",
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: "retry-origin-implicit",
      execute: Effect.die("scripted driver dispatches instead")
    })
    let originRequests = 0
    const engine = scriptedEngine({
      actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.succeed(7) })),
      actionRetryOrigin: () => Effect.sync(() => (originRequests++, Option.none()))
    })
    return Effect.gen(function*() {
      const result = yield* engine.actionExecute(action, 1)
      expect(result._tag).toBe("Complete")
      expect(originRequests).toBe(1)
      expect(logs.filter((entry) => entry.logLevel === "Warn")).toEqual([])
      const restarted = logs.filter((entry) => String(entry.message).includes("no durable retry origin"))
      expect(restarted.map((entry) => entry.logLevel)).toEqual(["Debug"])
    }).pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        FlowEngine.makeInstance(flow, "retry-origin-implicit-run")
      ),
      Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
      Effect.provide(Logger.layer([capture])),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.provide(TestClock.layer())
    )
  })

  const runWithOrigin = (
    actionName: string,
    origin: number,
    options: { readonly advanceMs?: number | undefined } = {}
  ) => {
    const attempts: Array<number> = []
    const logs: Array<{ readonly message: unknown; readonly logLevel: string }> = []
    const capture = Logger.make((entry) => {
      logs.push({ message: entry.message, logLevel: entry.logLevel })
    })
    const action = Action.make({
      name: actionName,
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({
        initialMs: 1,
        factor: 1,
        maxMs: 1,
        maxAttempts: 2,
        expirationMs: 5
      }),
      execute: Effect.die("scripted driver dispatches instead")
    })
    const engine = scriptedEngine({
      actionExecute: (input) =>
        Effect.sync(() => {
          attempts.push(input.attempt)
          return new Flow.Complete({ exit: Exit.fail("still-failing") })
        }),
      actionRetryOrigin: () => Effect.succeedSome(origin)
    })
    return Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const fiber = yield* engine.actionExecute(action, 1).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      if (options.advanceMs !== undefined) yield* TestClock.adjust(options.advanceMs)
      const result = yield* Fiber.join(fiber)
      return { attempts, logs, result }
    }).pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        FlowEngine.makeInstance(flow, `retry-origin-${actionName}`)
      ),
      Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
      Effect.provide(Logger.layer([capture])),
      Effect.provide(TestClock.layer())
    )
  }

  effect("clamps a future durable origin to the local clock and logs the skew", () =>
    Effect.gen(function*() {
      const outcome = yield* runWithOrigin("RetryOriginFallback/future", 61_000, { advanceMs: 1 })
      expect(outcome.attempts).toEqual([1, 2])
      const warnings = outcome.logs.filter((entry) => entry.logLevel === "Warn")
      expect(warnings.length).toBe(1)
      expect(String(warnings[0]?.message)).toContain("RetryOriginFallback/future")
      expect(String(warnings[0]?.message)).toContain("61000")
      expect(String(warnings[0]?.message)).toContain("1000")
    }))

  effect(
    "replaces a non-finite durable origin with the local clock and logs the corrupt value",
    () =>
      Effect.gen(function*() {
        const outcome = yield* runWithOrigin("RetryOriginFallback/non-finite", Number.NaN, { advanceMs: 1 })
        expect(outcome.attempts).toEqual([1, 2])
        const warnings = outcome.logs.filter((entry) => entry.logLevel === "Warn")
        expect(warnings.length).toBe(1)
        expect(String(warnings[0]?.message)).toContain("RetryOriginFallback/non-finite")
        expect(String(warnings[0]?.message)).toContain("NaN")
        expect(String(warnings[0]?.message)).toContain("1000")
      })
  )

  effect(
    "keeps a valid past durable origin as consumed expiration budget without a warning",
    () =>
      Effect.gen(function*() {
        const outcome = yield* runWithOrigin("RetryOriginFallback/past", 990)
        expect(outcome.attempts).toEqual([1])
        expect(outcome.logs.filter((entry) => entry.logLevel === "Warn")).toEqual([])
        expect(outcome.result._tag).toBe("Complete")
        if (outcome.result._tag === "Complete" && Exit.isFailure(outcome.result.exit)) {
          expect(Cause.squash(outcome.result.exit.cause)).toBe("still-failing")
        }
      })
  )
})
