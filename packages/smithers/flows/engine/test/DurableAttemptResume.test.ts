import type * as Crypto from "effect/Crypto"
/**
 * Issue #59: the attempt counter resumes from the persisted sequence. A
 * durable driver exposes `actionLatestAttempt`, and the engine starts the
 * retry loop at the highest persisted attempt instead of 1, so replayed
 * failed attempts keep their numbering: the backoff ladder is not re-slept
 * and the retry decision sees the true attempt count.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect, liveEffect } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

/**
 * The same wiring on the live clock, for cases that wait on the real elapsed
 * time a retry or resume policy schedules rather than driving `TestClock`.
 */
const flow = Flow.make("AttemptResume/flow", {
  payload: { id: Schema.String },
  success: Schema.Number,
  error: Schema.String,
  body: () => Node.succeed(0)
})

const scriptedWith = (options: {
  readonly latestAttempt: Option.Option<number>
  readonly attempts: Array<number>
}) =>
  scriptedEngine({
    actionExecute: (input) =>
      Effect.sync(() => {
        options.attempts.push(input.attempt)
        return new Flow.Complete({
          exit: input.attempt >= 4 ? Exit.succeed(input.attempt) : Exit.fail("transient")
        })
      }),
    actionLatestAttempt: () => Effect.succeed(options.latestAttempt)
  })

const provideInstance = <A, E>(
  self: Effect.Effect<A, E, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Crypto.Crypto>,
  engine: FlowRuntime.FlowRuntime["Service"]
): Effect.Effect<A, E, Crypto.Crypto> =>
  self.pipe(
    Effect.provideService(
      FlowRuntime.FlowInstance,
      FlowEngine.makeInstance(flow, "attempt-resume-run")
    ),
    Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
  )

describe("durable attempt counter resume", () => {
  effect("starts the retry loop at the persisted highest attempt instead of 1", () => {
    const attempts: Array<number> = []
    const action = Action.make({
      name: "AttemptResume/replayed",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 10 }),
      execute: Effect.die("scripted driver dispatches instead")
    })
    const engine = scriptedWith({ latestAttempt: Option.some(4), attempts })
    return Effect.gen(function*() {
      const result = yield* engine.actionExecute(action, 1)
      expect(result._tag).toBe("Complete")
      // The persisted sequence resumes at attempt 4: attempts 1-3 are never
      // re-dispatched and their backoff ladder is never re-slept.
      expect(attempts).toEqual([4])
      if (result._tag === "Complete") {
        expect(result.exit).toEqual(Exit.succeed(4))
      }
    }).pipe((self) => provideInstance(self, engine))
  })

  effect("the top-of-loop guard refuses a resumed irreversible keyless attempt", () => {
    const attempts: Array<number> = []
    const action = Action.make({
      name: "AttemptResume/irreversible-keyless",
      tier: "irreversible",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1 }),
      execute: Effect.die("scripted driver dispatches instead")
    })
    const engine = scriptedWith({ latestAttempt: Option.some(2), attempts })
    return Effect.gen(function*() {
      const exit = yield* engine.actionExecute(action, 1).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
      expect(defect).toBeInstanceOf(Action.IrreversibleRetryRequiresIdempotencyKey)
      expect(defect).toMatchObject({ attempt: 2 })
      expect(attempts).toEqual([])
    }).pipe((self) => provideInstance(self, engine))
  })

  liveEffect("rejects a fractional durable attempt, falls back to the caller, and logs it", () => {
    const attempts: Array<number> = []
    const logs: Array<{ readonly message: unknown; readonly logLevel: string }> = []
    const capture = Logger.make((entry) => {
      logs.push({ message: entry.message, logLevel: entry.logLevel })
    })
    const action = Action.make({
      name: "AttemptResume/fractional",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 10 }),
      execute: Effect.die("scripted driver dispatches instead")
    })
    const engine = scriptedWith({ latestAttempt: Option.some(2.5), attempts })
    return Effect.gen(function*() {
      const result = yield* engine.actionExecute(action, 1)
      expect(result._tag).toBe("Complete")
      expect(attempts).toEqual([1, 2, 3, 4])
      const warnings = logs.filter((entry) =>
        entry.logLevel === "Warn" && String(entry.message).includes("AttemptResume/fractional")
      )
      expect(warnings.length).toBe(1)
      expect(String(warnings[0]?.message)).toContain("2.5")
    }).pipe(
      (self) => provideInstance(self, engine),
      Effect.provide(Logger.layer([capture]))
    )
  })

  liveEffect("keeps the caller's attempt when the persisted sequence is not ahead", () => {
    const attempts: Array<number> = []
    const action = Action.make({
      name: "AttemptResume/fresh",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 10 }),
      execute: Effect.die("scripted driver dispatches instead")
    })
    const engine = scriptedWith({ latestAttempt: Option.some(1), attempts })
    return Effect.gen(function*() {
      const result = yield* engine.actionExecute(action, 1)
      expect(result._tag).toBe("Complete")
      expect(attempts).toEqual([1, 2, 3, 4])
    }).pipe((self) => provideInstance(self, engine))
  })

  effect("propagates a replayed non-retryable failure at the persisted attempt without re-dispatching", () => {
    const attempts: Array<number> = []
    const action = Action.make({
      name: "AttemptResume/non-retryable",
      success: Schema.Number,
      error: Schema.Struct({ _tag: Schema.Literal("FatalBoom"), detail: Schema.String }),
      retryPolicy: RetryPolicy.make({
        initialMs: 60_000,
        factor: 2,
        maxMs: 600_000,
        maxAttempts: 10,
        nonRetryable: ["FatalBoom"]
      }),
      execute: Effect.die("scripted driver dispatches instead")
    })
    const engine = scriptedEngine({
      // The durable driver replays the persisted failed attempt: the
      // original tagged error surfaces, never an admission wrapper.
      actionExecute: (input) =>
        Effect.sync(() => {
          attempts.push(input.attempt)
          return new Flow.Complete({
            exit: Exit.failCause(Cause.fail({ _tag: "FatalBoom", detail: "persisted" }))
          })
        }),
      actionLatestAttempt: () => Effect.succeedSome(3)
    })
    return Effect.gen(function*() {
      const result = yield* engine.actionExecute(action, 1)
      // Exactly one (replayed) dispatch at the persisted attempt; the
      // non-retryable verdict matches the original error and propagates
      // without any backoff sleep.
      expect(attempts).toEqual([3])
      expect(result._tag).toBe("Complete")
      if (result._tag === "Complete") {
        expect(Exit.isFailure(result.exit)).toBe(true)
        if (Exit.isFailure(result.exit)) {
          expect(Cause.squash(result.exit.cause)).toMatchObject({ _tag: "FatalBoom" })
        }
      }
    }).pipe((self) => provideInstance(self, engine))
  })
})

class Unprovided extends Context.Service<Unprovided, { readonly value: string }>()(
  "test/flows-engine/DurableAttemptResume/Unprovided"
) {}

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = () => {
  // @ts-expect-error provideInstance provides only the flow instance and runtime, not Unprovided
  provideInstance(
    Effect.map(Unprovided, (service) => service.value),
    scriptedWith({ latestAttempt: Option.none(), attempts: [] })
  )
  provideInstance(
    Effect.map(FlowRuntime.FlowInstance, (instance) => instance),
    scriptedWith({ latestAttempt: Option.none(), attempts: [] })
  )
}

describe("regression: provide-then-cast test helpers erase layer requirements (#2704)", () => {
  it("rejects a body that needs a service its layer does not provide", () => {
    // The assertion is the `@ts-expect-error` directive above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})
