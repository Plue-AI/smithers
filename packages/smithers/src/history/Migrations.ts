/**
 * History reconciliation schema in the shared control database.
 *
 * The engine-side route table `smthrs_history_workspaces` stays outside this
 * set: engine.db's ladder belongs to `@smthrs/flows`, and a CLI block above it
 * would refuse every lower block that package adds later.
 *
 * @since 1.0.0
 */

import * as DatabaseMigrations from "@smthrs/database/Migrations"
import { appliedAudits } from "./migrations/0001_applied_audits.ts"

/**
 * History's namespaced migration set, the block above `@smthrs/memory`.
 *
 * @category migrations
 * @since 1.0.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "history",
  idOffset: DatabaseMigrations.idBlock * 8,
  migrations: {
    "0001_applied_audits": appliedAudits
  }
}
