import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as CacheStoreLive from "../src/CacheStore.ts"
import { CacheStore } from "../src/CacheStore.ts"
import * as Migrations from "../src/Migrations.ts"

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | CacheStore>
) =>
  effect.pipe(
    Effect.provide(CacheStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer)
  )

const entry = (overrides: Partial<CacheStoreLive.CacheEntry>): CacheStoreLive.CacheEntry => ({
  keyDigest: "digest-a",
  result: { output: "ok" },
  meta: { source: "recorded" },
  createdAtMs: 10,
  recordedRunId: "run-1",
  recordedEventSeq: 1,
  ...overrides
})

const heads = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<Record<string, unknown>>`
    SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
    FROM flows_step_cache ORDER BY key_digest
  `
})

const ref = (value: CacheStoreLive.CacheEntry): CacheStoreLive.RecordedRef => ({
  keyDigest: value.keyDigest,
  recordedRunId: value.recordedRunId,
  recordedEventSeq: value.recordedEventSeq
})

describe("CacheStore.rebuildHeads", () => {
  it.effect("replaces every head with the admitted ledger rows the candidates name", () =>
    migrated(Effect.gen(function*() {
      const cache = yield* CacheStore
      const first = entry({})
      const other = entry({ keyDigest: "digest-b", result: "other", recordedRunId: "run-2", recordedEventSeq: 4 })
      const foreign = entry({ keyDigest: "digest-c", recordedRunId: "foreign-run", recordedEventSeq: 9 })
      for (const value of [first, other, foreign]) yield* cache.put(value)
      const live = yield* heads

      const restored = yield* CacheStoreLive.rebuildHeads([ref(first), ref(other)])

      expect(restored).toBe(2)
      // The foreign head no candidate names is dropped; the rest are byte-equal.
      expect(yield* heads).toEqual(live.filter((row) => row.key_digest !== "digest-c"))
      expect(Option.isSome(yield* cache.get("digest-c", { recordedBy: { runId: "foreign-run", eventSeq: 9 } })))
        .toBe(true)
    })))

  it.effect("writes the one candidate each key names, whichever ledger row is older", () =>
    migrated(Effect.gen(function*() {
      const cache = yield* CacheStore
      const early = entry({ result: "early", createdAtMs: 5, recordedRunId: "run-a" })
      const late = entry({ result: "late", createdAtMs: 20, recordedRunId: "run-z" })
      for (const value of [early, late]) yield* cache.put(value)

      expect(yield* CacheStoreLive.rebuildHeads([ref(late)])).toBe(1)
      expect((yield* heads).map((row) => row.result_json)).toEqual(["\"late\""])
    })))

  it.effect("refuses two candidates for one key before touching a head", () =>
    migrated(Effect.gen(function*() {
      const cache = yield* CacheStore
      const first = entry({})
      const second = entry({ recordedRunId: "run-2" })
      yield* cache.put(first)
      yield* cache.put(second)
      const live = yield* heads

      const refused = yield* CacheStoreLive.rebuildHeads([ref(first), ref(second)]).pipe(Effect.flip)

      expect(refused.code).toBe("invalid_cache")
      expect(yield* heads).toEqual(live)
    })))

  it.effect("skips a candidate whose ledger row is gone and clears the heads when nothing survives", () =>
    migrated(Effect.gen(function*() {
      const cache = yield* CacheStore
      yield* cache.put(entry({}))

      const restored = yield* CacheStoreLive.rebuildHeads([
        { keyDigest: "digest-a", recordedRunId: "run-1", recordedEventSeq: 99 },
        { keyDigest: "digest-b", recordedRunId: "retained-elsewhere", recordedEventSeq: 1 }
      ])

      expect(restored).toBe(0)
      expect(yield* heads).toEqual([])
    })))

  it.effect("refuses an invalid candidate before touching a head", () =>
    migrated(Effect.gen(function*() {
      const cache = yield* CacheStore
      yield* cache.put(entry({}))

      const refused = yield* CacheStoreLive.rebuildHeads([
        { keyDigest: "", recordedRunId: "run-1", recordedEventSeq: 1 }
      ]).pipe(Effect.flip)
      const negative = yield* CacheStoreLive.rebuildHeads([
        { keyDigest: "digest-a", recordedRunId: "run-1", recordedEventSeq: -1 }
      ]).pipe(Effect.flip)

      expect(refused.code).toBe("invalid_cache")
      expect(negative.code).toBe("invalid_cache")
      expect(yield* heads).toHaveLength(1)
    })))
})
