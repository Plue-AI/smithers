/**
 * The deferred/clock fold: `flows_clock_deadlines` and the mutable half of
 * `flows_deferred_completions` rebuilt from the journal.
 *
 * Every change to either table is journalled on the run's own stream in the
 * transaction that makes it:
 *
 * - `flows.engine.clock-scheduled` when a clock row is inserted;
 * - `flows.engine.clock-completed` when a clock fires or its run settles
 *   first (`completeClock`, `completeRunClocks`);
 * - `flows.engine.deferred-completed` when the first completion wins, naming
 *   the row and the {@link JournalEvent.contentDigest} of its encoded `exit`
 *   and `metadata`;
 * - `flows.engine.deferred-consumed` when a run first observes a result.
 *
 * The journal is redacted and replayed to sync subscribers, so it never
 * carries a completion's value (issue #72). A clock row holds no value at
 * all, so the fold rebuilds it whole. A completion row's value stays in the
 * row: the fold rebuilds its `completed_at_ms` and `consumed_at_ms`, and a
 * rebuild checks the stored text against the recorded digests. A completion
 * the journal names but no row holds, or holds with other bytes, is a typed
 * {@link FoldIncomplete}, never a silent gap.
 *
 * Compaction deletes a run's entries below its floor, so the fold's state at
 * the floor has to survive in the floor's checkpoint: {@link checkpointState}
 * adds it under {@link checkpointKey}, and a rebuild of a compacted run whose
 * floor checkpoint lacks it fails {@link FoldIncomplete} with reason
 * `checkpoint_missing`. A rewind archives the suffix and removes the rows it
 * explains (`@smthrs/time-travel`), so the remaining journal still explains
 * the remaining rows.
 *
 * @since 1.0.0
 */

import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Journal, JournalEvent, Projection } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { EventTypes } from "./EventTypes.ts"

/**
 * The journal event types the fold reads.
 *
 * @category constants
 * @since 1.0.0
 */
export const eventTypes: ReadonlyArray<string> = [
  EventTypes.clockScheduled,
  EventTypes.clockCompleted,
  EventTypes.deferredCompleted,
  EventTypes.deferredConsumed
]

/**
 * The key a checkpoint's state keeps the fold under.
 *
 * @category constants
 * @since 1.0.0
 */
export const checkpointKey = "flows.engine.deferred-clock"

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/**
 * A clock as the journal records it.
 *
 * @category models
 * @since 1.0.0
 */
export const Clock = Schema.Struct({
  flowName: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  clockName: Schema.NonEmptyString,
  deferredName: Schema.NonEmptyString,
  dueAtMs: NonNegativeSafeInt,
  completedAtMs: Schema.NullOr(NonNegativeSafeInt)
})

/**
 * A clock as the journal records it.
 *
 * @category models
 * @since 1.0.0
 */
export type Clock = typeof Clock.Type

/**
 * A deferred completion as the journal records it. A completion journalled
 * before the fold existed carried its (redacted) value instead of digests and
 * no completion time: `exitDigest` and `metadataDigest` are then absent and
 * `completedAtMs` is `null`, and a rebuild keeps the row's own stamp.
 *
 * @category models
 * @since 1.0.0
 */
export const Deferred = Schema.Struct({
  flowName: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  deferredName: Schema.NonEmptyString,
  completedAtMs: Schema.NullOr(NonNegativeSafeInt),
  exitDigest: Schema.optionalKey(Digest),
  metadataDigest: Schema.optionalKey(Schema.NullOr(Digest)),
  consumedAtMs: Schema.NullOr(NonNegativeSafeInt)
})

/**
 * A deferred completion as the journal records it.
 *
 * @category models
 * @since 1.0.0
 */
export type Deferred = typeof Deferred.Type

/**
 * The folded clocks and completions, keyed by their row address.
 *
 * @category models
 * @since 1.0.0
 */
export interface State {
  readonly clocks: ReadonlyMap<string, Clock>
  readonly deferreds: ReadonlyMap<string, Deferred>
}

/**
 * The empty fold.
 *
 * @category constants
 * @since 1.0.0
 */
export const initial: State = { clocks: new Map(), deferreds: new Map() }

/**
 * The key of a clock row.
 *
 * @category models
 * @since 1.0.0
 */
export const clockKey = (
  address: { readonly flowName: string; readonly executionId: string; readonly clockName: string }
) => JSON.stringify([address.flowName, address.executionId, address.clockName])

/**
 * The key of a completion row.
 *
 * @category models
 * @since 1.0.0
 */
export const deferredKey = (
  address: { readonly flowName: string; readonly executionId: string; readonly deferredName: string }
) => JSON.stringify([address.flowName, address.executionId, address.deferredName])

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)

/**
 * Folds one committed journal entry. First writes win: a clock keeps its first
 * schedule and first completion, and a completion its first recording and
 * first consumption, exactly as the rows do. An entry of another type, or one
 * whose payload names no row, leaves the state unchanged.
 *
 * @category folds
 * @since 1.0.0
 */
export const reduce = (state: State, entry: JournalEvent.Entry): State => {
  const payload = record(entry.payload)
  if (payload === undefined || !text(payload.flowName) || !text(payload.executionId)) return state
  const flowName = payload.flowName
  const executionId = payload.executionId
  switch (entry.eventType) {
    case EventTypes.clockScheduled: {
      if (!text(payload.clockName) || !text(payload.deferredName) || !time(payload.dueAtMs)) return state
      const key = clockKey({ flowName, executionId, clockName: payload.clockName })
      if (state.clocks.has(key)) return state
      const clocks = new Map(state.clocks)
      clocks.set(key, {
        flowName,
        executionId,
        clockName: payload.clockName,
        deferredName: payload.deferredName,
        dueAtMs: payload.dueAtMs,
        completedAtMs: null
      })
      return { ...state, clocks }
    }
    case EventTypes.clockCompleted: {
      if (!text(payload.clockName) || !time(payload.completedAtMs)) return state
      const key = clockKey({ flowName, executionId, clockName: payload.clockName })
      const clock = state.clocks.get(key)
      if (clock === undefined || clock.completedAtMs !== null) return state
      const clocks = new Map(state.clocks)
      clocks.set(key, { ...clock, completedAtMs: payload.completedAtMs })
      return { ...state, clocks }
    }
    case EventTypes.deferredCompleted: {
      if (!text(payload.deferredName)) return state
      const key = deferredKey({ flowName, executionId, deferredName: payload.deferredName })
      if (state.deferreds.has(key)) return state
      const deferreds = new Map(state.deferreds)
      deferreds.set(key, {
        flowName,
        executionId,
        deferredName: payload.deferredName,
        completedAtMs: time(payload.completedAtMs) ? payload.completedAtMs : null,
        ...(digest(payload.exitDigest) ? { exitDigest: payload.exitDigest } : {}),
        ...(digest(payload.exitDigest) && (payload.metadataDigest === null || digest(payload.metadataDigest))
          ? { metadataDigest: payload.metadataDigest }
          : {}),
        consumedAtMs: null
      })
      return { ...state, deferreds }
    }
    case EventTypes.deferredConsumed: {
      if (!text(payload.deferredName) || !time(payload.consumedAtMs)) return state
      const key = deferredKey({ flowName, executionId, deferredName: payload.deferredName })
      const deferred = state.deferreds.get(key)
      if (deferred === undefined || deferred.consumedAtMs !== null) return state
      const deferreds = new Map(state.deferreds)
      deferreds.set(key, { ...deferred, consumedAtMs: payload.consumedAtMs })
      return { ...state, deferreds }
    }
    default:
      return state
  }
}

/**
 * The fold as a journal projection, for `Journal.project` over one run.
 *
 * @category folds
 * @since 1.0.0
 */
export const projection: Projection.Projection<State> = Projection.make({
  name: "flows.engine.deferred-clock",
  initial,
  reduce: (state, entry) => Effect.succeed(reduce(state, entry))
})

/**
 * The checkpoint encoding of the fold.
 *
 * @category models
 * @since 1.0.0
 */
export const Encoded = Schema.Struct({
  clocks: Schema.Array(Clock),
  deferreds: Schema.Array(Deferred)
})

/**
 * The checkpoint encoding of the fold.
 *
 * @category models
 * @since 1.0.0
 */
export type Encoded = typeof Encoded.Type

/**
 * Encodes the fold for a checkpoint.
 *
 * @category folds
 * @since 1.0.0
 */
export const encode = (state: State): Encoded => ({
  clocks: [...state.clocks.values()],
  deferreds: [...state.deferreds.values()]
})

/**
 * Decodes the fold a checkpoint kept, or `None` when the checkpoint state
 * holds none under {@link checkpointKey}.
 *
 * @category folds
 * @since 1.0.0
 */
export const fromCheckpoint = (checkpointState: unknown): Option.Option<State> => {
  const kept = record(checkpointState)?.[checkpointKey]
  if (kept === undefined) return Option.none()
  const decoded = Schema.decodeUnknownOption(Encoded)(kept)
  return Option.map(decoded, (encoded) => ({
    clocks: new Map(encoded.clocks.map((clock) => [clockKey(clock), clock])),
    deferreds: new Map(encoded.deferreds.map((deferred) => [deferredKey(deferred), deferred]))
  }))
}

/**
 * Why a rebuild could not reconstruct the tables.
 *
 * - `row_missing`: the journal names a completion no row holds.
 * - `digest_mismatch`: the row holds other bytes than the journal recorded.
 * - `run_missing`: a clock's run has no `flows_runs` row to hang it on.
 * - `checkpoint_missing`: a compacted run's floor checkpoint keeps no fold.
 *
 * @category errors
 * @since 1.0.0
 */
export const FoldIncompleteReason = Schema.Literals([
  "row_missing",
  "digest_mismatch",
  "run_missing",
  "checkpoint_missing"
])

/**
 * One reference a rebuild could not join.
 *
 * @category errors
 * @since 1.0.0
 */
export const Unjoined = Schema.Struct({
  reason: FoldIncompleteReason,
  executionId: Schema.String,
  flowName: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String)
})

/**
 * One reference a rebuild could not join.
 *
 * @category errors
 * @since 1.0.0
 */
export type Unjoined = typeof Unjoined.Type

/**
 * The journal references state the store no longer holds. The rebuild wrote
 * nothing.
 *
 * @category errors
 * @since 1.0.0
 */
export class FoldIncomplete extends Schema.TaggedError<FoldIncomplete>()(
  "@smthrs/engine-store/DeferredClockFold/FoldIncomplete",
  {
    code: Schema.Literal("fold_incomplete"),
    message: Schema.String,
    unjoined: Schema.Array(Unjoined)
  }
) {}

const pageSize = 512

/** Folds one run's entries after `after` into `start`, in sequence order. */
const foldEntries = (
  journal: Journal.Service,
  runId: string,
  start: State,
  after: JournalEvent.Seq | undefined,
  upTo?: number | undefined
) =>
  Effect.gen(function*() {
    let state = start
    let cursor = after
    while (true) {
      const page = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        eventTypes,
        limit: pageSize,
        ...(cursor === undefined ? {} : { after: cursor })
      })
      for (const entry of page.entries) {
        if (upTo !== undefined && entry.seq > upTo) return state
        state = reduce(state, entry)
        cursor = entry.seq
      }
      if (!page.hasMore) return state
    }
  })

/** The run's compaction floor checkpoint, if compaction ever ran. */
const floorOf = (sql: SqlClient.SqlClient, runId: string) =>
  sql<{ readonly seq: number | string; readonly state_json: string }>`
    SELECT seq, state_json FROM flows_journal_checkpoints
    WHERE run_id = ${runId} AND compacted_at_ms IS NOT NULL
    ORDER BY seq DESC LIMIT 1
  `.pipe(Effect.map((rows) => rows[0]))

/**
 * Folds one run: its floor checkpoint's fold, if it was compacted, then every
 * entry above the floor, up to and including `upTo` when given.
 */
const foldRun = (runId: string, upTo?: number | undefined) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const sql = yield* SqlClient.SqlClient
    const floor = yield* floorOf(sql, runId)
    if (floor === undefined) return yield* foldEntries(journal, runId, initial, undefined, upTo)
    const kept = fromCheckpoint(JSON.parse(floor.state_json) as unknown)
    if (Option.isNone(kept)) {
      return yield* Effect.fail(
        new FoldIncomplete({
          code: "fold_incomplete",
          message: `run ${runId} was compacted below a checkpoint that keeps no deferred/clock fold`,
          unjoined: [{ reason: "checkpoint_missing", executionId: runId }]
        })
      )
    }
    return yield* foldEntries(journal, runId, kept.value, Number(floor.seq) as JournalEvent.Seq, upTo)
  })

/**
 * The fold of one run's entries up to and including `upTo`, for the state of
 * a checkpoint at `upTo`. It starts from the run's floor checkpoint when the
 * run was compacted before.
 *
 * @category operations
 * @since 1.0.0
 */
export const capture = Effect.fn("DeferredClockFold.capture")(function*(runId: string, upTo: number) {
  return encode(yield* foldRun(runId, upTo))
})

/**
 * A checkpoint state that keeps the fold: `base` (an object, or nothing) with
 * the run's fold up to `upTo` under {@link checkpointKey}. A composition that
 * compacts runs writes its checkpoints through this, so compaction cannot
 * lose the deferred/clock history.
 *
 * @category operations
 * @since 1.0.0
 */
export const checkpointState = Effect.fn("DeferredClockFold.checkpointState")(function*(
  runId: string,
  upTo: number,
  base?: Readonly<Record<string, unknown>> | undefined
) {
  return { ...base, [checkpointKey]: yield* capture(runId, upTo) }
})

/**
 * What a {@link rebuild} read and wrote.
 *
 * @category models
 * @since 1.0.0
 */
export interface Rebuilt {
  /** Runs with deferred or clock entries, or with a compaction floor. */
  readonly runs: number
  /** Clock rows written. */
  readonly clocks: number
  /** Completion rows whose completion and consumption were rewritten. */
  readonly deferreds: number
  /** Completion rows no journal entry explains, left as they are. */
  readonly unexplained: number
}

interface StoredDeferred {
  readonly flow_name: string
  readonly execution_id: string
  readonly deferred_name: string
  readonly exit_json: string
  readonly metadata_json: string | null
}

/**
 * Rebuilds `flows_clock_deadlines` and the completion and consumption stamps
 * of `flows_deferred_completions` from the journal.
 *
 * Every run with deferred or clock entries, and every compacted run, is
 * folded in sequence order, from its floor checkpoint when it was compacted;
 * a compacted run whose floor keeps no fold fails, even one that never had a
 * clock, because the journal can no longer say. Every reference is joined
 * before anything is written: a completion with no row or with other bytes,
 * a clock whose run is gone, or a compacted run whose floor keeps no fold
 * fails {@link FoldIncomplete} listing each one, and nothing is written.
 * Otherwise, in one writer transaction, the clock table is replaced by the
 * fold's clocks and each folded completion row gets the fold's
 * `completed_at_ms` and `consumed_at_ms`. A completion row the journal does
 * not explain is left alone and counted.
 *
 * Run it on a quiescent store, as a restore does.
 *
 * @category operations
 * @since 1.0.0
 */
export const rebuild = Effect.fn("DeferredClockFold.rebuild")(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter
  // A compacted run may have no fold entry left above its floor, so every run
  // with a compaction floor is folded too.
  const runs = yield* sql<{ readonly run_id: string }>`
    SELECT run_id FROM flows_journal_events WHERE ${sql.in("event_type", eventTypes)}
    UNION
    SELECT run_id FROM flows_journal_checkpoints WHERE compacted_at_ms IS NOT NULL
    ORDER BY run_id
  `
  const unjoined: Array<Unjoined> = []
  const clocks: Array<Clock> = []
  const deferreds: Array<Deferred> = []
  for (const { run_id } of runs) {
    const state = yield* foldRun(run_id).pipe(
      Effect.catchTag("@smthrs/engine-store/DeferredClockFold/FoldIncomplete", (error) => {
        unjoined.push(...error.unjoined)
        return Effect.succeed(initial)
      })
    )
    clocks.push(...state.clocks.values())
    deferreds.push(...state.deferreds.values())
  }
  const liveRuns = new Set(
    (yield* sql<{ readonly run_id: string }>`SELECT run_id FROM flows_runs`).map((row) => row.run_id)
  )
  for (const clock of clocks) {
    if (!liveRuns.has(clock.executionId)) {
      unjoined.push({
        reason: "run_missing",
        executionId: clock.executionId,
        flowName: clock.flowName,
        name: clock.clockName
      })
    }
  }
  const stored = new Map(
    (yield* sql<StoredDeferred>`
      SELECT flow_name, execution_id, deferred_name, exit_json, metadata_json
      FROM flows_deferred_completions
    `).map((row) => [
      deferredKey({ flowName: row.flow_name, executionId: row.execution_id, deferredName: row.deferred_name }),
      row
    ])
  )
  for (const deferred of deferreds) {
    const row = stored.get(deferredKey(deferred))
    const reference = { executionId: deferred.executionId, flowName: deferred.flowName, name: deferred.deferredName }
    if (row === undefined) {
      unjoined.push({ reason: "row_missing", ...reference })
    } else if (
      (deferred.exitDigest !== undefined && JournalEvent.contentDigest(row.exit_json) !== deferred.exitDigest) ||
      (deferred.metadataDigest !== undefined &&
        (row.metadata_json === null ? null : JournalEvent.contentDigest(row.metadata_json)) !==
          deferred.metadataDigest)
    ) {
      unjoined.push({ reason: "digest_mismatch", ...reference })
    }
  }
  if (unjoined.length > 0) {
    return yield* Effect.fail(
      new FoldIncomplete({
        code: "fold_incomplete",
        message: `the journal references ${unjoined.length} deferred/clock rows the store cannot join`,
        unjoined
      })
    )
  }
  yield* writer.write(Effect.gen(function*() {
    yield* sql`DELETE FROM flows_clock_deadlines`
    for (const clock of clocks) {
      yield* sql`
        INSERT INTO flows_clock_deadlines (
          flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms
        ) VALUES (
          ${clock.flowName}, ${clock.executionId}, ${clock.clockName}, ${clock.deferredName},
          ${clock.dueAtMs}, ${clock.completedAtMs}
        )
      `
    }
    for (const deferred of deferreds) {
      yield* sql`
        UPDATE flows_deferred_completions
        SET completed_at_ms = COALESCE(${deferred.completedAtMs}, completed_at_ms),
            consumed_at_ms = ${deferred.consumedAtMs}
        WHERE flow_name = ${deferred.flowName}
          AND execution_id = ${deferred.executionId}
          AND deferred_name = ${deferred.deferredName}
      `
    }
  }))
  return {
    runs: runs.length,
    clocks: clocks.length,
    deferreds: deferreds.length,
    unexplained: stored.size - deferreds.length
  } satisfies Rebuilt
})
