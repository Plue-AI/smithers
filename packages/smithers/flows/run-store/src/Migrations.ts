/**
 * Run and attempt schema migrations.
 *
 * This package owns `flows_runs` and `flows_attempts`. It reserves migration
 * id block `1000` so its ids can never collide with the journal's or the step
 * cache's — see `@smthrs/database`'s `Migrations` for how the blocks compose.
 *
 * @since 0.1.0
 */

import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as Layer from "effect/Layer"
import { initial } from "./migrations/0001_initial.ts"
import { lineage } from "./migrations/0002_lineage.ts"
import { executionRevisions } from "./migrations/0003_execution_revisions.ts"
import { waitingRequest } from "./migrations/0004_waiting_request.ts"

/**
 * The run store's namespaced migration set, for composition with the other
 * storage packages.
 *
 * @category migrations
 * @since 0.1.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "run-store",
  idOffset: DatabaseMigrations.idBlock,
  migrations: {
    "0001_initial": initial,
    "0002_lineage": lineage,
    "0003_execution_revisions": executionRevisions,
    "0004_waiting_request": waitingRequest
  }
}

/**
 * Creates the run and attempt schema.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run([set])

/**
 * Layer that runs run-store migrations before exposing the database to the run
 * and attempt services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
