/**
 * Quota-aware waits: turning a provider's refusal into a deadline the run waits
 * out, rather than a failure that ends it.
 *
 * A `rate_limited` or `quota_exceeded` answer is not a defect report. It is the
 * provider telling the caller when to come back, and the difference matters to
 * every long run: a step that fails on a refusal loses everything the run had
 * done, while a step that waits keeps it and costs the operator nothing but
 * clock. Old smithers made that distinction with `classifyQuotaError` and a
 * `waiting-quota` park, and excluded a parked attempt from the retry budget on
 * the grounds that waiting for a window is not a failed attempt.
 *
 * This module is the classification half. It answers one question — "is this
 * refusal a wait, and until when?" — and nothing else: the park itself belongs
 * to `AgentAction`, which is the only place that knows it is inside a flow with
 * a durable clock to sleep on.
 *
 * Three things decide the deadline, in order of how much the provider actually
 * said:
 *
 * 1. `resetAtEpochMillis`, the instant the provider named;
 * 2. `retryAfterMillis`, the delay it named;
 * 3. a delay parsed out of the message text, for the providers that put it
 *    only there;
 * 4. and {@link Config.defaultWaitMillis}, when the refusal names nothing.
 *
 * {@link Config.maxWaitMillis} is the ceiling. Above it the classifier answers
 * `None` and the original `ModelError` propagates, because a run that parks for
 * a day is indistinguishable from a run that hung, and an operator who wants
 * that wait can declare it.
 *
 * The service is injected rather than assumed. A composition that wants every
 * refusal to stay a failure must say so explicitly with
 * {@link layerUnclassified}; omitting the decision is a type error.
 *
 * @since 0.1.0
 */

import { HarnessError } from "@smthrs/harness/HarnessError"
import { ModelError } from "@smthrs/model/ModelError"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * Where a park's deadline came from.
 *
 * Journaled with the park, because the four sources are worth very different
 * amounts of trust: `reset` and `retry-after` are the provider's own numbers,
 * `text` is this module reading prose, and `default` is a guess bounded by
 * configuration. An operator reading a run that waited an hour needs to know
 * which one it was.
 *
 * @category models
 * @since 0.1.0
 */
export const ParkSource = Schema.Literals(["reset", "retry-after", "text", "default"])

/**
 * Where a park's deadline came from.
 *
 * @category models
 * @since 0.1.0
 */
export type ParkSource = typeof ParkSource.Type

/**
 * One classified refusal: when to ask again, and on whose authority.
 *
 * It is a schema and not just an interface because the decision is RECORDED: a
 * park is computed from the wall clock, and a replayed body must wait out the
 * deadline the first pass chose rather than compute a new one from the instant
 * the replay happens to run at.
 *
 * @category models
 * @since 0.1.0
 */
export const Park = Schema.Struct({
  /** The absolute epoch instant the run may ask again. */
  wakeAt: Schema.Number,
  source: ParkSource
})

/**
 * One classified refusal.
 *
 * @category models
 * @since 0.1.0
 */
export type Park = typeof Park.Type

/**
 * Decides whether a failure is a quota wait.
 *
 * `now` is passed in rather than read: the classifier is pure, so a caller
 * inside a flow takes the instant from the injected clock and a test states it
 * outright.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly classify: (error: unknown, nowMillis: number) => Option.Option<Park>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class QuotaClassifier extends Context.Service<QuotaClassifier, Service>()(
  "@smthrs/agent/QuotaPolicy/QuotaClassifier"
) {}

/**
 * How long a refusal that names no deadline parks for.
 *
 * A minute: long enough that a run is not re-asking into a window that is
 * still closed, short enough that a wrong guess costs a minute.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultWaitMillis = 60_000

/**
 * The longest wait a refusal may buy before it stays a failure.
 *
 * An hour. Above it the answer is not "wait" but "this run cannot proceed
 * today", and that is a decision for whoever is watching the run rather than
 * for the step.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxWaitMillis = 3_600_000

/**
 * What a composition may change about the default classification.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config {
  readonly defaultWaitMillis?: number | undefined
  readonly maxWaitMillis?: number | undefined
}

/**
 * Builds a classifier from an implementation of its one method.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => QuotaClassifier.of(implementation)

/**
 * A classifier that classifies nothing, so every refusal stays a failure.
 *
 * This is an explicit safety-policy decision, not a default. It gives up
 * durable quota parking: provider refusals fail the run immediately. The
 * recorder's independent capacity-refusal floor still prevents those failures
 * from becoming durable values.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeUnclassified = (): Service => make({ classify: () => Option.none() })

/**
 * Explicitly provides {@link makeUnclassified}.
 *
 * This gives up durable quota parking. It does not permit quota or overload
 * failures to enter the sealed step cache.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerUnclassified = (): Layer.Layer<QuotaClassifier> => Layer.succeed(QuotaClassifier)(makeUnclassified())

/**
 * The delays a provider spells out in prose rather than in a field.
 *
 * Ported from the old CLI-agent classifier, which had to read text because a
 * subprocess adapter never sees a header. Each pattern captures one number;
 * unit-bearing forms bind one explicit unit, while the final bare form owns
 * the HTTP `Retry-After` seconds value. Anything else is left to
 * {@link Config.defaultWaitMillis}, since a misread number is a worse wait than
 * an honest guess.
 *
 * The bare form's trailing lookahead has to refuse a DIGIT as well as a
 * letter. A lookahead that only forbids the unit word is satisfied by a
 * shorter capture, and the engine will shorten one to make it pass: against
 * `Retry-After: 120ms` a `(?!\s*[a-z])` tail backtracked the capture to `12`
 * and parked for twelve seconds, and `Retry after 12 days` parked for one.
 * Both are exactly the misread this comment says the module refuses to make.
 * The dot is refused only when a digit follows it, so a truncated `1` out of
 * `1.5ms` cannot pass while a sentence-ending `Retry-After: 3.` still reads
 * as three seconds. Horizontal whitespace, not `\s`, separates the number
 * from a unit word: a unit sits on the number's own line, so `Retry-After: 30`
 * followed by a new line of prose keeps its thirty seconds.
 */
const textualDelays: ReadonlyArray<{ readonly pattern: RegExp; readonly unitMillis: number }> = [
  { pattern: /(?:try|retry)\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i, unitMillis: 1_000 },
  { pattern: /(?:try|retry)\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i, unitMillis: 60_000 },
  { pattern: /(?:try|retry)\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i, unitMillis: 3_600_000 },
  { pattern: /retry[- ]after[:=]?\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i, unitMillis: 1_000 },
  { pattern: /retry[- ]after[:=]?\s*(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i, unitMillis: 60_000 },
  { pattern: /retry[- ]after[:=]?\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i, unitMillis: 3_600_000 },
  { pattern: /retry[- ]after[:=]?\s*(\d+(?:\.\d+)?)(?!\d|\.\d|[^\S\r\n]*[a-z])/i, unitMillis: 1_000 },
  { pattern: /resets?\s+in\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i, unitMillis: 1_000 },
  { pattern: /resets?\s+in\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i, unitMillis: 60_000 },
  { pattern: /resets?\s+in\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i, unitMillis: 3_600_000 }
]

/**
 * The delay a refusal's message names, in milliseconds.
 *
 * `undefined` means the text named none, which is not the same as naming zero:
 * a caller falls back to its configured default rather than asking again
 * immediately.
 *
 * @category classification
 * @since 0.1.0
 */
export const parseDelay = (message: string): number | undefined => {
  for (const { pattern, unitMillis } of textualDelays) {
    const match = pattern.exec(message)
    // Every pattern captures `\d+(\.\d+)?`, so a match is always a finite,
    // non-negative number and needs no second validation.
    if (match !== null) return Math.round(Number(match[1]) * unitMillis)
  }
  return undefined
}

/**
 * The quota-shaped codes. HTTP 429 and 529 are included on its own, because an
 * adapter that could not read a provider's code still read the status.
 */
const quotaCodes: ReadonlySet<string> = new Set(["rate_limited", "quota_exceeded"])

const isQuotaRefusal = (error: ModelError): boolean =>
  quotaCodes.has(error.code) || error.httpStatus === 429 || error.httpStatus === 529

/**
 * The codes that describe the request or the account rather than a window.
 *
 * A bad key does not become a good key by waiting, a model that does not exist
 * does not appear, and a refused prompt is not refused because the provider was
 * busy. Retrying one of these is pure latency charged to the person watching
 * the run, so the classifier answers `None` and the typed `ModelError` reaches
 * the run card with the provider's own message.
 *
 * @category classification
 * @since 0.1.0
 */
const terminalCodes: ReadonlySet<string> = new Set([
  "authentication",
  "invalid_request",
  "no_route",
  "content_policy",
  "context_overflow",
  "out_of_credit",
  "invalid_provider_output"
])

/**
 * Statuses that are terminal whatever the provider's code says.
 *
 * `402` is the one that matters: payment required means the account has no
 * balance, and a balance is restored by a person, not by a timer.
 */
const terminalStatuses: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 405, 409, 410, 413, 422])

/**
 * Whether a refusal can never be waited out.
 *
 * Exhausted credit is the case this exists for. `quota_exceeded` covers both an
 * account that has run out of money and a subscription window that has closed,
 * and the two are told apart by whether the provider named a deadline: a window
 * that reopens says when (`resetAtEpochMillis` or `retryAfterMillis`), and an
 * empty balance says nothing because there is nothing to say. A run that parked
 * eight times at the default minute on `credit_balance_exhausted` — "You have no
 * credits remaining" — spent eight minutes to reach the failure it had in hand
 * at the first attempt.
 * An explicit model scope rules out account balance exhaustion and permits
 * the bounded default cooldown even when that model's reset is unknown.
 *
 * @param error the normalized provider failure
 * @since 0.1.0
 * @category classification
 */
export const isTerminalRefusal = (error: ModelError): boolean => {
  if (error.httpStatus !== undefined && terminalStatuses.has(error.httpStatus)) return true
  if (terminalCodes.has(error.code)) return true
  if (error.code !== "quota_exceeded" || error.quotaScope === "model") return false
  return error.resetAtEpochMillis === undefined && error.retryAfterMillis === undefined
}

/**
 * The `ModelError` a failure is, or wraps.
 *
 * A refusal reaches a model-backed step already wrapped: the cell controller
 * turns anything that is not a `HarnessError` into one with the original in
 * `cause`, so the classification has to look through that layer. It walks the
 * `cause` chain rather than checking one level, and it accepts a plain object
 * with the right shape as well as a class instance, because a failure that has
 * been through a journal round trip is decoded, not reconstructed.
 *
 * @category classification
 * @since 0.1.0
 */
export const modelErrorOf = (error: unknown): Option.Option<ModelError> => {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    if (current instanceof ModelError) return Option.some(current)
    const candidate = current as {
      readonly _tag?: unknown
      readonly code?: unknown
      readonly message?: unknown
      readonly retryAfterMillis?: unknown
      readonly resetAtEpochMillis?: unknown
      readonly httpStatus?: unknown
      readonly quotaScope?: unknown
      readonly cause?: unknown
    }
    if (candidate._tag === "flows/model/ModelError" && typeof candidate.code === "string") {
      return Option.some(
        new ModelError({
          code: candidate.code as ModelError["code"],
          message: typeof candidate.message === "string" ? candidate.message : "",
          ...(typeof candidate.retryAfterMillis === "number"
            ? { retryAfterMillis: candidate.retryAfterMillis }
            : {}),
          ...(typeof candidate.resetAtEpochMillis === "number"
            ? { resetAtEpochMillis: candidate.resetAtEpochMillis }
            : {}),
          ...(typeof candidate.httpStatus === "number" ? { httpStatus: candidate.httpStatus } : {}),
          ...(candidate.quotaScope === "model" || candidate.quotaScope === "account"
            ? { quotaScope: candidate.quotaScope }
            : {})
        })
      )
    }
    current = current instanceof HarnessError ? current.cause : candidate.cause
  }
  return Option.none()
}

/**
 * The production classifier.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeDefault = (config: Config = {}): Service => {
  const fallback = config.defaultWaitMillis ?? defaultWaitMillis
  const ceiling = config.maxWaitMillis ?? maxWaitMillis
  return make({
    classify: (error, nowMillis) => {
      const model = modelErrorOf(error)
      if (Option.isNone(model) || !isQuotaRefusal(model.value)) return Option.none()
      const refusal = model.value
      // An exhausted balance, a bad key, or a request the provider will refuse
      // again is not a window. It fails on the attempt that earned it.
      if (isTerminalRefusal(refusal)) return Option.none()
      const park: Park = refusal.resetAtEpochMillis !== undefined
        ? { wakeAt: refusal.resetAtEpochMillis, source: "reset" }
        : refusal.retryAfterMillis !== undefined
        ? { wakeAt: nowMillis + refusal.retryAfterMillis, source: "retry-after" }
        : ((): Park => {
          const parsed = parseDelay(refusal.message)
          return parsed === undefined
            ? { wakeAt: nowMillis + fallback, source: "default" }
            : { wakeAt: nowMillis + parsed, source: "text" }
        })()
      // A deadline already past is a park of zero, not a refusal to park: the
      // provider said the window has reopened.
      const wait = Math.max(0, park.wakeAt - nowMillis)
      return wait > ceiling ? Option.none() : Option.some(park)
    }
  })
}

/**
 * Provides {@link makeDefault}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerDefault = (config: Config = {}): Layer.Layer<QuotaClassifier> =>
  Layer.succeed(QuotaClassifier)(makeDefault(config))

/**
 * The journal event one park writes.
 *
 * @category records
 * @since 0.1.0
 */
export const quotaParkedEvent = "flows.agent.quota-parked.v1"

/**
 * The most times one step parks before its refusal is reported.
 *
 * A window that has reopened and closed again eight times over one step is not
 * a window this run is going to get through, and an unbounded park loop is a
 * run that never ends. The bound is per ask, so a step that parks, answers, and
 * is corrected starts again from zero.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultMaxParks = 8

/**
 * Reads the classifier a composition explicitly provided.
 *
 * There is deliberately no fallback. Every production composition must choose
 * quota parking or explicitly choose {@link layerUnclassified}.
 *
 * @category accessors
 * @since 0.1.0
 */
export const current: Effect.Effect<Service, never, QuotaClassifier> = QuotaClassifier
