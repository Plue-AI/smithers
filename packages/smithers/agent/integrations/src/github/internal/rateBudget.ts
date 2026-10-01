/**
 * GitHub's request budget as pure decisions over one {@link State}.
 *
 * The GitHub proxy keeps one state per principal and is the only process
 * that calls GitHub for it, so no decision here needs a lock: each is a pure
 * function of the state, the current instant, and the {@link Limits}.
 *
 * The limits are GitHub's, from "Rate limits for the REST API" and "Best
 * practices for using the REST API" on docs.github.com:
 *
 * - primary: a per-resource hourly budget reported in `x-ratelimit-*`;
 * - no more than 100 concurrent requests;
 * - at least one second between `POST`, `PATCH`, `PUT`, and `DELETE` requests;
 * - no more than 80 content-generating requests per minute and 500 per hour;
 * - on a limit: wait `retry-after` seconds; with `x-ratelimit-remaining: 0`,
 *   wait for `x-ratelimit-reset`; otherwise wait at least a minute, growing
 *   exponentially while the limit persists.
 *
 * @since 1.0.0
 */

/**
 * The limits one principal's traffic obeys.
 *
 * @since 1.0.0
 * @private
 */
export interface Limits {
  /** Requests in flight at once. GitHub's ceiling is 100. */
  readonly maxConcurrent: number
  /** Least time between the starts of two writes. GitHub asks for 1 s. */
  readonly writeSpacingMs: number
  /** Writes started in any 60 s. GitHub allows 80 content-generating requests. */
  readonly writesPerMinute: number
  /** Writes started in any hour. GitHub allows 500 content-generating requests. */
  readonly writesPerHour: number
  /** Shortest pause after a limit response that names no wait. GitHub asks for one minute. */
  readonly minPauseMs: number
  /** Longest pause any header can impose, so a skewed or hostile reset cannot park callers for days. */
  readonly maxPauseMs: number
}

/**
 * GitHub's documented limits. `maxConcurrent` is half of GitHub's 100 so that
 * traffic outside the proxy on the same credential (an interactive `gh`,
 * `git`) keeps headroom. Every write counts as content-generating, because
 * GitHub does not publish which endpoints are.
 *
 * @since 1.0.0
 * @private
 */
export const DEFAULT_LIMITS: Limits = {
  maxConcurrent: 50,
  writeSpacingMs: 1_000,
  writesPerMinute: 80,
  writesPerHour: 500,
  minPauseMs: 60_000,
  maxPauseMs: 3_600_000
}

/**
 * The environment variable that overrides each limit.
 *
 * @since 1.0.0
 * @private
 */
export const LIMIT_VARIABLES: Readonly<Record<keyof Limits, string>> = {
  maxConcurrent: "SMITHERS_GITHUB_MAX_CONCURRENT",
  writeSpacingMs: "SMITHERS_GITHUB_WRITE_SPACING_MS",
  writesPerMinute: "SMITHERS_GITHUB_WRITES_PER_MINUTE",
  writesPerHour: "SMITHERS_GITHUB_WRITES_PER_HOUR",
  minPauseMs: "SMITHERS_GITHUB_MIN_PAUSE_MS",
  maxPauseMs: "SMITHERS_GITHUB_MAX_PAUSE_MS"
}

const MINIMUM: Readonly<Record<keyof Limits, number>> = {
  maxConcurrent: 1,
  writeSpacingMs: 0,
  writesPerMinute: 1,
  writesPerHour: 1,
  minPauseMs: 0,
  maxPauseMs: 0
}

/**
 * Explicit values, then the environment, then {@link DEFAULT_LIMITS}. Throws
 * an `Error` naming the first value that is not an integer at or above its
 * minimum, because a typo that silently disabled a limit is the failure this
 * module exists to prevent.
 *
 * @since 1.0.0
 * @private
 */
export const resolveLimits = (
  explicit: Partial<Limits> = {},
  env: Readonly<Record<string, string | undefined>> = {}
): Limits => {
  const resolved: Record<string, number> = {}
  for (const name of Object.keys(DEFAULT_LIMITS) as Array<keyof Limits>) {
    const variable = LIMIT_VARIABLES[name]
    const raw = env[variable]
    const value = explicit[name] ?? (raw === undefined || raw.trim() === "" ? DEFAULT_LIMITS[name] : Number(raw))
    if (!Number.isSafeInteger(value) || value < MINIMUM[name]) {
      throw new Error(
        `GitHub rate limit ${name} (${variable}) must be an integer >= ${MINIMUM[name]}, got ${String(value)}`
      )
    }
    resolved[name] = value
  }
  return resolved as unknown as Limits
}

/**
 * One primary budget, as the latest response in its window reported it.
 *
 * @since 1.0.0
 * @private
 */
export interface Budget {
  readonly limit: number
  readonly remaining: number
  /** Epoch milliseconds when the window resets. */
  readonly resetAt: number
}

/**
 * Everything the proxy knows about one principal's budget.
 *
 * @since 1.0.0
 * @private
 */
export interface State {
  /** No request may start before this instant: a limit response paused every caller. */
  readonly pausedUntil: number
  /** The pause after a limit that names no wait: doubled by every limit response, cleared by a success. */
  readonly backoffMs: number
  /** Primary budgets by `x-ratelimit-resource`. */
  readonly budgets: Readonly<Record<string, Budget>>
  /** Start instants of the writes booked in the last hour, ascending. */
  readonly writes: ReadonlyArray<number>
}

/**
 * The state of a principal that has made no request yet.
 *
 * @since 1.0.0
 * @private
 */
export const emptyState: State = { pausedUntil: 0, backoffMs: 0, budgets: {}, writes: [] }

const HOUR = 3_600_000
const MINUTE = 60_000

/**
 * Whether GitHub counts `method` as a mutation.
 *
 * @since 1.0.0
 * @private
 */
export const isWrite = (method: string): boolean => !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())

/**
 * The primary budget a request to `path` spends, before its response names it.
 *
 * @since 1.0.0
 * @private
 */
export const resourceOf = (path: string): string => {
  const pathname = (/^https?:/.test(path) ? new URL(path).pathname : path).replace(/\?.*$/, "")
  if (/(^|\/)graphql$/.test(pathname)) return "graphql"
  if (/(^|\/)search\/code(\/|$)/.test(pathname)) return "code_search"
  if (/(^|\/)search\//.test(pathname)) return "search"
  return "core"
}

/**
 * Books the start instants of `count` writes, ascending, honoring the pause,
 * the spacing, and both windows. A caller that will not wait for the last
 * slot drops the returned state, so the booking is all or none.
 *
 * @since 1.0.0
 * @private
 */
export const reserveWrites = (
  state: State,
  now: number,
  count: number,
  limits: Limits
): { readonly state: State; readonly slots: ReadonlyArray<number> } => {
  const booked = state.writes.filter((at) => at > now - HOUR)
  const slots: Array<number> = []
  for (let i = 0; i < count; i++) {
    const all = [...booked, ...slots]
    const last = all.at(-1)
    let at = Math.max(now, state.pausedUntil, last === undefined ? now : last + limits.writeSpacingMs)
    if (all.length >= limits.writesPerMinute) at = Math.max(at, all[all.length - limits.writesPerMinute]! + MINUTE)
    if (all.length >= limits.writesPerHour) at = Math.max(at, all[all.length - limits.writesPerHour]! + HOUR)
    slots.push(at)
  }
  return { state: { ...state, writes: [...booked, ...slots] }, slots }
}

/**
 * Why a request may not start yet.
 *
 * @since 1.0.0
 * @private
 */
export type WaitReason = "paused" | "budget"

/**
 * {@link begin}'s answer: started, or the instant to look again.
 *
 * @since 1.0.0
 * @private
 */
export type Admission =
  | { readonly admitted: true; readonly state: State }
  | { readonly admitted: false; readonly until: number; readonly reason: WaitReason }

/**
 * The current window of `resource`'s budget, or undefined once it reset.
 *
 * @since 1.0.0
 * @private
 */
export const currentBudget = (state: State, now: number, resource: string): Budget | undefined => {
  const budget = state.budgets[resource]
  return budget !== undefined && budget.resetAt > now ? budget : undefined
}

/**
 * Starts a request on `resource` when the pause and the primary budget allow
 * it, spending one unit of the modeled budget so concurrent requests do not
 * all spend the last one.
 *
 * @since 1.0.0
 * @private
 */
export const begin = (state: State, now: number, resource: string): Admission => {
  if (state.pausedUntil > now) return { admitted: false, until: state.pausedUntil, reason: "paused" }
  const budget = currentBudget(state, now, resource)
  if (budget === undefined) return { admitted: true, state }
  if (budget.remaining <= 0) return { admitted: false, until: budget.resetAt, reason: "budget" }
  return {
    admitted: true,
    state: { ...state, budgets: { ...state.budgets, [resource]: { ...budget, remaining: budget.remaining - 1 } } }
  }
}

/**
 * Reads one response header by lower-case name.
 *
 * @since 1.0.0
 * @private
 */
export type HeaderLookup = (name: string) => string | null | undefined

/**
 * What one finished request tells the budget.
 *
 * @since 1.0.0
 * @private
 */
export interface Outcome {
  /** The resource the request was admitted on; `x-ratelimit-resource` overrides it. */
  readonly resource: string
  /** Absent when no response arrived: a transport failure or an interrupt. */
  readonly headers?: HeaderLookup | undefined
  /** GitHub refused the request for rate limiting. */
  readonly limited: boolean
}

const numeric = (headers: HeaderLookup | undefined, name: string): number | undefined => {
  const raw = headers?.(name)
  if (raw === null || raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Folds a finished request into the state: its `x-ratelimit-*` headers into
 * the budget, and on a limit response a pause for every caller. `pause` is
 * set when this outcome moved the pause later.
 *
 * @since 1.0.0
 * @private
 */
export const finish = (
  state: State,
  now: number,
  outcome: Outcome,
  limits: Limits
): { readonly state: State; readonly pause?: { readonly until: number; readonly cause: string } } => {
  const headers = outcome.headers
  const resource = headers?.("x-ratelimit-resource") ?? outcome.resource
  const limit = numeric(headers, "x-ratelimit-limit")
  const remaining = numeric(headers, "x-ratelimit-remaining")
  const resetSeconds = numeric(headers, "x-ratelimit-reset")
  const resetAt = resetSeconds === undefined ? undefined : Math.min(resetSeconds * 1000, now + limits.maxPauseMs)
  let budgets = state.budgets
  if (limit !== undefined && remaining !== undefined && resetAt !== undefined && resetAt > now) {
    const previous = currentBudget(state, now, resource)
    // A response from an earlier window arrives late; it says nothing about this one.
    if (previous === undefined || previous.resetAt <= resetAt) {
      const sameWindow = previous !== undefined && previous.resetAt === resetAt
      budgets = {
        ...budgets,
        [resource]: { limit, resetAt, remaining: sameWindow ? Math.min(previous.remaining, remaining) : remaining }
      }
    }
  }
  const settled: State = { ...state, budgets }
  if (!outcome.limited) return { state: settled.backoffMs === 0 ? settled : { ...settled, backoffMs: 0 } }
  const retryAfter = numeric(headers, "retry-after")
  // Every limit response doubles the backoff, so a limit that persists waits
  // longer even while GitHub names each wait; a success clears it.
  const backoffMs = Math.min(Math.max(state.backoffMs * 2, limits.minPauseMs), limits.maxPauseMs)
  let until: number
  let cause: string
  if (retryAfter !== undefined) {
    until = now + retryAfter * 1000
    cause = `retry-after ${retryAfter}s`
  } else if (remaining === 0 && resetAt !== undefined) {
    until = resetAt
    cause = `${resource} budget exhausted until x-ratelimit-reset`
  } else {
    until = now + backoffMs
    cause = `secondary rate limit, backoff ${backoffMs} ms`
  }
  until = Math.min(until, now + limits.maxPauseMs)
  const pausedUntil = Math.max(state.pausedUntil, until)
  const next: State = { ...settled, backoffMs, pausedUntil }
  return pausedUntil > state.pausedUntil ? { state: next, pause: { until: pausedUntil, cause } } : { state: next }
}

/**
 * The earliest instant `writes` more writes, and a read on `resource` after
 * them, could start, without booking anything.
 *
 * @since 1.0.0
 * @private
 */
export const earliestStart = (
  state: State,
  now: number,
  writes: number,
  resource: string,
  limits: Limits
): number => {
  const last = reserveWrites(state, now, writes, limits).slots.at(-1) ?? now
  const budget = currentBudget(state, now, resource)
  return Math.max(last, state.pausedUntil, budget !== undefined && budget.remaining <= 0 ? budget.resetAt : now)
}
