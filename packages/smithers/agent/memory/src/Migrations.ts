/**
 * Memory schema migrations on the shared Smithers database ladder.
 *
 * Standalone stores install only this set. Hosts sharing a file with the
 * durable engine and control plane compose those lower blocks before this
 * set, so every table and its migration identity are committed together.
 *
 * @since 1.0.0
 */

import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as Layer from "effect/Layer"
import { ftsFold } from "./internal/MemoryFtsFold.ts"
import { indexes } from "./internal/MemoryIndexes.ts"
import { initial } from "./internal/MemorySchema.ts"

/**
 * Memory's authoritative schema, in the block following the control plane.
 *
 * @category migrations
 * @since 1.0.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "memory",
  idOffset: DatabaseMigrations.idBlock * 7,
  migrations: {
    "0001_initial": initial,
    "0002_indexes": indexes,
    "0003_fts_fold": ftsFold
  }
}

/**
 * Applies the memory schema and records it atomically in `flows_migrations`.
 *
 * @category migrations
 * @since 1.0.0
 */
export const run = DatabaseMigrations.run([set])

/**
 * Installs the memory schema before exposing the database to memory services.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = Layer.effectDiscard(run)
