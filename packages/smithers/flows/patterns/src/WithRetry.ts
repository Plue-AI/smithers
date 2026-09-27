/**
 * Bounded retry helpers.
 *
 * The declared decorator performs the retry: every attempt the budget allows
 * is a call of the wrapped flow, each attempt but the last is guarded by a
 * `Node.catch` whose failure arm runs the next one, and a declared backoff is a
 * durable `Sleep.action` wait between them. {@link retryEffect} performs the
 * same policy on a hand-written Effect. The ladder IS `@smthrs/flow`
 * `RetryPolicy`'s, so a pattern policy and an engine policy are the same three
 * numbers rather than two spellings of them.
 *
 * @see https://smithers.sh/docs/concepts/retries
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import type * as RetryPolicy from "@smthrs/flow/RetryPolicy"
import * as Sleep from "@smthrs/flow/Sleep"
import * as Node from "@smthrs/plan/Node"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Compose from "./internal/Compose.ts"
import * as Decorate from "./internal/Decorate.ts"
import * as Pattern from "./Pattern.ts"
import { PatternError } from "./PatternError.ts"

/**
 * An un-jittered exponential backoff ladder.
 *
 * The delay before attempt `n + 1` is
 * `min(initialMs * factor^(n - 1), maxMs)`. There is no jitter: a plan built
 * twice must describe the same waits.
 *
 * These are the three ladder fields of `@smthrs/flow` `RetryPolicy`, not a
 * copy of them, so a pattern ladder and the ladder the engine spends are one
 * declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type Backoff = Pick<RetryPolicy.RetryPolicy, "initialMs" | "factor" | "maxMs">

/**
 * Retry declaration options.
 *
 * `attempts` is the TOTAL attempt count, which is `RetryPolicy`'s
 * `maxAttempts`. `nonRetryable` lists error `_tag` values that end the sequence
 * on their first occurrence, whatever the attempt budget says.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly attempts: number
  readonly backoff?: Backoff | undefined
  readonly nonRetryable?: RetryPolicy.RetryPolicy["nonRetryable"]
}

const validate = (options: Options): void => {
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `Retry attempts must be a positive safe integer, received ${options.attempts}`
    })
  }
  const backoff = options.backoff
  if (backoff === undefined) return
  if (!Number.isFinite(backoff.initialMs) || backoff.initialMs <= 0) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `Retry backoff initialMs must be a positive finite number, received ${backoff.initialMs}`
    })
  }
  if (!Number.isFinite(backoff.factor) || backoff.factor < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `Retry backoff factor must be at least 1, received ${backoff.factor}`
    })
  }
  if (!Number.isFinite(backoff.maxMs) || backoff.maxMs < backoff.initialMs) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `Retry backoff maxMs must be at least initialMs, received ${backoff.maxMs}`
    })
  }
}

// Both call sites read `nonRetryable` only after proving it is present, so the
// parameter is the array rather than the options: a `?? []` fallback here would
// be code no caller can reach.
const tags = (nonRetryable: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(nonRetryable)].sort()

// Own fields only: a decorator is applied later than `make`, and a retried
// effect reads its ladder later than `retryEffect`, so neither may read the
// caller's option object or its backoff record again.
const copied = (options: Options): Options => ({
  attempts: options.attempts,
  backoff: options.backoff === undefined ? undefined : {
    initialMs: options.backoff.initialMs,
    factor: options.backoff.factor,
    maxMs: options.backoff.maxMs
  },
  nonRetryable: options.nonRetryable === undefined ? undefined : [...options.nonRetryable]
})

const captures = (options: Options): Readonly<Record<string, unknown>> => ({
  attempts: options.attempts,
  ...(options.backoff === undefined ? {} : {
    backoff: {
      initialMs: options.backoff.initialMs,
      factor: options.backoff.factor,
      maxMs: options.backoff.maxMs
    }
  }),
  ...(options.nonRetryable === undefined ? {} : { nonRetryable: tags(options.nonRetryable) })
})

const label = (options: Options): string => {
  const parts = [`attempts=${options.attempts}`]
  if (options.backoff !== undefined) {
    parts.push(`backoff=${options.backoff.initialMs}x${options.backoff.factor}<=${options.backoff.maxMs}`)
  }
  if (options.nonRetryable !== undefined) parts.push(`nonRetryable=${tags(options.nonRetryable).join("|")}`)
  return parts.join(", ")
}

/** The wait before attempt `attempt + 1`: `min(initialMs * factor^(attempt - 1), maxMs)`. */
const delayMillis = (backoff: Backoff, attempt: number): number =>
  Math.min(backoff.initialMs * backoff.factor ** (attempt - 1), backoff.maxMs)

const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined

const declaration = (inner: Flow.Any, options: Options): Flow.Any => {
  validate(options)
  // Each attempt nests the catch, the non-retryable branch, and the wait.
  const tooDeep = Compose.sequencedBoundRefusal("Retry", "attempts", options.attempts, 3)
  if (tooDeep !== undefined) throw tooDeep
  const envelope = Decorate.envelopeOf(inner)
  const identity = captures(options)
  const fatal = options.nonRetryable === undefined ? undefined : new Set(tags(options.nonRetryable))
  const backoff = options.backoff
  const attempt = (payload: unknown, index: number): Node.Node<unknown, unknown, never> => {
    const call = Decorate.call<never>(inner, payload)
    if (index >= options.attempts) return call
    const next = backoff === undefined
      ? attempt(payload, index + 1)
      : Node.andThen(Sleep.action.call({ millis: delayMillis(backoff, index) }), attempt(payload, index + 1))
    return Node.catch(call, {
      onFailure: Node.capture(
        { ...identity, attempt: index },
        (error: unknown): Node.Node<unknown, unknown, never> =>
          fatal === undefined ? next : Node.branch(Node.succeed(error), {
            // The tag is read off the real failure at run time.
            if: Node.capture(
              { ...identity, attempt: index, fatal: true },
              (failure: unknown) => {
                const tag = tagOf(failure)
                return tag !== undefined && fatal.has(tag)
              }
            ),
            then: (failure) => Node.fail(failure),
            else: () => next
          })
      )
    })
  }
  return Flow.make(`withRetry(${Decorate.displayName(inner)}, ${label(options)})`, {
    ...(inner.description === undefined ? {} : { description: inner.description }),
    payload: inner.payloadSchema,
    success: inner.successSchema,
    error: inner.errorSchema,
    capabilities: Decorate.capabilitiesOf(inner),
    ...(envelope === undefined ? {} : { effects: envelope }),
    body: Node.capture(identity, (payload: unknown) => attempt(payload, 1))
  })
}

/**
 * Builds a bounded retry decorator.
 *
 * The returned declaration calls the wrapped flow once per attempt the budget
 * allows. Every attempt but the last is a `Node.catch`, so a typed failure
 * runs the next attempt and a success settles without running the rest; a
 * failure whose `_tag` is listed in `nonRetryable` is re-raised at once.
 * A declared `backoff` is a durable `Sleep.action` wait between attempts, so a
 * host executing a backoff retry provides `Sleep.layer`. Fiber interruption is
 * not a typed failure and is never retried.
 *
 * `make` snapshots the options at the call, so a later edit to the caller's
 * object does not change the decorator it returned.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Pattern.Decorator => {
  const snapshot = copied(options)
  return (inner) => declaration(inner, snapshot)
}

/**
 * Wraps a flow in a declaration-identifiable retry decorator.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withRetry = (inner: Flow.Any, options: Options): Flow.Any => Pattern.decorate(inner, make(options))

const ladder = (backoff: Backoff): Schedule.Schedule<Duration.Duration> =>
  Schedule.modifyDelay(
    Schedule.exponential(Duration.millis(backoff.initialMs), backoff.factor),
    ({ duration }) => Effect.succeed(Duration.millis(Math.min(Duration.toMillis(duration), backoff.maxMs)))
  )

/**
 * Retries typed Effect failures up to the declared total attempt count,
 * waiting the declared backoff between attempts and stopping immediately on a
 * non-retryable tag.
 *
 * Effect schedules never recover fiber interruption, so cancellation
 * propagates without consuming or elaborating another attempt.
 *
 * @category combinators
 * @since 0.1.0
 */
export const retryEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  caller: Options
): Effect.Effect<A, E, R> => {
  const options = copied(caller)
  validate(options)
  const retryable = options.nonRetryable === undefined
    ? undefined
    : new Set(tags(options.nonRetryable))
  if (options.attempts === 1) return effect
  return Effect.retry(effect, {
    times: options.attempts - 1,
    ...(options.backoff === undefined ? {} : { schedule: ladder(options.backoff) }),
    ...(retryable === undefined ? {} : {
      while: (error: E) => {
        const tag = tagOf(error)
        return tag === undefined || !retryable.has(tag)
      }
    })
  })
}
