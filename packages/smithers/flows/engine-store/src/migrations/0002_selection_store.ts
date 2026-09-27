/**
 * Durable suspected-edge storage for probabilistic selection.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_selection_suspected_edges` table.
 *
 * @category migrations
 * @since 0.1.0
 */
export const selectionStore: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_selection_suspected_edges (
    scope TEXT NOT NULL CHECK (length(scope) > 0),
    affects TEXT NOT NULL CHECK (length(affects) > 0),
    confidence DOUBLE PRECISION NOT NULL CHECK (
      ${
    sql.literal(Dialect.isPostgres(sql) ? "TRUE" : "(typeof(confidence) = 'real' OR typeof(confidence) = 'integer')")
  } AND
      confidence >= 0 AND
      confidence <= 1
    ),
    valid_from_ms ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`valid_from_ms`)} AND
      valid_from_ms >= 0 AND
      valid_from_ms <= 9007199254740991
    ),
    evidence_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`evidence_json`)}),
    PRIMARY KEY (scope, affects)
  )`
})
