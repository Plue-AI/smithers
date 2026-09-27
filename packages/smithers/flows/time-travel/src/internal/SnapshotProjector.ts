/**
 * The tier-2 anchor projector: engine snapshot records in, frame anchors out.
 *
 * `docs/concepts/derived-state.md`: a frame must carry the jj pointer
 * current when its seq was journaled and the plan digest in force, because
 * replay cannot derive either. The engine emits both facts as ordinary journal
 * records — it has to, it is the only thing that knows them — but the engine
 * must NOT write `flows_time_travel_snapshots` itself: `@smthrs/time-travel`
 * already depends on `@smthrs/engine-store`, so an engine that wrote this
 * package's tables would close a dependency cycle.
 *
 * A projector is the seam that keeps the arrow one-way. It reads the journal
 * (which both packages may depend on) and folds it into the anchor table
 * through {@link TimeTravelStore.Service.recordSnapshot}. The journal's projection
 * rule applies: a projection has no independent durable state, so replaying the
 * same entries reproduces the same anchors, and running it twice is a no-op.
 *
 * @since 0.1.0
 */

import { EventTypes } from "@smthrs/engine-store/EventTypes"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import type * as Projection from "@smthrs/journal/Projection"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { error, type TimeTravelError } from "../TimeTravelError.ts"
import { type Snapshot, TimeTravelStore } from "../TimeTravelStore.ts"
import * as HistoryLimit from "./HistoryLimit.ts"
import * as JournalPages from "./JournalPages.ts"
import { LineageMetadata } from "./LineageMetadata.ts"

/**
 * The anchor facts one lineage has put in force.
 *
 * `changeId` is the pointer the lineage's last anchor named, which is what a
 * `carried` record on that lineage resolves to; `planDigest` is the digest
 * the lineage's last plan record put in force. Both start absent, and an
 * anchor is written only once a pointer exists: a lineage that has taken no
 * snapshot has no tier-2 state to restore, and inventing one would be worse
 * than reporting none.
 *
 * @since 0.1.0
 * @category models
 */
export interface LineageState {
  readonly changeId: string | undefined
  readonly operationId?: string | undefined
  readonly planDigest: string | undefined
}

/**
 * What the fold carries between entries.
 *
 * Facts are keyed BY LINEAGE. A run's journal can interleave lineages, and a
 * `carried` record asserts "the same pointer as my lineage's previous anchor",
 * never "the pointer whoever wrote last named". One run-wide pointer resolved
 * lineage B's carried record to lineage A's snapshot and recorded it under B,
 * so a later fork or rewind of B restored A's workspace. The plan digest is
 * scoped the same way: a plan record belongs to the lineage that recorded it.
 *
 * @since 0.1.0
 * @category models
 */
export interface State {
  readonly lineages: Readonly<Record<string, LineageState>>
  readonly anchors: number
}

/**
 * The fold's starting {@link State}: no lineage known, nothing anchored.
 *
 * A projection has no durable state of its own beyond the anchors it writes,
 * so a fold from here replays to the same result as one resumed from them.
 *
 * @since 0.1.0
 * @category constants
 */
export const initial: State = { lineages: {}, anchors: 0 }

const emptyLineage: LineageState = { changeId: undefined, planDigest: undefined }

const SnapshotPayload = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  snapshotId: Schema.optionalKey(Schema.NonEmptyString),
  operationId: Schema.optionalKey(Schema.NonEmptyString),
  carried: Schema.optionalKey(Schema.Boolean)
})

/**
 * `digest` is optional because not every graph a run is driven from has one.
 * The plan scheduler names a digest an approval binds to; an interpreted flow
 * records the graph it built and has no plan id and no digest to name. A
 * record that names none puts none in force, and the lineage keeps the digest
 * its last naming record put there -- an anchor stamped with a digest the
 * record never claimed would be worse than an anchor with none.
 */
const PlanPayload = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  digest: Schema.optionalKey(Schema.NonEmptyString)
})

/**
 * One fold step: the state after `entry`, and the anchor the entry put in
 * force, if any.
 *
 * Pure with respect to the store, so {@link project} can batch a page's
 * anchors into one write while {@link projection} records each as it folds.
 *
 * @since 0.1.0
 * @category constructors
 */
export const step = (
  state: State,
  entry: JournalEvent.Entry
): Effect.Effect<{ readonly state: State; readonly anchor: Snapshot | undefined }, TimeTravelError> =>
  Effect.gen(function*() {
    const isPlan = entry.eventType === EventTypes.planRecorded ||
      entry.eventType === EventTypes.subgraphAppended
    if (!isPlan && entry.eventType !== EventTypes.snapshotIdentified) return { state, anchor: undefined }
    // Both facts are keyed by the lineage the record carries, so a record
    // that carries none is corrupt evidence for either: the engine stamps
    // the lineage on every record it writes.
    const kind = isPlan ? "plan" : "snapshot"
    const { lineageId } = yield* Schema.decodeUnknownEffect(LineageMetadata)(entry.meta).pipe(
      Effect.mapError((cause) => error("invalid", `${kind} event ${entry.eventId} has corrupt lineage metadata`, cause))
    )
    const lineage = state.lineages[lineageId] ?? emptyLineage
    if (isPlan) {
      const plan = yield* Schema.decodeUnknownEffect(PlanPayload)(entry.payload).pipe(
        Effect.mapError((cause) => error("invalid", `plan event ${entry.eventId} is corrupt`, cause))
      )
      return {
        state: {
          ...state,
          lineages: {
            ...state.lineages,
            [lineageId]: plan.digest === undefined ? lineage : { ...lineage, planDigest: plan.digest }
          }
        },
        anchor: undefined
      }
    }
    const payload = yield* Schema.decodeUnknownEffect(SnapshotPayload)(entry.payload).pipe(
      Effect.mapError((cause) => error("invalid", `snapshot event ${entry.eventId} is corrupt`, cause))
    )
    // `carried` asserts "the same pointer as this lineage's previous anchor",
    // the cheap half of the per-frame obligation. Resolving it here, from the
    // lineage's own state, is what turns one journal row into a real tier-2
    // address rather than another lineage's.
    const changeId = payload.snapshotId ?? lineage.changeId
    if (changeId === undefined) return { state, anchor: undefined }
    // The operation travels with the pointer it recorded: a new snapshot
    // replaces both, and a carried record inherits both.
    const operationId = payload.snapshotId === undefined ? lineage.operationId : payload.operationId
    return {
      state: {
        lineages: {
          ...state.lineages,
          [lineageId]: {
            changeId,
            ...(operationId === undefined ? {} : { operationId }),
            planDigest: lineage.planDigest
          }
        },
        anchors: state.anchors + 1
      },
      anchor: {
        runId: entry.runId,
        frame: { lineageId, seq: entry.seq },
        changeId,
        ...(operationId === undefined ? {} : { operationId }),
        ...(lineage.planDigest === undefined ? {} : { planDigest: lineage.planDigest })
      }
    }
  })

/**
 * The fold, as a reproducible journal projection.
 *
 * @since 0.1.0
 * @category constructors
 */
export const projection = (
  store: TimeTravelStore["Service"]
): Projection.Projection<State, TimeTravelError> => ({
  name: "flows/time-travel/snapshots",
  initial,
  reduce: (state, entry) =>
    step(state, entry).pipe(
      Effect.flatMap(({ anchor, state: next }) =>
        anchor === undefined ? Effect.succeed(next) : store.recordSnapshot(anchor).pipe(Effect.as(next))
      )
    )
})

/**
 * What {@link project} reads and where it stops.
 *
 * @since 0.1.0
 * @category models
 */
export interface ProjectOptions {
  /** Journal page size; defaults to 200. */
  readonly pageSize?: number | undefined
  /**
   * The seq the fold stops at, inclusive. A fork or rewind restores from the
   * anchor at or below its frame, so it has no use for anchors above it.
   */
  readonly upTo?: number | undefined
  /**
   * The most unanchored entries the fold may read before it refuses with
   * `limit_exceeded`. Entries at or below the anchored high-water mark are
   * never re-read, so a run whose anchors are current costs one page.
   */
  readonly maxEntries?: number | undefined
}

const planEventTypes = [EventTypes.planRecorded, EventTypes.subgraphAppended] as const

/**
 * The fold's state at the anchored high-water mark, rebuilt from the store.
 *
 * Each lineage's last anchor names the pointer a `carried` record resolves to,
 * and the plan digest that anchor stamped. A plan recorded on a lineage AFTER
 * its last anchor (or on a lineage that never anchored) is in force too but is
 * in no anchor, so the plan records at or below the mark are folded on top:
 * the journal serves them filtered by event type, a handful of rows.
 */
const resume = (
  journal: Journal.Service,
  runId: string,
  latest: ReadonlyArray<Snapshot>,
  pageSize: number
): Effect.Effect<{ readonly state: State; readonly highWater: number | undefined }, TimeTravelError> =>
  Effect.gen(function*() {
    let highWater: number | undefined
    const lineages: Record<string, LineageState> = {}
    for (const anchor of latest) {
      if (anchor.runId !== runId) continue
      if (highWater === undefined || anchor.frame.seq > highWater) highWater = anchor.frame.seq
      lineages[anchor.frame.lineageId] = {
        changeId: anchor.changeId,
        ...(anchor.operationId === undefined ? {} : { operationId: anchor.operationId }),
        planDigest: anchor.planDigest
      }
    }
    let state: State = { lineages, anchors: 0 }
    if (highWater === undefined) return { state, highWater }
    const mark = highWater
    yield* JournalPages.forEachPage(
      journal,
      {
        runId,
        pageSize,
        eventTypes: planEventTypes,
        label: "snapshot",
        readFailure: `could not read ${runId} for anchoring`
      },
      (entries) =>
        Effect.gen(function*() {
          for (const entry of entries) {
            if (entry.seq > mark) return JournalPages.Stop
            // A journal double may ignore the filter; the fold ignores the rest.
            if (!planEventTypes.includes(entry.eventType as (typeof planEventTypes)[number])) continue
            state = (yield* step(state, entry)).state
          }
          const tail = entries.at(-1)?.seq
          if (tail !== undefined && tail >= mark) return JournalPages.Stop
        })
    )
    return { state, highWater }
  })

/**
 * Folds one run's committed journal into its frame anchors, resuming from the
 * anchors already recorded.
 *
 * The fold is {@link projection}, a plain `@smthrs/journal` `Projection` that
 * `Journal.project` runs unchanged — that is the reusable artifact, and a live
 * follower should use exactly that. What this driver does NOT do is call
 * `Journal.project` itself, because that stream replays a run and then FOLLOWS
 * its committed tail: it never ends, so a verb that awaited it would hang
 * forever instead of forking. Paging `entries` gives the same fold a terminating
 * driver.
 *
 * The anchor table is the projection's own output, so it is also its cursor:
 * the driver reads the last anchor per lineage, folds only the entries above
 * the highest one, and writes each page's anchors in one store write. A run
 * whose anchors are current reads one page and writes nothing, and a second
 * run over the same journal is a no-op in the store, not merely in the result.
 *
 * @since 0.1.0
 * @category constructors
 */
export const project = (
  runId: string,
  options: ProjectOptions = {}
): Effect.Effect<State, TimeTravelError, Journal.Journal | TimeTravelStore> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const store = yield* TimeTravelStore
    const pageSize = options.pageSize ?? 200
    const latest = yield* store.latestSnapshots(runId)
    const resumed = yield* resume(journal, runId, latest, pageSize)
    let state = resumed.state
    if (options.upTo !== undefined && resumed.highWater !== undefined && resumed.highWater >= options.upTo) {
      return state
    }
    let read = 0
    yield* JournalPages.forEachPage(
      journal,
      {
        runId,
        after: resumed.highWater,
        pageSize,
        label: "snapshot",
        readFailure: `could not read ${runId} for anchoring`
      },
      (entries) =>
        Effect.gen(function*() {
          const anchors: Array<Snapshot> = []
          let reachedBound = false
          for (const entry of entries) {
            if (options.upTo !== undefined && entry.seq > options.upTo) {
              reachedBound = true
              break
            }
            read += 1
            if (options.maxEntries !== undefined && read > options.maxEntries) {
              return yield* Effect.fail(HistoryLimit.exceeded("anchor refresh", runId, options.maxEntries))
            }
            const next = yield* step(state, entry)
            state = next.state
            if (next.anchor !== undefined) anchors.push(next.anchor)
          }
          if (anchors.length > 0) yield* store.recordSnapshots(anchors)
          if (reachedBound) return JournalPages.Stop
        })
    )
    return state
  })
