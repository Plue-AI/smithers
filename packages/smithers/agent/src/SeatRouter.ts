/**
 * Jev picks the seat a run starts on, and its system-prompt variant, in one
 * call.
 *
 * A declared seat always wins: {@link route} asks nothing unless the flow
 * declared {@link Seat.auto}. An `auto` run asks once, at its start, over the
 * seats the host's {@link Catalog} offers, and a subagent routes on its own.
 * There is no confidence floor, and a judge that cannot answer fails the run
 * as {@link Seat.SeatUnrouted}: no default seat is ever picked instead.
 *
 * {@link durable} records the decision as a sealed step, so a replayed run is
 * served the seat it first started on.
 *
 * @since 1.0.0-rc.0
 */

import { Action } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Judgement from "@smthrs/harness/Judgement"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Seat from "./Seat.ts"

/**
 * One seat Jev may pick: an id the host's `SeatResolver` resolves (an alias,
 * `provider:model`, or a role) and what it is good for.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Candidate {
  readonly id: string
  readonly description: string
}

/**
 * One system-prompt variant: what kind of task it fits and the system text a
 * run picked for it is given.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Variant {
  readonly id: string
  readonly description: string
  readonly system: ReadonlyArray<string>
}

/**
 * What the host offers Jev: the seats it can resolve and the variants.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export interface Service {
  readonly candidates: Effect.Effect<ReadonlyArray<Candidate>, Seat.SeatUnresolved>
  readonly variants: ReadonlyArray<Variant>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export class Catalog extends Context.Service<Catalog, Service>()("@smthrs/agent/SeatRouter/Catalog") {}

/**
 * Provides {@link Catalog} from an implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (implementation: Service): Layer.Layer<Catalog> =>
  Layer.succeed(Catalog)(Catalog.of(implementation))

/**
 * The variants a host offers unless it declares its own.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultVariants: ReadonlyArray<Variant> = [
  {
    id: "change",
    description: "Change the workspace.",
    system: [
      "Edit the workspace to do what the task asks.",
      "Prove the change with a check whose result is recorded before you finish."
    ]
  },
  {
    id: "investigate",
    description: "Find something out without changing anything.",
    system: ["Read what the task needs and cite the files and lines you rely on.", "Change nothing."]
  },
  {
    id: "answer",
    description: "Reply to a question.",
    system: ["Reply only: the task needs an answer, not a change."]
  },
  {
    id: "review",
    description: "Judge a given diff.",
    system: ["Judge the diff you were given and cite each problem where it is.", "Make no edits."]
  }
]

/**
 * What Jev reads to pick: the task, the flow it runs as, and, for a subagent,
 * the seat and flow of the run that spawned it.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const State = Schema.Struct({
  /** The task, as `Judgement.task` carries it. */
  task: Schema.String,
  flow: Schema.String,
  description: Schema.String,
  capabilities: Schema.Array(Schema.String),
  parent: Schema.optionalKey(Schema.Struct({ seat: Schema.String, flow: Schema.String }))
})

/**
 * The decoded form of {@link State}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type State = typeof State.Type

/**
 * The instructions of the `seat` question.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const seatInstructions =
  "Which available model should run this whole task? Prefer the least expensive model that will finish it correctly; choose a stronger one for multi-file changes, unfamiliar code, long reasoning or high-risk work."

/**
 * The instructions of the `system` question.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const systemInstructions = "Which kind of work does this task ask for?"

type RouteClassifier = Classifier.Classifier<"seat/route", typeof State, Classifier.Questions>

const classifiers = new Map<string, RouteClassifier>()

/**
 * The `seat/route` classifier over one catalog: `seat` is a choice over the
 * candidates, and `system` a choice over the variants, each asked only when
 * there are at least two to choose from. The same catalog returns the same
 * classifier.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const classifierFor = (
  candidates: ReadonlyArray<Candidate>,
  variants: ReadonlyArray<Variant>
): RouteClassifier => {
  const key = JSON.stringify([
    candidates.map(({ description, id }) => [id, description]),
    variants.map(({ description, id }) => [id, description])
  ])
  const held = classifiers.get(key)
  if (held !== undefined) return held
  const criteria = (entries: ReadonlyArray<Candidate>) =>
    Object.fromEntries(entries.map(({ description, id }) => [id, description]))
  const made = Classifier.make("seat/route", {
    description: "Picks the model, and the kind of system prompt, one task runs with.",
    state: State,
    questions: {
      ...(candidates.length < 2
        ? {}
        : { seat: Classifier.choice({ instructions: seatInstructions, criteria: criteria(candidates) }) }),
      ...(variants.length < 2
        ? {}
        : { system: Classifier.choice({ instructions: systemInstructions, criteria: criteria(variants) }) })
    }
  })
  classifiers.set(key, made)
  return made
}

/**
 * The most seats one `seat` question can list.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maxCandidates = 255

/**
 * The JSON form of one {@link Decision}.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const DecisionSchema = Schema.Struct({
  seat: Schema.String,
  variant: Schema.NullOr(Schema.String),
  decidedBy: Schema.Literals(["jev", "declared", "only"]),
  /** The provider's own confidence in `seat`, absent when it sent none. */
  confidence: Schema.optional(Schema.Number),
  latencyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The seats offered; empty for a declared seat. */
  candidates: Schema.Array(Schema.String),
  /** What Jev was asked and answered; `null` when it was not asked. */
  asked: Schema.NullOr(Schema.Struct({
    classifier: Schema.String,
    digest: Schema.String,
    /**
     * The questions in their wire form: a question's own schema has checks
     * the engine cannot key a durable step on.
     */
    questions: Schema.Record(Schema.String, Schema.Json),
    state: Schema.Json,
    answers: AgentEvent.DecisionSettled.fields.answers,
    usage: AgentEvent.DecisionSettled.fields.usage
  }))
})

/**
 * Which seat a run starts on, which variant it is given, and who decided.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Decision = typeof DecisionSchema.Type

/**
 * What {@link route} decides for.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Input {
  /** The seat the flow declared; only {@link Seat.auto} asks Jev. */
  readonly declared: string
  readonly state: State
}

/**
 * Picks the run's seat and variant.
 *
 * A declared seat is kept and nothing is asked. Otherwise Jev picks among two
 * to {@link maxCandidates} candidates and, in the same call, among two or
 * more variants. The catalog's one candidate is taken without asking, and
 * Jev is asked only the variant when there are several.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const route = (input: Input): Effect.Effect<Decision, Seat.SeatUnrouted, Catalog> =>
  Effect.gen(function*() {
    if (input.declared !== Seat.auto) {
      return { seat: input.declared, variant: null, decidedBy: "declared", latencyMs: 0, candidates: [], asked: null }
    }
    const unrouted = (reason: Seat.SeatUnrouted["reason"], message: string) =>
      new Seat.SeatUnrouted({ seat: input.declared, reason, message })
    const catalog = yield* Catalog
    const candidates = yield* catalog.candidates.pipe(
      Effect.mapError((error) => unrouted("unconfigured", error.message))
    )
    const ids = candidates.map((candidate) => candidate.id)
    const variants = catalog.variants
    if (candidates.length === 0) return yield* unrouted("no_candidates", "The catalog offers no seat")
    if (candidates.length > maxCandidates) {
      return yield* unrouted(
        "too_many_candidates",
        `The catalog offers ${candidates.length} seats; Jev picks among at most ${maxCandidates}`
      )
    }
    const sole = variants.length === 1 ? variants[0]!.id : null
    const only = candidates.length === 1
    if (only && variants.length < 2) {
      return { seat: ids[0]!, variant: sole, decidedBy: "only", latencyMs: 0, candidates: ids, asked: null }
    }
    const reading = yield* Judgement.read(
      classifierFor(candidates, variants),
      { ...input.state, task: Judgement.task(input.state.task) }
    ).pipe(Effect.mapError((unjudged) => unrouted(unjudged.reason, unjudged.detail)))
    const answers = reading.answers as Readonly<Record<string, Classifier.ChoiceAnswer>>
    const { latencyMs, questions, ...rest } = reading.asked
    const asked = { ...rest, questions: Evaluator.encodeQuestions(questions) as Readonly<Record<string, Schema.Json>> }
    const seat = asked.answers.seat
    const confidence = seat !== undefined && "confidence" in seat ? seat.confidence : undefined
    return {
      seat: answers.seat?.value ?? ids[0]!,
      variant: answers.system?.value ?? sole,
      decidedBy: only ? "only" : "jev",
      ...(confidence === undefined ? {} : { confidence }),
      latencyMs,
      candidates: ids,
      asked
    }
  })

/**
 * {@link route} as a sealed step of the running flow: a replay is served the
 * recorded decision and asks Jev nothing. The key names the execution and
 * the purpose only, so editing a description does not re-route a run in
 * flight.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const durable = (
  input: Input,
  key: { readonly executionId: string; readonly purpose: string }
): Action.Action<typeof DecisionSchema, typeof Seat.SeatUnrouted, Catalog> =>
  Action.make({
    name: "agent/route-seat",
    success: DecisionSchema,
    error: Seat.SeatUnrouted,
    tier: "sealed",
    idempotencyKey: `seat/route:${key.executionId}:${key.purpose}`,
    execute: route(input)
  })

// The wire form was encoded from these questions by `route`.
const decodeQuestions = Schema.decodeUnknownSync(AgentEvent.DecisionSettled.fields.questions)

/**
 * The rows that journal a decision: `seat-routed` and the `decision-settled`
 * row of the reading for one Jev picked, `seat-routed` alone for the only
 * candidate, and none for a declared seat.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const events = (
  decision: Decision,
  at: { readonly scope: string; readonly modelId: string }
): ReadonlyArray<AgentEvent.AgentEvent> => {
  if (decision.decidedBy === "declared") return []
  const routed = new AgentEvent.SeatRouted({
    eventType: AgentEvent.eventType.seatRouted,
    scope: at.scope,
    declared: Seat.auto,
    seat: decision.seat,
    modelId: at.modelId,
    variant: decision.variant,
    candidates: decision.candidates,
    decidedBy: decision.decidedBy,
    ...(decision.confidence === undefined ? {} : { confidence: decision.confidence }),
    latencyMs: decision.latencyMs
  })
  if (decision.asked === null) return [routed]
  return [
    routed,
    Judgement.decision(
      { ...decision.asked, questions: decodeQuestions(decision.asked.questions), latencyMs: decision.latencyMs },
      { scope: at.scope, frame: 0, acted: true }
    )
  ]
}

/**
 * The system text of the variant `id` names: none for `null`, and
 * `undefined` for an id no variant has.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const variantText = (
  variants: ReadonlyArray<Variant>,
  id: string | null
): ReadonlyArray<string> | undefined => id === null ? [] : variants.find((variant) => variant.id === id)?.system
