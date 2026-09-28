/**
 * Asking a person something, as an ordinary declared action.
 *
 * {@link module:WaitFor.action} is the general rendezvous: it parks until
 * something outside the run resolves it, and settles with whatever arrived.
 * That is the right primitive and the wrong affordance for a human, because a
 * human answers in prose, in a hurry, and sometimes wrongly. Smithers 0.x had
 * the affordance — a `HumanTask` with a kind, a prompt, an output schema, an
 * attempt budget, and a deadline — and this module is that affordance rebuilt
 * on the primitives this package already has.
 *
 * Four things are added to a bare wait:
 *
 * - a **kind**, so the four shapes a person is asked for (`ask`, `confirm`,
 *   `select`, `json`) are stated rather than reconstructed from a schema;
 * - **validation**, so an answer that does not fit is refused where it arrives
 *   instead of failing three steps later as a decode error;
 * - **re-asking**, so a refused answer parks again on a NEW wait point rather
 *   than ending the run, until the attempt budget is spent;
 * - a **deadline**, so a question nobody answers settles instead of parking
 *   forever.
 *
 * All four are built from what is already durable. Each attempt is its own wait
 * point in {@link module:WaitFor}'s namespace — `WaitFor/<name>#<attempt>` — so
 * an answer is recorded exactly as any other durable deferred completion is, a
 * refused answer stays recorded under the attempt that refused it, and a
 * re-driven round replays every answer it already has before parking on the
 * first attempt that has none. The reason an answer was refused is recorded
 * too, as a sealed step named `HumanTask/<name>#<attempt>/rejected`, so the
 * judgment the run made sits in the journal beside the answer it judged rather
 * than in a log stream nobody replays. The park is declared through the ordinary
 * waiting vocabulary under `approval`, carrying the current attempt's token, so
 * whoever collects answers always sees the one wait point that is open. The
 * deadline is a {@link module:DurableClock} armed once per task and raced
 * against every attempt, which makes it a deadline for the QUESTION rather than
 * for one attempt at answering it.
 *
 * @since 0.1.0
 */

import * as Node from "@smthrs/plan/Node"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Action from "./Action/index.ts"
import * as DurableClock from "./DurableClock.ts"
import * as DurableDeferred from "./DurableDeferred.ts"
import { FlowInstance } from "./FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"
import { annotateWaiting } from "./FlowRuntime/WaitingAnnotation.ts"
import * as BoundedJson from "./internal/BoundedJson.ts"
import * as JsonSchemaSubset from "./internal/JsonSchemaSubset.ts"
import * as WaitFor from "./WaitFor.ts"

/**
 * The shape a person is asked for.
 *
 * `ask` wants prose, `confirm` wants yes or no, `select` wants one of the
 * options the task names, and `json` wants a value the task's JSON Schema
 * accepts. The kind is what an interface renders and what {@link validate}
 * checks; it is stated rather than inferred, because a text box and a two-
 * button confirmation are different questions even when both answers happen to
 * be strings.
 *
 * @category models
 * @since 0.1.0
 */
export type Kind = "ask" | "confirm" | "select" | "json"

/**
 * The schema the `kind` payload field is declared with.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Kind: Schema.Literals<readonly ["ask", "confirm", "select", "json"]> = Schema.Literals([
  "ask",
  "confirm",
  "select",
  "json"
])

/**
 * A question that ended without an answer the task could accept.
 *
 * `request_invalid` is the author's mistake — a `select` with no options, an
 * attempt budget below one, a deadline that is not a length of time, a JSON
 * Schema outside the supported subset — and is refused before anyone is asked
 * anything. `rejected` means every attempt was
 * spent on answers the task refused, and `timeout` means the deadline passed
 * with the question still open. All three are typed failures rather than
 * defects, so a body recovers from them with `Node.catch` like any other
 * declared failure — which is the point, because "the reviewer never answered"
 * is an ordinary outcome of asking a reviewer.
 *
 * @category errors
 * @since 0.1.0
 */
export class HumanTaskFailed extends Schema.TaggedError<HumanTaskFailed>()(
  "@smthrs/flow/HumanTaskFailed",
  {
    code: Schema.Literals(["request_invalid", "rejected", "timeout"]),
    task: Schema.String,
    attempts: Schema.Number,
    rejections: Schema.Array(Schema.String),
    message: Schema.String
  }
) {}

/**
 * An answer refused before it could consume durable storage.
 *
 * @category errors
 * @since 1.0.0
 */
export class HumanAnswerInvalid extends Schema.TaggedError<HumanAnswerInvalid>()(
  "@smthrs/flow/HumanAnswerInvalid",
  {
    code: Schema.Literals(["answer_invalid", "answer_not_open"]).pipe(
      Schema.withConstructorDefault(Effect.succeed("answer_invalid"))
    ),
    message: Schema.String
  }
) {}

/**
 * The tag the human-task declaration is catalogued and resolved under.
 *
 * @category constructors
 * @since 0.1.0
 */
export const tag = "system/human-task"

/**
 * The attempt budget a task that names none is asked under.
 *
 * @category constructors
 * @since 0.1.0
 */
export const defaultMaxAttempts = 10

/**
 * The deepest supported JSON Schema path, counting the root as depth zero.
 *
 * @category constructors
 * @since 0.1.0
 */
export const maxSchemaDepth = JsonSchemaSubset.maxSchemaDepth

/**
 * The most schema objects one human-task request may contain.
 *
 * @category constructors
 * @since 0.1.0
 */
export const maxSchemaNodes = JsonSchemaSubset.maxSchemaNodes

/**
 * The most JSON values embedded across schema keywords such as `enum`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxSchemaValueNodes = JsonSchemaSubset.maxSchemaValueNodes

/**
 * The deepest JSON value embedded in a schema, including enum members.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxSchemaValueDepth = JsonSchemaSubset.maxSchemaValueDepth

/**
 * The most JSON values one answer validation may visit.
 *
 * @category constructors
 * @since 0.1.0
 */
export const maxAnswerNodes = JsonSchemaSubset.maxAnswerNodes

/**
 * The largest encoded JSON answer that can enter the durable store.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxAnswerBytes = JsonSchemaSubset.maxAnswerBytes

/**
 * The largest encoded JSON Schema carried by one question.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxSchemaBytes = JsonSchemaSubset.maxSchemaBytes

/**
 * The deepest admitted answer tree.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxAnswerDepth = JsonSchemaSubset.maxAnswerDepth

/**
 * The largest encoded string value admitted in a request or answer.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxJsonStringBytes = JsonSchemaSubset.maxJsonStringBytes

/**
 * The largest encoded object key admitted in a request or answer.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxJsonKeyBytes = JsonSchemaSubset.maxJsonKeyBytes

/**
 * The most members admitted in one JSON array or object.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxJsonMembers = JsonSchemaSubset.maxJsonMembers

/**
 * The largest encoded task name.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxTaskNameBytes = 1_024

/**
 * The largest encoded prompt.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxPromptBytes = 64 * 1024

/**
 * The largest option list on one select question.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxOptions = 256

/**
 * The largest encoded select option.
 *
 * @category constructors
 * @since 1.0.0
 */
export const maxOptionBytes = 4 * 1024

/**
 * The largest attempt budget one human task may declare.
 *
 * @category constructors
 * @since 0.1.0
 */
export const maxAttemptBudget = 1_000

/**
 * The most caller-supplied characters retained in one rendered diagnostic.
 *
 * @category constructors
 * @since 0.1.0
 */
export const maxDiagnosticChars = JsonSchemaSubset.maxDiagnosticChars

/**
 * The most characters retained across a terminal failure's rejection list.
 *
 * @category constructors
 * @since 0.1.0
 */
export const maxRetainedRejectionChars = 8_192

/**
 * The durable deferred one attempt at answering resolves through.
 *
 * Attempts are separate wait points on purpose. A durable deferred records the
 * FIRST completion and replays it forever, so re-asking on the same wait point
 * would read the refused answer again on every round; a new point per attempt
 * makes "answer again" expressible without a second completion mechanism, and
 * leaves the refused answers in place as the record of what was asked and what
 * came back.
 *
 * The name lives in {@link module:WaitFor}'s namespace because an answer is
 * completed through exactly the {@link module:WaitFor} path: a token, and
 * `DurableDeferred.succeed`. {@link answer} is that call with the token parsed
 * for you.
 *
 * @category constructors
 * @since 0.1.0
 */
export const deferred = (
  name: string,
  attempt: number
): DurableDeferred.DurableDeferred<typeof Schema.Json> => WaitFor.deferred(`${name}#${attempt}`)

/** The namespace {@link module:WaitFor.deferred} prepends to every wait point. */
const waitForNamespace = /^WaitFor\//

/**
 * The only spelling of an attempt {@link deferred} writes: a canonical decimal
 * with no sign, no leading zero, no exponent, and no fraction.
 *
 * `Number()` alone is not this check. `NaN`, `Infinity`, `-Infinity`, and
 * `1e+21` all survive a `Number()`/`String()` round trip character for
 * character, so a gate that rebuilt the name through `Number()` would accept
 * them as attempts the action never parks on.
 */
const attemptSuffix = /^(0|[1-9][0-9]*)$/

/**
 * The deferred a token addresses, when {@link deferred} could have named it.
 *
 * {@link answer} builds its deferred FROM the caller's token, so
 * `DurableDeferred.done`'s own name check compares a name against itself and
 * can never refuse. This is the check that is not vacuous: the name is taken
 * apart at its attempt separator, the suffix is required to be a canonical
 * decimal naming an attempt the action can park on (a safe integer of one or
 * more), the name is rebuilt through {@link deferred}, and it is accepted only
 * when the rebuilt name is character-for-character the one the token carried.
 * A name {@link deferred} cannot produce -- a `DurableQueue` item address, a
 * plain {@link module:WaitFor} gate, another flow's deferred, a suffix spelled
 * any way other than the decimal {@link deferred} writes -- fails, so a
 * foreign token cannot be completed under `Schema.Json` through the
 * human-answer path.
 *
 * This bounds the confusion to human-task wait points. It does NOT distinguish
 * two human tasks from each other, nor a wait point an author deliberately
 * named to collide with one; separating those needs the deferred's schema and
 * purpose carried in the address itself, which is a wire-format change.
 *
 * @private
 */
const answerableDeferred = (
  deferredName: string
): DurableDeferred.DurableDeferred<typeof Schema.Json> | undefined => {
  const separator = deferredName.lastIndexOf("#")
  if (separator === -1) return undefined
  const suffix = deferredName.slice(separator + 1)
  if (!attemptSuffix.test(suffix)) return undefined
  const attempt = Number(suffix)
  if (!Number.isSafeInteger(attempt) || attempt < 1) return undefined
  const rebuilt = deferred(deferredName.slice(0, separator).replace(waitForNamespace, ""), attempt)
  return rebuilt.name === deferredName ? rebuilt : undefined
}

/**
 * The clock a task's deadline is armed on.
 *
 * One clock per task, not one per attempt: the deadline bounds how long the
 * QUESTION stays open, so re-asking does not extend it. The name is the task's,
 * so every attempt's race arms and awaits the same durable timer — a clock row
 * keeps the deadline it was first armed with, which is what makes the bound
 * survive a restart.
 *
 * The deadline settles on both hosts. `@smthrs/engine`'s in-process engine and
 * the SQLite engine store each re-drive a run parked on
 * {@link module:DurableDeferred.raceAll}, so the durable timer wakes the
 * question wherever it was asked
 * (`packages/smithers/flows/engine-store/test/RacedParkResume.test.ts`).
 *
 * @private
 */
const timeoutClockName = (name: string): string => `HumanTask/${name}/timeout`

/**
 * What one attempt settled with: the answer that arrived, or the deadline.
 *
 * @private
 */
const Settled = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("answered"), value: Schema.Json }),
  Schema.Struct({ _tag: Schema.Literal("timeout") })
])

type Settled = typeof Settled.Type

/**
 * What {@link validate} checks an answer against.
 *
 * @category models
 * @since 0.1.0
 */
export interface Request {
  readonly kind: Kind
  /** Ignored for `json`: an option list alone constrains no JSON value. */
  readonly options?: ReadonlyArray<string> | undefined
  readonly schema?: unknown
}

/**
 * Checks that a JSON Schema stays inside the bounded subset, at every depth.
 *
 * This is a different question from {@link validate}, which asks whether an
 * ANSWER fits a schema. A question is worth refusing before anyone is asked it:
 * a constraint the subset cannot enforce would otherwise be silently dropped,
 * and the person would be told their answer was fine when half of what was
 * asked for went unchecked.
 *
 * The subset is `type` (`object`, `array`, `string`, `number`, `integer`,
 * `boolean`, `null`), `enum`, `properties`, `required`, `items`, and
 * `nullable`; it lives in `internal/JsonSchemaSubset`.
 *
 * Returns the first reason the schema is out of bounds, or `undefined` when the
 * whole tree is inside it.
 *
 * @category combinators
 * @since 0.1.0
 */
export const validateSchema = (
  schema: unknown,
  path: ReadonlyArray<string> = []
): string | undefined => JsonSchemaSubset.validateSchema(schema, path)

/**
 * Checks one answer against the question that was asked.
 *
 * Returns the reason the answer was refused, or `undefined` when it fits. It is
 * exported because it is the same check an interface should run BEFORE it
 * records an answer: refusing a typo in the text box the person is looking at
 * is worth more than refusing it one durable round later.
 *
 * ```ts
 * const rejection = HumanTask.validate(value, { kind: "select", options })
 * if (rejection !== undefined) return showTheReviewer(rejection)
 * ```
 *
 * @category combinators
 * @since 0.1.0
 */
export const validate = (value: unknown, request: Request): string | undefined => {
  switch (request.kind) {
    case "ask":
      if (typeof value !== "string") return "The answer must be a string."
      return BoundedJson.textFits(value, maxJsonStringBytes)
        ? undefined
        : `The answer must fit within ${maxJsonStringBytes} encoded bytes of well-formed text.`
    case "confirm":
      return typeof value === "boolean" ? undefined : "The answer must be a boolean."
    case "select": {
      if (request.options === undefined || request.options.length === 0) {
        return "The question declares no options to choose from."
      }
      if (
        request.options.length > maxOptions ||
        request.options.some((option) => typeof option !== "string" || !BoundedJson.textFits(option, maxOptionBytes))
      ) {
        return `The question's options exceed the ${maxOptions}-member or ${maxOptionBytes}-byte limits.`
      }
      return request.options.some((option) => option === value)
        ? undefined
        : `The answer ${JsonSchemaSubset.renderDiagnostic(value)} is not one of ${
          JsonSchemaSubset.truncateDiagnostic(request.options.join(", "))
        }.`
    }
    default: {
      if (request.schema !== undefined) return JsonSchemaSubset.check(value, request.schema)
      const admitted = BoundedJson.admit(value, JsonSchemaSubset.answerLimits)
      return admitted.ok ? undefined : admitted.complaint
    }
  }
}

/**
 * The fields a question is asked with.
 *
 * @private
 */
const boundedText = (label: string, maximumBytes: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) =>
        BoundedJson.textFits(value, maximumBytes) ||
        `${label} must be well-formed text within ${maximumBytes} encoded bytes`,
      { title: `bounded${label.replaceAll(" ", "")}` }
    )
  )

const boundedSchema = Schema.Json.check(
  Schema.makeFilter(
    (value) => {
      const admitted = BoundedJson.admit(value, JsonSchemaSubset.schemaLimits)
      return admitted.ok || admitted.complaint
    },
    { title: "boundedHumanTaskSchema" }
  )
)

const option = boundedText("option", maxOptionBytes)

const payloadFields = {
  name: boundedText("task name", maxTaskNameBytes),
  kind: Kind,
  prompt: boundedText("prompt", maxPromptBytes),
  options: Schema.optional(
    Schema.Array(option).check(Schema.isMaxLength(maxOptions))
  ),
  schema: Schema.optional(boundedSchema),
  timeoutMs: Schema.optional(Schema.Number),
  maxAttempts: Schema.optional(Schema.Number)
}

/**
 * The declared human-task action.
 *
 * **When to use**
 *
 * Use it in a body wherever the next step depends on a person: a release that
 * needs sign-off, a plan that needs a choice, a field the run cannot compute.
 * The node settles with the answer, so downstream steps read it the way they
 * read any other step result, and {@link decode} gives that answer the caller's
 * own type.
 *
 * ```ts
 * HumanTask.action.call({
 *   name: "release",
 *   kind: "select",
 *   prompt: "Which build should ship?",
 *   options: ["canary", "stable"],
 *   timeoutMs: 6 * 60 * 60 * 1000
 * })
 * ```
 *
 * `name` addresses the question, so two calls naming one question in one
 * execution await one answer — the same reading {@link module:WaitFor} takes,
 * for the same reason: a person has to be able to name what they are answering.
 *
 * @category constructors
 * @since 0.1.0
 */
export const action: Action.Declared<
  typeof tag,
  Schema.Struct<typeof payloadFields>,
  typeof Schema.Json,
  typeof HumanTaskFailed,
  never
> = Action.makeSystem(tag, {
  payload: payloadFields,
  success: Schema.Json,
  error: HumanTaskFailed,
  tier: "sealed"
})

/** The payload the action is called with, as its implementation reads it. */
type Payload = typeof action.payloadSchema.Type

/**
 * The question a park publishes about itself, as the JSON text the durable
 * waiting row stores.
 *
 * It is the payload's own fields, narrowed to what an interface needs to
 * render an answer box and refuse a bad answer before a person sends it: the
 * kind picks the control, the prompt is the question, `options` fills a
 * select, `schema` validates a JSON answer, and the two attempt numbers say
 * how much of the budget is left. The answer VALUE never appears here — this
 * describes the question, not what anybody said.
 *
 * @private
 */
const declaredQuestion = (
  payload: Payload,
  attempt: number,
  maxAttempts: number
): string =>
  JSON.stringify({
    task: "human",
    name: payload.name,
    kind: payload.kind,
    prompt: payload.prompt,
    attempt,
    maxAttempts,
    ...(payload.options === undefined ? {} : { options: [...payload.options] }),
    ...(payload.schema === undefined ? {} : { schema: payload.schema })
  })

/** Builds the failure a task settles with, with the reasons it refused. */
const failed = (
  payload: Payload,
  code: typeof HumanTaskFailed.Type["code"],
  attempts: number,
  rejections: ReadonlyArray<string>,
  message: string
): HumanTaskFailed => new HumanTaskFailed({ code, task: payload.name, attempts, rejections, message })

interface RetainedRejections {
  readonly entries: Array<string>
  chars: number
  omitted: number
}

/** Describes the tail of a rejection history that could not be retained. */
const omissionMarker = (count: number): string => `${count} further rejections were omitted.`

/** Adds one rejection while keeping the terminal rejection history bounded. */
const retainRejection = (state: RetainedRejections, rejection: string): void => {
  const alreadyOmitting = state.omitted > 0
  if (alreadyOmitting) {
    const previousMarker = state.entries.pop()!
    state.chars -= previousMarker.length
  }
  if (!alreadyOmitting && state.chars + rejection.length <= maxRetainedRejectionChars) {
    state.entries.push(rejection)
    state.chars += rejection.length
    return
  }
  state.omitted++
  let marker = omissionMarker(state.omitted)
  while (state.chars + marker.length > maxRetainedRejectionChars) {
    const removed = state.entries.pop()!
    state.chars -= removed.length
    state.omitted++
    marker = omissionMarker(state.omitted)
  }
  state.entries.push(marker)
  state.chars += marker.length
}

/**
 * The attempt budget a payload asks for, refused when it is not a whole number
 * of attempts.
 *
 * @private
 */
const budgetOf = (payload: Payload): Effect.Effect<number, HumanTaskFailed> => {
  const maxAttempts = payload.maxAttempts ?? defaultMaxAttempts
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return Effect.fail(
      failed(
        payload,
        "request_invalid",
        0,
        [],
        `${tag} was called with maxAttempts ${maxAttempts}. A question is asked at least once.`
      )
    )
  }
  return maxAttempts <= maxAttemptBudget
    ? Effect.succeed(maxAttempts)
    : Effect.fail(
      failed(
        payload,
        "request_invalid",
        0,
        [],
        `${tag} was called with maxAttempts ${maxAttempts}. A question asked more than ` +
          `${maxAttemptBudget} times is a stuck question.`
      )
    )
}

/**
 * The deadline a payload asks for, refused when it is not a length of time.
 *
 * `Duration.millis` takes any number, so an unchecked deadline does not fail —
 * it changes what the question means. `NaN` becomes zero and a negative stays
 * negative, so both are deadlines that have ALREADY passed: the task times out
 * on its first park and nobody is ever really asked. `Infinity` becomes the
 * infinite duration, so the race has a branch that can never win and a question
 * asked with a deadline has none. All three are the same authoring mistake as a
 * `select` with no options, and they are refused in the same place, before the
 * first park, rather than surfacing as a `timeout` nobody waited for.
 *
 * @private
 */
const deadlineOf = (payload: Payload): Effect.Effect<Duration.Duration | undefined, HumanTaskFailed> => {
  const timeoutMs = payload.timeoutMs
  if (timeoutMs === undefined) return Effect.succeed(undefined)
  return Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? Effect.succeed(Duration.millis(timeoutMs))
    : Effect.fail(
      failed(
        payload,
        "request_invalid",
        0,
        [],
        `${tag} was called with timeoutMs ${timeoutMs}. A deadline is a finite number of ` +
          "milliseconds that is not negative; the question would be over before it was asked, or " +
          "never over at all."
      )
    )
}

/**
 * Refuses a question nobody could answer correctly, before anyone is asked.
 *
 * A `select` with no options and a schema outside the supported subset are
 * authoring mistakes whose only symptom at answer time would be a person being
 * refused for something they did not do, so {@link validateSchema} walks the
 * whole schema tree before the first park rather than waiting for an answer to
 * reach the keyword nobody can enforce.
 *
 * An `options` list on a `json` question is ignored because it constrains
 * nothing; JSON constraints come only from `schema`.
 *
 * @private
 */
const requestOf = (payload: Payload): Effect.Effect<Request, HumanTaskFailed> => {
  const request: Request = {
    kind: payload.kind,
    options: payload.options,
    ...(payload.schema === undefined ? {} : { schema: payload.schema })
  }
  if (payload.schema !== undefined && payload.kind !== "json") {
    return Effect.fail(
      failed(
        payload,
        "request_invalid",
        0,
        [],
        `A schema describes a "json" answer, and this question is an "${payload.kind}".`
      )
    )
  }
  if (payload.kind === "select" && (payload.options === undefined || payload.options.length === 0)) {
    return Effect.fail(
      failed(payload, "request_invalid", 0, [], `${tag} was called as a select with no options to choose from.`)
    )
  }
  if (payload.kind === "json" && payload.schema !== undefined) {
    const complaint = validateSchema(payload.schema)
    if (complaint !== undefined) return Effect.fail(failed(payload, "request_invalid", 0, [], complaint))
  }
  return Effect.succeed(request)
}

/**
 * Awaits one attempt, racing the answer against the task's deadline.
 *
 * The race is named per attempt because a durable race records its winner: one
 * name across attempts would replay the first attempt's answer forever. The
 * clock is NOT named per attempt, for the mirrored reason — the deadline is one
 * fact about the question.
 *
 * @private
 */
const attemptOnce = (
  payload: Payload,
  attempt: number,
  deadline: Duration.Duration | undefined
): Effect.Effect<Settled, never, Crypto.Crypto | FlowRuntime | FlowInstance> => {
  const answered: Effect.Effect<Settled, never, FlowRuntime | FlowInstance> = Effect.map(
    DurableDeferred.await(deferred(payload.name, attempt)),
    (value): Settled => ({ _tag: "answered", value })
  )
  if (deadline === undefined) return answered
  return DurableDeferred.raceAll({
    name: `HumanTask/${payload.name}#${attempt}`,
    success: Settled,
    error: Schema.Never,
    effects: [
      answered,
      Effect.as(
        DurableClock.sleep({
          name: timeoutClockName(payload.name),
          duration: deadline,
          // The wait is the point: the question parks the execution rather than
          // holding a fiber open for however long a person takes.
          inMemoryThreshold: Duration.zero
        }),
        { _tag: "timeout" } as const
      )
    ]
  })
}

/**
 * What a refusal records: which question, which attempt, and why the answer
 * could not be accepted.
 *
 * @private
 */
const RejectionRecord = Schema.Struct({
  task: Schema.String,
  attempt: Schema.Number,
  reason: Schema.String
})

/**
 * Records that an answer was refused, as a step rather than as a log line.
 *
 * A refusal is a decision the run made about something a person did, and it is
 * the only part of the exchange that is not already durable: the answer is
 * recorded under its own wait point and the re-ask is recorded as the next
 * one, but WHY the answer was refused would otherwise live in a log stream
 * nobody replays. `Action.make` is the recorded boundary the rest of this
 * package already writes through — {@link module:DurableClock.sleep} takes it
 * for an in-memory wait — so the refusal is dispatched, journaled, and
 * replayed like any other sealed step, under a name that carries the task and
 * the attempt it refused.
 *
 * The payload names no time. A record whose contents depend on the wall clock
 * would differ between the first run and its replay, which is the one thing a
 * journaled decision may never do.
 *
 * @private
 */
const recordRejection = (task: string, attempt: number, reason: string) =>
  Action.make({
    name: `HumanTask/${task}#${attempt}/rejected`,
    tier: "sealed",
    success: RejectionRecord,
    execute: Effect.succeed({ task, attempt, reason })
  })

/**
 * The human-task implementation: park, validate, re-ask, settle.
 *
 * Provide it beside the other action implementation layers a body calls, over
 * the {@link module:Implementations.layerImplementations} table they file
 * themselves in:
 *
 * ```ts
 * Layer.mergeAll(HumanTask.layer, Interpreter.layer(Release)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<never, never, Crypto.Crypto | FlowRuntime> = action.toLayer((payload) =>
  Effect.gen(function*() {
    const instance = yield* FlowInstance
    const maxAttempts = yield* budgetOf(payload)
    const deadline = yield* deadlineOf(payload)
    const request = yield* requestOf(payload)
    const retained: RetainedRejections = { entries: [], chars: 0, omitted: 0 }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const token = DurableDeferred.tokenFromExecutionId(deferred(payload.name, attempt), {
        flow: instance.flow,
        executionId: instance.executionId
      })
      // Declared rather than left to a driver's derivation, so the run parks
      // under `approval` carrying the ONE wait point that is currently open.
      // The question travels with the park for a different reason than the
      // token does: the token addresses the wait, and the question is what an
      // inbox has to render for a person to answer it at all. Without it a
      // parked run carried nothing but a wait name, so run-3's
      // `coding-clarification` could be listed and never asked.
      yield* annotateWaiting({ reason: "approval", token, request: declaredQuestion(payload, attempt, maxAttempts) })
      const settled = yield* attemptOnce(payload, attempt, deadline)
      // The attempt is over either way, so the declared park is over too. A
      // raced attempt awaits on a copied instance, so the branch that resolved
      // could not clear the annotation itself.
      yield* annotateWaiting(undefined)
      if (settled._tag === "timeout") {
        return yield* Effect.fail(
          failed(
            payload,
            "timeout",
            attempt,
            retained.entries,
            `Nobody answered "${payload.name}" within ${payload.timeoutMs} ms.`
          )
        )
      }
      const rejection = validate(settled.value, request)
      if (rejection === undefined) return settled.value
      retainRejection(retained, `attempt ${attempt}: ${rejection}`)
      yield* recordRejection(payload.name, attempt, rejection)
    }
    return yield* Effect.fail(
      failed(
        payload,
        "rejected",
        maxAttempts,
        retained.entries,
        `"${payload.name}" was asked ${maxAttempts} times without an answer it could accept.`
      )
    )
  })
)

/**
 * Records one answer to a human task.
 *
 * `token` is the value the run parked with — the `token` of the waiting
 * annotation, which is the wait point the current attempt is open on. The
 * runtime checks that exact approval wait and records the completion as one
 * mutation, so guessed, unopened, or stale attempt tokens cannot pre-answer a
 * run. An admitted answer then resumes the run through the ordinary durable
 * deferred path.
 *
 * The token is not a credential: anyone who knows or derives the address of
 * the open attempt can answer it. The host decides who may answer, and must
 * authorize the caller before calling `answer`.
 *
 * ```ts
 * yield* HumanTask.answer({ token: waiting.token, value: { decision: "ship" } })
 * ```
 *
 * The durable JSON boundary is validated here: the value must be inert,
 * detached, and within the exported depth, node, member, string, key, and byte
 * limits. Whether that JSON fits the question is the task's own judgment, made
 * where its kind and schema are known; a semantically refused answer stays
 * recorded so the record shows what was actually said. Call {@link validate}
 * first when the interface can refuse it while the person is still looking at
 * it.
 *
 * The TOKEN is checked. This entry point completes an arbitrary caller-supplied
 * address under `Schema.Json`, so it accepts only a token whose deferred name
 * {@link deferred} could have written. A token for a `DurableQueue` item, a
 * plain {@link module:WaitFor} gate, or an unrelated flow's deferred fails with
 * `TokenInvalid` carrying `deferred_mismatch` rather than writing a JSON exit
 * into a row another schema will decode.
 *
 * A syntactically valid HumanTask token can still fail with
 * `HumanAnswerInvalid` carrying `answer_not_open` when the addressed run is not
 * currently parked on that exact approval token.
 *
 * @category combinators
 * @since 0.1.0
 */
export const answer = (options: {
  readonly token: DurableDeferred.Token
  readonly value: typeof Schema.Json.Type
}): Effect.Effect<void, DurableDeferred.TokenInvalid | HumanAnswerInvalid, FlowRuntime> =>
  Effect.gen(function*() {
    const admitted = BoundedJson.admit(options.value, JsonSchemaSubset.answerLimits)
    if (!admitted.ok) {
      return yield* Effect.fail(
        new HumanAnswerInvalid({
          message: `The human-task answer was not recorded: ${JsonSchemaSubset.truncateDiagnostic(admitted.complaint)}`
        })
      )
    }
    const parsed = yield* DurableDeferred.TokenParsed.parse(options.token)
    const target = answerableDeferred(parsed.deferredName)
    if (target === undefined) {
      return yield* Effect.fail(
        new DurableDeferred.TokenInvalid({
          code: "deferred_mismatch",
          message:
            `The token addresses deferred "${
              JsonSchemaSubset.truncateDiagnostic(parsed.deferredName)
            }", which is not a ` +
            "human task wait point. Answer it through the surface that owns it."
        })
      )
    }
    const runtime = yield* FlowRuntime
    const outcome = yield* runtime.deferredDoneIfWaiting(target, {
      flowName: parsed.flowName,
      executionId: parsed.executionId,
      deferredName: parsed.deferredName,
      reason: "approval",
      token: options.token,
      exit: Exit.succeed(admitted.value)
    })
    if (outcome === "NotWaiting") {
      return yield* Effect.fail(
        new HumanAnswerInvalid({
          code: "answer_not_open",
          message: "The human-task answer was not recorded because the run is not parked on this approval token."
        })
      )
    }
  })

/**
 * Gives an answer the caller's own type.
 *
 * The action's success schema is `Schema.Json`, because what a person may
 * answer is described by the task's payload rather than by a TypeScript type.
 * `decode` is the other half: the author states the schema they were really
 * asking for, and the node downstream of the question carries that type.
 *
 * ```ts
 * const Decision = Schema.Struct({ decision: Schema.Literals(["ship", "hold"]) })
 *
 * HumanTask.action.call({ name: "release", kind: "json", prompt, schema }).pipe(
 *   HumanTask.decode(Decision)
 * )
 * ```
 *
 * The two descriptions must agree. The answer already passed the task's own
 * JSON Schema before it reached here, so a value this schema rejects means the
 * payload's schema and the author's schema describe different answers — an
 * authoring mistake, not a human one — and it surfaces as a defect naming the
 * offending path rather than as a failure a body could sensibly catch.
 *
 * @category combinators
 * @since 0.1.0
 */
export const decode =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  <E, R>(self: Node.Node<typeof Schema.Json.Type, E, R>): Node.Node<S["Type"], E, R> =>
    Node.map(self, Schema.decodeUnknownSync(schema))
