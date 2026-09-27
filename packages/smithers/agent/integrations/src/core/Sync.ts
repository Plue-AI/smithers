/**
 * The provider half of source synchronization.
 *
 * A provider adapter answers one question: what changed after this cursor.
 * The first call passes `null` and receives the initial pages; later calls
 * pass the cursor the previous batch returned. A provider that invalidates a
 * cursor (Google's `410 Gone` on a stale sync token) answers `reset: true`,
 * which tells the driver that the batch is a fresh full listing and anything
 * it does not contain is gone.
 *
 * The driver owns durability: it applies a batch and advances the stored
 * cursor in one transaction, so a crash between them re-reads the batch
 * rather than skipping it, and applying the same batch twice is a no-op.
 *
 * `runSync` is that driver. It reads the stream's committed cursor from the
 * `SourceStore`, asks the adapter for the next page, and hands the page to
 * `SourceStore.commit`, which applies the records, advances the cursor under
 * the key `connectionId:stream`, and, when a `reset` listing completes,
 * tombstones every record of the stream the listing did not contain. It stops
 * when the adapter reports `done` or the page budget runs out; the next run
 * resumes from the committed cursor, including a full listing still in
 * progress. A revoked connection is refused before the adapter is called.
 *
 * @since 1.0.0
 */

import { Effect } from "effect"
import { IntegrationError } from "./IntegrationError.ts"
import type { SourceRecord } from "./SourceRecord.ts"
import { SourceStore } from "./SourceStore.ts"

/**
 * One page of changes.
 *
 * @category models
 * @since 1.0.0
 */
export interface Changes {
  /** Created, edited and deleted records (tombstones), in any order. */
  readonly records: ReadonlyArray<SourceRecord>
  /** The cursor that acknowledges this page, or `null` when the provider issued none. */
  readonly cursor: string | null
  /** Whether this page starts a fresh full listing that replaces earlier state. */
  readonly reset: boolean
  /** Whether no more pages are available right now. */
  readonly done: boolean
}

/**
 * A provider's change feed for one stream of one connection.
 *
 * @category models
 * @since 1.0.0
 */
export interface SyncAdapter {
  /** The provider the records come from. */
  readonly provider: string
  /** The connection the adapter reads through. */
  readonly connectionId: string
  /** The stream within the connection, such as one channel or one repository. */
  readonly stream: string
  /** The changes after `cursor`; `null` asks for the initial listing. */
  readonly changes: (cursor: string | null) => Effect.Effect<Changes, IntegrationError>
}

/**
 * The default number of pages one `runSync` commits.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_MAX_PAGES = 10

/**
 * The largest page budget `runSync` accepts.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_PAGES_LIMIT = 1000

/**
 * What one `runSync` did.
 *
 * @category models
 * @since 1.0.0
 */
export interface Report {
  readonly provider: string
  readonly connectionId: string
  readonly stream: string
  /** Pages committed. */
  readonly pages: number
  readonly inserted: number
  readonly updated: number
  readonly unchanged: number
  /** Deletions the provider reported and the store applied. */
  readonly tombstoned: number
  /** Records a completed full listing did not contain, now tombstones. */
  readonly swept: number
  /** The committed cursor after the last page. */
  readonly cursor: string | null
  /** Whether a page started a fresh full listing. */
  readonly reset: boolean
  /** Whether the adapter reported no more pages; `false` when the page budget ran out first. */
  readonly done: boolean
}

/**
 * What `runSync` needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunOptions {
  readonly adapter: SyncAdapter
  /** Pages to commit before returning, 1 to {@link MAX_PAGES_LIMIT}. Defaults to {@link DEFAULT_MAX_PAGES}. */
  readonly maxPages?: number | undefined
}

/**
 * Pulls an adapter's changes into the `SourceStore`, one committed page at a
 * time.
 *
 * Every page is applied and its cursor advanced in one transaction, so a
 * failure, in the adapter or in the store, leaves the stream at its last
 * committed page and the next run repeats only the page that failed. Records
 * must belong to the adapter's connection and provider; a page carrying
 * anything else is refused before it is written.
 *
 * @category constructors
 * @since 1.0.0
 */
export const runSync = (options: RunOptions): Effect.Effect<Report, IntegrationError, SourceStore> =>
  Effect.gen(function*() {
    const { adapter } = options
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
    const scope = { provider: adapter.provider, connectionId: adapter.connectionId, stream: adapter.stream }
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT) {
      return yield* Effect.fail(
        new IntegrationError(
          "invalid-config",
          `Sync maxPages must be an integer between 1 and ${MAX_PAGES_LIMIT}.`,
          { ...scope, maxPages, retryable: false }
        )
      )
    }
    const store = yield* SourceStore
    if (yield* store.isRevoked(adapter.connectionId)) {
      return yield* Effect.fail(
        new IntegrationError(
          "permission-denied",
          `Connection "${adapter.connectionId}" is revoked, so it is not synchronized.`,
          { ...scope, retryable: false }
        )
      )
    }
    let cursor = yield* store.cursor(adapter.connectionId, adapter.stream)
    let report: Report = {
      ...scope,
      pages: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      tombstoned: 0,
      swept: 0,
      cursor,
      reset: false,
      done: false
    }
    while (report.pages < maxPages && !report.done) {
      const changes = yield* adapter.changes(cursor)
      // A page that promises more but names no position would be asked for
      // again forever. Refused before anything is written.
      if (!changes.done && changes.cursor === null) {
        return yield* Effect.fail(
          new IntegrationError(
            "decode-failed",
            `Sync adapter for "${adapter.connectionId}:${adapter.stream}" reported more pages without a cursor.`,
            { ...scope, retryable: false }
          )
        )
      }
      const committed = yield* store.commit({ ...scope, changes })
      if (changes.cursor !== null) cursor = changes.cursor
      report = {
        ...report,
        pages: report.pages + 1,
        inserted: report.inserted + committed.inserted,
        updated: report.updated + committed.updated,
        unchanged: report.unchanged + committed.unchanged,
        tombstoned: report.tombstoned + committed.tombstoned,
        swept: report.swept + committed.swept,
        cursor,
        reset: report.reset || changes.reset,
        done: changes.done
      }
    }
    return report
  }).pipe(
    Effect.withSpan("Sync.runSync", {
      attributes: {
        "integration.provider": options.adapter.provider,
        "integration.connection": options.adapter.connectionId,
        "integration.stream": options.adapter.stream
      }
    })
  )
