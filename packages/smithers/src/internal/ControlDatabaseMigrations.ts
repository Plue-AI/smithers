/**
 * The schema installed before any service opens the shared control database.
 *
 * Memory can be the first CLI command a project runs. Installing every lower
 * block here keeps that command from advancing the migration cursor past
 * control and engine tables that a later command still needs to create.
 *
 * @since 1.0.0
 */

import * as ControlMigrations from "@smthrs/control/Migrations"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as MemoryMigrations from "@smthrs/memory/Migrations"
import * as TimeTravelMigrations from "@smthrs/time-travel/Migrations"
import * as HistoryMigrations from "../history/Migrations.ts"

/**
 * Applies the complete shared schema in a single ordered migration pass.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = DatabaseMigrations.layer([
  ...TimeTravelMigrations.sets,
  ControlMigrations.set,
  MemoryMigrations.set,
  HistoryMigrations.set
])
