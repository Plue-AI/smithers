/**
 * Serializable events emitted by harness adapters.
 *
 * @since 0.1.0
 */

import * as Permission from "@smthrs/capability/Permission"
import type * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Context, Effect, Schema } from "effect"
import * as Cell from "./Cell.ts"
import * as EngineLike from "./EngineLike.ts"
import { NonNegativeSafeInt } from "./internal/nonNegativeSafeInt.ts"
import * as Sandbox from "./Sandbox.ts"

/**
 * Observes an event before the controller advances or parks. Durable hosts
 * finish their checkpoint here; stream consumers may lag behind the source.
 * @category services
 * @since 1.0.0-rc.0
 */
export const Observer = Context.Reference<(event: AgentEvent) => Effect.Effect<void>>(
  "@smthrs/harness/AgentEvent/Observer",
  { defaultValue: () => () => Effect.void }
)

/**
 * Journals an event into the run whose cell called the current flow. The
 * controller provides it around each flow call, so a flow that asks Jev
 * itself journals its receipts beside the run's own. Outside a run there is
 * no journal, and it does nothing.
 * @category services
 * @since 1.0.0-rc.0
 */
export const Journal = Context.Reference<(event: AgentEvent) => Effect.Effect<void>>(
  "@smthrs/harness/AgentEvent/Journal",
  { defaultValue: () => () => Effect.void }
)

/**
 * The kind of a human-provided item a relevance reading may withhold.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const RelevanceKind = Schema.Literals(["flow", "skill", "instruction", "memory"])

/**
 * What a compaction reading did with one replaced message.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const CompactionMark = Schema.Literals(["keep", "squash", "remove"])

/**
 * The invariant that kept a message from being removed, whatever it was marked.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const CompactionPin = Schema.Literals(["summary", "person", "steering", "mutated", "failing", "pair", "budget"])

/**
 * What a supervisor monitor watches for.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const MonitorKind = Schema.Literals(["mood", "skill", "lint"])

/**
 * The static stance a run's monitors deliver under.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Stance = Schema.Literals(["careful", "paranoid"])

/**
 * Why a crossed monitor was not delivered.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Suppression = Schema.Literals(["streak", "cooldown", "limit", "slot"])

/**
 * Why a reading could not be judged: `unconfigured`, `interrupted`, or the
 * transport's own error code.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const UnjudgedReason = Schema.Literals(["unconfigured", "interrupted", ...Evaluator.EvaluatorErrorCode.literals])

/** Token usage an evaluator reported for one reading. */
const Usage = Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number })

/**
 * The loop discipline a run was armed with, journaled once when it starts.
 *
 * Arming used to be observable only through the events a disciplined run
 * *reaches*: the read-cap failure proves the cap was armed, and a run that
 * times out before it fires proves nothing — so a grader could not tell "armed
 * but never reached" from "never armed", which is exactly what the 2026-08-19
 * SWE-bench wave could not decide about its django instance. This event is the
 * positive record: it says what was armed, before anything has had a chance to
 * fire.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class DisciplineArmed extends Schema.TaggedClass<DisciplineArmed>(
  "flows/harness/AgentEvent/DisciplineArmed"
)("discipline-armed", {
  eventType: Schema.Literal("flows.harness.discipline-armed.v1"),
  /** Consecutive read-only frames allowed; zero means the cap is disarmed. */
  readOnlyCap: Schema.Number,
  /** The frame budget the run stops at. */
  maxFrames: Schema.Number,
  /**
   * Whether a human can answer this run.
   *
   * False says nothing is listening: a `park` transition is refused and
   * answered in the frame that returned it, because a run that waits for an
   * answer nobody will give has stopped working with its budget unspent.
   */
  approvalChannel: Schema.Boolean,
  /**
   * Wall-clock milliseconds one model call may spend; zero means disarmed.
   *
   * Every other budget here caps the cell — the calls it makes, the memory and
   * time its code spends, the run's frames. This one caps the step in between,
   * which was the only unbounded thing the loop did.
   */
  modelCallMs: Schema.Number,
  /**
   * Consecutive repeat-observation frames allowed; zero disarms the demand.
   *
   * Armed here for the same reason the read-only cap is: a run that never
   * reaches a control proves nothing about whether the control was armed, and
   * a grader must be able to tell "armed and never needed" from "never armed".
   */
  repeatCap: Schema.Number,
  /**
   * Completions this run may have bounced for narrowed evidence; zero disarms.
   *
   * Journaled with the rest because the demand it governs fires at most once
   * in a run and often not at all, so its absence from a wave says nothing on
   * its own. One is the armed default: the loop names the missing check once,
   * and the answer that comes back is the answer that stands.
   */
  narrowingCap: Schema.Number,
  /**
   * Completions this run may have bounced for an unmoved tree; zero disarms.
   *
   * Journaled for the same reason as the other two completion caps: the demand
   * fires at most once and usually not at all, so a wave that records none must
   * be able to say whether the control was armed and never needed.
   */
  unmovedCap: Schema.Number,
  /**
   * Times one frame may answer its own unparseable cell before ending; zero
   * disarms the answer.
   *
   * Journaled with the rest because a wave that records no
   * `cell-rejected-in-frame` must be able to say whether the answer was armed
   * and never needed or never armed at all.
   */
  revalidations: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Completions this run may have bounced for a failing check it replaced
   * rather than answered; zero disarms.
   */
  unresolvedCap: Schema.Number,
  /**
   * Completions this run may have bounced for a claim its own record does not
   * support; zero disarms.
   *
   * Journaled with the other completion caps, and it says less than they do on
   * its own: the control it arms is also a no-op wherever no `Evaluator` is
   * bound, so an armed cap and no `claim-demanded` event anywhere in a run
   * means either that nothing was asked or that everything asked came back
   * inside the thresholds. Defaulted so journals written before this control
   * existed decode unchanged. See `CompletionClaim`.
   */
  claimCap: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Whether a supervisor reading could nudge the run, as journals written
   * before {@link judged} said it. Later writers omit it: `judged` says the
   * same.
   */
  supervisorSteer: Schema.optional(Schema.Boolean),
  /** Maximum calls per cell, when this binding can enforce one. */
  calls: Schema.optional(Schema.Number),
  /** Maximum sandbox heap, when this binding can enforce one. */
  memoryBytes: Schema.optional(Schema.Number),
  /** Maximum interpreter steps, when this binding can enforce one. */
  steps: Schema.optional(Schema.Number),
  /** Maximum cell-compute time, when this binding can enforce one. */
  timeMs: Schema.optional(Schema.Number),
  /** Maximum whole-evaluation time, when this binding can enforce one. */
  totalMs: Schema.optional(Schema.Number),
  /** Maximum wall-clock time for one flow call. */
  callMs: Schema.optional(Schema.Number),
  /** Whether a judge was bound, so Jev's readings run. Absent before it existed. */
  judged: Schema.optional(Schema.Boolean),
  /** The relevance gate: the withhold threshold and the item ids never offered to it. */
  relevance: Schema.optional(Schema.Struct({ withholdAt: Schema.Number, pinned: Schema.Array(Schema.String) })),
  /** The supervisor monitors armed, with their delivery gates. */
  monitors: Schema.optional(Schema.Array(Schema.Struct({
    id: Schema.String,
    kind: MonitorKind,
    /** The probability at or above which the monitor crosses. */
    at: Schema.Number,
    /** Consecutive crossed readings required before a delivery. */
    consecutive: NonNegativeSafeInt,
    /** Frames after a delivery during which the monitor is not delivered again. */
    cooldownFrames: NonNegativeSafeInt,
    /** Deliveries allowed in one run. */
    limit: NonNegativeSafeInt
  }))),
  /** The static stance the monitors deliver under. */
  stance: Schema.optional(Stance)
}) {}

/**
 * The serializable snapshot fixed when a turn opens.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class TurnOpened extends Schema.TaggedClass<TurnOpened>(
  "flows/harness/AgentEvent/TurnOpened"
)("turn-opened", {
  eventType: Schema.Literal("flows.harness.turn-opened.v1"),
  seat: Schema.String,
  modelParams: ModelRequest.GenerationParams,
  /**
   * The tool set the turn opened with, which the cell-first controller always
   * opens empty: it declares no provider tools. The field stays on the event
   * so journals written before the provider-tool loop was retired keep
   * decoding, and so a foreign-adapter loop has somewhere to put one.
   */
  activeToolNames: Schema.Array(Schema.String),
  contextDigest: Schema.String
}) {}

/**
 * What one model call was asked, written before the call is made.
 *
 * `model-settled` journals what a call answered and what it cost, and until
 * this event nothing journaled what it was asked: the request existed only in
 * the sealed step's key material, as a digest. A reader that wants to open one
 * step and run it again needs the request itself, so this is the request
 * itself, carried whole here and bounded where it is journaled.
 *
 * It is written when the call is OPENED rather than when it settles, so a call
 * that never settles (a deadline, a refusal, a process that died mid-stream)
 * still leaves what it asked on the record.
 *
 * `scope`, `frame` and `attempt` are the join keys, and they are on the record
 * because position is not one. `scope` is the run's session, which for a
 * module step is the step's recorded scope; `frame` is the controller's own
 * frame number; `attempt` counts the model calls one frame made, from one,
 * and is the same number `cell-rejected-in-frame` names when it refuses that
 * call's answer. A compaction call runs before its frame's `turn-opened`, so a
 * reader counting turns would file it under the frame before; `purpose` and
 * `frame` say where it belongs.
 *
 * Credential-free by construction. The request is the provider-neutral
 * `ModelRequest`, which has no member a credential can occupy, and
 * {@link EngineLike.Binding} carries two names read off the prepared request
 * that exists before any secret is signed on.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class ModelRequested extends Schema.TaggedClass<ModelRequested>(
  "flows/harness/AgentEvent/ModelRequested"
)("model-requested", {
  eventType: Schema.Literal("flows.harness.model-requested.v1"),
  /** The run's session, which is the recorded scope of the step that made the call. */
  scope: Schema.String,
  /** The controller's frame number for the turn this call belongs to. */
  frame: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Which model call of that frame and purpose this is, counting from one. */
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** What the call is for: the frame's own turn, or the compaction ahead of it. */
  purpose: Schema.Literals(["frame", "compaction"]),
  /** The seat the frame ran on, as `turn-opened` names it. */
  seat: Schema.String,
  /** The route the host resolved, absent where the host names none. */
  binding: Schema.optional(EngineLike.Binding),
  /** The request the provider is sent, whole: after any rewrite the host applies. */
  request: ModelRequest.ModelRequest
}) {}

/**
 * A capacity refusal moved the current frame to another seat.
 * @category events
 * @since 1.0.0-rc.1
 */
export class SeatFailedOver extends Schema.TaggedClass<SeatFailedOver>(
  "flows/harness/AgentEvent/SeatFailedOver"
)("seat-failed-over", {
  eventType: Schema.Literal("flows.harness.seat-failed-over.v1"),
  from: Schema.String,
  to: Schema.String,
  code: ModelError.ModelErrorCode,
  resetAtEpochMillis: Schema.optional(Schema.Number)
}) {}

/**
 * All configured model seats are cooling until this instant.
 * @category events
 * @since 1.0.0-rc.1
 */
export class ModelParked extends Schema.TaggedClass<ModelParked>(
  "flows/harness/AgentEvent/ModelParked"
)("model-parked", {
  eventType: Schema.Literal("flows.harness.model-parked.v1"),
  seat: Schema.String,
  wakeAt: Schema.Number,
  source: Schema.Literals(["reset", "retry-after", "default"]),
  code: ModelError.ModelErrorCode
}) {}

/**
 * A parked model frame may issue a new request.
 * @category events
 * @since 1.0.0-rc.1
 */
export class ModelUnparked extends Schema.TaggedClass<ModelUnparked>(
  "flows/harness/AgentEvent/ModelUnparked"
)("model-unparked", {
  eventType: Schema.Literal("flows.harness.model-unparked.v1"),
  seat: Schema.String,
  at: Schema.Number
}) {}

/**
 * One provider-neutral model progress event.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class ModelDelta extends Schema.TaggedClass<ModelDelta>(
  "flows/harness/AgentEvent/ModelDelta"
)("model-delta", {
  eventType: Schema.Literal("flows.harness.model-delta.v1"),
  delta: ModelEvent.ModelEvent
}) {}

/**
 * A transport-only model retry taken before the sealed step settled.
 *
 * @category events
 * @since 0.1.0
 */
export class ModelRetried extends Schema.TaggedClass<ModelRetried>(
  "flows/harness/AgentEvent/ModelRetried"
)("model-retried", {
  eventType: Schema.Literal("flows.harness.model-retried.v1"),
  attempt: Schema.Int,
  code: Schema.String,
  /**
   * Milliseconds the boundary waited before this attempt.
   *
   * Every retry of one sealed step is journaled at the moment the step
   * settles, so the event timestamps cannot show the schedule. This carries
   * it. Zero is what an unscheduled retry, or a record written before the
   * field existed, reports.
   */
  delayMillis: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  )
}) {}

/**
 * The complete recorded model settlement and usage.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class ModelSettled extends Schema.TaggedClass<ModelSettled>(
  "flows/harness/AgentEvent/ModelSettled"
)("model-settled", {
  eventType: Schema.Literal("flows.harness.model-settled.v1"),
  message: ModelRequest.AssistantMessage,
  usage: ModelEvent.Usage,
  /** The vendor session that answered, for a wrapped CLI seat: `claude --resume <sessionId>`. */
  sessionId: Schema.optional(Schema.String),
  /**
   * Wall-clock milliseconds the sealed step took, measured on the injected
   * clock.
   *
   * Usage alone answers what a call cost, never how long it took, so a
   * benchmark could compare tokens per run but not seconds per call — and
   * speed was the larger half of the gap the first head-to-head measured.
   * Zero is what an event carries when nothing timed it.
   */
  durationMillis: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  )
}) {}

/**
 * The cell source recovered from one model settlement.
 *
 * The source itself is durable evidence: replay re-executes exactly this text,
 * and every call identity inside the frame folds in its digest.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellProduced extends Schema.TaggedClass<CellProduced>(
  "flows/harness/AgentEvent/CellProduced"
)("cell-produced", {
  eventType: Schema.Literal("flows.harness.cell-produced.v1"),
  cell: Cell.Source,
  /**
   * How many fenced cell blocks the reply was written in.
   *
   * Journaled because it is the only record of how the model laid its frame
   * out, and because the count above one is the shape whose whole program the
   * harness used to discard. See `Cell.extract`.
   */
  blocks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
    Schema.withConstructorDefault(Effect.succeed(1)),
    Schema.withDecodingDefaultKey(Effect.succeed(1))
  )
}) {}

/**
 * One reply the boundary parse refused, answered inside the frame it arrived
 * in rather than by ending the frame.
 *
 * Journaled because it is spend: a re-prompt is a real model call, cached
 * prefix or not, and a wave counting cost per frame would otherwise see the
 * output of an answer it has no record of asking for. It is also the only
 * measure of whether validating at the boundary is worth what it costs — the
 * ratio of this event to `cell-settled` rejections says how often one re-ask
 * recovers a frame.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellRejectedInFrame extends Schema.TaggedClass<CellRejectedInFrame>(
  "flows/harness/AgentEvent/CellRejectedInFrame"
)("cell-rejected-in-frame", {
  eventType: Schema.Literal("flows.harness.cell-rejected-in-frame.v1"),
  /** Which attempt of this frame was refused, counting from one. */
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Why the parse refused it. */
  code: Cell.RejectionCode,
  /** What the frame told the model, verbatim. */
  message: Schema.String
}) {}

/**
 * One flow call opened from inside a running cell.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellCallStarted extends Schema.TaggedClass<CellCallStarted>(
  "flows/harness/AgentEvent/CellCallStarted"
)("cell-call-started", {
  eventType: Schema.Literal("flows.harness.cell-call-started.v1"),
  call: Cell.Call
}) {}

/**
 * One settled flow call made from inside a running cell.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellCallSettled extends Schema.TaggedClass<CellCallSettled>(
  "flows/harness/AgentEvent/CellCallSettled"
)("cell-call-settled", {
  eventType: Schema.Literal("flows.harness.cell-call-settled.v1"),
  flowName: Schema.String,
  identity: Cell.CallIdentity,
  result: Cell.CallResult
}) {}

/**
 * What one REPL cell printed, as the next model turn will read it.
 *
 * The print buffer is the whole of the context channel in REPL mode, so it is
 * journaled rather than derived: a transcript projection rebuilds a resumed
 * run's window from the journal without re-running anything, exactly as it does
 * for the context a filing cell projected. Bounded before it is emitted, so the
 * journal carries what the model saw and nothing larger.
 *
 * @category events
 * @since 0.1.0
 */
export class CellPrinted extends Schema.TaggedClass<CellPrinted>(
  "flows/harness/AgentEvent/CellPrinted"
)("cell-printed", {
  eventType: Schema.Literal("flows.harness.cell-printed.v1"),
  /** The digest of the cell whose prints these are. */
  cell: Schema.String,
  /** The frame's whole print buffer, already bounded; empty when it printed nothing. */
  text: Schema.String
}) {}

/**
 * The outcome of executing one cell, whether it settled, threw, or was
 * rejected before it ran.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellSettled extends Schema.TaggedClass<CellSettled>(
  "flows/harness/AgentEvent/CellSettled"
)("cell-settled", {
  eventType: Schema.Literal("flows.harness.cell-settled.v1"),
  cell: Schema.String,
  outcome: Cell.Outcome,
  /** Absent in journals written before execution frontiers were recorded. */
  boundary: Schema.optional(Sandbox.FrameBoundary)
}) {}

/**
 * The durable transition the controller applied after a cell settled.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class TransitionApplied extends Schema.TaggedClass<TransitionApplied>(
  "flows/harness/AgentEvent/TransitionApplied"
)("transition-applied", {
  eventType: Schema.Literal("flows.harness.transition-applied.v1"),
  transition: Cell.Transition
}) {}

/**
 * The controller issuing a read-cap intervention to the next frame.
 *
 * Kept separately from {@link ReadOnlyDemanded}: this event records the user
 * message entering the model transcript, while that event records how a later
 * frame answered it. A crash between those boundaries must retain the demand.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class ReadOnlyDemandIssued extends Schema.TaggedClass<ReadOnlyDemandIssued>(
  "flows/harness/AgentEvent/ReadOnlyDemandIssued"
)("read-only-demand-issued", {
  eventType: Schema.Literal("flows.harness.read-only-demand-issued.v1"),
  /** Consecutive read-only frames the run had spent. */
  streak: Schema.Int,
  /** The armed threshold that streak reached. */
  cap: Schema.Int,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The outcome of the frame immediately following a read-cap intervention.
 *
 * @category events
 * @since 0.1.0
 */
export class ReadOnlyDemanded extends Schema.TaggedClass<ReadOnlyDemanded>(
  "flows/harness/AgentEvent/ReadOnlyDemanded"
)("read-only-demanded", {
  eventType: Schema.Literal("flows.harness.read-only-demanded.v1"),
  streak: Schema.Int,
  cap: Schema.Int,
  nextFrame: Schema.Int,
  nextAction: Schema.Literals(["write", "justification", "read-only", "park"])
}) {}

/**
 * The controller telling a run it has stopped learning anything.
 *
 * Written when a run reaches its repeat-observation threshold: consecutive
 * frames that issued calls, issued none the run had not already issued, and
 * changed nothing. Both this and {@link ReadOnlyDemandIssued} are written when
 * their demand is issued; {@link ReadOnlyDemanded} additionally records the
 * read-cap demand's later answer because that answer is a field on a
 * transition. A repeat demand is answered by the shape of the next frame's
 * calls, which the journal already writes one by one.
 *
 * @category events
 * @since 0.1.0
 */
export class RepeatDemanded extends Schema.TaggedClass<RepeatDemanded>(
  "flows/harness/AgentEvent/RepeatDemanded"
)("repeat-demanded", {
  eventType: Schema.Literal("flows.harness.repeat-demanded.v1"),
  /** Consecutive repeat-observation frames the run had spent. */
  frames: Schema.Int,
  /** The armed threshold that streak reached. */
  cap: Schema.Int,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller refusing one completion whose evidence was narrowed.
 *
 * Written when a frame returns `complete` while the check it ran is a strict
 * narrowing of one the run had already run in full, over a tree that has since
 * changed and never re-run since. Written when the demand is *issued*, like the
 * repeat demand and unlike the read-cap one, because what answers it is the
 * shape of the next frame's calls and its output — both of which the journal
 * already writes.
 *
 * The event is the whole audit trail for the bounce. `broader` and `narrower`
 * quote the two inputs as the run wrote them, and the two digests say which
 * trees they were measured over, so a grader can decide after the fact whether
 * the demand was right without replaying anything.
 *
 * @category events
 * @since 0.1.0
 */
export class NarrowedDemanded extends Schema.TaggedClass<NarrowedDemanded>(
  "flows/harness/AgentEvent/NarrowedDemanded"
)("narrowed-demanded", {
  eventType: Schema.Literal("flows.harness.narrowed-demanded.v1"),
  /** The flow both checks named. */
  flow: Schema.String,
  /** The broader check's input as the run wrote it, clipped. */
  broader: Schema.String,
  /** The narrowing check's input as the run wrote it, clipped. */
  narrower: Schema.String,
  /** Workspace digest the broader check was last run over. */
  broaderDigest: Schema.String,
  /** Workspace digest the completing frame closed on. */
  currentDigest: Schema.String,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller refusing one completion with no change behind it.
 *
 * Written when a frame returns `complete` while the tree it closed on is
 * byte-for-byte the tree the run opened on. Written when the demand is
 * *issued*, like the narrowing demand, because what answers it is the next
 * frame's own record — an edit that moves the digest, or a second completion
 * saying no change was needed — and the journal already writes both.
 *
 * The two digests are the whole audit trail: a grader can decide after the fact
 * whether the demand was right by comparing them to the run's
 * `mutation-observed` record, without replaying anything.
 *
 * @category events
 * @since 0.1.0
 */
export class UnmovedDemanded extends Schema.TaggedClass<UnmovedDemanded>(
  "flows/harness/AgentEvent/UnmovedDemanded"
)("unmoved-demanded", {
  eventType: Schema.Literal("flows.harness.unmoved-demanded.v1"),
  /** Workspace digest the run opened on. */
  openedDigest: Schema.String,
  /** Workspace digest the completing frame closed on, equal to the first. */
  currentDigest: Schema.String,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller refusing one completion that stepped around a failing check.
 *
 * Written when a frame returns `complete` while a check recorded over the same
 * tree reported a failing exit status, was never re-run, and a later check went
 * back to the same subject with a different command.
 *
 * `failed` and `instead` quote the two inputs as the run wrote them, and
 * `currentDigest` is the tree both were measured over, so the record says which
 * reading the completion stands on and which one replaced it.
 *
 * @category events
 * @since 0.1.0
 */
export class UnresolvedDemanded extends Schema.TaggedClass<UnresolvedDemanded>(
  "flows/harness/AgentEvent/UnresolvedDemanded"
)("unresolved-demanded", {
  eventType: Schema.Literal("flows.harness.unresolved-demanded.v1"),
  /** The flow both checks named. */
  flow: Schema.String,
  /** The failing check's input as the run wrote it, clipped. */
  failed: Schema.String,
  /** The input of the reading the run took instead, clipped. */
  instead: Schema.String,
  /** Workspace digest both checks were recorded over, and the frame closed on. */
  currentDigest: Schema.String,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller handing back a completion its own cell wrote before a call
 * in that cell failed.
 *
 * `failures` quotes each failed call's flow and message as the flow reported
 * them, so the record says which results the completion was written without.
 * See `FailedCall`.
 *
 * @category events
 * @since 1.0.0-rc.1
 */
export class FailedCallDemanded extends Schema.TaggedClass<FailedCallDemanded>(
  "flows/harness/AgentEvent/FailedCallDemanded"
)("failed-call-demanded", {
  eventType: Schema.Literal("flows.harness.failed-call-demanded.v1"),
  /** The calls the completing frame settled as failures, oldest first. */
  failures: Schema.Array(Schema.Struct({ flow: Schema.String, message: Schema.String })),
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller handing back a completion its own cell wrote before reading
 * the calls it made.
 *
 * `calls` names each call the completing frame settled, in ledger order, with
 * the head of the result the next frame was shown, so the record says which
 * results the completion was written without.
 *
 * @category events
 * @since 1.0.0-rc.1
 */
export class UnobservedDemanded extends Schema.TaggedClass<UnobservedDemanded>(
  "flows/harness/AgentEvent/UnobservedDemanded"
)("unobserved-demanded", {
  eventType: Schema.Literal("flows.harness.unobserved-demanded.v1"),
  /** The calls the completion was written without reading, oldest first. */
  calls: Schema.Array(
    Schema.Struct({ flow: Schema.String, ordinal: Schema.Int, ok: Schema.Boolean, summary: Schema.String })
  ),
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller refusing one completion that holds a single reading.
 *
 * Written when a frame returns `complete` while the last check it ran names
 * subjects no other check of the run covers together, and the run never issued
 * that exact call before. The sibling of `narrowed-demanded`, from the other
 * side: that one fires when a broader check exists in the ledger and was not
 * re-run, this one when no broader check was ever taken.
 *
 * `check` quotes the input as the run wrote it and `targets` names the subjects
 * the demand is about, so a grader can decide after the fact whether the demand
 * was right without replaying anything.
 *
 * @category events
 * @since 0.1.0
 */
export class NarrowOnlyDemanded extends Schema.TaggedClass<NarrowOnlyDemanded>(
  "flows/harness/AgentEvent/NarrowOnlyDemanded"
)("narrow-only-demanded", {
  eventType: Schema.Literal("flows.harness.narrow-only-demanded.v1"),
  /** The flow the check named. */
  flow: Schema.String,
  /** The check's input as the run wrote it, clipped. */
  check: Schema.String,
  /** The subjects it names, sorted. */
  targets: Schema.Array(Schema.String),
  /** Workspace digest the completing frame closed on; empty when unmeasured. */
  currentDigest: Schema.String,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * What Jev read off one completion claim, whether or not it braked.
 *
 * The only demand event written on every evaluation rather than only on a
 * firing, and it is written that way on purpose: the other five demands are
 * derived from facts a grader can recompute from the journal, and this one is
 * a model's reading that exists nowhere else. Without the passing readings the
 * record would answer "how often did it fire" and could never answer "how
 * often did it agree", which is the only question that says whether arming it
 * was right. `demanded` is the field that separates them, and it says exactly one
 * thing: whether this reading handed the completion back for a frame. A
 * reading comes out three ways, not two. It passes, and cost the run nothing.
 * It demands, and cost the run a frame. Or it reads against a run with no
 * bounce left to spend, where `demanded` is false and the run ends on
 * `CompletionClaim.unproven`: the verdict is in the run's failure, and the two
 * probabilities here are what a grader re-applies a threshold to either way.
 *
 * `complete` and `overclaims` are the transport's probabilities for the
 * classifier's two questions, verbatim, so a grader can re-apply any
 * threshold to a whole wave without re-asking. `latencyMs` is what the
 * evaluation cost in wall clock on the hot path of a completion. No event is
 * written where the brake is disarmed (`claimCap` of zero), where the
 * transport failed, or where there was no task and no claim to ask about:
 * nothing was read, so there is nothing to record. A spent cap is no longer
 * one of those cases — the reading still happens, and it is the reading that
 * ends the run. See `CompletionClaim`.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class ClaimDemanded extends Schema.TaggedClass<ClaimDemanded>(
  "flows/harness/AgentEvent/ClaimDemanded"
)("claim-demanded", {
  eventType: Schema.Literal("flows.harness.claim-demanded.v1"),
  /** Probability the transport gave to "the task as stated is done"; journaled, decides nothing. */
  complete: Schema.Number,
  /** Probability it gave to "the claim asserts what the evidence does not show"; journaled, decides nothing. */
  overclaims: Schema.Number,
  /** Probability it gave to "the claim reports a command or a result the evidence does not record"; the one that decides. */
  invented: Schema.Number,
  /** Wall-clock milliseconds the evaluation took. */
  latencyMs: Schema.Int,
  /** Token usage reported by the evaluator, absent from older journal entries. */
  usage: Schema.optional(Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number })),
  /** Whether this reading handed the completion back. */
  demanded: Schema.Boolean,
  /**
   * Whether this reading ended the run instead of handing the completion back.
   *
   * The third of the three ways a reading comes out, and the one that had no
   * field. `demanded` false meant both "the claim stands" and "the claim is
   * refused and the run is over", which a projection cannot tell apart, so the
   * refusal wrote no card and the sentence it refused was nowhere a person
   * could read. Absent from older journal entries, where it decodes false: a
   * journal written before this field carries its verdict in the run's
   * failure, which is where it always was.
   */
  refused: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /** Workspace digest the completing frame closed on; empty when unmeasured. */
  currentDigest: Schema.String,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/**
 * One classifier answer as `decision-settled` journals it, tagged by kind.
 *
 * `confidence` is the PROVIDER's number, `Evaluator.Response.confidence`, and
 * it is absent whenever the provider sent none. It is never the largest
 * probability wearing the name: `Classifier.confidence` reads 1 for an answer
 * that carried no distribution at all, so a record that filled the field from
 * it would report certainty exactly where the provider reported nothing. A
 * boolean has no such field because its probability is the whole answer.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const DecisionAnswer = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("boolean"),
    /** The probability the transport gave to yes. */
    p: Probability
  }),
  Schema.Struct({
    kind: Schema.Literal("choice"),
    /** The option chosen. */
    value: Schema.String,
    probabilities: Schema.Record(Schema.String, Probability),
    /** The provider's own number, unchecked: it is theirs to define, and a record must not fail a run. */
    confidence: Schema.optionalKey(Schema.Number)
  }),
  Schema.Struct({
    kind: Schema.Literal("score"),
    /** The score as the transport gave it, interpolated over rung indexes. */
    value: Schema.Number,
    /** The label of the nearest rung. */
    label: Schema.String,
    probabilities: Schema.Record(Schema.String, Probability),
    /** The provider's own number, unchecked: it is theirs to define, and a record must not fail a run. */
    confidence: Schema.optionalKey(Schema.Number)
  })
])

/**
 * The decoded form of {@link DecisionAnswer}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type DecisionAnswer = typeof DecisionAnswer.Type

/**
 * The answers of one evaluation in the shape {@link DecisionSettled} carries.
 *
 * `confidence` is `Evaluator.Response.confidence`, passed through per question
 * and left out per question: see {@link DecisionAnswer}.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const decisionAnswers = (
  answers: Readonly<Record<string, Classifier.Answer>>,
  confidence: Readonly<Record<string, number>> | undefined
): Readonly<Record<string, DecisionAnswer>> =>
  Object.fromEntries(
    Object.entries(answers).map(([id, answer]): readonly [string, DecisionAnswer] => {
      if ("probability" in answer) return [id, { kind: "boolean", p: answer.probability }]
      const reported = confidence !== undefined && Object.hasOwn(confidence, id) ? confidence[id] : undefined
      const provided = reported === undefined ? {} : { confidence: reported }
      return "label" in answer
        ? [id, {
          kind: "score",
          value: answer.value,
          label: answer.label,
          probabilities: answer.probabilities,
          ...provided
        }]
        : [id, { kind: "choice", value: answer.value, probabilities: answer.probabilities, ...provided }]
    })
  )

/**
 * One decision a classifier made, with everything a reader needs to make it
 * again: the state it read, the questions it was asked, and what it answered.
 *
 * The generalisation of {@link ClaimDemanded}, which stays. That event is three
 * probabilities and a verdict, and it cannot say what the probabilities were
 * probabilities OF: the evidence the brake assembled exists nowhere else, so a
 * reading could be re-thresholded and never re-asked. This one carries the
 * evidence. It is written beside `claim-demanded` rather than instead of it,
 * because every projection that counts readings counts that event.
 *
 * `classifier` is the declaration's stable id, never its description, and
 * `digest` is `Classifier.digest`, so a reader can tell a decision made under
 * questions that have since been reworded from one it can reproduce.
 * `questions` are the wire shapes the transport was sent.
 *
 * `acted` says whether the decision changed what the run did next. For the
 * completion brake that is a completion handed back or a run ended; a reading
 * that let the claim stand is `false`, and it is journaled all the same,
 * because the passing decisions are what say whether asking was right.
 *
 * `decidedBy` names who answered: `jev` for the decision-only model behind
 * `Evaluator`, `seat` for a generation seat asked to judge, `human` for a
 * person. Only `jev` is written today.
 *
 * `scope` and `frame` are the join keys {@link ModelRequested} carries, for the
 * reason it carries them.
 *
 * An emitter must produce the reading inside a recorded boundary, as the
 * completion brake does, and emit what the record holds. The answers are a
 * model's and the latency is a clock's, so a replayed frame that asked again
 * would journal a second, different decision at the same coordinates.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class DecisionSettled extends Schema.TaggedClass<DecisionSettled>(
  "flows/harness/AgentEvent/DecisionSettled"
)("decision-settled", {
  eventType: Schema.Literal("flows.harness.decision-settled.v1"),
  /** The run's session, which is the recorded scope of the step that decided. */
  scope: Schema.String,
  /** The controller's frame number for the turn the decision was made in. */
  frame: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The classifier's stable id. */
  classifier: Schema.String,
  /** `Classifier.digest`: the canonical hash of the id and the questions. */
  digest: Schema.String,
  /** The encoded state the questions were asked about, as the transport was sent it. */
  state: Schema.Json,
  /** The questions as they crossed the wire, keyed by question id. */
  questions: Schema.Record(Schema.String, Evaluator.Question),
  /** One answer per question id, tagged by kind. */
  answers: Schema.Record(Schema.String, DecisionAnswer),
  /** Wall-clock milliseconds the evaluation took. */
  latencyMs: Schema.Int,
  /** Whether this decision changed what the run did next. */
  acted: Schema.Boolean,
  /** Who answered. */
  decidedBy: Schema.Literals(["jev", "seat", "human"]),
  /** Token usage reported by the evaluator, absent when it supplied none. */
  usage: Schema.optional(Usage)
}) {}

const Level = Schema.Literals(["none", "mild", "strong"])

/**
 * What Jev read off one frame of a running run, whether or not it nudged.
 *
 * Written by the supervisor fiber for every snapshot it read, at some time
 * after the frame it is a reading of closed: the reading is taken off the
 * cell loop's hot path, so its position among the frame's other events is not
 * fixed and `scope` and `frame` are its coordinates. `frame` is the frame the
 * snapshot was built from, not the frame that will read any nudge.
 *
 * `thrashing`, `onTarget` and `suspect` are the transport's probabilities
 * verbatim, so a wave re-applies any threshold without re-asking. The five
 * levels and `needsHelp` are the transport's words: nothing here is a default
 * a failed reading fills in, because a failed reading writes
 * {@link SupervisorUnjudged} and never this. `crossed` says whether the
 * reading passed a nudge threshold; `nudged` whether a nudge was handed to
 * the next boundary, which needs the host to have armed steering.
 * `remembered` holds the indexes of the candidates written to memory; the
 * recalled rows are judged by Relevance and journaled beside this as
 * `relevance-settled`. `decision-settled` beside this carries the snapshot
 * and every answer.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class SupervisorSettled extends Schema.TaggedClass<SupervisorSettled>(
  "flows/harness/AgentEvent/SupervisorSettled"
)("supervisor-settled", {
  eventType: Schema.Literal("flows.harness.supervisor-settled.v1"),
  /** The run's session. */
  scope: Schema.String,
  /** The frame the snapshot was built from. */
  frame: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Probability the run is repeating itself without converging. */
  thrashing: Schema.Number,
  /** Probability the run is still working on the task as stated. */
  onTarget: Schema.Number,
  /** Probability the run's evidence is suspect. */
  suspect: Schema.Number,
  /** Probability visible earlier context is contradicted by later evidence. */
  outdatedContext: Schema.optional(Schema.Number),
  /** Probability visible earlier context is no longer useful for this task. */
  irrelevantContext: Schema.optional(Schema.Number),
  frustrated: Level,
  anxious: Level,
  scared: Level,
  confused: Level,
  confident: Level,
  /** The one word a person is shown. */
  needsHelp: Schema.Literals(["none", "clarification", "permission", "stuck", "risky_action"]),
  /** Whether the reading crossed a nudge threshold. */
  crossed: Schema.Boolean,
  /** Whether a nudge was handed to the next boundary. */
  nudged: Schema.Boolean,
  /**
   * Whether steering was armed for this reading. `discipline-armed` states it
   * once, at a run's first frame; a resumed run may be armed differently, and
   * this is where the journal says what the reading actually ran under.
   * Absent from readings journaled before it existed.
   */
  steer: Schema.optional(Schema.Boolean),
  /** Indexes of candidates written to memory. */
  remembered: Schema.Array(Schema.Int),
  /**
   * Whether the snapshot had more uncalled skills than `Supervisor.skillLimit`,
   * so some were not scored. Absent when every one was.
   */
  skillsCapped: Schema.optional(Schema.Boolean),
  /** Wall-clock milliseconds the evaluation took. */
  latencyMs: Schema.Int,
  /** Token usage reported by the evaluator, absent when it supplied none. */
  usage: Schema.optional(Usage),
  /** Each armed monitor's probability in this reading, and whether it crossed. */
  monitors: Schema.optional(Schema.Array(Schema.Struct({
    id: Schema.String,
    kind: MonitorKind,
    p: Schema.Number,
    crossed: Schema.Boolean
  })))
}) {}

/**
 * A supervisor snapshot nobody could judge, and why.
 *
 * Written instead of {@link SupervisorSettled}, never beside it: no
 * evaluator on the host, a refusal, a deadline, an answer that does not
 * decode, a run that ended with the reading in flight. `reason` is
 * `unconfigured`, `interrupted`, or the transport's own error code. A reading
 * that fails inserts nothing, remembers nothing and reports no level, so a
 * wave counting calm runs counts only runs Jev read. An `interrupted` reading
 * was asked and may have cost a call, so a wave counting Jev's cost counts it.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class SupervisorUnjudged extends Schema.TaggedClass<SupervisorUnjudged>(
  "flows/harness/AgentEvent/SupervisorUnjudged"
)("supervisor-unjudged", {
  eventType: Schema.Literal("flows.harness.supervisor-unjudged.v1"),
  /** The run's session. */
  scope: Schema.String,
  /** The frame the snapshot was built from. */
  frame: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** `unconfigured`, `interrupted`, or the transport's own error code. */
  reason: UnjudgedReason,
  /** What went wrong, safe to journal: see `Evaluator.publicMessage`. */
  detail: Schema.String
}) {}

/**
 * A Jev reading that could not be judged, outside the supervisor.
 *
 * Written by a relevance, compaction or routing reading instead of its
 * settlement. The caller then keeps everything it would have filtered, so the
 * receipt is what says the filter did not run. `items` is how many items the
 * failed reading covered.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class DecisionUnjudged extends Schema.TaggedClass<DecisionUnjudged>(
  "flows/harness/AgentEvent/DecisionUnjudged"
)("decision-unjudged", {
  eventType: Schema.Literal("flows.harness.decision-unjudged.v1"),
  /** The run's session. */
  scope: Schema.String,
  /** The frame the reading was asked in. */
  frame: NonNegativeSafeInt,
  /** The classifier's stable id. */
  classifier: Schema.String,
  /** `unconfigured`, `interrupted`, or the transport's own error code. */
  reason: UnjudgedReason,
  /** What went wrong, safe to journal: see `Evaluator.publicMessage`. */
  detail: Schema.String,
  /** Items the failed reading covered. */
  items: NonNegativeSafeInt
}) {}

const RelevanceItem = Schema.Struct({
  kind: RelevanceKind,
  id: Schema.String,
  /** Digest of the item's text; the text itself is never journaled. */
  digest: Schema.String,
  /** Probability the item is unnecessary for the task as stated. */
  p: Schema.Number
})

/**
 * Which human-provided items a relevance reading kept and which it withheld.
 *
 * An item is withheld only at or above `withholdAt`. Ids and digests, never
 * item text.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class RelevanceSettled extends Schema.TaggedClass<RelevanceSettled>(
  "flows/harness/AgentEvent/RelevanceSettled"
)("relevance-settled", {
  eventType: Schema.Literal("flows.harness.relevance-settled.v1"),
  /** The run's session. */
  scope: Schema.String,
  /** The frame the reading was asked in. */
  frame: NonNegativeSafeInt,
  /**
   * `run` for the gate at run start, `supervisor` for recalled memory,
   * `recall` for a recall the model called.
   */
  source: Schema.Literals(["run", "supervisor", "recall"]),
  /** The probability at or above which an item is withheld. */
  withholdAt: Schema.Number,
  kept: Schema.Array(RelevanceItem),
  withheld: Schema.Array(RelevanceItem),
  /** Wall-clock milliseconds the evaluation took. */
  latencyMs: NonNegativeSafeInt,
  /** Token usage reported by the evaluator, absent when it supplied none. */
  usage: Schema.optional(Usage)
}) {}

/**
 * A withheld flow restored because the run called it by name.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class RelevanceRestored extends Schema.TaggedClass<RelevanceRestored>(
  "flows/harness/AgentEvent/RelevanceRestored"
)("relevance-restored", {
  eventType: Schema.Literal("flows.harness.relevance-restored.v1"),
  /** The run's session. */
  scope: Schema.String,
  /** The frame whose call restored it. */
  frame: NonNegativeSafeInt,
  /** The flow restored. */
  flow: Schema.String
}) {}

/**
 * A panel a routed run fans out to: each member seat, with the backups it
 * fails over to, answers the task, and `merger` merges their answers.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const SeatPanel = Schema.Struct({
  seats: Schema.Array(Schema.Struct({ seat: Schema.String, backups: Schema.Array(Schema.String) })),
  merger: Schema.String
})

/**
 * The seat a run with no declared model was routed to, and who chose it.
 *
 * `decidedBy` is `jev` when Jev answered the routing questions. Rows written
 * before the routing graph may say `only` and carry the seat choice's
 * `confidence`.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class SeatRouted extends Schema.TaggedClass<SeatRouted>(
  "flows/harness/AgentEvent/SeatRouted"
)("seat-routed", {
  eventType: Schema.Literal("flows.harness.seat-routed.v1"),
  /** The run's session. */
  scope: Schema.String,
  /** What the flow declared, such as `auto`. */
  declared: Schema.String,
  /** The seat chosen. */
  seat: Schema.String,
  /** The chosen seat's model. */
  modelId: Schema.String,
  /** The system-prompt variant chosen with it, when one was. */
  variant: Schema.NullOr(Schema.String),
  /** The seats offered. */
  candidates: Schema.Array(Schema.String),
  decidedBy: Schema.Literals(["jev", "only"]),
  /** The provider's own number, absent when it sent none. */
  confidence: Schema.optional(Schema.Number),
  /** Wall-clock milliseconds the routing took. */
  latencyMs: NonNegativeSafeInt,
  /** The seats `seat` fails over to, in order; absent when there are none. */
  backups: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The panel the task was routed to, whose merger is `seat`; absent for one seat. */
  panel: Schema.optionalKey(SeatPanel)
}) {}

/**
 * A memory read or write the supervisor asked for and the store refused.
 *
 * Written by the supervisor fiber beside the reading it belongs to, never
 * instead of it: a memory fault is not a supervisor fault, and the reading
 * still settles. `operation` says which side failed; `detail` is the store's
 * own account. A wave counts these rather than reading a log, because a
 * concurrent writer that loses a lock looks exactly like a run that
 * remembered nothing.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class SupervisorMemoryFailed extends Schema.TaggedClass<SupervisorMemoryFailed>(
  "flows/harness/AgentEvent/SupervisorMemoryFailed"
)("supervisor-memory-failed", {
  eventType: Schema.Literal("flows.harness.supervisor-memory-failed.v1"),
  /** The run's session. */
  scope: Schema.String,
  /** The frame whose reading asked. */
  frame: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** `recall` for a read, `remember` for a write. */
  operation: Schema.Literals(["recall", "remember"]),
  /** The store's own account of the failure. */
  detail: Schema.String
}) {}

/**
 * The controller telling a run that its own evidence is complete.
 *
 * The one control that is not a brake, and the only one written for a frame
 * that has done nothing wrong: the run watched a check fail before it changed
 * anything and watched the same check, or a broader one, pass after. Written
 * when the observation is *issued*, at most once per run, because what answers
 * it is the next frame's transition and the journal already writes that.
 *
 * `failed` and `passed` quote the two inputs as the run wrote them, and `epoch`
 * is the run's count of mutating frames when the failure was recorded, so the
 * ordering the observation asserts is checkable after the fact. Nothing is
 * refused and no cap is spent, so there is no cap field to record.
 *
 * @category events
 * @since 0.1.0
 */
export class SufficiencyObserved extends Schema.TaggedClass<SufficiencyObserved>(
  "flows/harness/AgentEvent/SufficiencyObserved"
)("sufficiency-observed", {
  eventType: Schema.Literal("flows.harness.sufficiency-observed.v1"),
  /** The flow that ran the failing check. */
  flow: Schema.String,
  /** The failing check's input as the run wrote it, clipped. */
  failed: Schema.String,
  /** The input of the passing check that answered it, clipped. */
  passed: Schema.String,
  /** Mutating frames the run had spent when the failure was recorded. */
  epoch: Schema.Int,
  /** The frame the observation was attached to. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller telling a run that its stored proof was already green.
 *
 * **Nothing emits this.** `VacuousVerification` is unwired from `CellTurn`;
 * the event stays declared so the r93 journals that carry it keep decoding and
 * so a controlled re-measure needs no schema change. See `VacuousVerification`
 * for the evidence that turned the arm off.
 *
 * The second control in this package that is not a brake, and the narrower of
 * the two: a cell stored `state.verification` naming a call this run had
 * already watched pass over the tree it was handed, before any frame changed a
 * byte. Written when the observation is issued, at most once per distinct
 * verification input, and delivered on the `invalidProbe` channel because it is
 * the same class of fact — a result that reads identically on a broken tree and
 * on a fixed one.
 *
 * `check` quotes the stored input as the run wrote it, and `callDigest` is the
 * controller's own identity for that call, so a reader can reconcile the
 * observation against the run's own `cell-call-settled` rows without replaying
 * anything. Nothing is refused and no cap is spent, so there is no cap field.
 *
 * It is named for what it is -- the digest of `{ flow, input }`, nothing signs
 * it -- rather than `signature`, the controller's own word for it everywhere
 * else. The journal redacts by field name, and `signature` names a credential
 * often enough in this repository (an HMAC over share claims, a grant
 * envelope, a webhook header) that the rule stays. A field this row exists to
 * be reconciled by cannot be written as `[REDACTED]`, so the field carries the
 * honest word and the rule keeps its reach.
 *
 * @category events
 * @since 0.1.0
 */
export class VacuousVerificationObserved extends Schema.TaggedClass<VacuousVerificationObserved>(
  "flows/harness/AgentEvent/VacuousVerificationObserved"
)("vacuous-verification-observed", {
  eventType: Schema.Literal("flows.harness.vacuous-verification-observed.v1"),
  /** The flow the stored check named. */
  flow: Schema.String,
  /** The stored check's input as the run wrote it, clipped. */
  check: Schema.String,
  /** The controller's identity for that call: the digest of its flow and input. */
  callDigest: Schema.String,
  /** The frame the observation was attached to. */
  nextFrame: Schema.Int
}) {}

/**
 * What one frame did to the workspace, and how the controller knows.
 *
 * Emitted once per frame that ran a cell. It is the frame's own answer to the
 * question every later audit asks — "did this frame change anything" — written
 * before any control acts on it, so a run that never trips the cap still leaves
 * the evidence behind.
 *
 * `basis` is the field that keeps the record honest. `observed` means the frame
 * had two measurements around it that each covered the whole workspace, so the
 * tree itself could answer. `partial` means a measurement was taken and stopped
 * at a bound before it covered the tree, so it is set aside: a prefix chosen by
 * sort order cannot say the files being edited outside it held still, and its
 * own movement is as likely to be a tool's churn as work. `declared` means the
 * host measured nothing at all.
 * Under the last two, `mutated` is only what the frame's calls claimed about
 * themselves — which is exactly the signal that missed a shell redirect over a
 * tracked source file.
 *
 * `mutated` is the union of the two signals, with one exception. A declaration
 * by a call that *succeeded* stands even where the measurement cannot see the
 * path it touched, because the alternative is failing a run that has been
 * editing all along on the strength of a walk that never looked at its files.
 * A declaration by a call that *failed* is a claim about what it would have
 * written, and where `basis` is `observed` and the digest did not move, the
 * tree has answered that claim: nothing was written, and the frame is not
 * counted as a write. So `declaredWrites: 1` beside `mutated: false` under
 * `observed` is a declaration the measurement vetoed, and both numbers stay in
 * the record.
 *
 * @category events
 * @since 0.1.0
 */
export class MutationObserved extends Schema.TaggedClass<MutationObserved>(
  "flows/harness/AgentEvent/MutationObserved"
)("mutation-observed", {
  eventType: Schema.Literal("flows.harness.mutation-observed.v1"),
  /** What the frame had to decide with: a full measurement, a partial one, or paperwork. */
  basis: Schema.Literals(["observed", "partial", "declared"]),
  /** Whether this frame changed anything: the tree said so, or a call declared it. */
  mutated: Schema.Boolean,
  /** Content address of the workspace as the frame left it; empty when unobserved. */
  digest: Schema.String,
  /** Paths the closing measurement covered; zero when unobserved. */
  paths: Schema.Int,
  /**
   * Calls this frame made that DECLARED a write, whether or not they landed.
   *
   * Journaled beside the observed answer rather than instead of it, because
   * the gap between the two numbers is the accounting defect itself: a frame
   * with `declaredWrites: 0` and `mutated: true` is a shell mutation nothing
   * else in the run can see, and a frame with `declaredWrites: 1` and
   * `mutated: false` under `observed` is a failed call whose declaration the
   * measurement contradicted.
   */
  declaredWrites: Schema.Int
}) {}

/**
 * One tree this run pinned, and the store's own name for it.
 *
 * Journaled at the mint rather than only at its use, because the two are
 * frames apart by design: a run pins the tree it is about to change and reads
 * against it later, and a journal that recorded only the reading could not say
 * which tree it was a reading of. `ref` is the host's vocabulary and the
 * controller never interprets it; a grader reconciles it against the store by
 * hand. See `EngineLike` `Snapshot`.
 *
 * @category events
 * @since 0.1.0
 */
export class CheckpointMinted extends Schema.TaggedClass<CheckpointMinted>(
  "flows/harness/AgentEvent/CheckpointMinted"
)("checkpoint-minted", {
  eventType: Schema.Literal("flows.harness.checkpoint-minted.v1"),
  /** The handle the cell holds, and what a later call names in its `at`. */
  id: Schema.String,
  /** What the host recorded, in the host's own vocabulary. */
  ref: Schema.String,
  /** The cell that minted it, and where in that cell. */
  cell: Schema.String,
  ordinal: Schema.Int
}) {}

/**
 * The durable reason a cell execution parked.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class Suspended extends Schema.TaggedClass<Suspended>(
  "flows/harness/AgentEvent/Suspended"
)("suspended", {
  eventType: Schema.Literal("flows.harness.suspended.v1"),
  reason: EngineLike.SuspendReason
}) {}

/**
 * A sealed compaction summary and the prefix it replaces.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CompactionSettled extends Schema.TaggedClass<CompactionSettled>(
  "flows/harness/AgentEvent/CompactionSettled"
)("compaction-settled", {
  eventType: Schema.Literal("flows.harness.compaction-settled.v1"),
  replacedPrefixDigest: Schema.String,
  // Counts messages, not segments: one live transcript segment can contain
  // both an assistant turn and its observations. Absent in older journals.
  retainedMessageCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Absent when nothing replaced was squashed. */
  summary: Schema.optional(ModelRequest.Message),
  /** Replaced messages carried over verbatim, after the summary. */
  kept: Schema.optional(Schema.Array(ModelRequest.Message)),
  /** What a reading marked each replaced message, by message digest. */
  marks: Schema.optional(Schema.Array(Schema.Struct({
    digest: Schema.String,
    mark: CompactionMark,
    /** The invariant that overrode a `remove`, when one did. */
    pinned: Schema.optional(CompactionPin)
  }))),
  /** Estimated tokens the removed messages held. */
  removedTokens: Schema.optional(NonNegativeSafeInt),
  /**
   * True when a judged run could not mark: its facts do not describe every
   * transcript segment, as in state written before marks, so every replaced
   * message was squashed.
   */
  unaligned: Schema.optional(Schema.Boolean)
}) {}

/**
 * Steering messages drained at a turn boundary.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class SteeringDrained extends Schema.TaggedClass<SteeringDrained>(
  "flows/harness/AgentEvent/SteeringDrained"
)("steering-drained", {
  eventType: Schema.Literal("flows.harness.steering-drained.v1"),
  /** What the person sent, in admission order. */
  messages: Schema.Array(ModelRequest.Message),
  /**
   * What the run's supervisor delivered at the same boundary: a nudge or a
   * recalled row. The model reads these above the person's messages; they
   * never join the task the completion brake or the supervisor reads.
   */
  supervisor: Schema.optional(Schema.Array(ModelRequest.Message)),
  /** The monitor whose delivery `supervisor` carries, when one's does. */
  monitor: Schema.optional(Schema.String),
  /** Crossed monitors not delivered at this boundary, and why. */
  suppressed: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, reason: Suppression }))),
  /** Keys of the memory rows delivered at this boundary. */
  memory: Schema.optional(Schema.Array(Schema.String))
}) {}

/**
 * The terminal decision made at a turn boundary.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class TurnClosed extends Schema.TaggedClass<TurnClosed>(
  "flows/harness/AgentEvent/TurnClosed"
)("turn-closed", {
  eventType: Schema.Literal("flows.harness.turn-closed.v1"),
  stopReason: ModelRequest.StopReason,
  outcome: Schema.Literals(["continue", "resolved", "aborted", "suspended"])
}) {}

/**
 * A permission request reported for engine-owned suspension and resolution.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class PermissionRequired extends Schema.TaggedClass<PermissionRequired>(
  "flows/harness/AgentEvent/PermissionRequired"
)("permission-required", {
  eventType: Schema.Literal("flows.harness.permission-required.v1"),
  request: Permission.PermissionRequired
}) {}

/**
 * A normalized harness abort.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class Aborted extends Schema.TaggedClass<Aborted>(
  "flows/harness/AgentEvent/Aborted"
)("aborted", {
  eventType: Schema.Literal("flows.harness.aborted.v1"),
  reason: Schema.String
}) {}

/**
 * The final assistant message produced by the harness.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class Resolved extends Schema.TaggedClass<Resolved>(
  "flows/harness/AgentEvent/Resolved"
)("resolved", {
  eventType: Schema.Literal("flows.harness.resolved.v1"),
  message: ModelRequest.AssistantMessage
}) {}

/**
 * All normalized events emitted by a harness adapter.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export const AgentEvent = Schema.Union([
  DisciplineArmed,
  TurnOpened,
  ModelDelta,
  ModelRequested,
  SeatFailedOver,
  ModelParked,
  ModelUnparked,
  ModelRetried,
  ModelSettled,
  CellProduced,
  CellRejectedInFrame,
  CellCallStarted,
  CellCallSettled,
  CellPrinted,
  CellSettled,
  TransitionApplied,
  MutationObserved,
  CheckpointMinted,
  ReadOnlyDemandIssued,
  ReadOnlyDemanded,
  RepeatDemanded,
  NarrowedDemanded,
  NarrowOnlyDemanded,
  UnmovedDemanded,
  UnresolvedDemanded,
  FailedCallDemanded,
  UnobservedDemanded,
  ClaimDemanded,
  DecisionSettled,
  SupervisorSettled,
  SupervisorUnjudged,
  SupervisorMemoryFailed,
  DecisionUnjudged,
  RelevanceSettled,
  RelevanceRestored,
  SeatRouted,
  SufficiencyObserved,
  VacuousVerificationObserved,
  Suspended,
  CompactionSettled,
  SteeringDrained,
  TurnClosed,
  PermissionRequired,
  Aborted,
  Resolved
]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * All normalized events emitted by a harness adapter.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export type AgentEvent = typeof AgentEvent.Type

/**
 * The journal event type of every member of {@link AgentEvent}, by tag.
 *
 * One table, because the literal used to be written three times: on the class,
 * in `CellTurn`'s emitter, and again in `Transcript`'s decoder. A projection
 * that reads a literal the emitter no longer writes silently returns an empty
 * transcript, and nothing failed when the two drifted. `CellTurn` and
 * `Transcript` both read this, and `Contracts.test.ts` pins it against the
 * union, so an event added without a row here fails a test rather than a run.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export const eventType = {
  aborted: "flows.harness.aborted.v1",
  cellCallSettled: "flows.harness.cell-call-settled.v1",
  cellCallStarted: "flows.harness.cell-call-started.v1",
  cellPrinted: "flows.harness.cell-printed.v1",
  cellProduced: "flows.harness.cell-produced.v1",
  cellRejectedInFrame: "flows.harness.cell-rejected-in-frame.v1",
  cellSettled: "flows.harness.cell-settled.v1",
  checkpointMinted: "flows.harness.checkpoint-minted.v1",
  claimDemanded: "flows.harness.claim-demanded.v1",
  compactionSettled: "flows.harness.compaction-settled.v1",
  decisionSettled: "flows.harness.decision-settled.v1",
  decisionUnjudged: "flows.harness.decision-unjudged.v1",
  disciplineArmed: "flows.harness.discipline-armed.v1",
  modelDelta: "flows.harness.model-delta.v1",
  modelRequested: "flows.harness.model-requested.v1",
  seatFailedOver: "flows.harness.seat-failed-over.v1",
  modelParked: "flows.harness.model-parked.v1",
  modelUnparked: "flows.harness.model-unparked.v1",
  modelRetried: "flows.harness.model-retried.v1",
  modelSettled: "flows.harness.model-settled.v1",
  mutationObserved: "flows.harness.mutation-observed.v1",
  narrowOnlyDemanded: "flows.harness.narrow-only-demanded.v1",
  narrowedDemanded: "flows.harness.narrowed-demanded.v1",
  permissionRequired: "flows.harness.permission-required.v1",
  readOnlyDemandIssued: "flows.harness.read-only-demand-issued.v1",
  readOnlyDemanded: "flows.harness.read-only-demanded.v1",
  relevanceRestored: "flows.harness.relevance-restored.v1",
  relevanceSettled: "flows.harness.relevance-settled.v1",
  repeatDemanded: "flows.harness.repeat-demanded.v1",
  resolved: "flows.harness.resolved.v1",
  seatRouted: "flows.harness.seat-routed.v1",
  steeringDrained: "flows.harness.steering-drained.v1",
  sufficiencyObserved: "flows.harness.sufficiency-observed.v1",
  supervisorSettled: "flows.harness.supervisor-settled.v1",
  supervisorUnjudged: "flows.harness.supervisor-unjudged.v1",
  supervisorMemoryFailed: "flows.harness.supervisor-memory-failed.v1",
  suspended: "flows.harness.suspended.v1",
  transitionApplied: "flows.harness.transition-applied.v1",
  turnClosed: "flows.harness.turn-closed.v1",
  turnOpened: "flows.harness.turn-opened.v1",
  unmovedDemanded: "flows.harness.unmoved-demanded.v1",
  unresolvedDemanded: "flows.harness.unresolved-demanded.v1",
  failedCallDemanded: "flows.harness.failed-call-demanded.v1",
  unobservedDemanded: "flows.harness.unobserved-demanded.v1",
  vacuousVerificationObserved: "flows.harness.vacuous-verification-observed.v1"
} as const
