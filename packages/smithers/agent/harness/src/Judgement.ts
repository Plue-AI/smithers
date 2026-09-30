/**
 * The one way this package asks Jev a question.
 *
 * Every reading a control takes — the supervisor's, the completion brake's,
 * and every relevance, compaction, monitor and routing reading after them —
 * goes through here, so each is metered the same way and fails the same way.
 *
 * Two layers. {@link measured} asks through the bound `Evaluator` and keeps
 * what the classifier drops: the transport's usage, the provider's own
 * confidence, the state exactly as it was sent, and the wall-clock latency.
 * Its failure is the transport's own. {@link read} is the fail-closed layer
 * above it: a host with no `Evaluator` and a transport that could not answer
 * both fail as {@link Unjudged}, with a detail that is safe to journal. There
 * is no reading Jev did not make, and nothing here fills one in.
 *
 * {@link perItem} asks one set of questions about each of many items. Items
 * go in as few requests as fit {@link maxStateBytes}, in order, and a reading
 * is whole or it fails: one failed request fails every item, and partial
 * answers are never returned.
 *
 * {@link recorded} is how a reading taken inside a run is journaled: through
 * `EngineLike.record`, so a replayed frame is served what the first attempt
 * read and never asks again, with the `decision-settled` or
 * `decision-unjudged` rows {@link emitRecorded} journals beside it.
 *
 * @since 1.0.0-rc.0
 */

import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as AgentEvent from "./AgentEvent.ts"
import type * as EngineLike from "./EngineLike.ts"
import type { HarnessError } from "./HarnessError.ts"
import * as bytes from "./internal/bytes.ts"
import * as elide from "./internal/elide.ts"
import { paidUsage } from "./internal/paidUsage.ts"

/**
 * Why a reading could not be judged, and what went wrong in words safe to
 * journal. `reason` is `unconfigured`, `interrupted`, or the transport's own
 * error code; an `unreachable` detail is `Evaluator.unreachableMessage`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Unjudged {
  readonly reason: typeof AgentEvent.UnjudgedReason.Type
  readonly detail: string
}

/**
 * The failure of a reading on a host that binds no `Evaluator`.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const unconfigured: Unjudged = { reason: "unconfigured", detail: "No evaluator is installed on this host" }

/**
 * What one request asked and what came back, in the shape
 * `AgentEvent.DecisionSettled` carries.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Asked {
  /** The classifier's stable id. */
  readonly classifier: string
  /** `Classifier.digest`. */
  readonly digest: string
  readonly questions: Classifier.Questions
  /** The encoded state, as the transport was sent it. */
  readonly state: Schema.Json
  readonly answers: Readonly<Record<string, AgentEvent.DecisionAnswer>>
  /** Wall-clock milliseconds the evaluation took. */
  readonly latencyMs: number
  /** Token usage the transport reported, absent when it reported none. */
  readonly usage?: Evaluator.Usage | undefined
}

/**
 * One reading: the decoded answers and the record of asking.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Read<Qs extends Classifier.Questions> {
  readonly answers: Classifier.AnswersOf<Qs>
  readonly asked: Asked
}

/**
 * Asks every question of `classifier` about `state` through the bound
 * `Evaluator`, keeping the usage, the provider's confidence, the state as
 * sent and the latency. The transport's failure is kept as it is.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const measured = <Id extends string, S extends Schema.Codec<any, any>, Qs extends Classifier.Questions>(
  classifier: Classifier.Classifier<Id, S, Qs>,
  state: S["Type"]
): Effect.Effect<Read<Qs>, Classifier.ClassifierError, Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const bound = yield* Evaluator.Evaluator
    // The classifier returns answers only. The transport's accounting and the
    // provider's confidence are read at the service boundary, and so is the
    // state: a record of what was asked is of the encoding that crossed it.
    let usage: Evaluator.Usage | undefined
    let confidence: Readonly<Record<string, number>> | undefined
    let sent: Schema.Json = null
    const metered = Evaluator.Evaluator.of({
      evaluate: (request) =>
        bound.evaluate(request).pipe(Effect.tap((response) =>
          Effect.sync(() => {
            usage = response.usage
            confidence = response.confidence
            // A classifier state is a codec to JSON, so its encoding is JSON.
            sent = request.state as Schema.Json
          })
        ))
    })
    const [elapsed, answers] = yield* classifier.evaluate(state).pipe(
      Effect.provideService(Evaluator.Evaluator, metered),
      Effect.timed
    )
    return {
      answers,
      asked: {
        classifier: classifier.id,
        digest: classifier.digest,
        questions: classifier.questions,
        state: sent,
        answers: AgentEvent.decisionAnswers(answers, confidence),
        latencyMs: Math.round(Duration.toMillis(elapsed)),
        ...(usage === undefined ? {} : { usage })
      }
    }
  })

/**
 * Asks like {@link measured}, and fails as {@link Unjudged} whenever no
 * answer could be obtained: no `Evaluator` bound, a refusal, a deadline, an
 * answer that does not decode.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const read = <Id extends string, S extends Schema.Codec<any, any>, Qs extends Classifier.Questions>(
  classifier: Classifier.Classifier<Id, S, Qs>,
  state: S["Type"]
): Effect.Effect<Read<Qs>, Unjudged> =>
  Effect.gen(function*() {
    const bound = yield* Effect.serviceOption(Evaluator.Evaluator)
    if (Option.isNone(bound)) return yield* Effect.fail(unconfigured)
    return yield* measured(classifier, state).pipe(
      Effect.provideService(Evaluator.Evaluator, bound.value),
      // An unreachable transport's own message can name hosts and URLs.
      Effect.mapError((error): Unjudged => ({ reason: error.code, detail: Evaluator.publicMessage(error) }))
    )
  })

/**
 * The largest state one reading sends, in UTF-8 bytes of its JSON: the
 * ceiling the `jev` flow applies to a cell's own calls.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maxStateBytes = 262_144

/**
 * The questions {@link perItem} asks about each item, each built for the
 * item's index within its request.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ItemQuestions = Readonly<Record<string, (index: number) => Classifier.Question>>

/**
 * The answers {@link perItem} reads for one item, keyed as its questions are.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ItemAnswers<Qs extends ItemQuestions> = {
  readonly [Key in keyof Qs]: Classifier.AnswerOf<ReturnType<Qs[Key]>>
}

/**
 * What {@link perItem} declares.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface PerItemOptions<Ctx, Item, Qs extends ItemQuestions> {
  /** The classifier's stable id. */
  readonly id: string
  readonly description: string
  /** What every request carries beside its items. */
  readonly context: Schema.Codec<Ctx, any>
  readonly item: Schema.Codec<Item, any>
  /** Asked once per item; the question id is `${key}_${index}`. */
  readonly questions: Qs
  /** Requests in flight at once. Defaults to `Classifier.defaultConcurrency`. */
  readonly concurrency?: number | undefined
  /** The ceiling one request's state is packed under. Defaults to {@link maxStateBytes}. */
  readonly maxStateBytes?: number | undefined
}

/**
 * The state of one {@link perItem} request.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ItemState<Ctx, Item> {
  readonly context: Ctx
  readonly items: ReadonlyArray<Item>
}

/**
 * One per-item reading: an answer record per item, in input order, and the
 * record of every request it took.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ItemsRead<Qs extends ItemQuestions> {
  readonly answers: ReadonlyArray<ItemAnswers<Qs>>
  readonly asked: ReadonlyArray<Asked>
}

/**
 * A declared per-item reading.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface PerItem<Ctx, Item, Qs extends ItemQuestions> {
  /** The classifier for a request of `n` items; the same object for the same `n`. */
  readonly classifierFor: (
    n: number
  ) => Classifier.Classifier<string, Schema.Codec<ItemState<Ctx, Item>, any>, Classifier.Questions>
  /** Asks every question about every item; whole or failed. */
  readonly read: (context: Ctx, items: ReadonlyArray<Item>) => Effect.Effect<ItemsRead<Qs>, Unjudged>
}

/**
 * Declares one set of questions asked about each of many items.
 *
 * Items are packed in order, greedily, into requests whose encoded state fits
 * `maxStateBytes`, and each request numbers its items from 0. Requests run at
 * most `concurrency` at once, and the first that fails fails the reading. An
 * item too large to send even alone fails as `invalid_question`, and no items
 * send no request.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const perItem = <Ctx, Item, const Qs extends ItemQuestions>(
  options: PerItemOptions<Ctx, Item, Qs>
): PerItem<Ctx, Item, Qs> => {
  const limit = options.maxStateBytes ?? maxStateBytes
  const keys = Object.keys(options.questions)
  const state: Schema.Codec<ItemState<Ctx, Item>, any> = Schema.Struct({
    context: options.context,
    items: Schema.Array(options.item)
  })
  const encodeContext = Schema.encodeEffect(options.context)
  const encodeItem = Schema.encodeEffect(options.item)
  const cache = new Map<number, ReturnType<PerItem<Ctx, Item, Qs>["classifierFor"]>>()

  const classifierFor = (n: number): ReturnType<PerItem<Ctx, Item, Qs>["classifierFor"]> => {
    const held = cache.get(n)
    if (held !== undefined) return held
    const questions: Classifier.Questions = Object.fromEntries(
      Array.from({ length: n }, (_, index) => keys.map((key) => [`${key}_${index}`, options.questions[key]!(index)]))
        .flat()
    )
    const made = Classifier.make(options.id, { description: options.description, state, questions })
    cache.set(n, made)
    return made
  }

  const size = (value: unknown): number => bytes.size(JSON.stringify(value))

  const chunk = (context: Ctx, items: ReadonlyArray<Item>): Effect.Effect<Array<Array<Item>>, Unjudged> =>
    Effect.gen(function*() {
      const invalid = (error: { readonly message: string }): Unjudged => ({
        reason: "invalid_question",
        detail: error.message
      })
      const encoded = yield* encodeContext(context).pipe(Effect.mapError(invalid))
      // `{"context":…,"items":[]}`; each item adds its own bytes and, after
      // the first, one comma.
      const base = size({ context: encoded, items: [] })
      const chunks: Array<Array<Item>> = []
      let current: Array<Item> = []
      let used = base
      for (const [index, item] of items.entries()) {
        const width = size(yield* encodeItem(item).pipe(Effect.mapError(invalid)))
        if (base + width > limit) {
          return yield* Effect.fail<Unjudged>({
            reason: "invalid_question",
            detail: `Item ${index} alone makes a ${base + width}-byte state; one reading sends at most ${limit} bytes.`
          })
        }
        if (current.length > 0 && used + 1 + width > limit) {
          chunks.push(current)
          current = []
        }
        used = current.length === 0 ? base + width : used + 1 + width
        current.push(item)
      }
      // Called with at least one item, so the last request is never empty.
      chunks.push(current)
      return chunks
    })

  const readItems = (context: Ctx, items: ReadonlyArray<Item>): Effect.Effect<ItemsRead<Qs>, Unjudged> =>
    Effect.gen(function*() {
      if (items.length === 0) return { answers: [], asked: [] }
      const chunks = yield* chunk(context, items)
      const reads = yield* Effect.forEach(
        chunks,
        (slice) => read(classifierFor(slice.length), { context, items: slice }),
        { concurrency: options.concurrency ?? Classifier.defaultConcurrency }
      )
      const answers = reads.flatMap((reading, at) =>
        chunks[at]!.map((_, index) =>
          Object.fromEntries(
            keys.map((key) => [key, (reading.answers as Readonly<Record<string, unknown>>)[`${key}_${index}`]])
          ) as ItemAnswers<Qs>
        )
      )
      return { answers, asked: reads.map((reading) => reading.asked) }
    })

  return { classifierFor, read: readItems }
}

/**
 * The `decision-settled` row for one request. `decidedBy` is `jev`, and the
 * transport's usage is carried when it reported any.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const decision = (
  asked: Asked,
  at: { readonly scope: string; readonly frame: number; readonly acted: boolean }
): AgentEvent.DecisionSettled =>
  new AgentEvent.DecisionSettled({
    eventType: AgentEvent.eventType.decisionSettled,
    scope: at.scope,
    frame: at.frame,
    classifier: asked.classifier,
    digest: asked.digest,
    state: asked.state,
    questions: asked.questions,
    answers: asked.answers,
    latencyMs: asked.latencyMs,
    acted: at.acted,
    decidedBy: "jev",
    ...(asked.usage === undefined ? {} : { usage: asked.usage })
  })

/**
 * The `decision-unjudged` row for a reading that failed.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const unjudgedEvent = (
  unjudged: Unjudged,
  at: { readonly scope: string; readonly frame: number; readonly classifier: string; readonly items: number }
): AgentEvent.DecisionUnjudged =>
  new AgentEvent.DecisionUnjudged({
    eventType: AgentEvent.eventType.decisionUnjudged,
    scope: at.scope,
    frame: at.frame,
    classifier: at.classifier,
    reason: unjudged.reason,
    detail: unjudged.detail,
    items: at.items
  })

/**
 * What one {@link recorded} reading holds: the caller's value, or `null`
 * when the reading failed, and the rows to journal for it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Recorded<A> {
  readonly value: A | null
  readonly decisions: ReadonlyArray<AgentEvent.DecisionSettled>
  readonly unjudged: AgentEvent.DecisionUnjudged | null
}

/**
 * The durable schema of {@link Recorded} over the caller's value schema.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Recorded = <A>(value: EngineLike.DurableSchema<A>): EngineLike.DurableSchema<Recorded<A>> =>
  Schema.Struct({
    value: Schema.NullOr(value),
    decisions: Schema.Array(AgentEvent.DecisionSettled),
    unjudged: Schema.NullOr(AgentEvent.DecisionUnjudged)
  })

/**
 * Takes one reading inside a run as a durable boundary.
 *
 * `execute` runs once; its value is recorded with a `decision-settled` row
 * per request, or, when it fails, a `null` value with one `decision-unjudged`
 * row over `items`. A replayed frame is served the record and never asks.
 * `identity.session` is the rows' scope.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const recorded = <A>(
  engine: EngineLike.EngineLike,
  boundary: {
    readonly name: string
    readonly identity: EngineLike.BoundaryIdentity & { readonly session: string }
    readonly classifier: string
    readonly value: EngineLike.DurableSchema<A>
    readonly items: number
  },
  execute: Effect.Effect<
    { readonly value: A; readonly asked: ReadonlyArray<Asked>; readonly acted: boolean },
    Unjudged
  >
): Effect.Effect<Recorded<A>, HarnessError> => {
  const scope = boundary.identity.session
  const frame = boundary.identity.frame
  return engine.record({
    name: boundary.name,
    identity: boundary.identity,
    success: Recorded(boundary.value),
    // Each settled request is one metered reading; see `EngineLike.RecordBoundary.usage`.
    usage: (record) => paidUsage(record.decisions.map((settled) => settled.usage)),
    execute: Effect.match(execute, {
      onFailure: (unjudged): Recorded<A> => ({
        value: null,
        decisions: [],
        unjudged: unjudgedEvent(unjudged, { scope, frame, classifier: boundary.classifier, items: boundary.items })
      }),
      onSuccess: (settled): Recorded<A> => ({
        value: settled.value,
        decisions: settled.asked.map((asked) => decision(asked, { scope, frame, acted: settled.acted })),
        unjudged: null
      })
    })
  })
}

/**
 * Journals a {@link Recorded} reading: its decisions in order, then its
 * `decision-unjudged` row.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const emitRecorded = <E, R>(
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void, E, R>,
  record: Recorded<unknown>
): Effect.Effect<void, E, R> =>
  Effect.gen(function*() {
    for (const settled of record.decisions) yield* emit(settled)
    if (record.unjudged !== null) yield* emit(record.unjudged)
  })

/**
 * The most of a run's task one reading carries, in UTF-8 bytes; both ends
 * kept, for the reason `CompletionClaim` keeps both.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const taskBytes = 4096

/**
 * The task as a reading carries it, both ends kept.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const task = (text: string): string => elide.middle(text.trim(), taskBytes, "the run record has the whole task")
