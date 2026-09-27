/**
 * What a compaction does with each old frame: keep it, squash it into the
 * summary, or remove it.
 *
 * {@link pins} fixes what must survive whatever Jev says: a summary is always
 * squashed, so a later summary extends it; steering and the person's messages
 * are kept, and so is the newest frame that ran each check still failing; a
 * frame that changed files is never removed; and the two halves of a tool
 * call and its result share one mark. {@link read} asks Jev two questions
 * about each segment, and {@link resolve} turns the answers into marks,
 * demoting the least-needed keeps until the kept frames fit the window.
 *
 * Marking is not compacting. The supervisor asks about each settled segment
 * off the loop's hot path, and the run stores each {@link Answer} in the
 * segment's {@link Facts}; nothing the model is sent changes. Only when the
 * budget forces a compaction are the pins taken and the stored answers
 * resolved, and a segment still unmarked then is asked about in that one
 * reading.
 *
 * Nothing here journals or compacts; the caller records the reading, and
 * journals `decision-unjudged` and squashes every frame when it fails.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import * as Classifier from "@smthrs/model/Classifier"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { InvalidStep } from "../Compaction.ts"
import * as ContextWindow from "../ContextWindow.ts"
import * as Judgement from "../Judgement.ts"
import * as bytes from "./bytes.ts"
import { pairBoundaries } from "./compactable.ts"
import * as elide from "./elide.ts"
import { NonNegativeSafeInt } from "./nonNegativeSafeInt.ts"

/**
 * One frame as Jev reads it: its size, the cell it ran, what the model said
 * beside it, and what it observed.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const Item = Schema.Struct({
  tokens: NonNegativeSafeInt,
  cell: Schema.String,
  prose: Schema.String,
  observed: Schema.String
})

/**
 * The decoded form of {@link Item}.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type Item = typeof Item.Type

/**
 * What every reading is told beside its items: the task and the labels of
 * the checks still failing.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const Context = Schema.Struct({ task: Schema.String, failing: Schema.Array(Schema.String) })

/**
 * The decoded form of {@link Context}.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type Context = typeof Context.Type

/**
 * Jev's answer about one item: the probabilities that it can be removed and
 * that its exact text must be kept.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const Answer = Schema.Struct({ remove: Schema.Number, keep: Schema.Number })

/**
 * The decoded form of {@link Answer}.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type Answer = typeof Answer.Type

/**
 * Jev's {@link Answer} about one transcript segment, named by the segment's
 * digest: what a supervisor reading marks and the next boundary stores.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const Marking = Schema.Struct({ digest: Schema.String, ...Answer.fields })

/**
 * The decoded form of {@link Marking}.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type Marking = typeof Marking.Type

/**
 * What the run knows of one transcript segment: the frame that wrote it,
 * whether it carries the person's messages, whether it changed files, the
 * labels of the checks it ran, and Jev's answer about it once a reading has
 * marked it.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const Facts = Schema.Struct({
  frame: NonNegativeSafeInt,
  person: Schema.Boolean,
  mutated: Schema.Boolean,
  checks: Schema.Array(Schema.String),
  answer: Schema.optionalKey(Answer)
})

/**
 * The decoded form of {@link Facts}.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type Facts = typeof Facts.Type

/**
 * Why a mark was not Jev's own.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const Pinned = Schema.Literals(["summary", "steering", "person", "failing", "mutated", "pair", "budget"])

/**
 * The decoded form of {@link Pinned}.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type Pinned = typeof Pinned.Type

/**
 * One segment's resolved mark, and why it was fixed when Jev did not choose
 * it.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const Marked = Schema.Struct({ mark: ContextWindow.Mark, pinned: Schema.optionalKey(Pinned) })

/**
 * The decoded form of {@link Marked}.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type Marked = typeof Marked.Type

/**
 * What {@link pins} fixes for one segment. `mark` is fixed and not asked;
 * `floor` is the weakest mark allowed; `pair` is the index of the first
 * segment of the tool-call span the segment shares a mark with.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Pin {
  readonly pin: Exclude<Pinned, "budget">
  readonly mark?: ContextWindow.Mark | undefined
  readonly floor?: ContextWindow.Mark | undefined
  readonly pair?: number | undefined
}

const rank: Readonly<Record<ContextWindow.Mark, number>> = { remove: 0, squash: 1, keep: 2 }

const stronger = (a: ContextWindow.Mark, b: ContextWindow.Mark): ContextWindow.Mark => rank[a] >= rank[b] ? a : b

/** Each prefix index's span: the index of the first segment of its tool-call span. */
const spans = (prefix: ReadonlyArray<ContextWindow.Segment>): ReadonlyArray<number> => {
  const unsafe = pairBoundaries(prefix)
  const starts: Array<number> = []
  for (let index = 0; index < prefix.length; index++) {
    starts.push(unsafe.has(index) ? starts[index - 1]! : index)
  }
  return starts
}

const own = (
  segment: ContextWindow.Segment,
  facts: Facts | undefined,
  newest: boolean
): Pin | undefined => {
  if (segment.kind === "summary") return { mark: "squash", pin: "summary" }
  if (segment.kind === "steering") return { mark: "keep", pin: "steering" }
  if (facts === undefined) return undefined
  if (facts.person) return { mark: "keep", pin: "person" }
  if (newest) return { mark: "keep", pin: "failing" }
  if (facts.mutated) return { floor: "squash", pin: "mutated" }
  return undefined
}

/**
 * What must survive of the first `prefixLength` of `segments`, the window's
 * compactable segments in order. `facts[i]` describes `segments[i]`, and is
 * absent for a segment no frame recorded; it is aligned by position, not by
 * digest, because two frames can be byte-identical.
 *
 * Of the segments that ran a check still failing, only the newest is kept: a
 * check that fails frame after frame would otherwise pin every run of it, and
 * no compaction could shrink the window. When that newest run is past the
 * prefix, no prefix segment is kept for it.
 *
 * A tool call and its result in different segments share the strongest
 * retention either holds: kept together when one is pinned keep, and never
 * below the other's floor.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const pins = (
  segments: ReadonlyArray<ContextWindow.Segment>,
  prefixLength: number,
  facts: ReadonlyArray<Facts | undefined>,
  failing: ReadonlyArray<string>
): ReadonlyArray<Pin | undefined> => {
  const prefix = segments.slice(0, prefixLength)
  const newest = new Set(
    failing.map((label) =>
      facts.reduce((last, entry, index) => entry?.checks.includes(label) === true ? index : last, -1)
    )
  )
  const owned = prefix.map((segment, index) => own(segment, facts[index], newest.has(index)))
  const starts = spans(prefix)
  return owned.map((pin, index) => {
    const start = starts[index]!
    const members = owned.filter((_, other) => starts[other] === start)
    if (members.length === 1) return pin
    if (members.some((member) => member?.mark === "keep")) {
      return { mark: "keep", pin: pin?.mark === "keep" ? pin.pin : "pair", pair: start }
    }
    if (pin?.mark !== undefined) return { ...pin, pair: start }
    const floors = members.flatMap((member) => member?.floor ?? member?.mark ?? [])
    if (floors.length === 0) return { pin: "pair", pair: start }
    const floor = floors.reduce(stronger)
    return { floor, pin: pin?.floor === floor ? pin.pin : "pair", pair: start }
  })
}

/**
 * The prefix indexes whose mark Jev is asked: those no pin fixes, in order.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const unpinned = (pinned: ReadonlyArray<Pin | undefined>): ReadonlyArray<number> =>
  pinned.flatMap((pin, index) => pin?.mark === undefined ? [index] : [])

/**
 * The most of an item's cell and prose a reading carries, head kept, and of
 * what it observed, tail kept; in UTF-8 bytes.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const fieldBytes = 1024

const recall = "the run record has the whole frame"

const headKept = (text: string): string => {
  const whole = bytes.size(text)
  if (whole <= fieldBytes) return text
  return elide.head(text, fieldBytes - bytes.size(`… [+${whole}b, ${recall}]`), recall)
}

const tailKept = (text: string): string => {
  const whole = bytes.size(text)
  if (whole <= fieldBytes) return text
  const kept = elide.tailSlice(text, fieldBytes - bytes.size(`[+${whole}b, ${recall}] …`))
  return `[+${whole - bytes.size(kept)}b, ${recall}] …${kept}`
}

/**
 * The reading: `remove_${i}` and `keep_${i}` per item, in as many requests as
 * the items need, asked together.
 *
 * Two booleans rather than one choice: a boolean always carries its
 * probability, and a choice without a distribution reads one-hot, so a floor
 * on it would guard nothing.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const reader = Judgement.perItem({
  id: "compaction/marks",
  description: "Decide which old frames of an agent run to keep, squash into a summary, or remove",
  context: Context,
  item: Item,
  questions: {
    remove: (i) =>
      Classifier.boolean({
        instructions:
          `Is items[${i}], an old frame of this run, no longer needed at all now that the context must shrink? The task, the person's messages and the latest frames stay regardless.`,
        criteria: {
          true:
            "it contributed nothing still needed: a superseded read, a repeated command, a dead end later frames abandoned",
          false: "something it established may still matter"
        }
      }),
    keep: (i) =>
      Classifier.boolean({
        instructions: `Will the exact text of items[${i}] be needed again?`,
        criteria: {
          true:
            "a file's current content, an exact error still unresolved, a decision or constraint the run still acts on",
          false: "a summary sentence is enough"
        }
      })
  }
})

/**
 * Asks Jev about `items`, in order. Cell and prose are sent head-kept and what was observed tail-kept,
 * each to {@link fieldBytes}. A reading is whole or it fails.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const read = (
  context: Context,
  items: ReadonlyArray<Item>
): Effect.Effect<
  { readonly answers: ReadonlyArray<Answer>; readonly asked: ReadonlyArray<Judgement.Asked> },
  Judgement.Unjudged
> =>
  reader.read(
    context,
    items.map((item) => ({
      tokens: item.tokens,
      cell: headKept(item.cell),
      prose: headKept(item.prose),
      observed: tailKept(item.observed)
    }))
  ).pipe(Effect.map((reading) => ({
    answers: reading.answers.map((answer) => ({
      remove: answer.remove.probability,
      keep: answer.keep.probability
    })),
    asked: reading.asked
  })))

/**
 * The window a compaction must leave room in. Kept prefix tokens, `suffix`
 * and a summary allowance must fit under
 * `contextWindow - reserve - keepRecent / 2`. `tokens[i]` is prefix segment
 * `i`'s size.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Budget {
  readonly contextWindow: number
  readonly reserve: number
  readonly keepRecent: number
  readonly suffix: number
  readonly tokens: ReadonlyArray<number>
}

/** Room left for the summary a squash produces. */
const summaryAllowance = 4000

/** Jev removes a frame at or above this probability, when it would not keep it. */
const removeAt = 0.8

/** Jev keeps a frame's exact text at or above this probability. */
const keepAt = 0.5

/**
 * The mark of every prefix segment. `answers` are {@link read}'s, for the
 * indexes {@link unpinned} names.
 *
 * A segment is removed only when Jev is sure it is not needed and would not
 * keep it, kept when Jev would keep it, and squashed otherwise; pins and
 * floors override Jev, and a tool-call span takes its strongest mark. Then,
 * while the kept segments do not fit the {@link Budget}, the unpinned keep
 * Jev was least sure of, the older on a tie, is squashed. Pins alone may
 * exceed the budget; the next frame's trigger compacts again.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const resolve = (
  answers: ReadonlyArray<Answer>,
  pinned: ReadonlyArray<Pin | undefined>,
  budget: Budget
): Result.Result<ReadonlyArray<Marked>, InvalidStep> => {
  const asked = unpinned(pinned)
  if (answers.length !== asked.length || budget.tokens.length !== pinned.length) {
    return Result.fail(
      new InvalidStep({ message: "The compaction answers and budget must describe every unpinned prefix segment" })
    )
  }
  const answered = new Map(asked.map((index, at) => [index, answers[at]!]))
  const marks: Array<Marked> = pinned.map((pin, index) => {
    if (pin?.mark !== undefined) return { mark: pin.mark, pinned: pin.pin }
    const { keep, remove } = answered.get(index)!
    const mark = keep >= keepAt ? "keep" : remove >= removeAt ? "remove" : "squash"
    return pin?.floor !== undefined && rank[pin.floor] > rank[mark]
      ? { mark: pin.floor, pinned: pin.pin }
      : { mark }
  })
  const unit = (index: number): number => pinned[index]?.pair ?? index
  for (const [index, marked] of marks.entries()) {
    const strongest = marks.filter((_, other) => unit(other) === unit(index)).map((other) => other.mark).reduce(
      stronger
    )
    if (pinned[index]?.mark === undefined && rank[strongest] > rank[marked.mark]) {
      marks[index] = { mark: strongest, pinned: "pair" }
    }
  }
  const limit = budget.contextWindow - budget.reserve - budget.keepRecent / 2
  let kept = marks.reduce((sum, marked, index) => marked.mark === "keep" ? sum + budget.tokens[index]! : sum, 0)
  const units = [...new Set(marks.map((_, index) => unit(index)))]
    .map((start) => ({ start, members: marks.flatMap((_, index) => unit(index) === start ? [index] : []) }))
    .filter(({ members }) =>
      members.some((index) => marks[index]!.mark === "keep") &&
      members.every((index) => pinned[index]?.mark === undefined)
    )
    .map(({ members, start }) => ({
      start,
      members,
      p: Math.max(...members.map((index) => answered.get(index)!.keep))
    }))
    .sort((a, b) => a.p - b.p || a.start - b.start)
  for (const { members } of units) {
    if (kept + budget.suffix + summaryAllowance <= limit) break
    // A span takes its strongest mark, so every member of a demotable one is kept.
    for (const index of members) {
      marks[index] = { mark: "squash", pinned: "budget" }
      kept -= budget.tokens[index]!
    }
  }
  return Result.succeed(marks)
}
