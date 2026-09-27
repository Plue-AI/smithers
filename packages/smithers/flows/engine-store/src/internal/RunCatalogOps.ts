/**
 * The workspace run catalog read.
 *
 * `@smthrs/sync` serves a workspace subscription over a `RunCatalog`, and
 * every implementation of that service was static (`layerStatic`,
 * `layerNoop`) or in-process (`makeMemory`, which hears only about runs the
 * same process registered). A follower composed against any of them saw the
 * runs that existed when it started and never learned of another run, so a
 * second engine writing to the same workspace was invisible to it. This
 * module is the durable half of the fix: the read that says which runs the
 * workspace has right now, taken from `flows_runs` itself.
 *
 * The read is a full set rather than a cursor tail, for one reason: retention
 * deletes runs. A follower that only ever appended what appeared after a
 * cursor would keep every collected run in its view forever and hold a
 * journal stream open for each one. Reading the set makes both directions
 * work, and the workspace's own bound keeps the cost of it flat.
 *
 * Nothing here polls. The interval belongs to the catalog that consumes this
 * read (`RunCatalog.makePolling` in `@smthrs/sync`), so the durable side has
 * no policy and no fiber of its own.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as RunListing from "./RunListing.ts"
import { RunCatalogError } from "./RunListingError.ts"

/**
 * Stable error codes returned by the catalog read.
 *
 * @category models
 * @since 0.1.0
 */
export { RunCatalogErrorCode } from "./RunListingError.ts"

/**
 * A catalog read that could not complete.
 *
 * `list_failed` means the workspace's run set could not be read. The caller
 * keeps whatever view it already had; the read is idempotent, so the next one
 * converges once the cause is fixed.
 *
 * @category errors
 * @since 0.1.0
 */
export { RunCatalogError } from "./RunListingError.ts"

/**
 * Options for one catalog read.
 *
 * @category models
 * @since 0.1.0
 */
export interface ListOptions {
  /**
   * Largest number of runs the read returns. Defaults to
   * {@link defaultLimit}. A workspace with more runs than the bound is
   * followed by its most recent ones; an older run stays readable through a
   * run-scoped subscription, which names it directly.
   */
  readonly limit?: number | undefined
}

/**
 * The workspace's run set.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /** Revision-consistent, filtered keyset page of execution rows. */
  readonly listRuns: RunListing.Service["listRuns"]
  /**
   * Every run the workspace has, oldest first, bounded by the read. "Oldest"
   * is the run table's own row order, which is the order `RunStore.create`
   * inserted them: SQLite hands a new row an identifier above every one in
   * the table, and reuses one only after the highest is deleted, so deletion
   * by retention does not reorder what is left.
   */
  readonly listRunIds: (options?: ListOptions) => Effect.Effect<ReadonlyArray<string>, RunCatalogError>
}

/**
 * Service tag for the workspace run catalog read.
 *
 * @category services
 * @since 0.1.0
 */
export class RunCatalogRead extends Context.Service<RunCatalogRead, Service>()(
  "@smthrs/engine-store/RunCatalogRead"
) {}

/**
 * Runs one read returns when the caller names no bound. Large enough that an
 * ordinary workspace is returned whole, small enough that a workspace which
 * has never been collected does not hand a follower an unbounded list.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultLimit = 10_000

/**
 * Builds the catalog read over the composition's own run table.
 *
 * The read goes to `flows_runs` directly, the way `DurableEngineState`,
 * `ArtifactGc`, and `RetentionOps` do: this package composes the run-store
 * migrations, so the schema is its own.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (): Effect.Effect<Service, never, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const listing = yield* RunListing.make()

    // Newest first by `rowid`, then reversed. `rowid` is the order the
    // workspace gained its runs, and reading it backwards walks the table's
    // own b-tree, so the bound costs one seek rather than a sort of every
    // run: `flows_runs` carries no index on `created_at_ms`, and two runs
    // created in the same millisecond do not order by it at all.
    //
    // `flows_runs` has a TEXT primary key, so its `rowid` is not an alias of
    // a declared column and SQLite documents that a rebuild may reassign it.
    // The order the rebuild leaves is what this read depends on, not the
    // numbers, and `VACUUM INTO` — the hot backup this release ships, and the
    // only rebuild in the supported path (the release policy) — preserves
    // it. `RunCatalogCatchUp.test.ts` pins that across a real backup and
    // reopen, including after retention has deleted rows out of the middle
    // and the end.
    const listRunIds: Service["listRunIds"] = Effect.fn("RunCatalog.listRunIds")((options?: ListOptions) =>
      Effect.gen(function*() {
        const limit = options?.limit ?? defaultLimit
        if (!Number.isSafeInteger(limit) || limit < 0) {
          return yield* Effect.fail(
            new RunCatalogError({
              code: "invalid_options",
              message: "the run catalog limit must be a non-negative safe integer"
            })
          )
        }
        return yield* sql<{ readonly run_id: string }>`
          SELECT run_id FROM flows_runs
          ORDER BY rowid DESC
          LIMIT ${limit}
        `.pipe(
          Effect.map((rows) => rows.map((row) => row.run_id).reverse()),
          Effect.mapError((cause) =>
            new RunCatalogError({
              code: "list_failed",
              message: "the workspace run set could not be read",
              cause
            })
          )
        )
      })
    )

    return { listRunIds, ...listing }
  })

/**
 * Provides the workspace run catalog read.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<RunCatalogRead, never, SqlClient.SqlClient> = Layer.effect(RunCatalogRead)(make())
