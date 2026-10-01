import { describe, expect, it } from "@effect/vitest"
import { Action, Fault, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Unreachable } from "@smthrs/kernel"
import { Clock, Effect, Exit, Fiber, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const InvalidInput = Schema.Struct({
  _tag: Schema.Literal("application/InvalidInput"),
  attempt: Schema.optional(Schema.Number)
})
const ErrorSchema = Schema.Union([Unreachable.Unreachable, InvalidInput])

const readOnly = { reads: [], writes: [], mode: "expected", onConflict: "serialize" } as const
const writer = { reads: [], writes: ["/workspace/result"], mode: "expected", onConflict: "serialize" } as const
const failReason = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail") :
    undefined

const run = (
  name: string,
  options: {
    readonly tier?: "sealed" | "compensable" | "irreversible"
    readonly idempotencyKey?: string
    readonly effects?: typeof readOnly | typeof writer
    readonly retryPolicy?: RetryPolicy.RetryPolicy
  },
  implementation: Effect.Effect<number, typeof ErrorSchema.Type>,
  check: (
    execution: Effect.Effect<
      number,
      unknown,
      FlowRuntime.FlowRuntime | Crypto.Crypto | Action.Requirement<`Transient/${string}/action`>
    >,
    cancel: Effect.Effect<void, unknown, FlowRuntime.FlowRuntime>
  ) => Effect.Effect<
    void,
    unknown,
    FlowRuntime.FlowRuntime | Crypto.Crypto | Action.Requirement<`Transient/${string}/action`>
  >
) => {
  const action = Action.make(`Transient/${name}/action`, {
    payload: {},
    success: Schema.Number,
    error: ErrorSchema,
    ...options
  })
  const flow = Flow.make(`Transient/${name}`, {
    payload: {},
    success: Schema.Number,
    error: ErrorSchema,
    body: (payload) => action.call(payload)
  })
  const layer = Layer.mergeAll(action.toLayer(() => implementation), Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )
  return withCrypto(
    check(flow.execute({}, { executionId: `transient-${name}` }), flow.interrupt(`transient-${name}`)).pipe(
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
      Effect.scoped
    )
  )
}

describe("default infrastructure retry at Dispatch", () => {
  for (
    const [name, options] of [
      ["keyed", { idempotencyKey: "remote-job-status" }],
      ["read-only", { effects: readOnly }],
      ["keyed-writer", { idempotencyKey: "remote-job-start", effects: writer }]
    ] as const
  ) {
    it.effect(`retries a ${name} infrastructure failure at the exact backoff boundaries`, () => {
      const times: number[] = []
      return run(
        name,
        options,
        Effect.gen(function*() {
          times.push(yield* Clock.currentTimeMillis)
          return times.length === 4 ? 42 : yield* Effect.fail(new Unreachable.Unreachable({ message: "EAI_AGAIN" }))
        }),
        (execution) =>
          Effect.gen(function*() {
            const fiber = yield* execution.pipe(Effect.forkChild)
            yield* TestClock.adjust(4999)
            expect(times).toEqual([0])
            yield* TestClock.adjust(1)
            expect(times).toEqual([0, 5000])
            yield* TestClock.adjust(9999)
            expect(times).toEqual([0, 5000])
            yield* TestClock.adjust(1)
            expect(times).toEqual([0, 5000, 15000])
            yield* TestClock.adjust(20000)
            expect(yield* Fiber.join(fiber)).toBe(42)
            expect(times).toEqual([0, 5000, 15000, 35000])
          })
      )
    })
  }

  for (const [name, options] of [["undeclared", {}], ["unkeyed-writer", { effects: writer }]] as const) {
    it.effect(`does not repeat an ${name} effect during an outage`, () => {
      let attempts = 0
      const failure = new Unreachable.Unreachable({ message: "ENOTFOUND" })
      return run(
        name,
        options,
        Effect.suspend(() => {
          attempts++
          return Effect.fail(failure)
        }),
        (execution) =>
          Effect.gen(function*() {
            const reason = failReason(yield* execution.pipe(Effect.exit))
            expect(attempts).toBe(1)
            expect(Fault.of(reason?._tag === "Fail" ? reason.error : undefined).class).toBe("infra")
            expect(yield* Clock.currentTimeMillis).toBe(0)
          })
      )
    })
  }

  it.effect("does not retry a repeat-safe action whose failure is a bug", () => {
    let attempts = 0
    return run(
      "bug",
      { effects: readOnly },
      Effect.suspend(() => {
        attempts++
        return Effect.fail({ _tag: "application/InvalidInput" as const })
      }),
      (execution) =>
        Effect.gen(function*() {
          expect(Exit.isFailure(yield* execution.pipe(Effect.exit))).toBe(true)
          expect(attempts).toBe(1)
          expect(yield* Clock.currentTimeMillis).toBe(0)
        })
    )
  })

  it.effect("preserves explicit policy behavior for an unkeyed writer and bug errors", () => {
    const times: number[] = []
    return run(
      "explicit",
      { effects: writer, retryPolicy: RetryPolicy.make({ initialMs: 17, factor: 1, maxMs: 17, maxAttempts: 2 }) },
      Effect.gen(function*() {
        times.push(yield* Clock.currentTimeMillis)
        return yield* Effect.fail({ _tag: "application/InvalidInput" as const, attempt: times.length })
      }),
      (execution) =>
        Effect.gen(function*() {
          const fiber = yield* execution.pipe(Effect.exit, Effect.forkChild)
          yield* TestClock.adjust(17)
          const reason = failReason(yield* Fiber.join(fiber))
          expect(times).toEqual([0, 17])
          expect(reason?._tag === "Fail" && reason.error).toEqual({ _tag: "application/InvalidInput", attempt: 2 })
          expect(Fault.of(reason?._tag === "Fail" ? reason.error : undefined).class).toBe("bug")
        })
    )
  })

  it.effect("caps default backoff at five minutes and preserves infrastructure classification at exhaustion", () => {
    const times: number[] = []
    return run(
      "expiration",
      { effects: readOnly },
      Effect.gen(function*() {
        times.push(yield* Clock.currentTimeMillis)
        return yield* Effect.fail(new Unreachable.Unreachable({ message: `EAI_AGAIN attempt ${times.length}` }))
      }),
      (execution) =>
        Effect.gen(function*() {
          const fiber = yield* execution.pipe(Effect.exit, Effect.forkChild)
          yield* TestClock.adjust(7200000)
          const reason = failReason(yield* Fiber.join(fiber))
          expect(times.slice(0, 8)).toEqual([0, 5000, 15000, 35000, 75000, 155000, 315000, 615000])
          expect(times.every((at) => at <= 7200000)).toBe(true)
          expect(times.at(-1)).toBe(7200000)
          expect(times.slice(7, -1).every((at, index) => at - times[index + 6]! === 300000)).toBe(true)
          const failure = reason?._tag === "Fail" ? reason.error : undefined
          expect(failure).toBeInstanceOf(Unreachable.Unreachable)
          expect((failure as Unreachable.Unreachable).message).toBe(`EAI_AGAIN attempt ${times.length}`)
          expect(Fault.of(failure).class).toBe("infra")
        })
    )
  })

  it.effect("a ten-minute resolver blackhole recovers without a terminal action failure", () => {
    const times: number[] = []
    let terminalFailures = 0
    return run(
      "dns-blackhole",
      { effects: readOnly },
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        times.push(now)
        return now >= 600000
          ? 1
          : yield* Effect.fail(new Unreachable.Unreachable({ message: "getaddrinfo EAI_AGAIN github.com" }))
      }),
      (execution) =>
        Effect.gen(function*() {
          const fiber = yield* execution.pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                terminalFailures++
              })
            ),
            Effect.forkChild
          )
          yield* TestClock.adjust(600000)
          expect(terminalFailures).toBe(0)
          expect(times).toEqual([0, 5000, 15000, 35000, 75000, 155000, 315000])
          yield* TestClock.adjust(15000)
          expect(yield* Fiber.join(fiber)).toBe(1)
          expect(times.at(-1)).toBe(615000)
          expect(terminalFailures).toBe(0)
        })
    )
  })
  it.effect("an unkeyed irreversible read-only declaration preserves the original infra failure", () => {
    let attempts = 0
    return run(
      "irreversible-read-only",
      { tier: "irreversible", effects: readOnly },
      Effect.suspend(() => {
        attempts++
        return Effect.fail(new Unreachable.Unreachable({ message: "ENOTFOUND" }))
      }),
      (execution) =>
        Effect.gen(function*() {
          const exit = yield* execution.pipe(Effect.exit)
          const reason = failReason(exit)
          expect(attempts).toBe(1)
          expect(Fault.of(reason?._tag === "Fail" ? reason.error : undefined).class).toBe("infra")
          expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(false)
          expect(yield* Clock.currentTimeMillis).toBe(0)
        })
    )
  })

  it.effect("stops when an infrastructure failure is followed by a bug", () => {
    let attempts = 0
    return run(
      "infra-then-bug",
      { effects: readOnly },
      Effect.suspend<never, typeof ErrorSchema.Type, never>(() =>
        ++attempts === 1
          ? Effect.fail(new Unreachable.Unreachable({ message: "EAI_AGAIN" }))
          : Effect.fail({ _tag: "application/InvalidInput" as const, attempt: attempts })
      ),
      (execution) =>
        Effect.gen(function*() {
          const fiber = yield* execution.pipe(Effect.exit, Effect.forkChild)
          yield* TestClock.adjust(5000)
          const reason = failReason(yield* Fiber.join(fiber))
          expect(attempts).toBe(2)
          expect(reason?._tag === "Fail" && reason.error).toEqual({ _tag: "application/InvalidInput", attempt: 2 })
          expect(yield* Clock.currentTimeMillis).toBe(5000)
        })
    )
  })

  it.effect("cancellation interrupts backoff without dispatching again", () => {
    let attempts = 0
    return run(
      "cancel",
      { effects: readOnly },
      Effect.suspend(() => {
        attempts++
        return Effect.fail(new Unreachable.Unreachable({ message: "EAI_AGAIN" }))
      }),
      (execution, cancel) =>
        Effect.gen(function*() {
          const fiber = yield* execution.pipe(Effect.forkChild)
          yield* TestClock.adjust(4999)
          yield* cancel
          yield* Fiber.interrupt(fiber)
          yield* TestClock.adjust(7200000)
          expect(attempts).toBe(1)
        })
    )
  })

  it.effect("does not retry a defect in a repeat-safe action", () => {
    let attempts = 0
    return run(
      "defect",
      { effects: readOnly },
      Effect.suspend(() => {
        attempts++
        return Effect.die(new Error("broken invariant"))
      }),
      (execution) =>
        Effect.gen(function*() {
          const exit = yield* execution.pipe(Effect.exit)
          expect(attempts).toBe(1)
          expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
          expect(yield* Clock.currentTimeMillis).toBe(0)
        })
    )
  })
})
