/**
 * Run and attempt schema migrations.
 *
 * This package owns `flows_runs` and `flows_attempts`. It reserves migration
 * id block `1000` so its ids can never collide with the journal's or the step
 * cache's — see `@smthrs/database`'s `Migrations` for how the blocks compose.
 *
 * The SQL `RunStore` arbitrates ownership through `@smthrs/journal`'s
 * `SqlConsensus`, whose lease table the journal's migration set creates, so
 * {@link run} and {@link layer} install the journal's set ahead of this one.
 * {@link set} stays scoped to the run-store tables for compositions that list
 * every set themselves, such as `@smthrs/engine-store/Migrations`.
 *
 * @since 0.1.0
 */

import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as JournalMigrations from "@smthrs/journal/Migrations"
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
 * Creates the run and attempt schema, and the journal schema whose consensus
 * lease table the SQL `RunStore` fences through.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run([JournalMigrations.set, set])

/**
 * Layer that runs run-store migrations before exposing the database to the run
 * and attempt services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
