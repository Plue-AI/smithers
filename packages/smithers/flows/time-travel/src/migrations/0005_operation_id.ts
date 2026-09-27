/**
 * jj operation identity on snapshot anchors.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { step } from "../internal/MigrationStep.ts"

/**
 * Adds the jj operation that recorded each snapshot anchor, which a
 * whole-repository rewind restores.
 *
 * @since 1.0.0
 * @private
 */
export const operationId = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  // Idempotent like 0004, so a schema adopted from unrecorded rungs converges.
  const columns = yield* Dialect.columns(sql, "flows_time_travel_snapshots")
  if (columns.some((column) => column.name === "operation_id")) return
  yield* step(
    "the flows_time_travel_snapshots operation_id column",
    sql`ALTER TABLE flows_time_travel_snapshots ADD COLUMN operation_id TEXT
      CHECK (operation_id IS NULL OR length(operation_id) > 0)`
  )
})
