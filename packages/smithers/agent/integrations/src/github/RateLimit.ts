/**
 * The rate limiter the GitHub proxy runs for each principal.
 *
 * GitHub's limits belong to a principal (a user or an App installation), not
 * to a process. The proxy is the one process on a machine that calls GitHub
 * for that principal, so one limiter in it sees every request: 32 agents, a
 * flow host, and `scripts/issue-claim.mjs` spend one budget. Before each
 * request the limiter waits for, in order:
 *
 * - for a `POST`, `PATCH`, `PUT`, or `DELETE`, a write slot: at least 1 s after
 *   the previous write, at most 80 a minute and 500 an hour;
 * - a concurrency permit: at most 50 requests in flight;
 * - the pause a limit response imposed on every caller;
 * - the primary budget of the request's resource, modeled from the
 *   `x-ratelimit-*` headers of every response and spent by every start.
 *
 * A 403 or 429 limit response pauses every caller: until `retry-after`, until
 * `x-ratelimit-reset` when the budget is spent, or for at least a minute,
 * doubling while limits persist. A wait longer than `maxWait` fails at once
 * with reason `rate-limited` and the instant to retry in `details.retryAt`,
 * so a caller sleeps durably instead of holding a connection for an hour.
 *
 * @since 1.0.0
 */

import { Clock, Duration, Effect, Metric, Ref, Semaphore } from "effect"
import type { Exit } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import * as Budget from "./internal/rateBudget.ts"

/**
 * The limits one principal's traffic obeys.
 *
 * @category models
 * @since 1.0.0
 */
export type Limits = Budget.Limits

/**
 * GitHub's documented limits: 50 concurrent requests (half of GitHub's 100),
 * 1 s between writes, 80 writes a minute, 500 an hour, and a one-minute
 * minimum pause after a limit response that names no wait.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_LIMITS: Limits = Budget.DEFAULT_LIMITS

/**
 * The longest a request waits for the budget before failing `rate-limited`.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_MAX_WAIT: Duration.Duration = Duration.minutes(1)

/**
 * Explicit limits, then the `SMITHERS_GITHUB_*` variables in `env`, then
 * {@link DEFAULT_LIMITS}. Throws an `Error` for a value that is not an
 * integer at or above its minimum.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolveLimits: (
  explicit?: Partial<Limits>,
  env?: Readonly<Record<string, string | undefined>>
) => Limits = Budget.resolveLimits

/**
 * What one finished attempt tells the limiter.
 *
 * @category models
 * @since 1.0.0
 */
export interface Observation {
  /** Response headers; absent when no response arrived. */
  readonly headers?: Headers | undefined
  /** GitHub refused the request for rate limiting. */
  readonly limited: boolean
}

/**
 * One principal's limiter.
 *
 * @category models
 * @since 1.0.0
 */
export interface RateLimiter {
  /**
   * Runs `attempt` once the budget allows a `method` request to `path`, then
   * records what `observe` reads from its exit. Fails `rate-limited` without
   * running `attempt` when the wait would exceed `maxWait`.
   */
  readonly limit: <A, E, R>(
    method: string,
    path: string,
    attempt: Effect.Effect<A, E, R>,
    observe: (exit: Exit.Exit<A, E>) => Observation
  ) => Effect.Effect<A, E | IntegrationError, R>
  /**
   * The earliest instant, in epoch milliseconds, that `writes` writes and a
   * read on `path` after them could start. Books nothing: a caller about to
   * make several writes asks first, so it starts all of them or none.
   */
  readonly earliestStart: (writes: number, path: string) => Effect.Effect<number>
}

/**
 * Counts every wait the limiter imposed, by reason: `spacing`, `paused`, or
 * `budget`.
 *
 * @category metrics
 * @since 1.0.0
 */
export const waits = Metric.counter("smithers_github_rate_limit_waits", {
  description: "Requests that waited for the GitHub budget, by reason",
  incremental: true
})

/**
 * Counts the limit responses that paused every caller.
 *
 * @category metrics
 * @since 1.0.0
 */
export const pauses = Metric.counter("smithers_github_rate_limit_pauses", {
  description: "GitHub limit responses that paused every caller",
  incremental: true
})

/**
 * The failure for a request the limiter will not wait for.
 *
 * @category constructors
 * @since 1.0.0
 */
export const rateLimited = (retryAt: number, reason: string, method: string, path: string): IntegrationError =>
  new IntegrationError(
    "rate-limited",
    `GitHub ${method} ${path} would wait for the rate limit (${reason}) until ${
      new Date(retryAt).toISOString()
    }, longer than maxWait.`,
    { method, path, reason, retryAt: new Date(retryAt).toISOString(), retryable: false, rateLimited: true }
  )

/**
 * A limiter with its own state.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: {
  readonly limits?: Limits | undefined
  readonly maxWait?: Duration.Duration | undefined
} = {}): Effect.Effect<RateLimiter> =>
  Effect.gen(function*() {
    const limits = options.limits ?? DEFAULT_LIMITS
    const maxWaitMs = Duration.toMillis(options.maxWait ?? DEFAULT_MAX_WAIT)
    const state = yield* Ref.make(Budget.emptyState)
    const permits = yield* Semaphore.make(limits.maxConcurrent)
    const counted = (reason: string) => Metric.update(Metric.withAttributes(waits, { reason }), 1)

    const limit: RateLimiter["limit"] = (method, path, attempt, observe) =>
      Effect.gen(function*() {
        const start = yield* Clock.currentTimeMillis
        const deadline = start + maxWaitMs
        const resource = Budget.resourceOf(path)

        if (Budget.isWrite(method)) {
          const slot = yield* Ref.modify(state, (current) => {
            const booked = Budget.reserveWrites(current, start, 1, limits)
            const at = booked.slots[0]!
            return at > deadline ? [at, current] : [at, booked.state]
          })
          if (slot > deadline) return yield* rateLimited(slot, "write spacing", method, path)
          if (slot > start) {
            yield* counted("spacing")
            yield* Effect.sleep(Duration.millis(slot - start))
          }
        }

        return yield* Semaphore.withPermits(permits, 1)(Effect.gen(function*() {
          for (;;) {
            const now = yield* Clock.currentTimeMillis
            const admission = yield* Ref.modify(state, (current) => {
              const decided = Budget.begin(current, now, resource)
              return [decided, decided.admitted ? decided.state : current]
            })
            if (admission.admitted) break
            if (admission.until > deadline) {
              return yield* rateLimited(admission.until, admission.reason, method, path)
            }
            yield* counted(admission.reason)
            yield* Effect.logWarning("GitHub rate limit: waiting for the budget").pipe(
              Effect.annotateLogs({
                reason: admission.reason,
                resource,
                until: new Date(admission.until).toISOString(),
                method,
                path
              })
            )
            yield* Effect.sleep(Duration.millis(admission.until - now))
          }
          return yield* attempt.pipe(Effect.onExit((exit) =>
            Effect.gen(function*() {
              const observed = observe(exit)
              const now = yield* Clock.currentTimeMillis
              const headers = observed.headers
              const pause = yield* Ref.modify(state, (current) => {
                const settled = Budget.finish(current, now, {
                  resource,
                  headers: headers === undefined ? undefined : (name) => headers.get(name),
                  limited: observed.limited
                }, limits)
                return [settled.pause, settled.state]
              })
              if (pause === undefined) return
              yield* Metric.update(pauses, 1)
              yield* Effect.logWarning("GitHub rate limit: pausing every caller").pipe(
                Effect.annotateLogs({ cause: pause.cause, until: new Date(pause.until).toISOString(), method, path })
              )
            })
          ))
        }))
      })

    const earliestStart: RateLimiter["earliestStart"] = (writes, path) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.map(
          Ref.get(state),
          (current) => Budget.earliestStart(current, now, writes, Budget.resourceOf(path), limits)
        ))

    return { limit, earliestStart }
  })
