/**
 * Persisted plan schema migrations.
 *
 * This package owns `flows_plans`, `flows_plan_nodes`, and `flows_plan_edges`
 * and nothing else. It reserves migration id block `4000` — the next free
 * block after the journal (`0`), the run store (`1000`), the step cache
 * (`2000`), and the engine store (`3000`) — so its first migration is id
 * `4001`. See `@smthrs/database`'s `Migrations` for how the blocks compose and
 * why a set landing at or below the applied high-water mark is rejected rather
 * than silently assumed done.
 *
 * The persisted plan and the journal are separate stores, which is why this
 * package owns its own tables and its own migration block.
 *
 * The ordered steps live under `internal/migrations`, which the export map
 * blocks, so {@link set} is the only way to reach them. A step imported on
 * its own would run outside the namespaced ordering that `@smthrs/database`
 * relies on to decide what has already been applied.
 *
 * Each step is a named export and is imported here by name. A default export
 * compiles to `exports.default` in the CommonJS build, and Node's interop then
 * hands a default import the whole exports object instead of the Effect.
 *
 * @since 0.1.0
 */

import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as Layer from "effect/Layer"
import { initial } from "./internal/migrations/0001_initial.ts"
import { appendOnlyHardening } from "./internal/migrations/0002_append_only_hardening.ts"
import { forwardOnlyIdentity } from "./internal/migrations/0003_forward_only_identity.ts"

/**
 * The plan store's namespaced migration set, for composition with the other
 * storage packages.
 *
 * @category migrations
 * @since 0.1.0
 * @slop
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "plan",
  idOffset: DatabaseMigrations.idBlock * 4,
  migrations: {
    "0001_initial": initial,
    "0002_append_only_hardening": appendOnlyHardening,
    "0003_forward_only_identity": forwardOnlyIdentity
  }
}

/**
 * Creates the plan schema.
 *
 * @category migrations
 * @since 0.1.0
 * @slop
 */
export const run = DatabaseMigrations.run([set])

/**
 * Layer that runs plan migrations before exposing the database to the plan
 * store.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = Layer.effectDiscard(run)
