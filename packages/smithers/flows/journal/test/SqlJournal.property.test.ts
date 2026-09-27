import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as FastCheck from "fast-check"
import { effectProperty } from "../../../../repo-targets/test-utils/effect-property.mjs"
import { type EntriesPage, Journal } from "../src/Journal.ts"
import type { Entry, RunId, Seq, SourceId } from "../src/JournalEvent.ts"
import * as TestJournal from "../src/test/TestJournal.ts"

const prop = effectProperty(it.effect)

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 60_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const seq = (value: number): Seq => value as Seq

describe("SqlJournal paging properties", () => {
  // The paging invariant every follower relies on: walking `entries` page by
  // page — whatever the page size, and wherever the cursor starts — yields
  // exactly the committed sequence, with no entry duplicated or lost at a
  // page boundary, and `hasMore` only ever true on a full page.
  prop(
    "concatenated pages reproduce the full sequence for arbitrary page sizes and cursors",
    [FastCheck.nat({ max: 24 }), FastCheck.integer({ min: 1, max: 7 }), FastCheck.nat({ max: 24 })],
    ([count, limit, startAfter]) =>
      Effect.gen(function*() {
        const journal = yield* Journal
        const run = runId("paging")
        yield* Effect.forEach(
          Array.from({ length: count }, (_, index) => index),
          (index) =>
            journal.emitDurableUnfenced({
              runId: run,
              sourceId: sourceId("producer"),
              eventType: "paging.event",
              payload: { index }
            }),
          { discard: true }
        )

        // One oversized read is the reference sequence.
        const full = yield* journal.entries({ runId: run, limit: count + 1 })
        expect(full.hasMore).toBe(false)
        expect(full.entries.map((entry) => entry.seq)).toEqual(
          Array.from({ length: count }, (_, index) => index)
        )

        // Page through with the generated page size.
        const collected: Array<Entry> = []
        let cursor: number | undefined = undefined
        for (let pages = 0;; pages++) {
          expect(pages).toBeLessThanOrEqual(count + 1)
          const page: EntriesPage = yield* journal.entries({
            runId: run,
            ...(cursor === undefined ? {} : { after: seq(cursor) }),
            limit
          })
          expect(page.entries.length).toBeLessThanOrEqual(limit)
          if (page.hasMore) {
            // A page claiming more must be full — a short page with hasMore
            // would stall a follower.
            expect(page.entries.length).toBe(limit)
          }
          collected.push(...page.entries)
          const last: Entry | undefined = page.entries.at(-1)
          if (!page.hasMore) break
          expect(last).toBeDefined()
          cursor = last!.seq
        }

        expect(collected.map((entry) => entry.seq)).toEqual(
          full.entries.map((entry) => entry.seq)
        )
        expect(collected.map((entry) => entry.eventId)).toEqual(
          full.entries.map((entry) => entry.eventId)
        )
        expect(collected.map((entry) => entry.payload)).toEqual(
          Array.from({ length: count }, (_, index) => ({ index }))
        )

        // An arbitrary cursor reproduces exactly the suffix after it: `after`
        // is exclusive, `after + 1` is included.
        const after = Math.min(startAfter, count)
        const suffix = yield* journal.entries({ runId: run, after: seq(after), limit: count + 1 })
        expect(suffix.hasMore).toBe(false)
        expect(suffix.entries.map((entry) => entry.seq)).toEqual(
          Array.from({ length: Math.max(count - after - 1, 0) }, (_, index) => after + 1 + index)
        )
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped),
    { fastCheck: { ...params, examples: [[0, 1, 0], [6, 3, 2], [7, 3, 7], [1, 7, 0]] } }
  )
})
