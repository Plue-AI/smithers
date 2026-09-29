/**
 * Stable engine event constructors over the open journal envelope.
 *
 * @since 0.1.0
 */

import { Journal, JournalEvent } from "@smthrs/journal"
import type { EngineEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import { EventTypes } from "../EventTypes.ts"

/**
 * The addressing every engine record shares: which run wrote it, which source
 * inside that run, and which journal lineage it belongs to.
 *
 * Only `lineageId` is a semantic requirement rather than bookkeeping — a
 * record without one is a record no time-travel frame can address — which is
 * why it is required here rather than optional.
 *
 * @since 0.1.0
 * @category models
 */
export interface EventOptions {
  readonly runId: string
  readonly sourceId: string
  readonly sourceSeq?: number | undefined
  /**
   * The journal lineage this record addresses itself to — minted by the engine
   * (`FlowEngine.Lineage`) and carried on every engine record.
   *
   * Time travel (`packages/smithers/flows/time-travel/docs/README.md`) makes a frame the position
   * `(lineageId, seq)`, and time travel's replay skips any entry whose
   * `meta.lineageId` names a different lineage. An engine record without it is
   * a record no frame can address, which is why this is required rather than
   * optional: the omission used to make `TimeTravel.inspect` fail `not_found`
   * on every journal the production composition wrote.
   */
  readonly lineageId: string
  /**
   * The step-cache key whose sealed row holds this record's result, when one
   * exists. Replay reads it to hand the projection the sealed value instead of
   * re-deriving it.
   */
  readonly cacheKey?: string | undefined
  /**
   * What a re-emission of this producer identity means.
   *
   * The default, `content`, is the strict reading: the identity names one set
   * of bytes. `identity` is for a record whose sequence is derived from the
   * event itself, where a collision IS the same event observed twice and the
   * bytes that differ are metadata about the observation — a node settled
   * `built` by the walk that ran it and `clean` by the resumed walk that
   * replayed it is one node settling once, seen twice.
   */
  readonly dedupe?: JournalEvent.Dedupe | undefined
}

/**
 * The additive envelope every engine record carries.
 *
 * Kept a plain open record on purpose: `meta` is the journal's forward-compatible
 * side channel, so a consumer that does not know a key ignores it.
 */
const meta = (options: EventOptions): Readonly<Record<string, unknown>> => ({
  lineageId: options.lineageId,
  ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey })
})

const event = (options: EventOptions, eventType: string, payload: unknown): JournalEvent.Input =>
  new JournalEvent.Input({
    runId: options.runId as JournalEvent.RunId,
    sourceId: options.sourceId as JournalEvent.SourceId,
    ...(options.sourceSeq === undefined ? {} : { sourceSeq: options.sourceSeq as JournalEvent.SourceSeq }),
    ...(options.dedupe === undefined ? {} : { dedupe: options.dedupe }),
    eventType,
    payload,
    meta: meta(options)
  })

/**
 * The run's state advanced. Replaying these records in order is how time
 * travel derives the state AT a frame, rather than reading the run row's
 * latest value.
 *
 * @since 0.1.0
 * @category events
 */
export const runDecision = (options: EventOptions, payload: unknown) => event(options, EventTypes.runDecision, payload)
/**
 * An action attempt was admitted and its body is about to run. Paired with
 * {@link attemptFinished}; an unmatched one is crash evidence.
 *
 * @since 0.1.0
 * @category events
 */
export const attemptStarted = (options: EventOptions, payload: unknown) =>
  event(options, EventTypes.attemptStarted, payload)
/**
 * An action attempt settled, successfully or not. Closes the span opened by
 * {@link attemptStarted}.
 *
 * @since 0.1.0
 * @category events
 */
export const attemptFinished = (options: EventOptions, payload: unknown) =>
  event(options, EventTypes.attemptFinished, payload)
/**
 * A durable deferred was resolved from outside the run. Journaled because the
 * resolution is the only evidence of it — a replay cannot re-derive a value
 * that arrived over the network.
 *
 * @since 0.1.0
 * @category events
 */
export const deferredCompleted = (options: EventOptions, payload: unknown) =>
  event(options, EventTypes.deferredCompleted, payload)
/**
 * A durable timer was armed. Journaling the schedule rather than the firing is
 * what lets a resumed run re-arm the same deadline instead of restarting the
 * wait.
 *
 * @since 0.1.0
 * @category events
 */
export const clockScheduled = (options: EventOptions, payload: unknown) =>
  event(options, EventTypes.clockScheduled, payload)
/**
 * The run was interrupted — cancelled, fenced out, or torn down — as opposed
 * to failing. Recorded so a later reader can tell a cancelled run from a
 * broken one.
 *
 * @since 0.1.0
 * @category events
 */
export const interrupted = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.interrupted", payload)
/**
 * The jj pointer and plan digest in force at this point in the journal. These
 * are the two tier-2 facts replay cannot derive, which is why the engine emits
 * them and time travel's snapshot projector folds them into frame anchors.
 *
 * @since 0.1.0
 * @category events
 */
export const snapshotIdentified = (options: EventOptions, payload: unknown) =>
  event(options, EventTypes.snapshotIdentified, payload)
/**
 * A hard-mode step wrote outside its declared write set, so its result was
 * refused. The record is the forensic trail for a declaration that does not
 * match what the step actually does.
 *
 * @since 0.1.0
 * @category events
 */
export const hardViolation = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.hard-violation", payload)
/**
 * An expected-mode step wrote paths its declaration did not predict. Unlike
 * {@link hardViolation} the result still stands — the declaration was a
 * prediction, and this is the record of it being wrong.
 *
 * @since 0.1.0
 * @category events
 */
export const expectedSetDeviation = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.expected-set-deviation", payload)
/**
 * An isolated execution produced a diff bundle: its content address, the paths
 * it changed, and the deviations the declaration did not predict. One of the
 * two record types copy-back writes.
 *
 * It is written once the attempt's copy-back has settled, not before it — the
 * rebase loop owns the window in between, and a bundle that lost every race
 * was never a proposal the host saw. A crash inside that window leaves the
 * attempt row unfinished, so the replay re-executes and journals the bundle it
 * actually applies. An execution the declaration invalidated journals nothing
 * here at all; its `hard-violation` record carries the identity instead.
 *
 * @since 0.1.0
 * @category events
 */
export const diffBundleCaptured = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.diff-bundle-captured", payload)
/**
 * A diff bundle reached the host. Carries the rebase count, the deduplicated
 * `queued` effect keys, and the `dispatched` keys the delivery stage sent.
 * `dispatched` is present and empty when no `EffectDispatcher` is composed, so
 * the absence of delivery is a journal fact rather than an inference.
 *
 * @since 0.1.0
 * @category events
 */
export const copyBackSettled = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.copy-back-settled", payload)
/**
 * A plan was recorded and a run is about to be driven under it. Carries the
 * plan id, its generation-0 digest, and its node count, so
 * `packages/smithers/flows/plan/docs/api.md` asks the audit question, "show me the plan this ran
 * under". This record answers it exactly rather than reconstructing it.
 *
 * @since 0.1.0
 * @category events
 */
export const planRecorded = (options: EventOptions, payload: EngineEvent.PlanRecordedPayload) =>
  event(options, EventTypes.planRecorded, payload)
/**
 * An elaboration appended a pre-keyed subgraph to the SAME plan. The plan
 * grows; it is never invalidated, so this record names the new generation, the
 * advanced digest, and the node ids added — never a replacement graph.
 *
 * @since 0.1.0
 * @category events
 */
export const subgraphAppended = (options: EventOptions, payload: EngineEvent.SubgraphAppendedPayload) =>
  event(options, EventTypes.subgraphAppended, payload)
/**
 * A plan node was admitted to the scheduler: its caps and seats allowed it,
 * and its effective priority selected it. Paired with `node-settled`, this is
 * the queue-time evidence the journal measures.
 *
 * @since 0.1.0
 * @category events
 */
export const nodeScheduled = (options: EventOptions, payload: EngineEvent.NodeScheduledPayload) =>
  event(options, "flows.engine.node-scheduled", payload)
/**
 * A plan node reached an evaluation outcome. Skyframe's
 * `EvaluationProgressReceiver.EvaluationState` is the prior art:
 * `SUCCESS_VERSION_CHANGED`/`SUCCESS_VERSION_UNCHANGED` map onto `built`/
 * `clean`, and where Skyframe splits failure by version we use `failed` and
 * `skipped` — a content-addressed store never serves a failure from cache, so
 * `FAIL_VERSION_UNCHANGED` has no analogue, while a dependent that never ran
 * because its cone failed does. `deferred` is the one outcome outside the
 * Skyframe quadruple: a scheduling debt recorded by probabilistic selection,
 * not an evaluation state.
 *
 * @since 0.1.0
 * @category events
 */
export const nodeSettled = (options: EventOptions, payload: EngineEvent.NodeSettledPayload) =>
  event(options, "flows.engine.node-settled", payload)
/**
 * A scheduled node's dispatch identity was invalidated: its measured inputs no
 * longer match the ones its key was computed from, so it is re-keyed and
 * re-dispatched. Invalidation is re-keying — there is no dirty bit and no
 * invalidating visitor to journal.
 *
 * @since 0.1.0
 * @category events
 */
export const nodeInvalidated = (options: EventOptions, payload: EngineEvent.NodeInvalidatedPayload) =>
  event(options, "flows.engine.node-invalidated", payload)
/**
 * The reconciliation seam returned a verdict for a deviation or an unabsorbed
 * materialization conflict.
 *
 * @since 0.1.0
 * @category events
 */
export const nodeReconciled = (options: EventOptions, payload: EngineEvent.NodeReconciledPayload) =>
  event(options, "flows.engine.node-reconciled", payload)
/**
 * A selection guess postponed a sink node: it did not execute, wrote no cache
 * row, and this record is the debt — node id, plan key, the suspected edge,
 * and the likelihood — that a later guess-free pass repays. `Selection.debt`
 * folds these against {@link nodeSettled} records to list what is still owed.
 *
 * @since 0.1.0
 * @category events
 */
export const selectionDeferred = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.selection-deferred", payload)
/**
 * A selection guess proposed a flow no real dependency reaches. V1 records
 * and surfaces the proposal; it never auto-appends plan nodes, so this record
 * is the proposal's only artifact.
 *
 * @since 0.1.0
 * @category events
 */
export const selectionProposed = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.selection-proposed", payload)
/**
 * A run forced full selection: every verdict was treated as `Admit`, the way
 * `--fresh` ignores the cache. Journaled so a report can say the guesses were
 * overridden rather than absent.
 *
 * @since 0.1.0
 * @category events
 */
export const selectionOverridden = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.selection-overridden", payload)
/**
 * A selection layer returned a Defer or Propose verdict naming a non-sink.
 * The verdict is ignored — only sinks are deferrable — and this observation
 * records the layer disagreeing with the plan's shape, in the pattern of
 * Skyframe's `GraphInconsistencyReceiver`: note it, never wire the detector
 * to /dev/null.
 *
 * @since 0.1.0
 * @category events
 */
export const selectionInconsistent = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.selection-inconsistent", payload)
/**
 * Where a reused result came from: which run first produced it and under which
 * key. A cache hit is otherwise invisible in the journal, and provenance is
 * what makes one auditable after the fact.
 *
 * @since 0.1.0
 * @category events
 */
export const cacheProvenance = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.cache-provenance", payload)
/**
 * Two runs recorded different results under one step key — the journaled form
 * of an under-specified declaration.
 *
 * @since 0.1.0
 * @category events
 */
export const cacheConflict = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.cache-conflict", payload)
/**
 * A cached output failed its digest check and the entry was evicted. Journaled
 * because a repeat is a failing disk, not a coincidence.
 *
 * @since 0.1.0
 * @category events
 */
export const cacheCorruption = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.cache-corruption", payload)

/**
 * Reads a page of engine records without imposing an agent-shaped event union.
 *
 * @since 0.1.0
 * @category queries
 */
export const entries = (runId: string, after: number | undefined, limit: number) =>
  Effect.flatMap(
    Journal.Journal,
    (journal) =>
      journal.entries({
        runId: runId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after: after as JournalEvent.Seq }),
        limit
      })
  )
