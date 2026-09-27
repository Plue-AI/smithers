/**
 * Score-store migrations.
 *
 * @since 0.1.0
 */

import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import { migration as scores } from "./migrations/0001_scores.ts"
import { migration as jobs } from "./migrations/0002_score_jobs.ts"
import { migration as failureCodes } from "./migrations/0003_score_failure_codes.ts"
import { migration as requiredFailureCodes } from "./migrations/0004_require_failure_codes.ts"

const migrations = {
  "0001_scores": scores,
  "0002_score_jobs": jobs,
  "0003_score_failure_codes": failureCodes,
  "0004_require_failure_codes": requiredFailureCodes
}

/**
 * Bootstraps the shared database ledger and applies all score-store migrations.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run([]).pipe(
  // A standalone file needs the shared ledger for NodeDatabase to reopen it.
  // Keep the scorer ledger and its ids intact for already-migrated stores.
  Effect.andThen(
    Migrator.make({})({
      loader: Migrator.fromRecord(migrations),
      table: "flows_scorers_migrations"
    })
  )
)

/**
 * Applies score-store migrations when the layer is constructed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
