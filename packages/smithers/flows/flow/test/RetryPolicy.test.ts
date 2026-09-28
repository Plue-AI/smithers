// Deep reviewed and polished by a human on 2026-08-10.

/**
 * `RetryPolicy` is pure data: every delay, give-up, and classification below
 * is derived without a runtime. The engine's use of these decisions — the
 * retry loop itself — is tested in `@smthrs/engine`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, RetryPolicy } from "@smthrs/flow"
import { Cause, Effect, Exit, Option, Random, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"

const some = (value: number) => Option.some(value)
const none = Option.none()

describe("make", () => {
  const base = { initialMs: 100, factor: 2, maxMs: 1_000 }

  it("rejects invalid bounds with a RangeError that names the field", () => {
    const cases: ReadonlyArray<{
      readonly field: string
      readonly options: Parameters<typeof RetryPolicy.make>[0]
    }> = [
      { field: "initialMs", options: { ...base, initialMs: -1 } },
      { field: "initialMs", options: { ...base, initialMs: 0 } },
      { field: "initialMs", options: { ...base, initialMs: Number.NaN } },
      { field: "initialMs", options: { ...base, initialMs: Number.POSITIVE_INFINITY } },
      { field: "factor", options: { ...base, factor: 0 } },
      { field: "factor", options: { ...base, factor: -1 } },
      { field: "factor", options: { ...base, factor: Number.POSITIVE_INFINITY } },
      { field: "maxMs", options: { ...base, maxMs: 99 } },
      { field: "maxMs", options: { ...base, maxMs: Number.POSITIVE_INFINITY } },
      { field: "maxAttempts", options: { ...base, maxAttempts: 0 } },
      { field: "maxAttempts", options: { ...base, maxAttempts: 1.5 } },
      { field: "maxAttempts", options: { ...base, maxAttempts: Number.NaN } },
      { field: "expirationMs", options: { ...base, expirationMs: 0 } },
      { field: "expirationMs", options: { ...base, expirationMs: Number.NaN } },
      { field: "expirationMs", options: { ...base, expirationMs: Number.POSITIVE_INFINITY } },
      { field: "jitterRatio", options: { ...base, jitterRatio: -1 } },
      { field: "jitterRatio", options: { ...base, jitterRatio: 1.0001 } },
      { field: "jitterRatio", options: { ...base, jitterRatio: Number.NaN } }
    ]

    for (const testCase of cases) {
      expect(() => RetryPolicy.make(testCase.options)).toThrow(RangeError)
      expect(() => RetryPolicy.make(testCase.options)).toThrow(`"${testCase.field}"`)
    }
  })

  it("accepts every inclusive boundary", () => {
    expect(
      RetryPolicy.make({
        initialMs: 1,
        factor: 1,
        maxMs: 1,
        maxAttempts: 1,
        expirationMs: 1,
        jitterRatio: 0
      })
    ).toMatchObject({ initialMs: 1, maxMs: 1, maxAttempts: 1, jitterRatio: 0 })
    expect(RetryPolicy.make({ ...base, maxMs: 100, jitterRatio: 1 })).toMatchObject({
      initialMs: 100,
      maxMs: 100,
      jitterRatio: 1
    })
  })

  it("copies and freezes the nonRetryable list", () => {
    const nonRetryable = ["Fatal"]
    const policy = RetryPolicy.make({ ...base, nonRetryable })

    nonRetryable.push("AddedLater")

    expect(policy.nonRetryable).toEqual(["Fatal"])
    expect(Object.isFrozen(policy.nonRetryable)).toBe(true)
  })

  it("enforces the constructor contract when decoding persisted policies", () => {
    const decode = Schema.decodeUnknownSync(RetryPolicy.RetryPolicy)
    expect(() => decode({ ...base, initialMs: 0 })).toThrow(/initialMs/)
    expect(() => decode({ ...base, maxMs: 99 })).toThrow(/maxMs/)
    expect(() => decode({ ...base, maxAttempts: 1.5 })).toThrow(/maxAttempts/)
    expect(() => decode({ ...base, jitterRatio: 2 })).toThrow(/jitterRatio/)
    expect(decode({ ...base, maxAttempts: 3 })).toMatchObject({ maxAttempts: 3 })
  })
})

describe("nextDelay", () => {
  const policy = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1000 })

  it("mirrors the temporal formula: initialMs * factor^(attempt - 1)", () => {
    expect(RetryPolicy.nextDelay(policy, 1)).toEqual(some(100))
    expect(RetryPolicy.nextDelay(policy, 2)).toEqual(some(200))
    expect(RetryPolicy.nextDelay(policy, 3)).toEqual(some(400))
    expect(RetryPolicy.nextDelay(policy, 4)).toEqual(some(800))
  })

  it("caps the delay at maxMs", () => {
    expect(RetryPolicy.nextDelay(policy, 5)).toEqual(some(1000))
    expect(RetryPolicy.nextDelay(policy, 50)).toEqual(some(1000))
  })

  it("gives up when maxAttempts is reached (attempt >= maxAttempts)", () => {
    const bounded = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      maxAttempts: 3
    })
    expect(RetryPolicy.nextDelay(bounded, 2)).toEqual(some(200))
    expect(RetryPolicy.nextDelay(bounded, 3)).toEqual(none)
    expect(RetryPolicy.nextDelay(bounded, 4)).toEqual(none)
  })

  it("gives up on a non-positive computed interval", () => {
    // `make` refuses these, so they model persisted rows that bypassed it.
    const zero: RetryPolicy.RetryPolicy = { initialMs: 0, factor: 2, maxMs: 1000 }
    expect(RetryPolicy.nextDelay(zero, 1)).toEqual(none)
    const negative: RetryPolicy.RetryPolicy = { initialMs: -5, factor: 2, maxMs: 1000 }
    expect(RetryPolicy.nextDelay(negative, 1)).toEqual(none)
    // A valid shrinking policy whose exponential underflows to zero.
    const underflow = RetryPolicy.make({ initialMs: 1, factor: 0.5, maxMs: 1 })
    expect(RetryPolicy.nextDelay(underflow, 2_000)).toEqual(none)
  })

  it("keeps retrying with a one millisecond initial interval up to maxAttempts", () => {
    // The smallest accepted interval behaves as a near-immediate retry, which
    // is the replacement for the refused `initialMs: 0`.
    const nearImmediate = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 5 })
    for (const attempt of [1, 2, 3, 4]) {
      expect(RetryPolicy.nextDelay(nearImmediate, attempt)).toEqual(some(1))
    }
    expect(RetryPolicy.nextDelay(nearImmediate, 5)).toEqual(none)
  })

  it("gives up when the cap falls below the initial interval", () => {
    const inverted: RetryPolicy.RetryPolicy = { initialMs: 500, factor: 2, maxMs: 100 }
    expect(RetryPolicy.nextDelay(inverted, 1)).toEqual(none)
  })

  it("gives up on non-finite persisted inputs that bypassed make", () => {
    const unbounded: RetryPolicy.RetryPolicy = { initialMs: 100, factor: 2, maxMs: 1_000 }
    expect(RetryPolicy.nextDelay(unbounded, Number.NaN)).toEqual(none)
    expect(RetryPolicy.nextDelay(unbounded, 1, { elapsedMs: Number.POSITIVE_INFINITY })).toEqual(none)

    const corruptAttempts = [Number.NaN, Number.POSITIVE_INFINITY].map(
      (maxAttempts): RetryPolicy.RetryPolicy => ({ ...unbounded, maxAttempts })
    )
    for (const corrupt of corruptAttempts) {
      expect(RetryPolicy.nextDelay(corrupt, 1)).toEqual(none)
      expect(RetryPolicy.decide(corrupt, { attempt: 1, error: "e" })).toEqual(
        RetryPolicy.giveUp("exhausted")
      )
    }

    const corruptExpiration: RetryPolicy.RetryPolicy = { ...unbounded, expirationMs: Number.NaN }
    expect(RetryPolicy.nextDelay(corruptExpiration, 1, { elapsedMs: 0 })).toEqual(none)
    expect(RetryPolicy.decide(corruptExpiration, { attempt: 1, error: "e", elapsedMs: 0 })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )
  })

  it("never returns a bad delay from malformed persisted jitter", () => {
    const malformed: RetryPolicy.RetryPolicy = {
      initialMs: 1_000,
      factor: 1,
      maxMs: 10_000,
      jitterRatio: 2
    }
    const delay = RetryPolicy.nextDelay(malformed, 1, { random: 0 })
    expect(delay).toEqual(none)
    expect(RetryPolicy.decide(malformed, { attempt: 1, error: "e", random: 0 })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )

    const ordinary = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1_000, jitterRatio: 0.5 })
    expect(RetryPolicy.nextDelay(ordinary, 1, { random: Number.NaN })).toEqual(none)
    // `random` is a public option, so an out-of-range sample is a caller
    // mistake that must not produce a delay outside the declared window.
    expect(RetryPolicy.nextDelay(ordinary, 1, { random: -0.5 })).toEqual(none)
    expect(RetryPolicy.nextDelay(ordinary, 1, { random: 1.5 })).toEqual(none)

    // An uncapped policy whose growth overflows to Infinity is corrupt in the
    // same way, and is refused before the jitter step rather than after it.
    const uncapped: RetryPolicy.RetryPolicy = {
      initialMs: 100,
      factor: 2,
      maxMs: Number.POSITIVE_INFINITY,
      jitterRatio: 0.5
    }
    expect(RetryPolicy.nextDelay(uncapped, 2_000, { random: 0.5 })).toEqual(none)
  })

  it("retries immediately when full jitter samples zero", () => {
    // Regression: guarding `delay > 0` AFTER the jitter step turned the
    // legitimate zero-delay sample of full jitter into an exhausted sequence.
    // `make` accepts `jitterRatio: 1`, and `random` is a public option, so a
    // deterministic caller reaches this directly.
    const full = RetryPolicy.make({ initialMs: 1_000, factor: 1, maxMs: 10_000, jitterRatio: 1 })
    expect(RetryPolicy.nextDelay(full, 1, { random: 0 })).toEqual(some(0))
    expect(RetryPolicy.decide(full, { attempt: 1, error: "e", random: 0 })).toEqual(
      RetryPolicy.retryAfter(0)
    )
    expect(RetryPolicy.nextDelay(full, 1, { random: 1 })).toEqual(some(1_000))
  })

  it("never jitters a delay above the declared cap", () => {
    // Regression: `delay * (1 - ratio) + random * delay * ratio` is not exactly
    // `delay` when `random` is 1. At ratio 0.000002 the two terms round to
    // 100.00000000000001, which is above the policy's own `maxMs` and above the
    // remaining expiration window when one applies, and `@smthrs/engine` sleeps
    // on whatever this returns.
    const rounding = RetryPolicy.make({ initialMs: 100, factor: 1, maxMs: 100, jitterRatio: 0.000002 })
    expect(RetryPolicy.nextDelay(rounding, 1, { random: 1 })).toEqual(some(100))

    // The stated postcondition, over the shapes that reach the rounding: the
    // delay a policy hands the engine is never negative and never above the cap.
    for (const jitterRatio of [0.000002, 1e-7, 0.1, 1 / 3, 0.9999999, 1]) {
      for (const random of [0, 0.5, 1 - Number.EPSILON, 1]) {
        for (const [initialMs, maxMs] of [[100, 100], [1_000, 30_000], [7, 7]] as const) {
          const policy = RetryPolicy.make({ initialMs, factor: 1.5, maxMs, jitterRatio })
          const delay = RetryPolicy.nextDelay(policy, 3, { random })
          expect(Option.isSome(delay)).toBe(true)
          const value = (delay as Option.Some<number>).value
          expect(value).toBeGreaterThanOrEqual(0)
          expect(value).toBeLessThanOrEqual(maxMs)
        }
      }
    }
  })

  it("applies jitter from the supplied random sample", () => {
    const jittered = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      jitterRatio: 0.2
    })
    // delay * (1 - ratio) + random * delay * ratio
    expect(RetryPolicy.nextDelay(jittered, 1, { random: 0 })).toEqual(some(80))
    expect(RetryPolicy.nextDelay(jittered, 1, { random: 0.5 })).toEqual(some(90))
    expect(RetryPolicy.nextDelay(jittered, 1, { random: 1 })).toEqual(some(100))
    // Default random of 1 leaves the delay un-jittered.
    expect(RetryPolicy.nextDelay(jittered, 1)).toEqual(some(100))
  })

  it.effect("samples the Random service deterministically under a seed", () =>
    Effect.gen(function*() {
      const jittered = RetryPolicy.make({
        initialMs: 100,
        factor: 2,
        maxMs: 1000,
        jitterRatio: 0.5
      })
      const sample = () =>
        withCrypto(
          RetryPolicy.nextDelayEffect(jittered, 2).pipe(Random.withSeed(42))
        )
      const first = yield* sample()
      const second = yield* sample()
      expect(first).toEqual(second)
      const delay = Option.getOrThrow(first)
      expect(delay).toBeGreaterThanOrEqual(100)
      expect(delay).toBeLessThanOrEqual(200)
    }))
})

describe("expiration (issue #36)", () => {
  const policy = RetryPolicy.make({
    initialMs: 100,
    factor: 2,
    maxMs: 1000,
    expirationMs: 1_000
  })

  it("gives up once the expiration bound leaves no room for another full-value attempt", () => {
    // Temporal's ComputeNextDelay: done when elapsed passes the expiration
    // interval, or when the remaining window caps the delay below initialMs.
    expect(RetryPolicy.nextDelay(policy, 1, { elapsedMs: 0 })).toEqual(some(100))
    expect(RetryPolicy.nextDelay(policy, 3, { elapsedMs: 500 })).toEqual(some(400))
    // elapsed 950 leaves a 50ms window, below the 100ms initial interval
    expect(RetryPolicy.nextDelay(policy, 3, { elapsedMs: 950 })).toEqual(none)
    // elapsed exactly at the bound leaves a zero window
    expect(RetryPolicy.nextDelay(policy, 1, { elapsedMs: 1_000 })).toEqual(none)
    // elapsed past the bound gives up before computing any interval
    expect(RetryPolicy.nextDelay(policy, 1, { elapsedMs: 1_001 })).toEqual(none)
  })

  it("caps the final retry delay to the remaining expiration interval instead of expiring early", () => {
    // Temporal parity: `retrypolicy_test.go` TestExpirationOverflow — with
    // initial 2s / expiration 5s, the retry after 2s elapsed is capped to the
    // remaining 3s window rather than refused because 2s + 4s > 5s.
    const temporal = RetryPolicy.make({
      initialMs: 2_000,
      factor: 2,
      maxMs: 1_000_000,
      expirationMs: 5_000
    })
    expect(RetryPolicy.nextDelay(temporal, 1, { elapsedMs: 0 })).toEqual(some(2_000))
    expect(RetryPolicy.nextDelay(temporal, 2, { elapsedMs: 2_000 })).toEqual(some(3_000))
    // the capped delay must still clear the initial interval: at 3.5s elapsed
    // only 1.5s remains, below the 2s initial interval, so the policy expires
    expect(RetryPolicy.nextDelay(temporal, 2, { elapsedMs: 3_500 })).toEqual(none)
    expect(
      RetryPolicy.decide(temporal, { attempt: 2, error: "e", elapsedMs: 2_000 })
    ).toEqual(RetryPolicy.retryAfter(3_000))
    expect(
      RetryPolicy.decide(temporal, { attempt: 2, error: "e", elapsedMs: 3_500 })
    ).toEqual(RetryPolicy.giveUp("expired"))
  })

  it("applies jitter to the expiration-capped delay, never exceeding the remaining window", () => {
    const jittered = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1_000,
      expirationMs: 1_000,
      jitterRatio: 0.5
    })
    // attempt 3 computes 400ms, capped to the remaining 300ms, then jittered
    // within [150, 300] — matching Temporal's cap-then-jitter ordering.
    expect(RetryPolicy.nextDelay(jittered, 3, { elapsedMs: 700, random: 0 })).toEqual(some(150))
    expect(RetryPolicy.nextDelay(jittered, 3, { elapsedMs: 700, random: 1 })).toEqual(some(300))
  })

  it("ignores elapsed time when the policy declares no expiration", () => {
    const unbounded = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1000 })
    expect(RetryPolicy.nextDelay(unbounded, 5, { elapsedMs: Number.MAX_SAFE_INTEGER })).toEqual(some(1000))
  })

  it("decide reports the expired give-up distinctly from exhaustion", () => {
    const decision = RetryPolicy.decide(policy, {
      attempt: 2,
      error: new Error("still down"),
      elapsedMs: 5_000
    })
    expect(decision).toEqual({ _tag: "GiveUp", reason: "expired" })
  })

  it("separates malformed elapsed time from a genuine policy expiry", () => {
    const unbounded = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1_000 })
    for (const elapsedMs of [-1, Number.NaN]) {
      expect(RetryPolicy.decide(unbounded, { attempt: 1, error: "e", elapsedMs })).toEqual(
        RetryPolicy.giveUp("exhausted")
      )
    }
    expect(RetryPolicy.decide(policy, { attempt: 1, error: "e", elapsedMs: 1_000 })).toEqual(
      RetryPolicy.giveUp("expired")
    )
  })
})

describe("decide", () => {
  it("honors a tool retry hint within policy bounds", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 2_000,
      maxAttempts: 3,
      expirationMs: 5_000,
      jitterRatio: 0.5,
      nonRetryable: ["Fatal"]
    })
    const error = { retryAfterMs: 3_000 }
    expect(RetryPolicy.decide(
      RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 4_000 }),
      { attempt: 1, error }
    )).toEqual(RetryPolicy.retryAfter(3_000))
    expect(RetryPolicy.decide(policy, { attempt: 1, error, elapsedMs: 0, random: 0 })).toEqual(
      RetryPolicy.retryAfter(2_000)
    )
    expect(RetryPolicy.decide(policy, { attempt: 1, error, elapsedMs: 3_500 })).toEqual(
      RetryPolicy.retryAfter(1_500)
    )
    expect(RetryPolicy.decide(policy, { attempt: 1, error: { retryAfterMs: 300 }, elapsedMs: 0 }))
      .toEqual(RetryPolicy.retryAfter(300))
    expect(RetryPolicy.decide(policy, { attempt: 1, error, elapsedMs: 4_950 })).toEqual(
      RetryPolicy.giveUp("expired")
    )
    expect(RetryPolicy.decide(policy, { attempt: 3, error })).toEqual(RetryPolicy.giveUp("exhausted"))
    expect(RetryPolicy.decide(policy, { attempt: 1, error: { _tag: "Fatal", retryAfterMs: 3000 } }))
      .toEqual(RetryPolicy.giveUp("nonRetryable"))
    for (const retryAfterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, "3000"]) {
      expect(RetryPolicy.decide(policy, { attempt: 1, error: { retryAfterMs } }))
        .toEqual(RetryPolicy.retryAfter(100))
    }
    const accessor = Object.defineProperty({}, "retryAfterMs", { get: () => { throw new Error("read") } })
    expect(RetryPolicy.decide(policy, { attempt: 1, error: accessor }))
      .toEqual(RetryPolicy.retryAfter(100))
  })

  it("keeps non-retryable integrity failures terminal across attempt and clock boundaries", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1_000,
      maxAttempts: 2,
      expirationMs: 300,
      nonRetryable: ["CallerFatal"]
    })

    // Literal integrity tags keep this oracle independent of the production default list.
    for (
      const tag of [
        "CallerFatal",
        "@smthrs/engine-store/CacheCorruptionDetected",
        "@smthrs/engine-store/AttemptEvidenceQuarantined"
      ]
    ) {
      for (const attempt of [1, 2, 3]) {
        for (const elapsedMs of [0, 300, 301]) {
          expect(RetryPolicy.decide(policy, { attempt, elapsedMs, error: { _tag: tag } })).toEqual(
            RetryPolicy.giveUp("nonRetryable")
          )
        }
      }
    }

    expect(RetryPolicy.decide(policy, { attempt: 1, elapsedMs: 0, error: { _tag: "Transient" } }))
      .toEqual(RetryPolicy.retryAfter(100))
    expect(RetryPolicy.decide(policy, { attempt: 2, elapsedMs: 0, error: { _tag: "Transient" } }))
      .toEqual(RetryPolicy.giveUp("exhausted"))
    expect(RetryPolicy.decide(policy, { attempt: 1, elapsedMs: 300, error: { _tag: "Transient" } }))
      .toEqual(RetryPolicy.giveUp("expired"))
  })

  it("classifies tagged failures identically after an action Exit JSON round trip", () => {
    class CallerFatal extends Schema.TaggedError<CallerFatal>()("Retry/CallerFatal", {
      reason: Schema.String
    }) {}
    class CacheCorruption extends Schema.TaggedError<CacheCorruption>()(
      "@smthrs/engine-store/CacheCorruptionDetected",
      { row: Schema.String }
    ) {}
    const failureSchema = Schema.Union([CallerFatal, CacheCorruption])
    const action = Action.make({
      name: "Retry/rehydrated",
      success: Schema.Number,
      error: failureSchema,
      execute: Effect.succeed(1)
    })
    const exitCodec = Schema.toCodecJson(action.exitSchema)
    const callerPolicy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      nonRetryable: ["Retry/CallerFatal"]
    })
    const defaultPolicy = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1000 })
    const cases = [
      { live: new CallerFatal({ reason: "do not retry" }), policy: callerPolicy },
      { live: new CacheCorruption({ row: "attempt-7" }), policy: defaultPolicy }
    ] as const

    for (const current of cases) {
      const encoded = Schema.encodeUnknownSync(exitCodec)(Exit.fail(current.live))
      const decoded = Schema.decodeUnknownSync(exitCodec)(JSON.parse(JSON.stringify(encoded)))
      expect(Exit.isFailure(decoded)).toBe(true)
      if (!Exit.isFailure(decoded)) continue
      const failureReason = decoded.cause.reasons.find(Cause.isFailReason)
      expect(failureReason).toBeDefined()
      if (failureReason === undefined) continue
      const rehydrated = failureReason.error

      expect(rehydrated).toEqual(current.live)
      expect(RetryPolicy.errorTag(rehydrated)).toBe(current.live._tag)
      expect(RetryPolicy.decide(current.policy, { attempt: 1, error: rehydrated })).toEqual(
        RetryPolicy.decide(current.policy, { attempt: 1, error: current.live })
      )
      expect(RetryPolicy.decide(current.policy, { attempt: 1, error: rehydrated })).toEqual(
        RetryPolicy.giveUp("nonRetryable")
      )
    }
  })

  it("short-circuits a nonRetryable-tagged error to giveUp on attempt 1", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      nonRetryable: ["FatalError"]
    })
    expect(
      RetryPolicy.decide(policy, { attempt: 1, error: { _tag: "FatalError" } })
    ).toEqual(RetryPolicy.giveUp("nonRetryable"))
    expect(
      RetryPolicy.decide(policy, { attempt: 1, error: { _tag: "OtherError" } })
    ).toEqual(RetryPolicy.retryAfter(100))
  })

  it("matches an Error instance by name", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      nonRetryable: ["TypeError"]
    })
    expect(
      RetryPolicy.decide(policy, { attempt: 1, error: new TypeError("boom") })
    ).toEqual(RetryPolicy.giveUp("nonRetryable"))
  })

  it("matches an Error subclass whose stable name is defined on its prototype", () => {
    class Permanent extends Error {}
    Permanent.prototype.name = "Permanent"
    const error = new Permanent("do not retry")
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1_000,
      nonRetryable: ["Permanent"]
    })

    expect(RetryPolicy.errorTag(error)).toBe("Permanent")
    expect(RetryPolicy.decide(policy, { attempt: 1, error })).toEqual(
      RetryPolicy.giveUp("nonRetryable")
    )
  })

  it("bounds a hostile proxy prototype walk without invoking property getters", () => {
    let prototypeReads = 0
    let propertyReads = 0
    const target = Object.defineProperty({}, "message", {
      get() {
        propertyReads++
        return "hidden"
      }
    })
    let hostile: object
    hostile = new Proxy(target, {
      getPrototypeOf() {
        prototypeReads++
        return prototypeReads <= 65 ? hostile : null
      }
    })

    expect(RetryPolicy.errorTag(hostile)).toBeUndefined()
    expect(prototypeReads).toBe(64)
    expect(propertyReads).toBe(0)
  })

  it("never invokes accessors or proxy traps while classifying an error", () => {
    let getters = 0
    const accessor = Object.defineProperty({}, "_tag", {
      get() {
        getters += 1
        return "FatalError"
      }
    })
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("trap")
      }
    })

    expect(RetryPolicy.errorTag(accessor)).toBeUndefined()
    expect(RetryPolicy.errorTag(hostile)).toBeUndefined()
    expect(getters).toBe(0)
  })

  it("returns exhausted when the policy runs out of attempts", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      maxAttempts: 2
    })
    expect(RetryPolicy.decide(policy, { attempt: 1, error: "e" })).toEqual(
      RetryPolicy.retryAfter(100)
    )
    expect(RetryPolicy.decide(policy, { attempt: 2, error: "e" })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )
  })
})

// Parity: Temporal `common/backoff/retry_test.go:285` (duration overflow) and
// `retrypolicy_test.go:269` (constant / conditional policies).
describe("nextDelay numeric boundaries", () => {
  it("clamps an overflowing exponential to maxMs instead of returning Infinity", () => {
    const explosive = RetryPolicy.make({
      initialMs: 1000,
      factor: 1e6,
      maxMs: 30000
    })
    // 1000 * 1e6^999 overflows IEEE754 to Infinity before the cap is applied.
    const delay = RetryPolicy.nextDelay(explosive, 1000)
    expect(Option.isSome(delay)).toBe(true)
    if (Option.isSome(delay)) {
      expect(Number.isFinite(delay.value)).toBe(true)
      expect(delay.value).toBe(30000)
    }
  })

  it("clamps at the largest finite attempt index without producing NaN", () => {
    const policy = RetryPolicy.make({ initialMs: 1, factor: 2, maxMs: 60000 })
    for (const attempt of [1024, Number.MAX_SAFE_INTEGER]) {
      const delay = RetryPolicy.nextDelay(policy, attempt)
      expect(Option.isSome(delay)).toBe(true)
      if (Option.isSome(delay)) {
        expect(Number.isNaN(delay.value)).toBe(false)
        expect(delay.value).toBe(60000)
      }
    }
  })

  it("keeps an overflowing delay clamped once jitter is applied", () => {
    const jittered = RetryPolicy.make({
      initialMs: 1000,
      factor: 1e6,
      maxMs: 30000,
      jitterRatio: 0.5
    })
    expect(RetryPolicy.nextDelay(jittered, 1000, { random: 0 })).toEqual(some(15000))
    expect(RetryPolicy.nextDelay(jittered, 1000, { random: 1 })).toEqual(some(30000))
  })

  it("expresses a constant-delay policy as factor 1", () => {
    const constant = RetryPolicy.make({ initialMs: 250, factor: 1, maxMs: 250 })
    for (const attempt of [1, 2, 7, 500]) {
      expect(RetryPolicy.nextDelay(constant, attempt)).toEqual(some(250))
    }
  })

  it("a constant policy with maxAttempts stops exactly at the bound", () => {
    const constant = RetryPolicy.make({
      initialMs: 250,
      factor: 1,
      maxMs: 250,
      maxAttempts: 4
    })
    expect(RetryPolicy.decide(constant, { attempt: 3, error: "e" })).toEqual(
      RetryPolicy.retryAfter(250)
    )
    expect(RetryPolicy.decide(constant, { attempt: 4, error: "e" })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )
  })

  it("a fractional factor still never dips below the initial interval", () => {
    const decaying = RetryPolicy.make({ initialMs: 100, factor: 0.5, maxMs: 1000 })
    expect(RetryPolicy.nextDelay(decaying, 1)).toEqual(some(100))
    // attempt 2 computes 50ms, which is below initialMs, so the policy gives up
    expect(RetryPolicy.nextDelay(decaying, 2)).toEqual(none)
    expect(RetryPolicy.decide(decaying, { attempt: 2, error: "e" })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )
  })

  it("maxAttempts of 1 refuses to retry the very first failure", () => {
    const once = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      maxAttempts: 1
    })
    expect(RetryPolicy.nextDelay(once, 1)).toEqual(none)
    expect(RetryPolicy.decide(once, { attempt: 1, error: "e" })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )
  })

  it("nonRetryable classification wins over an otherwise valid delay and over exhaustion", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      maxAttempts: 1,
      nonRetryable: ["Fatal"]
    })
    expect(
      RetryPolicy.decide(policy, { attempt: 1, error: { _tag: "Fatal" } })
    ).toEqual(RetryPolicy.giveUp("nonRetryable"))
    // an untagged error at the same attempt is exhausted, not nonRetryable
    expect(RetryPolicy.decide(policy, { attempt: 1, error: "plain" })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )
  })

  it("errorTag reads _tag, then Error name, and is otherwise undefined", () => {
    expect(RetryPolicy.errorTag({ _tag: "Tagged" })).toBe("Tagged")
    const named = new Error("x")
    Object.defineProperty(named, "name", { value: "NamedError" })
    expect(RetryPolicy.errorTag(named)).toBe("NamedError")
    for (
      const [error, name] of [
        [new EvalError("x"), "EvalError"],
        [new RangeError("x"), "RangeError"],
        [new ReferenceError("x"), "ReferenceError"],
        [new SyntaxError("x"), "SyntaxError"],
        [new TypeError("x"), "TypeError"],
        [new URIError("x"), "URIError"],
        [new AggregateError([], "x"), "AggregateError"],
        [new Error("x"), "Error"]
      ] as const
    ) {
      expect(RetryPolicy.errorTag(error)).toBe(name)
    }
    expect(RetryPolicy.errorTag(Object.defineProperty({}, "name", { get: () => "hidden" }))).toBeUndefined()
    expect(RetryPolicy.errorTag(Object.defineProperty({}, "name", { value: 7 }))).toBeUndefined()
    expect(RetryPolicy.errorTag({ _tag: 7 })).toBe(undefined)
    expect(RetryPolicy.errorTag("string")).toBe(undefined)
    expect(RetryPolicy.errorTag(null)).toBe(undefined)
  })

  it("cache corruption is non-retryable by type, with no per-policy opt-in", () => {
    // Issue #156: a corrupt cache row is deterministic — every retry re-reads
    // the same bytes — so the default classification refuses it even under a
    // policy that declared no nonRetryable tags at all.
    const policy = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1000, maxAttempts: 5 })
    const corruption = { _tag: "@smthrs/engine-store/CacheCorruptionDetected" }
    expect(RetryPolicy.isNonRetryable(policy, corruption)).toBe(true)
    expect(RetryPolicy.decide(policy, { attempt: 1, error: corruption })).toEqual(
      RetryPolicy.giveUp("nonRetryable")
    )
    // an explicit caller list cannot opt corruption back into retrying
    const optIn = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      nonRetryable: ["SomethingElse"]
    })
    expect(RetryPolicy.isNonRetryable(optIn, corruption)).toBe(true)
  })

  it("an empty nonRetryable list classifies nothing as non-retryable", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      nonRetryable: []
    })
    expect(RetryPolicy.isNonRetryable(policy, { _tag: "Anything" })).toBe(false)
    expect(RetryPolicy.decide(policy, { attempt: 1, error: { _tag: "Anything" } })).toEqual(
      RetryPolicy.retryAfter(100)
    )
  })

  it.effect("decideEffect skips the Random service when jitter is absent or zero", () =>
    Effect.gen(function*() {
      const noJitter = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1000 })
      const zeroJitter = RetryPolicy.make({
        initialMs: 100,
        factor: 2,
        maxMs: 1000,
        jitterRatio: 0
      })
      for (const policy of [noJitter, zeroJitter]) {
        const decision = yield* withCrypto(
          RetryPolicy.decideEffect(policy, { attempt: 1, error: "e" })
        )
        expect(decision).toEqual(RetryPolicy.retryAfter(100))
        const delay = yield* withCrypto(RetryPolicy.nextDelayEffect(policy, 1))
        expect(delay).toEqual(some(100))
      }
    }))

  it.effect("decideEffect samples Random once when jitter is enabled and stays in the jitter band", () =>
    Effect.gen(function*() {
      const policy = RetryPolicy.make({
        initialMs: 100,
        factor: 2,
        maxMs: 1000,
        jitterRatio: 0.5
      })
      const decision = yield* withCrypto(
        RetryPolicy.decideEffect(policy, { attempt: 2, error: "e" }).pipe(Random.withSeed(42))
      )
      expect(decision._tag).toBe("RetryAfter")
      // attempt 2 → 200ms base; a 0.5 jitter ratio keeps the delay in [100, 200]
      const delayMs = decision._tag === "RetryAfter" ? decision.delayMs : Number.NaN
      expect(delayMs).toBeGreaterThanOrEqual(100)
      expect(delayMs).toBeLessThanOrEqual(200)
      // deterministic under a fixed seed
      const again = yield* withCrypto(
        RetryPolicy.decideEffect(policy, { attempt: 2, error: "e" }).pipe(Random.withSeed(42))
      )
      expect(again).toEqual(decision)
    }))

  it.effect("decideEffect still gives up on a nonRetryable error before sampling jitter", () =>
    Effect.gen(function*() {
      const policy = RetryPolicy.make({
        initialMs: 100,
        factor: 2,
        maxMs: 1000,
        jitterRatio: 0.5,
        nonRetryable: ["Fatal"]
      })
      const decision = yield* withCrypto(
        RetryPolicy.decideEffect(policy, { attempt: 1, error: { _tag: "Fatal" } }).pipe(
          Random.withSeed(1)
        )
      )
      expect(decision).toEqual(RetryPolicy.giveUp("nonRetryable"))
    }))
})

describe("defaultRetryPolicy", () => {
  it("mirrors the historical exponential(200, 1.5) / spaced(30000) envelope", () => {
    expect(Object.isFrozen(RetryPolicy.defaultRetryPolicy)).toBe(true)
    expect(RetryPolicy.nextDelay(RetryPolicy.defaultRetryPolicy, 1)).toEqual(some(200))
    expect(RetryPolicy.nextDelay(RetryPolicy.defaultRetryPolicy, 2)).toEqual(some(300))
    expect(RetryPolicy.nextDelay(RetryPolicy.defaultRetryPolicy, 3)).toEqual(some(450))
    expect(
      RetryPolicy.nextDelay(RetryPolicy.defaultRetryPolicy, 100)
    ).toEqual(some(30000))
  })
})
