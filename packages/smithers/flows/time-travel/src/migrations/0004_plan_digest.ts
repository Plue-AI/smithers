/**
 * Plan identity on snapshot anchors.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { step } from "../internal/MigrationStep.ts"

/**
 * Adds plan identity to snapshot anchors.
 *
 * @since 0.1.0
 * @private
 */
export const planDigest = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  // Older store builds added this column outside the migration ledger.
  const columns = yield* Dialect.columns(sql, "flows_time_travel_snapshots")
  if (columns.some((column) => column.name === "plan_digest")) return
  yield* step(
    "the flows_time_travel_snapshots plan_digest column",
    sql`ALTER TABLE flows_time_travel_snapshots ADD COLUMN plan_digest TEXT
      CHECK (plan_digest IS NULL OR length(plan_digest) > 0)`
  )
})
