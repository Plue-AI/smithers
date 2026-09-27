/**
 * Declarative supervisor monitors: what one reading can put in front of the
 * run, and when.
 *
 * A monitor turns one {@link Supervisor.Reading} into a probability `p` and a
 * sentence. A {@link Questioned} monitor adds one boolean question to the
 * supervisor's single Jev call; a {@link Derived} monitor scores answers the
 * supervisor already asks and costs nothing. {@link evaluate} runs at reading
 * time and renders every crossed monitor's text against the reading's own
 * snapshot. {@link gate} runs later, at the recorded steering drain, against
 * the durable {@link Ledger}: it applies each monitor's streak, cooldown and
 * limit and delivers at most one message.
 *
 * Both halves are pure. Nothing here asks Jev, journals, or steers.
 *
 * @since 1.0.0-rc.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Classifier from "@smthrs/model/Classifier"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as AgentEvent from "./AgentEvent.ts"
import { NonNegativeSafeInt } from "./internal/nonNegativeSafeInt.ts"
import * as Supervisor from "./Supervisor.ts"

/**
 * What a monitor watches for.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Kind = typeof AgentEvent.MonitorKind.Type

/**
 * The fields every monitor declares.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Common {
  /** Matches {@link idPattern}; the question id is {@link questionId}. */
  readonly id: string
  readonly kind: Kind
  /** Crosses when `p >= at`; in `(0, 1]`. */
  readonly at: number
  /** Consecutive crossed readings before delivery. */
  readonly consecutive: number
  /** Frames after a delivery before the next one. */
  readonly cooldownFrames: number
  /** Deliveries per run. */
  readonly limit: number
  /** The higher priority takes the one slot. */
  readonly priority: number
  readonly say: (snapshot: Supervisor.Snapshot, reading: Supervisor.Reading) => string
}

/**
 * A monitor that adds one boolean question to the supervisor's Jev call.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Questioned extends Common {
  readonly _tag: "Questioned"
  readonly question: Classifier.BooleanQuestion
  /** Whether the question is asked of this snapshot; always when absent. */
  readonly applies?: (snapshot: Supervisor.Snapshot) => boolean
}

/**
 * A monitor scored from answers the supervisor already asks.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Derived extends Common {
  readonly _tag: "Derived"
  readonly score: (reading: Supervisor.Reading, snapshot: Supervisor.Snapshot) => number
}

/**
 * One declared monitor.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Monitor = Questioned | Derived

/**
 * The fields {@link make} fills from {@link budgets}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Budget = Pick<Common, "at" | "consecutive" | "cooldownFrames" | "limit" | "priority">

/**
 * A monitor as declared, with its budget optional.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Input = (Omit<Questioned, keyof Budget> | Omit<Derived, keyof Budget>) & Partial<Budget>

/**
 * The budget each kind starts from.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const budgets: Readonly<Record<Kind, Budget>> = {
  lint: { at: 0.8, consecutive: 1, cooldownFrames: 6, limit: 2, priority: 30 },
  mood: { at: 0.8, consecutive: 2, cooldownFrames: 6, limit: 2, priority: 20 },
  skill: { at: 0.85, consecutive: 1, cooldownFrames: 6, limit: 1, priority: 10 }
}

/**
 * The ids a monitor may take.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const idPattern = /^[a-z][a-z0-9_]{0,47}$/

/**
 * The classifier question id of one monitor.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const questionId = (id: string): keyof Supervisor.MonitorQuestions => `${Supervisor.monitorPrefix}${id}`

/**
 * Declares one monitor, filling any budget field from its kind's
 * {@link budgets}.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = (input: Input): Monitor => ({ ...budgets[input.kind], ...input })

/**
 * A monitor declaration that cannot be run.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class InvalidMonitor extends Schema.TaggedError<InvalidMonitor>()("@smthrs/harness/Monitor/InvalidMonitor", {
  id: Schema.String,
  message: Schema.String
}) {}

type Suppression = typeof AgentEvent.Suppression.Type

const count = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

/** Ids each supervisor reading declares itself: its skill monitors and the use-jev lint. */
const reserved = /^(?:skill_|use_jev$)/

const invalid = (monitor: Monitor, seen: ReadonlySet<string>): string | undefined => {
  if (!idPattern.test(monitor.id)) return `id must match ${idPattern.source}`
  if (reserved.test(monitor.id)) return "id is reserved"
  if (seen.has(monitor.id)) return "id is declared twice"
  if (!(monitor.at > 0 && monitor.at <= 1)) return `at ${monitor.at} is outside (0, 1]`
  for (const field of ["consecutive", "cooldownFrames", "limit"] as const) {
    if (!count(monitor[field])) return `${field} ${monitor[field]} is not a non-negative integer`
  }
  return undefined
}

/**
 * Admits a set of host monitors, or names the first one that cannot be run.
 * The ids each reading adds (`skill_*`, `use_jev`) are reserved.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const validate = (
  monitors: ReadonlyArray<Monitor>
): Effect.Effect<ReadonlyArray<Monitor>, InvalidMonitor> =>
  Effect.suspend(() => {
    const seen = new Set<string>()
    for (const monitor of monitors) {
      const message = invalid(monitor, seen)
      if (message !== undefined) return Effect.fail(new InvalidMonitor({ id: monitor.id, message }))
      seen.add(monitor.id)
    }
    return Effect.succeed(monitors)
  })

/**
 * The supervisor's own nudge as a monitor: it crosses exactly when
 * {@link Supervisor.crosses} does and says {@link Supervisor.nudge}, with no
 * streak, cooldown or limit.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const lint = (): ReadonlyArray<Monitor> => [
  make({
    _tag: "Derived",
    id: "supervisor",
    kind: "lint",
    at: 0.5,
    consecutive: 1,
    cooldownFrames: 0,
    limit: Number.MAX_SAFE_INTEGER,
    priority: 30,
    score: (reading) => Supervisor.crosses(reading) ? 1 : 0,
    say: Supervisor.nudge
  })
]

/**
 * What the `paranoid` monitor says.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const paranoidText = "Stance: paranoid. Treat your last result as wrong until a printed check shows it."

/**
 * What the `careful` monitor says.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const carefulText = "Stance: careful. No destructive or out-of-scope call; ask with ctx.park if unsure."

/**
 * What the `step_back` monitor says.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const stepBackText = "Stance: step back. Name the wrong assumption before the next edit."

/**
 * What the `clarify` monitor says.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const clarifyText = "Stance: unsure of the task. Restate it in one line and check it against the files."

const mood = (
  id: string,
  text: string,
  fires: (reading: Supervisor.Reading) => boolean,
  budget: Partial<Budget> = {}
): Monitor =>
  make({ _tag: "Derived", id, kind: "mood", ...budget, score: (reading) => fires(reading) ? 1 : 0, say: () => text })

/**
 * Stance monitors over the emotions and help the supervisor already reads.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const moods = (): ReadonlyArray<Monitor> => [
  mood(
    "paranoid",
    paranoidText,
    (reading) => reading.suspect >= Supervisor.suspectAt && reading.emotions.confident === "strong"
  ),
  mood(
    "careful",
    carefulText,
    (reading) => reading.emotions.scared === "strong" || reading.needsHelp === "risky_action"
  ),
  mood("step_back", stepBackText, (reading) => reading.emotions.frustrated === "strong", { consecutive: 2 }),
  mood("clarify", clarifyText, (reading) => reading.emotions.confused === "strong")
]

/**
 * The built-in monitors: {@link lint} then {@link moods}.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const defaults = (): ReadonlyArray<Monitor> => [...lint(), ...moods()]

const skillQuestions: Array<Classifier.BooleanQuestion> = []

/** The question about `skills[index]`, one object per index so the classifier is declared once. */
const skillQuestion = (index: number): Classifier.BooleanQuestion =>
  skillQuestions[index] ??= Classifier.boolean({
    instructions: `Would reading skills[${index}] now change what the run does next for the task as stated?`,
    criteria: {
      true:
        `the newest frames do the work skills[${index}] describes without having read it, or violate what it prescribes`,
      false: "unrelated, or the run already follows it"
    }
  })

const skillId = (name: string): string =>
  `skill_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`.slice(0, 48)

/**
 * What the skill monitor for `name` says.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const skillText = (name: string, path: string): string =>
  `Read skill \`${name}\` first: await ctx.call("read", { path: ${JSON.stringify(path)} })`

/**
 * One monitor per skill the snapshot offers, asking whether reading it now
 * would change what the run does next. Its id is `skill_` and the name made
 * safe, with a digest of the name after it when two names make the same id.
 * It says only the skill's name and path, never its description.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const skills = (snapshot: Supervisor.Snapshot): ReadonlyArray<Monitor> => {
  const seen = new Set<string>()
  return snapshot.skills.map((skill, index) => {
    const plain = skillId(skill.name)
    const id = seen.has(plain) ? `${plain.slice(0, 39)}_${Digest.digest(skill.name).slice(0, 8)}` : plain
    seen.add(id)
    const text = skillText(skill.name, skill.path)
    return make({ _tag: "Questioned", id, kind: "skill", question: skillQuestion(index), say: () => text })
  })
}

/**
 * What the `use_jev` monitor says.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const useJevText = "Judge those items with one jev call, one question per item."

const useJevQuestion = Classifier.boolean({
  instructions:
    "Do the newest frames print lists of items (files, hits, failures, candidates) and then choose among them by hand?",
  criteria: {
    true: "a frame prints several items and a later cell or its prose picks among them without a jev call",
    false: "no list is chosen from by hand, or the choice was a jev call"
  }
})

/**
 * The lint that nudges a run choosing among printed items by hand toward one
 * `jev` call, asked only while the run can call `jev`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const useJev = (): Monitor =>
  make({
    _tag: "Questioned",
    id: "use_jev",
    kind: "lint",
    at: 0.85,
    limit: 2,
    question: useJevQuestion,
    applies: (snapshot) => snapshot.jevAvailable,
    say: () => useJevText
  })

/**
 * The questions one snapshot adds to the supervisor's call, by
 * {@link questionId}: every {@link Questioned} monitor whose `applies` holds.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const questions = (
  monitors: ReadonlyArray<Monitor>,
  snapshot: Supervisor.Snapshot
): Supervisor.MonitorQuestions =>
  Object.fromEntries(
    monitors.flatMap((monitor) =>
      monitor._tag === "Questioned" && (monitor.applies === undefined || monitor.applies(snapshot))
        ? [[questionId(monitor.id), monitor.question] as const]
        : []
    )
  )

/**
 * One monitor's value in one reading.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Row {
  readonly id: string
  readonly kind: Kind
  readonly p: number
  readonly crossed: boolean
}

/**
 * A crossed monitor's message, rendered against the reading it crossed on.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Candidate {
  readonly id: string
  readonly kind: Kind
  readonly priority: number
  readonly p: number
  readonly text: string
}

/**
 * What one reading says about every monitor.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Evaluation {
  readonly rows: ReadonlyArray<Row>
  readonly candidates: ReadonlyArray<Candidate>
}

/**
 * Scores every monitor against one reading. A {@link Derived} monitor scores
 * itself; a {@link Questioned} monitor reads `values` by monitor id and has no
 * row when it was not asked.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const evaluate = (input: {
  readonly monitors: ReadonlyArray<Monitor>
  readonly reading: Supervisor.Reading
  readonly snapshot: Supervisor.Snapshot
  readonly values: Readonly<Record<string, number>>
}): Evaluation => {
  const rows: Array<Row> = []
  const candidates: Array<Candidate> = []
  for (const monitor of input.monitors) {
    const p = monitor._tag === "Derived" ? monitor.score(input.reading, input.snapshot) : input.values[monitor.id]
    if (p === undefined) continue
    const crossed = p >= monitor.at
    rows.push({ id: monitor.id, kind: monitor.kind, p, crossed })
    if (crossed) {
      candidates.push({
        id: monitor.id,
        kind: monitor.kind,
        priority: monitor.priority,
        p,
        text: monitor.say(input.snapshot, input.reading)
      })
    }
  }
  return { rows, candidates }
}

/**
 * One monitor's durable delivery state.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Entry = Schema.Struct({
  streak: NonNegativeSafeInt.annotate({ description: "Consecutive readings that crossed" }),
  delivered: NonNegativeSafeInt.annotate({ description: "Deliveries so far" }),
  lastFrame: Schema.Int.annotate({ description: "The frame of the last delivery; -1 never" })
})

/**
 * The decoded form of {@link Entry}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Entry = typeof Entry.Type

/**
 * Every monitor's delivery state, by monitor id.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Ledger = Schema.Record(Schema.String, Entry)

/**
 * The decoded form of {@link Ledger}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Ledger = typeof Ledger.Type

/**
 * The state of a monitor with no entry.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const fresh: Entry = { streak: 0, delivered: 0, lastFrame: -1 }

/**
 * What one drain delivers and withholds.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Gated {
  readonly message?: { readonly id: string; readonly text: string }
  readonly suppressed: ReadonlyArray<{ readonly id: string; readonly reason: Suppression }>
  readonly ledger: Ledger
}

/**
 * Decides, at the steering drain, which one crossed monitor is delivered.
 *
 * Each row moves its monitor's streak: up on a crossing, to zero otherwise; a
 * monitor with no row keeps it. Each candidate is then withheld for its
 * `streak`, its `cooldown` since the last delivery, or its `limit`, in that
 * order. Of the rest the highest priority, then the lower id, takes the one
 * slot and the others are withheld for `slot`. A candidate no monitor
 * declares is ignored.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const gate = (input: {
  readonly rows: ReadonlyArray<Row>
  readonly candidates: ReadonlyArray<Candidate>
  readonly monitors: ReadonlyArray<Monitor>
  readonly ledger: Ledger
  readonly frame: number
}): Gated => {
  const ledger: Record<string, Entry> = { ...input.ledger }
  for (const row of input.rows) {
    const entry = ledger[row.id] ?? fresh
    ledger[row.id] = { ...entry, streak: row.crossed ? entry.streak + 1 : 0 }
  }
  const declared = new Map(input.monitors.map((monitor) => [monitor.id, monitor] as const))
  const suppressed: Array<{ id: string; reason: Suppression }> = []
  const eligible: Array<Candidate> = []
  for (const candidate of input.candidates) {
    const monitor = declared.get(candidate.id)
    if (monitor === undefined) continue
    const entry = ledger[candidate.id] ?? fresh
    const reason: Suppression | undefined = entry.streak < monitor.consecutive
      ? "streak"
      : entry.lastFrame >= 0 && input.frame - entry.lastFrame < monitor.cooldownFrames
      ? "cooldown"
      : entry.delivered >= monitor.limit
      ? "limit"
      : undefined
    if (reason === undefined) eligible.push(candidate)
    else suppressed.push({ id: candidate.id, reason })
  }
  const [winner, ...losers] = [...eligible].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1))
  for (const loser of losers) suppressed.push({ id: loser.id, reason: "slot" })
  if (winner === undefined) return { suppressed, ledger }
  const entry = ledger[winner.id] ?? fresh
  ledger[winner.id] = { ...entry, delivered: entry.delivered + 1, lastFrame: input.frame }
  return { message: { id: winner.id, text: winner.text }, suppressed, ledger }
}
