/**
 * Offline judges for fixtures, answered from the evidence each classifier
 * sends.
 *
 * {@link layer} answers only the completion brake, and compares reported
 * commands with the evidence the brake received. {@link layerAll} answers
 * every classifier the agent asks, one {@link answer} per classifier, each
 * computed from the state it is sent. Neither is a general language judge and
 * neither must ever be a production default. Whole-host fixtures with other
 * classifiers must dispatch those question ids too;
 * flows/test/fixtures/scripted-judge.ts is the example. Unknown questions
 * fail closed rather than borrowing another classifier's probabilities.
 *
 * @since 1.0.0-rc.0
 */

import * as CompletionClaim from "@smthrs/harness/CompletionClaim"
import * as Relevance from "@smthrs/harness/Relevance"
import * as Supervisor from "@smthrs/harness/Supervisor"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SeatRouter from "./SeatRouter.ts"

type Answers = Readonly<Record<string, Evaluator.ScriptedAnswer>>

/**
 * One classifier's scripted answers to one request, or the outage reply when
 * its state is not what that classifier sends.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Answerer = (request: Evaluator.Request) => Effect.Effect<Answers, Evaluator.EvaluatorError>

/** What this fixture answers to any question it does not script. The message is the transport's own so a journal line, a
 * refused check row and a test all read the same words. */
const unscripted = (detail: string): Evaluator.EvaluatorError =>
  new Evaluator.EvaluatorError({ code: "unreachable", message: `No evaluator is installed on this host (${detail})` })

/**
 * Whether one completion claim reports work this run's record does not record.
 *
 * This is the whole verdict the completion brake still acts on, so it is read
 * from the evidence rather than declared. A claim reports work when it both
 * speaks of a run or its outcome — `ran`, `passed`, `exits`, `output` — and
 * names something to run: a backticked span, or a runner and its arguments.
 * The record is every command in `checksRun` plus the completing frame's
 * `lastCheck`. A named command the record carries on either side of a
 * containment is recorded; one it carries nowhere is the refusal.
 *
 * A mention with no run or result around it is not a report. A proposed
 * fixture's `argv`, a path that happens to end in `.mjs`, or a cited file are
 * all things a run is entitled to write about work it has not done, and the
 * question this answers is deliberately narrower than "is the claim true".
 */
const reportsUnrecordedWork = (evidence: {
  readonly claim: string
  readonly checksRun: ReadonlyArray<{ readonly command: string }>
  readonly lastCheck?: { readonly command: string } | undefined
}): boolean => {
  const claim = evidence.claim
  if (
    !/\b(ran|run|runs|passed|passes|passing|failed|fails|executed|exited|exits|output|succeeded|green)\b/i.test(claim)
  ) {
    return false
  }
  const named = [
    ...[...claim.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!),
    ...[
      ...claim.matchAll(
        /\b(?:node|npm|pnpm|bun|yarn|python3?|cargo|make|jj|git|bash|sh|pytest|vitest|jest|tsc)\s+[^\n"'`,;)}\]]*/g
      )
    ]
      .map((match) => match[0])
  ].map((value) => value.trim()).filter((value) => value !== "" && !/^[\w*-]+:[\w*-]+:/.test(value))
  if (named.length === 0) return false
  const record = [
    ...evidence.checksRun.map((check) => check.command),
    ...(evidence.lastCheck ? [evidence.lastCheck.command] : [])
  ]
  return named.some((command) => !record.some((entry) => entry.includes(command) || command.includes(entry)))
}

/** `request.state` decoded by `schema`, or the outage reply naming what `judge` needed. */
const decoded = <S extends Schema.Decoder<unknown>>(schema: S, judge: string, request: Evaluator.Request) =>
  Effect.fromResult(Schema.decodeUnknownResult(schema)(request.state)).pipe(
    Effect.mapError(() => unscripted(`scripted ${judge} judge cannot read this state`))
  )

/** The lowercase words of four or more characters in `text`. */
const words = (text: string): ReadonlySet<string> => new Set(text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])

const shares = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => [...a].some((word) => b.has(word))

/** The envelope `Relevance.flowItem` puts around a description, and its capability line, which are not the item's words. */
const envelope =
  /^External metadata [^\n]*\n<untrusted-data>\nProvenance: [^\n]*$|^<\/untrusted-data>$|^capabilities: .*$/gm

const RelevanceState = Schema.Struct({ context: Relevance.Context, items: Schema.Array(Relevance.Item) })

const CompactionState = Schema.Struct({ items: Schema.Array(Schema.Struct({ observed: Schema.String })) })

const skillPrefix = `${Supervisor.monitorPrefix}skill_`

/** The skill a skill monitor's question asks about, by its index in the snapshot. */
const skillIndex = /\bskills\[(\d+)\]/

/** The eleven fixed supervisor answers for a snapshot that repeats `repeatFrames` frames. */
const calm = (repeatFrames: number): Answers => ({
  thrashing: { probability: repeatFrames > 1 ? 0.9 : 0.1 },
  on_target: { probability: 0.9 },
  suspect: { probability: 0.1 },
  outdated_context: { probability: 0.1 },
  irrelevant_context: { probability: 0.1 },
  ...Object.fromEntries(Supervisor.emotions.map((emotion) => [emotion, { score: 0 }])),
  needs_help: { choice: "none" }
})

/**
 * One answerer per classifier. {@link layer} and {@link layerAll} dispatch to
 * these by question id; a fixture that scripts its own classifiers calls them
 * for the agent's.
 *
 * @category answerers
 * @since 1.0.0-rc.0
 */
export const answer: {
  /**
   * The completion brake's three answers, from one reading of one evidence
   * record.
   *
   * `invented` is the only one with a verdict behind it: whether the claim
   * reports work this run's record does not record. `complete` and
   * `overclaims` are bounce heights that decide nothing — `CompletionClaim`'s
   * own corpus demoted them because neither separates an honest completion
   * from a lie — so they are answered consistently with the one reading: a
   * claim that reports work nothing recorded is also a claim that overclaims
   * and has not shown the task done, and a claim that does not is neither.
   * Answering them at no demand keeps a fixture's measured model-call counts
   * honest, since a bounce spends a frame that a fixed script would answer
   * with the same sentence.
   *
   * `sentence${i}` per sentence, when the brake reads a long claim one
   * sentence at a time: the same `invented` reading, of that sentence alone.
   */
  readonly completion: Answerer
  /**
   * `unnecessary_${i}` per item. A flow or skill is unnecessary (0.95) when
   * neither its name nor any of its words of four or more characters appears
   * in the task, query or recent text; an instruction chunk or memory row
   * when it shares no such word with them. Anything else is needed (0.05).
   */
  readonly relevance: Answerer
  /**
   * `remove_${i}` and `keep_${i}` per frame: removable (0.9) when what it
   * observed is byte-identical to what a later frame observed, else 0.1;
   * never worth keeping verbatim (0.1).
   */
  readonly compaction: Answerer
  /**
   * `seat`, when asked: the first candidate, in sorted order, whose
   * description shares a word with the task (0.9), else the first candidate
   * (0.6). `system`, when asked: `change` when the task says fix or
   * implement, else `investigate`.
   */
  readonly route: Answerer
  /**
   * A calm run: thrashing only when more than one frame repeated, on target,
   * nothing suspect, outdated or irrelevant, every emotion `none`, and nothing
   * needed from a person. No candidate is remembered (0.1). A skill monitor
   * fires (0.9) while the run has not called the skill it asks about; every
   * other monitor stays quiet (0.05).
   */
  readonly supervisor: Answerer
} = {
  completion: (request) =>
    decoded(CompletionClaim.Evidence, "completion", request).pipe(Effect.map((evidence) => {
      const ids = Object.keys(request.questions)
      if (every(ids, sentence)) {
        return Object.fromEntries(ids.map((id) => {
          const claim = CompletionClaim.sentenceOf(request.questions[id]!.instructions)
          return [id, { probability: reportsUnrecordedWork({ ...evidence, claim }) ? 0.95 : 0.02 }]
        }))
      }
      const unrecorded = reportsUnrecordedWork(evidence)
      return {
        complete: { probability: unrecorded ? 0.05 : 0.95 },
        overclaims: { probability: unrecorded ? 0.95 : 0.05 },
        invented: { probability: unrecorded ? 0.95 : 0.02 }
      }
    })),
  relevance: (request) =>
    decoded(RelevanceState, "relevance", request).pipe(Effect.map(({ context, items }) => {
      const said = [context.task, context.query ?? "", context.recent ?? ""].join("\n").toLowerCase()
      const known = words(said)
      return Object.fromEntries(items.map((item, index) => {
        const needed = item.kind === "flow" || item.kind === "skill"
          ? said.includes(item.id.toLowerCase()) || shares(words(item.text.replace(envelope, "")), known)
          : shares(words(item.text), known)
        return [`unnecessary_${index}`, { probability: needed ? 0.05 : 0.95 }]
      }))
    })),
  compaction: (request) =>
    decoded(CompactionState, "compaction", request).pipe(
      Effect.map(({ items }) =>
        Object.fromEntries(items.flatMap((item, index) => [
          [`remove_${index}`, {
            probability: items.slice(index + 1).some((later) => later.observed === item.observed) ? 0.9 : 0.1
          }],
          [`keep_${index}`, { probability: 0.1 }]
        ]))
      )
    ),
  route: (request) =>
    decoded(SeatRouter.State, "route", request).pipe(Effect.flatMap(({ task }) => {
      const system = /fix|implement/i.test(task) ? "change" : "investigate"
      const variant: Readonly<Record<string, Evaluator.ScriptedAnswer>> = "system" in request.questions
        ? { system: { choice: system, probabilities: { [system]: 0.9 } } }
        : {}
      const seat = request.questions["seat"]
      if (seat === undefined) return Effect.succeed(variant)
      if (seat.type !== "choice") return Effect.fail(unscripted("scripted route judge needs a seat choice"))
      const criteria = seat.criteria
      const candidates = Object.keys(criteria).sort()
      const said = words(task)
      const matched = candidates.find((id) => shares(words(criteria[id]!), said))
      const chosen = matched ?? candidates[0]!
      return Effect.succeed({
        seat: { choice: chosen, probabilities: { [chosen]: matched === undefined ? 0.6 : 0.9 } },
        ...variant
      })
    })),
  supervisor: (request) =>
    decoded(Supervisor.Snapshot, "supervisor", request).pipe(Effect.map((snapshot) => {
      const fixed = calm(snapshot.signals.repeatFrames)
      const unread = (id: string): boolean => {
        const asked = id.startsWith(skillPrefix) ? skillIndex.exec(request.questions[id]!.instructions) : null
        const skill = asked === null ? undefined : snapshot.skills[Number(asked[1])]
        return skill !== undefined && !snapshot.called.includes(skill.name)
      }
      return Object.fromEntries(
        Object.keys(request.questions).map((id) => [
          id,
          fixed[id] ?? { probability: id.startsWith("remember_") ? 0.1 : unread(id) ? 0.9 : 0.05 }
        ])
      )
    }))
}

const every = (ids: ReadonlyArray<string>, pattern: RegExp): boolean =>
  ids.length > 0 && ids.every((id) => pattern.test(id))

const sentence = /^sentence\d+$/

const isCompletion = (ids: ReadonlyArray<string>): boolean =>
  (ids.length === 3 && ["complete", "overclaims", "invented"].every((id) => ids.includes(id))) ||
  every(ids, sentence)

/**
 * The {@link answer} for a question-id set, or none for a set no classifier
 * asks.
 *
 * @category answerers
 * @since 1.0.0-rc.0
 */
export const answererFor = (ids: ReadonlyArray<string>): Answerer | undefined => {
  if (isCompletion(ids)) return answer.completion
  if (every(ids, /^unnecessary_\d+$/)) return answer.relevance
  if (every(ids, /^(?:remove|keep)_\d+$/)) return answer.compaction
  if (every(ids, /^(?:seat|system)$/)) return answer.route
  const fixed = Object.keys(calm(0))
  if (
    fixed.every((id) => ids.includes(id)) &&
    ids.every((id) => fixed.includes(id) || /^(?:remember|monitor)_/.test(id))
  ) return answer.supervisor
  return undefined
}

/** A layer that answers the id sets `pick` names and refuses every other. */
const dispatch = (pick: (ids: ReadonlyArray<string>) => Answerer | undefined, judge: string) =>
  Evaluator.layerScripted((request) => {
    const ids = Object.keys(request.questions)
    const answerer = pick(ids)
    return answerer === undefined
      ? Effect.fail(unscripted(`scripted ${judge} judge has no answer for ${ids.sort().join(", ")}`))
      : answerer(request)
  })

/**
 * Deliberately bind this only in an offline fixture whose reported commands
 * use the syntax above. An unrecorded command changes the verdict; no answer
 * is an unconditional permission to complete.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer: Layer.Layer<Evaluator.Evaluator> = dispatch(
  (ids) => isCompletion(ids) ? answer.completion : undefined,
  "completion"
)

/**
 * Every classifier the agent asks, each answered by its {@link answer}: the
 * completion brake, relevance, compaction marks, seat routing and the
 * supervisor. Bind this only in an offline fixture; a question-id set no
 * classifier asks fails `unreachable`.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerAll: Layer.Layer<Evaluator.Evaluator> = dispatch(answererFor, "offline")
