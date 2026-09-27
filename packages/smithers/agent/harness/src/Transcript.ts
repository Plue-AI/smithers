/**
 * Transcript projection from durable journal entries.
 *
 * The transcript grows: what the model saw is what it said plus what the
 * harness answered, in journal order. A `continue` used to be able to replace
 * the whole projection with a list of messages the cell had written for its
 * successor, and that branch is gone with the surface that produced it — a
 * journal from those waves still decodes, and its `context` entries are simply
 * not read.
 *
 * @since 0.1.0
 */

import type { JournalEvent } from "@smthrs/journal"
import { ModelRequest } from "@smthrs/model"
import { Result, Schema } from "effect"
import * as AgentEvent from "./AgentEvent.ts"
import type * as Cell from "./Cell.ts"
import type * as EngineLike from "./EngineLike.ts"
import * as FailedCall from "./FailedCall.ts"
import { HarnessError } from "./HarnessError.ts"
import * as DemandText from "./internal/demandText.ts"
import { printsObservation } from "./internal/printsObservation.ts"
import * as UnobservedCall from "./internal/unobservedCall.ts"

/**
 * Journal and model-key format after summaries became user context.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const journalVersion = 2

/**
 * The event-type namespace a session journals its controller events under.
 *
 * Resume validation reads only the entries under this prefix, and the writer
 * that produces them lives in another package, so the prefix is exported here
 * rather than spelled twice: a writer types its event types as
 * {@link ControlEventType} and a rename fails to compile instead of silently
 * emptying the set {@link validateJournal} inspects.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const controlEventPrefix = "control.agent."

/**
 * An event type {@link validateJournal} validates.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ControlEventType = `${typeof controlEventPrefix}${string}`

/**
 * Refuses history whose replay could address different sealed model steps.
 * Historical display projection is separate from permission to resume.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const validateJournal = (
  entries: ReadonlyArray<JournalEvent.Entry>
): Result.Result<void, HarnessError> => {
  for (const entry of entries) {
    if (!entry.eventType.startsWith(controlEventPrefix)) continue
    const payload = entry.payload as Record<string, unknown> | null
    if (payload === null || typeof payload !== "object" || payload["journalVersion"] !== journalVersion) {
      return Result.fail(
        new HarnessError({
          code: "incompatible_journal",
          message: `Journal sequence ${entry.seq} predates harness journal format ${journalVersion}; start a new run.`
        })
      )
    }
  }
  return Result.succeed(undefined)
}

/**
 * Stable failures produced while projecting a durable transcript.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const TranscriptErrorCode = Schema.Literals(["projection_failed"])

/**
 * Stable failures produced while projecting a durable transcript.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TranscriptErrorCode = typeof TranscriptErrorCode.Type

/**
 * Stable failures produced while projecting a durable transcript.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class TranscriptError extends Schema.TaggedError<TranscriptError>()("flows/harness/TranscriptError", {
  code: TranscriptErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * The kind and message of one projected transcript item.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ProjectedMessage {
  readonly kind: "transcript" | "summary" | "steering"
  readonly message: ModelRequest.Message
}

/**
 * A projection with the compaction replacement identity, when one was recorded.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ProjectedState {
  readonly messages: ReadonlyArray<ProjectedMessage>
  readonly replaced?: string | undefined
  readonly cell: CellEvidence
}

/**
 * Schema-decoded cell evidence consumed while rebuilding a journal.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CellEvidence {
  readonly produced: ReadonlyArray<Cell.Source>
  /**
   * What each frame printed, in journal order.
   *
   * The print buffer is the whole of the context channel: it is what the NEXT
   * model turn reads, and `AgentEvent.CellPrinted` is journaled rather than
   * derived precisely so a projection can rebuild that window without
   * re-running anything. It was missing from this decoder, so a transcript
   * projected from a harness-native journal could not reconstruct what the
   * model saw.
   */
  readonly printed: ReadonlyArray<AgentEvent.CellPrinted>
  readonly callsStarted: ReadonlyArray<Cell.Call>
  readonly callsSettled: ReadonlyArray<AgentEvent.CellCallSettled>
  readonly settled: ReadonlyArray<AgentEvent.CellSettled>
  readonly transitions: ReadonlyArray<Cell.Transition>
  readonly suspensions: ReadonlyArray<EngineLike.SuspendReason>
  readonly aborts: ReadonlyArray<string>
}

/** The one journal-event-type table; see `AgentEvent.eventType`. */
const eventType = AgentEvent.eventType

const projectionFailed = (entry: JournalEvent.Entry, cause: unknown): TranscriptError =>
  new TranscriptError({
    code: "projection_failed",
    message: `Invalid ${entry.eventType} payload at journal sequence ${entry.seq}`,
    cause
  })

const decode = <A>(
  decodePayload: (payload: unknown) => Result.Result<A, unknown>,
  entry: JournalEvent.Entry
): Result.Result<A, TranscriptError> =>
  Result.mapError(decodePayload(entry.payload), (cause) => projectionFailed(entry, cause))

const ordered = (entries: ReadonlyArray<JournalEvent.Entry>): ReadonlyArray<JournalEvent.Entry> =>
  [...entries].sort((left, right) => left.seq - right.seq)

const decodeModelSettled = Schema.decodeUnknownResult(AgentEvent.ModelSettled)
const decodeSteeringDrained = Schema.decodeUnknownResult(AgentEvent.SteeringDrained)
const decodeCompactionSettled = Schema.decodeUnknownResult(AgentEvent.CompactionSettled)
const decodeCellPrinted = Schema.decodeUnknownResult(AgentEvent.CellPrinted)
const decodeCellProduced = Schema.decodeUnknownResult(AgentEvent.CellProduced)
const decodeCellCallStarted = Schema.decodeUnknownResult(AgentEvent.CellCallStarted)
const decodeCellCallSettled = Schema.decodeUnknownResult(AgentEvent.CellCallSettled)
const decodeCellSettled = Schema.decodeUnknownResult(AgentEvent.CellSettled)
const decodeTransitionApplied = Schema.decodeUnknownResult(AgentEvent.TransitionApplied)
const decodeSuspended = Schema.decodeUnknownResult(AgentEvent.Suspended)
const decodeAborted = Schema.decodeUnknownResult(AgentEvent.Aborted)
const decodeReadOnlyDemandIssued = Schema.decodeUnknownResult(AgentEvent.ReadOnlyDemandIssued)
const decodeRepeatDemanded = Schema.decodeUnknownResult(AgentEvent.RepeatDemanded)
const decodeNarrowedDemanded = Schema.decodeUnknownResult(AgentEvent.NarrowedDemanded)
const decodeNarrowOnlyDemanded = Schema.decodeUnknownResult(AgentEvent.NarrowOnlyDemanded)
const decodeUnmovedDemanded = Schema.decodeUnknownResult(AgentEvent.UnmovedDemanded)
const decodeUnresolvedDemanded = Schema.decodeUnknownResult(AgentEvent.UnresolvedDemanded)
const decodeFailedCallDemanded = Schema.decodeUnknownResult(AgentEvent.FailedCallDemanded)
const decodeUnobservedDemanded = Schema.decodeUnknownResult(AgentEvent.UnobservedDemanded)
const decodeClaimDemanded = Schema.decodeUnknownResult(AgentEvent.ClaimDemanded)

const transcriptMessage = (
  message: ModelRequest.AssistantMessage
): ModelRequest.AssistantMessage =>
  message.stopReason === "error" || message.stopReason === "aborted"
    ? new ModelRequest.AssistantMessage({
      role: "assistant",
      content: message.content.map((part) =>
        part.type === "thinking"
          ? ModelRequest.ThinkingPart.make({ text: part.text })
          : part
      ),
      stopReason: message.stopReason
    })
    : message

/**
 * Projects journal events into their model-visible transcript state as typed
 * data, preserving malformed payload failures instead of throwing.
 *
 * This rebuilds turn structure, the settlement's own message, and every
 * journaled controller demand. The controller also folds frame-local
 * settled-call salvage and the memory-probe alert into failure notes. A raised
 * cell's `bindingPathMiss` hint is live-only, so the projection rebuilds a
 * shorter note exactly where that hint would name a missed binding.
 *
 * A terminal frame has the opposite skew: `observe` appends no observation
 * once the frame budget is spent, while this projection rebuilds its journaled
 * print and settlement. On a run whose last frame was terminal, it therefore
 * over-reports by one trailing user turn. `AgentEvent.TurnClosed.outcome` is the
 * journaled signal a future projection would key on to drop it: `"resolved"`
 * on the terminal frame and `"continue"` otherwise.
 *
 * @category projections
 * @since 0.1.0
 * @slop
 */
export const projectStateResult = (
  entries: ReadonlyArray<JournalEvent.Entry>
): Result.Result<ProjectedState, TranscriptError> => {
  const events = ordered(entries)
  const produced: Array<Cell.Source> = []
  const printed: Array<AgentEvent.CellPrinted> = []
  const prints = new Map<number, AgentEvent.CellPrinted>()
  const callsStarted: Array<Cell.Call> = []
  const callsSettled: Array<AgentEvent.CellCallSettled> = []
  const settledCells: Array<AgentEvent.CellSettled> = []
  const transitions: Array<Cell.Transition> = []
  const suspensions: Array<EngineLike.SuspendReason> = []
  const aborts: Array<string> = []
  const compactions = new Map<number, AgentEvent.CompactionSettled>()
  let replaced: string | undefined
  // Legacy events replaced everything before themselves. Preserve that
  // behavior, including skipping obsolete model payloads, for old journals.
  let legacyBoundary = Number.NEGATIVE_INFINITY

  for (const entry of events) {
    switch (entry.eventType) {
      case eventType.cellProduced: {
        const decoded = decode(decodeCellProduced, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        produced.push(decoded.success.cell)
        break
      }
      case eventType.cellPrinted: {
        const decoded = decode(decodeCellPrinted, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        printed.push(decoded.success)
        // Decoded once, here, and read back by sequence below. The payload is
        // retained so a failed settlement can prove the immediately preceding
        // print belongs to the same cell before merging the two observations.
        prints.set(entry.seq, decoded.success)
        break
      }
      case eventType.cellCallStarted: {
        const decoded = decode(decodeCellCallStarted, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        callsStarted.push(decoded.success.call)
        break
      }
      case eventType.cellCallSettled: {
        const decoded = decode(decodeCellCallSettled, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        callsSettled.push(decoded.success)
        break
      }
      case eventType.cellSettled: {
        const decoded = decode(decodeCellSettled, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        settledCells.push(decoded.success)
        break
      }
      case eventType.transitionApplied: {
        const decoded = decode(decodeTransitionApplied, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        transitions.push(decoded.success.transition)
        break
      }
      case eventType.suspended: {
        const decoded = decode(decodeSuspended, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        suspensions.push(decoded.success.reason)
        break
      }
      case eventType.aborted: {
        const decoded = decode(decodeAborted, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        aborts.push(decoded.success.reason)
        break
      }
      case eventType.compactionSettled: {
        const decoded = decode(decodeCompactionSettled, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        compactions.set(entry.seq, decoded.success)
        replaced = decoded.success.replacedPrefixDigest
        if (decoded.success.retainedMessageCount === undefined) legacyBoundary = entry.seq
        break
      }
    }
  }

  const messages: Array<ProjectedMessage> = []
  // Set only after emitting a print and cleared whenever another message is
  // emitted, so presence means the last projected turn is exactly this print.
  let precedingPrint: AgentEvent.CellPrinted | undefined
  const appendDemand = (text: string): void => {
    messages.push({ kind: "transcript", message: ModelRequest.Message.user(text) })
    precedingPrint = undefined
  }

  for (const entry of events) {
    if (entry.seq < legacyBoundary) continue
    const compaction = compactions.get(entry.seq)
    if (compaction !== undefined) {
      // Apply each boundary to the already-projected messages so repeated
      // compactions replace prior summaries without dropping the recent tail.
      // A marked compaction carries the replaced messages it kept verbatim
      // after its summary, and may carry no summary when nothing was squashed.
      const summary = compaction.summary
      messages.splice(
        0,
        Math.max(0, messages.length - (compaction.retainedMessageCount ?? 0)),
        ...(summary === undefined ? [] : [{
          kind: "summary" as const,
          message: summary.role === "user"
            ? summary
            : ModelRequest.Message.user(
              summary.content.filter((part): part is ModelRequest.TextPart => part.type === "text")
            )
        }]),
        ...(compaction.kept ?? []).map((message) => ({ kind: "transcript" as const, message }))
      )
      precedingPrint = undefined
      continue
    }
    // The print buffer is the context channel: what a cell printed is what the
    // next model turn read, in the place the journal put it.
    const print = prints.get(entry.seq)
    if (print !== undefined) {
      messages.push({
        kind: "transcript",
        message: ModelRequest.Message.user(printsObservation(print.text))
      })
      precedingPrint = print
      continue
    }
    switch (entry.eventType) {
      case eventType.modelSettled: {
        const decoded = decode(decodeModelSettled, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        if (decoded.success.message.content.length === 0) break
        messages.push({ kind: "transcript", message: transcriptMessage(decoded.success.message) })
        precedingPrint = undefined
        break
      }
      case eventType.steeringDrained: {
        const decoded = decode(decodeSteeringDrained, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        for (const message of decoded.success.messages) {
          messages.push({ kind: "steering", message })
          precedingPrint = undefined
        }
        break
      }
      case eventType.readOnlyDemandIssued: {
        const decoded = decode(decodeReadOnlyDemandIssued, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        appendDemand(DemandText.readOnly(decoded.success.cap, decoded.success.streak))
        break
      }
      case eventType.repeatDemanded: {
        const decoded = decode(decodeRepeatDemanded, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        appendDemand(DemandText.repeat(decoded.success.frames, decoded.success.cap))
        break
      }
      case eventType.narrowedDemanded: {
        const decoded = decode(decodeNarrowedDemanded, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        appendDemand(DemandText.narrowed(decoded.success.flow, decoded.success.broader, decoded.success.narrower))
        break
      }
      case eventType.narrowOnlyDemanded: {
        const decoded = decode(decodeNarrowOnlyDemanded, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        appendDemand(DemandText.narrowOnly(decoded.success.flow, decoded.success.check, decoded.success.targets))
        break
      }
      case eventType.unmovedDemanded: {
        const decoded = decode(decodeUnmovedDemanded, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        appendDemand(DemandText.unmoved(decoded.success.openedDigest, decoded.success.currentDigest))
        break
      }
      case eventType.unresolvedDemanded: {
        const decoded = decode(decodeUnresolvedDemanded, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        appendDemand(DemandText.unresolved(decoded.success.flow, decoded.success.failed, decoded.success.instead))
        break
      }
      case eventType.failedCallDemanded: {
        const decoded = decode(decodeFailedCallDemanded, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        appendDemand(FailedCall.demand(decoded.success.failures))
        break
      }
      case eventType.unobservedDemanded: {
        const decoded = decode(decodeUnobservedDemanded, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        appendDemand(UnobservedCall.demand(decoded.success.calls))
        break
      }
      case eventType.claimDemanded: {
        const decoded = decode(decodeClaimDemanded, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        // The reading that let a completion through was journaled too, and it
        // put nothing in front of the model, so only a firing is replayed.
        if (decoded.success.demanded) {
          appendDemand(DemandText.claim())
        }
        break
      }
      case eventType.cellSettled: {
        const decoded = decode(decodeCellSettled, entry)
        /* v8 ignore next -- the first pass ran `decodeCellSettled` over every `cellSettled` entry of this same `events` array and returned on failure, and `decode` is a pure function of `entry.payload`, so re-decoding an entry that survived that pass cannot fail; the branch exists because `Result` has no way to carry that proof */
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        const outcome = decoded.success.outcome
        if (outcome._tag !== "rejected" && outcome._tag !== "raised") break
        const note = outcome._tag === "rejected"
          ? outcome.message
          : `The cell threw ${outcome.name}: ${outcome.message}. Emit a corrected cell.`
        if (precedingPrint !== undefined && precedingPrint.cell === decoded.success.cell) {
          messages[messages.length - 1] = {
            kind: "transcript",
            message: ModelRequest.Message.user(`${printsObservation(precedingPrint.text)}\n\n${note}`)
          }
        } else {
          messages.push({
            kind: "transcript",
            message: ModelRequest.Message.user(note)
          })
        }
        precedingPrint = undefined
        break
      }
    }
  }
  return Result.succeed({
    messages,
    replaced,
    cell: {
      produced,
      printed,
      callsStarted,
      callsSettled,
      settled: settledCells,
      transitions,
      suspensions,
      aborts
    }
  })
}

/**
 * Projects model-visible messages in canonical journal sequence order.
 *
 * @category projections
 * @since 0.1.0
 * @slop
 */
export const projectResult = (
  entries: ReadonlyArray<JournalEvent.Entry>
): Result.Result<ReadonlyArray<ModelRequest.Message>, TranscriptError> =>
  Result.map(projectStateResult(entries), (state) => state.messages.map((item) => item.message))
