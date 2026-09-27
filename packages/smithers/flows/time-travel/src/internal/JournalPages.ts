/**
 * The one journal paging loop every time-travel read drives.
 *
 * Replay, the snapshot projector, fork, and both rewind scans page
 * `journal.entries` the same way, and each used to carry its own copy of the
 * cursor bookkeeping and its own idea of what a malformed page means. The
 * copies drifted: the destructive rewind reads refused a page that claims
 * more and delivers nothing, while the fork's copy took it for the end of
 * history and committed a child whose disclosed effects were incomplete.
 *
 * FAIL CLOSED, once, here. A page that claims `hasMore` and delivers no
 * entries is `invalid`; so is a page whose highest seq does not move the
 * cursor forward, which is the shape a journal double that ignores `after`
 * produces and would otherwise spin forever. A page without `hasMore` ends
 * the read whatever it holds.
 *
 * @since 0.1.0
 */

import type * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import { error, type TimeTravelError } from "../TimeTravelError.ts"

/**
 * What {@link forEachPage} returns from a page callback to end the read
 * before the journal does: replay past its frame, the projector past its
 * bound.
 *
 * @since 0.1.0
 * @category models
 */
export const Stop: unique symbol = Symbol.for("@smthrs/time-travel/JournalPages/Stop")

/**
 * The type of {@link Stop}.
 *
 * @since 0.1.0
 * @category models
 */
export type Stop = typeof Stop

/**
 * Where a paged read starts, how wide its pages are, and how it names itself
 * in the failures it raises.
 *
 * @since 0.1.0
 * @category models
 */
export interface PageOptions {
  readonly runId: string
  /** The seq the read starts after; absent reads from the first record. */
  readonly after?: number | undefined
  readonly pageSize: number
  /** Passed through to the journal; a double may ignore it. */
  readonly eventTypes?: ReadonlyArray<string> | undefined
  /**
   * Names the read in its `invalid` failures: `${label} returned an empty
   * continuation page for ${runId}` and `${label} pagination did not advance
   * for ${runId}`.
   */
  readonly label: string
  /** The message a failed journal read is reported under, as `unknown`. */
  readonly readFailure: string
}

/**
 * Pages a run's journal from `options.after` until the journal reports no
 * more, `onPage` returns {@link Stop}, or a page is malformed.
 *
 * `onPage` sees each page's entries exactly as the journal delivered them;
 * the cursor for the next page is the highest seq the page held, so a caller
 * that sorts or deduplicates within a page never disagrees with the cursor.
 *
 * @since 0.1.0
 * @category constructors
 */
export const forEachPage = <E>(
  journal: Journal.Service,
  options: PageOptions,
  onPage: (entries: ReadonlyArray<JournalEvent.Entry>) => Effect.Effect<void | Stop, E>
): Effect.Effect<void, E | TimeTravelError> =>
  Effect.gen(function*() {
    let after = options.after
    while (true) {
      const page = yield* journal.entries({
        runId: options.runId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after: after as JournalEvent.Seq }),
        ...(options.eventTypes === undefined ? {} : { eventTypes: options.eventTypes }),
        limit: options.pageSize
      }).pipe(Effect.mapError((cause) => error("unknown", options.readFailure, cause)))
      if ((yield* onPage(page.entries)) === Stop) return
      if (!page.hasMore) return
      if (page.entries.length === 0) {
        return yield* Effect.fail(
          error("invalid", `${options.label} returned an empty continuation page for ${options.runId}`)
        )
      }
      const previous = after ?? -1
      const next = page.entries.reduce((tail, entry) => entry.seq > tail ? entry.seq : tail, previous)
      if (next <= previous) {
        return yield* Effect.fail(
          error("invalid", `${options.label} pagination did not advance for ${options.runId}`)
        )
      }
      after = next
    }
  })
