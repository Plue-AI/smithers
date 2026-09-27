/**
 * Page-scoped durable child and round enumeration.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import { RunStoreError } from "@smthrs/run-store/RunStore"
import { Effect, Schema } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type { Batch, Snapshot } from "../ExecutionSnapshot.ts"
import * as Read from "./ExecutionSnapshotRead.ts"

/**
 * Child edges and trampoline rounds are different relations.
 *
 * @category models
 * @since 1.0.0
 */
export interface RelatedOptions {
  readonly runId: string
  readonly kind: "children" | "rounds"
  readonly cursor?: string
  readonly limit?: number
}
/**
 * A requested anchor and its page, observed in one transaction.
 *
 * @category models
 * @since 1.0.0
 */
export interface RelatedPage extends Batch {
  readonly anchor: Snapshot
  readonly cursor: string | null
}
const Kind = Schema.Literals(["children", "rounds"])
const Options = Schema.Struct({
  runId: Read.Identifier,
  kind: Kind,
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32768))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })))
})
const Cursor = Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1),
  source: Read.Source,
  runId: Read.Identifier,
  kind: Kind,
  ordinal: Read.Natural,
  lastRunId: Read.Identifier
}))
const Relation = Schema.Struct({ run_id: Read.Identifier, ordinal: Read.Natural })

/**
 * Builds a bounded relation reader over the shared snapshot port.
 *
 * @private
 * @since 1.0.0
 */
export const make = (
  sql: SqlClient.SqlClient,
  read: (ids: ReadonlyArray<string>) => Effect.Effect<Batch, RunStoreError>
) =>
(options: RelatedOptions): Effect.Effect<RelatedPage, RunStoreError> =>
  Read.boundary(
    "ExecutionSnapshot.related",
    Effect.gen(function*() {
      const input = yield* Read.decode(Options, options)
      const cursor = input.cursor === undefined ? null : yield* Read.decode(Cursor, input.cursor)
      return yield* Read.transaction(
        sql,
        Effect.gen(function*() {
          const at = yield* Read.position(sql)
          if (
            cursor !== null &&
            (cursor.source !== at.source || cursor.runId !== input.runId || cursor.kind !== input.kind)
          ) {
            return yield* Effect.fail(
              new RunStoreError({
                method: "ExecutionSnapshot.related",
                code: "invalid_run",
                message: "relation cursor belongs to another query or source",
                cause: cursor
              })
            )
          }
          const anchor = (yield* read([input.runId])).snapshots[0]!
          const limit = input.limit ?? 100
          const values: Array<string | number | null> = [input.runId]
          const columns = input.kind === "children" ? ["seq", "child_id"] : ["COALESCE(round_ordinal, 0)", "run_id"]
          const after = cursor === null ? "" : `AND (${columns.join(", ")}) > (?, ?)`
          if (cursor !== null) values.push(cursor.ordinal, cursor.lastRunId)
          values.push(limit + 1)
          const query = input.kind === "children"
            ? `SELECT child_id AS run_id, seq AS ordinal FROM flows_run_parents
         WHERE parent_id = ? ${after} ORDER BY seq, child_id LIMIT ?`
            : `SELECT run_id, COALESCE(round_ordinal, 0) AS ordinal FROM flows_runs
         WHERE execution_lineage = (SELECT execution_lineage FROM flows_runs WHERE run_id = ?)
         ${after} ORDER BY COALESCE(round_ordinal, 0), run_id LIMIT ?`
          const rows = yield* Dialect.query(sql, query, values)
          const decoded = yield* Effect.forEach(rows, (row) => Read.decode(Relation, row))
          const selected = decoded.slice(0, limit)
          const batch = yield* read(selected.map((row) => row.run_id))
          const last = selected[selected.length - 1]
          return {
            ...batch,
            anchor,
            cursor: decoded.length > limit ?
              JSON.stringify({
                version: 1,
                source: at.source,
                runId: input.runId,
                kind: input.kind,
                ordinal: last!.ordinal,
                lastRunId: last!.run_id
              }) :
              null
          }
        })
      )
    })
  )
