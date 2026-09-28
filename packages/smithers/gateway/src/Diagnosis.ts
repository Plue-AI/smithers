/**
 * The run diagnosis: what happened to a run, computed from its own control
 * events.
 *
 * The old gateway answered this question with a `whatHappened` RPC that read
 * run rows, node-iteration rows, and attempt rows out of the engine database
 * and optionally asked an agent to narrate them. The rc.0 gateway serves the
 * same answer as a field of the `run-summary` projection, computed from the
 * ordered `ControlEvent` deltas `Control.watch` already publishes. Nothing
 * here opens a database, so a diagnosis read through a relay is the same
 * diagnosis a local reader computes.
 *
 * This is the one fold both surfaces read. `@smthrs/cli` `Forensics` calls
 * `digest` and adds what a terminal card needs on top of it: duplicate calls,
 * per-flow counts, the parked approval payload, and the declined-launch state
 * the wire vocabulary does not carry. The counts, the refusal aggregation, and
 * the clipping are therefore one implementation, not two that drift.
 *
 * @since 1.0.0
 */

import { ControlSchema } from "@smthrs/control"
import { HashMap } from "effect"
import { callEventKey, callScope, nativeCallEvent, nativeStepEvent, uniqueCallEvents } from "./internal/callEvents.ts"
import * as DigestIndex from "./internal/digestIndex.ts"
import { encodedBytes, recordDigestBytes } from "./internal/digestMemory.ts"
import * as NativeResolution from "./internal/nativeResolution.ts"

/**
 * Keeps one start and settlement per durable call identity, preferring a
 * committed native fact over telemetry at the first observation's position.
 * Unidentified legacy events remain distinct because their identity cannot
 * be recovered from flow names and inputs. Shared with CLI call counts.
 *
 * @since 1.0.0
 * @category projections
 */
export { uniqueCallEvents }

/**
 * Native fact normalization and stable call/checkpoint identities.
 * Incremental readers retain these keys to match the full history fold.
 *
 * @since 1.0.0
 * @category projections
 */
export { callEventKey, callScope, nativeCallEvent, nativeStepEvent } from "./internal/callEvents.ts"

/**
 * Finds an open call by ID, with name/FIFO fallback only for legacy starts.
 * Shared by gateway node output and the CLI's compatible flow/ordinal IDs.
 *
 * @since 1.0.0
 * @category projections
 */
export { openCallIndex } from "./internal/callEvents.ts"

/**
 * The run statuses a digest may report.
 *
 * `@smthrs/control` `ControlSchema.RunStatus` is the vocabulary; this is the
 * runtime set the fold checks a journaled kind against.
 *
 * @since 1.0.0
 * @category models
 */
export type RunStatus = ControlSchema.RunStatus

/**
 * Every `control.run.*` suffix that names a status rather than an operation.
 *
 * `@smthrs/control` journals `control.run.lineage`, `control.run.resume`,
 * `control.run.resumed`, `control.run.cancel-requested`, and
 * `control.run.pending` under the same prefix as the status transitions, and
 * `Lineage.derive` adds one more to every followed stream. Reading a status
 * off the prefix alone made a live run's verdict read `lineage` or `resume`,
 * so the fold accepts only the schema statuses a client may render.
 */
const runStatuses: ReadonlySet<string> = new Set(ControlSchema.RunStatus.literals)

/**
 * One refused flow call, aggregated by its refusal message.
 *
 * @since 1.0.0
 * @category models
 */
export interface Refusal {
  readonly message: string
  readonly count: number
}

/**
 * Everything the diagnosis computes from one run's events.
 *
 * @since 1.0.0
 * @category models
 */
export interface Digest {
  /** The last run status seen, or undefined before launch. */
  readonly status: RunStatus | undefined
  /** The journaled failure cause, when the run failed and recorded one. */
  readonly cause: string | undefined
  /** The model seat the last opened turn ran on. */
  readonly seat: string | undefined
  readonly turns: number
  readonly calls: number
  readonly callsFailed: number
  readonly editsAttempted: number
  readonly editsSucceeded: number
  /** Refusal messages, descending by count. */
  readonly refusals: ReadonlyArray<Refusal>
  readonly inputTokens: number
  readonly outputTokens: number
  /** The final assistant output, when the run resolved. */
  readonly finalOutput: string | undefined
  /** Root binding and committed native result, retained across bounded windows. */
  readonly nativeResolution?: NativeResolution.NativeResolution | undefined
  /** The pending ask's question, when the run parked for approval. */
  readonly parkedQuestion: string | undefined
  /** The earliest time a kind this fold handles occurred at. */
  readonly startedAt: number | undefined
  /** The latest time a kind this fold handles occurred at. */
  readonly endedAt: number | undefined
}

/** Flows whose calls count as edit attempts. */
const editFlows: ReadonlySet<string> = new Set(["write", "edit", "apply_patch"])

/**
 * Reads a payload as a record. Wire payloads are `Json`, so every field read
 * tolerates absence and the digest of a malformed journal is a sparse digest,
 * never a throw.
 *
 * @param value the payload to read
 * @since 1.0.0
 * @category conversions
 */
export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * Reads a payload field as a string, or nothing when it is not one.
 *
 * @param value the field to read
 * @since 1.0.0
 * @category conversions
 */
export const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

/**
 * Reads a payload field as a number, or nothing when it is not one.
 *
 * @param value the field to read
 * @since 1.0.0
 * @category conversions
 */
export const asNumber = (value: unknown): number | undefined => typeof value === "number" ? value : undefined

/**
 * Occurrence time: the payload's own stamp, else journal admission time.
 *
 * @param event the event to time
 * @since 1.0.0
 * @category conversions
 */
export const timeOf = (event: ControlSchema.ControlEvent): number =>
  asNumber(asRecord(event.payload).at) ?? event.occurredAt

/**
 * The first line, whichever line ending produced it. Splitting on `\n` alone
 * left the `\r` of a CRLF cause on the wire, and every reader of a one-line
 * field, here and in `@smthrs/cli` `Forensics`, wants the same answer.
 *
 * @param text the text to read one line of
 * @since 1.0.0
 * @category conversions
 */
export const firstLine = (text: string): string => {
  const index = text.search(/[\r\n]/)
  return index < 0 ? text : text.slice(0, index)
}

/**
 * Truncates to a display width, marking the cut.
 *
 * The cut is made on code points, never on UTF-16 code units. Slicing code
 * units splits an astral character in half and puts a lone surrogate on the
 * wire, where a Go decoder silently replaces it with U+FFFD and a strict
 * decoder rejects the whole frame; the result of this function is always well
 * formed. A clipped result is exactly `width` code points, so `width` 1 is the
 * ellipsis alone and `width` 0, or any negative width, is the empty string.
 *
 * @param text the text to clip
 * @param width the greatest number of code points to keep
 * @since 1.0.0
 * @category rendering
 */
export const clip = (text: string, width: number): string => {
  if (width <= 0) return ""
  const points = [...text]
  return points.length <= width ? text : `${points.slice(0, width - 1).join("")}…`
}

/** The mutable accumulator the fold below writes into. */
interface Accumulator {
  status: RunStatus | undefined
  cause: string | undefined
  seat: string | undefined
  turns: number
  calls: number
  callsFailed: number
  editsAttempted: number
  editsSucceeded: number
  inputTokens: number
  outputTokens: number
  finalOutput: string | undefined
  parkedQuestion: string | undefined
}

/**
 * Which events may write a run-level field.
 *
 * `uniqueCallEvents` normalizes a native step fact into the `control.agent.*`
 * event the step recorded, so this fold reads two streams at once: the run's
 * own, and one per step a module run dispatched. A step's record carries the
 * `step` object its checkpoint was written under, which is what `callScope`
 * reads; the run's own records carry none. Every run-level field therefore
 * belongs to one of three classes, and a new handler has to name its class
 * before it compiles:
 *
 * - `aggregate`: the field sums or counts what the whole run did, steps
 *   included, so a step's record contributes to it like any other.
 * - `root`: the field is the run's own answer or state, so only an unscoped
 *   record may set it. A step's record is skipped.
 * - scope dependent: the field means something only beside the scope that
 *   recorded it, so it is kept per scope rather than run wide. No field of
 *   this digest is one; `GatewayProjection.callHistory` holds the one that is,
 *   the seat a call ran on.
 *
 * The table, field by field:
 *
 * | Field                           | Class     | Why                                                        |
 * | ------------------------------- | --------- | ---------------------------------------------------------- |
 * | `turns`                         | aggregate | a turn a step opened is a turn this run opened             |
 * | `seat`                          | aggregate | the seat of the run's last opened turn, wherever it opened |
 * | `inputTokens`, `outputTokens`   | aggregate | a step spends the run's budget, so the run pays for it     |
 * | `calls`, `editsAttempted`       | aggregate | a call a step made is a call this run made                 |
 * | `callsFailed`, `editsSucceeded` | aggregate | the settlement of one of those calls                       |
 * | `refusals`                      | aggregate | the messages those settlements refused with                |
 * | `startedAt`, `endedAt`          | aggregate | a step runs inside the run's span, so its records widen it |
 * | `finalOutput`                   | root      | THE run's answer; a step's answer is the step's            |
 * | `parkedQuestion`                | root      | THE question the run is parked on                          |
 * | `status`, `cause`               | root      | THE run's terminal state, from `control.run.*` alone       |
 *
 * `status`, `cause` and `parkedQuestion` are root only by construction as well
 * as by this class: `StepFact.Fact` accepts an `eventType` matching
 * `^control\.agent\.[a-z-]+$`, so no step fact can normalize to a
 * `control.run.*` kind or to `control.approval.requested`.
 */
type Reach = "aggregate" | "root"

/** One kind's contribution, and the class of the fields it writes. */
interface Handler {
  readonly reach: Reach
  readonly apply: (accumulator: Accumulator, payload: Record<string, unknown>) => void
}

const handlers: Readonly<Record<string, Handler>> = {
  "control.agent.turn-opened": {
    reach: "aggregate",
    apply: (accumulator, payload) => {
      accumulator.turns += 1
      accumulator.seat = asString(payload.seat) ?? accumulator.seat
    }
  },
  "control.agent.model-settled": {
    reach: "aggregate",
    apply: (accumulator, payload) => {
      const usage = asRecord(payload.usage)
      accumulator.inputTokens += asNumber(usage.inputTokens) ?? 0
      accumulator.outputTokens += asNumber(usage.outputTokens) ?? 0
    }
  },
  "control.agent.cell-call-started": {
    reach: "aggregate",
    apply: (accumulator, payload) => {
      accumulator.calls += 1
      if (editFlows.has(asString(payload.flowName) ?? "")) accumulator.editsAttempted += 1
    }
  },
  "control.agent.resolved": {
    reach: "root",
    apply: (accumulator, payload) => {
      accumulator.finalOutput = asString(payload.text)
    }
  },
  "control.approval.requested": {
    reach: "root",
    apply: (accumulator, payload) => {
      accumulator.parkedQuestion = asString(payload.question)
    }
  }
}

/**
 * The kinds this fold handles, with the class each one's fields belong to.
 *
 * Exported so a test can hold the table above against the map rather than
 * trusting a comment, and so a new handler that names no class fails both the
 * compiler and that test.
 *
 * @since 1.0.0
 * @category models
 */
export const handlerReach: Readonly<Record<string, "aggregate" | "root">> = Object.fromEntries(
  Object.entries(handlers).map(([kind, handler]) => [kind, handler.reach])
)

/**
 * Computes the diagnosis facts for one run from its ordered control events.
 *
 * Total on purpose: an event this vocabulary does not know contributes
 * nothing rather than failing the fold.
 *
 * @param events the run's ordered control events
 * @since 1.0.0
 * @category constructors
 */
const rawDigest = (events: ReadonlyArray<ControlSchema.ControlEvent>): Digest => {
  const accumulator: Accumulator = {
    status: undefined,
    cause: undefined,
    seat: undefined,
    turns: 0,
    calls: 0,
    callsFailed: 0,
    editsAttempted: 0,
    editsSucceeded: 0,
    inputTokens: 0,
    outputTokens: 0,
    finalOutput: undefined,
    parkedQuestion: undefined
  }
  const refusalCounts = new Map<string, number>()
  let startedAt: number | undefined
  let endedAt: number | undefined
  let nativeResolution: NativeResolution.NativeResolution | undefined

  /**
   * Widens the span this digest reports.
   *
   * Only a kind this fold handles widens it. The gateway merges a keepalive
   * event whose kind no emitter uses into every followed `Watch` stream
   * (`GatewayServer.watchHeartbeatKind`), and a fold that let an unhandled kind
   * contribute its timestamp reported a run that ran for as long as it was
   * watched.
   */
  const observe = (at: number): void => {
    startedAt = startedAt === undefined ? at : Math.min(startedAt, at)
    endedAt = endedAt === undefined ? at : Math.max(endedAt, at)
  }

  for (const event of uniqueCallEvents(events)) {
    nativeResolution = NativeResolution.combine(nativeResolution, NativeResolution.fromEvent(event))
    const payload = asRecord(event.payload)
    const at = timeOf(event)
    const handler = Object.hasOwn(handlers, event.kind) ? handlers[event.kind] : undefined
    if (handler !== undefined) {
      // A step's record still widens the span it was recorded in, because the
      // step ran inside this run. Whether it may write the field is the
      // handler's class: a root-only field keeps the root's reading.
      observe(at)
      if (handler.reach === "aggregate" || callScope(event) === undefined) handler.apply(accumulator, payload)
      continue
    }
    if (event.kind === "control.agent.cell-call-settled") {
      observe(at)
      if (asString(payload.outcome) === "failure") {
        accumulator.callsFailed += 1
        const message = firstLine(asString(payload.message) ?? "unknown refusal")
        refusalCounts.set(message, (refusalCounts.get(message) ?? 0) + 1)
      } else if (editFlows.has(asString(payload.flowName) ?? "")) {
        accumulator.editsSucceeded += 1
      }
      continue
    }
    if (event.kind.startsWith("control.run.")) {
      const status = event.kind.slice("control.run.".length)
      if (!runStatuses.has(status)) continue
      observe(at)
      accumulator.status = status as RunStatus
      if (status === "failed") accumulator.cause = asString(payload.cause)
    }
  }

  return {
    ...accumulator,
    ...(nativeResolution === undefined ? {} : { nativeResolution }),
    refusals: [...refusalCounts.entries()]
      .map(([message, count]) => ({ message, count }))
      .sort((left, right) => right.count - left.count),
    startedAt,
    endedAt
  }
}

const counters = [
  "turns",
  "calls",
  "callsFailed",
  "editsAttempted",
  "editsSucceeded",
  "inputTokens",
  "outputTokens"
] as const
type ContributionValue = Partial<Pick<Digest, typeof counters[number] | "seat" | "startedAt" | "endedAt" | "refusals">>

const contributionValue = (value: Digest): ContributionValue => ({
  ...Object.fromEntries(counters.filter((counter) => value[counter] !== 0).map((counter) => [counter, value[counter]])),
  ...(value.seat === undefined ? {} : { seat: value.seat }),
  ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }),
  ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt }),
  ...(value.refusals.length === 0 ? {} : { refusals: value.refusals })
})

interface Contribution {
  readonly ordinal: number
  readonly authoritative: boolean
  readonly value: ContributionValue
}

interface DigestState {
  readonly base: Digest
  readonly writes: { readonly cause: boolean; readonly finalOutput: boolean; readonly parkedQuestion: boolean }
  readonly baseSeatOrdinal: number | undefined
  readonly baseRefusals: ReadonlyMap<string, number>
  readonly indexes: Indexes
  readonly contributions: HashMap.HashMap<string, Contribution>
  readonly contributionBytes: number
  readonly length: number
}

interface Indexes {
  readonly timings: DigestIndex.Index | undefined
  readonly refusals: HashMap.HashMap<string, DigestIndex.Index>
  readonly refusalBytes: number
}

const emptyIndexes = (): Indexes => ({ timings: undefined, refusals: HashMap.empty(), refusalBytes: 0 })
const refusalIndexBytes = (message: string, tree: DigestIndex.Index | undefined): number =>
  tree === undefined ? 0 : encodedBytes(message) + tree.bytes

const indexContribution = (indexes: Indexes, previous: Contribution | undefined, next: Contribution): Indexes => {
  let refusals = indexes.refusals
  let refusalBytes = indexes.refusalBytes
  for (const refusal of previous?.value.refusals ?? []) {
    if (next.value.refusals?.some((member) => member.message === refusal.message)) continue
    // Every previous refusal was indexed when its contribution was retained.
    const oldTree = HashMap.getUnsafe(refusals, refusal.message)
    const tree = DigestIndex.remove(oldTree, next.ordinal)
    refusalBytes += refusalIndexBytes(refusal.message, tree) - refusalIndexBytes(refusal.message, oldTree)
    refusals = tree === undefined
      ? HashMap.remove(refusals, refusal.message)
      : HashMap.set(refusals, refusal.message, tree)
  }
  for (const refusal of next.value.refusals ?? []) {
    if (previous?.value.refusals?.some((member) => member.message === refusal.message)) continue
    const old = HashMap.get(refusals, refusal.message)
    const oldTree = old._tag === "Some" ? old.value : undefined
    const tree = DigestIndex.set(oldTree, next.ordinal)
    refusalBytes += refusalIndexBytes(refusal.message, tree) - refusalIndexBytes(refusal.message, oldTree)
    refusals = HashMap.set(refusals, refusal.message, tree)
  }
  return {
    timings: DigestIndex.set(indexes.timings, next.ordinal, next.value.startedAt, next.value.endedAt),
    refusals,
    refusalBytes
  }
}

// Scalar contributions only: no model input, call output, or event body is
// retained. Weak associations keep the public Digest and its wire shape intact.
const digestStates = new WeakMap<Digest, DigestState>()
const remember = (value: Digest, state: DigestState): Digest => {
  digestStates.set(value, state)
  recordDigestBytes(
    value,
    encodedBytes(value) + (value === state.base ? 0 : encodedBytes(state.base)) +
      state.contributionBytes + (state.indexes.timings?.bytes ?? 0) + state.indexes.refusalBytes + encodedBytes({
        writes: state.writes,
        baseSeatOrdinal: state.baseSeatOrdinal,
        baseRefusals: [...state.baseRefusals],
        length: state.length
      })
  )
  return value
}

/**
 * A `control.run.*` verdict stamped with a run id other than `runId`, such as
 * a child's riding in the parent's events. It must not set the digested run's
 * status or failure cause. An unstamped verdict is the run's own.
 *
 * @param event the event to classify
 * @param runId the run being digested; omitted, no verdict is foreign
 * @category predicates
 * @since 1.0.0
 */
export const foreignVerdict = (event: ControlSchema.ControlEvent, runId: string | undefined): boolean =>
  runId !== undefined && event.runId !== undefined && event.runId !== runId && event.kind.startsWith("control.run.")

/**
 * Folds one event range, retaining compact identities for later combination.
 * Native facts supersede telemetry at its first position across ranges too.
 *
 * @param events the range to fold
 * @param runId the run being digested; a `control.run.*` verdict stamped with
 *   another run's id is skipped. Omitted, every verdict folds.
 * @category constructors
 * @since 1.0.0
 */
export const digest = (events: ReadonlyArray<ControlSchema.ControlEvent>, runId?: string): Digest => {
  if (runId !== undefined && events.some((event) => foreignVerdict(event, runId))) {
    events = events.filter((event) => !foreignVerdict(event, runId))
  }
  let contributions = HashMap.empty<string, Contribution>()
  let indexes = emptyIndexes()
  let contributionBytes = 0
  const baseEvents: Array<ControlSchema.ControlEvent> = []
  const baseRefusals = new Map<string, number>()
  const writes = { cause: false, finalOutput: false, parkedQuestion: false }
  let baseSeatOrdinal: number | undefined
  for (const [ordinal, event] of events.entries()) {
    const key = callEventKey(event)
    if (key === undefined) {
      baseEvents.push(event)
      if (event.kind === "control.run.failed") writes.cause = true
      if (callScope(event) === undefined) {
        if (event.kind === "control.agent.resolved") writes.finalOutput = true
        if (event.kind === "control.approval.requested") writes.parkedQuestion = true
      }
      const payload = asRecord(event.payload)
      if (event.kind === "control.agent.turn-opened" && asString(payload.seat) !== undefined) baseSeatOrdinal = ordinal
      if (event.kind === "control.agent.cell-call-settled" && payload.outcome === "failure") {
        const message = firstLine(asString(payload.message) ?? "unknown refusal")
        if (!baseRefusals.has(message)) baseRefusals.set(message, ordinal)
      }
      continue
    }
    const native = nativeStepEvent(event) ?? nativeCallEvent(event)
    const previous = HashMap.get(contributions, key)
    if (previous._tag === "Some" && (previous.value.authoritative || native === undefined)) continue
    const contribution = {
      ordinal: previous._tag === "Some" ? previous.value.ordinal : ordinal,
      authoritative: native !== undefined,
      value: contributionValue(rawDigest([native ?? event]))
    }
    contributionBytes += encodedBytes([key, contribution]) -
      (previous._tag === "Some" ? encodedBytes([key, previous.value]) : 0)
    contributions = HashMap.set(contributions, key, contribution)
    indexes = indexContribution(indexes, previous._tag === "Some" ? previous.value : undefined, contribution)
  }
  const value = rawDigest(events)
  return remember(value, {
    base: baseEvents.length === events.length ? value : rawDigest(baseEvents),
    writes,
    baseSeatOrdinal,
    baseRefusals,
    indexes,
    contributions,
    contributionBytes,
    length: events.length
  })
}

/**
 * The wall-clock span the events cover, rendered for a reader.
 *
 * Only the span is read, so a caller carrying a wider digest of its own, as
 * `@smthrs/cli` `Forensics` does, measures it with this rather than a copy.
 *
 * @param value the span to measure
 * @since 1.0.0
 * @category rendering
 */
export const duration = (value: Pick<Digest, "startedAt" | "endedAt">): string => {
  if (value.startedAt === undefined || value.endedAt === undefined) return "0s"
  const seconds = Math.max(0, Math.round((value.endedAt - value.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

/**
 * Assistant text, or a typed module's committed result under its bound root.
 * @category projections
 * @since 1.0.0
 */
export const resolvedOutput = (value: Pick<Digest, "finalOutput" | "nativeResolution">): string | undefined =>
  value.finalOutput ?? NativeResolution.output(value.nativeResolution)

/**
 * The one-line verdict: the status plus the reason that most explains it.
 *
 * Priority order mirrors what a reader needs first: a recorded failure cause,
 * then a park's question, then the "worked but never edited" pathology a green
 * status would otherwise hide, then the resolved output.
 *
 * @param value the digest to judge
 * @since 1.0.0
 * @category rendering
 */
export const verdict = (value: Digest): string => {
  const status = value.status ?? "unlaunched"
  const output = resolvedOutput(value)
  if (status === "failed") {
    return value.cause === undefined
      ? "failed — no cause recorded in the journal"
      : `failed — ${clip(firstLine(value.cause), 100)}`
  }
  if (status === "waiting-approval") {
    return value.parkedQuestion === undefined
      ? "waiting-approval — a permission gate is pending"
      : `waiting-approval — asks: ${clip(value.parkedQuestion, 90)}`
  }
  if (status === "completed" && value.calls > 0 && value.editsAttempted === 0) {
    return `completed — but 0 of ${value.calls} calls attempted an edit; the run only read`
  }
  if (status === "completed" && output !== undefined && output.length > 0) {
    return `completed — ${clip(firstLine(output), 100)}`
  }
  return status
}

const label = (name: string): string => name.padEnd(10)

/**
 * Identity a diagnosis is rendered for.
 *
 * @since 1.0.0
 * @category models
 */
export interface Subject {
  readonly runId: string
  readonly flowId?: string | undefined
}

/**
 * Renders the diagnosis card for one run: verdict, activity evidence, tokens,
 * refusals, cause, and output.
 *
 * @param subject the run being diagnosed
 * @param value the digest computed from its events
 * @since 1.0.0
 * @category rendering
 */
export const render = (subject: Subject, value: Digest): string => {
  const output = resolvedOutput(value)
  const lines: Array<string> = [
    `${label("Verdict")}${verdict(value)}`,
    `${label("Run")}${subject.runId}${subject.flowId === undefined ? "" : ` · ${subject.flowId}`}${
      value.seat === undefined ? "" : ` · ${value.seat}`
    } · ${duration(value)}`,
    `${
      label("Activity")
    }${value.turns} turns · ${value.calls} calls (${value.callsFailed} refused) · edits ${value.editsSucceeded}/${value.editsAttempted}`,
    `${label("Tokens")}${value.inputTokens} in / ${value.outputTokens} out`
  ]
  for (const [index, refusal] of value.refusals.slice(0, 3).entries()) {
    lines.push(`${label(index === 0 ? "Refusals" : "")}${refusal.count}× ${clip(refusal.message, 110)}`)
  }
  if (value.cause !== undefined) lines.push(`${label("Cause")}${clip(firstLine(value.cause), 120)}`)
  if (output !== undefined && output.length > 0) {
    lines.push(`${label("Output")}${clip(firstLine(output), 120)}`)
  }
  return lines.join("\n")
}

/**
 * A digest of no events at all: the identity {@link combine} folds onto.
 *
 * @since 1.0.0
 * @category constructors
 */
export const emptyDigest = (): Digest => digest([])

const earliest = (left: number | undefined, right: number | undefined): number | undefined =>
  left === undefined ? right : right === undefined ? left : Math.min(left, right)
const latest = (left: number | undefined, right: number | undefined): number | undefined =>
  left === undefined ? right : right === undefined ? left : Math.max(left, right)

/**
 * Folds two digests of adjacent event ranges into the digest of both.
 *
 * `digest` is a left fold over an ordered range, so the digest of a whole
 * journal is the digest of its prefix combined with the digest of its
 * remainder. That identity is what lets a bounded reader keep exact counters
 * for a run whose journal it cannot hold: it folds the events it drops into a
 * carry digest and combines that carry with the digest of the window it kept.
 *
 * Used for contributions that do not overlap. Written fields may deliberately
 * clear an older value. Refusal counts merge and re-sort. The span widens.
 *
 * @param earlier the digest of the earlier range
 * @param later the digest of the range that follows it
 * @since 1.0.0
 * @category constructors
 */
const combinePlain = (earlier: Digest, later: Digest, writes: DigestState["writes"]): Digest => {
  const counts = new Map<string, number>()
  for (const refusal of [...earlier.refusals, ...later.refusals]) {
    counts.set(refusal.message, (counts.get(refusal.message) ?? 0) + refusal.count)
  }
  return {
    status: later.status ?? earlier.status,
    cause: writes.cause ? later.cause : earlier.cause,
    seat: later.seat ?? earlier.seat,
    turns: earlier.turns + later.turns,
    calls: earlier.calls + later.calls,
    callsFailed: earlier.callsFailed + later.callsFailed,
    editsAttempted: earlier.editsAttempted + later.editsAttempted,
    editsSucceeded: earlier.editsSucceeded + later.editsSucceeded,
    refusals: [...counts.entries()]
      .map(([message, count]) => ({ message, count }))
      .sort((left, right) => right.count - left.count),
    inputTokens: earlier.inputTokens + later.inputTokens,
    outputTokens: earlier.outputTokens + later.outputTokens,
    finalOutput: writes.finalOutput ? later.finalOutput : earlier.finalOutput,
    nativeResolution: NativeResolution.combine(earlier.nativeResolution, later.nativeResolution),
    parkedQuestion: writes.parkedQuestion ? later.parkedQuestion : earlier.parkedQuestion,
    startedAt: earliest(earlier.startedAt, later.startedAt),
    endedAt: latest(earlier.endedAt, later.endedAt)
  }
}

const stateOf = (value: Digest): DigestState =>
  digestStates.get(value) ?? {
    base: value,
    writes: {
      cause: value.cause !== undefined,
      finalOutput: value.finalOutput !== undefined,
      parkedQuestion: value.parkedQuestion !== undefined
    },
    baseSeatOrdinal: value.seat === undefined ? undefined : 0,
    baseRefusals: new Map(value.refusals.map((refusal) => [refusal.message, 0])),
    indexes: emptyIndexes(),
    contributions: HashMap.empty(),
    contributionBytes: 0,
    length: 1
  }

/** Rebuild only scalar facts; keyed observations never own root result/state fields. */
const combinedFacts = (state: DigestState): Digest => {
  const result = { ...state.base }
  let seatOrdinal = state.baseSeatOrdinal ?? -1
  const refusals = new Map(state.base.refusals.map((refusal) => [refusal.message, {
    count: refusal.count,
    ordinal: state.baseRefusals.get(refusal.message)!
  }]))
  for (const [, contribution] of state.contributions) {
    const value = contribution.value
    for (const key of counters) result[key] += value[key] ?? 0
    if (value.seat !== undefined && contribution.ordinal > seatOrdinal) {
      result.seat = value.seat
      seatOrdinal = contribution.ordinal
    }
    result.startedAt = earliest(result.startedAt, value.startedAt)
    result.endedAt = latest(result.endedAt, value.endedAt)
    for (const refusal of value.refusals ?? []) {
      const previous = refusals.get(refusal.message)
      refusals.set(refusal.message, {
        count: (previous?.count ?? 0) + refusal.count,
        ordinal: Math.min(previous?.ordinal ?? contribution.ordinal, contribution.ordinal)
      })
    }
  }
  result.refusals = [...refusals].sort(([, left], [, right]) =>
    right.count - left.count || left.ordinal - right.ordinal
  )
    .map(([message, { count }]) => ({ message, count }))
  return result
}

/**
 * Combines adjacent digests without counting an identified call or checkpoint
 * twice. A later native fact replaces the earlier telemetry contribution.
 * Identity state is private and must stay with the in-memory digest; a plain
 * reconstructed Digest is treated as an already aggregated, unkeyed value.
 * @category constructors
 * @since 1.0.0
 */
export const combine = (earlier: Digest, later: Digest): Digest => {
  const left = stateOf(earlier)
  const right = stateOf(later)
  let contributions = left.contributions
  let indexes = left.indexes
  let contributionBytes = left.contributionBytes
  let accepted = HashMap.empty<string, Contribution>()
  const corrected = { ...earlier }
  for (const [key, value] of right.contributions) {
    const previous = HashMap.get(contributions, key)
    if (previous._tag === "Some" && (previous.value.authoritative || !value.authoritative)) continue
    if (previous._tag === "Some") {
      const old = previous.value.value
      const next = value.value
      for (const counter of counters) corrected[counter] += (next[counter] ?? 0) - (old[counter] ?? 0)
    } else accepted = HashMap.set(accepted, key, value)
    const contribution = {
      ...value,
      ordinal: previous._tag === "Some" ? previous.value.ordinal : left.length + value.ordinal
    }
    contributionBytes += encodedBytes([key, contribution]) -
      (previous._tag === "Some" ? encodedBytes([key, previous.value]) : 0)
    contributions = HashMap.set(contributions, key, contribution)
    indexes = indexContribution(indexes, previous._tag === "Some" ? previous.value : undefined, contribution)
  }
  const baseRefusals = new Map(left.baseRefusals)
  for (const [message, ordinal] of right.baseRefusals) {
    if (!baseRefusals.has(message)) baseRefusals.set(message, left.length + ordinal)
  }
  const incomingComplete = HashMap.size(accepted) === HashMap.size(right.contributions)
  const incoming = incomingComplete ? later : combinedFacts({ ...right, contributions: accepted })
  const state: DigestState = {
    base: combinePlain(left.base, right.base, right.writes),
    writes: {
      cause: left.writes.cause || right.writes.cause,
      finalOutput: left.writes.finalOutput || right.writes.finalOutput,
      parkedQuestion: left.writes.parkedQuestion || right.writes.parkedQuestion
    },
    baseSeatOrdinal: right.baseSeatOrdinal === undefined ? left.baseSeatOrdinal : left.length + right.baseSeatOrdinal,
    baseRefusals,
    indexes,
    contributions,
    contributionBytes,
    length: left.length + right.length
  }
  // Appending new identities (or replaying an existing one) should cost the
  // incoming range, not re-fold the entire retained ledger on every eviction.
  // Indexed timestamps and refusal positions handle native corrections without
  // re-scanning all identities. Refusal rendering costs distinct messages.
  const value = { ...combinePlain(corrected, incoming, right.writes) }
  value.startedAt = state.base.startedAt
  value.endedAt = state.base.endedAt
  if (indexes.timings?.min !== undefined) {
    value.startedAt = Math.min(value.startedAt ?? indexes.timings.min, indexes.timings.min)
  }
  if (indexes.timings?.max !== undefined) {
    value.endedAt = Math.max(value.endedAt ?? indexes.timings.max, indexes.timings.max)
  }
  const refusals = new Map(state.base.refusals.map((refusal) => [refusal.message, {
    count: refusal.count,
    ordinal: baseRefusals.get(refusal.message)!
  }]))
  for (const [message, tree] of indexes.refusals) {
    const previous = refusals.get(message)
    refusals.set(message, {
      count: (previous?.count ?? 0) + tree.size,
      ordinal: Math.min(previous?.ordinal ?? tree.first, tree.first)
    })
  }
  value.refusals = [...refusals].sort(([, a], [, b]) => b.count - a.count || a.ordinal - b.ordinal)
    .map(([message, { count }]) => ({ message, count }))
  return remember(value, state)
}
