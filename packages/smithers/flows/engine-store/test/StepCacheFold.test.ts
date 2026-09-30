/**
 * Issue #2053: `flows_step_cache` heads are a fold of the journal. Each cell
 * drives the real engine, snapshots the live heads, drops them, rebuilds them
 * from the journal, and requires byte-equal rows, or no row where the journal
 * cannot prove which one the store held.
 */
import { describe, expect, it } from "@effect/vitest"
import type { FileInput } from "@smthrs/flow/FileInput"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as HashSet from "effect/HashSet"
import * as Layer from "effect/Layer"
import * as TestClock from "effect/testing/TestClock"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepCacheFold from "../src/StepCacheFold.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "fold-host", pid: 53, nonce: "fold-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "fold-snapshot" as never, changeId: "fold-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const exact = StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) })

/** A boundary that measures `measurements` in turn and then repeats the last one. */
const measuring = (...measurements: Array<ReadonlyArray<FileInput>>) =>
  Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.make({
      prepare: (descriptor) =>
        Effect.sync(() => ({
          descriptor,
          readSnapshot: measurements.length > 1 ? measurements.shift()! : measurements[0]!
        })),
      settle: (prepared) =>
        Effect.succeed({
          declaredOutputs: { paths: prepared.descriptor.writeSet },
          diffIdentity: "fold-diff",
          wholeTreeWritesVerified: true,
          hermeticReadsVerified: true
        }),
      replayOutputs: () => Effect.void
    })
  )

const unchanged: ReadonlyArray<FileInput> = declared.readSet as never
const changed: ReadonlyArray<FileInput> = [{ path: "config.json", digest: "D2" }] as never

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

interface Dispatch {
  readonly runId: string
  readonly key: string
  readonly result: string
  readonly attempt?: number
  readonly nondeterministic?: boolean
  readonly missFirst?: boolean
}

/** A cache whose first lookup misses, modelling a racer that landed the row after this dispatch looked. */
const missingOnce = (cache: CacheStore.Service): CacheStore.Service => {
  let reads = 0
  return CacheStore.makeNoop({
    ...cache,
    get: (keyDigest, options) => (++reads === 1 ? Effect.succeedNone : cache.get(keyDigest, options))
  })
}

const dispatch = (options: Dispatch) =>
  Effect.gen(function*() {
    const cache = yield* CacheStore.CacheStore
    const run = ActionPersistence.make({
      runId: options.runId,
      owner,
      sourceId: `fold-${options.runId}`,
      execute: () => Effect.succeed(options.result)
    })({
      action: {},
      attempt: options.attempt ?? 1,
      key: options.key,
      tier: "sealed",
      metadata: declared,
      ...(options.nondeterministic === true ? { nondeterministic: true } : {})
    })
    return yield* options.missFirst === true
      ? Effect.provideService(run, CacheStore.CacheStore, missingOnce(cache))
      : run
  })

const heads = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<Record<string, unknown>>`
    SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
    FROM flows_step_cache ORDER BY key_digest
  `
})

/** Snapshots the live heads, drops them, rebuilds them from the journal, and reads them back. */
const dropAndRebuild = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const live = yield* heads
  yield* sql`DELETE FROM flows_step_cache`
  const rebuilt = yield* StepCacheFold.rebuild()
  return { live, rebuilt, restored: yield* heads }
})

const services = Layer.merge(TestStores.layerAt(":memory:"), jj)

const setup = Layer.merge(services, exact)

describe("StepCacheFold.rebuild", () => {
  it.effect("restores inserted heads byte for byte and never a duplicate", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("fold-insert")
        yield* activate("fold-duplicate")
        yield* dispatch({ runId: "fold-insert", key: "fold/insert", result: "one" })
        yield* dispatch({ runId: "fold-insert", key: "fold/other", result: "two" })
        // A replay of the same attempt re-records nothing new.
        yield* dispatch({ runId: "fold-insert", key: "fold/insert", result: "one" })
        // A later run that raced past the head records the same bytes: `ExistingSame`.
        yield* TestClock.adjust(1_000)
        yield* dispatch({ runId: "fold-duplicate", key: "fold/insert", result: "one", missFirst: true })

        const { live, rebuilt, restored } = yield* dropAndRebuild

        expect(live).toHaveLength(2)
        expect(restored).toEqual(live)
        expect(rebuilt).toEqual({ runs: 2, compacted: 0, rewound: 0, admitted: 2, retired: 0, heads: 2 })
      }).pipe(Effect.provide(setup), Effect.scoped)
    ))

  it.effect("keeps the first writer over an older duplicate", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("fold-first")
        yield* activate("fold-older")
        yield* TestClock.setTime(2_000)
        yield* dispatch({ runId: "fold-first", key: "fold/order", result: "same" })
        // The duplicate's completion time is earlier, but it committed second.
        yield* TestClock.setTime(1_000)
        yield* dispatch({ runId: "fold-older", key: "fold/order", result: "same", missFirst: true })

        const { live, restored } = yield* dropAndRebuild

        expect(live[0]!.recorded_run_id).toBe("fold-first")
        expect(restored).toEqual(live)
      }).pipe(Effect.provide(setup), Effect.scoped)
    ))

  it.effect("keeps the first writer when a declared-nondeterministic loser records under the key", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("z-winner")
        yield* activate("a-loser")
        yield* dispatch({ runId: "z-winner", key: "fold/nondeterministic", result: "first", nondeterministic: true })
        yield* dispatch({
          runId: "a-loser",
          key: "fold/nondeterministic",
          result: "second",
          nondeterministic: true,
          missFirst: true
        })

        const { live, rebuilt, restored } = yield* dropAndRebuild

        expect(live).toHaveLength(1)
        expect(live[0]!.recorded_run_id).toBe("z-winner")
        expect(restored).toEqual(live)
        expect(rebuilt.admitted).toBe(1)
      }).pipe(Effect.provide(setup), Effect.scoped)
    ))

  it.effect("keeps the first writer when a tolerated conflict names the attempted row", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("z-strict-winner")
        yield* activate("a-strict-loser")
        yield* dispatch({ runId: "z-strict-winner", key: "fold/conflict", result: "first" })
        yield* dispatch({ runId: "a-strict-loser", key: "fold/conflict", result: "second", missFirst: true })

        const { live, rebuilt, restored } = yield* dropAndRebuild

        expect(live[0]!.recorded_run_id).toBe("z-strict-winner")
        expect(restored).toEqual(live)
        expect(rebuilt.admitted).toBe(1)
      }).pipe(
        Effect.provide(Layer.provideMerge(Inconsistency.layerTolerant(owner), setup)),
        Effect.scoped
      )
    ))

  it.effect("keeps the first writer over an older loser whose conflict was never journalled", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("fold-winner")
        yield* activate("fold-unjournalled")
        yield* TestClock.setTime(2_000)
        yield* dispatch({ runId: "fold-winner", key: "fold/unjournalled", result: "first" })
        yield* TestClock.setTime(1_000)
        // This receiver tolerates without journalling, as a crash after the recording would.
        yield* dispatch({ runId: "fold-unjournalled", key: "fold/unjournalled", result: "second", missFirst: true })

        const { live, restored } = yield* dropAndRebuild

        expect(live[0]!.recorded_run_id).toBe("fold-winner")
        expect(restored).toEqual(live)
      }).pipe(Effect.provide(Layer.merge(setup, Inconsistency.layerNoop())), Effect.scoped)
    ))

  it.effect("does not restore a row the journal evicted, and restores its replacement", () =>
    withCrypto(
      Effect.gen(function*() {
        const flapping = measuring(unchanged, changed, unchanged)
        yield* activate("fold-evict")
        yield* dispatch({ runId: "fold-evict", key: "fold/evict", result: "stale" }).pipe(Effect.provide(flapping))
        // The hit measures a changed read set: `stale_read_set`, fenced evict, re-record.
        yield* dispatch({ runId: "fold-evict", key: "fold/evict", result: "fresh", attempt: 2 }).pipe(
          Effect.provide(flapping)
        )

        const { live, rebuilt, restored } = yield* dropAndRebuild

        expect(live[0]!.result_json).toBe("\"fresh\"")
        expect(restored).toEqual(live)
        expect(rebuilt).toEqual({ runs: 1, compacted: 0, rewound: 0, admitted: 2, retired: 1, heads: 1 })
      }).pipe(Effect.provide(services), Effect.scoped)
    ))

  it.effect("does not promote a duplicate when another run evicts the head", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("fold-head")
        yield* activate("fold-copy")
        yield* activate("fold-evictor")
        yield* dispatch({ runId: "fold-head", key: "fold/promote", result: "old" }).pipe(Effect.provide(exact))
        yield* TestClock.adjust(1_000)
        yield* dispatch({ runId: "fold-copy", key: "fold/promote", result: "old", missFirst: true }).pipe(
          Effect.provide(exact)
        )
        yield* TestClock.adjust(1_000)
        yield* dispatch({ runId: "fold-evictor", key: "fold/promote", result: "new" }).pipe(
          Effect.provide(measuring(changed, unchanged))
        )

        const { live, restored } = yield* dropAndRebuild

        expect(live[0]!.recorded_run_id).toBe("fold-evictor")
        expect(restored).toEqual(live)
      }).pipe(Effect.provide(services), Effect.scoped)
    ))

  it.effect("writes no head for a key whose earlier admission left without a journal entry", () =>
    withCrypto(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("fold-swept")
        yield* activate("fold-after-sweep")
        yield* dispatch({ runId: "fold-swept", key: "fold/swept", result: "first" })
        yield* TestClock.adjust(10_000)
        expect(yield* cache.sweepExpired(5_000)).toBe(1)
        yield* dispatch({ runId: "fold-after-sweep", key: "fold/swept", result: "second" })

        const { live, rebuilt, restored } = yield* dropAndRebuild

        expect(live[0]!.recorded_run_id).toBe("fold-after-sweep")
        // Both admissions survive the fold and the journal cannot order them: a miss.
        expect(restored).toEqual([])
        expect(rebuilt).toMatchObject({ admitted: 2, retired: 0, heads: 0 })
      }).pipe(Effect.provide(setup), Effect.scoped)
    ))

  it.effect("drops a head no journal entry records", () =>
    withCrypto(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("fold-local")
        yield* dispatch({ runId: "fold-local", key: "fold/local", result: "local" })
        // A shared-tier write-back lands a foreign head with no local entry.
        yield* cache.put({
          keyDigest: sha256("fold/foreign"),
          result: "foreign",
          meta: {},
          createdAtMs: 1,
          recordedRunId: "foreign-run",
          recordedEventSeq: 3
        })

        const { live, restored } = yield* dropAndRebuild

        expect(live).toHaveLength(2)
        expect(restored).toEqual(live.filter((row) => row.recorded_run_id === "fold-local"))
      }).pipe(Effect.provide(setup), Effect.scoped)
    ))

  it.effect("writes no heads once a run that evicted a head is compacted", () =>
    withCrypto(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* activate("fold-recorder")
        yield* activate("fold-compacted")
        yield* dispatch({ runId: "fold-recorder", key: "fold/compacted", result: "stale" }).pipe(
          Effect.provide(exact)
        )
        yield* dispatch({ runId: "fold-compacted", key: "fold/compacted", result: "fresh" }).pipe(
          Effect.provide(measuring(changed, unchanged))
        )
        // Compact the evicting run through its last entry: its `stale_read_set` is gone.
        const runId = "fold-compacted" as JournalEvent.RunId
        const seq = (yield* journal.entries({ runId, limit: 1_000 })).entries.at(-1)!.seq
        yield* journal.checkpoint({ runId, seq, state: {} }, owner)
        yield* journal.compact({ runId, upTo: seq }, owner)

        const { live, rebuilt, restored } = yield* dropAndRebuild

        expect(live[0]!.result_json).toBe("\"fresh\"")
        expect(restored).toEqual([])
        expect(rebuilt).toEqual({ runs: 2, compacted: 1, rewound: 0, admitted: 0, retired: 0, heads: 0 })
      }).pipe(Effect.provide(services), Effect.scoped)
    ))

  it.effect("writes no heads once a rewind drops the eviction of a head", () =>
    withCrypto(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const journal = yield* Journal.Journal
        const flapping = measuring(unchanged, changed, unchanged)
        yield* activate("fold-rewound")
        yield* dispatch({ runId: "fold-rewound", key: "fold/rewound", result: "stale" }).pipe(Effect.provide(flapping))
        const runId = "fold-rewound" as JournalEvent.RunId
        const frame = (yield* journal.entries({ runId, limit: 1_000 })).entries.at(-1)!.seq
        yield* dispatch({ runId: "fold-rewound", key: "fold/rewound", result: "fresh", attempt: 2 }).pipe(
          Effect.provide(flapping)
        )
        // A time-travel rewind to the frame after the first admission: it
        // bumps the run's generation and deletes the later `stale_read_set`,
        // and leaves the live head alone.
        yield* sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES (${runId}, 1, ${frame})`
        yield* sql`DELETE FROM flows_journal_events WHERE run_id = ${runId} AND seq > ${frame}`

        const { live, rebuilt, restored } = yield* dropAndRebuild

        expect(live[0]!.result_json).toBe("\"fresh\"")
        // The surviving history admits only the evicted row: restoring it would be a head live never held.
        expect(restored).toEqual([])
        expect(rebuilt).toEqual({ runs: 1, compacted: 0, rewound: 1, admitted: 0, retired: 0, heads: 0 })
      }).pipe(Effect.provide(services), Effect.scoped)
    ))
})

const entry = (eventType: string, payload: unknown, runId = "run-1", seq = 1) =>
  new JournalEvent.Entry({
    runId: runId as JournalEvent.RunId,
    seq: seq as JournalEvent.Seq,
    eventId: `event-${runId}-${seq}`,
    sourceId: "fold-test" as JournalEvent.SourceId,
    sourceSeq: 0 as JournalEvent.SourceSeq,
    emittedAtMs: 0,
    eventType,
    payload,
    meta: {}
  })

const provenance = "flows.engine.cache-provenance"
const naming = (action: string, extra: Record<string, unknown> = {}, keyDigest = "k", runId = "run-1", seq = 1) =>
  entry(provenance, { keyDigest, action, recordedRunId: runId, recordedEventSeq: seq, ...extra }, "run-2", 5)
const admitted = (keyDigest = "k", runId = "run-1", seq = 1) => naming("admitted", {}, keyDigest, runId, seq)

const fold = (entries: ReadonlyArray<JournalEvent.Entry>) => entries.reduce(StepCacheFold.reduce, StepCacheFold.initial)

describe("StepCacheFold.reduce", () => {
  it("retires the rows engine evictions name, and nothing else", () => {
    const retired = (entries: ReadonlyArray<JournalEvent.Entry>) =>
      StepCacheFold.candidates(fold([admitted(), ...entries])).length === 0

    expect(retired([naming("expired")])).toBe(true)
    expect(retired([naming("stale_read_set")])).toBe(true)
    expect(retired([naming("replay_failed", { reason: "corruption" })])).toBe(true)
    // The slot may hold an earlier host failure while the store evicted for corruption.
    expect(retired([naming("replay_failed", { reason: "host" })])).toBe(true)
    expect(retired([naming("ttl", { verdict: "expired" })])).toBe(false)
    expect(retired([naming("hit")])).toBe(false)
    expect(retired([naming("conflict_first_writer")])).toBe(false)
    expect(retired([naming("expired", {}, "k", "run-1", 2)])).toBe(false)
    expect(retired([naming("expired", {}, "j")])).toBe(false)
  })

  it("admits only `admitted` entries, never a `recorded` one", () => {
    const state = fold([entry(provenance, { keyDigest: "k", action: "recorded" }, "run-1", 1)])

    expect(StepCacheFold.candidates(state)).toEqual([])
  })

  it("gives a key its one surviving admission and no head when several survive", () => {
    const state = fold([
      admitted("k", "run-1", 1),
      admitted("k", "run-2", 3),
      admitted("j", "run-1", 2),
      admitted("j", "run-3", 4),
      naming("stale_read_set", {}, "j", "run-1", 2),
      // A copied entry names the same row again.
      admitted("i", "run-1", 5),
      admitted("i", "run-1", 5)
    ])

    expect(StepCacheFold.candidates(state)).toEqual([
      { keyDigest: "j", recordedRunId: "run-3", recordedEventSeq: 4 },
      { keyDigest: "i", recordedRunId: "run-1", recordedEventSeq: 5 }
    ])
  })

  it("ignores entries that name no row", () => {
    const state = fold([
      admitted(),
      entry("flows.engine.attempt-finished", {
        keyDigest: "j",
        action: "admitted",
        recordedRunId: "r",
        recordedEventSeq: 1
      }),
      entry(provenance, null),
      entry(provenance, ["admitted"]),
      entry(provenance, { action: "admitted", recordedRunId: "run-1", recordedEventSeq: 1 }),
      entry(provenance, { keyDigest: "k", action: "expired" }),
      entry(provenance, { keyDigest: "k", action: "expired", recordedRunId: "run-1", recordedEventSeq: "1" }),
      entry(provenance, { keyDigest: "k", action: "expired", recordedRunId: 1, recordedEventSeq: 1 })
    ])

    expect(StepCacheFold.candidates(state)).toEqual([{ keyDigest: "k", recordedRunId: "run-1", recordedEventSeq: 1 }])
    expect(HashSet.size(state.retired)).toBe(0)
  })

  it.effect("is the same fold as a journal projection", () =>
    Effect.gen(function*() {
      const entries = [admitted("k"), admitted("j", "run-1", 2), naming("expired")]
      let state = StepCacheFold.projection.initial
      for (const value of entries) state = yield* StepCacheFold.projection.reduce(state, value)

      expect(StepCacheFold.candidates(state)).toEqual(StepCacheFold.candidates(fold(entries)))
      expect(StepCacheFold.projection.name).toBe("flows.engine.step-cache")
    }))
})

describe("StepCacheFold.rebuild failures", () => {
  it.effect("reads each run page by page", () =>
    withCrypto(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* activate("fold-paged")
        yield* dispatch({ runId: "fold-paged", key: "fold/page-1", result: "one" })
        yield* dispatch({ runId: "fold-paged", key: "fold/page-2", result: "two" })
        const paged = Journal.Journal.of({
          ...journal,
          entries: (options) => journal.entries({ ...options, limit: 1 })
        })

        const { live, rebuilt, restored } = yield* dropAndRebuild.pipe(Effect.provideService(Journal.Journal, paged))

        expect(restored).toEqual(live)
        expect(rebuilt.heads).toBe(2)
      }).pipe(Effect.provide(setup), Effect.scoped)
    ))

  it.effect("surfaces a journal read failure without touching a head", () =>
    withCrypto(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* activate("fold-read-failure")
        yield* dispatch({ runId: "fold-read-failure", key: "fold/read-failure", result: "kept" })
        const live = yield* heads
        const failing = Journal.Journal.of({
          ...journal,
          entries: () => Effect.fail(new Journal.JournalError({ code: "read_failed", message: "disk gone" }))
        })

        const error = yield* StepCacheFold.rebuild().pipe(
          Effect.provideService(Journal.Journal, failing),
          Effect.flip
        )

        expect(error).toMatchObject({ code: "read_failed" })
        expect(yield* heads).toEqual(live)
      }).pipe(Effect.provide(Layer.merge(services, exact)), Effect.scoped)
    ))
})
