/**
 * Durable engine schema migrations.
 *
 * Engine-store owns persisted deferred/clock state, execution selections,
 * and append-only plan-input observations. These are authoritative execution
 * records, distinct from journal projections and evictable step-cache rows.
 * It reserves migration id block `3000`.
 *
 * Because engine-store composes the journal, the run store, and the step
 * cache, {@link sets} is also the full durable schema an engine needs, and
 * {@link layer} installs it in dependency order.
 *
 * Derived contracts: `docs/api.md` ("Migrations") and
 * `packages/smithers/flows/journal/docs/api.md`.
 *
 * @since 0.1.0
 */

import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as PlanMigrations from "@smthrs/plan-store/Migrations"
import * as RunStoreMigrations from "@smthrs/run-store/Migrations"
import * as StepCacheMigrations from "@smthrs/step-cache/Migrations"
import * as Layer from "effect/Layer"
import { initial } from "./migrations/0001_initial.ts"
import { selectionStore } from "./migrations/0002_selection_store.ts"
import { planInputs } from "./migrations/0003_plan_inputs.ts"
import { planEnvironment } from "./migrations/0004_plan_environment.ts"
import { planMerges } from "./migrations/0005_plan_merges.ts"
import { executionListing } from "./migrations/0006_execution_listing.ts"
import { runParentSequence } from "./migrations/0007_run_parent_sequence.ts"
import { deferredConsumption } from "./migrations/0008_deferred_consumption.ts"
import { deferredClockFacts } from "./migrations/0009_deferred_clock_facts.ts"
import { pendingCancellation } from "./migrations/0010_pending_cancellation.ts"

/**
 * Engine-store's own namespaced migration set.
 *
 * @category migrations
 * @since 0.1.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "engine-store",
  idOffset: DatabaseMigrations.idBlock * 3,
  migrations: {
    "0001_initial": initial,
    "0002_selection_store": selectionStore,
    "0003_plan_inputs": planInputs,
    "0004_plan_environment": planEnvironment,
    "0005_plan_merges": planMerges,
    "0006_execution_listing": executionListing,
    "0007_run_parent_sequence": runParentSequence,
    "0008_deferred_consumption": deferredConsumption,
    "0009_deferred_clock_facts": deferredClockFacts,
    "0010_pending_cancellation": pendingCancellation
  }
}

/**
 * Every migration set a durable engine needs, in dependency order: journal
 * events, run and attempt state, the step cache, the engine's own deferred and
 * clock, selection, and input tables, then the persisted plan.
 *
 * The plan set has the highest id block (`4000`). The database loader applies
 * forward additions within already installed blocks transactionally before
 * the ordinary migration pass (for example, engine-store `3003` after plan
 * `4003`). Earlier holes and entirely new lower blocks remain refusals.
 *
 * @category migrations
 * @since 0.1.0
 */
export const sets: ReadonlyArray<DatabaseMigrations.MigrationSet> = [
  JournalMigrations.set,
  RunStoreMigrations.set,
  StepCacheMigrations.set,
  set,
  PlanMigrations.set
]

/**
 * Creates the complete durable engine schema.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run(sets)

/**
 * Layer that installs the complete durable engine schema before exposing the
 * database to any durable service.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
