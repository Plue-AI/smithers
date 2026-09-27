/**
 * Bounded, indexed run pages.
 *
 * @since 1.0.0
 */
import * as Dialect from "@smthrs/database/Dialect"
import { RunStatus } from "@smthrs/run-store/RunStore"
import { Cause, Effect, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Read from "./ExecutionSnapshotRead.ts"
import { RunCatalogError } from "./RunListingError.ts"

/**
 * Supported equality and inclusive creation-range filters.
 *
 * @category models
 * @since 1.0.0
 */
export const Filters = Schema.Struct({
  status: Schema.optionalKey(RunStatus),
  flowName: Schema.optionalKey(Read.Identifier),
  parentRunId: Schema.optionalKey(Schema.NullOr(Read.Identifier)),
  lineageId: Schema.optionalKey(Read.Identifier),
  waitingReason: Schema.optionalKey(Schema.NullOr(Read.Identifier)),
  createdAfterMs: Schema.optionalKey(Read.Natural),
  createdBeforeMs: Schema.optionalKey(Read.Natural)
})
/**
 * Supported filters; lineageId also selects its original root.
 *
 * @category models
 * @since 1.0.0
 */
export type Filters = typeof Filters.Type
/**
 * Options for a bounded run page. Numeric offsets are not cursors.
 *
 * @category models
 * @since 1.0.0
 */
export interface ListRunsOptions {
  readonly filters?: Filters
  readonly cursor?: string
  readonly limit?: number
}
/**
 * One transaction's page and watermark; no total count.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunPage extends Read.Position {
  readonly runs: ReadonlyArray<Read.Observed>
  readonly cursor: string | null
}
/**
 * Bounded catalog operations.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  readonly listRuns: (options?: ListRunsOptions) => Effect.Effect<RunPage, RunCatalogError>
}
/**
 * Maximum page size.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumPageSize = 200
const Cursor = Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1),
  source: Read.Source,
  filters: Schema.String,
  createdAtMs: Read.Natural,
  runId: Read.Identifier
}))
const Options = Schema.Struct({
  filters: Schema.optionalKey(Filters),
  // Four 1,024-unit filter strings can expand sevenfold inside the JSON tuple
  // string, plus a sixfold escaped 1,024-unit run ID and bounded scalar fields.
  // 64 Ki UTF-16 units therefore admits every cursor this port can produce.
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65536))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumPageSize })))
})

/**
 * Builds the bounded read against the engine database.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const listRuns: Service["listRuns"] = (options = {}) =>
      Effect.gen(function*() {
        const admitted = yield* Schema.decodeUnknownEffect(Options)(options, { onExcessProperty: "error" }).pipe(
          Effect.mapError((cause) =>
            new RunCatalogError({ code: "invalid_options", message: "invalid run page options", cause })
          )
        )
        const filters = admitted.filters ?? {}
        const tuple = JSON.stringify([
          filters.status ?? null,
          filters.flowName ?? null,
          filters.parentRunId === undefined ? [] : [filters.parentRunId],
          filters.lineageId ?? null,
          filters.waitingReason === undefined ? [] : [filters.waitingReason],
          filters.createdAfterMs ?? null,
          filters.createdBeforeMs ?? null
        ])
        const cursor = admitted.cursor === undefined ?
          null :
          yield* Schema.decodeUnknownEffect(Cursor)(admitted.cursor).pipe(
            Effect.mapError((cause) =>
              new RunCatalogError({ code: "invalid_cursor", message: "malformed run cursor", cause })
            )
          )
        if (cursor !== null && cursor.filters !== tuple) {
          return yield* Effect.fail(
            new RunCatalogError({ code: "invalid_cursor", message: "run cursor belongs to another query" })
          )
        }
        const limit = admitted.limit ?? 100
        return yield* Read.transaction(
          sql,
          Effect.gen(function*() {
            const at = yield* Read.position(sql)
            if (cursor !== null && cursor.source !== at.source) {
              return yield* Effect.fail(
                new RunCatalogError({ code: "source_changed", message: "run cursor belongs to another engine source" })
              )
            }
            const predicates: Array<string> = []
            const values: Array<string | number | null> = []
            let mask = 0
            const equalities = [
              ["status", filters.status],
              ["execution_flow", filters.flowName],
              ["execution_parent_id", filters.parentRunId],
              ["execution_lineage", filters.lineageId],
              ["waiting_reason", filters.waitingReason]
            ] as const
            for (const [index, [column, value]] of equalities.entries()) {
              if (value === undefined) continue
              mask |= 1 << index
              predicates.push(`r.${column} IS NOT DISTINCT FROM ?`)
              values.push(value)
            }
            if (filters.createdAfterMs !== undefined) {
              predicates.push("r.created_at_ms >= ?")
              values.push(filters.createdAfterMs)
            }
            if (filters.createdBeforeMs !== undefined) {
              predicates.push("r.created_at_ms <= ?")
              values.push(filters.createdBeforeMs)
            }
            if (cursor !== null) {
              predicates.push("(r.created_at_ms, r.run_id) > (?, ?)")
              values.push(cursor.createdAtMs, cursor.runId)
            }
            values.push(limit + 1)
            const rows = yield* Dialect.query(
              sql,
              `SELECT ${Read.selectColumns} FROM flows_runs r ${
                Dialect.isPostgres(sql) ? "" : `INDEXED BY flows_runs_listing_${mask}`
              }
        LEFT JOIN flows_run_changes c ON c.run_id = r.run_id
        ${
                predicates.length === 0
                  ? ""
                  : `WHERE ${predicates.join(" AND ")}`
              }
        ORDER BY r.created_at_ms, r.run_id LIMIT ?`,
              values
            )
            const decoded = yield* Effect.forEach(rows, (row) => Read.observed(row, at))
            const runs = decoded.slice(0, limit)
            const last = runs[runs.length - 1]
            return {
              ...at,
              runs,
              cursor: decoded.length > limit ?
                JSON.stringify({
                  version: 1,
                  source: at.source,
                  filters: tuple,
                  createdAtMs: last!.createdAtMs,
                  runId: last!.runId
                }) :
                null
            }
          })
        )
      }).pipe(Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>)
        const original = Cause.squash(cause)
        return Effect.fail(
          original instanceof RunCatalogError ? original : new RunCatalogError({
            code: "list_failed",
            message: "the engine run page could not be read",
            cause: original
          })
        )
      }))
    return { listRuns }
  })
