/**
 * Journal schema migrations.
 *
 * The journal owns four tables: `flows_journal_events` and its event-type
 * index in `0001_initial`, `flows_journal_checkpoints` in
 * `0002_checkpoints`, the bounded startup ordering index in
 * `0003_startup_index`, compacted producer identities in `0004_dedup`, the
 * per-run exact event-type cursor index in `0005_run_event_type`, and the
 * `SqlConsensus` lease table `flows_consensus_leases` in `0006_consensus`. Run
 * and attempt state migrate from `@smthrs/run-store`, the step cache from
 * `@smthrs/step-cache`, and the durable deferred/clock tables from
 * `@smthrs/engine-store`; an application composes those sets with this one
 * through `@smthrs/database`'s `Migrations.layer`.
 *
 * @since 0.1.0
 */

import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as Layer from "effect/Layer"
import { initial } from "./migrations/0001_initial.ts"
import { checkpoints } from "./migrations/0002_checkpoints.ts"
import { startupIndex } from "./migrations/0003_startup_index.ts"
import { dedup } from "./migrations/0004_dedup.ts"
import { runEventType } from "./migrations/0005_run_event_type.ts"
import { consensus } from "./migrations/0006_consensus.ts"

/**
 * The journal's namespaced migration set, for composition with the other
 * storage packages.
 *
 * @category migrations
 * @since 0.1.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "journal",
  idOffset: 0,
  migrations: {
    "0001_initial": initial,
    "0002_checkpoints": checkpoints,
    "0003_startup_index": startupIndex,
    "0004_dedup": dedup,
    "0005_run_event_type": runEventType,
    "0006_consensus": consensus
  }
}

/**
 * Creates the journal's authoritative durable schema.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run([set])

/**
 * Layer that runs journal migrations before exposing the database to journal
 * services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
