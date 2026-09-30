/**
 * The durable `TimeTravelStore`, backed by SQL.
 *
 * Six tables carry what the journal cannot: `flows_time_travel_audits`
 * (one row per rewind, so a crash leaves something recovery can find),
 * `flows_time_travel_receipts` (proof a side effect was compensated),
 * `flows_time_travel_snapshots` (the tier-2 anchors at a frame),
 * `flows_time_travel_fork_intents` (a minted fork id, reserved before its
 * workspace is provisioned so a crash between the two never blocks a retry),
 * `flows_time_travel_edges` (fork edges), and `flows_time_travel_archive`
 * (records retained across truncation). The migration ladder also initializes
 * `flows_journal_generations`, shared with the journal.
 * Lineage edges are read as ONE tree across this package's fork edges and the
 * engine's child spawns (`docs/concepts/frames-and-lineage.md`).
 *
 * The derived reads — state and attempts at a frame — are folds over journal
 * records rather than columns, because the run row holds only the *latest*
 * state. SQLite and PostgreSQL share the migration identities and operations;
 * dialect fragments handle JSON extraction, constraints, and recursive syntax.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import { affectedRows, DurableWriter } from "@smthrs/database/DurableWriter"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import { EventTypes } from "@smthrs/engine-store/EventTypes"
import { RunState } from "@smthrs/engine-store/RunState"
import * as JournalGeneration from "@smthrs/journal/JournalGeneration"
import { isTerminalRunStatus, type RunStatus } from "@smthrs/run-store/RunStore"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as EffectBoundary from "./EffectBoundary.ts"
import { forkCreatedEventType, Frame, type LineageEdge, LineageEdgeKind } from "./Frame.ts"
import * as LineageTree from "./internal/LineageTree.ts"
import * as Migrations from "./Migrations.ts"
import { error, TimeTravelError } from "./TimeTravelError.ts"
import * as TimeTravelStore from "./TimeTravelStore.ts"

/**
 * Applies pending time-travel migration rungs and records them in
 * `flows_migrations`. The journal and run-store ladders must already be
 * migrated; use `Migrations.run` to install the full durable schema.
 *
 * @since 0.1.0
 * @category migrations
 */
export const migrate: Effect.Effect<void, unknown, SqlClient.SqlClient> = DatabaseMigrations.run([Migrations.set]).pipe(
  Effect.asVoid
)
const Json = Schema.fromJsonString(Schema.Unknown)
const RunStateJson = Schema.fromJsonString(RunState)
const mapError = (cause: unknown) =>
  cause instanceof TimeTravelError ? cause : error("unknown", "time-travel persistence failed", cause)
const decodeJson = (value: string | null) =>
  value === null
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(Json)(value).pipe(Effect.mapError(mapError))
/**
 * Encodes a value for a time-travel column WITHOUT the journal's redaction
 * pass. Audit detail and receipts are executable state, not observability:
 * recovery decodes `detail_json` and hands `compensation.handlerReceipts[].data`
 * back to each handler's `rollback`, and a placeholder there would roll back
 * the wrong thing (the same reason `@smthrs/journal` Redaction excludes
 * `state_json`, checkpoints, and outcomes). A receipt must therefore never
 * carry a credential: `Compensation.compensate` refuses one the redaction
 * rules would rewrite, and `docs/guides/compensate-an-effect.md` says so.
 */
const encodeJson = (value: unknown) => Schema.encodeEffect(Json)(value).pipe(Effect.mapError(mapError))

/** One `flows_time_travel_audits` row as SQL returns it. */
interface AuditRow {
  readonly id: string
  readonly run_id: string
  readonly lineage_id: string
  readonly seq: number
  readonly status: TimeTravelStore.Audit["status"]
  readonly rate_limit_json: string | null
  readonly detail_json: string | null
}

const auditFromRow = (row: AuditRow) =>
  Effect.gen(function*() {
    const rateLimit = yield* decodeJson(row.rate_limit_json)
    const detail = yield* decodeJson(row.detail_json)
    return {
      id: row.id,
      runId: row.run_id,
      frame: { lineageId: row.lineage_id, seq: row.seq },
      status: row.status,
      rateLimit,
      detail
    }
  })

/** The `[digest, attempt]` pairs of a set of attempts, as one JSON parameter. */
const attemptRefsJson = (refs: ReadonlyArray<TimeTravelStore.AttemptRef>): string =>
  JSON.stringify(refs.map((ref) => [ref.stepKeyDigest, ref.attempt]))

const restartableStateJson = (stateJson: string, forkKeyRunIds: ReadonlyArray<string>) =>
  Schema.decodeUnknownEffect(RunStateJson)(stateJson).pipe(
    Effect.flatMap((state) => {
      const { cancellation: _, result: __, ...restartable } = state
      return Schema.encodeEffect(RunStateJson)({ ...restartable, forkKeyRunIds })
    }),
    Effect.mapError((cause) => error("unknown", "could not materialize executable fork state", cause))
  )

/** @private */
const EdgeRow = Schema.Struct({
  parent_run_id: Schema.NonEmptyString,
  parent_seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  child_run_id: Schema.NonEmptyString,
  kind: LineageEdgeKind,
  attached: Schema.Literals([0, 1])
})

/** @private */
type EdgeRow = typeof EdgeRow.Type

const decodeEdges = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(EdgeRow))(rows).pipe(Effect.mapError(mapError))

const edgeFromRow = (row: EdgeRow): LineageEdge => ({
  parentRunId: row.parent_run_id,
  parentSeq: row.parent_seq,
  childRunId: row.child_run_id,
  kind: row.kind,
  attached: row.attached === 1
})

/**
 * The kind an engine child spawn is journaled under.
 *
 * `@smthrs/engine-store` writes a boundary-shaped record naming the child at
 * the parent's spawn seq. Reading it here is the BRIDGE decision: rather than
 * teach the engine to write `flows_time_travel_edges` (it must not depend on
 * this package) or leave three parallel stores of the same tree, fork edges
 * stay in `flows_time_travel_edges` and child edges are DERIVED from the
 * parent's own journal, which is the only one of the three that carries the
 * `parentSeq` a frame needs. `flows_runs.parent_run_id` and
 * `flows_run_parents` keep their existing jobs — the fork chain walk and cycle
 * detection — and stop being a third opinion about the lineage tree.
 *
 * @private
 */
const spawnEffectKind = EventTypes.childSpawnKind

/**
 * The decision a trampoline round records when it hands off to the next one.
 *
 * The same BRIDGE reasoning as {@link spawnEffectKind}: a later round is its
 * own run row with its own `lineage_id`/`round_ordinal`, but `flows_runs`
 * carries no parent SEQ, and a frame needs one. The handoff decision does — it
 * is journaled on the round that finished, at the exact position the round
 * advanced — so continuation edges are DERIVED from it rather than from a
 * fourth store of the same tree.
 *
 * @private
 */
const handoffEventType = EventTypes.runDecision

/** @private */
const DecisionPayload = Schema.Struct({ state: Schema.Unknown })
const decisionState = Schema.decodeUnknownOption(DecisionPayload)

/** @private */
const attemptRef = Schema.decodeUnknownEffect(TimeTravelStore.AttemptRef)

/**
 * Builds the SQL-backed store, running {@link migrate} over a database the
 * journal and run-store ladders have already migrated. Missing prerequisite
 * tables and migration failures fail with `TimeTravelError`. The `SqlClient`
 * requirement is a SQLite dialect requirement, not a portable one — see the
 * module header.
 *
 * Writes go through `DurableWriter` rather than straight to `SqlClient`, so a
 * rewind's audit row, receipts, and truncation land under the same durability
 * discipline as the engine's own journal writes.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: Effect.Effect<
  TimeTravelStore.Service,
  TimeTravelError,
  DurableWriter | SqlClient.SqlClient
> = Effect.gen(
  function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter

    for (const table of ["flows_journal_events", "flows_runs"]) {
      const found = yield* Dialect.tables(sql).pipe(Effect.map((rows) => rows.filter((row) => row.name === table)))
        .pipe(
          Effect.mapError((cause) => error("unknown", `could not check time-travel prerequisite ${table}`, cause))
        )
      if (found.length === 0) {
        return yield* Effect.fail(error(
          "unknown",
          `time-travel requires ${table}; run the journal and run-store migration ladders before building the store`
        ))
      }
    }
    yield* migrate.pipe(
      // The SQL migrator raises failed DDL as defects; store construction
      // exposes these through the same typed channel as prerequisite errors.
      Effect.catchDefect((cause) => Effect.fail(cause)),
      Effect.mapError((cause) => error("unknown", "time-travel schema migration failed", cause))
    )

    /**
     * The lineage edges under one run, forks and engine child spawns as ONE
     * tree.
     *
     * A run has one lineage tree with an edge kind; this is that union, expressed where both sources can be
     * read. Fork edges stay in `flows_time_travel_edges`; child edges and
     * trampoline continuation edges are DERIVED from the parent's own journal,
     * which is the only one of the three stores of this tree that carries the
     * `parentSeq` a frame needs.
     *
     * Each recursive step probes fork edges by parent_run_id and journal
     * edges by run_id through the partial lineage indexes. The final edge
     * projection makes the same probes for each reachable parent; unrelated
     * runs are never materialized. CROSS JOIN keeps reachable as the outer
     * loop. Pinning the partial indexes keeps unrelated event kinds out of
     * each probe even when the journal also has a general run/event index.
     * UNION deduplicates the reachable run ids so cycles terminate. The set
     * ignores attachment and frame on purpose: LineageTree.descendants applies those
     * policies to this superset of the edges it visits.
     */
    const edgesUnder = (runId: string) =>
      (Dialect.isPostgres(sql) ?
        sql<EdgeRow>`
      WITH RECURSIVE all_edges AS NOT MATERIALIZED (
      SELECT parent_run_id, parent_seq, child_run_id, kind, attached
      FROM flows_time_travel_edges
      UNION ALL
      SELECT flows_journal_events.run_id AS parent_run_id,
             seq AS parent_seq,
             ${Dialect.jsonText(sql, sql`payload_json`, "$.effect.output.childRunId")} AS child_run_id,
             'child' AS kind,
             CASE WHEN ${
          Dialect.jsonText(sql, sql`payload_json`, "$.effect.output.attached")
        } = 'true' THEN 1 ELSE 0 END AS attached
      FROM flows_journal_events ${Dialect.indexHint(sql, "flows_journal_events_child_spawn_idx")}
      WHERE event_type = ${sql.literal(`'${EffectBoundary.eventType}'`)}
        AND ${Dialect.jsonText(sql, sql`payload_json`, "$.effect.kind")} = ${sql.literal(`'${spawnEffectKind}'`)}
        AND ${Dialect.jsonText(sql, sql`payload_json`, "$.effect.status")} = 'succeeded'
        AND ${Dialect.jsonText(sql, sql`payload_json`, "$.effect.output.childRunId")} IS NOT NULL
      UNION ALL
      SELECT flows_journal_events.run_id AS parent_run_id,
             seq AS parent_seq,
             ${Dialect.jsonText(sql, sql`payload_json`, "$.nextExecutionId")} AS child_run_id,
             'continuation' AS kind,
             0 AS attached
      FROM flows_journal_events ${Dialect.indexHint(sql, "flows_journal_events_handoff_idx")}
      WHERE event_type = ${sql.literal(`'${handoffEventType}'`)}
        AND ${Dialect.jsonText(sql, sql`payload_json`, "$.decision")} = 'handed-off'
        AND ${Dialect.jsonText(sql, sql`payload_json`, "$.nextExecutionId")} IS NOT NULL
      ), reachable (run_id) AS (
        SELECT ${runId}
        UNION
        SELECT all_edges.child_run_id FROM reachable CROSS JOIN all_edges WHERE all_edges.parent_run_id = reachable.run_id
      )
      SELECT all_edges.* FROM reachable CROSS JOIN all_edges WHERE all_edges.parent_run_id = reachable.run_id
    ` :
        sql<EdgeRow>`
      WITH RECURSIVE reachable (run_id) AS (
        SELECT ${runId}
        UNION
        SELECT flows_time_travel_edges.child_run_id
        FROM reachable CROSS JOIN flows_time_travel_edges
        WHERE flows_time_travel_edges.parent_run_id = reachable.run_id
        UNION
        SELECT json_extract(payload_json, '$.effect.output.childRunId')
        FROM reachable CROSS JOIN flows_journal_events INDEXED BY flows_journal_events_child_spawn_idx
        WHERE flows_journal_events.run_id = reachable.run_id
          AND event_type = ${sql.literal(`'${EffectBoundary.eventType}'`)}
          AND json_extract(payload_json, '$.effect.kind') = ${sql.literal(`'${spawnEffectKind}'`)}
          AND json_extract(payload_json, '$.effect.status') = 'succeeded'
          AND json_extract(payload_json, '$.effect.output.childRunId') IS NOT NULL
        UNION
        SELECT json_extract(payload_json, '$.nextExecutionId')
        FROM reachable CROSS JOIN flows_journal_events INDEXED BY flows_journal_events_handoff_idx
        WHERE flows_journal_events.run_id = reachable.run_id
          AND event_type = ${sql.literal(`'${handoffEventType}'`)}
          AND json_extract(payload_json, '$.decision') = 'handed-off'
          AND json_extract(payload_json, '$.nextExecutionId') IS NOT NULL
      )
      SELECT parent_run_id, parent_seq, child_run_id, kind, attached
      FROM reachable CROSS JOIN flows_time_travel_edges
      WHERE flows_time_travel_edges.parent_run_id = reachable.run_id
      UNION ALL
      SELECT flows_journal_events.run_id AS parent_run_id,
             seq AS parent_seq,
             json_extract(payload_json, '$.effect.output.childRunId') AS child_run_id,
             'child' AS kind,
             CASE WHEN json_extract(payload_json, '$.effect.output.attached') = 1 THEN 1 ELSE 0 END AS attached
      FROM reachable CROSS JOIN flows_journal_events INDEXED BY flows_journal_events_child_spawn_idx
      WHERE flows_journal_events.run_id = reachable.run_id
        AND event_type = ${sql.literal(`'${EffectBoundary.eventType}'`)}
        AND json_extract(payload_json, '$.effect.kind') = ${sql.literal(`'${spawnEffectKind}'`)}
        AND json_extract(payload_json, '$.effect.status') = 'succeeded'
        AND json_extract(payload_json, '$.effect.output.childRunId') IS NOT NULL
      UNION ALL
      SELECT flows_journal_events.run_id AS parent_run_id,
             seq AS parent_seq,
             json_extract(payload_json, '$.nextExecutionId') AS child_run_id,
             'continuation' AS kind,
             0 AS attached
      FROM reachable CROSS JOIN flows_journal_events INDEXED BY flows_journal_events_handoff_idx
      WHERE flows_journal_events.run_id = reachable.run_id
        AND event_type = ${sql.literal(`'${handoffEventType}'`)}
        AND json_extract(payload_json, '$.decision') = 'handed-off'
        AND json_extract(payload_json, '$.nextExecutionId') IS NOT NULL
    `).pipe(Effect.flatMap(decodeEdges), Effect.mapError(mapError))

    /**
     * Reads one event type's lineage-filtered prefix.
     *
     * An entry with no `meta.lineageId` is kept: records written before lineage
     * was minted, and records from producers outside the engine, are still
     * evidence of this run, and dropping them would silently shorten the fold.
     */
    const prefix = (
      runId: string,
      frame: TimeTravelStore.Snapshot["frame"],
      eventType: string,
      includeInherited = false
    ) =>
      sql<{ readonly seq: number; readonly payload_json: string }>`
        SELECT seq, payload_json FROM flows_journal_events
        WHERE run_id = ${runId}
          AND seq <= ${frame.seq}
          AND event_type = ${eventType}
          AND (
            ${includeInherited ? 1 : 0} = 1
            OR ${Dialect.jsonText(sql, sql`meta_json`, "$.lineageId")} IS NULL
            OR ${Dialect.jsonText(sql, sql`meta_json`, "$.lineageId")} = ${frame.lineageId}
          )
        ORDER BY seq ASC
      `.pipe(Effect.mapError(mapError))

    /**
     * Run state at a frame, rebuilt by folding the run-decision records —
     * Temporal's `mutable_state_rebuilder.ApplyEvents`, scoped to the one
     * decision channel that carries state. The base comes from the `created`
     * decision (the only record naming `flowName` and `payload`) and each later
     * transition replaces it wholesale, so the fold is "last state at or before
     * the frame".
     */
    const forkStateRow = (runId: string) =>
      sql<{ readonly state_json: string }>`
        SELECT state_json FROM flows_runs
        WHERE run_id = ${runId} AND EXISTS (
          SELECT 1 FROM flows_time_travel_edges
          WHERE child_run_id = ${runId} AND kind = 'fork'
        )
      `.pipe(Effect.mapError(mapError))

    const stateAtFrame = (
      runId: string,
      frame: TimeTravelStore.Snapshot["frame"]
    ): Effect.Effect<string | undefined, TimeTravelError> =>
      Effect.gen(function*() {
        const fork = yield* forkStateRow(runId)
        const rows = yield* prefix(runId, frame, EventTypes.runDecision, fork.length > 0)
        let state: unknown = undefined
        for (const row of rows) {
          const payload = yield* decodeJson(row.payload_json)
          const decoded = decisionState(payload)
          if (decoded._tag === "Some") state = decoded.value.state
        }
        if (state === undefined) return undefined
        // A rewind into copied history retains this run's immutable origins.
        if (fork[0] !== undefined) {
          const current = yield* Schema.decodeUnknownEffect(RunStateJson)(fork[0].state_json).pipe(
            Effect.mapError(mapError)
          )
          const atFrame = yield* Schema.decodeUnknownEffect(RunState)(state).pipe(Effect.mapError(mapError))
          return yield* Schema.encodeEffect(RunStateJson)({
            ...atFrame,
            ...(current.forkKeyRunIds === undefined ? {} : { forkKeyRunIds: current.forkKeyRunIds })
          }).pipe(Effect.mapError(mapError))
        }
        return yield* encodeJson(state)
      })

    /**
     * The attempts admitted at a frame. `attempt-started` adds one and nothing
     * removes it: a failed attempt is still part of the history the child
     * inherits, and the fork replays its recorded failure rather than re-running
     * the body.
     */
    /**
     * A row-value subquery naming a set of attempts, so one statement can copy
     * or keep the whole set instead of issuing one statement per row.
     */
    const attemptRefsSelect = (refs: ReadonlyArray<TimeTravelStore.AttemptRef>) =>
      Dialect.isPostgres(sql)
        ? sql`SELECT value ->> 0, (value ->> 1)::numeric FROM jsonb_array_elements(${attemptRefsJson(refs)}::jsonb)`
        : sql`SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(${attemptRefsJson(refs)})`

    const attemptsAtFrame = (
      runId: string,
      frame: TimeTravelStore.Snapshot["frame"],
      eventType: string = EventTypes.attemptStarted,
      includeInherited = false
    ): Effect.Effect<ReadonlyArray<TimeTravelStore.AttemptRef>, TimeTravelError> =>
      Effect.gen(function*() {
        const inherited = includeInherited || (yield* forkStateRow(runId)).length > 0
        return yield* prefix(runId, frame, eventType, inherited)
      }).pipe(
        Effect.flatMap((rows) =>
          Effect.gen(function*() {
            const refs = new Map<string, TimeTravelStore.AttemptRef>()
            for (const row of rows) {
              const payload = yield* decodeJson(row.payload_json)
              const decoded = yield* attemptRef(payload).pipe(
                Effect.mapError((cause) => error("invalid", `${eventType} at seq ${row.seq} is malformed`, cause))
              )
              refs.set(`${decoded.stepKeyDigest}:${decoded.attempt}`, decoded)
            }
            return [...refs.values()]
          })
        )
      )

    /**
     * The generation of a run's current history, which is the one
     * `SqlJournal.generation` reports: zero until a truncation raises it.
     *
     * Read inside the truncation's transaction and BEFORE its own bump, so the
     * archived records carry the generation being truncated rather than
     * the one that replaced them.
     */
    const currentGeneration = (runId: string) =>
      sql<{ readonly generation: number }>`
        SELECT generation FROM flows_journal_generations WHERE run_id = ${runId}
      `.pipe(Effect.map((rows) => rows[0] === undefined ? 0 : Number(rows[0].generation)))

    /**
     * Removes the mutable durable-wait projections explained by a journal
     * suffix that is about to be archived. Sequence numbers do not live on
     * either projection table, so the event payload is the only durable link
     * between a truncated record and the row it created.
     */
    const deleteProjectedWaits = (runId: string, afterSeq: number) =>
      Effect.gen(function*() {
        yield* sql`
          DELETE FROM flows_deferred_completions
          WHERE execution_id = ${runId}
            AND EXISTS (
              SELECT 1 FROM flows_journal_events AS event
              WHERE event.run_id = ${runId}
                AND event.seq > ${afterSeq}
                AND event.event_type = ${EventTypes.deferredCompleted}
                AND ${
          Dialect.jsonText(sql, sql`event.payload_json`, "$.flowName")
        } = flows_deferred_completions.flow_name
                AND ${
          Dialect.jsonText(sql, sql`event.payload_json`, "$.executionId")
        } = flows_deferred_completions.execution_id
                AND ${
          Dialect.jsonText(sql, sql`event.payload_json`, "$.deferredName")
        } = flows_deferred_completions.deferred_name
            )
        `
        yield* sql`
          DELETE FROM flows_clock_deadlines
          WHERE execution_id = ${runId}
            AND EXISTS (
              SELECT 1 FROM flows_journal_events AS event
              WHERE event.run_id = ${runId}
                AND event.seq > ${afterSeq}
                AND event.event_type = ${EventTypes.clockScheduled}
                AND ${Dialect.jsonText(sql, sql`event.payload_json`, "$.flowName")} = flows_clock_deadlines.flow_name
                AND ${
          Dialect.jsonText(sql, sql`event.payload_json`, "$.executionId")
        } = flows_clock_deadlines.execution_id
                AND ${Dialect.jsonText(sql, sql`event.payload_json`, "$.clockName")} = flows_clock_deadlines.clock_name
            )
        `
      }).pipe(Effect.mapError(mapError))

    /**
     * The id the next fork off this frame carries.
     *
     * The ordinal counts the edges already hanging off `(parent, seq)` PLUS
     * the intents still reserved there, so a frame forked twice numbers its
     * children 1 and 2, and a mint that never committed keeps its number. It
     * used to count committed edges alone: a process that minted, provisioned
     * the child's jj workspace, and died before `createFork` retried under the
     * same id, and jj refused the lane name its own leftover held. `nextForkId`
     * reads this inside the transaction that reserves the id; `createFork`
     * reads it inside its own for the caller that minted nothing.
     */
    const mintForkId = (
      parentRunId: string,
      frame: TimeTravelStore.Snapshot["frame"]
    ): Effect.Effect<string, TimeTravelError> =>
      sql<{ readonly count: number }>`
        SELECT (
          SELECT COUNT(*) FROM flows_time_travel_edges
          WHERE parent_run_id = ${parentRunId} AND parent_seq = ${frame.seq}
        ) + (
          SELECT COUNT(*) FROM flows_time_travel_fork_intents
          WHERE parent_run_id = ${parentRunId} AND parent_seq = ${frame.seq}
        ) AS count
      `.pipe(
        Effect.map((rows) => `${parentRunId}:fork:${frame.seq}:${Number(rows[0]!.count) + 1}`),
        Effect.mapError(mapError)
      )

    /**
     * Whether the engine's spawn-edge table is installed.
     *
     * The control-plane database migrates the run store and the journal and
     * nothing else, so the walk that follows must not name a table that only
     * the engine ladder creates.
     */
    const hasRunParents = Dialect.tables(sql).pipe(
      Effect.map((rows) => rows.filter((row) => row.name === "flows_run_parents"))
    ).pipe(Effect.map((rows) => rows.length > 0))

    /**
     * Refuses the fork while the parent or ANY ancestor of it is live.
     *
     * Ancestry is the union of three relations, walked breadth-first with a
     * visited set so a cycle terminates: the fork edges this store writes,
     * the `flows_runs.parent_run_id` column the engine stamps on a spawned
     * child and on a trampoline continuation, and the `flows_run_parents`
     * edges a spawned child is recorded under. The walk used to follow the
     * fork edges alone, so an inactive child spawned by a running engine run
     * passed as if its whole history were settled.
     */
    const refuseLiveAncestry = (parentRunId: string) =>
      Effect.gen(function*() {
        const walkRunParents = yield* hasRunParents
        const queue = [parentRunId]
        const seen = new Set<string>()
        while (queue.length > 0) {
          const currentRunId = queue.shift()!
          if (seen.has(currentRunId)) continue
          seen.add(currentRunId)
          const current = yield* sql<{
            readonly status: string
            readonly owner_host_id: string | null
            readonly claim_host_id: string | null
            readonly parent_run_id: string | null
          }>`
            SELECT status, owner_host_id, claim_host_id, parent_run_id
            FROM flows_runs WHERE run_id = ${currentRunId}
          `
          if (current[0] === undefined) {
            return yield* Effect.fail(error("not_found", `parent ${currentRunId} was not found`))
          }
          if (
            current[0].status === "running" ||
            current[0].owner_host_id !== null ||
            current[0].claim_host_id !== null
          ) {
            return yield* Effect.fail(
              error(
                "live_parent",
                currentRunId === parentRunId
                  ? `parent ${currentRunId} is live`
                  : `ancestor run ${currentRunId} is live`
              )
            )
          }
          if (current[0].parent_run_id !== null) queue.push(current[0].parent_run_id)
          const forkParents = yield* sql<{ readonly parent_run_id: string }>`
            SELECT parent_run_id FROM flows_time_travel_edges WHERE child_run_id = ${currentRunId}
          `
          for (const row of forkParents) queue.push(row.parent_run_id)
          if (walkRunParents) {
            const spawnParents = yield* sql<{ readonly parent_id: string }>`
              SELECT parent_id FROM flows_run_parents WHERE child_id = ${currentRunId}
            `
            for (const row of spawnParents) queue.push(row.parent_id)
          }
        }
      })

    const upsertSnapshot = (snapshot: TimeTravelStore.Snapshot) =>
      sql`
        INSERT INTO flows_time_travel_snapshots (run_id, lineage_id, seq, change_id, operation_id, plan_digest)
        VALUES (
          ${snapshot.runId},
          ${snapshot.frame.lineageId},
          ${snapshot.frame.seq},
          ${snapshot.changeId},
          ${snapshot.operationId ?? null},
          ${snapshot.planDigest ?? null}
        )
        ON CONFLICT (run_id, lineage_id, seq) DO UPDATE SET
          change_id = excluded.change_id,
          operation_id = excluded.operation_id,
          plan_digest = excluded.plan_digest
      `

    return TimeTravelStore.make({
      snapshotAt: Effect.fn("TimeTravelStore.snapshotAt")((runId, frame) =>
        Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
          sql<
            {
              readonly change_id: string
              readonly seq: number
              readonly operation_id: string | null
              readonly plan_digest: string | null
            }
          >`SELECT change_id, seq, operation_id, plan_digest FROM flows_time_travel_snapshots WHERE run_id = ${runId} AND lineage_id = ${frame.lineageId} AND seq <= ${frame.seq} ORDER BY seq DESC LIMIT 1`
            .pipe(
              Effect.map((rows) =>
                rows[0] === undefined ? undefined : {
                  runId,
                  frame: { lineageId: frame.lineageId, seq: rows[0].seq },
                  changeId: rows[0].change_id,
                  ...(rows[0].operation_id === null ? {} : { operationId: rows[0].operation_id }),
                  ...(rows[0].plan_digest === null ? {} : { planDigest: rows[0].plan_digest })
                }
              ),
              Effect.mapError(mapError)
            )
        ))
      ),
      recordSnapshot: Effect.fn("TimeTravelStore.recordSnapshot")((snapshot) =>
        Effect.annotateCurrentSpan({
          runId: snapshot.runId,
          lineageId: snapshot.frame.lineageId,
          seq: snapshot.frame.seq
        }).pipe(Effect.andThen(
          writer.write(upsertSnapshot(snapshot)).pipe(Effect.asVoid, Effect.mapError(mapError))
        ))
      ),
      // One transaction per batch: the projector hands over a journal page's
      // anchors at a time, so a page costs one write rather than one per anchor.
      recordSnapshots: Effect.fn("TimeTravelStore.recordSnapshots")((batch) =>
        Effect.annotateCurrentSpan({ anchors: batch.length }).pipe(Effect.andThen(
          batch.length === 0
            ? Effect.void
            : writer.write(Effect.forEach(batch, upsertSnapshot, { discard: true })).pipe(
              Effect.asVoid,
              Effect.mapError(mapError)
            )
        ))
      ),
      latestSnapshots: Effect.fn("TimeTravelStore.latestSnapshots")((runId) =>
        Effect.annotateCurrentSpan({ runId }).pipe(Effect.andThen(
          sql<
            {
              readonly lineage_id: string
              readonly seq: number
              readonly change_id: string
              readonly operation_id: string | null
              readonly plan_digest: string | null
            }
          >`SELECT lineage_id, seq, change_id, operation_id, plan_digest FROM flows_time_travel_snapshots
            WHERE run_id = ${runId} AND (lineage_id, seq) IN (
              SELECT lineage_id, MAX(seq) FROM flows_time_travel_snapshots WHERE run_id = ${runId} GROUP BY lineage_id
            )
            ORDER BY seq ASC, lineage_id ASC`.pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                runId,
                frame: { lineageId: row.lineage_id, seq: row.seq },
                changeId: row.change_id,
                ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
                ...(row.plan_digest === null ? {} : { planDigest: row.plan_digest })
              }))
            ),
            Effect.mapError(mapError)
          )
        ))
      ),
      stateAt: Effect.fn("TimeTravelStore.stateAt")((runId, frame) =>
        Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(
          Effect.andThen(stateAtFrame(runId, frame))
        )
      ),
      attemptsAt: Effect.fn("TimeTravelStore.attemptsAt")((runId, frame) =>
        Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(
          Effect.andThen(attemptsAtFrame(runId, frame))
        )
      ),
      descendants: Effect.fn("TimeTravelStore.descendants")((runId, frame) =>
        Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
          edgesUnder(runId).pipe(
            Effect.map((rows) => {
              const descendants = LineageTree.descendants(rows.map(edgeFromRow), runId, frame)
              return { attached: descendants.attached, detached: descendants.detached }
            }),
            Effect.mapError(mapError)
          )
        ))
      ),
      writeAudit: Effect.fn("TimeTravelStore.writeAudit")((audit) =>
        Effect.annotateCurrentSpan({
          auditId: audit.id,
          runId: audit.runId,
          lineageId: audit.frame.lineageId,
          seq: audit.frame.seq
        }).pipe(Effect.andThen(
          writer.write(
            Effect.gen(function*() {
              const rateLimit = audit.rateLimit === undefined ? null : yield* encodeJson(audit.rateLimit)
              const detail = audit.detail === undefined ? null : yield* encodeJson(audit.detail)
              yield* sql`INSERT INTO flows_time_travel_audits (id, run_id, lineage_id, seq, status, rate_limit_json, detail_json) VALUES (${audit.id}, ${audit.runId}, ${audit.frame.lineageId}, ${audit.frame.seq}, ${audit.status}, ${rateLimit}, ${detail})`
            })
          ).pipe(Effect.asVoid, Effect.mapError(mapError))
        ))
      ),
      updateAudit: Effect.fn("TimeTravelStore.updateAudit")((id, patch) =>
        Effect.annotateCurrentSpan({ auditId: id }).pipe(
          Effect.andThen(TimeTravelStore.validateAuditPatch(patch)),
          Effect.andThen(
            writer.write(
              Effect.gen(function*() {
                const rows = yield* sql<AuditRow>`SELECT * FROM flows_time_travel_audits WHERE id = ${id}`
                if (rows[0] === undefined) return yield* Effect.fail(error("not_found", `audit ${id} was not found`))
                const audit = yield* auditFromRow(rows[0])
                const next = { ...audit, ...patch }
                const rateLimitJson = next.rateLimit === undefined ? null : yield* encodeJson(next.rateLimit)
                const detailJson = next.detail === undefined ? null : yield* encodeJson(next.detail)
                yield* sql`UPDATE flows_time_travel_audits SET status = ${next.status}, rate_limit_json = ${rateLimitJson}, detail_json = ${detailJson} WHERE id = ${id}`
              }).pipe(Effect.mapError(mapError))
            ).pipe(Effect.mapError(mapError), Effect.asVoid)
          )
        )
      ),
      pendingAudits: Effect.fn("TimeTravelStore.pendingAudits")(() =>
        sql<AuditRow>`SELECT * FROM flows_time_travel_audits WHERE status = 'in_progress'`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, auditFromRow)),
          Effect.mapError(mapError)
        )
      ),
      archiveAndTruncate: Effect.fn("TimeTravelStore.archiveAndTruncate")(
        (runId, frame, receipts, owner, childOwners) =>
          Schema.decodeUnknownEffect(Frame)(frame).pipe(
            Effect.mapError((cause) => error("invalid", "invalid archive frame", cause)),
            Effect.tap(() => Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq })),
            Effect.andThen(
              writer.write(
                Effect.gen(function*() {
                  // The commit-time owner predicate: the whole archive+truncate
                  // only commits while `flows_runs` still records this owner, so
                  // a superseded rewinder can never truncate history behind the
                  // live owner — the same fence the journal's `emitDurable`
                  // asserts, one store up.
                  const fence = yield* sql<{ readonly ok: number }>`
            SELECT 1 AS ok FROM flows_runs
            WHERE run_id = ${runId}
              AND owner_host_id = ${owner.hostId}
              AND owner_pid = ${owner.pid}
              AND owner_nonce = ${owner.nonce}
          `
                  if (fence.length === 0) {
                    return yield* Effect.fail(
                      error(
                        "fence_lost",
                        `run ${runId} is no longer owned by ${owner.hostId}:${owner.pid}:${owner.nonce}`
                      )
                    )
                  }
                  const rows = yield* edgesUnder(runId)
                  const descendants = LineageTree.descendants(rows.map(edgeFromRow), runId, frame)
                  // Attached journals are part of this transaction, so every
                  // non-terminal child is fenced here too. Assessment and claims
                  // happen before the commit, but only this read can catch a child
                  // that was re-owned or newly attached in the intervening window.
                  for (const childRunId of descendants.attachedRunIds) {
                    const childRows = yield* sql<{
                      readonly status: string
                      readonly owner_host_id: string | null
                      readonly owner_pid: number | null
                      readonly owner_nonce: string | null
                    }>`
                  SELECT status, owner_host_id, owner_pid, owner_nonce
                  FROM flows_runs
                  WHERE run_id = ${childRunId}
                `
                    const child = childRows[0]
                    if (
                      child === undefined ||
                      isTerminalRunStatus(child.status as RunStatus)
                    ) {
                      continue
                    }
                    const childOwner = childOwners?.get(childRunId)
                    if (
                      childOwner === undefined ||
                      child.owner_host_id !== childOwner.hostId ||
                      child.owner_pid !== childOwner.pid ||
                      child.owner_nonce !== childOwner.nonce
                    ) {
                      return yield* Effect.fail(
                        error("fence_lost", `attached child ${childRunId} is not owned by this rewind`)
                      )
                    }
                  }
                  const nowMs = yield* Clock.currentTimeMillis
                  const parentGeneration = yield* currentGeneration(runId)
                  const parentResult = yield* sql`
            INSERT INTO flows_time_travel_archive
              (run_id, generation, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json, archived_at_ms)
            SELECT run_id, ${parentGeneration}, seq, event_id, source_id, source_seq, emitted_at_ms,
                   event_type, payload_json, meta_json, ${nowMs}
            FROM flows_journal_events
            WHERE run_id = ${runId} AND seq > ${frame.seq}
          `.raw
                  let archived = yield* affectedRows(parentResult)
                  yield* sql`
                  INSERT INTO flows_journal_generations (run_id, generation, after_seq)
                  VALUES (${runId}, 1, ${frame.seq})
                  ON CONFLICT (run_id) DO UPDATE SET generation = flows_journal_generations.generation + 1, after_seq = excluded.after_seq
                `
                  yield* sql`DELETE FROM flows_time_travel_snapshots WHERE run_id = ${runId} AND seq > ${frame.seq}`
                  yield* deleteProjectedWaits(runId, frame.seq)
                  yield* sql`
            DELETE FROM flows_journal_events
            WHERE run_id = ${runId} AND seq > ${frame.seq}
          `
                  /**
                   * THE ATTEMPT ROWS FOLLOW THE JOURNAL THEY EXPLAIN.
                   *
                   * Truncation archived the `attempt-started` records above the
                   * frame but left `flows_attempts` untouched, so a resumed run's
                   * `probeAttempts` restored the counter and the retry origin from
                   * rows its own journal no longer records: a step whose attempts
                   * were archived came back at attempt N+1, or stayed exhausted.
                   * `createFork` already derives exactly this set for the child
                   * (`attemptsAtFrame`), and the two now agree about which attempts
                   * a prefix can explain.
                   */
                  const survivors = yield* attemptsAtFrame(runId, frame)
                  // One statement for the whole run rather than one round trip
                  // per unexplained row while the writer lock is held.
                  yield* sql`
            DELETE FROM flows_attempts
            WHERE run_id = ${runId}
              AND (step_key_digest, attempt) NOT IN (${attemptRefsSelect(survivors)})
          `
                  for (const childRunId of descendants.attachedRunIds) {
                    // An archived child's journal no longer explains any attempt,
                    // so none of its attempt rows may survive it.
                    yield* sql`DELETE FROM flows_attempts WHERE run_id = ${childRunId}`
                    const childGeneration = yield* currentGeneration(childRunId)
                    const childResult = yield* sql`
              INSERT INTO flows_time_travel_archive
                (run_id, generation, seq, event_id, source_id, source_seq, emitted_at_ms,
                 event_type, payload_json, meta_json, archived_at_ms)
              SELECT run_id, ${childGeneration}, seq, event_id, source_id, source_seq, emitted_at_ms,
                     event_type, payload_json, meta_json, ${nowMs}
              FROM flows_journal_events WHERE run_id = ${childRunId}
            `.raw
                    archived += yield* affectedRows(childResult)
                    yield* sql`
                    INSERT INTO flows_journal_generations (run_id, generation, after_seq)
                    VALUES (${childRunId}, 1, -1)
                    ON CONFLICT (run_id) DO UPDATE SET generation = flows_journal_generations.generation + 1, after_seq = -1
                  `
                    yield* sql`DELETE FROM flows_time_travel_snapshots WHERE run_id = ${childRunId}`
                    yield* deleteProjectedWaits(childRunId, -1)
                    yield* sql`DELETE FROM flows_journal_events WHERE run_id = ${childRunId}`
                  }
                  for (const edge of descendants.attached) {
                    yield* sql`DELETE FROM flows_time_travel_edges WHERE child_run_id = ${edge.childRunId}`
                  }
                  for (const receipt of receipts) {
                    const receiptJson = yield* encodeJson(receipt.receipt)
                    yield* sql`
              INSERT INTO flows_time_travel_receipts
                (id, audit_id, effect_id, receipt_json)
              VALUES (
                ${receipt.id},
                ${receipt.auditId},
                ${receipt.effectId},
                ${receiptJson}
              )
            `
                  }
                  return { archived, orphaned: descendants.detached, forgotten: [runId, ...descendants.attachedRunIds] }
                }).pipe(Effect.mapError(mapError))
              ).pipe(
                Effect.tap(({ forgotten }) =>
                  JournalGeneration.forget(forgotten).pipe(Effect.provideService(SqlClient.SqlClient, sql))
                ),
                Effect.map(({ archived, orphaned }) => ({ archived, orphaned })),
                Effect.mapError(mapError)
              )
            )
          )
      ),
      archivedAt: Effect.fn("TimeTravelStore.archivedAt")((runId, seq) =>
        Effect.annotateCurrentSpan({ runId, seq }).pipe(Effect.andThen(
          sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM flows_time_travel_archive
            WHERE run_id = ${runId} AND seq = ${seq}
          `.pipe(
            Effect.map((rows) => Number(rows[0]!.count) > 0),
            Effect.mapError(mapError)
          )
        ))
      ),
      nextForkId: Effect.fn("TimeTravelStore.nextForkId")((parentRunId, frame) =>
        Effect.annotateCurrentSpan({ parentRunId, lineageId: frame.lineageId, seq: frame.seq }).pipe(
          Effect.andThen(
            // The count and the reservation share one write transaction, so
            // two mints are serialized by the writer and the second sees the
            // first's intent; the primary key is the backstop for a mint that
            // somehow arrives at the same ordinal.
            writer.write(
              Effect.gen(function*() {
                const runId = yield* mintForkId(parentRunId, frame)
                const nowMs = yield* Clock.currentTimeMillis
                yield* sql`
                  INSERT INTO flows_time_travel_fork_intents
                    (child_run_id, parent_run_id, parent_seq, reserved_at_ms, reclaimed_at_ms)
                  VALUES (${runId}, ${parentRunId}, ${frame.seq}, ${nowMs}, NULL)
                `
                return runId
              }).pipe(Effect.mapError(mapError))
            ).pipe(Effect.mapError(mapError))
          )
        )
      ),
      abandonForkIntents: Effect.fn("TimeTravelStore.abandonForkIntents")((staleBeforeMs) =>
        Effect.annotateCurrentSpan({ staleBeforeMs }).pipe(Effect.andThen(
          writer.write(
            Effect.gen(function*() {
              const rows = yield* sql<{
                readonly child_run_id: string
                readonly parent_run_id: string
                readonly parent_seq: number
                readonly reserved_at_ms: number
              }>`
                SELECT child_run_id, parent_run_id, parent_seq, reserved_at_ms
                FROM flows_time_travel_fork_intents
                WHERE reserved_at_ms < ${staleBeforeMs} AND reclaimed_at_ms IS NULL
                ORDER BY reserved_at_ms ASC, child_run_id ASC
              `
              const nowMs = yield* Clock.currentTimeMillis
              const intents: Array<TimeTravelStore.ForkIntent> = []
              for (const row of rows) {
                yield* sql`
                  UPDATE flows_time_travel_fork_intents SET reclaimed_at_ms = ${nowMs}
                  WHERE child_run_id = ${row.child_run_id}
                `
                intents.push({
                  childRunId: row.child_run_id,
                  parentRunId: row.parent_run_id,
                  parentSeq: Number(row.parent_seq),
                  reservedAtMs: Number(row.reserved_at_ms)
                })
              }
              return intents
            }).pipe(Effect.mapError(mapError))
          ).pipe(Effect.mapError(mapError))
        ))
      ),
      createFork: Effect.fn("TimeTravelStore.createFork")((parentRunId, frame, childRunId) =>
        Effect.annotateCurrentSpan({ parentRunId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
          writer.write(
            Effect.gen(function*() {
              yield* refuseLiveAncestry(parentRunId)
              /**
               * THE FRAME MUST ADDRESS A RECORD.
               *
               * Nothing validated the fork's coordinate, so a seq past the tail
               * or a sibling lineage copied whatever `seq <= frame.seq` matched,
               * derived no state at the frame, and fell back to the parent's
               * LATEST `state_json` - the "state NOW" bug the fold above exists
               * to fix - while writing a marker row that claims a frame nobody
               * can address. Frame zero stays addressable by definition
               * (`Frame`): it is the state before the run wrote anything. A
               * record carrying no lineage is compatible with every frame, the
               * same rule `prefix` reads by.
               */
              if (frame.seq > 0) {
                const atFrame = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM flows_journal_events
              WHERE run_id = ${parentRunId}
                AND seq = ${frame.seq}
                AND (
                  ${Dialect.jsonText(sql, sql`meta_json`, "$.lineageId")} IS NULL
                  OR ${Dialect.jsonText(sql, sql`meta_json`, "$.lineageId")} = ${frame.lineageId}
                )
            `
                if (Number(atFrame[0]!.count) === 0) {
                  return yield* Effect.fail(
                    error("not_found", TimeTravelStore.forkFrameMessage(parentRunId, frame))
                  )
                }
              }
              const attempts = yield* attemptsAtFrame(parentRunId, frame, EventTypes.attemptFinished, true)
              // An irreversible crossing without a completion cannot safely be
              // made fresh work, nor may its parent's future result be copied.
              // Require a frame outside that interval instead.
              const unresolved = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count FROM flows_attempts AS attempts
                WHERE attempts.run_id = ${parentRunId}
                  AND (attempts.step_key_digest, attempts.attempt) NOT IN (${attemptRefsSelect(attempts)})
                  AND EXISTS (
                    SELECT 1 FROM flows_journal_events AS events
                    WHERE events.run_id = ${parentRunId} AND events.seq <= ${frame.seq}
                      AND events.event_type = ${EffectBoundary.eventType}
                      AND ${Dialect.jsonText(sql, sql`events.payload_json`, "$.effect.tier")} = 'irreversible'
                      AND ${Dialect.jsonText(sql, sql`events.payload_json`, "$.effect.id")} =
                        ${Dialect.jsonText(sql, sql`events.payload_json`, "$.effect.runId")} || ':' ||
                        attempts.step_key_digest || ':' || attempts.attempt
                  )
              `
              if (Number(unresolved[0]!.count) > 0) {
                return yield* Effect.fail(error(
                  "already_crossed",
                  "fork frame crosses an unfinished irreversible action; choose a frame before its boundary or after completion"
                ))
              }
              const runId = childRunId ?? (yield* mintForkId(parentRunId, frame))
              // The committed edge takes over the ordinal the reservation
              // held, so the intent is consumed in the same transaction.
              yield* sql`DELETE FROM flows_time_travel_fork_intents WHERE child_run_id = ${runId}`
              const nowMs = yield* Clock.currentTimeMillis
              /**
               * THE CHILD'S STATE IS THE STATE **AT** THE FRAME.
               *
               * Copying `flows_runs.state_json` copied the parent's state NOW —
               * a fork at seq 3 of a run that later reached seq 40 started from
               * seq 40's payload and parent pointer. `stateAt` folds the
               * run-decision records up to the frame instead, exactly the
               * derive-don't-copy rule `ndc/state_rebuilder.go` follows. The
               * run row stays the fallback for a journal written before
               * decisions carried state; both then pass through
               * `restartableStateJson`, because a fork must not inherit the
               * parent's recorded result or cancellation.
               */
              const derived = yield* stateAtFrame(parentRunId, frame)
              // The liveness walk above already proved the parent row exists, so
              // the fallback read cannot come back empty.
              const parentState = yield* sql<{ readonly state_json: string }>`
            SELECT state_json FROM flows_runs WHERE run_id = ${parentRunId}
          `
              const parent = yield* Schema.decodeUnknownEffect(RunStateJson)(parentState[0]!.state_json).pipe(
                Effect.mapError((cause) => error("unknown", "could not materialize executable fork state", cause))
              )
              const stateJson = yield* restartableStateJson(
                derived ?? parentState[0]!.state_json,
                [parentRunId, ...(parent.forkKeyRunIds ?? [])]
              )
              yield* sql`
            INSERT INTO flows_runs (
              run_id,
              status,
              created_at_ms,
              parent_run_id,
              state_json,
              lineage_id,
              round_ordinal
            ) VALUES (
              ${runId},
              'pending',
              ${nowMs},
              ${parentRunId},
              ${stateJson},
              ${runId},
              0
            )
          `
              yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            SELECT ${runId}, seq, ${`fork:${runId}:`} || event_id,
                   source_id, source_seq, emitted_at_ms,
                   event_type, payload_json, meta_json
            FROM flows_journal_events
            WHERE run_id = ${parentRunId} AND seq <= ${frame.seq}
          `
              /**
               * THE ATTEMPTS ARE FILTERED TO THE FRAME.
               *
               * The copy had no predicate at all: a fork at seq 3 inherited every
               * attempt row the parent ever wrote, including the ones its own
               * copied journal has no record of, so the child replayed results
               * from a future it was forked away from. Only an attempt-finished
               * receipt at or before the frame authorizes a terminal result:
               * an attempt merely started there may have finished in the future.
               */
              // The completed-at-frame set above includes ancestor lineages,
              // exactly like the journal prefix this fork copies.
              // One statement for the whole set rather than one round trip per
              // surviving attempt while the writer lock is held.
              yield* sql`
              INSERT INTO flows_attempts (
                run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
                heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
              )
              SELECT
                ${runId}, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
                heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
              FROM flows_attempts
              WHERE run_id = ${parentRunId}
                AND (step_key_digest, attempt) IN (${attemptRefsSelect(attempts)})
            `
              /**
               * THE FRAME'S ANCHORS CROSS THE FORK WITH IT.
               *
               * The anchor table is a projection of the parent's
               * `snapshot-identified` records, and the copied prefix carries
               * those records — but a fresh engine incarnation that forks the
               * CHILD next never projects the child's journal first. Copying
               * the rows at or below the frame makes the child's history
               * self-contained on restart, exactly as its copied journal and
               * attempts already are; a later projection of the child upserts
               * the same `(runId, lineageId, seq)` rows and changes nothing.
               */
              yield* sql`
            INSERT INTO flows_time_travel_snapshots (run_id, lineage_id, seq, change_id, operation_id, plan_digest)
            SELECT ${runId}, lineage_id, seq, change_id, operation_id, plan_digest
            FROM flows_time_travel_snapshots
            WHERE run_id = ${parentRunId} AND seq <= ${frame.seq}
          `
              yield* sql`
            INSERT INTO flows_time_travel_edges
              (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES (${parentRunId}, ${frame.seq}, ${runId}, 'fork', 0)
          `
              /**
               * The fork-created marker (`Frame.forkCreatedEventType`): written
               * on the CHILD, above the copied prefix, naming
               * the parent and the offset it was cut at. A cross-fork timeline
               * can now start from any child and find its origin without
               * consulting the edge table.
               *
               * `source_seq` is the marker's own seq, never a constant: the
               * copy above preserves source identities, so a fork-of-fork
               * whose prefix reaches the parent's own marker inherits a row
               * with this same `source_id`. Every marker keeps
               * `source_seq = seq`, and the new marker sits strictly above
               * everything it copied, so `UNIQUE (run_id, source_id,
               * source_seq)` can never collide.
               */
              yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES (
              ${runId},
              ${frame.seq + 1},
              ${`fork:${runId}:created`},
              ${"flows/time-travel/fork"},
              ${frame.seq + 1},
              ${nowMs},
              ${forkCreatedEventType},
              ${JSON.stringify({ parentRunId, forkJournalOffset: frame.seq, childRunId: runId })},
              ${JSON.stringify({ lineageId: frame.lineageId })}
            )
          `
              return {
                runId,
                edge: {
                  parentRunId,
                  parentSeq: frame.seq,
                  childRunId: runId,
                  kind: "fork" as const,
                  attached: false
                }
              }
            }).pipe(Effect.mapError(mapError))
          ).pipe(Effect.mapError(mapError))
        ))
      ),
      recordReceipt: Effect.fn("TimeTravelStore.recordReceipt")((receipt) =>
        Effect.annotateCurrentSpan({
          receiptId: receipt.id,
          auditId: receipt.auditId,
          effectId: receipt.effectId
        }).pipe(Effect.andThen(
          writer.write(
            Effect.gen(function*() {
              const receiptJson = yield* encodeJson(receipt.receipt)
              yield* sql`INSERT INTO flows_time_travel_receipts (id, audit_id, effect_id, receipt_json) VALUES (${receipt.id}, ${receipt.auditId}, ${receipt.effectId}, ${receiptJson})`
            })
          ).pipe(Effect.asVoid, Effect.mapError(mapError))
        ))
      )
    })
  }
)
/**
 * Provides {@link make} as the `TimeTravelStore` service. Requires a
 * `SqlClient` and a `DurableWriter`; building it migrates the schema.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<TimeTravelStore.TimeTravelStore, TimeTravelError, DurableWriter | SqlClient.SqlClient> =
  Layer
    .effect(
      TimeTravelStore.TimeTravelStore
    )(make)
