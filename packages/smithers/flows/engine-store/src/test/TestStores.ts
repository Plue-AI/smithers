/**
 * Deterministic bundle of every durable store a flow engine composes.
 *
 * The stores split into `@smthrs/journal`, `@smthrs/run-store`, and
 * `@smthrs/step-cache`, each with its own in-memory test layer. An engine
 * needs all of them over ONE database, which is what this layer builds:
 * the composed migration sets from `../Migrations.ts` run first, then the four
 * services bind to the same in-memory SQLite connection.
 *
 * Governing design: `packages/smithers/flows/journal/docs/README.md`.
 *
 * @since 0.1.0
 */

import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as DurableEngineState from "../DurableEngineState.ts"
import * as Migrations from "../Migrations.ts"
import * as OwnerIdentity from "../OwnerIdentity.ts"
import * as PlanInputStore from "../PlanInputStore.ts"
import * as PlanMergeStore from "../PlanMergeStore.ts"

/**
 * Options for the deterministic store bundle.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestStoresOptions {
  readonly capacity?: number
  readonly overflow?: "reject" | "drop-newest" | "drop-oldest"
  readonly batchSize?: number
}

/**
 * An in-memory SQLite database with the complete durable engine schema
 * installed, exposed as `SqlClient` and `DurableWriter`.
 *
 * @category layers
 * @since 0.1.0
 */
export const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

/**
 * Provides the production SQLite journal, run, attempt, and cache services
 * over one in-memory database. Migrations run before any durable service is
 * exposed. The shared writer remains exposed for the engine cancellation
 * boundary, which must inspect its complete Exit before error normalization.
 *
 * `OwnerIdentity.layer` rides along: it is not a store, but it is the other
 * service `EngineStore.make` requires and has no in-memory variant to choose
 * between. The default is used rather than a pinned one so a test observes
 * the same fresh-per-incarnation owner the production composition mints.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options?: TestStoresOptions) =>
  Layer.mergeAll(
    SqlJournal.layer({
      capacity: options?.capacity ?? 1024,
      overflow: options?.overflow ?? "reject",
      batchSize: options?.batchSize
    }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    PlanStore.layer,
    PlanInputStore.layer,
    PlanMergeStore.layer,
    Layer.effect(DurableWriter.DurableWriter, DurableWriter.DurableWriter)
  ).pipe(Layer.provide(database), Layer.merge(OwnerIdentity.layer))

/**
 * The same schema over a named SQLite database or PostgreSQL URL, with the connection exposed.
 *
 * {@link database} hides `SqlClient` behind the stores it provisions, which is
 * right for a case that only needs an engine. Two other shapes need the
 * connection itself: a composition that adds another SQL-backed service over
 * the same database (a control runtime, for one), and a case that has to prove
 * cross-process durability, which needs a persistent identity rather than the private
 * in-memory database each `:memory:` connection gets to itself.
 *
 * @category layers
 * @since 0.1.0
 */
export const databaseAt = (filename: string) => {
  const url = /^postgres(?:ql)?:/.test(filename) ? new URL(filename) : undefined
  const schema = url?.searchParams.get("schema") ?? undefined
  url?.searchParams.delete("schema")
  const database = url === undefined ?
    NodeDatabase.layer({ filename }) :
    Layer.unwrap(
      Effect.promise(() => import("@smthrs/database/postgres/PostgresDatabase")).pipe(
        Effect.map((PostgresDatabase) =>
          PostgresDatabase.layer({
            url: url.toString(),
            schema,
            postgres: { connectTimeout: Infinity, idleTimeout: Infinity, connectionTTL: Infinity }
          })
        )
      )
    )
  return Layer.provideMerge(Migrations.layer, Layer.provideMerge(DurableWriter.layer(), database))
}

/**
 * Every durable engine service over one named database, connection included.
 *
 * `layer` builds the same stores over a private in-memory database and keeps
 * `SqlClient` to itself. This one takes the database by name and re-exports
 * the connection, so a case can point two independently constructed bundles at
 * one file — two connections, two engines, no shared object graph — which is
 * what a second process actually looks like. `DurableEngineState` rides along
 * for the same reason: its in-memory variant is a map that a second bundle
 * would not see.
 *
 * Pass `:memory:` for the cheap variant when the connection is still needed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerAt = (filename: string, options?: TestStoresOptions) =>
  Layer.mergeAll(
    SqlJournal.layer({
      capacity: options?.capacity ?? 1024,
      overflow: options?.overflow ?? "reject",
      batchSize: options?.batchSize
    }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    PlanStore.layer,
    PlanInputStore.layer,
    PlanMergeStore.layer,
    DurableEngineState.layer
  ).pipe(Layer.provideMerge(databaseAt(filename)), Layer.merge(OwnerIdentity.layer))
