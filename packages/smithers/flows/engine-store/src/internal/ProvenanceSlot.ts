/**
 * Read-only validation of the cache-provenance record occupying a producer
 * slot this run re-emits into.
 *
 * A provenance producer identity (`cache:<digest>:<action>[:<run>:<seq>]`,
 * `sourceSeq` 0) names ONE fact about one cache row — this key expired, this
 * row was served, this replay failed — so a re-emission after a resume or in
 * a fork child records the same fact with fresh measurements (`ageMs`, the
 * clock, a later `reason`) and collapses onto the row already there. That
 * collapse is legitimate only while the occupying record IS that fact: the
 * same event type, the same key, the same action, and the same recorded row
 * when the record names one. Anything else in the slot is the conflict the
 * journal reported.
 * @since 1.0.0-rc.0
 */

import type { Journal, JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as CacheAgeHistory from "./CacheAgeHistory.ts"

const identity = ["keyDigest", "action", "recordedRunId", "recordedEventSeq"] as const

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Accepts the occupying record only when it states the same provenance fact
 * as `record`; otherwise fails with `conflict`.
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const accept = (options: {
  readonly journal: Journal.Service
  readonly runId: string
  readonly record: JournalEvent.Input
  readonly conflict: Journal.JournalError
}): Effect.Effect<void, Journal.JournalError> =>
  Effect.gen(function*() {
    const { conflict, journal, record } = options
    const sourceSeq = record.sourceSeq ?? 0
    const entry = yield* CacheAgeHistory.find(
      journal,
      options.runId,
      (candidate) => candidate.sourceId === record.sourceId && Number(candidate.sourceSeq) === Number(sourceSeq)
    )
    if (entry === undefined || entry.eventType !== record.eventType) return yield* Effect.fail(conflict)
    const attempted = record.payload
    const occupying = entry.payload
    if (!isRecord(attempted) || !isRecord(occupying)) return yield* Effect.fail(conflict)
    const same = identity.every((field) => !(field in attempted) || attempted[field] === occupying[field])
    return same ? undefined : yield* Effect.fail(conflict)
  })
