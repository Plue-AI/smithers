// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Defines data-shaped retry policies for durable action retries.
 *
 * A `RetryPolicy` is a plain value — initial interval, backoff factor, cap,
 * optional maximum attempts, optional jitter, and optional non-retryable
 * error tags — so the next retry delay can be derived from a persisted
 * attempt count instead of fiber-local `Schedule` state. `nextDelay` mirrors
 * Temporal's `ExponentialRetryPolicy.ComputeNextDelay` formula, and `decide`
 * is the engine's single retry decision point: the core default a pluggable
 * `resolveRetry` resolution can later dispatch in front of.
 *
 * The historical terminal-failure schemas below use the `@smthrs/flow/` tags settled for
 * 1.0.0-rc.0. The release candidate makes no compatibility promise to 0.x
 * journals, and these tags freeze at the RC. Current action dispatch preserves
 * the final declared failure when a retry policy is spent.
 *
 * See `docs/guides/retry-a-failing-action.md`; its "Infrastructure
 * interrupts" section covers the interrupt retry schedule.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"

/**
 * Data-shaped retry policy schema.
 *
 * The delay before attempt `n + 1` is
 * `min(initialMs * factor^(n - 1), maxMs)`, where `n` is the attempt that
 * just failed. `maxAttempts` bounds the total number of attempts;
 * `expirationMs` bounds the total wall-clock retry duration
 * (schedule-to-close, mirroring Temporal's `expirationInterval`);
 * `jitterRatio` spreads the final portion of each delay uniformly;
 * `nonRetryable` lists error tags that must never be retried.
 *
 * The bounds are per STEP KEY, which is what makes them the provider-retry
 * budget for one agent ask rather than a budget for the exchange the ask
 * belongs to. A structured-output correction re-prompts under a NEW session,
 * so the corrected ask is a different sealed step with its own attempt
 * sequence: `maxAttempts` bounds the provider retries inside one correction
 * session and does not bound the correction ladder, which `AgentAction`
 * bounds separately with its own `corrections` budget.
 *
 * @category models
 * @since 0.1.0
 */
const RetryPolicyFields = Schema.Struct({
  initialMs: Schema.Number,
  factor: Schema.Number,
  maxMs: Schema.Number,
  maxAttempts: Schema.optional(Schema.Number),
  expirationMs: Schema.optional(Schema.Number),
  jitterRatio: Schema.optional(Schema.Number),
  nonRetryable: Schema.optional(Schema.Array(Schema.String))
})

type RetryPolicyFields = typeof RetryPolicyFields.Type

/** Returns the first contract violation shared by decoding and construction. */
const validationIssue = (policy: RetryPolicyFields): string | undefined => {
  // Zero is refused rather than read as "retry immediately": every computed
  // delay would be zero, so such a policy would give up on its first failure
  // no matter what `maxAttempts` promised. Use `initialMs: 1` for a
  // near-immediate retry.
  if (!Number.isFinite(policy.initialMs) || policy.initialMs <= 0) {
    return `"initialMs" must be a finite number of milliseconds greater than zero, and was ${policy.initialMs}.`
  }
  if (!Number.isFinite(policy.factor) || policy.factor <= 0) {
    return `"factor" must be a finite number greater than zero, and was ${policy.factor}.`
  }
  if (!Number.isFinite(policy.maxMs) || policy.maxMs < policy.initialMs) {
    return `"maxMs" must be a finite number of milliseconds at least as large as initialMs, and was ${policy.maxMs}.`
  }
  if (
    policy.maxAttempts !== undefined &&
    (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1)
  ) {
    return `"maxAttempts" must be a safe integer of at least one, and was ${policy.maxAttempts}.`
  }
  if (
    policy.expirationMs !== undefined &&
    (!Number.isFinite(policy.expirationMs) || policy.expirationMs <= 0)
  ) {
    return `"expirationMs" must be a finite number of milliseconds greater than zero, and was ${policy.expirationMs}.`
  }
  if (
    policy.jitterRatio !== undefined &&
    (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1)
  ) {
    return `"jitterRatio" must be a finite number between zero and one, inclusive, and was ${policy.jitterRatio}.`
  }
  return undefined
}

/**
 * Data-shaped retry policy schema. Decoding enforces the same relational
 * contract as {@link make}; persisted data cannot bypass constructor checks.
 *
 * @category models
 * @since 0.1.0
 */
export const RetryPolicy = RetryPolicyFields.check(
  Schema.makeFilter(
    (policy) => validationIssue(policy) ?? true,
    { title: "validRetryPolicy" }
  )
)

/**
 * The value form of a {@link RetryPolicy}.
 *
 * @category models
 * @since 0.1.0
 */
export type RetryPolicy = typeof RetryPolicy.Type

/**
 * Creates a `RetryPolicy` value after checking every numeric bound.
 * `initialMs` must be greater than zero: a zero initial interval would
 * compute a zero delay for every attempt, which {@link nextDelay} reads as
 * exhausted, so the policy would never retry. `jitterRatio` must be between
 * zero and one, inclusive, and `jitterRatio: 0` disables jitter.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: {
  readonly initialMs: number
  readonly factor: number
  readonly maxMs: number
  readonly maxAttempts?: number | undefined
  readonly expirationMs?: number | undefined
  readonly jitterRatio?: number | undefined
  readonly nonRetryable?: ReadonlyArray<string> | undefined
}): RetryPolicy => {
  const issue = validationIssue(options)
  if (issue !== undefined) throw new RangeError(`RetryPolicy.make: ${issue}`)
  return Object.freeze({
    initialMs: options.initialMs,
    factor: options.factor,
    maxMs: options.maxMs,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.expirationMs !== undefined ? { expirationMs: options.expirationMs } : {}),
    ...(options.jitterRatio !== undefined ? { jitterRatio: options.jitterRatio } : {}),
    ...(options.nonRetryable !== undefined
      ? { nonRetryable: Object.freeze([...options.nonRetryable]) }
      : {})
  })
}

/**
 * The default engine retry policy.
 *
 * Uses a 200ms initial delay growing by 1.5x, capped at 30s, and never gives
 * up: it declares neither `maxAttempts` nor `expirationMs`. Bound long-lived
 * retries with `make({ ..., expirationMs })` when a wall-clock give-up is
 * required.
 *
 * @category constructors
 * @since 0.1.0
 */
export const defaultRetryPolicy: RetryPolicy = Object.freeze(
  make({
    initialMs: 200,
    factor: 1.5,
    maxMs: 30000
  })
)

/**
 * A retry decision: wait `delayMs` before the next attempt.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetryAfter {
  readonly _tag: "RetryAfter"
  readonly delayMs: number
}

/**
 * A retry decision: stop retrying.
 *
 * @category models
 * @since 0.1.0
 */
export interface GiveUp {
  readonly _tag: "GiveUp"
  readonly reason: "nonRetryable" | "exhausted" | "expired"
}

/**
 * The outcome of the engine's retry decision point.
 *
 * @category models
 * @since 0.1.0
 */
export type RetryDecision = RetryAfter | GiveUp

/**
 * Creates a `RetryAfter` decision.
 *
 * @category constructors
 * @since 0.1.0
 */
export const retryAfter = (delayMs: number): RetryDecision => ({
  _tag: "RetryAfter",
  delayMs
})

/**
 * Creates a `GiveUp` decision.
 *
 * @category constructors
 * @since 0.1.0
 */
export const giveUp = (reason: GiveUp["reason"]): RetryDecision => ({
  _tag: "GiveUp",
  reason
})

/**
 * A historical retry sequence crossed its `expirationMs` wall-clock bound.
 * Current dispatch preserves the final declared failure instead of emitting this defect.
 *
 * @category errors
 * @since 0.1.0
 */
export class RetryPolicyExpired extends Schema.TaggedError<RetryPolicyExpired>()(
  "@smthrs/flow/RetryPolicyExpired",
  {
    code: Schema.Literal("retry_policy_expired").pipe(
      Schema.withConstructorDefault(Effect.succeed("retry_policy_expired"))
    ),
    actionName: Schema.String,
    attempt: Schema.Number,
    expirationMs: Schema.Number,
    lastError: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * A historical retry sequence exhausted its `maxAttempts` bound.
 * Current dispatch preserves the final declared failure instead of emitting this defect.
 *
 * @category errors
 * @since 0.1.0
 */
export class RetryAttemptsExhausted extends Schema.TaggedError<RetryAttemptsExhausted>()(
  "@smthrs/flow/RetryAttemptsExhausted",
  {
    code: Schema.Literal("retry_attempts_exhausted").pipe(
      Schema.withConstructorDefault(Effect.succeed("retry_attempts_exhausted"))
    ),
    actionName: Schema.String,
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    lastError: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Computes the delay before attempt `attempt + 1` from the persisted attempt
 * count, mirroring Temporal's `ComputeNextDelay`
 * (`common/backoff/retrypolicy.go`).
 *
 * `attempt` is the 1-based attempt that just failed. Returns `None` when the
 * policy gives up: `maxAttempts` reached, a non-positive computed interval,
 * a cap below the initial interval, or — when the policy declares
 * `expirationMs` and the caller supplies `elapsedMs` — an elapsed duration
 * past the expiration bound. Otherwise the delay is capped to the remaining
 * expiration window, expiring only when that window cannot fit one more
 * full-value (`initialMs`) attempt.
 *
 * Jitter is deterministic-friendly: `options.random` is a `[0, 1]` sample
 * supplied by the caller and defaults to `1`, which leaves the delay at its
 * un-jittered value. Use {@link nextDelayEffect} to sample the `Random`
 * service instead. A sample outside `[0, 1]`, or a persisted `jitterRatio`
 * above one, gives up rather than returning a delay the policy never
 * declared. A sample of zero under `jitterRatio: 1` is a delay of zero, which
 * retries immediately.
 *
 * @category attempts
 * @since 0.1.0
 */
export const nextDelay = (
  policy: RetryPolicy,
  attempt: number,
  options?: {
    readonly random?: number | undefined
    readonly elapsedMs?: number | undefined
  }
): Option.Option<number> => {
  // Persisted policies can be decoded without `make`, so these guards treat a
  // corrupt row as terminal instead of sending an invalid delay to the engine.
  if (validationIssue(policy) !== undefined || !Number.isSafeInteger(attempt) || attempt < 1) {
    return Option.none()
  }
  if (
    options?.elapsedMs !== undefined &&
    (!Number.isFinite(options.elapsedMs) || options.elapsedMs < 0)
  ) {
    return Option.none()
  }
  if (policy.maxAttempts !== undefined && attempt >= policy.maxAttempts) {
    return Option.none()
  }
  if (
    policy.expirationMs !== undefined &&
    options?.elapsedMs !== undefined &&
    options.elapsedMs > policy.expirationMs
  ) {
    return Option.none()
  }
  const raw = policy.initialMs * Math.pow(policy.factor, attempt - 1)
  if (!(raw > 0)) {
    return Option.none()
  }
  let delay = Math.min(raw, policy.maxMs)
  // Temporal caps the delay to the remaining expiration window rather than
  // refusing outright; the below-initial check then expires sequences whose
  // remaining window cannot fit one more full-value attempt.
  if (policy.expirationMs !== undefined && options?.elapsedMs !== undefined) {
    delay = Math.min(delay, Math.max(0, policy.expirationMs - options.elapsedMs))
  }
  if (delay < policy.initialMs) {
    return Option.none()
  }
  // `validationIssue` established finite `maxMs`, so `Math.min` made the
  // un-jittered delay finite even when the exponential itself overflowed.
  // This check belongs before jitter conceptually: a full-jitter sample of
  // zero is a legitimate immediate retry rather than a give-up.
  if (policy.jitterRatio !== undefined && policy.jitterRatio > 0) {
    // Both jitter inputs are bounded to [0, 1] where they are accepted --
    // `make` for `jitterRatio` and this function's contract for `random` --
    // while `random` is a public option that still needs checking here.
    const random = options?.random ?? 1
    if (!(random >= 0 && random <= 1)) {
      return Option.none()
    }
    // In range, the result is between `delay * (1 - jitterRatio)` and `delay`,
    // so it is finite and never negative. A jittered value of zero retries
    // immediately; it does not exhaust the sequence.
    //
    // The two terms do not sum to exactly `delay` at `random: 1`: at
    // `jitterRatio: 0.000002` a delay of 100 rounds up to 100.00000000000001,
    // above the policy's own cap and above the remaining expiration window.
    // Clamping down to the un-jittered delay is what makes the upper bound
    // stated above exact rather than approximate.
    const jittered = delay * (1 - policy.jitterRatio) + random * delay * policy.jitterRatio
    delay = Math.min(delay, jittered)
  }
  return Option.some(delay)
}

/**
 * Computes the next retry delay, sampling the `Random` service for jitter.
 *
 * Deterministic under `Random.withSeed`. Policies without a `jitterRatio`
 * never touch the service.
 *
 * @category attempts
 * @since 0.1.0
 */
export const nextDelayEffect = (
  policy: RetryPolicy,
  attempt: number,
  options?: { readonly elapsedMs?: number | undefined }
): Effect.Effect<Option.Option<number>> =>
  policy.jitterRatio === undefined || policy.jitterRatio <= 0
    ? Effect.sync(() => nextDelay(policy, attempt, { elapsedMs: options?.elapsedMs }))
    : Effect.map(Random.next, (random) => nextDelay(policy, attempt, { random, elapsedMs: options?.elapsedMs }))

/**
 * Extracts the stable identity tag of an error for non-retryable matching:
 * an own string `_tag` when present, otherwise the first own `name` descriptor
 * found while walking a bounded prototype chain. That first descriptor decides
 * the result: only a string data value is a tag.
 *
 * Descriptors keep accessors inert instead of running author code through a
 * property read. A bounded walk also terminates when a hostile proxy reports a
 * cyclic prototype chain; any proxy trap that throws leaves the error untagged.
 *
 * @category attempts
 * @since 0.1.0
 */
export const errorTag = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  try {
    const tag = Object.getOwnPropertyDescriptor(error, "_tag")
    if (tag !== undefined && "value" in tag && typeof tag.value === "string") return tag.value

    let current: object | null = error
    for (let depth = 0; current !== null && depth < 64; depth++) {
      const name = Object.getOwnPropertyDescriptor(current, "name")
      if (name !== undefined) {
        return "value" in name && typeof name.value === "string" ? name.value : undefined
      }
      current = Object.getPrototypeOf(current)
    }
  } catch {
    // Proxies and hostile accessors are untrusted failure payloads. An error
    // that cannot be inspected inertly simply has no stable retry tag.
  }
  return undefined
}

/**
 * Error tags that are non-retryable by type, under every policy (issue #156).
 *
 * These failures are integrity verdicts that must reach the driver without an
 * action-level retry hiding the first detection. Their persistence seams
 * take a quarantine state action before raising them, so a later dispatch can
 * heal, but the detecting dispatch remains a non-retryable failure. No
 * per-callsite or per-policy opt-out exists; the tags are matched by string so
 * the classification does not invert the package dependency direction.
 *
 * `AttemptEvidenceQuarantined` (issue #171) is the succeeded-attempt-row
 * counterpart: the corrupt boundary evidence is removed while the completed
 * outcome stays durable. It reaches the driver unretried, which parks the
 * first detection in the `quarantine` waiting state; the next explicit resume
 * returns the recorded outcome without re-executing the action.
 *
 * @category attempts
 * @since 0.1.0
 */
export const defaultNonRetryable: ReadonlyArray<string> = [
  "@smthrs/engine-store/CacheCorruptionDetected",
  "@smthrs/engine-store/AttemptEvidenceQuarantined"
]

/**
 * Whether an error is classified non-retryable, either by type (see
 * {@link defaultNonRetryable}) or by the policy's declared tag list.
 *
 * @category attempts
 * @since 0.1.0
 */
export const isNonRetryable = (policy: RetryPolicy, error: unknown): boolean => {
  const tag = errorTag(error)
  if (tag === undefined) {
    return false
  }
  if (defaultNonRetryable.includes(tag)) {
    return true
  }
  return policy.nonRetryable !== undefined && policy.nonRetryable.includes(tag)
}

/**
 * The pure core of the engine's single retry decision point.
 *
 * Non-retryable classification is evaluated here and nowhere else. This is
 * the default a pluggable `resolveRetry` resolution falls back to when no
 * plugin claims the decision.
 *
 * @category attempts
 * @since 0.1.0
 */
export const decide = (
  policy: RetryPolicy,
  options: {
    readonly attempt: number
    readonly error: unknown
    readonly random?: number | undefined
    readonly elapsedMs?: number | undefined
  }
): RetryDecision => {
  if (isNonRetryable(policy, options.error)) {
    return giveUp("nonRetryable")
  }
  return Option.match(
    nextDelay(policy, options.attempt, { random: options.random, elapsedMs: options.elapsedMs }),
    {
      onNone: () =>
        // A policy can report `expired` only when it declares an expiration
        // bound and dropping elapsed time would have allowed another attempt.
        // A malformed elapsed value still gives up because the sequence cannot
        // continue without a trustworthy clock reading; without an expiration
        // bound, the public terminal reason for that refusal is `exhausted`.
        policy.expirationMs !== undefined &&
          Option.isSome(nextDelay(policy, options.attempt, { random: options.random }))
          ? giveUp("expired")
          : giveUp("exhausted"),
      onSome: (delay) => {
        // Tool failures may supply a delay instead of using policy backoff.
        // Inspect only an own data property: failure payloads can be untrusted.
        let hint: unknown
        if (typeof options.error === "object" && options.error !== null) {
          try {
            const descriptor = Object.getOwnPropertyDescriptor(options.error, "retryAfterMs")
            if (descriptor !== undefined && "value" in descriptor) hint = descriptor.value
          } catch {
            // An uninspectable failure falls back to the policy delay.
          }
        }
        if (typeof hint !== "number" || !Number.isFinite(hint) || hint < 0) {
          return retryAfter(delay)
        }
        return retryAfter(Math.min(
          hint,
          policy.maxMs,
          policy.expirationMs !== undefined && options.elapsedMs !== undefined
            ? Math.max(0, policy.expirationMs - options.elapsedMs)
            : policy.maxMs
        ))
      }
    }
  )
}

/**
 * Effect form of {@link decide}, sampling the `Random` service for jitter.
 *
 * This is the engine-facing decision function: keep calls to it behind a
 * single decision point so a plugin hook dispatch can later be inserted in
 * front of it without touching call sites.
 *
 * @category attempts
 * @since 0.1.0
 */
export const decideEffect = (
  policy: RetryPolicy,
  options: {
    readonly attempt: number
    readonly error: unknown
    readonly elapsedMs?: number | undefined
  }
): Effect.Effect<RetryDecision> =>
  policy.jitterRatio === undefined || policy.jitterRatio <= 0
    ? Effect.sync(() => decide(policy, options))
    : Effect.map(Random.next, (random) => decide(policy, { ...options, random }))
