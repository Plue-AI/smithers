/**
 * Polling as a durable lineage: one attempt per round, a durable wait between
 * attempts, and a bound the lineage settles on.
 *
 * Smithers 0.x had a `Poller` component — a check, an interval, a backoff, an
 * attempt bound, and what to do at that bound. The pieces it was built from
 * already exist here: {@link module:Sleep.action} is the durable wait, and
 * `Flow.to` opens the next round. What was missing is the shape that puts them
 * together, and that is this module.
 *
 * A poll is a flow whose body is ONE attempt. It runs the check, and branches:
 * a satisfied check settles the lineage with the check's own output, an
 * unsatisfied one sleeps for this attempt's delay and hands off to the next
 * round with the attempt counter raised. The last attempt has no sleep and no
 * handoff — it either answers with the output it just read (`return-last`) or
 * fails {@link PollExhausted} (`fail`).
 *
 * Everything durable about it is durable for the ordinary reason. Each attempt
 * is a round with its own keyed plan nodes, so a check that already ran replays
 * from its recorded outcome instead of running again; the wait between attempts
 * is a durable timer, so a process that dies during it resumes on the round it
 * left rather than starting the poll over; and the attempt counter travels in
 * the payload, so nothing about "which attempt is this" lives in memory.
 *
 * The bound is stated twice on purpose. The body ends the lineage on the last
 * attempt, and `maxAttempts` is also the flow's `maxRounds` budget, so a
 * lineage that somehow opened another round is refused by the engine rather
 * than polling forever.
 *
 * @since 0.1.0
 */

import * as Node from "@smthrs/plan/Node"
import type * as Repetition from "@smthrs/plan/Repetition"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Action from "./Action/index.ts"
import * as Flow from "./Flow/index.ts"
import type { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"
import * as Sleep from "./Sleep.ts"

/**
 * How the wait between attempts grows.
 *
 * `fixed` waits the interval every time, `linear` waits the interval times the
 * attempt, and `exponential` doubles the interval on every attempt.
 *
 * @category models
 * @since 0.1.0
 */
export type Backoff = "fixed" | "linear" | "exponential"

/**
 * What a check reports: whether the poll is over, and the value this attempt
 * read.
 *
 * The output travels on every attempt, satisfied or not, because it is also
 * the answer a `return-last` poll settles with when it runs out of attempts.
 *
 * @category models
 * @since 0.1.0
 */
export interface Check<out Result> {
  readonly satisfied: boolean
  readonly output: Result
}

/**
 * The success schema a check action declares.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CheckResult = <Result extends Schema.Top>(
  result: Result
): Schema.Struct<{
  readonly satisfied: typeof Schema.Boolean
  readonly output: Result
}> => Schema.Struct({ satisfied: Schema.Boolean, output: result })

/**
 * A poll that used its last attempt without a satisfied check.
 *
 * It is a typed failure rather than a defect: running out of attempts is an
 * expected outcome of polling something that may never become ready, so a
 * caller recovers from it through `Node.catch` like any other declared failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class PollExhausted extends Schema.TaggedError<PollExhausted>()(
  "@smthrs/flow/PollExhausted",
  {
    // This wire shape freezes at 1.0.0-rc.0.
    code: Schema.Literal("poll_exhausted").pipe(
      Schema.withConstructorDefault(Effect.succeed("poll_exhausted"))
    ),
    poll: Schema.String,
    attempts: Schema.Number,
    message: Schema.String
  }
) {}

/**
 * The tag the exhaustion step is catalogued and resolved under.
 *
 * @category constructors
 * @since 0.1.0
 */
export const exhaustedTag = "system/poll-exhausted"

/**
 * The declared step a poll takes when its last attempt was not satisfied.
 *
 * Running out of attempts is a step rather than a bare `Effect.fail` so the
 * exhaustion is in the plan and in the journal: the round that gave up shows
 * which poll gave up and after how many attempts, exactly like every other node
 * a body drove.
 *
 * @category constructors
 * @since 0.1.0
 */
export const exhausted: Action.Declared<
  typeof exhaustedTag,
  Schema.Struct<{
    readonly poll: typeof Schema.String
    readonly attempts: typeof Schema.Number
  }>,
  typeof Schema.Never,
  typeof PollExhausted,
  never
> = Action.makeSystem(exhaustedTag, {
  payload: { poll: Schema.String, attempts: Schema.Number },
  success: Schema.Never,
  error: PollExhausted,
  tier: "sealed"
})

/**
 * The wait before the attempt after this one, in milliseconds.
 *
 * @category combinators
 * @since 0.1.0
 */
export const delayMillis = (options: {
  readonly intervalMs: number
  readonly backoff: Backoff
  readonly attempt: number
}): number =>
  options.intervalMs *
  (options.backoff === "fixed" ? 1 : options.backoff === "linear" ? options.attempt : 2 ** (options.attempt - 1))

/**
 * What a poll round can fail with.
 *
 * {@link PollExhausted} is the poll's own failure. `SleepRequestInvalid` is the
 * wait node's, declared because the wait between attempts is an ordinary
 * {@link module:Sleep.action} node and its typed refusal is part of the
 * topology a poll carries. Its codes cover a payload that names no deadline,
 * names two deadlines, or names a value that is not a deadline. {@link make}
 * refuses invalid author schedules at construction. A caller-visible round
 * payload can still carry an invalid attempt that produces an invalid derived
 * wait, so `Sleep` refuses that wait before the round parks.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Failure: Schema.Union<
  readonly [typeof PollExhausted, typeof Sleep.SleepRequestInvalid]
> = Schema.Union([PollExhausted, Sleep.SleepRequestInvalid])

/**
 * The payload schema {@link make} derives from an author's input fields: the
 * author's own fields, plus the attempt this round is.
 *
 * `attempt` is optional so a caller starts a poll with its own fields alone;
 * the first round reads it as one.
 *
 * @category models
 * @since 0.1.0
 */
export type PayloadSchema<Input extends Schema.Struct.Fields> = Schema.Struct<
  Input & { readonly attempt: Schema.optional<typeof Schema.Number> }
>

/**
 * The payload schema one round is opened with: the author's fields, plus the
 * attempt counter the lineage carries between them.
 *
 * @private
 */
const payloadSchema = <Input extends Schema.Struct.Fields>(
  input: Input,
  maxAttempts: number
): PayloadSchema<Input> =>
  Schema.Struct({
    ...input,
    attempt: Schema.optional(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(maxAttempts)
      )
    )
  })

/**
 * The attempt a round payload carries, defaulting to the first.
 *
 * @private
 */
const attemptOf = (payload: object): number => {
  const attempt = (payload as { readonly attempt?: unknown }).attempt
  return typeof attempt === "number" ? attempt : 1
}

/**
 * Rebuilds a round payload with an explicit attempt.
 *
 * The two views of one round payload — what the check reads, and what the next
 * round is opened with — are the same fields with `attempt` resolved. TypeScript
 * cannot reduce a mapped type over an unresolved generic field set, so the
 * shape is stated once here instead of at each use.
 *
 * @private
 */
const withAttempt = <Payload>(payload: object, attempt: number): Payload =>
  ({ ...payload, attempt }) as unknown as Payload

/**
 * Declares a durable poller.
 *
 * **When to use**
 *
 * Use it wherever a run has to keep asking until something is ready — a build
 * that finishes, a deployment that goes live, a review that lands — and the
 * waiting has to survive a restart. `check` is the one thing an author writes:
 * a body fragment that reads whatever it polls and reports a {@link Check}.
 * Everything else is schedule. Under stable callback admission (the default of
 * `Interpreter.layerWithImplementations`), wrap `check` in `Node.capture` with
 * every semantic capture, including a version for imported behavior. An
 * uncaptured check keeps the poll process-local. The helper captures its own
 * callbacks using the schedule and the check's identity.
 *
 * ```ts
 * const Deployment = Poll.make("deploy/wait", {
 *   input: { id: Schema.String },
 *   result: Schema.String,
 *   intervalMs: 5_000,
 *   backoff: "exponential",
 *   maxAttempts: 8,
 *   onTimeout: "fail",
 *   check: Node.capture(
 *     { action: Status.name, implementationVersion: "deploy/status-check/v1" },
 *     ({ attempt, id }) => Status.call({ attempt, id })
 *   )
 * })
 * ```
 *
 * The check may not fail. A check that can fail states what a failure means for
 * the poll — give up, or treat it as "not ready yet" — with `Node.catch` inside
 * the fragment, rather than leaving the poll to guess.
 *
 * A per-attempt time limit on the check itself is NOT a poll option. A plan
 * node's duration is not something the body around it can bound; that bound
 * belongs in the check's own implementation, where `DurableDeferred.raceAll`
 * races the work against a durable clock and stays replayable.
 *
 * A schedule no clock can be armed with is refused here, with a `RangeError`
 * naming the option that is wrong. `intervalMs` becomes the `millis` of a
 * {@link module:Sleep.action} node, and a wait of `Infinity`, `NaN`, or a
 * negative length arms a timer that never fires — a poll that hangs forever
 * with a plan that looks correct. The check is on the schedule, not only on the
 * interval: `{ intervalMs: 1000, maxAttempts: 2000, backoff: "exponential" }`
 * states three finite options and asks for an infinite wait, so the LAST wait
 * the poll can arm has to be a length too. `maxAttempts` is the lineage's round
 * budget, and a budget below one attempt reaches `Flow.make` as a `maxRounds`
 * complaint about an option the author never wrote.
 *
 * @throws A `RangeError` when `intervalMs` is not a duration a clock accepts,
 * when `maxAttempts` is not a whole number of attempts of at least one, or when
 * the interval under the declared backoff reaches a wait no clock can be armed
 * with before the budget is spent.
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  const Tag extends string,
  Input extends Schema.Struct.Fields,
  Result extends Schema.Top,
  R = never
>(
  tag: Tag,
  options: {
    readonly input: Input
    readonly result: Result
    readonly check: (
      payload: Schema.Struct.Type<Input> & { readonly attempt: number }
    ) => Node.Node<Check<Result["Type"]>, never, R>
    readonly intervalMs: number
    readonly maxAttempts: number
    readonly backoff?: Backoff | undefined
    readonly onTimeout?: Repetition.AtCeiling | undefined
  }
): Flow.Flow<Tag, PayloadSchema<Input>, Result, typeof Failure, R> => {
  type Round = Flow.Flow<Tag, PayloadSchema<Input>, Result, typeof Failure, R>
  type RoundPayload = PayloadSchema<Input>["Type"]
  if (Object.prototype.hasOwnProperty.call(options.input, "attempt")) {
    throw new TypeError(
      `Poll.make: "${tag}" input cannot declare the reserved "attempt" field. ` +
        "Poll owns that counter across durable rounds."
    )
  }
  const input = Object.freeze({ ...options.input }) as Input
  const result = options.result
  const check = options.check
  const intervalMs = options.intervalMs
  const maxAttempts = options.maxAttempts
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError(
      `Poll.make: "${tag}" intervalMs must be a finite number of milliseconds that is not negative, ` +
        `and was ${intervalMs}. The interval is the length of a durable wait, and a wait of ` +
        "that length never ends."
    )
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(
      `Poll.make: "${tag}" maxAttempts must be a whole number of attempts of at least one, and was ` +
        `${maxAttempts}. A poll checks at least once.`
    )
  }
  const backoff = options.backoff ?? "fixed"
  // The wait a poll arms is not `intervalMs`. {@link delayMillis} multiplies it
  // by the backoff, so a schedule whose options are each finite can still ask
  // for a wait that is not a length — and that wait arms the same timer that
  // never fires the interval guard above exists to refuse. The last wait is the
  // one before the final attempt, because the attempt at the budget gives up
  // rather than sleeps, and the schedule never shrinks, so the last wait is
  // also the longest: checking it checks all of them.
  const longestWaitMs = maxAttempts > 1
    ? delayMillis({ intervalMs, backoff, attempt: maxAttempts - 1 })
    : 0
  if (!Number.isFinite(longestWaitMs)) {
    throw new RangeError(
      `Poll.make: "${tag}" asks for a wait of ${longestWaitMs} ms before its last attempt. An ` +
        `intervalMs of ${intervalMs} under the "${backoff}" backoff reaches a length no clock ` +
        `can be armed with by attempt ${maxAttempts - 1} of ${maxAttempts}. Lower ` +
        "maxAttempts, shorten the interval, or slow the backoff."
    )
  }
  const onTimeout = options.onTimeout ?? "fail"
  const captures = { tag, intervalMs, backoff, maxAttempts, onTimeout, check: Node.functionIdentity(check) }
  const body = (
    payload: RoundPayload
  ): Node.Node<Flow.BodySuccess<Result["Type"]>, typeof Failure.Type, R> => {
    const attempt = attemptOf(payload)
    const last = attempt >= maxAttempts
    return check(withAttempt(payload, attempt)).pipe(
      Node.branch({
        if: Node.capture(captures, (checked) => checked.satisfied),
        then: (checked) => Flow.done(checked.output),
        else: (checked): Node.Node<Flow.BodySuccess<Result["Type"]>, typeof Failure.Type> =>
          last
            ? onTimeout === "return-last"
              ? Flow.done(checked.output)
              : exhausted.call({ poll: tag, attempts: attempt })
            : Sleep.action.call({
              millis: delayMillis({ intervalMs, backoff, attempt })
            }).pipe(
              Node.andThen(
                self.to(withAttempt<Parameters<Round["to"]>[0]>(payload, attempt + 1))
              )
            )
      })
    )
  }
  // The body names the flow it is the body of, which is what makes one round
  // open the next. It is read when a round is planned, long after `Flow.make`
  // has returned, so the binding is initialized by then.
  const self: Round = Flow.make(tag, {
    payload: payloadSchema(input, maxAttempts),
    success: result,
    error: Failure,
    maxRounds: maxAttempts,
    // A captured wrapper must not admit a process-local check as stable.
    body: captures.check.algorithm === "sha256-source-ephemeral/v4" ? body : Node.capture(captures, body)
  })
  return self
}

/**
 * The exhaustion implementation, provided beside the other action layers a
 * poll's rounds call.
 *
 * ```ts
 * Layer.mergeAll(Poll.layer, Sleep.layer, Interpreter.layer(Deployment)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<never, never, Crypto.Crypto | FlowRuntime> = exhausted.toLayer(
  ({ attempts, poll }) =>
    Effect.fail(
      new PollExhausted({
        poll,
        attempts,
        message: `Poll "${poll}" used all ${attempts} attempts without a satisfied check.`
      })
    )
)
