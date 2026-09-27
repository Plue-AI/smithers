/**
 * Read-only validation of a journal record another lineage recorded under
 * this run's producer identity.
 *
 * A time-travel fork copies the parent's journal rows verbatim: the copied
 * record keeps the producer identity, but its payload names the parent run and
 * its `meta.lineageId` is the parent's lineage, so this run's re-emission of
 * the same record raises `idempotency_conflict` instead of collapsing into a
 * `Duplicate`. That conflict is benign ONLY when the occupying record is the
 * record being emitted, recorded by a validated ancestor. Anything else in the
 * slot — an unrelated event type, another attempt's coordinates, the opposite
 * terminal state, a record with no retained fork ancestry — is the conflict
 * the journal reported, and it fails closed.
 * @since 1.0.0-rc.0
 */

import { canonicalize, isRecord } from "@smthrs/canonical"
import { FlowEngine } from "@smthrs/engine"
import { Journal, JournalEvent } from "@smthrs/journal"
import type { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"

/** Paged lookup retains only the matching record, including unexpected event types.
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const find = (
  journal: Journal.Service,
  runId: string,
  predicate: (entry: JournalEvent.Entry) => boolean
): Effect.Effect<JournalEvent.Entry | undefined, Journal.JournalError> =>
  Effect.gen(function*() {
    let after: JournalEvent.Seq | undefined
    while (true) {
      const page = yield* journal.entries({
        runId: JournalEvent.RunId.make(runId),
        limit: 128,
        ...after === undefined ? {} : { after }
      })
      const entry = page.entries.find(predicate)
      if (entry !== undefined) return entry
      if (!page.hasMore) return undefined
      const next = page.entries.at(-1)?.seq
      if (next === undefined || (after !== undefined && next <= after)) {
        return yield* Effect.fail(
          new Journal.JournalError({ code: "read_failed", message: "cache history cursor did not advance" })
        )
      }
      after = next
    }
  })

const sameJson = (left: unknown, right: unknown): boolean =>
  left === undefined || right === undefined
    ? left === right
    : canonicalize(left, { loneSurrogates: "escape" }) === canonicalize(right, { loneSurrogates: "escape" })

/** The record as the named ancestor would have emitted it: the payload's own
 * `runId` and the lineage in `meta` name that run instead of this one. */
const asEmittedBy = (record: JournalEvent.Input, runId: string, ancestor: string) => ({
  payload: isRecord(record.payload) && record.payload["runId"] === runId
    ? { ...record.payload, runId: ancestor }
    : record.payload,
  meta: isRecord(record.meta) ? { ...record.meta, lineageId: FlowEngine.Lineage.root(ancestor) } : record.meta
})

/**
 * Proves every retained fork prefix between a copied entry and its original.
 * Callers retain their payload and metadata equality rules.
 * @category accessors
 * @since 1.0.0
 */
export const prove = (options: {
  readonly journal: Journal.Service
  readonly runs: RunStore.Service
  readonly runId: string
  readonly entry: JournalEvent.Entry
  readonly conflict: Journal.JournalError
  readonly same?: (left: unknown, right: unknown) => boolean
}) =>
  Effect.gen(function*() {
    const { conflict, journal, runs, same = sameJson } = options
    let entry = options.entry
    const source = (candidate: JournalEvent.Entry) =>
      candidate.sourceId === options.entry.sourceId && candidate.sourceSeq === options.entry.sourceSeq
    let child = options.runId
    const visited = new Set<string>()
    while (!visited.has(child)) {
      visited.add(child)
      const run = yield* runs.get(child).pipe(Effect.mapError((cause) =>
        new Journal.JournalError({
          code: "idempotency_conflict",
          message: conflict.message,
          cause
        })
      ))
      const parent = run.parentRunId
      if (parent === null) return yield* Effect.fail(conflict)
      const copied = entry
      const marker = yield* find(journal, child, (candidate) => {
        const value = candidate.payload as {
          readonly childRunId?: unknown
          readonly parentRunId?: unknown
          readonly forkJournalOffset?: unknown
        } | null
        return candidate.eventType === "flows.time-travel.fork-created" &&
          candidate.sourceId === "flows/time-travel/fork" && Number(candidate.sourceSeq) === candidate.seq &&
          value?.childRunId === child &&
          value.parentRunId === parent && typeof value.forkJournalOffset === "number" &&
          Number.isSafeInteger(value.forkJournalOffset) && value.forkJournalOffset >= copied.seq &&
          candidate.seq === value.forkJournalOffset + 1 &&
          same(value, { childRunId: child, parentRunId: parent, forkJournalOffset: value.forkJournalOffset })
      })
      if (marker === undefined) return yield* Effect.fail(conflict)
      const cutoff = yield* find(journal, parent, (candidate) => candidate.seq === marker.seq - 1)
      if (
        cutoff === undefined ||
        !same(marker.meta, { lineageId: (cutoff.meta as { lineageId?: unknown } | null)?.lineageId })
      ) {
        return yield* Effect.fail(conflict)
      }
      const original = yield* find(journal, parent, source)
      if (
        original === undefined || original.seq !== copied.seq || original.emittedAtMs !== copied.emittedAtMs ||
        original.eventType !== copied.eventType || !same(original.payload, copied.payload) ||
        !same(original.meta, copied.meta)
      ) return yield* Effect.fail(conflict)
      if (isRecord(original.meta) && original.meta["lineageId"] === FlowEngine.Lineage.root(parent)) {
        return { ancestor: parent, record: original }
      }
      child = parent
      entry = original
    }
    return yield* Effect.fail(conflict)
  })

/**
 * Accepts the occupying record only when it is `record` as a validated
 * copied-lineage ancestor emitted it; otherwise fails with `conflict`.
 *
 * The shared ancestry proof requires, at each hop, the child's fork marker above the copied prefix, the parent row the
 * marker was cut at, and the parent's own copy of the record at the same
 * `seq`, identical in content. The walk ends at the run whose lineage the
 * record carries, and that run's original must be the record being emitted
 * under that run's identity: same event type, same payload with the ancestor
 * in place of this run, same meta.
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const accept = (options: {
  readonly journal: Journal.Service
  readonly runs: RunStore.Service
  readonly runId: string
  readonly record: JournalEvent.Input
  readonly conflict: Journal.JournalError
}): Effect.Effect<void, Journal.JournalError> =>
  Effect.gen(function*() {
    const { conflict, journal, record } = options
    const sourceSeq = record.sourceSeq ?? 0
    const source = (entry: JournalEvent.Entry) =>
      entry.sourceId === record.sourceId && Number(entry.sourceSeq) === Number(sourceSeq)
    const entry = yield* find(journal, options.runId, source)
    if (entry === undefined || entry.eventType !== record.eventType) return yield* Effect.fail(conflict)
    const original = yield* prove({ ...options, entry })
    const expected = asEmittedBy(record, options.runId, original.ancestor)
    return sameJson(original.record.payload, expected.payload) && sameJson(original.record.meta, expected.meta)
      ? undefined
      : yield* Effect.fail(conflict)
  })
