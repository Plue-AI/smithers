/**
 * Control-plane and credential schema migrations.
 *
 * This package reserves the migration block immediately after time travel.
 * Hosts compose this set with the journal and run-store sets before opening a
 * shared control database.
 *
 * @since 0.1.0
 */

import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as Layer from "effect/Layer"
import { initial } from "./migrations/0001_control_tables.ts"
import { runKeys } from "./migrations/0002_run_keys.ts"
import { signalCommands } from "./migrations/0003_signal_commands.ts"
import { approvalDecisions } from "./migrations/0004_approval_decisions.ts"
import { signalPrincipals } from "./migrations/0005_signal_principals.ts"

/**
 * The control package's namespaced migration set.
 *
 * @category migrations
 * @since 0.1.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "control",
  idOffset: DatabaseMigrations.idBlock * 6,
  migrations: {
    "0001_control_tables": initial,
    "0002_run_keys": runKeys,
    "0003_signal_commands": signalCommands,
    "0004_approval_decisions": approvalDecisions,
    "0005_signal_principals": signalPrincipals
  }
}

/**
 * Creates every durable control-plane and credential table.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run([set])

/**
 * Layer that runs control migrations before exposing the database to control
 * services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
