/**
 * The third memory migration: PostgreSQL FTS folds diacritics like FTS5.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { Kind } from "../Namespace.ts"
import { postgresSearchColumn, postgresSearchIndex } from "./Fts.ts"

/**
 * Regenerates the search column of every enabled PostgreSQL FTS table with
 * the current diacritic-folding expression, so text indexed before the fold
 * still matches folded query terms. SQLite's FTS5 tables already fold, and a
 * kind enabled after this migration is created with the current column.
 *
 * @category migrations
 * @since 1.0.0
 */
export const ftsFold = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  if (!Dialect.isPostgres(sql)) return
  const kinds = yield* sql<{ readonly namespace_kind: Kind }>`SELECT namespace_kind FROM memory_fts_kinds`
  for (const { namespace_kind: kind } of kinds) {
    const table = sql.literal(`memory_fts_${kind}`)
    yield* sql`ALTER TABLE ${table} DROP COLUMN search`
    yield* sql`ALTER TABLE ${table} ADD COLUMN ${postgresSearchColumn(sql)}`
    yield* postgresSearchIndex(sql, kind)
  }
})
