/**
 * The transport a classifier asks: one JSON state and a map of typed questions
 * go out, one typed raw answer per question comes back.
 *
 * The service is the seam. `layerVercelGateway` speaks Jev's wire protocol
 * through the Vercel AI Gateway over the kernel `HttpClient`; `layerScripted`
 * answers from a function so a test never touches the network; and
 * `layerUnavailable` simulates an unreachable transport for classifier tests.
 * A host without a key refuses composition. `Classifier` decodes the raw answers this module returns into typed
 * ones; this module never interprets them.
 *
 * @since 1.0.0-rc.0
 */
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Clock from "effect/Clock"
import type * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as CanonicalJson from "./CanonicalJson.ts"
import * as Endpoint from "./Endpoint.ts"

/**
 * The failure vocabulary shared by the transport and the classifier above it.
 *
 * `unreachable` is a transport that answered nothing; `refused` is a gateway
 * status other than 200, carried in `status`; `empty` is a 200 whose body
 * held no answers; `timeout` is this call's own deadline; `invalid_answer` is
 * an answer the question's shape does not accept; `invalid_question` is a
 * question the gateway or the schema rejected.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const EvaluatorErrorCode = Schema.Literals([
  "unreachable",
  "refused",
  "empty",
  "timeout",
  "invalid_answer",
  "invalid_question"
])

/**
 * The decoded form of {@link EvaluatorErrorCode}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type EvaluatorErrorCode = typeof EvaluatorErrorCode.Type

/**
 * A transport failure. Typed, never thrown: every layer in this module fails
 * with one of these and nothing else.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class EvaluatorError extends Schema.TaggedError<EvaluatorError>()("flows/model/EvaluatorError", {
  code: EvaluatorErrorCode,
  status: Schema.optional(Schema.Number),
  message: Schema.String
}) {}

/**
 * What an `unreachable` failure says wherever it is shown or journaled.
 *
 * The transport's own message for that code is the HTTP client's, and it can
 * name hosts, ports and query strings. So the code carries this fixed
 * sentence instead, and every surface says the same thing.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const unreachableMessage = "Jev was unavailable: the judge this host binds did not answer."

/**
 * The text of an evaluator failure that is safe to journal or hand a model:
 * the fixed {@link unreachableMessage} for `unreachable`, the failure's own
 * message for every other code.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const publicMessage = (error: { readonly code: EvaluatorErrorCode; readonly message: string }): string =>
  error.code === "unreachable" ? unreachableMessage : error.message

const criteriaKeyCount = Schema.makeFilter(
  (criteria: Readonly<Record<string, string>>) => {
    const count = Object.keys(criteria).length
    return count >= 2 && count <= 255
      ? undefined
      : `A choice question offers between 2 and 255 options, not ${count}`
  },
  { identifier: "choiceCriteria" }
)

const rungCount = Schema.makeFilter(
  (rungs: ReadonlyArray<string>) =>
    rungs.length >= 2 ? undefined : `A score question orders at least 2 rungs, not ${rungs.length}`,
  { identifier: "scoreRungCount" }
)

const distinctRungs = Schema.makeFilter(
  (rungs: ReadonlyArray<string>) =>
    new Set(rungs).size === rungs.length ? undefined : "A score question's rungs are distinct",
  { identifier: "scoreRungsDistinct" }
)

/**
 * The fields of each question shape, declared once. The classes below are the
 * one definition a host builds and narrows on; {@link encodeQuestions} rebuilds
 * the same fields as plain structs so the wire form is written from the field
 * declarations rather than from whatever order an object literal happened to
 * carry.
 *
 * `type` is the discriminant the gateway reads, so it is a plain literal field
 * and not a `_tag`: a `_tag` would have to be renamed at the transport and
 * would change the request body. `Schema.tag` gives it a constructor default,
 * so `new ChoiceQuestion({ instructions, criteria })` does not repeat it.
 */
const booleanFields = {
  type: Schema.tag("boolean"),
  instructions: Schema.String,
  criteria: Schema.optionalKey(Schema.Struct({ true: Schema.String, false: Schema.String }))
}

const choiceFields = {
  type: Schema.tag("choice"),
  instructions: Schema.String,
  criteria: Schema.Record(Schema.String, Schema.String).pipe(Schema.check(criteriaKeyCount))
}

const scoreFields = {
  type: Schema.tag("score"),
  instructions: Schema.String,
  criteria: Schema.Array(Schema.String).pipe(Schema.check(rungCount, distinctRungs))
}

/**
 * A yes/no question, with optional prose for what each side means.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export class BooleanQuestion extends Schema.Class<BooleanQuestion>("flows/model/BooleanQuestion")(booleanFields) {
  /**
   * Builds a yes/no question. `Classifier.boolean` is this factory.
   *
   * @category constructors
   * @since 1.0.0-rc.0
   */
  static readonly of = (options: {
    readonly instructions: string
    readonly criteria?: { readonly true: string; readonly false: string }
  }): BooleanQuestion =>
    options.criteria === undefined
      ? new BooleanQuestion({ instructions: options.instructions })
      : new BooleanQuestion({ instructions: options.instructions, criteria: options.criteria })
}

/**
 * A question answered with one of a named set of options. Between 2 and 255
 * options, each described; fewer or more is a declaration defect and fails the
 * field's schema check at construction.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export class ChoiceQuestion extends Schema.Class<ChoiceQuestion>("flows/model/ChoiceQuestion")(choiceFields) {
  /**
   * Builds a question answered with one of the named options, keeping the
   * literal option keys so the answer's `value` is their union rather than
   * `string`. A class instance type is not generic, so the keys ride on the
   * factory's return type and {@link Classifier.AnswerOf} reads them back off
   * `criteria` structurally. `Classifier.choice` is this factory.
   *
   * @category constructors
   * @since 1.0.0-rc.0
   */
  static readonly of = <const Criteria extends Readonly<Record<string, string>>>(options: {
    readonly instructions: string
    readonly criteria: Criteria
  }): Omit<ChoiceQuestion, "criteria"> & { readonly criteria: Criteria } =>
    new ChoiceQuestion(options) as Omit<ChoiceQuestion, "criteria"> & { readonly criteria: Criteria }
}

/**
 * A question answered along an ordered rubric of at least two distinct rungs.
 * Fewer, or a repeated rung, fails the field's schema check at construction.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export class ScoreQuestion extends Schema.Class<ScoreQuestion>("flows/model/ScoreQuestion")(scoreFields) {
  /**
   * Builds a question answered along an ordered rubric, keeping the literal
   * rung labels the same way {@link ChoiceQuestion.of} keeps its option keys.
   * `Classifier.score` is this factory.
   *
   * @category constructors
   * @since 1.0.0-rc.0
   */
  static readonly of = <const Rungs extends ReadonlyArray<string>>(options: {
    readonly instructions: string
    readonly criteria: Rungs
  }): Omit<ScoreQuestion, "criteria"> & { readonly criteria: Rungs } =>
    new ScoreQuestion(options) as Omit<ScoreQuestion, "criteria"> & { readonly criteria: Rungs }
}

/**
 * One question as it crosses the wire. A model-authored question is decoded
 * with this before it reaches a transport, so construction limits hold on the
 * ad-hoc path exactly as `Classifier.boolean`, `choice` and `score` hold them
 * on the typed one.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Question = Schema.Union([BooleanQuestion, ChoiceQuestion, ScoreQuestion])

/**
 * The decoded form of {@link Question}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Question = typeof Question.Type

/**
 * The same three shapes as plain structs. A class schema's encoder accepts
 * only its own instances, and both a host that declared its questions before
 * this module grew classes and a test that writes one as an object literal
 * hold structurally valid questions; encoding through the structs takes both
 * and writes the same bytes for either.
 */
const WireQuestions = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Struct(booleanFields), Schema.Struct(choiceFields), Schema.Struct(scoreFields)])
)

const encodeWireQuestions = Schema.encodeUnknownEffect(WireQuestions)

/**
 * The wire form of a map of questions: plain JSON, with each question's keys
 * in the order its fields are declared rather than the order the object
 * literal that built it happened to carry.
 *
 * The transport stringifies this instead of the questions themselves, and
 * `Classifier.make` digests it, so neither the request body nor a durable call
 * key moves when a question becomes a class. It throws on a question no shape
 * accepts, the same moment a malformed schema would.
 *
 * @category encoding
 * @since 1.0.0-rc.0
 */
export const encodeQuestions: (questions: Readonly<Record<string, Question>>) => Readonly<Record<string, unknown>> =
  Schema.encodeUnknownSync(WireQuestions)

/**
 * Jev's answer to a boolean question: the probability that the answer is yes.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const RawBooleanAnswer = Schema.Struct({
  type: Schema.Literal("boolean"),
  probability: Schema.Number
})

/**
 * Jev's answer to a choice question: the chosen option, and the distribution
 * over options when the gateway sends one.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const RawChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  probabilities: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number))
})

/**
 * Jev's answer to a score question: a score interpolated over the rubric's
 * zero-based rung indexes, and the distribution over rungs when the gateway
 * sends one.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const RawScoreAnswer = Schema.Struct({
  type: Schema.Literal("score"),
  score: Schema.Number,
  probabilities: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number))
})

/**
 * One answer as the transport returns it, before the classifier decodes it
 * against its question.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const RawAnswer = Schema.Union([RawBooleanAnswer, RawChoiceAnswer, RawScoreAnswer])

/**
 * The decoded form of {@link RawAnswer}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type RawAnswer = typeof RawAnswer.Type

/**
 * The body of a successful evaluation: one raw answer per question id.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const RawAnswers = Schema.Record(Schema.String, RawAnswer)

/**
 * The decoded form of {@link RawAnswers}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type RawAnswers = typeof RawAnswers.Type

/**
 * One evaluation: the JSON state to read and the questions to answer about it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Request {
  readonly state: unknown
  readonly questions: Readonly<Record<string, Question>>
}

/**
 * Token counts a transport reports for one evaluation, when it reports any.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * What one evaluation answered: the raw answers keyed by question id, the
 * confidence and usage when the transport reported them, and the wall-clock
 * time the call took.
 *
 * `confidence` is the provider's own number, not one derived here. Jev reports
 * it for a choice and a score and never for a boolean, whose `probability` is
 * already the whole answer, so a key is absent whenever the provider sent
 * none. It is distinct from `Classifier.confidence`, which reads the largest
 * probability in a distribution and therefore reads 1 for an answer that
 * carried no distribution at all.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Response {
  readonly answers: RawAnswers
  readonly confidence?: Readonly<Record<string, number>>
  readonly usage?: Usage
  readonly latencyMs: number
}

/**
 * The transport a classifier evaluates through. One method, one request, one
 * response, typed failure.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export interface Evaluator {
  readonly evaluate: (request: Request) => Effect.Effect<Response, EvaluatorError>
}

/**
 * The {@link Evaluator} service tag.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export const Evaluator: Context.Service<Evaluator, Evaluator> = Context.Service("/model/Evaluator")

/**
 * The gateway's evaluation endpoint: the provider's default base URL plus its
 * `/evaluation-model` path.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultBaseUrl = `${Endpoint.providerOrigins.vercel}/v4/ai/evaluation-model`

/**
 * The model asked when an option names none, as the gateway names it. It
 * rides in the `ai-model-id` header.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultModel = "typesafe-ai/jev"

/**
 * The deadline over one whole evaluation when an option names none: every
 * attempt, headers and body, and the pauses between them. Three attempts
 * that each take the median ~350 ms, plus the two pauses, fit inside it with
 * room for a slow answer.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultTimeoutMs = 3000

/**
 * How many requests one evaluation may send when an option names none. Only
 * a 429, 502, 503 or 504, or a connection that failed before any status, is
 * asked again; see {@link layerVercelGateway}.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultAttempts = 3

/**
 * The pause before the second attempt, in milliseconds. Each later pause
 * doubles it.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const retryBackoffMs = 100

/**
 * The gateway wire protocol this transport speaks, sent as
 * `ai-gateway-protocol-version`.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const protocolVersion = "0.0.1"

/**
 * The evaluation modality's specification version, sent as
 * `ai-evaluation-model-specification-version`.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const specificationVersion = "4"

/**
 * Options for {@link layerVercelGateway}.
 *
 * `apiKey` is the Vercel AI Gateway key, either in hand or as a `Config` read
 * when the layer is built. Every other option has a default: `model` is
 * {@link defaultModel}, `timeoutMs` is {@link defaultTimeoutMs}, `attempts`
 * is {@link defaultAttempts}, `zeroDataRetention` is on, and `baseUrl` is
 * {@link defaultBaseUrl}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface VercelGatewayOptions {
  readonly apiKey: Redacted.Redacted<string> | Effect.Effect<Redacted.Redacted<string>, Config.ConfigError>
  readonly model?: string
  readonly timeoutMs?: number
  readonly attempts?: number
  readonly zeroDataRetention?: boolean
  readonly baseUrl?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const decodeRawAnswers = Schema.decodeUnknownEffect(RawAnswers)

/**
 * The per-question confidence the provider reported, at the path the gateway
 * puts it: `providerMetadata.typesafe.confidence`. Anything that is not a
 * number is dropped rather than coerced, and a metadata block that carries no
 * numbers at all reads as no confidence.
 */
const confidenceOf = (body: Record<string, unknown>): Readonly<Record<string, number>> | undefined => {
  const providerMetadata = body["providerMetadata"]
  if (!isRecord(providerMetadata)) return undefined
  const typesafe = providerMetadata["typesafe"]
  if (!isRecord(typesafe)) return undefined
  const confidence = typesafe["confidence"]
  if (!isRecord(confidence)) return undefined
  const numbers = Object.entries(confidence).filter((entry): entry is [string, number] => typeof entry[1] === "number")
  return numbers.length === 0 ? undefined : Object.fromEntries(numbers)
}

const usageOf = (body: Record<string, unknown>): Usage | undefined => {
  const usage = body["usage"]
  if (!isRecord(usage)) return undefined
  const inputTokens = usage["inputTokens"]
  const outputTokens = usage["outputTokens"]
  return typeof inputTokens === "number" && typeof outputTokens === "number" ? { inputTokens, outputTokens } : undefined
}

/**
 * The status codes the gateway answers to a question it could not accept.
 * Everything else that is not 200 is a refusal of the caller or of the
 * service, carried as `refused` with the status.
 */
const invalidQuestionStatuses = new Set([400, 422])

/**
 * The statuses that say "not now" rather than "not this": the provider shed
 * the request, the caller is over its rate, or a proxy lost the upstream. The
 * same request may be answered a moment later, so these, and a connection
 * that failed before any status, alone are asked again.
 */
const retryStatuses = new Set([429, 502, 503, 504])

/**
 * Jev through the Vercel AI Gateway, over the kernel `HttpClient`.
 *
 * One POST per attempt and one deadline over the whole evaluation. A 429, 502,
 * 503 or 504, or a connection that failed before any status, is asked again,
 * up to `attempts` requests in all, after a pause of {@link retryBackoffMs}
 * that doubles each time; the answer is still Jev's, and a request shed on
 * every attempt fails `refused` with the last status (or `unreachable`).
 * On 2026-09-23 `typesafe-ai/jev` shed about one request in seven with a 503
 * in ~125 ms, with no `retry-after` and no fallback behind the gateway; the
 * same body sent again was answered. The deadline bounds the retries too: no
 * attempt starts, and no pause runs, past it. Every other status fails at
 * once. Every request
 * runs as a `model:call` on the gateway host for the configured model, so a
 * grant for the gateway is a grant for this model and not for the rest. The
 * wire protocol is the AI SDK gateway provider's own, as recorded on
 * 2026-09-17; Vercel may change it without notice, and a changed response
 * surfaces as `empty` or `invalid_answer`, never as a guessed answer.
 *
 * The layer requires the kernel HTTP client. With the key in hand it cannot
 * fail; with a `Config` it fails at construction when the key cannot be read.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export function layerVercelGateway(
  options: VercelGatewayOptions & { readonly apiKey: Redacted.Redacted<string> }
): Layer.Layer<Evaluator, never, KernelHttpClient.HttpClient>
/**
 * {@link layerVercelGateway} with the key read from `Config` when the layer is
 * built, so a missing or malformed key is a `ConfigError` at construction.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export function layerVercelGateway(
  options: VercelGatewayOptions
): Layer.Layer<Evaluator, Config.ConfigError, KernelHttpClient.HttpClient>
/**
 * The implementation behind both overloads.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export function layerVercelGateway(
  options: VercelGatewayOptions
): Layer.Layer<Evaluator, any, KernelHttpClient.HttpClient> {
  return Layer.effect(
    Evaluator,
    Effect.gen(function*() {
      // Every request's lifetime is tied to the scope the call opens below, so
      // its abort fires the moment the call settles. Without it an answer the
      // transport refused, or one whose body this module never reads, leaves
      // the response body held open until the runtime collects it.
      const http = HttpClient.withScope(yield* KernelHttpClient.HttpClient)
      const apiKey = Redacted.isRedacted(options.apiKey) ? options.apiKey : yield* options.apiKey
      const model = options.model ?? defaultModel
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
      const attempts = Math.max(1, Math.floor(options.attempts ?? defaultAttempts))
      const zeroDataRetention = options.zeroDataRetention ?? true
      const baseUrl = options.baseUrl ?? defaultBaseUrl

      const evaluate = (request: Request): Effect.Effect<Response, EvaluatorError> =>
        Effect.gen(function*() {
          const started = yield* Clock.currentTimeMillis
          // The questions are encoded through their schema rather than handed
          // to `JSON.stringify` as they stand: a question is a class instance
          // on the typed path and an object literal on the ad-hoc one, and the
          // body has to read the same either way.
          const encodedQuestions = yield* encodeWireQuestions(request.questions).pipe(
            Effect.mapError((error) => new EvaluatorError({ code: "invalid_question", message: error.message }))
          )
          const serializedBody = yield* Effect.try({
            try: () => {
              // Reject values JSON would omit or coerce, as well as cycles
              // and bigint. Keep the existing wire order after validation.
              CanonicalJson.stringify(request.state)
              // The gateway accepts strings, arrays and objects, but rejects
              // number, boolean and null states. The wrapper is transport
              // only: each question must still judge the original JSON value.
              const wrapped = request.state === null || typeof request.state === "number" ||
                typeof request.state === "boolean"
              return JSON.stringify({
                state: wrapped ? { state: request.state } : request.state,
                questions: wrapped ?
                  Object.fromEntries(
                    Object.entries(encodedQuestions).map(([id, question]) => [id, {
                      ...question,
                      instructions:
                        "The original JSON state is wrapped in the object's state property. Answer about that original value, not the wrapper.\n\n" +
                        question.instructions
                    }])
                  ) :
                  encodedQuestions,
                providerOptions: { gateway: { zeroDataRetention } }
              })
            },
            catch: () =>
              new EvaluatorError({ code: "invalid_question", message: "The evaluation state must be a JSON value" })
          })
          const wire = HttpClientRequest.post(baseUrl, {
            headers: {
              authorization: `Bearer ${Redacted.value(apiKey)}`,
              "ai-gateway-protocol-version": protocolVersion,
              "ai-gateway-auth-method": "api-key",
              "ai-evaluation-model-specification-version": specificationVersion,
              "ai-model-id": model,
              "content-type": "application/json"
            },
            body: HttpBody.text(serializedBody, "application/json")
          })
          const send = http.execute(wire).pipe(
            KernelHttpClient.withModelCall(model),
            Effect.mapError((error) => new EvaluatorError({ code: "unreachable", message: error.message }))
          )
          // An evaluation is a pure question, so asking it again is safe.
          const retryable = (outcome: Result.Result<HttpClientResponse.HttpClientResponse, EvaluatorError>) =>
            Result.isFailure(outcome) || retryStatuses.has(outcome.success.status)
          let outcome = yield* Effect.result(send)
          for (let attempt = 1; attempt < attempts && retryable(outcome); attempt++) {
            yield* Effect.sleep(retryBackoffMs * 2 ** (attempt - 1))
            outcome = yield* Effect.result(send)
          }
          if (Result.isFailure(outcome)) {
            const error = outcome.failure
            return yield* Effect.fail(
              attempts > 1
                ? new EvaluatorError({ code: error.code, message: `${error.message} on all ${attempts} attempts` })
                : error
            )
          }
          const response = outcome.success
          if (response.status !== 200) {
            const retried = attempts > 1 && retryStatuses.has(response.status)
            return yield* Effect.fail(
              new EvaluatorError({
                code: invalidQuestionStatuses.has(response.status) ? "invalid_question" : "refused",
                status: response.status,
                message: retried
                  ? `The gateway answered ${response.status} on all ${attempts} attempts`
                  : `The gateway answered ${response.status}`
              })
            )
          }
          const body = yield* response.json.pipe(
            Effect.mapError((error) =>
              new EvaluatorError({ code: "empty", status: 200, message: `Unreadable body: ${error.reason._tag}` })
            )
          )
          if (!isRecord(body) || !isRecord(body["answers"])) {
            return yield* Effect.fail(
              new EvaluatorError({ code: "empty", status: 200, message: "The body carried no answers" })
            )
          }
          const answers = yield* decodeRawAnswers(body["answers"]).pipe(
            Effect.mapError((error) =>
              new EvaluatorError({ code: "invalid_answer", status: 200, message: error.message })
            )
          )
          const confidence = confidenceOf(body)
          const usage = usageOf(body)
          const latencyMs = (yield* Clock.currentTimeMillis) - started
          return {
            answers,
            ...(confidence === undefined ? {} : { confidence }),
            ...(usage === undefined ? {} : { usage }),
            latencyMs
          }
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
              Effect.fail(
                new EvaluatorError({ code: "timeout", message: `The gateway did not answer within ${timeoutMs} ms` })
              )
          })
        )

      return Evaluator.of({ evaluate: Effect.fn("Evaluator.evaluate")(evaluate) })
    })
  )
}

/**
 * One scripted answer. The `type` is optional because the script's request
 * already names it through the question; a bare `{ probability }`,
 * `{ choice }` or `{ score }` is enough.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ScriptedAnswer =
  | { readonly type?: "boolean"; readonly probability: number }
  | { readonly type?: "choice"; readonly choice: string; readonly probabilities?: Readonly<Record<string, number>> }
  | { readonly type?: "score"; readonly score: number; readonly probabilities?: Readonly<Record<string, number>> }

/**
 * What a script answers: one {@link ScriptedAnswer} per question id, either
 * in hand or as an effect that may fail the way a transport fails.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Script = (
  request: Request
) =>
  | Readonly<Record<string, ScriptedAnswer>>
  | Effect.Effect<Readonly<Record<string, ScriptedAnswer>>, EvaluatorError>

const typed = (question: Question | undefined, answer: ScriptedAnswer): unknown =>
  answer.type === undefined && question !== undefined ? { ...answer, type: question.type } : answer

/**
 * An evaluator that answers from a function, so a test runs without a key or
 * a network. A scripted answer may omit its `type`: the layer fills it from
 * the question it answers, and then decodes the result exactly as the gateway
 * layer decodes a body, so a script that answers the wrong shape fails as
 * `invalid_answer` rather than reaching the classifier.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerScripted = (script: Script): Layer.Layer<Evaluator> =>
  Layer.succeed(Evaluator)(
    Evaluator.of({
      evaluate: Effect.fn("Evaluator.evaluate")((request: Request) =>
        Effect.gen(function*() {
          const scripted = script(request)
          const answers = Effect.isEffect(scripted) ? yield* scripted : scripted
          const raw = Object.fromEntries(
            Object.entries(answers).map(([id, answer]) => [id, typed(request.questions[id], answer)])
          )
          const decoded = yield* decodeRawAnswers(raw).pipe(
            Effect.mapError((error) => new EvaluatorError({ code: "invalid_answer", message: error.message }))
          )
          return { answers: decoded, latencyMs: 0 }
        })
      )
    })
  )

/**
 * The environment variable every host reads its gateway key from.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const environmentKey = "AI_GATEWAY_API_KEY"

/**
 * The evaluator a named host binds from its environment: Jev through the
 * Vercel gateway, or a synchronous startup refusal when the key is missing.
 *
 * The agent's required `Evaluator` already makes omission a type error. The
 * old environment factory defeated that contract by providing an evaluator
 * that could answer nothing. Refuse here, while the host assembles its layers,
 * rather than in an effect that can race a sibling database or socket layer.
 * Hosts that defer assembly until after startup must select this layer first.
 * An offline host deliberately binds {@link layerScripted} instead.
 *
 * `host` is required so a newly authored composition cannot omit the name in
 * its refusal. No colon follows the variable name: the journal redactor would
 * consume the next word as a secret. This checks configuration, not future
 * availability; a judge that goes down still fails the completion closed.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  host: string
): Layer.Layer<Evaluator, never, KernelHttpClient.HttpClient> => {
  const apiKey = environment[environmentKey]
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new EvaluatorError({
      code: "unreachable",
      message:
        `${host} needs AI_GATEWAY_API_KEY, because the harness asks Jev to judge every completion and fails a run it cannot judge. Export AI_GATEWAY_API_KEY (Vercel AI Gateway) and start again, or deliberately bind Evaluator.layerScripted with an evidence-based judge.`
    })
  }
  return layerVercelGateway({
    apiKey: Redacted.make(apiKey),
    // An explicit SMITHERS_EVALUATOR_BASE_URL wins; otherwise the gateway
    // origin honors SMITHERS_MODEL_PROXY_URL through Endpoint.providerOrigin.
    baseUrl: environment.SMITHERS_EVALUATOR_BASE_URL ??
      `${Endpoint.providerOrigin("vercel", environment)}/v4/ai/evaluation-model`
  })
}

/**
 * An evaluator with no transport behind it: every request fails as
 * `unreachable`. It is an outage fixture for classifiers, and the binding for
 * a host that cannot reach a completion at all: one composed to observe runs
 * and drive none, where nothing will ever ask it anything. It is never a
 * completion-capable host's missing-key default: such a host must bind a live
 * or scripted judge before it opens resources, and
 * {@link layerFromEnvironment} enforces that choice at composition time.
 * It is also the judge a host binds when it has disarmed the claim brake
 * (`claimCap: 0`), so that nothing on the host will ever ask it.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerUnavailable = (): Layer.Layer<Evaluator> =>
  Layer.succeed(Evaluator)(
    Evaluator.of({
      evaluate: () =>
        Effect.fail(new EvaluatorError({ code: "unreachable", message: "No evaluator is installed on this host" }))
    })
  )
