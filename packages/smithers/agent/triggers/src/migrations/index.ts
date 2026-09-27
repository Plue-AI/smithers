/** @since 0.1.0 */

import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import { triggers } from "./0001_triggers.ts"
import { reservationLease } from "./0002_reservation_lease.ts"
import { schedulerHeartbeat } from "./0003_heartbeat.ts"
import { fireRunIndex } from "./0004_fire_run_index.ts"

/**
 * The migration record {@link run} applies, keyed by migration file name.
 *
 * Exported so a test and the release smoke can assert that every entry is the
 * migration Effect itself in both the ESM and the CommonJS build.
 *
 * @category migrations
 * @since 1.0.0-rc.0
 */
export const migrations = {
  "0001_triggers": triggers,
  "0002_reservation_lease": reservationLease,
  "0003_heartbeat": schedulerHeartbeat,
  "0004_fire_run_index": fireRunIndex
}

/**
 * Applies the triggers schema migrations.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = Migrator.make({})({ loader: Migrator.fromRecord(migrations), table: "flows_trigger_migrations" })

/**
 * Runs {@link run} once as a layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
