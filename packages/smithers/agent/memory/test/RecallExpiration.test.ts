import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Fts from "../src/RecallFts.ts"
import * as Keyword from "../src/RecallKeyword.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

describe("recall of expiring facts", () => {
  it("hides a fact at its TTL boundary before GC and restores recall after a fresh write", async () => {
    const snapshots = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const input = { banks: ["flow-expiring"], query: "durable" }
        yield* TestClock.setTime(0)
        yield* store.enableFts("flow")
        yield* store.putFact({
          namespace: "flow-expiring",
          key: "runbook",
          value: "durable first version",
          ttlMs: 5,
          provenance: {}
        })
        const before = [yield* Keyword.recall(input), yield* Fts.recall(input)]
        yield* TestClock.adjust("4 millis")
        const justBeforeExpiry = [yield* Keyword.recall(input), yield* Fts.recall(input)]
        yield* TestClock.adjust("1 millis")
        const expired = [yield* Keyword.recall(input), yield* Fts.recall(input)]
        yield* store.putFact({
          namespace: "flow-expiring",
          key: "runbook",
          value: "durable revised version",
          ttlMs: 5,
          provenance: {}
        })
        const renewed = [yield* Keyword.recall(input), yield* Fts.recall(input)]
        yield* TestClock.adjust("4 millis")
        const justBeforeRenewedExpiry = [yield* Keyword.recall(input), yield* Fts.recall(input)]
        yield* TestClock.adjust("1 millis")
        const expiredAgain = [yield* Keyword.recall(input), yield* Fts.recall(input)]
        return { before, justBeforeExpiry, expired, renewed, justBeforeRenewedExpiry, expiredAgain }
      }).pipe(Effect.provide(TestMemory.layer), Effect.provide(TestClock.layer()))
    )
    for (const rows of snapshots.before) {
      expect(rows.map(({ key, text }) => [key, text])).toEqual([["runbook", "durable first version"]])
    }
    for (const rows of snapshots.justBeforeExpiry) {
      expect(rows.map(({ key, text }) => [key, text])).toEqual([["runbook", "durable first version"]])
    }
    expect(snapshots.expired).toEqual([[], []])
    for (const rows of snapshots.renewed) {
      expect(rows.map(({ key, text }) => [key, text])).toEqual([["runbook", "durable revised version"]])
    }
    for (const rows of snapshots.justBeforeRenewedExpiry) {
      expect(rows.map(({ key, text }) => [key, text])).toEqual([["runbook", "durable revised version"]])
    }
    expect(snapshots.expiredAgain).toEqual([[], []])
  })
})
