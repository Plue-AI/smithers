/**
 * Typed questions about a JSON state, answered by Jev through an
 * {@link Evaluator.Evaluator}.
 *
 * A host declares a classifier once: an id, a state schema, and a map of
 * questions built with {@link boolean}, {@link choice} and {@link score}. The
 * answer type is inferred from the questions, so a choice's options become a
 * literal union and a score's rungs become its labels. `evaluate` sends one
 * state and decodes the transport's raw answers against the questions;
 * `evaluateAll` fans out over many states with bounded concurrency, one
 * request per state, and keeps every result. `digest` is the canonical hash
 * of the declaration, so a durable call key that folds it in never replays an
 * answer to a question that has since changed.
 *
 * @since 1.0.0-rc.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Fault from "@smthrs/flow/Fault"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as CanonicalJson from "./CanonicalJson.ts"
import * as Evaluator from "./Evaluator.ts"

/**
 * The classifier's failure vocabulary: the transport's codes, plus
 * `invalid_answer` for a raw answer the question's shape does not accept and
 * `invalid_question` for a state the classifier's schema does not encode.
 * Typed, never thrown.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class ClassifierError extends Schema.TaggedError<ClassifierError>()("flows/model/ClassifierError", {
  code: Evaluator.EvaluatorErrorCode,
  status: Schema.optional(Schema.Number),
  resetAtEpochMillis: Schema.optional(Schema.Number),
  message: Schema.String
}) {}
Fault.register("flows/model/ClassifierError", Evaluator.faults)

/**
 * One question as it crosses the wire; the schema for a model-authored
 * question on the ad-hoc path. The same value as `Evaluator.Question`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Question = Evaluator.Question

/**
 * The decoded form of {@link Question}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Question = Evaluator.Question

/**
 * A yes/no question. `criteria`, when present, says what each side means. The
 * same class as `Evaluator.BooleanQuestion`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const BooleanQuestion = Evaluator.BooleanQuestion

/**
 * The decoded form of {@link BooleanQuestion}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type BooleanQuestion = Evaluator.BooleanQuestion

/**
 * A question answered with one of the named options in `criteria`. The same
 * class as `Evaluator.ChoiceQuestion`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const ChoiceQuestion = Evaluator.ChoiceQuestion

/**
 * The decoded form of {@link ChoiceQuestion}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ChoiceQuestion = Evaluator.ChoiceQuestion

/**
 * A question answered along the ordered rubric in `criteria`. The same class
 * as `Evaluator.ScoreQuestion`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const ScoreQuestion = Evaluator.ScoreQuestion

/**
 * The decoded form of {@link ScoreQuestion}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ScoreQuestion = Evaluator.ScoreQuestion

/**
 * The map of questions a classifier declares, keyed by question id.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Questions = Readonly<Record<string, BooleanQuestion | ChoiceQuestion | ScoreQuestion>>

/**
 * Builds a yes/no question.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const boolean = Evaluator.BooleanQuestion.of

/**
 * Builds a question answered with one of the named options, keeping the
 * literal option keys so the answer's `value` is their union. Between 2 and
 * 255 options; fewer or more is a declaration defect and fails the field's
 * schema check at construction, the same moment a malformed schema would.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const choice = Evaluator.ChoiceQuestion.of

/**
 * Builds a question answered along an ordered rubric, keeping the literal rung
 * labels. At least 2 distinct rungs; fewer, or a repeated label, is a
 * declaration defect and fails the field's schema check at construction.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const score = Evaluator.ScoreQuestion.of

/**
 * The answer to a {@link BooleanQuestion}: the value, and the probability the
 * transport gave to yes.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface BooleanAnswer {
  readonly value: boolean
  readonly probability: number
}

/**
 * The answer to a {@link ChoiceQuestion}: the chosen option, the distribution
 * over every option, and the confidence, which is the largest probability in
 * that distribution.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ChoiceAnswer<Key extends string = string> {
  readonly value: Key
  readonly probabilities: Readonly<Record<Key, number>>
  readonly confidence: number
}

/**
 * The answer to a {@link ScoreQuestion}: the score as the transport gave it,
 * interpolated over zero-based rung indexes; the label of the nearest rung;
 * the distribution over rungs keyed by label; and the confidence, which is
 * the largest probability in that distribution.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ScoreAnswer<Label extends string = string> {
  readonly value: number
  readonly label: Label
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number
}

/**
 * The typed answer a question infers.
 *
 * A `Schema.Class` instance type is not generic, so this reads the option keys
 * and rung labels off `criteria` structurally rather than off a class type
 * parameter. {@link choice} and {@link score} keep those literals on their
 * return types, so `answers.role.value` stays the option union and
 * `answers.risk.label` stays the rung union.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type AnswerOf<Q> = Q extends { readonly type: "boolean" } ? BooleanAnswer
  : Q extends { readonly type: "choice"; readonly criteria: infer Criteria extends Readonly<Record<string, string>> }
    ? ChoiceAnswer<keyof Criteria & string>
  : Q extends { readonly type: "score"; readonly criteria: ReadonlyArray<infer Label extends string> }
    ? ScoreAnswer<Label>
  : never

/**
 * The typed answers a map of questions infers, keyed like the questions.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type AnswersOf<Qs extends Questions> = { readonly [Id in keyof Qs]: AnswerOf<Qs[Id]> }

const Probability = Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })))

/**
 * One decoded answer, in any of the three shapes; the schema for the ad-hoc
 * path, where the questions are not known at compile time.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Answer = Schema.Union([
  Schema.Struct({
    value: Schema.Number,
    label: Schema.String,
    probabilities: Schema.Record(Schema.String, Probability),
    confidence: Probability
  }),
  Schema.Struct({ value: Schema.Boolean, probability: Probability }),
  Schema.Struct({
    value: Schema.String,
    probabilities: Schema.Record(Schema.String, Probability),
    confidence: Probability
  })
])

/**
 * The decoded form of {@link Answer}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Answer = typeof Answer.Type

const invalidAnswer = (id: string, message: string): ClassifierError =>
  new ClassifierError({ code: "invalid_answer", message: `Answer to "${id}": ${message}` })

const isUnitInterval = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1

const distribution = (
  keys: ReadonlyArray<string>,
  chosen: string,
  given: Readonly<Record<string, number>> | undefined,
  aliases: (index: number) => ReadonlyArray<string>
): Result.Result<Readonly<Record<string, number>>, string> => {
  const probabilities: Record<string, number> = Object.create(null)
  for (const [index, key] of keys.entries()) {
    const provided = given === undefined
      ? undefined
      : aliases(index).map((alias) => Object.hasOwn(given, alias) ? given[alias] : undefined).find((value) =>
        value !== undefined
      )
    const probability = provided ?? (given === undefined && key === chosen ? 1 : 0)
    if (!isUnitInterval(probability)) return Result.fail(`probability of "${key}" is ${probability}`)
    probabilities[key] = probability
  }
  return Result.succeed(probabilities)
}

const decodeOne = (
  id: string,
  question: BooleanQuestion | ChoiceQuestion | ScoreQuestion,
  raw: Evaluator.RawAnswer | undefined
): Result.Result<Answer, ClassifierError> => {
  if (raw === undefined) return Result.fail(invalidAnswer(id, "the transport answered nothing"))
  if (raw.type !== question.type) {
    return Result.fail(invalidAnswer(id, `expected a ${question.type} answer, got ${raw.type}`))
  }
  switch (raw.type) {
    case "boolean": {
      if (!isUnitInterval(raw.probability)) {
        return Result.fail(invalidAnswer(id, `probability is ${raw.probability}`))
      }
      return Result.succeed({ value: raw.probability >= 0.5, probability: raw.probability })
    }
    case "choice": {
      const keys = Object.keys((question as ChoiceQuestion).criteria)
      if (!keys.includes(raw.choice)) return Result.fail(invalidAnswer(id, `"${raw.choice}" is not an option`))
      const probabilities = distribution(keys, raw.choice, raw.probabilities, (index) => [keys[index]!])
      if (Result.isFailure(probabilities)) return Result.fail(invalidAnswer(id, probabilities.failure))
      return Result.succeed({
        value: raw.choice,
        probabilities: probabilities.success,
        confidence: Math.max(...Object.values(probabilities.success))
      })
    }
    case "score": {
      const rungs = (question as ScoreQuestion).criteria
      if (!Number.isFinite(raw.score) || raw.score < 0 || raw.score > rungs.length - 1) {
        return Result.fail(invalidAnswer(id, `score ${raw.score} is outside the ${rungs.length} rungs`))
      }
      const label = rungs[Math.round(raw.score)]!
      let probabilityKeys: ReadonlyArray<string> = rungs
      if (raw.probabilities !== undefined) {
        const supplied = Object.keys(raw.probabilities)
        const indexes = rungs.map((_, index) => String(index))
        const indexSet = new Set(indexes)
        // Choose one key space for the whole dictionary. A rung label may
        // itself be an index, so per-rung aliases can duplicate or swap mass.
        if (supplied.every((key) => indexSet.has(key))) {
          probabilityKeys = indexes
        } else {
          const labels = new Set(rungs)
          if (!supplied.every((key) => labels.has(key))) {
            return Result.fail(invalidAnswer(id, "score probabilities must use either rung indexes or rung labels"))
          }
        }
      }
      const probabilities = distribution(rungs, label, raw.probabilities, (index) => [probabilityKeys[index]!])
      if (Result.isFailure(probabilities)) return Result.fail(invalidAnswer(id, probabilities.failure))
      return Result.succeed({
        value: raw.score,
        label,
        probabilities: probabilities.success,
        confidence: Math.max(...Object.values(probabilities.success))
      })
    }
  }
}

/**
 * Decodes a transport's raw answers against the questions they answer.
 *
 * Every question needs an answer of its own type. A boolean's probability
 * and every distribution entry must lie in `[0, 1]`; a choice must name one
 * of its options; a score must lie within the rubric's index range. A
 * distribution the transport did not send is one-hot on the chosen option or
 * nearest rung, so confidence reads 1 and a caller that wants to tell the two
 * apart keeps the raw response. A score distribution uses one dictionary
 * format: all valid zero-based indexes, otherwise all declared labels.
 * Indexes take precedence when numeric labels make both formats valid.
 * Both the typed path and the ad-hoc path go through here.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export const decodeAnswers = <Qs extends Questions>(
  questions: Qs,
  raw: Evaluator.RawAnswers
): Effect.Effect<AnswersOf<Qs>, ClassifierError> =>
  Effect.suspend(() => {
    const answers: Record<string, Answer> = Object.create(null)
    for (const [id, question] of Object.entries(questions)) {
      const decoded = decodeOne(id, question, Object.hasOwn(raw, id) ? raw[id] : undefined)
      if (Result.isFailure(decoded)) return Effect.fail(decoded.failure)
      answers[id] = decoded.success
    }
    return Effect.succeed(answers as AnswersOf<Qs>)
  })

/**
 * How sure an answer is, from 0 to 1: a boolean's distance from even odds,
 * doubled; a choice's or score's `confidence`.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const confidence = (answer: Answer): number =>
  "probability" in answer ? Math.abs(answer.probability - 0.5) * 2 : answer.confidence

/**
 * The answer's value when its {@link confidence} is at or above `floor`,
 * else none.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const confident: {
  (answer: BooleanAnswer, floor: number): Option.Option<boolean>
  <Key extends string>(answer: ChoiceAnswer<Key>, floor: number): Option.Option<Key>
  <Label extends string>(answer: ScoreAnswer<Label>, floor: number): Option.Option<number>
  (answer: Answer, floor: number): Option.Option<boolean | string | number>
} = (answer: Answer, floor: number): Option.Option<any> =>
  confidence(answer) >= floor ? Option.some(answer.value) : Option.none()

/**
 * Options for {@link Classifier.evaluateAll}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface EvaluateAllOptions {
  /** How many states are in flight at once. Defaults to {@link defaultConcurrency}. */
  readonly concurrency?: number
}

/**
 * The concurrency `evaluateAll` uses when its options name none.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultConcurrency = 8

/**
 * A declared classifier: its identity, its schemas, and the two ways to ask.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Classifier<Id extends string, State extends Schema.Codec<any, any>, Qs extends Questions> {
  readonly id: Id
  readonly description: string
  readonly state: State
  readonly questions: Qs
  /** The SHA-256 of the canonical JSON of `{ id, questions }`. */
  readonly digest: string
  /** Asks every question about one state. */
  readonly evaluate: (state: State["Type"]) => Effect.Effect<AnswersOf<Qs>, ClassifierError, Evaluator.Evaluator>
  /**
   * Asks every question about each state, one request per state, at most
   * `concurrency` in flight. Results keep the states' order and a failed
   * state never hides its neighbours.
   */
  readonly evaluateAll: (
    states: ReadonlyArray<State["Type"]>,
    options?: EvaluateAllOptions
  ) => Effect.Effect<ReadonlyArray<Result.Result<AnswersOf<Qs>, ClassifierError>>, never, Evaluator.Evaluator>
}

/**
 * Options for {@link make}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface MakeOptions<State extends Schema.Codec<any, any>, Qs extends Questions> {
  /** What the classifier judges, in one sentence; the catalog shows it. */
  readonly description: string
  /** The state each question is asked about. It is encoded before it is sent. */
  readonly state: State
  readonly questions: Qs
}

/**
 * The classifier failure an evaluator failure is: the same code, status,
 * and message. `@smthrs/std`'s `classify` flow maps its calls with it too.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const fromEvaluatorError = (error: Evaluator.EvaluatorError): ClassifierError =>
  new ClassifierError({
    code: error.code,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.resetAtEpochMillis === undefined ? {} : { resetAtEpochMillis: error.resetAtEpochMillis }),
    message: error.message
  })

/**
 * Declares a classifier. The digest is computed here, once, from the id and
 * the questions.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = <const Id extends string, State extends Schema.Codec<any, any>, const Qs extends Questions>(
  id: Id,
  options: MakeOptions<State, Qs>
): Classifier<Id, State, Qs> => {
  const { description, questions, state } = options
  // The encoded questions, not the questions: a class instance is not JSON,
  // and hashing the wire form is what keeps a digest — and every durable call
  // key and sealed-key preimage that folds it in — where it already is.
  const digest = Digest.digest(CanonicalJson.stringify({ id, questions: Evaluator.encodeQuestions(questions) }))
  const encodeState = Schema.encodeEffect(state)

  const evaluate = Effect.fn(`Classifier.evaluate(${id})`)((value: State["Type"]) =>
    Effect.gen(function*() {
      const evaluator = yield* Evaluator.Evaluator
      const encoded = yield* encodeState(value).pipe(
        Effect.mapError((error) => new ClassifierError({ code: "invalid_question", message: error.message }))
      )
      const response = yield* evaluator.evaluate({ state: encoded, questions }).pipe(
        Effect.mapError(fromEvaluatorError)
      )
      return yield* decodeAnswers(questions, response.answers)
    })
  )

  const evaluateAll = (
    states: ReadonlyArray<State["Type"]>,
    all: EvaluateAllOptions = {}
  ): Effect.Effect<ReadonlyArray<Result.Result<AnswersOf<Qs>, ClassifierError>>, never, Evaluator.Evaluator> =>
    Effect.forEach(states, (value) => Effect.result(evaluate(value)), {
      concurrency: all.concurrency ?? defaultConcurrency
    })

  return { id, description, state, questions, digest, evaluate, evaluateAll }
}
