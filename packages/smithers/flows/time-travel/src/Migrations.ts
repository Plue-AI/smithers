/**
 * Time-travel schema migrations, as a rung on the shared ladder.
 *
 * Each rung owns fixed DDL. Store construction applies this same set through
 * the shared migrator, which records completed rungs in `flows_migrations`.
 * Add schema changes as new rungs; never grow an already published rung.
 * The journal owns `flows_journal_events`; time travel owns the lineage
 * indexes it adds to that table.
 *
 * @since 0.1.0
 */

import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as EngineStoreMigrations from "@smthrs/engine-store/Migrations"
import * as Layer from "effect/Layer"
import { initial } from "./migrations/0001_initial.ts"
import { archiveGeneration } from "./migrations/0002_archive_generation.ts"
import { lineageProbes } from "./migrations/0003_lineage_probes.ts"
import { planDigest } from "./migrations/0004_plan_digest.ts"
import { operationId } from "./migrations/0005_operation_id.ts"

/**
 * Time travel's namespaced migration set.
 *
 * The block is `5000` — above `@smthrs/plan`'s `4000`, which is what keeps the
 * set runnable on a database the engine ladder already migrated.
 *
 * @category migrations
 * @since 0.1.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "time-travel",
  idOffset: DatabaseMigrations.idBlock * 5,
  migrations: {
    "0001_initial": initial,
    "0002_archive_generation": archiveGeneration,
    "0003_lineage_probes": lineageProbes,
    "0004_plan_digest": planDigest,
    "0005_operation_id": operationId
  }
}

/**
 * The full durable schema an engine WITH time travel needs, in dependency
 * order: everything `@smthrs/engine-store` composes, then this.
 *
 * @category migrations
 * @since 0.1.0
 */
export const sets: ReadonlyArray<DatabaseMigrations.MigrationSet> = [
  ...EngineStoreMigrations.sets,
  set
]

/**
 * Creates the complete durable schema for an engine with time travel.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run(sets)

/**
 * Layer that installs the complete schema before exposing the database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
