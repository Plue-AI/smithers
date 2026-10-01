/**
 * The limiter the GitHub proxy runs per principal. Every case runs on
 * `TestClock`, so minutes of spacing and pauses take no wall time and every
 * instant is exact.
 */
import { Clock, Duration, Effect, Exit, Fiber, Metric } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { isIntegrationError } from "../src/core/IntegrationError.ts"
import {
  DEFAULT_LIMITS,
  DEFAULT_MAX_WAIT,
  type Limits,
  make,
  type Observation,
  pauses,
  type RateLimiter,
  resolveLimits,
  waits
} from "../src/github/RateLimit.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.provide(effect, TestClock.layer()))

const limiter = (limits: Partial<Limits> = {}, maxWait: Duration.Input = "1 hour") =>
  make({ limits: { ...DEFAULT_LIMITS, ...limits }, maxWait: Duration.fromInputUnsafe(maxWait) })

interface Reply {
  readonly headers?: Record<string, string>
  readonly limited?: boolean
  readonly takes?: Duration.Input
}

/** One request through `rate` that records when it started and answers `reply`. */
const call = (rate: RateLimiter, method: string, starts: Array<number>, reply: Reply = {}, path = "/repos/o/r") =>
  rate.limit(
    method,
    path,
    Effect.gen(function*() {
      starts.push(yield* Clock.currentTimeMillis)
      if (reply.takes !== undefined) yield* Effect.sleep(reply.takes)
      return reply
    }),
    (exit: Exit.Exit<Reply, never>): Observation =>
      Exit.isSuccess(exit)
        ? { headers: new Headers(exit.value.headers ?? {}), limited: exit.value.limited ?? false }
        : { limited: false }
  )

/** Runs `effect` in the background, moves the clock `by`, and joins it. */
const after = <A, E>(effect: Effect.Effect<A, E>, by: Duration.Input) =>
  Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(effect)
    yield* TestClock.adjust(by)
    return yield* Fiber.join(fiber)
  })

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((candidate) => candidate._tag === "Fail")
  if (reason?._tag !== "Fail" || !isIntegrationError(reason.error)) throw new Error("expected an IntegrationError")
  return reason.error
}

describe("RateLimit spacing", () => {
  it("starts concurrent writes at least writeSpacingMs apart, in booking order", async () => {
    const starts: Array<number> = []
    await run(Effect.gen(function*() {
      const rate = yield* limiter()
      yield* after(
        Effect.all([call(rate, "POST", starts), call(rate, "PATCH", starts), call(rate, "DELETE", starts)], {
          concurrency: "unbounded"
        }),
        "10 seconds"
      )
    }))
    expect(starts).toEqual([0, 1000, 2000])
  })

  it("never spaces reads", async () => {
    const starts: Array<number> = []
    await run(Effect.gen(function*() {
      const rate = yield* limiter()
      yield* Effect.all([call(rate, "GET", starts), call(rate, "GET", starts)], { concurrency: "unbounded" })
    }))
    expect(starts).toEqual([0, 0])
  })

  it("holds the 81st write of a minute until the first leaves the window", async () => {
    const starts: Array<number> = []
    await run(Effect.gen(function*() {
      const rate = yield* limiter({ writeSpacingMs: 0 })
      yield* after(
        Effect.all(Array.from({ length: 81 }, () => call(rate, "POST", starts)), { concurrency: "unbounded" }),
        "2 minutes"
      )
    }))
    expect(starts.filter((at) => at === 0)).toHaveLength(80)
    expect(starts.at(-1)).toBe(60_000)
  })
})

describe("RateLimit primary budget", () => {
  it("spends the modeled budget and waits for x-ratelimit-reset once it is gone", async () => {
    const starts: Array<number> = []
    const spent = { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "90" }
    await run(Effect.gen(function*() {
      const rate = yield* limiter()
      yield* after(
        Effect.gen(function*() {
          yield* call(rate, "GET", starts, { headers: spent })
          yield* call(rate, "GET", starts)
          // Another resource has its own budget and is not held.
          yield* call(rate, "POST", starts, {}, "/graphql")
        }),
        "2 minutes"
      )
    }))
    expect(starts).toEqual([0, 90_000, 90_000])
  })
})

describe("RateLimit limit responses", () => {
  it("honors Retry-After before the next request starts", async () => {
    const starts: Array<number> = []
    await run(Effect.gen(function*() {
      const rate = yield* limiter()
      yield* after(
        Effect.gen(function*() {
          yield* call(rate, "GET", starts, { limited: true, headers: { "retry-after": "7" } })
          yield* call(rate, "GET", starts)
        }),
        "1 minute"
      )
    }))
    expect(starts).toEqual([0, 7_000])
  })

  it("pauses every fiber after a 403 secondary limit, not only the one refused", async () => {
    const starts: Record<string, Array<number>> = { refused: [], a: [], b: [], inFlight: [] }
    const before = await Effect.runPromise(Metric.value(pauses))
    await run(Effect.gen(function*() {
      const rate = yield* limiter()
      yield* after(
        Effect.gen(function*() {
          // Admitted before the refusal; a request in flight is never recalled.
          const inFlight = yield* Effect.forkChild(call(rate, "GET", starts["inFlight"]!, { takes: "5 seconds" }))
          yield* Effect.yieldNow
          yield* call(rate, "POST", starts["refused"]!, { limited: true })
          yield* Effect.all([call(rate, "GET", starts["a"]!), call(rate, "POST", starts["b"]!)], {
            concurrency: "unbounded"
          })
          yield* Fiber.join(inFlight)
        }),
        "5 minutes"
      )
    }))
    expect(starts).toEqual({ refused: [0], inFlight: [0], a: [60_000], b: [60_000] })
    expect((await Effect.runPromise(Metric.value(pauses))).count).toBe(Number(before.count) + 1)
  })

  it("doubles the pause while GitHub keeps refusing, and clears it after a success", async () => {
    const starts: Array<number> = []
    await run(Effect.gen(function*() {
      const rate = yield* limiter()
      yield* after(
        Effect.gen(function*() {
          yield* call(rate, "GET", starts, { limited: true })
          yield* call(rate, "GET", starts, { limited: true })
          yield* call(rate, "GET", starts)
          yield* call(rate, "GET", starts, { limited: true })
          yield* call(rate, "GET", starts)
        }),
        "10 minutes"
      )
    }))
    expect(starts).toEqual([0, 60_000, 180_000, 180_000, 240_000])
  })

  it("records no pause for an attempt that failed without a response", async () => {
    const starts: Array<number> = []
    await run(Effect.gen(function*() {
      const rate = yield* limiter()
      const broken = rate.limit("GET", "/x", Effect.fail("socket closed"), () => ({ limited: false }))
      expect(yield* Effect.flip(broken)).toBe("socket closed")
      yield* call(rate, "GET", starts)
    }))
    expect(starts).toEqual([0])
  })
})

describe("RateLimit concurrency", () => {
  it("never has more than maxConcurrent requests in flight", async () => {
    let inFlight = 0
    let peak = 0
    const finished = await run(Effect.gen(function*() {
      const rate = yield* limiter({ maxConcurrent: 2 })
      const tracked = rate.limit(
        "GET",
        "/x",
        Effect.gen(function*() {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          yield* Effect.sleep("1 second")
          inFlight -= 1
          return yield* Clock.currentTimeMillis
        }),
        () => ({ limited: false })
      )
      return yield* after(Effect.all([tracked, tracked, tracked, tracked, tracked], { concurrency: 5 }), "10 seconds")
    }))
    expect(peak).toBe(2)
    expect([...finished].sort((a, b) => a - b)).toEqual([1000, 1000, 2000, 2000, 3000])
  })

  it("returns the permit when the request is interrupted", async () => {
    const starts: Array<number> = []
    await run(Effect.gen(function*() {
      const rate = yield* limiter({ maxConcurrent: 1 })
      const stuck = yield* Effect.forkChild(call(rate, "GET", starts, { takes: "1 hour" }))
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(stuck)
      yield* call(rate, "GET", starts)
    }))
    expect(starts).toEqual([0, 1000])
  })
})

describe("RateLimit refusals", () => {
  it("fails rate-limited with the retry instant instead of waiting past maxWait", async () => {
    const starts: Array<number> = []
    const exit = await run(Effect.gen(function*() {
      const rate = yield* limiter({}, "30 seconds")
      yield* call(rate, "GET", starts, { limited: true, headers: { "retry-after": "120" } })
      return yield* Effect.exit(call(rate, "GET", starts))
    }))
    const error = failure(exit)
    expect(error.reason).toBe("rate-limited")
    expect(error.details).toMatchObject({
      retryAt: new Date(120_000).toISOString(),
      reason: "paused",
      rateLimited: true,
      retryable: false,
      path: "/repos/o/r",
      method: "GET"
    })
    expect(starts).toEqual([0])
  })

  it("fails rate-limited for a write slot beyond maxWait without booking it", async () => {
    const starts: Array<number> = []
    const [exit, startsAt] = await run(Effect.gen(function*() {
      const rate = yield* limiter({ writeSpacingMs: 60_000 }, "10 seconds")
      yield* call(rate, "POST", starts)
      const exit = yield* Effect.exit(call(rate, "POST", starts))
      return [exit, yield* rate.earliestStart(1, "/repos/o/r")] as const
    }))
    expect(failure(exit).details).toMatchObject({ reason: "write spacing", retryAt: new Date(60_000).toISOString() })
    expect(startsAt).toBe(60_000)
    expect(starts).toEqual([0])
  })

  it("counts every wait by reason", async () => {
    const counted = (reason: string) =>
      Effect.runPromise(Metric.value(Metric.withAttributes(waits, { reason }))).then((state) => Number(state.count))
    const before = await counted("spacing")
    await run(Effect.gen(function*() {
      const rate = yield* limiter()
      yield* after(Effect.all([call(rate, "POST", []), call(rate, "POST", [])], { concurrency: 2 }), "5 seconds")
    }))
    expect(await counted("spacing")).toBe(before + 1)
  })
})

describe("RateLimit construction", () => {
  it("defaults to GitHub's limits and a one-minute wait", async () => {
    expect(Duration.toMillis(DEFAULT_MAX_WAIT)).toBe(60_000)
    const exit = await run(Effect.gen(function*() {
      const rate = yield* make()
      yield* call(rate, "GET", [], { limited: true, headers: { "retry-after": "61" } })
      return yield* Effect.exit(call(rate, "GET", []))
    }))
    expect(failure(exit).reason).toBe("rate-limited")
  })

  it("resolves limits from the environment and refuses invalid ones", () => {
    expect(resolveLimits({}, { SMITHERS_GITHUB_MAX_CONCURRENT: "4" }).maxConcurrent).toBe(4)
    expect(() => resolveLimits({ maxConcurrent: 0 })).toThrow(/maxConcurrent/)
  })
})
