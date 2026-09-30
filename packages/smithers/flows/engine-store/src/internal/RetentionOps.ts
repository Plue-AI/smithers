/**
 * Retention: the one operation that deletes finished run state.
 *
 * Nothing in the composition removed a `flows_runs` row or anything that hangs
 * off one. Every run a workspace ever finished stayed in `.flows/engine.db`
 * with its attempts, its persisted deferred completions and clock deadlines,
 * its journal entries, and its checkpoints, and journal compaction is off by
 * default (`SqlJournal` `Options.compaction`), so the file only grew. This
 * module is the deletion side, and the whole of it: one operation, run
 * explicitly.
 *
 * Three properties make it safe to run against a live workspace.
 *
 * - **One transaction.** Every delete runs inside a single `journal.transact`,
 *   so a crash leaves either a run with all of its rows or none of them —
 *   never a run row whose history is gone, or history whose run row is gone.
 * - **Terminal and aged only.** A run is a candidate only when its status is
 *   `completed`, `failed`, or `cancelled` AND it finished before the cutoff.
 *   A running, pending, or suspended run is never a candidate at any age.
 * - **Nothing a live run still needs.** A candidate is retained when a live
 *   run stands on either side of it in the lineage, over BOTH relations that
 *   make one run the parent of another: the `flows_run_parents` edge a spawned
 *   child is recorded under, and the reserved `parent_run_id` column the
 *   rounds of one trampoline lineage are chained through. Upward: an aged
 *   terminal run with a live ancestor stays, because a parent reads a settled
 *   child's result out of its run row (`agent/await`) and a parent parked on
 *   an approval, a deferred, or a timer can be parked for longer than the
 *   threshold before it ever asks. Downward: an aged terminal run whose
 *   descendant is still live stays, because deleting it would leave that
 *   descendant's `parent_run_id` pointing at nothing and would drop the live
 *   descendant's lineage edges with the `flows_run_parents_gc` trigger.
 * - **Explicit.** Nothing schedules this. Automatic retention stays opt-in,
 *   for the reason `ArtifactGc` states: deletion is the irreversible
 *   direction, and a human approving a plan must be approving the deletions.
 *
 * Journal history is deleted outright rather than compacted to a checkpoint.
 * `Journal.checkpoint` and `Journal.compact` are owner-fenced — `SqlJournal`'s
 * `fenceGuard` requires a consensus lease held by the exact owner passed in —
 * so neither can be called for a finished, ownerless run at all. Deleting the run's entries and checkpoints is strictly stronger than
 * compacting them to a checkpoint, and it happens in the same transaction as
 * the run row, which is the property a compaction could not have given.
 *
 * The operation is idempotent. With a positive integer limit and a fixed,
 * finite, acyclic run lineage, each successful non-dry pass deletes at least
 * one collectable run until none remain. Continuation children are selected
 * before parents; parents pinned by excluded children do not consume the
 * bound. Runs protected by age or live lineage remain until eligible.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Journal from "@smthrs/journal/Journal"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/**
 * Stable error codes returned by retention.
 *
 * @category models
 * @since 0.1.0
 */
export const RetentionErrorCode = Schema.Literals(["scan_failed", "delete_failed"])

/**
 * Stable error codes returned by retention.
 *
 * @category models
 * @since 0.1.0
 */
export type RetentionErrorCode = typeof RetentionErrorCode.Type

/**
 * A retention pass that could not complete.
 *
 * `scan_failed` means the candidate set could not be computed and nothing was
 * deleted. `delete_failed` means the candidate set held but a delete refused;
 * the transaction rolled back, so nothing was deleted then either, and
 * re-running converges once the cause is fixed.
 *
 * @category errors
 * @since 0.1.0
 */
export class RetentionError extends Schema.TaggedError<RetentionError>()(
  "@smthrs/engine-store/RetentionError",
  {
    code: RetentionErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Options for one retention pass.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetainOptions {
  /**
   * How long a run must have been finished to be collected, in milliseconds.
   * A run's age is measured from `finished_at_ms`, or from `created_at_ms`
   * for a terminal row that never recorded one. Zero collects every terminal
   * run; a negative value is read as zero.
   */
  readonly olderThanMs: number
  /**
   * Largest number of runs one pass deletes. Defaults to
   * {@link defaultLimit}. Retention is idempotent, so a workspace with more
   * aged runs than the bound converges over repeated passes instead of
   * holding one long write transaction open. A negative value is read as
   * zero, so a pass under a mistyped bound deletes nothing.
   */
  readonly limit?: number | undefined
  /** Compute and report the pass without deleting anything. */
  readonly dryRun?: boolean | undefined
}

/**
 * What one retention pass did, or — under `dryRun` — would do.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetainReport {
  /** Runs finished at or before this instant were candidates. */
  readonly cutoffMs: number
  /** The runs deleted, oldest first. */
  readonly runIds: ReadonlyArray<string>
  /**
   * Aged terminal runs left in place because a descendant of theirs is not
   * terminal, or is terminal and is not being deleted by this pass. They
   * become collectable once that descendant is. At most `limit` of them are
   * reported, the oldest first, so the report costs no more than the pass.
   */
  readonly retainedForLiveDescendants: ReadonlyArray<string>
  /**
   * Aged terminal runs left in place because an ancestor of theirs is not
   * terminal. That ancestor can still read the run's settled result through
   * `agent/await`, which answers out of the run row. They become collectable
   * once every ancestor is terminal — a terminal ancestor holds nothing back,
   * whatever its own age. A run retained for both reasons is reported under
   * {@link retainedForLiveDescendants}, and at most `limit` runs are reported.
   */
  readonly retainedForLiveAncestors: ReadonlyArray<string>
  readonly runs: number
  readonly attempts: number
  readonly clockDeadlines: number
  readonly deferredCompletions: number
  readonly journalEntries: number
  readonly journalCheckpoints: number
  /** Producer identities journal compaction kept after deleting event payloads. */
  readonly journalIdentities: number
  /** Time-travel archive rows; always zero where that table is not installed. */
  readonly archiveEntries: number
  /** Time-travel receipt rows reached through their audits. */
  readonly timeTravelReceipts: number
  readonly dryRun: boolean
}

/**
 * Explicit run retention.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /**
   * Deletes up to `limit` aged terminal runs and their dependents atomically.
   * With a positive integer limit and a fixed, finite, acyclic lineage, each
   * successful non-dry pass makes progress until all collectable runs are gone,
   * including continuation chains longer than the bound. Age and live-lineage
   * protection still apply. Explicit only; nothing schedules this operation.
   */
  readonly retain: (
    options: RetainOptions
  ) => Effect.Effect<RetainReport, RetentionError | Journal.JournalError>
}

/**
 * Service tag for run retention.
 *
 * @category services
 * @since 0.1.0
 */
export class Retention extends Context.Service<Retention, Service>()("@smthrs/engine-store/Retention") {}

/**
 * Runs deleted by one pass when the caller names no bound. Large enough that
 * an ordinary workspace finishes in one pass, small enough that the write
 * transaction stays short on a workspace that has never been collected.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultLimit = 1000

/**
 * Run ids per `IN (...)` list. SQLite's default host-parameter ceiling is 999.
 *
 * @category constants
 * @since 0.1.0
 */
const chunkSize = 500

/**
 * One table a deleted run leaves rows in.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunScopedTable {
  readonly table: string
  /** The column naming the run. */
  readonly column: string
  /**
   * Whether the migration ladder this package composes installs the table.
   *
   * A ladder table missing from an engine database is a broken schema, so
   * {@link installedTables} can be asked to keep it and let the delete refuse.
   * A table beyond the ladder belongs to a store the host may simply not have
   * composed, and is skipped when the catalog does not list it.
   */
  readonly ladder: boolean
}

/**
 * Every table a deleted run leaves rows in, and the column naming the run.
 *
 * ONE inventory, because two passes read it: {@link Service.retain} over the
 * engine ladder, and `Retention.collect` over whatever a host's file holds. A
 * table listed by only one of them is a table the other leaks forever. Tables
 * are listed rather than discovered from foreign keys because the set spans
 * six packages that migrate into one database, and a silently missing entry is
 * exactly that leak.
 *
 * The run rows themselves are not here: they go last and in generation order,
 * which {@link deleteRuns} does after this list.
 * `flows_time_travel_receipts` is reached through its audit rather than listed
 * here because the upstream table has no run column: its `audit_id` points to
 * `flows_time_travel_audits.id`, whose row carries `run_id`.
 *
 * @category constants
 * @since 0.1.0
 */
export const runScopedTables: ReadonlyArray<RunScopedTable> = [
  { table: "flows_deferred_completions", column: "execution_id", ladder: true },
  { table: "flows_clock_deadlines", column: "execution_id", ladder: true },
  { table: "flows_attempts", column: "run_id", ladder: true },
  { table: "flows_journal_events", column: "run_id", ladder: true },
  { table: "flows_journal_checkpoints", column: "run_id", ladder: true },
  { table: "flows_journal_dedup", column: "run_id", ladder: true },
  { table: "flows_consensus_leases", column: "run_id", ladder: true },
  { table: "flows_step_cache_recorded", column: "recorded_run_id", ladder: true },
  { table: "flows_time_travel_archive", column: "run_id", ladder: false },
  { table: "flows_time_travel_snapshots", column: "run_id", ladder: false },
  { table: "flows_time_travel_audits", column: "run_id", ladder: false },
  { table: "flows_time_travel_edges", column: "child_run_id", ladder: false },
  { table: "control_run_messages", column: "run_id", ladder: false },
  { table: "control_runs", column: "run_id", ladder: false }
]

/**
 * The statuses a run can never leave.
 *
 * @category constants
 * @since 1.0.0
 */
export const terminalStatuses: ReadonlyArray<string> = ["completed", "failed", "cancelled"]

/** `terminalStatuses` as a SQL list, for the lineage prelude below. */
const terminalList = terminalStatuses.map((status) => `'${status}'`).join(", ")

/**
 * The prelude every scan opens with: which runs a live run stands above, and
 * which it stands below.
 *
 * Two relations make one run the parent of another, and a walk over either one
 * alone misses half the lineage. A SPAWNED child records its parent as a
 * `flows_run_parents` edge, one row per parent so a diamond records both, and
 * leaves `parent_run_id` NULL: the engine reserves that column for the rounds
 * of one trampoline lineage (`RunDriver.continueLineage`). The edge is the
 * relation every `agent/await` depends on. `link` is both relations as one
 * edge list.
 *
 * `under_live` is every run reachable downward from a run that is not
 * terminal. Those runs have a live ancestor, which can still read a settled
 * result out of their run row. `over_live` is every run reachable upward from
 * one. Those runs have a live descendant, whose own lineage the
 * `flows_run_parents_gc` trigger would drop with them. An edge whose parent
 * row is gone is not reachable from `live` at all, so it holds nothing back,
 * and since only terminal runs are ever deleted it never can.
 *
 * The walks carry run ids and nothing else, so `UNION` makes them terminate on
 * their own: a corrupt edge that closed a cycle adds a row the set already
 * holds, and the walk stops. That matters because these reads run inside the
 * pass's write transaction. They are SQLite-specific, like the `sqlite_master`
 * probe below, and rc.0 is SQLite-only.
 *
 * `parentEdges: false` drops the `flows_run_parents` half of `link`. A
 * database that carries the run rows but not the engine's edge table — the
 * control plane's, which migrates the run store and the journal and nothing
 * else — has no edges to walk, and reading the missing table would fail the
 * whole scan. The `parent_run_id` half still runs, so the continuation
 * lineage is guarded there too. The retention pass itself always walks both.
 *
 * @category constructors
 * @since 0.1.0
 */
export const lineagePrelude = (
  options: { readonly parentEdges: boolean }
): string => `
      WITH RECURSIVE
        link(child_id, parent_id) AS (
          ${
  options.parentEdges
    ? `SELECT child_id, parent_id FROM flows_run_parents
          UNION
          `
    : ``
}SELECT run_id, parent_run_id FROM flows_runs WHERE parent_run_id IS NOT NULL
        ),
        live(run_id) AS (
          SELECT run_id FROM flows_runs WHERE status NOT IN (${terminalList})
        ),
        under_live(run_id) AS (
          SELECT link.child_id FROM link JOIN live ON live.run_id = link.parent_id
          UNION
          SELECT link.child_id FROM link JOIN under_live ON under_live.run_id = link.parent_id
        ),
        over_live(run_id) AS (
          SELECT link.parent_id FROM link JOIN live ON live.run_id = link.child_id
          UNION
          SELECT link.parent_id FROM link JOIN over_live ON over_live.run_id = link.child_id
        )
    `

/**
 * The bound one pass may delete, as both passes read it.
 *
 * Clamped, not interpolated: SQLite reads a negative `LIMIT` as no limit at
 * all, which would make a mistyped bound a full sweep, and rejects `NaN` or a
 * fraction as a datatype mismatch. Anything that is not a non-negative safe
 * integer is read as zero, so the pass deletes nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const normalizeLimit = (limit: number | undefined): number => {
  const bound = limit ?? defaultLimit
  return Number.isSafeInteger(bound) && bound >= 0 ? bound : 0
}

/**
 * Which runs a pass may delete, and which it must keep, as CTEs.
 *
 * `eligible` is every terminal run older than the cutoff that no live run
 * stands above or below. `blocked` is every other run plus every ancestor of
 * one over `parent_run_id`: a continuation parent must outlive every child
 * excluded by age or live lineage, and this propagates that exclusion before
 * any bound is applied. `inclusive` says whether a run finished exactly at
 * the cutoff is old enough.
 */
const scanPrelude = (
  sql: SqlClient.SqlClient,
  options: { readonly cutoffMs: number; readonly inclusive: boolean; readonly parentEdges: boolean }
) =>
  sql`
      ${sql.unsafe(lineagePrelude({ parentEdges: options.parentEdges }))},
      eligible(run_id) AS (
        SELECT run_id FROM flows_runs
        WHERE ${sql.in("status", terminalStatuses)}
          AND ${
    options.inclusive
      ? sql`COALESCE(finished_at_ms, created_at_ms) <= ${options.cutoffMs}`
      : sql`COALESCE(finished_at_ms, created_at_ms) < ${options.cutoffMs}`
  }
          AND run_id NOT IN (SELECT run_id FROM under_live)
          AND run_id NOT IN (SELECT run_id FROM over_live)
      ),
      blocked(run_id) AS (
        SELECT run_id FROM flows_runs WHERE run_id NOT IN (SELECT run_id FROM eligible)
        UNION
        SELECT runs.parent_run_id FROM flows_runs AS runs
        JOIN blocked ON blocked.run_id = runs.run_id
        WHERE runs.parent_run_id IS NOT NULL
      )
    `

/**
 * The runs one pass deletes: at most `limit` of them, children before parents.
 *
 * The one candidate query, shared by {@link Service.retain} and
 * `Retention.collect`. A trampoline parent always finishes before its
 * successor, so an oldest-first window over a lineage longer than the bound
 * held only ancestors, each pinned by the round just outside the window, and
 * every later pass selected the same window and deleted nothing. Depth walks
 * from roots, visiting each continuation row once; corrupt cycles have no
 * root and cannot enter the deletion set. Excluded runs and their ancestors
 * are dropped before the bound, so pinned parents cannot consume it. The
 * result is presented oldest first.
 *
 * @category getters
 * @since 1.0.0
 */
export const candidatesOf = (
  sql: SqlClient.SqlClient,
  options: {
    readonly cutoffMs: number
    readonly inclusive: boolean
    readonly parentEdges: boolean
    readonly limit: number
  }
): Effect.Effect<ReadonlyArray<Candidate>, SqlError> =>
  sql<{ readonly run_id: string; readonly parent_run_id: string | null }>`
    ${scanPrelude(sql, options)},
    depths(run_id, depth) AS (
      SELECT run_id, 0 FROM flows_runs WHERE parent_run_id IS NULL
      UNION ALL
      SELECT runs.run_id, depths.depth + 1 FROM flows_runs AS runs
      JOIN depths ON runs.parent_run_id = depths.run_id
    ),
    selected AS (
      SELECT runs.run_id, runs.parent_run_id,
        COALESCE(runs.finished_at_ms, runs.created_at_ms) AS finished_at_ms
      FROM flows_runs AS runs JOIN depths ON depths.run_id = runs.run_id
      WHERE runs.run_id NOT IN (SELECT run_id FROM blocked)
      ORDER BY depths.depth DESC, COALESCE(runs.finished_at_ms, runs.created_at_ms), runs.run_id
      LIMIT ${normalizeLimit(options.limit)}
    )
    SELECT run_id, parent_run_id FROM selected ORDER BY finished_at_ms, run_id
  `.pipe(
    Effect.map((rows): ReadonlyArray<Candidate> =>
      rows.map((row) => ({ runId: row.run_id, parentRunId: row.parent_run_id }))
    )
  )

/** Classifies a read of the scan phase, where nothing has been deleted yet. */
const scanning = (what: string) => (cause: unknown): RetentionError =>
  new RetentionError({ code: "scan_failed", message: `${what} could not be read`, cause })

/** Classifies a statement of the delete phase, which rolls the pass back. */
const deleting = (what: string) => (cause: unknown): RetentionError =>
  new RetentionError({ code: "delete_failed", message: `${what} could not be collected`, cause })

const chunksOf = (ids: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
  const chunks: Array<ReadonlyArray<string>> = []
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    chunks.push(ids.slice(offset, offset + chunkSize))
  }
  return chunks
}

/**
 * A run a pass proposes to delete, and the run it names as its parent.
 *
 * @category models
 * @since 0.1.0
 */
export interface Candidate {
  readonly runId: string
  readonly parentRunId: string | null
}

/** A run and the candidate it names as its parent. */
interface ChildEdge {
  readonly runId: string
  readonly parentRunId: string
}

/**
 * What one deletion pass removed, or would remove under `dryRun`.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeletionReport {
  /** The candidates deleted, in the order they were given. */
  readonly runIds: ReadonlyArray<string>
  /** Candidates kept because a run outside the pass still names them. */
  readonly pinned: ReadonlyArray<string>
  /**
   * Rows counted per table, `flows_runs` included, zeroes omitted. Counted
   * whether or not the pass deletes, so a dry run reports the same numbers.
   */
  readonly deleted: Readonly<Record<string, number>>
}

/** Reads the installed SQLite table names once for inventory decisions. */
const installedTableNames = (sql: SqlClient.SqlClient): Effect.Effect<ReadonlySet<string>, RetentionError> =>
  Dialect.tables(sql).pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.name))),
    Effect.mapError(scanning("the schema catalog"))
  )

/**
 * The {@link runScopedTables} entries this database actually has.
 *
 * `assumeLadder` keeps every entry the ladder installs whether the catalog
 * lists it or not. {@link Service.retain} passes `true`: this package composes
 * the run-store, journal, step-cache and engine migrations, so a ladder table
 * missing from the file it is pointed at is a broken schema, and a delete that
 * refuses says so. `Retention.collect` passes `false`, because it also runs
 * against the control plane's database, which migrates the run store and the
 * journal and nothing else; there a missing ladder table is a host that
 * composed fewer stores, and the pass still owes it a complete sweep of what
 * it has.
 *
 * The catalog read is SQLite-specific, like the lineage prelude above and the
 * `flows_run_parents_gc` trigger this package ships. rc.0 is SQLite-only.
 *
 * @category getters
 * @since 0.1.0
 */
export const installedTables = (
  sql: SqlClient.SqlClient,
  options: { readonly assumeLadder: boolean }
): Effect.Effect<ReadonlyArray<RunScopedTable>, RetentionError> =>
  installedTableNames(sql).pipe(
    Effect.map((present) =>
      runScopedTables.filter((entry) => (options.assumeLadder && entry.ladder) || present.has(entry.table))
    )
  )

const countIn = (sql: SqlClient.SqlClient, table: string, column: string, ids: ReadonlyArray<string>) =>
  Effect.reduce(chunksOf(ids), () => 0, (total, chunk) =>
    sql<{ readonly total: number }>`
      SELECT COUNT(*) AS total FROM ${sql.unsafe(table)} WHERE ${sql.in(column, chunk)}
    `.pipe(
      Effect.map((rows) => rows.reduce((sum, row) => sum + Number(row.total), total)),
      Effect.mapError(deleting(table))
    ))

const deleteIn = (sql: SqlClient.SqlClient, table: string, column: string, ids: ReadonlyArray<string>) =>
  Effect.forEach(
    chunksOf(ids),
    (chunk) =>
      sql`DELETE FROM ${sql.unsafe(table)} WHERE ${sql.in(column, chunk)}`.pipe(
        Effect.mapError(deleting(table))
      ),
    { discard: true }
  )

const countTimeTravelReceipts = (sql: SqlClient.SqlClient, ids: ReadonlyArray<string>) =>
  Effect.reduce(chunksOf(ids), () => 0, (total, chunk) =>
    sql<{ readonly total: number }>`
      SELECT COUNT(*) AS total
      FROM flows_time_travel_receipts
      WHERE audit_id IN (
        SELECT id FROM flows_time_travel_audits WHERE ${sql.in("run_id", chunk)}
      )
    `.pipe(
      Effect.map((rows) => rows.reduce((sum, row) => sum + Number(row.total), total)),
      Effect.mapError(deleting("flows_time_travel_receipts"))
    ))

const deleteTimeTravelReceipts = (sql: SqlClient.SqlClient, ids: ReadonlyArray<string>) =>
  Effect.forEach(
    chunksOf(ids),
    (chunk) =>
      sql`
        DELETE FROM flows_time_travel_receipts
        WHERE audit_id IN (
          SELECT id FROM flows_time_travel_audits WHERE ${sql.in("run_id", chunk)}
        )
      `.pipe(Effect.mapError(deleting("flows_time_travel_receipts"))),
    { discard: true }
  )

/** Every run whose parent is a candidate, candidates included. */
const childrenOf = (sql: SqlClient.SqlClient, candidateIds: ReadonlyArray<string>) =>
  Effect.reduce(
    chunksOf(candidateIds),
    (): Array<ChildEdge> => [],
    (accumulated, chunk) =>
      // `parent_run_id` is the match predicate, so every row this returns
      // has one.
      sql<{ readonly run_id: string; readonly parent_run_id: string }>`
        SELECT run_id, parent_run_id FROM flows_runs WHERE ${sql.in("parent_run_id", chunk)}
      `.pipe(
        Effect.map((rows) => {
          for (const row of rows) {
            accumulated.push({ runId: row.run_id, parentRunId: row.parent_run_id })
          }
          return accumulated
        }),
        Effect.mapError(scanning("the run lineage"))
      )
  )

/**
 * Drops from `doomed` every candidate that must outlive this pass, and
 * every ancestor of one.
 *
 * A candidate whose child is not being deleted has to stay: `flows_runs`
 * carries a self-referential foreign key on `parent_run_id`, so deleting
 * it would orphan a row that still exists. Retention is upward-closed for
 * the same reason — once a candidate is retained, the candidate it points
 * at is still referenced and is retained too.
 */
const pinAncestors = (
  doomed: Set<string>,
  retained: Set<string>,
  parentOf: ReadonlyMap<string, string | null>,
  from: string
): void => {
  let current: string | undefined = from
  while (current !== undefined && doomed.has(current)) {
    doomed.delete(current)
    retained.add(current)
    current = parentOf.get(current) ?? undefined
  }
}

/**
 * Groups the doomed runs so that no group holds a run and one of its
 * doomed descendants. Deleting a parent while its child row still exists
 * violates the foreign key, and SQLite evaluates it per row rather than at
 * commit, so the delete runs deepest generation first.
 */
const generations = (
  doomed: ReadonlySet<string>,
  parentOf: ReadonlyMap<string, string | null>
): ReadonlyArray<ReadonlyArray<string>> => {
  const depths = new Map<string, number>()
  const depthOf = (runId: string): number => {
    const known = depths.get(runId)
    if (known !== undefined) return known
    const parent = parentOf.get(runId) ?? undefined
    const depth = parent !== undefined && doomed.has(parent) ? depthOf(parent) + 1 : 0
    depths.set(runId, depth)
    return depth
  }
  const byDepth = new Map<number, Array<string>>()
  for (const runId of doomed) {
    const depth = depthOf(runId)
    const bucket = byDepth.get(depth)
    if (bucket === undefined) byDepth.set(depth, [runId])
    else bucket.push(runId)
  }
  return Array.from(byDepth.keys())
    .sort((left, right) => right - left)
    .map((depth) => byDepth.get(depth)!)
}

/**
 * Deletes `candidates` and every row the inventory says names them.
 *
 * The one deletion in this package. Both passes call it, so neither can be
 * holding a shorter table list than the other, and neither can be deleting
 * run rows in an order the self-referential foreign key refuses: a handoff
 * parent always sorts before its successor, so a pass that deleted in age
 * order broke as soon as one lineage straddled a chunk boundary.
 *
 * The caller owns the transaction. Nothing here is atomic on its own, and a
 * pass that removed the dependents of every candidate and then refused on the
 * run rows would have destroyed history it could not put back.
 *
 * @category constructors
 * @since 0.1.0
 */
export const deleteRuns = (
  sql: SqlClient.SqlClient,
  candidates: ReadonlyArray<Candidate>,
  options: { readonly dryRun: boolean; readonly assumeLadder: boolean }
): Effect.Effect<DeletionReport, RetentionError> =>
  Effect.gen(function*() {
    const installed = yield* installedTableNames(sql)
    const tables = runScopedTables.filter((entry) =>
      (options.assumeLadder && entry.ladder) || installed.has(entry.table)
    )
    const hasTimeTravelReceipts = installed.has("flows_time_travel_receipts") &&
      installed.has("flows_time_travel_audits")
    const candidateIds = candidates.map((candidate) => candidate.runId)
    const parentOf = new Map(candidates.map((candidate) => [candidate.runId, candidate.parentRunId]))
    const doomed = new Set(candidateIds)
    const pinned = new Set<string>()
    const candidateSet = new Set(candidateIds)
    // The foreign key, which no lineage filter covers: a child row that is
    // terminal and simply outside this pass — younger than the cutoff, or past
    // the bound — still points at its parent.
    for (const child of yield* childrenOf(sql, candidateIds)) {
      if (candidateSet.has(child.runId)) continue
      pinAncestors(doomed, pinned, parentOf, child.parentRunId)
    }
    // `candidates` arrives oldest first, so this reads in the order the pass
    // collected.
    const runIds = candidateIds.filter((runId) => doomed.has(runId))

    const deleted: Record<string, number> = {}
    if (hasTimeTravelReceipts) {
      const total = yield* countTimeTravelReceipts(sql, runIds)
      if (total > 0) deleted["flows_time_travel_receipts"] = total
    }
    for (const entry of tables) {
      const total = yield* countIn(sql, entry.table, entry.column, runIds)
      if (total > 0) deleted[entry.table] = total
    }
    if (runIds.length > 0) deleted["flows_runs"] = runIds.length

    if (!options.dryRun) {
      // Receipts have no run column, so remove them through their audits
      // before the ordinary inventory reaches and deletes those audit rows.
      if (hasTimeTravelReceipts) yield* deleteTimeTravelReceipts(sql, runIds)
      for (const entry of tables) yield* deleteIn(sql, entry.table, entry.column, runIds)
      // Last, and deepest generation first. The `flows_run_parents_gc`
      // trigger drops each run's DAG edges as its row goes.
      for (const generation of generations(doomed, parentOf)) {
        yield* deleteIn(sql, "flows_runs", "run_id", generation)
      }
    }

    return { runIds, pinned: Array.from(pinned), deleted }
  })

/**
 * Builds the retention operation over the composition's own durable tables.
 *
 * The scan reads `flows_runs` directly, the way `DurableEngineState` and
 * `ArtifactGc` do: this package composes the run-store, journal, and engine
 * migrations, so the schema is its own.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (): Effect.Effect<Service, never, SqlClient.SqlClient | Journal.Journal> =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const journal = yield* Journal.Journal

    /**
     * Aged terminal runs held by live lineage or an excluded continuation
     * descendant. An upward exclusion takes precedence over a live ancestor.
     *
     * These runs are never candidates — `candidatesOf` excludes them — so this
     * read exists to say WHY a workspace with aged runs collected fewer than
     * it holds. It carries the pass's own bound so the report costs no more
     * than the pass does.
     */
    const retainedByLineage = (cutoffMs: number, limit: number) =>
      sql<{ readonly run_id: string; readonly live_descendant: number }>`
        ${scanPrelude(sql, { cutoffMs, inclusive: true, parentEdges: true })}
        SELECT
          run_id,
          (run_id IN (SELECT run_id FROM over_live) OR EXISTS (
            SELECT 1 FROM flows_runs AS child
            WHERE child.parent_run_id = flows_runs.run_id
              AND child.run_id IN (SELECT run_id FROM blocked)
          )) AS live_descendant
        FROM flows_runs
        WHERE ${sql.in("status", terminalStatuses)}
          AND COALESCE(finished_at_ms, created_at_ms) <= ${cutoffMs}
          AND run_id IN (SELECT run_id FROM blocked)
        ORDER BY COALESCE(finished_at_ms, created_at_ms), run_id
        LIMIT ${limit}
      `.pipe(Effect.mapError(scanning("the run lineage")))

    const pass = (options: RetainOptions, cutoffMs: number) =>
      Effect.gen(function*() {
        const limit = normalizeLimit(options.limit)
        const candidates = yield* candidatesOf(sql, { cutoffMs, inclusive: true, parentEdges: true, limit }).pipe(
          Effect.mapError(scanning("the run table"))
        )
        const retained = new Set<string>()
        const retainedAbove = new Set<string>()
        // Why the workspace kept aged runs this pass. These never entered the
        // candidate set, so this only classifies them. It runs before the
        // deletes so the report describes the file the pass was handed.
        for (const held of yield* retainedByLineage(cutoffMs, limit)) {
          if (Number(held.live_descendant) > 0) retained.add(held.run_id)
          else retainedAbove.add(held.run_id)
        }
        // The whole deletion, shared with `Retention.collect` so the two
        // passes cannot hold different table lists or different orders. This
        // database is the engine's own ladder, so a table of it that the
        // catalog does not list is a broken schema and the delete says so.
        const removed = yield* deleteRuns(sql, candidates, {
          dryRun: options.dryRun === true,
          assumeLadder: true
        })

        return {
          cutoffMs,
          runIds: removed.runIds,
          retainedForLiveDescendants: Array.from(retained).sort(),
          retainedForLiveAncestors: Array.from(retainedAbove).sort(),
          runs: removed.runIds.length,
          attempts: removed.deleted["flows_attempts"] ?? 0,
          clockDeadlines: removed.deleted["flows_clock_deadlines"] ?? 0,
          deferredCompletions: removed.deleted["flows_deferred_completions"] ?? 0,
          journalEntries: removed.deleted["flows_journal_events"] ?? 0,
          journalCheckpoints: removed.deleted["flows_journal_checkpoints"] ?? 0,
          journalIdentities: removed.deleted["flows_journal_dedup"] ?? 0,
          archiveEntries: removed.deleted["flows_time_travel_archive"] ?? 0,
          timeTravelReceipts: removed.deleted["flows_time_travel_receipts"] ?? 0,
          dryRun: options.dryRun === true
        } satisfies RetainReport
      })

    const retain: Service["retain"] = Effect.fn("Retention.retain")((options: RetainOptions) =>
      Effect.gen(function*() {
        const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        const cutoffMs = nowMs - Math.max(0, options.olderThanMs)
        // One commit: `transact` joins the run-row deletes, the dependent
        // deletes, and the journal truncation into a single write transaction,
        // so a crash can never leave a run without its history or history
        // without its run. A transaction that cannot commit fails as the
        // `JournalError` it is rather than being laundered into a retention
        // code that would claim to know why.
        return yield* journal.transact(pass(options, cutoffMs))
      })
    )

    return { retain }
  })

/**
 * Provides run retention. Nothing schedules `retain()`; invoking it stays an
 * explicit caller decision.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Retention, never, SqlClient.SqlClient | Journal.Journal> = Layer.effect(Retention)(
  make()
)
