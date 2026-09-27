/**
 * Deleting run history that has outlived its usefulness.
 *
 * Nothing in the durable stores forgets on its own: a finished run keeps its
 * row, every attempt, every journal event, and every archived frame forever.
 * That is the right default — a run's history is the only account of what an
 * agent did to a repository — and it is why `smithers gc` exists rather than a
 * background sweeper. Retention is an operator decision, taken explicitly,
 * with a dry run available before anything is deleted.
 *
 * This module is the public surface. The operation lives in
 * `internal/RetentionOps.ts` beside the other modules that read this package's
 * own tables, so `internal/` is never imported by a consumer — the same split
 * `Errors.ts` uses. {@link retain} and {@link layer} are that operation: one
 * bounded pass over the engine ladder, inside one `journal.transact`.
 *
 * {@link collect} is the host-facing pass `smithers gc` runs, and it is a
 * facade over the same guard. A project keeps its history in two files — the
 * control plane's database and the engine's — and a sweep of one without the
 * other leaves half of a deleted run behind, so the pass takes the database as
 * a service and runs once per file. Which runs it may delete is
 * {@link RetentionOps.lineagePrelude}'s answer, not a second guard written
 * here: a run stays whenever a live run stands above or below it, over BOTH
 * relations that make one run the parent of another — the `flows_run_parents`
 * edge a spawned child records, and the `parent_run_id` column a trampoline
 * lineage is chained through.
 *
 * Only terminal runs are ever considered. A `pending`, `running`, or
 * `suspended` row belongs to work that can still resume.
 *
 * @since 1.0.0
 */
import * as Dialect from "@smthrs/database/Dialect"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as RetentionOps from "./internal/RetentionOps.ts"

export {
  defaultLimit,
  layer,
  make,
  type RetainOptions,
  type RetainReport,
  Retention,
  RetentionError,
  RetentionErrorCode,
  type RunScopedTable,
  /**
   * Every table a deleted run leaves rows in. One inventory serves this pass
   * and {@link Service.retain}, so neither can leak what the other deletes.
   *
   * @category constants
   * @since 1.0.0
   */
  runScopedTables,
  type Service,
  terminalStatuses
} from "./internal/RetentionOps.ts"

/**
 * What one retention pass would delete, or did.
 *
 * @category models
 * @since 1.0.0
 */
export interface Report {
  readonly database: string
  /** The threshold, as an epoch millisecond value. */
  readonly olderThanMs: number
  readonly runs: ReadonlyArray<string>
  /** Rows deleted per table; empty under a dry run. */
  readonly deleted: Readonly<Record<string, number>>
  readonly dryRun: boolean
}

/**
 * Arguments accepted by {@link collect}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** Delete terminal runs that finished strictly before this epoch millisecond. */
  readonly olderThanMs: number
  readonly dryRun?: boolean | undefined
  /** A label for the report; the host's database path. */
  readonly database?: string | undefined
  /** Largest number of runs considered by this pass. Defaults to 1,000. */
  readonly limit?: number | undefined
}

/** Whether a table exists in the connected database. */
const hasTable = (table: string): Effect.Effect<boolean, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* Dialect.tables(sql).pipe(Effect.map((rows) => rows.filter((row) => row.name === table)))
    return rows.length > 0
  })

/**
 * The runs one pass would delete, oldest first, each with the run it names as
 * its parent.
 *
 * The same candidate query `retain` runs: children before parents, so a
 * trampoline lineage longer than the bound still loses a run every pass, and
 * a run is excluded whenever a live run stands above or below it. Downward,
 * deleting a parent whose child is still running would break the
 * `parent_run_id` foreign key and drop the live child's edges with the
 * `flows_run_parents_gc` trigger. Upward, a parked parent still reads a
 * settled child's result out of its run row through `agent/await`, and it can
 * be parked for longer than the threshold before it ever asks.
 */
const eligibleCandidates = (
  olderThanMs: number,
  limit: number | undefined
): Effect.Effect<ReadonlyArray<RetentionOps.Candidate>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    if (!(yield* hasTable("flows_runs"))) return []
    // The engine's edge table is absent from the control-plane database, which
    // migrates the run store and the journal and nothing else. The prelude
    // drops that half of the walk there and keeps the `parent_run_id` half, so
    // one guard covers both files.
    return yield* RetentionOps.candidatesOf(sql, {
      cutoffMs: olderThanMs,
      inclusive: false,
      parentEdges: yield* hasTable("flows_run_parents"),
      limit: RetentionOps.normalizeLimit(limit)
    })
  })

/**
 * The terminal runs one pass would delete, oldest first.
 *
 * @category getters
 * @since 1.0.0
 */
export const eligible = (
  olderThanMs: number,
  limit = RetentionOps.defaultLimit
): Effect.Effect<ReadonlyArray<string>, SqlError, SqlClient.SqlClient> =>
  Effect.map(
    eligibleCandidates(olderThanMs, limit),
    (candidates) => candidates.map((candidate) => candidate.runId)
  )

/**
 * Runs one retention pass.
 *
 * The deletion itself is {@link RetentionOps.deleteRuns}, the same one
 * {@link Service.retain} runs, so this pass cannot hold a shorter table list
 * than that one and cannot delete run rows in an order the self-referential
 * `parent_run_id` foreign key refuses. A handoff parent always sorts before
 * its successor, so deleting in age order broke as soon as one lineage
 * straddled a chunk boundary, and it broke AFTER the dependent rows of every
 * eligible run were already gone. `assumeLadder: false` because this pass also
 * runs against the control plane's database, which composed fewer stores.
 *
 * Eligibility and deletion share one retryable transaction: another writer
 * cannot attach a live parent between the lineage scan and deletion. A busy
 * retry recomputes eligibility rather than replaying an old candidate list.
 * One transaction, for the reason `retain` opens one: a pass that removed a
 * run's history and then refused on its row would have destroyed what it could
 * not put back, and a workspace whose next pass refuses the same way can never
 * be collected again.
 *
 * Under `dryRun` nothing is written and `deleted` is empty: the report names
 * exactly the runs a real pass would remove, which is what makes
 * `smithers gc --dry-run` worth trusting.
 *
 * @category constructors
 * @since 1.0.0
 */
export const collect = (
  options: Options
): Effect.Effect<Report, SqlError | RetentionOps.RetentionError, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const dryRun = options.dryRun === true
    const pass = Effect.gen(function*() {
      const candidates = yield* eligibleCandidates(options.olderThanMs, options.limit)
      return yield* RetentionOps.deleteRuns(sql, candidates, { dryRun, assumeLadder: false })
    })
    const removed = yield* (dryRun ? sql.withTransaction(pass) : DurableWriter.make(sql).write(pass).pipe(
      Effect.catchIf(
        (cause): cause is DurableWriter.DatabaseError => cause instanceof DurableWriter.DatabaseError,
        (cause) =>
          Effect.fail(
            new RetentionOps.RetentionError({
              code: "delete_failed",
              message: "retention transaction failed; no history was deleted",
              cause
            })
          )
      )
    ))
    return {
      database: options.database ?? "",
      olderThanMs: options.olderThanMs,
      runs: removed.runIds,
      deleted: dryRun ? {} : removed.deleted,
      dryRun
    }
  })
