/**
 * What a run is shown of the human-provided items it could be shown.
 *
 * Memory rows, catalog flows and skills, and chunks of instruction files such
 * as `AGENTS.md` are items. {@link judge} asks Jev one question about each:
 * is it unnecessary for the task as stated? An item is withheld only when Jev
 * says so with probability at or above {@link withholdAt}; everything else is
 * kept. A reading that cannot be judged keeps everything, and the caller
 * journals `decision-unjudged` for it: keeping is the rule, withholding is
 * the exception Jev must be confident of.
 *
 * Nothing here journals or filters a live catalog. {@link settled} is the row
 * a caller writes for a reading, and {@link render} the instruction block a
 * caller builds from what was kept.
 *
 * @since 1.0.0-rc.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as AgentEvent from "./AgentEvent.ts"
import * as bytes from "./internal/bytes.ts"
import * as elide from "./internal/elide.ts"
import { untrustedData } from "./internal/untrustedData.ts"
import * as Judgement from "./Judgement.ts"

/**
 * What an item is.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Kind = AgentEvent.RelevanceKind

/**
 * The decoded form of {@link Kind}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Kind = typeof Kind.Type

/**
 * One human-provided item a run could be shown.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Item = Schema.Struct({ kind: Kind, id: Schema.String, text: Schema.String })

/**
 * The decoded form of {@link Item}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Item = typeof Item.Type

/**
 * What every reading is told beside its items.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Context = Schema.Struct({
  task: Schema.String,
  query: Schema.optionalKey(Schema.String),
  recent: Schema.optionalKey(Schema.String)
})

/**
 * The decoded form of {@link Context}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Context = typeof Context.Type

/**
 * The probability of "unnecessary" at or above which an item is withheld.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const withholdAt = 0.9

/**
 * The `Classifier.confident` floor that is {@link withholdAt} for a boolean:
 * its confidence is its distance from even odds, doubled.
 */
const confidentAt = (withholdAt - 0.5) * 2

/**
 * The most of one item's text a reading carries, in UTF-8 bytes; the head
 * kept.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const itemBytes = 1024

/** The most of a flow's description an item carries, in UTF-8 bytes. */
const descriptionBytes = 512

const recall = "the rest is not shown"

/** `text` within `limit` bytes, its head kept and the cut stated. */
const headKept = (text: string, limit: number): string => {
  const whole = bytes.size(text)
  if (whole <= limit) return text
  // The notice names at most `whole` dropped bytes.
  return elide.head(text, limit - bytes.size(`… [+${whole}b, ${recall}]`), recall)
}

/**
 * The reading: one question per item, `unnecessary_${index}`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const reader = Judgement.perItem({
  id: "relevance/unnecessary",
  description: "Decide which provided items an agent run does not need",
  context: Context,
  item: Item,
  questions: {
    unnecessary: (i) =>
      Classifier.boolean({
        instructions:
          `Is items[${i}] unnecessary for the task as stated? Read context.task, and context.query or context.recent when present.`,
        criteria: {
          true: "nothing the task, context.query, or a step they plainly imply uses it, needs it, or must follow it",
          false: "the task, context.query, or a step they plainly imply may use it, need it, or must follow it"
        }
      })
  }
})

/**
 * Jev's verdict on one item. `p` is the probability it is unnecessary.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Verdict {
  readonly item: Item
  /** `Digest.digest` of the item's whole text. */
  readonly digest: string
  readonly p: number
  readonly withheld: boolean
}

/**
 * One reading: a verdict per item in input order, and the record of asking.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Reading {
  readonly verdicts: ReadonlyArray<Verdict>
  readonly asked: ReadonlyArray<Judgement.Asked>
  /** Wall-clock milliseconds the reading took. */
  readonly latencyMs: number
  /** Token usage summed over every request, absent when none reported any. */
  readonly usage?: Evaluator.Usage | undefined
}

/**
 * Asks Jev which of `items` the run does not need. Each item's text is sent
 * head-kept to {@link itemBytes}. No items ask nothing.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const judge = (context: Context, items: ReadonlyArray<Item>): Effect.Effect<Reading, Judgement.Unjudged> =>
  Effect.gen(function*() {
    const sent = items.map((item) => ({ ...item, text: headKept(item.text, itemBytes) }))
    const [elapsed, read] = yield* reader.read(context, sent).pipe(Effect.timed)
    const verdicts = items.map((item, index): Verdict => {
      const answer = read.answers[index]!.unnecessary
      return {
        item,
        digest: Digest.digest(item.text),
        p: answer.probability,
        withheld: Option.getOrElse(Classifier.confident(answer, confidentAt), () => false)
      }
    })
    const usages = read.asked.flatMap((asked) => asked.usage === undefined ? [] : [asked.usage])
    return {
      verdicts,
      asked: read.asked,
      latencyMs: Math.round(Duration.toMillis(elapsed)),
      ...(usages.length === 0 ? {} : {
        usage: {
          inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
          outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0)
        }
      })
    }
  })

/**
 * The `relevance-settled` row for a reading: ids and digests, never text.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const settled = (
  reading: Reading,
  at: { readonly scope: string; readonly frame: number; readonly source: AgentEvent.RelevanceSettled["source"] }
): AgentEvent.RelevanceSettled => {
  const row = (verdict: Verdict) => ({
    kind: verdict.item.kind,
    id: verdict.item.id,
    digest: verdict.digest,
    p: verdict.p
  })
  return new AgentEvent.RelevanceSettled({
    eventType: AgentEvent.eventType.relevanceSettled,
    scope: at.scope,
    frame: at.frame,
    source: at.source,
    withholdAt,
    kept: reading.verdicts.filter((verdict) => !verdict.withheld).map(row),
    withheld: reading.verdicts.filter((verdict) => verdict.withheld).map(row),
    latencyMs: reading.latencyMs,
    ...(reading.usage === undefined ? {} : { usage: reading.usage })
  })
}

/**
 * A catalog entry as an item: a `skill` when its body is markdown, else a
 * `flow`. Its description is untrusted data.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const flowItem = (descriptor: Descriptor.FlowDescriptor): Item => {
  const description = untrustedData(
    headKept(descriptor.description, descriptionBytes),
    `description of ${descriptor.name}`
  )
  const capabilities = descriptor.capabilities.length === 0
    ? ""
    : `\ncapabilities: ${[...descriptor.capabilities].sort().join(",")}`
  return {
    kind: descriptor.body._tag === "Markdown" ? "skill" : "flow",
    id: descriptor.name,
    text: `${descriptor.name}\n${description}${capabilities}`
  }
}

/**
 * One human-provided instruction file.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Document = Schema.Struct({ path: Schema.String, text: Schema.String })

/**
 * The decoded form of {@link Document}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Document = typeof Document.Type

/**
 * One piece of an instruction file, as {@link chunks} splits it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Chunk {
  /** `${path}#${n}`, `n` counting from 0 within the file. */
  readonly id: string
  readonly path: string
  readonly text: string
}

const heading = /^#{1,6}(?:[ \t]|$)/
const listItem = /^(?:[-*+] |\d+\. )/
const fence = /^[ \t]*```/
const blank = /^[ \t]*\r?$/
const indented = /^[ \t]/

const split = (document: Document): ReadonlyArray<Chunk> => {
  const pieces: Array<string> = []
  let fenced = false
  // A list item's chunk runs over its indented and wrapped lines, and ends at
  // the first unindented line after a blank one.
  let item = false
  let afterBlank = false
  for (const line of document.text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const bare = line.endsWith("\n") ? line.slice(0, -1) : line
    const starts = !fenced && pieces.length > 0 && (heading.test(bare) || listItem.test(bare) ||
      (item && afterBlank && !blank.test(bare) && !indented.test(bare)))
    if (!fenced && (heading.test(bare) || listItem.test(bare))) item = listItem.test(bare)
    else if (starts) item = false
    if (starts || pieces.length === 0) pieces.push(line)
    else pieces[pieces.length - 1] += line
    if (fence.test(bare)) fenced = !fenced
    afterBlank = !fenced && blank.test(bare)
  }
  return pieces.map((text, n) => ({ id: `${document.path}#${n}`, path: document.path, text }))
}

/**
 * Splits instruction files into the chunks a reading judges, in order.
 *
 * A chunk starts at each markdown heading and at each top-level list item,
 * whose indented and wrapped lines are its own. Every other line, blank lines
 * included, joins the chunk before it, and nothing inside a fence is split.
 * A file's chunks concatenate back to the file.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const chunks = (documents: ReadonlyArray<Document>): ReadonlyArray<Chunk> => documents.flatMap(split)

/**
 * The project-instructions block of every chunk not in `withheld`, in order.
 * A file whose every chunk is withheld is left out, and `""` is returned when
 * nothing is left.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const render = (documents: ReadonlyArray<Document>, withheld: ReadonlySet<string>): string => {
  const blocks = documents.flatMap((document) => {
    const all = split(document)
    const kept = all.filter((chunk) => !withheld.has(chunk.id))
    if (all.length > 0 && kept.length === 0) return []
    return [
      `<project_instructions path="${document.path}">\n${
        kept.map((chunk) => chunk.text).join("")
      }\n</project_instructions>`
    ]
  })
  return blocks.length === 0 ? "" : "Project-specific instructions and guidelines:\n\n" + blocks.join("\n\n")
}
