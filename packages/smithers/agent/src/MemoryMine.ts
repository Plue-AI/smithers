/**
 * What a finished run leaves behind for the next one.
 *
 * A run's transcript is mined once, at run end. Two things come out of it
 * deterministically: candidate facts, the paragraphs of prose the model wrote
 * around its cells, and decisions, the messages a person typed as steering.
 * One Jev reading, `memory/mine`, asks two booleans per candidate: whether it
 * is a durable fact about the repository a later run needs, and whether it
 * names factory work a person should track. Both accept at the calibrated
 * fact bar, `MemoryCalibration.initial.decisions.fact`.
 *
 * {@link write} is the one writer of a mined fact: redacted, keyed by
 * {@link noteId}, accepted, with the run as provenance. `Agent.run` calls
 * {@link settle} when `supervisor.remember` is on and a `Supervisor.Memory`
 * that can write is bound; the `memory/mine` file flow reads a finished run's
 * journal through {@link extract} and {@link judge}.
 *
 * @since 1.0.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as EngineLike from "@smthrs/harness/EngineLike"
import * as Judgement from "@smthrs/harness/Judgement"
import * as Supervisor from "@smthrs/harness/Supervisor"
import * as Redaction from "@smthrs/journal/Redaction"
import * as Bank from "@smthrs/memory/Bank"
import type * as MemoryError from "@smthrs/memory/MemoryError"
import type * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Wiki from "./internal/memory/wiki.ts"
import * as MemoryCalibration from "./MemoryCalibration.ts"

/**
 * The most paragraphs one reply offers as candidates.
 *
 * @category constants
 * @since 1.0.0
 */
export const paragraphLimit = 4

/**
 * The most candidates one run offers Jev, first seen first.
 *
 * @category constants
 * @since 1.0.0
 */
export const candidateLimit = 64

/**
 * The most decisions one run keeps, first seen first.
 *
 * @category constants
 * @since 1.0.0
 */
export const decisionLimit = 64

/**
 * The most characters one candidate carries.
 *
 * @category constants
 * @since 1.0.0
 */
export const candidateChars = 400

/**
 * The most characters one decision carries.
 *
 * @category constants
 * @since 1.0.0
 */
export const decisionChars = 500

/**
 * Where a run's decisions are appended, one `<item>.md` page per item, and
 * where `memory`'s wiki source reads them back as pages.
 *
 * @category constants
 * @since 1.0.0
 */
export const decisionsDirectory = Wiki.decisionsDirectory

/**
 * One transcript row: its sequence, its event type and its payload.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Row = Schema.Struct({ seq: Schema.Int, eventType: Schema.String, payload: Schema.Unknown })

/**
 * The decoded form of {@link Row}.
 *
 * @category models
 * @since 1.0.0
 */
export type Row = typeof Row.Type

/**
 * A sentence and the sequence of the row it came from.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Cited = Schema.Struct({ text: Schema.String, seq: Schema.Int })

/**
 * The decoded form of {@link Cited}.
 *
 * @category models
 * @since 1.0.0
 */
export type Cited = typeof Cited.Type

const settled = new Set(["control.agent.model-settled", "flows.harness.model-settled.v1"])
const steered = new Set(["control.agent.steering-drained", "flows.harness.steering-drained.v1"])

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? value as Readonly<Record<string, unknown>> : {}

/** A control-journal `text`, or a message's text parts. */
const textOf = (value: unknown): string | undefined => {
  const held = record(value)
  if (typeof held.text === "string") return held.text
  const content = held.content ?? record(held.message).content
  if (!Array.isArray(content)) return undefined
  return content.flatMap((part) => {
    const p = record(part)
    return p.type === "text" && typeof p.text === "string" ? [p.text] : []
  }).join("\n")
}

const redact = (text: string): string => String(Redaction.redact(text))

const clip = (text: string, chars: number): string => text.length > chars ? `${text.slice(0, chars - 1)}…` : text

/**
 * A fenced block of any info string, backticks or tildes, closed by a fence
 * of its own character at least as long, or running to the end of the text
 * when it is never closed, as CommonMark reads one.
 */
const fenced =
  /^ {0,3}(?:(`{3,})[^`\n]*$[\s\S]*?(?:^ {0,3}\1`*[ \t]*$|(?![\s\S]))|(~{3,})[^\n]*$[\s\S]*?(?:^ {0,3}\2~*[ \t]*$|(?![\s\S])))/gm

/**
 * The candidate paragraphs of one reply's prose. The whole text is redacted
 * first, so a secret is never cut in two by a clip, and every fenced block is
 * removed before the text is split on blank lines, so a blank line inside one
 * never frees its code as prose. Then the first {@link paragraphLimit}
 * paragraphs, each clipped to {@link candidateChars}.
 *
 * @category conversions
 * @since 1.0.0
 */
export const sentences = (prose: string): ReadonlyArray<string> =>
  redact(prose)
    .replace(fenced, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .slice(0, paragraphLimit)
    .map((paragraph) => clip(paragraph, candidateChars))

/**
 * The text a note id keys on: case, width and whitespace folded.
 *
 * @category conversions
 * @since 1.0.0
 */
export const normalize = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()

/**
 * The note id of `text` in `bank`.
 *
 * @category conversions
 * @since 1.0.0
 */
export const noteId = (bank: string, text: string): string => Digest.digest(`${bank}\0${normalize(text)}`)

/**
 * A run's transcript as it is read: candidates distinct by normalized text,
 * and decisions, each bounded.
 *
 * @category models
 * @since 1.0.0
 */
export interface Transcript {
  readonly candidates: Array<Cited>
  readonly decisions: Array<Cited>
  readonly seen: Set<string>
}

/**
 * An empty {@link Transcript}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const transcript = (): Transcript => ({ candidates: [], decisions: [], seen: new Set() })

/**
 * Reads one row into `into`: a settled reply's prose paragraphs as
 * candidates, a drained user message as a decision clipped to
 * {@link decisionChars}, anything else not at all. Both are redacted as the
 * journal redacts, whole, before anything is clipped.
 *
 * @category conversions
 * @since 1.0.0
 */
export const add = (into: Transcript, row: Row): void => {
  if (settled.has(row.eventType)) {
    const text = textOf(row.payload)
    if (text === undefined) return
    for (const sentence of sentences(Supervisor.prose(text))) {
      const key = normalize(sentence)
      if (into.seen.has(key) || into.candidates.length >= candidateLimit) continue
      into.seen.add(key)
      into.candidates.push({ text: sentence, seq: row.seq })
    }
  } else if (steered.has(row.eventType)) {
    const messages = record(row.payload).messages
    for (const message of Array.isArray(messages) ? messages : []) {
      const text = record(message).role === "user" ? textOf(message)?.trim() : undefined
      if (text && into.decisions.length < decisionLimit) {
        into.decisions.push({ text: clip(redact(text), decisionChars), seq: row.seq })
      }
    }
  }
}

/**
 * The candidates and decisions of a whole journal, in sequence order.
 *
 * @category conversions
 * @since 1.0.0
 */
export const extract = (rows: ReadonlyArray<Row>): {
  readonly candidates: ReadonlyArray<Cited>
  readonly decisions: ReadonlyArray<Cited>
} => {
  const into = transcript()
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) add(into, row)
  return { candidates: into.candidates, decisions: into.decisions }
}

/**
 * The `memory/mine` reading: two booleans per candidate.
 *
 * @category classifiers
 * @since 1.0.0
 */
export const reading = Judgement.perItem({
  id: "memory/mine",
  description:
    "Read the sentences a finished coding run wrote and decide which are durable facts about the repository and which name factory work a person should track.",
  context: Schema.Struct({ task: Schema.String }),
  item: Schema.Struct({ text: Schema.String }),
  questions: {
    durable: (index: number) =>
      Classifier.boolean({
        instructions:
          `Is items[${index}].text a durable fact about this repository that a later run needs: how the project builds, tests, is laid out, or behaves, stated plainly?`,
        criteria: {
          true: "a fact about the repository or its tooling a later run would otherwise rediscover",
          false: "a plan, a status line, a claim about this task, a value from this run, or nothing at all"
        }
      }),
    issue: (index: number) =>
      Classifier.boolean({
        instructions:
          `Does items[${index}].text name a defect or deferred work in the factory itself (a flow, a policy, a tool) that a person should track as an issue?`,
        criteria: {
          true: "a concrete defect or a named piece of deferred work in the factory",
          false: "anything else, including work on the task itself"
        }
      })
  }
})

/**
 * Whether a probability clears the calibrated fact bar.
 *
 * @category conversions
 * @since 1.0.0
 */
export const accepts = (p: number): boolean => MemoryCalibration.include(MemoryCalibration.initial.decisions.fact, p)

/**
 * What one reading accepted.
 *
 * @category models
 * @since 1.0.0
 */
export interface Judged {
  readonly facts: ReadonlyArray<Cited>
  readonly issues: ReadonlyArray<Cited>
  readonly asked: ReadonlyArray<Judgement.Asked>
}

/**
 * Asks Jev about every candidate, whole or failed. No candidates ask nothing.
 *
 * @category conversions
 * @since 1.0.0
 */
export const judge = (
  task: string,
  candidates: ReadonlyArray<Cited>
): Effect.Effect<Judged, Judgement.Unjudged, Evaluator.Evaluator> =>
  Effect.map(reading.read({ task }, candidates.map(({ text }) => ({ text }))), (read) => ({
    facts: candidates.filter((_, index) => accepts(read.answers[index]!.durable.probability)),
    issues: candidates.filter((_, index) => accepts(read.answers[index]!.issue.probability)),
    asked: read.asked
  }))

/**
 * Writes one fact to `bank`: redacted, keyed by {@link noteId}, accepted,
 * tagged `source:transcript`, with `runId` as provenance. A fact already
 * stored, however it was cased or spaced, is returned as it stands and never
 * written again: the store refuses a second note under one id with other
 * creation data, and the first run to learn a fact keeps it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const write = (
  store: MemoryStore.Service,
  input: { readonly bank: string; readonly runId: string; readonly text: string }
): Effect.Effect<MemoryStore.Note, MemoryError.MemoryError> =>
  Effect.gen(function*() {
    const namespace = yield* Bank.parse(input.bank)
    const text = redact(input.text)
    const id = noteId(input.bank, text)
    const held = yield* store.getNote({ id })
    if (held !== undefined) return held
    return yield* store.putNote({
      namespace,
      id,
      text,
      tags: ["source:transcript"],
      provenance: { runId: input.runId },
      status: "accepted"
    })
  })

/**
 * Mines a run's transcript at run end and writes what Jev accepts through
 * `memory`.
 *
 * The reading is a durable boundary, `memory-mine` at `frame`, so a replayed
 * run is served the recorded reading and never asks again. It returns the
 * rows to journal: the reading's `decision-settled` rows, or one
 * `decision-unjudged` row when Jev could not answer, in which case nothing is
 * written; then a `supervisor-memory-failed` row for each fact the store
 * refused. An engine that cannot record the reading writes nothing and
 * journals one `supervisor-memory-failed` row with the engine's account.
 * None of it fails the run, which has already resolved.
 *
 * @category constructors
 * @since 1.0.0
 */
export const settle = (input: {
  readonly engine: EngineLike.EngineLike
  readonly session: string
  readonly frame: number
  readonly task: string
  readonly candidates: ReadonlyArray<Cited>
  readonly memory: Supervisor.Memory
}): Effect.Effect<ReadonlyArray<AgentEvent.AgentEvent>, never, Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const failed = (detail: string) =>
      new AgentEvent.SupervisorMemoryFailed({
        eventType: AgentEvent.eventType.supervisorMemoryFailed,
        scope: input.session,
        frame: input.frame,
        operation: "remember",
        detail
      })
    if (input.candidates.length === 0) return []
    const services = yield* Effect.context<Evaluator.Evaluator>()
    const outcome = yield* Effect.result(Judgement.recorded(
      input.engine,
      {
        name: "memory-mine",
        identity: { session: input.session, frame: input.frame, boundary: "memory-mine" },
        classifier: reading.classifierFor(0).id,
        value: Schema.Array(Schema.String),
        items: input.candidates.length
      },
      Effect.map(judge(Judgement.task(input.task), input.candidates), (judged) => ({
        value: judged.facts.map((fact) => fact.text),
        asked: judged.asked,
        acted: judged.facts.length > 0
      })).pipe(Effect.provideContext(services))
    ))
    if (Result.isFailure(outcome)) return [failed(`${outcome.failure.code}: ${outcome.failure.message}`)]
    const recorded = outcome.success
    const events: Array<AgentEvent.AgentEvent> = [...recorded.decisions]
    if (recorded.unjudged !== null) events.push(recorded.unjudged)
    for (const text of recorded.value ?? []) {
      yield* input.memory.remember(text).pipe(
        Effect.catch((failure) => Effect.sync(() => void events.push(failed(failure.detail))))
      )
    }
    return events
  })
