/**
 * Routes a run to seats by the maintainer's routing graph: Jev classifies the
 * task, and a pure table picks the seats.
 *
 * A declared seat always wins: {@link route} asks nothing unless the flow
 * declared {@link Seat.auto}. An `auto` run asks Jev once, at its start, the
 * graph's edge questions (phase, size, clarity, binary success) and the
 * system-prompt variant in one call. {@link plan} maps the answers to a seat
 * or a panel, {@link backupsOf} gives each seat's failover order, and
 * {@link fit} keeps the seats the host's {@link Catalog} has available. A
 * judge that cannot answer, or a pick whose seats are all unavailable, fails
 * the run as {@link Seat.SeatUnrouted}: no default seat is ever picked instead.
 *
 * {@link durable} records the decision as a sealed step, so a replayed run is
 * served the route it first started on.
 *
 * @since 1.0.0-rc.0
 */

import { Action } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Judgement from "@smthrs/harness/Judgement"
import * as Classifier from "@smthrs/model/Classifier"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Seat from "./Seat.ts"

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
 * What the host offers: the graph {@link seats} its `SeatResolver` can run
 * here, and the variants.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export interface Service {
  readonly candidates: Effect.Effect<ReadonlyArray<string>, Seat.SeatUnresolved>
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
 * What Jev reads to pick: the task, and the flow it runs as.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const State = Schema.Struct({
  /** The task; {@link route} sends it as `Judgement.task` carries it. */
  task: Schema.String,
  flow: Schema.String,
  description: Schema.String,
  capabilities: Schema.Array(Schema.String)
})

/**
 * The decoded form of {@link State}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type State = typeof State.Type

/**
 * The seats the routing graph names, by their `Providers.seatAliases` names.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const seats = ["luna", "sol", "opus", "fable", "sonnet", "kimi"] as const

/**
 * One graph seat.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type GraphSeat = typeof seats[number]

/**
 * The phases of work the graph routes separately.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const phases = ["plan", "implement", "review", "ui", "tool", "other"] as const

/**
 * One phase of work.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Phase = typeof phases[number]

/**
 * Jev's answers to the graph's edge questions, with a pinned phase in place
 * of its answer.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Answers = Schema.Struct({
  phase: Schema.Literals(phases),
  size: Schema.Literals(["trivial", "simple", "middle", "important"]),
  clarity: Schema.Literals(["clear", "unknowns"]),
  /** Whether success is a binary yes or no. */
  binary: Schema.Boolean
})

/**
 * The decoded form of {@link Answers}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Answers = typeof Answers.Type

/**
 * What the graph picks for one set of answers: a seat, or a panel whose
 * members answer in parallel and whose merger, `seat`, merges them.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Planned {
  readonly seat: GraphSeat
  readonly panel?: { readonly seats: ReadonlyArray<GraphSeat>; readonly merger: GraphSeat }
}

const panel: Planned = { seat: "fable", panel: { seats: ["opus", "fable", "sol"], merger: "fable" } }

/**
 * The routing graph: the seat or panel one set of answers runs on. Writing
 * code never runs on Luna; Luna takes only trivial, clear tool work whose
 * success is binary. Work the graph does not list runs on Opus.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const plan = (answers: Answers): Planned => {
  const { binary, clarity, phase, size } = answers
  switch (phase) {
    case "plan":
      return size === "trivial"
        ? { seat: "sonnet" }
        : size === "simple"
        ? { seat: "opus" }
        : size === "middle"
        ? { seat: "fable" }
        : panel
    case "implement":
      return size === "important" && clarity === "unknowns"
        ? { seat: "fable" }
        : size === "important" || clarity === "unknowns"
        ? { seat: "opus" }
        : { seat: "sonnet" }
    case "review":
      return size === "important" ? panel : { seat: "opus" }
    case "tool":
      return binary && clarity === "clear" ? { seat: size === "trivial" ? "luna" : "sonnet" } : { seat: "opus" }
    case "ui":
    case "other":
      return { seat: "opus" }
  }
}

/**
 * The seats `seat` fails over to, in order, when its provider fails.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const backupsOf = (seat: GraphSeat, phase: Phase): ReadonlyArray<GraphSeat> =>
  seat === "fable"
    ? ["sol"]
    : seat === "opus"
    ? phase === "ui" ? ["kimi", "sol"] : ["sol"]
    : seat === "kimi"
    ? []
    : ["kimi"]

/**
 * The JSON form of one {@link Route}.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const RouteSchema = Schema.Struct({
  seat: Schema.String,
  /** The seats `seat` fails over to, in order. */
  backups: Schema.Array(Schema.String),
  /** The panel the task fans out to; `seat` is its merger. */
  panel: Schema.optionalKey(AgentEvent.SeatPanel)
})

/**
 * The seats a run starts on, over the seats a host has available.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Route = typeof RouteSchema.Type

/**
 * Keeps the available seats of a {@link Planned} pick: each seat becomes the
 * first available of itself and its {@link backupsOf}, the rest available
 * are its backups, and panel members that land on one seat are one member
 * with the union of their backups, in order, less the seats on the panel. A
 * panel left with one member is that member's seat and backups alone. `undefined` when the pick's
 * seat has nothing available.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const fit = (planned: Planned, phase: Phase, available: ReadonlyArray<string>): Route | undefined => {
  const chain = (seat: GraphSeat) => {
    const [first, ...backups] = [seat, ...backupsOf(seat, phase)].filter((id) => available.includes(id))
    return first === undefined ? undefined : { seat: first, backups }
  }
  const merger = chain(planned.seat)
  if (merger === undefined) return undefined
  if (planned.panel === undefined) return merger
  const members = new Map<string, { readonly seat: string; readonly backups: ReadonlyArray<string> }>()
  for (const seat of planned.panel.seats) {
    const member = chain(seat)
    if (member === undefined) continue
    // Two chains that land on one seat are one member with both chains' backups.
    const held = members.get(member.seat)?.backups ?? []
    members.set(member.seat, { seat: member.seat, backups: [...new Set([...held, ...member.backups])] })
  }
  // A panel left with one member is that member's chain alone.
  if (members.size < 2) return members.values().next().value ?? merger
  // A member never fails over to a seat that is already answering on the panel.
  const onPanel = [...members.keys()]
  const seats = [...members.values()].map(({ backups, seat }) => ({
    seat,
    backups: backups.filter((id) => !onPanel.includes(id))
  }))
  return { ...merger, panel: { seats, merger: merger.seat } }
}

/**
 * The instructions and criteria of the graph's edge questions.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const edgeQuestions = {
  phase: Classifier.choice({
    instructions: "Which kind of work is this task mostly?",
    criteria: {
      plan: "Produce a plan or design for work, not the work itself.",
      implement: "Write or change code.",
      review: "Judge existing work, such as a diff or a plan, without changing it.",
      ui: "Build or change a user interface or its visual design.",
      tool: "Drive tools to a result, such as running commands or calling services, with little writing.",
      other: "Anything else, such as answering a question or researching."
    }
  }),
  size: Classifier.choice({
    instructions: "How big and how important is this task?",
    criteria: {
      trivial: "One obvious step, such as a lookup or a one-line change.",
      simple: "A small, self-contained task.",
      middle: "Several steps or files, with ordinary risk.",
      important: "Complex, architectural, or high-stakes work where a mistake is costly."
    }
  }),
  clarity: Classifier.choice({
    instructions: "Is the approach clear?",
    criteria: {
      clear: "The task says or implies how to do it.",
      unknowns: "It has unknown unknowns, open design decisions, or real risk."
    }
  }),
  binary: Classifier.boolean({
    instructions: "Is success binary: one check says yes or no, such as a command passing or a file existing?"
  })
}

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
 * The `seat/route` classifier: the {@link edgeQuestions}, without `phase`
 * when the caller pinned it, and `system`, a choice over the variants asked
 * only when there are at least two. The same variants and pin return the
 * same classifier.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const classifierFor = (variants: ReadonlyArray<Variant>, pinned: boolean): RouteClassifier => {
  const key = JSON.stringify([variants.map(({ description, id }) => [id, description]), pinned])
  const held = classifiers.get(key)
  if (held !== undefined) return held
  const { phase, ...edges } = edgeQuestions
  const made = Classifier.make("seat/route", {
    description: "Classifies one task for the routing graph, and picks the kind of system prompt it runs with.",
    state: State,
    questions: {
      ...(pinned ? {} : { phase }),
      ...edges,
      ...(variants.length < 2 ? {} : {
        system: Classifier.choice({
          instructions: systemInstructions,
          criteria: Object.fromEntries(variants.map(({ description, id }) => [id, description]))
        })
      })
    }
  })
  classifiers.set(key, made)
  return made
}

/**
 * The JSON form of one {@link Decision}.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const DecisionSchema = Schema.Struct({
  ...RouteSchema.fields,
  variant: Schema.NullOr(Schema.String),
  decidedBy: Schema.Literals(["jev", "declared"]),
  /** The graph's inputs; `null` for a declared seat. */
  answers: Schema.NullOr(Answers),
  latencyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The seats available; empty for a declared seat. */
  candidates: Schema.Array(Schema.String),
  /** What Jev was asked and answered; `null` when it was not asked. */
  asked: Schema.NullOr(Schema.Struct({
    classifier: Schema.String,
    digest: Schema.String,
    questions: AgentEvent.DecisionSettled.fields.questions,
    state: Schema.Json,
    answers: AgentEvent.DecisionSettled.fields.answers,
    usage: AgentEvent.DecisionSettled.fields.usage
  }))
})

/**
 * The route a run starts on, the variant it is given, and who decided.
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
  /** The phase of work, when the caller knows it; Jev is then not asked it. */
  readonly phase?: Phase | undefined
  /**
   * `false` when the caller does not fan out: a panel pick routes to its
   * merger alone, so no panel is recorded that will not run.
   */
  readonly panel?: boolean | undefined
}

/**
 * Routes the run and picks its variant.
 *
 * A declared seat is kept and nothing is asked. Otherwise Jev answers the
 * edge questions and, in the same call, the variant among two or more; the
 * route is {@link fit} of {@link plan} over the catalog's seats, without the
 * panel when {@link Input.panel} is `false`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const route = (input: Input): Effect.Effect<Decision, Seat.SeatUnrouted, Catalog> =>
  Effect.gen(function*() {
    if (input.declared !== Seat.auto) {
      return {
        seat: input.declared,
        backups: [],
        variant: null,
        decidedBy: "declared",
        answers: null,
        latencyMs: 0,
        candidates: [],
        asked: null
      }
    }
    const unrouted = (reason: Seat.SeatUnrouted["reason"], message: string) =>
      new Seat.SeatUnrouted({ seat: input.declared, reason, message })
    const catalog = yield* Catalog
    const candidates = yield* catalog.candidates.pipe(
      Effect.mapError((error) => unrouted("unconfigured", error.message))
    )
    if (candidates.length === 0) return yield* unrouted("no_candidates", "The catalog offers no seat")
    const variants = catalog.variants
    const reading = yield* Judgement.read(
      classifierFor(variants, input.phase !== undefined),
      { ...input.state, task: Judgement.task(input.state.task) }
    ).pipe(Effect.mapError((unjudged) => unrouted(unjudged.reason, unjudged.detail)))
    const read = reading.answers as Readonly<Record<string, Classifier.ChoiceAnswer | Classifier.BooleanAnswer>>
    const choice = (id: string) => (read[id] as Classifier.ChoiceAnswer).value
    const answers = Schema.decodeUnknownSync(Answers)({
      phase: input.phase ?? choice("phase"),
      size: choice("size"),
      clarity: choice("clarity"),
      binary: (read.binary as Classifier.BooleanAnswer).value
    })
    const planned = plan(answers)
    const routed = fit(input.panel === false ? { seat: planned.seat } : planned, answers.phase, candidates)
    if (routed === undefined) {
      return yield* unrouted(
        "no_candidates",
        `None of ${[planned.seat, ...backupsOf(planned.seat, answers.phase)].join(", ")} is available here`
      )
    }
    const { latencyMs, ...asked } = reading.asked
    return {
      ...routed,
      variant: read.system === undefined ? variants.length === 1 ? variants[0]!.id : null : choice("system"),
      decidedBy: "jev",
      answers,
      latencyMs,
      candidates,
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

/**
 * The rows that journal a decision: `seat-routed`, with the route's backups
 * and panel, and the `decision-settled` row of Jev's reading; none for a
 * declared seat.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const events = (
  decision: Decision,
  at: { readonly scope: string; readonly modelId: string }
): ReadonlyArray<AgentEvent.AgentEvent> => {
  if (decision.decidedBy === "declared" || decision.asked === null) return []
  return [
    new AgentEvent.SeatRouted({
      eventType: AgentEvent.eventType.seatRouted,
      scope: at.scope,
      declared: Seat.auto,
      seat: decision.seat,
      modelId: at.modelId,
      variant: decision.variant,
      candidates: decision.candidates,
      decidedBy: decision.decidedBy,
      latencyMs: decision.latencyMs,
      ...(decision.backups.length === 0 ? {} : { backups: decision.backups }),
      ...(decision.panel === undefined ? {} : { panel: decision.panel })
    }),
    Judgement.decision(
      { ...decision.asked, latencyMs: decision.latencyMs },
      { scope: at.scope, frame: 0, acted: true }
    )
  ]
}

/**
 * The task a panel's merger is given: the task, each member's answer as
 * `seat: answer`, and the members that failed without one.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const mergePrompt = (
  task: string,
  answers: ReadonlyArray<readonly [seat: string, answer: string]>,
  failed: ReadonlyArray<string>
): string =>
  `${task}\n\nIndependent answers to this task, one per seat:\n\n${
    answers.map(([seat, answer]) => `${seat}: ${answer}`).join("\n\n")
  }\n\n` +
  (failed.length === 0 ? "" : `These seats failed and gave no answer: ${failed.join(", ")}.\n\n`) +
  "Merge them into the one best answer: keep what they agree on and settle where they differ."

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
