/**
 * Step cache schema migrations.
 *
 * This package owns two tables and nothing else: the mutable `flows_step_cache`
 * head and the append-only `flows_step_cache_recorded` provenance ledger. It
 * reserves migration id block `2000` so its ids can never collide with the
 * journal's or the run store's — see `@smthrs/database`'s `Migrations` for how
 * the blocks compose.
 *
 * See the {@link https://smithers.sh/docs/concepts/content-addressing | step-key contract}
 * and {@link https://smithers.sh/docs/concepts/durable-execution | journal architecture}.
 *
 * @since 0.1.0
 */

import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as Layer from "effect/Layer"
import { initial } from "./migrations/0001_initial.ts"
import { createdAtIndex } from "./migrations/0002_created_at_index.ts"

/**
 * The step cache's namespaced migration set, for composition with the other
 * storage packages.
 *
 * @category migrations
 * @since 0.1.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "step-cache",
  idOffset: DatabaseMigrations.idBlock * 2,
  // The earlier RC created the same two single-column age indexes under
  // *_created_at_idx names. Preserve its recorded identity and cached receipts.
  previousNames: { "0002_created_at_index": ["sweep_indexes"] },
  migrations: {
    "0001_initial": initial,
    "0002_created_at_index": createdAtIndex
  }
}

/**
 * Creates the step cache schema.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run([set])

/**
 * Layer that runs step-cache migrations before exposing the database to the
 * cache service.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
