/**
 * Deterministic bundle of the production run and attempt services.
 *
 * @since 0.1.0
 */

import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Layer from "effect/Layer"
import * as AttemptStore from "../AttemptStore.ts"
import * as Migrations from "../Migrations.ts"
import * as RunStore from "../RunStore.ts"

/**
 * Provides the production SQLite run and attempt stores over an in-memory
 * database. Migrations run before either service is exposed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.mergeAll(RunStore.layer, AttemptStore.layer).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)
