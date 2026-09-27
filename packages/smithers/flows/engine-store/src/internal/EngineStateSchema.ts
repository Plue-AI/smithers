/**
 * The schema objects `DurableEngineState` creates outside the journal
 * migration, and the inventory of what porting them to another
 * dialect costs.
 *
 * Each durable package owns its migration ladder. Spawn edges and their GC
 * trigger moved into engine-store migration 0006. The remaining
 * statements are engine-store-owned storage created idempotently at
 * construction instead (issues #40/#41/#79/#81). That is a deliberate lane
 * boundary, not an oversight — but it left the statements invisible to the
 * pg-porting plan in the database roadmap, which
 * scoped only the journal migration's SQLite-specific DDL. Declaring them here
 * makes the inventory machine-readable: a test diffs the database's schema
 * objects across `make` against this list, so no engine-owned statement can
 * be added without appearing in the porting inventory (issue #92).
 *
 * @since 0.1.0
 */

import type { Service as WriterService } from "@smthrs/database/DurableWriter"
import * as Effect from "effect/Effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * SQL dialects a statement is known to be accepted by, verbatim.
 *
 * @since 0.1.0
 * @category models
 */
export type Dialect = "sqlite" | "postgres"

/**
 * One engine-store-owned schema object.
 *
 * @since 0.1.0
 * @category models
 */
export interface Statement {
  /** The schema object's name, as it appears in the catalog. */
  readonly name: string
  /** Why the object exists, by issue. */
  readonly reason: string
  /**
   * Dialects that accept this statement unchanged. A statement listing only
   * `"sqlite"` must be rewritten before a Postgres/PGlite `Database` layer
   * can construct this service — `make` pipes every one of them through
   * `Effect.orDie`, so an unported statement is a construction-time defect,
   * not a recoverable error.
   */
  readonly dialects: ReadonlyArray<Dialect>
  readonly ddl: string
}

/**
 * The porting inventory: every engine-store-owned statement, in creation order.
 *
 * @since 0.1.0
 * @category constants
 */
export const statements: ReadonlyArray<Statement> = [
  {
    name: "flows_runs_stale_running_idx",
    reason:
      "Serves the stale-running sweep's per-tick predicate (issue #79): `status = 'running' AND heartbeat_at_ms < cutoff`, ordered by heartbeat. A partial index keeps it tiny — only live running rows appear.",
    // Partial indexes are valid Postgres since 9.5, so this one ports as-is.
    dialects: ["sqlite", "postgres"],
    ddl: `
      CREATE INDEX IF NOT EXISTS flows_runs_stale_running_idx
      ON flows_runs (heartbeat_at_ms)
      WHERE status = 'running'
    `
  }
]

/**
 * Creates the engine-store-owned objects, idempotently, in inventory order.
 *
 * `flows_runs` must already exist — every query in this service assumes a
 * migrated database, so `make` composes over one by construction.
 *
 * @since 0.1.0
 * @category constructors
 */
export const apply = (sql: SqlClient.SqlClient, writer: WriterService): Effect.Effect<void> =>
  Effect.forEach(
    statements,
    (statement) => writer.write(sql.unsafe(statement.ddl)).pipe(Effect.orDie),
    { discard: true }
  )
