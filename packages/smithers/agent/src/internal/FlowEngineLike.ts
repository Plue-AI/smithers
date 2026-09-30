/**
 * Internal model-step recording for the durable agent engine port.
 *
 * These functions own retry closure state and record normalization. Keeping
 * them behind the package's null-mapped `internal/*` export prevents that
 * closure protocol from becoming a public compatibility promise.
 *
 * @since 1.0.0-rc.0
 */

import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import { tokensOf } from "../Budget.ts"

type RecordedModelStep =
  | ReadonlyArray<ModelEvent.ModelEvent>
  | {
    readonly events: ReadonlyArray<ModelEvent.ModelEvent>
    readonly error?: ModelError.ModelError | undefined
    readonly correction?: number | undefined
  }

/**
 * Reads either recorded-model-step branch as the object form.
 *
 * @category conversions
 * @since 0.1.0
 */
export const normalizeRecordedModelStep = (
  recorded: RecordedModelStep
): {
  readonly events: ReadonlyArray<ModelEvent.ModelEvent>
  readonly error?: ModelError.ModelError | undefined
  readonly correction?: number | undefined
} => "events" in recorded ? recorded : { events: recorded, error: undefined, correction: undefined }

/**
 * The model error codes worth trying again.
 *
 * A provider call is the one step in the loop that fails for reasons that have
 * nothing to do with the task: a dropped HTTP/2 session, a 5xx, a rate limit.
 * Without a retry the first of those ends the run — an agent working a real
 * repository lost twenty minutes of context to
 * `ERR_HTTP2_INVALID_SESSION: The session has been destroyed`, with the frame,
 * the run, and the workspace state all discarded.
 *
 * `call_timeout` joins them for a different reason. It is the caller's own
 * doing — the request was interrupted at the budget the controller armed — but
 * it is retryable for the same reason the other two are: nothing about the
 * task changed, and the next attempt can succeed. What separates it is that
 * waiting alone would not help, so the re-issue also carries
 * {@link overrunTeaching} — and that it does not get this set's whole retry
 * budget, because it is the one code whose every attempt costs a full wall
 * clock ceiling rather than a refused connection. {@link defaultModelOverruns}
 * bounds it separately.
 *
 * Everything absent from this set is terminal for the request as written — a
 * bad key, a malformed request, a context overflow, a refusal — and retrying
 * one is pure latency. `context_overflow` in particular must reach the caller
 * unchanged: it is the typed signal compaction reads.
 */
const retryableModelCodes: ReadonlySet<string> = new Set([
  "provider_internal",
  "transport",
  "call_timeout"
])

const seconds = (millis: number): number => Math.round(millis / 1000)

/** Final cumulative counters from distinct provider attempts, counted once each. */
const combineUsage = (usages: ReadonlyArray<ModelEvent.Usage>): ModelEvent.Usage => {
  const combined: Record<string, number> = { totalTokens: usages.reduce((sum, usage) => sum + tokensOf(usage), 0) }
  for (const usage of usages) {
    for (const [key, value] of Object.entries(usage)) {
      if (key !== "totalTokens" && value !== undefined) combined[key] = (combined[key] ?? 0) + value
    }
  }
  return combined
}

/**
 * How many times one sealed step re-issues a call its budget cut off.
 *
 * The retry budget the transport codes share cannot be shared with an overrun,
 * because the two cost different things. A dropped session fails in
 * milliseconds, so five retries of it cost five backoffs; an overrun fails
 * only after spending the whole armed ceiling, so five retries of it cost five
 * ceilings. On the wave 7 default of 300,000 ms that is a single sealed step
 * spending 1,800 s of wall clock — 150% of the 1,200 s process budget that
 * wave gave a whole run, and 2.7x the 667 s call the budget was written to
 * bound. A budget that multiplies the failure it names is not a budget.
 *
 * One re-issue is the number the mechanism supports. Waiting cannot shorten an
 * answer, so the only thing a re-issue adds is {@link overrunTeaching}, and a
 * model that overran again *after* being told to answer directly has already
 * shown the teaching did not land; a third ask costs another full ceiling and
 * buys nothing new. With one re-issue a step spends at most twice the armed
 * budget — 600 s at the default, under the 667 s single call that motivated
 * the ceiling — and then fails the frame with the typed error, which is a
 * bound a report can state.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelOverruns = 1

/**
 * Milliseconds a model stream may go without one event before it is cut off.
 *
 * A call's ceiling bounds how long it may take; this bounds how long it may
 * say nothing. The two fail differently. A long call that keeps streaming is
 * a model at work: Terminal-Bench 4.0's photonic-waveguide-routing
 * (2026-09-24) needed a 735 s design turn at `max` effort, and a total
 * ceiling short enough to catch a stall killed it. A stream that goes silent
 * is a dead socket or a stuck backend, and waiting out a 30-minute ceiling on
 * one is the cost this bound removes.
 *
 * 300,000 ms is stock Codex's `stream_idle_timeout_ms` default. The ChatGPT
 * route asks for reasoning summaries, so a long think streams summary deltas
 * and reasoning items: one live `gpt-6-sol` call at `high` effort on
 * 2026-09-24 streamed an event at least every 10 s. A stall is a transport
 * failure, re-issued without the overrun teaching, because the model did
 * nothing that needs correcting, and at most {@link defaultModelOverruns}
 * times, because each stall costs a whole window.
 *
 * Armed only when it is shorter than the call's ceiling, so a ceiling at or
 * below it is the only bound, as it was before this existed; a disarmed
 * ceiling disarms it too.
 *
 * @category policies
 * @since 1.0.0-rc.0
 */
export const defaultModelIdleMs = 300_000

/**
 * What a re-issued call tells the model about the attempt that was cut off.
 *
 * A transport failure is repaired by waiting; an overrun is not. The provider
 * would happily spend the budget again on the same answer, so the re-issue has
 * to say something the first attempt did not, and the only party that can
 * shorten the answer is the model. The note is deliberately terse and states
 * one instruction, because it is prepended to a system context that already
 * carries the cell contract, the task, and the run's state.
 *
 * It says nothing about how many attempts have been spent, because
 * {@link defaultModelOverruns} allows exactly one: a call carrying this note is
 * always the last one the step will make.
 *
 * @category policies
 * @since 0.1.0
 */
export const overrunTeaching = (budgetMillis: number): string =>
  `Time budget — your previous answer ran past this run's ${
    seconds(budgetMillis)
  }-second budget for one model call and was cut off before it finished, so none of it survives, and this is the last attempt this step will make. Answer directly this time: decide with the evidence you already have, keep the reasoning short, and emit the cell.`

/**
 * Re-issues one overrun call with the teaching prepended to its system context.
 *
 * The teaching goes at the front of `system` rather than at the end of the
 * transcript because the transcript is the cell's to shape — the controller
 * replaces it wholesale each frame from what the cell projected — while the
 * system context is the run's stable teaching, which is where an instruction
 * about how to answer belongs. The original request is never mutated; a later
 * attempt re-derives from it, so two overruns leave one note rather than two.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withOverrunTeaching = (
  request: ModelRequest.ModelRequest,
  budgetMillis: number
): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    ...request,
    system: [
      ModelRequest.SystemPart.make({ text: overrunTeaching(budgetMillis) }),
      ...request.system
    ]
  })

/**
 * Retries transient provider failures inside the sealed step.
 *
 * The retry is deliberately here rather than on the action's `retryPolicy`.
 * The engine's policy classifies by error *tag*, and every provider failure
 * shares the one `flows/model/ModelError` tag, so a tag-level policy either
 * retries a bad API key four times or retries nothing. It also replaces an
 * exhausted failure with `RetryAttemptsExhausted`, which would hide the very
 * `code` the caller branches on. Retrying in place keeps the classification
 * precise and lets the original typed error surface unchanged when the
 * backoff gives up.
 *
 * Each retry states the delay the schedule chose for it. The delay cannot be
 * read back off the journal timestamps: every retry of one sealed step is
 * buffered and written when the step settles, so a run that backed off for
 * half a minute and one that did not back off at all are indistinguishable
 * there.
 *
 * The classification is a `Schedule.while` *inside* the schedule rather than
 * `Effect.retry`'s `while` option, and the tap sits outside it. Both placements
 * matter. `Effect.retry` applies its `while` after stepping the schedule, so a
 * tap under it fires once for a terminal failure too and records a retry that
 * never happened — a `quota_exceeded` run journaled a phantom `model-retried`
 * exactly that way. Stopping the schedule first means the tap only ever sees a
 * step that will really recur, and `duration` is then the delay actually
 * slept — jitter and bound already applied — not the nominal one the base
 * schedule would have produced.
 *
 * `budgetMillis` is the same retry, applied to the one failure the provider
 * never reports: a call that answers, slowly, forever. It is enforced here
 * rather than around the whole sealed step so an overrun is an attempt rather
 * than the end of the frame — it is interrupted, classified `call_timeout`,
 * and re-issued on this schedule with {@link overrunTeaching} in front of it.
 * Interruption is the only mechanism involved: `Effect.timeoutOrElse` closes
 * the attempt's scope, and the model layer's own request teardown follows from
 * that, so nothing threads an abort signal and nothing polls a flag.
 *
 * The overrun rides the schedule's delays but not its count. Every other
 * retryable code fails fast and costs a backoff; an overrun costs a whole
 * armed ceiling, so it stops after {@link defaultModelOverruns} re-issues and
 * the step's total model time stays bounded by twice the budget rather than by
 * six times it.
 *
 * `onUsage` observes cumulative spend across this invocation's provider
 * attempts. The caller uses its last snapshot when no sealed value survives
 * (capacity refusal, permission failure, or interruption); partial text is
 * never exposed. The callback must be synchronous and cannot perform I/O.
 *
 * @category execution
 * @since 0.1.0
 */
export const recordModelStep = (
  model: Model.Model,
  request: ModelRequest.ModelRequest,
  policy: Schedule.Schedule<unknown, Model.ModelFailure>,
  budgetMillis?: number | undefined,
  correction?: number | undefined,
  onUsage?: ((usage: ModelEvent.Usage) => void) | undefined,
  onEvent?: ((event: ModelEvent.ModelEvent) => Effect.Effect<void>) | undefined
): Effect.Effect<RecordedModelStep, Model.ModelFailure> =>
  Effect.suspend(() => {
    const retries: Array<ModelEvent.ModelEvent> = []
    const failedUsage: Array<ModelEvent.Usage> = []
    let attemptUsage: ModelEvent.Usage = {}
    let attempt = 0
    /** How many attempts this step has already had cut off at the budget. */
    let overruns = 0
    /**
     * The stalls this step has cut off. Each one cost a whole idle window, so
     * like an overrun a stall is re-issued {@link defaultModelOverruns} times,
     * not the transport ladder's five.
     */
    const stalls = new Set<ModelError.ModelError>()
    const schedule = policy.pipe(
      Schedule.while(({ input }) =>
        input instanceof ModelError.ModelError && retryableModelCodes.has(input.code) &&
        // The overrun's own bound. `overruns` was incremented by the attempt
        // this failure came from, so the first cut-off call reads 1 and is
        // re-issued, and the re-issue's own cut-off reads 2 and is not.
        (input.code !== "call_timeout" || overruns <= defaultModelOverruns) &&
        (!stalls.has(input) || stalls.size <= defaultModelOverruns)
      ),
      Schedule.tap(({ duration, input }) =>
        Effect.gen(function*() {
          attempt++
          // Only a retryable `ModelError` reaches the tap: the classification
          // above stops the schedule before it on anything else.
          const error = input as ModelError.ModelError
          const retry = ModelEvent.ModelEvent.Retry({
            type: "retry",
            attempt,
            code: error.code,
            // Jitter produces a fractional millisecond. The whole millisecond
            // is the honest resolution for a report to read.
            delayMillis: Math.round(Duration.toMillis(duration))
          })
          retries.push(retry)
          if (onEvent !== undefined) yield* onEvent(retry)
        })
      )
    )
    const budget = budgetMillis === undefined || budgetMillis <= 0 ? undefined : budgetMillis
    const idle = budget !== undefined && defaultModelIdleMs < budget ? defaultModelIdleMs : undefined
    const silent = <A>(stream: Stream.Stream<A, Model.ModelFailure>): Stream.Stream<A, Model.ModelFailure> =>
      idle === undefined ? stream : stream.pipe(Stream.timeoutOrElse({
        duration: idle,
        orElse: () =>
          Stream.fromEffect(Effect.suspend(() => {
            const error = new ModelError.ModelError({
              code: "transport",
              message: `The model stream sent nothing for ${seconds(idle)} seconds and was cut off`
            })
            stalls.add(error)
            return Effect.fail(error)
          }))
      }))
    const collect = (input: ModelRequest.ModelRequest) =>
      Effect.suspend(() => {
        attemptUsage = {}
        return Stream.runCollect(
          silent(model.stream(input).pipe(Model.withGenAiSpan(input, model.providerName))).pipe(Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type !== "usage") return
              const { type: _type, ...usage } = event
              attemptUsage = {
                ...attemptUsage,
                ...Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined))
              }
              onUsage?.(combineUsage([...failedUsage, attemptUsage]))
            }).pipe(Effect.andThen(onEvent?.(event) ?? Effect.void))
          ))
        )
      })
    const collected = budget === undefined
      // Disarmed. The call is bounded by nothing but the caller's own process,
      // which is what every model call was before this budget existed.
      ? collect(request)
      // Suspended so each attempt reads the overrun count the attempt before it
      // left. That is what puts the teaching on a re-issue and never on the
      // first call, and what keeps the original request the one thing every
      // attempt derives from.
      : Effect.suspend(() =>
        collect(overruns === 0 ? request : withOverrunTeaching(request, budget)).pipe(
          Effect.timeoutOrElse({
            duration: budget,
            orElse: () =>
              Effect.sync(() => {
                overruns++
              }).pipe(
                Effect.andThen(Effect.fail(
                  new ModelError.ModelError({
                    code: "call_timeout",
                    message: `The model call ran past its ${seconds(budget)}-second budget and was interrupted`
                  })
                ))
              )
          })
        )
      )
    // A response body that ends without a settlement is a dead socket, and until
    // now it was the one way a socket could end a run outright. `Stream.runCollect`
    // *succeeds* on a truncated body — the events it did receive are returned,
    // `settledMessage` folds them into an `aborted` assistant message, and the
    // controller then raises `model_failed` because no `settle` is among them.
    // That failure is a `HarnessError`, not a `ModelError`, so no retry
    // classification ever saw it: one dropped HTTP/2 session, no backoff, run
    // over. Two r91 instances were lost to that class and re-run as
    // infrastructure crashes.
    //
    // Classifying it as `transport` puts it on the ladder every other socket
    // failure already rides. It cannot be confused with an interruption: an
    // interrupted fiber never reaches here with a value at all, and a settled
    // stream always carries its settlement.
    const attemptOnce = Effect.flatMap(collected, (events) =>
      Array.from(events).some((event) => event.type === "settle")
        ? Effect.succeed(events)
        : Effect.fail(
          new ModelError.ModelError({
            code: "transport",
            message: "The model response stream ended without a settlement"
          })
        )).pipe(Effect.tapError(() =>
          Effect.sync(() => {
            if (Object.keys(attemptUsage).length > 0) failedUsage.push(attemptUsage)
          })
        ))

    // Partial text from a failed attempt is unsafe to replay, but provider usage
    // is actual spend. Keep each attempt's final counters (not the sum of its
    // cumulative updates), then fold attempts into one usage event for the
    // sealed step. The explicit total also handles providers that report only
    // totals on some attempts and component counters on others.
    const accountFailedAttempts = (
      events: ReadonlyArray<ModelEvent.ModelEvent>
    ): ReadonlyArray<ModelEvent.ModelEvent> => {
      if (failedUsage.length === 0) return events
      const combined = combineUsage([...failedUsage, ModelEvent.ModelEvent.settledMessage(events).usage])
      const result: Array<ModelEvent.ModelEvent> = events.filter((event) => event.type !== "usage")
      const settlement = result.findIndex((event) => event.type === "settle")
      result.splice(settlement < 0 ? result.length : settlement, 0, ModelEvent.ModelEvent.Usage(combined))
      return result
    }
    // Spread rather than always present: a call outside a correction ladder has
    // no ordinal, and writing one anyway would make every ordinary model step
    // claim to be correction zero of a ladder that never ran.
    const ladder = correction === undefined ? {} : { correction }
    return attemptOnce.pipe(
      Effect.retry(schedule),
      Effect.map((events) => ({ ...ladder, events: [...retries, ...accountFailedAttempts(events)] })),
      Effect.catchIf(
        (error): error is ModelError.ModelError => error instanceof ModelError.ModelError,
        (error) =>
          isCapacityRefusal(error)
            ? Effect.fail(error)
            : Effect.succeed({ ...ladder, events: [...retries, ...accountFailedAttempts([])], error })
      )
    )
  })

/**
 * Failures that describe provider capacity rather than the request.
 *
 * This is the recorder's unconditional floor. Classifier policy may decide
 * whether the caller parks and retries one of these failures, but no classifier
 * can turn one into a durable sealed value. `provider_internal` is the model
 * vocabulary used for provider overload (including Anthropic 529); the status
 * checks cover transports that retained the wire status under another code.
 */
const capacityStatuses: ReadonlySet<number> = new Set([429, 503, 504, 529])

const isCapacityRefusal = (error: ModelError.ModelError): boolean =>
  error.code === "rate_limited" ||
  error.code === "quota_exceeded" ||
  error.code === "provider_internal" ||
  (error.httpStatus !== undefined && capacityStatuses.has(error.httpStatus))
