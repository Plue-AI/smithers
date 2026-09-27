/** @since 1.0.0 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `smithers_integration_cursors` table.
 *
 * The manifest is the allowlist, so this module stays out of `package.json`
 * `exports` and out of `core.ts`: consumers reach the migration through
 * `Core.Migrations.set`, never by importing the schema installation directly.
 *
 * Exported by name, never as a default: `scripts/build.mjs` converts every
 * module to CommonJS with esbuild under `"type": "module"`, and esbuild reads a
 * default import of a sibling as the whole interop wrapper rather than the
 * Effect, so a default import here left `Migrations.set` holding an object
 * with no `pipe`.
 *
 * @category migrations
 * @since 1.0.0
 */
export const integrationCursors: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS smithers_integration_cursors (
    source_id TEXT PRIMARY KEY,
    cursor TEXT,
    updated_at_ms ${Dialect.integer(sql)} NOT NULL
  )`
})
