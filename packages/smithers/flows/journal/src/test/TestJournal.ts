/**
 * Deterministic bundle of the production journal service.
 *
 * This provides the journal and nothing else. A consumer that also needs run
 * state or the step cache composes `@smthrs/run-store/test/TestRunStore` and
 * `@smthrs/step-cache/test/TestCacheStore` over the same database, or takes
 * the whole engine bundle from `@smthrs/engine-store/test/TestStores`.
 *
 * @since 0.1.0
 */

import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Layer from "effect/Layer"
import * as Migrations from "../Migrations.ts"
import * as SqlJournal from "../SqlJournal.ts"

/**
 * Options for the deterministic journal bundle.
 *
 * The production options with `capacity` and `overflow` made optional. Every
 * field forwards to {@link SqlJournal.layer} unchanged, so a suite can exercise
 * index-bound eviction, the entry byte bound, a custom or noop redactor, and
 * the compaction policy through the bundle instead of hand-assembling the layer
 * stack the bundle exists to hide.
 *
 * The type is derived rather than mirrored because a mirror silently falls
 * behind: the hand-copied list had already lost `maxEntryBytes`, so the one
 * production bound a hostile-payload suite needs was unreachable here.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestJournalOptions extends Omit<SqlJournal.SqlJournalOptions, "capacity" | "overflow"> {
  /** Admission-queue bound and `changes` buffer size. Defaults to 1024. */
  readonly capacity?: number | undefined
  /** Policy applied when the admission queue is full. Defaults to `reject`. */
  readonly overflow?: SqlJournal.SqlJournalOptions["overflow"] | undefined
}

/**
 * Provides the production SQLite journal over an in-memory database.
 * Migrations run before the journal is exposed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options?: TestJournalOptions) =>
  SqlJournal.layer({
    ...options,
    capacity: options?.capacity ?? 1024,
    overflow: options?.overflow ?? "reject"
  }).pipe(Layer.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
