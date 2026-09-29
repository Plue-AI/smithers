/**
 * Local-first, remote-second, with write-back into the local SQL store — the
 * shape of `CombinedCache.downloadActionResult`
 * (`remote/CombinedCache.java` in bazelbuild/bazel).
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import { TestClock } from "effect/testing"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as CacheStore from "../src/CacheStore.ts"
import * as CacheStoreMetrics from "../src/CacheStoreMetrics.ts"
import * as CombinedCacheStore from "../src/CombinedCacheStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as RemoteCacheStore from "../src/RemoteCacheStore.ts"

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

const entry: CacheStore.CacheEntry = {
  keyDigest: "key-digest",
  result: { ok: true },
  meta: {},
  createdAtMs: 7,
  recordedRunId: "run-1",
  recordedEventSeq: 3
}

/** A first-writer-wins in-memory tier with a call log. */
const tier = (options: { readonly putOutcome?: CacheStore.PutResult } = {}) => {
  const rows = new Map<string, CacheStore.CacheEntry>()
  const calls: Array<string> = []
  const getOptions: Array<CacheStore.GetOptions | undefined> = []
  const store: CacheStore.Service = {
    get: (keyDigest, lookupOptions) =>
      Effect.sync(() => {
        calls.push("get")
        getOptions.push(lookupOptions)
        const row = rows.get(keyDigest)
        return row === undefined ? Option.none() : Option.some(row)
      }),
    put: (candidate) =>
      Effect.sync(() => {
        calls.push("put")
        if (options.putOutcome !== undefined) return options.putOutcome
        if (rows.has(candidate.keyDigest)) return { _tag: "ExistingSame" } as const
        rows.set(candidate.keyDigest, candidate)
        return { _tag: "Inserted" } as const
      }),
    evict: (keyDigest) =>
      Effect.sync(() => {
        calls.push("evict")
        return rows.delete(keyDigest)
      }),
    sweepExpired: () =>
      Effect.sync(() => {
        calls.push("sweepExpired")
        const swept = rows.size
        rows.clear()
        return swept
      })
  }
  return { rows, calls, getOptions, store }
}

/**
 * A first-writer-wins tier that decides `ExistingSame` versus `Conflict` on the
 * stored result the way the SQL store does, with optional deferred gating so an
 * interleaving can be pinned without a sleep.
 */
const durableTier = (
  options: {
    readonly gateGet?: Deferred.Deferred<void>
    readonly reachedGet?: Deferred.Deferred<void>
    readonly failGet?: CacheStore.CacheStoreError
    readonly failPut?: CacheStore.CacheStoreError
  } = {}
) => {
  const rows = new Map<string, CacheStore.CacheEntry>()
  const calls: Array<string> = []
  const getOptions: Array<CacheStore.GetOptions | undefined> = []
  const outcomes: Array<CacheStore.PutResult> = []
  const store: CacheStore.Service = {
    get: (
      keyDigest: string,
      lookupOptions?: CacheStore.GetOptions
    ): Effect.Effect<Option.Option<CacheStore.CacheEntry>, CacheStore.CacheStoreError> =>
      Effect.suspend(() => {
        calls.push("get")
        getOptions.push(lookupOptions)
        const announce = options.reachedGet === undefined
          ? Effect.void
          : Deferred.succeed(options.reachedGet, undefined)
        const wait = options.gateGet === undefined ? Effect.void : Deferred.await(options.gateGet)
        return announce.pipe(
          Effect.andThen(wait),
          Effect.flatMap(() => {
            if (options.failGet !== undefined) return Effect.fail(options.failGet)
            const row = rows.get(keyDigest)
            return Effect.succeed(row === undefined ? Option.none() : Option.some(row))
          })
        )
      }),
    put: (candidate: CacheStore.CacheEntry): Effect.Effect<CacheStore.PutResult, CacheStore.CacheStoreError> =>
      Effect.suspend((): Effect.Effect<CacheStore.PutResult, CacheStore.CacheStoreError> => {
        calls.push("put")
        if (options.failPut !== undefined) return Effect.fail(options.failPut)
        const existing = rows.get(candidate.keyDigest)
        if (existing === undefined) {
          rows.set(candidate.keyDigest, candidate)
          outcomes.push({ _tag: "Inserted" })
          return Effect.succeed({ _tag: "Inserted" })
        }
        const outcome: CacheStore.PutResult = JSON.stringify(existing.result) === JSON.stringify(candidate.result)
          ? { _tag: "ExistingSame" }
          : { _tag: "Conflict" }
        outcomes.push(outcome)
        return Effect.succeed(outcome)
      }),
    evict: (keyDigest: string) =>
      Effect.sync(() => {
        calls.push("evict")
        return rows.delete(keyDigest)
      }),
    sweepExpired: () =>
      Effect.sync(() => {
        calls.push("sweepExpired")
        const swept = rows.size
        rows.clear()
        return swept
      })
  }
  return { rows, calls, getOptions, outcomes, store }
}

/**
 * A tier that detaches its argument the way both shipped tiers do: at the start
 * of its own `put`. Nothing else observes whether the composition hands the two
 * tiers one value or two.
 */
const snapshottingTier = (
  options: {
    readonly gatePut?: Deferred.Deferred<void>
    readonly reachedPut?: Deferred.Deferred<void>
  } = {}
) => {
  const rows = new Map<string, CacheStore.CacheEntry>()
  const store: CacheStore.Service = {
    get: () => Effect.succeed(Option.none()),
    put: (candidate: CacheStore.CacheEntry) =>
      Effect.gen(function*() {
        const snapshot = yield* CacheStore.snapshotEntry(candidate)
        if (options.reachedPut !== undefined) yield* Deferred.succeed(options.reachedPut, undefined)
        if (options.gatePut !== undefined) yield* Deferred.await(options.gatePut)
        rows.set(snapshot.keyDigest, snapshot)
        return { _tag: "Inserted" } as const
      }),
    evict: () => Effect.succeed(false),
    sweepExpired: () => Effect.succeed(0)
  }
  return { rows, store }
}

describe("publication detachment", () => {
  it.effect("hands both tiers the value the caller held when the put began", () =>
    Effect.gen(function*() {
      const reached = Deferred.makeUnsafe<void>()
      const gate = Deferred.makeUnsafe<void>()
      const local = snapshottingTier({ gatePut: gate, reachedPut: reached })
      const remote = snapshottingTier()
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      const mutable = { ...entry, result: { value: "before" } }
      const fiber = yield* Effect.forkChild(combined.put(mutable), { startImmediately: true })
      yield* Deferred.await(reached)
      // The caller mutates while the local write is parked. Each tier detaches
      // at the start of its own `put`, so a composition that forwards the
      // caller's object persists one value and publishes another under the same
      // digest, and answers `Inserted` for both.
      mutable.result = { value: "after" }
      yield* Deferred.succeed(gate, undefined)
      expect(yield* Fiber.join(fiber)).toEqual({ _tag: "Inserted" })

      expect(local.rows.get(entry.keyDigest)!.result).toEqual({ value: "before" })
      expect(remote.rows.get(entry.keyDigest)!.result).toEqual({ value: "before" })
    }))

  it.effect("keeps the shared publication unchanged when the local tier mutates its shell", () =>
    Effect.gen(function*() {
      const published: Array<CacheStore.CacheEntry> = []
      const local = CacheStore.makeNoop({
        put: (candidate) =>
          Effect.sync(() => {
            try {
              ;(candidate as { result: unknown }).result = { value: "changed locally" }
            } catch {
              // Strict-mode assignment to the frozen snapshot is expected to throw.
            }
            return { _tag: "Inserted" } as const
          })
      })
      const remote = CacheStore.makeNoop({
        put: (candidate) =>
          Effect.sync(() => {
            published.push(candidate)
            return { _tag: "Inserted" } as const
          })
      })
      const combined = CombinedCacheStore.make({ local, remote })
      const original = { ...entry, result: { value: "original" } }

      expect(yield* combined.put(original)).toEqual({ _tag: "Inserted" })
      expect(published[0]!.result).toEqual({ value: "original" })
    }))

  it.effect("refuses an entry it cannot read without running caller code", () =>
    Effect.gen(function*() {
      const local = snapshottingTier()
      const remote = snapshottingTier()
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      const hostile = Object.defineProperty({ ...entry }, "keyDigest", {
        enumerable: true,
        configurable: true,
        get: () => {
          throw new Error("hostile")
        }
      }) as CacheStore.CacheEntry

      const exit = yield* Effect.exit(combined.put(hostile))

      // A throwing accessor is a caller mistake this package reports, never a
      // defect it propagates, so the composition must not read a field before
      // the snapshot that refuses the shape.
      expect(Exit.isFailure(exit) && exit.cause.reasons[0]!._tag).toBe("Fail")
      expect(local.rows.size).toBe(0)
      expect(remote.rows.size).toBe(0)
    }))
})

describe("lookups", () => {
  it.effect("answers from the local tier without touching the remote one", () =>
    Effect.gen(function*() {
      const local = tier()
      const remote = tier()
      yield* (local.store.put(entry))
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      expect(Option.getOrUndefined(yield* (combined.get(entry.keyDigest)))).toEqual(entry)
      expect(remote.calls).toEqual([])
    }))

  it.effect("falls through to the remote tier and writes the row back locally", () =>
    Effect.gen(function*() {
      const local = tier()
      const remote = tier()
      yield* (remote.store.put(entry))
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      expect(Option.getOrUndefined(yield* (combined.get(entry.keyDigest)))).toEqual(entry)
      // The write-back means the next lookup — on this run or a sibling one — is
      // a local hit.
      expect(local.rows.get(entry.keyDigest)).toEqual(entry)
      const before = remote.calls.length
      yield* (combined.get(entry.keyDigest))
      expect(remote.calls).toHaveLength(before)
    }))

  it.effect("reports a miss neither tier can satisfy", () =>
    Effect.gen(function*() {
      const combined = CombinedCacheStore.make({ local: tier().store, remote: tier().store })
      expect(Option.isNone(yield* (combined.get(entry.keyDigest)))).toBe(true)
    }))

  it.effect("treats a shared-tier refusal as a miss", () =>
    Effect.gen(function*() {
      const refused = new CacheStore.CacheStoreError({
        code: "persistence_failed",
        message: "the remote cache tier refused a lookup"
      })
      const local = durableTier()
      const remote = durableTier({ failGet: refused })
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      let executions = 0

      const result = yield* combined.get(entry.keyDigest).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.sync(() => ++executions),
          onSome: () => Effect.succeed(-1)
        }))
      )
      expect(result).toBe(1)
      expect(executions).toBe(1)
      expect(remote.calls).toEqual(["get"])
      expect(yield* count(CacheStoreMetrics.remoteFailure.get)).toBe(1)
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))
})

const withSqlStore = <A, E>(effect: Effect.Effect<A, E, CacheStore.CacheStore | SqlClient.SqlClient>) =>
  effect.pipe(
    Effect.provide(CacheStore.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer)
  )

describe("imported provenance retention", () => {
  it.effect("collects released imports while preserving local replay references", () =>
    withSqlStore(Effect.gen(function*() {
      const local = yield* CacheStore.CacheStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const remote = tier()
      const imported = { ...entry, recordedRunId: "foreign-run", createdAtMs: 0 }
      remote.rows.set(entry.keyDigest, imported)
      const combined = CombinedCacheStore.make({ local, remote: remote.store })
      expect(Option.getOrThrow(yield* combined.get(entry.keyDigest))).toEqual(imported)

      // The host's journal owns these references, including references to a
      // foreign producer. A retention pass runs while execution is quiescent.
      const references = new Set(["foreign-run"])
      const retention = {
        canReclaimRecorded: (record: { readonly recordedRunId: string }) =>
          Effect.succeed(!references.has(record.recordedRunId))
      }
      yield* TestClock.adjust("10 seconds")
      expect(yield* combined.sweepExpired(1000, retention)).toBe(1)
      const recordedBy = { runId: imported.recordedRunId, eventSeq: imported.recordedEventSeq }
      expect(Option.getOrThrow(yield* local.get(entry.keyDigest, { recordedBy }))).toEqual(imported)

      references.clear()
      expect(yield* combined.sweepExpired(1000, retention)).toBe(0)
      expect(yield* sql`SELECT * FROM flows_step_cache_recorded`).toEqual([])
      expect(yield* local.get(entry.keyDigest, { recordedBy })).toEqual(Option.none())
      expect(remote.calls).toEqual(["get"])
    })))
})

describe("age-bounded SQL composition", () => {
  const recordedBy = { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
  const expired = { ...entry, createdAtMs: 0 }
  const fresh = { ...entry, result: "fresh-remote", createdAtMs: 5000, recordedRunId: "remote-run" }
  const options = { recordedBy, maxAgeMs: 1000 }

  it.effect.each(["retained", "evicted", "replaced"] as const)(
    "stops at an expired exact ledger row with the local head %s",
    (head) =>
      withSqlStore(Effect.gen(function*() {
        const local = yield* CacheStore.CacheStore
        yield* local.put(expired)
        if (head !== "retained") yield* local.evict(entry.keyDigest)
        yield* TestClock.adjust("5 seconds")
        if (head === "replaced") yield* local.put(fresh)
        const remote = tier()
        remote.rows.set(entry.keyDigest, fresh)
        const combined = CombinedCacheStore.make({ local, remote: remote.store })

        expect(Option.isNone(yield* local.get(entry.keyDigest, options))).toBe(true)
        expect(yield* combined.get(entry.keyDigest, options)).toEqual(Option.none())
        expect(remote.calls).toEqual([])
        expect(Option.getOrThrow(yield* local.get(entry.keyDigest, { recordedBy }))).toEqual(expired)
      }))
  )

  it.effect("serves the exact local row at the age boundary without a remote read", () =>
    withSqlStore(Effect.gen(function*() {
      const local = yield* CacheStore.CacheStore
      yield* local.put(expired)
      yield* TestClock.adjust("1 second")
      const remote = tier()
      const combined = CombinedCacheStore.make({ local, remote: remote.store })
      expect(Option.getOrThrow(yield* combined.get(entry.keyDigest, options))).toEqual(expired)
      expect(remote.calls).toEqual([])
    })))

  it.effect.each([
    { runId: "other-run", eventSeq: recordedBy.eventSeq },
    { runId: recordedBy.runId, eventSeq: recordedBy.eventSeq + 1 }
  ])(
    "allows remote fallback when the local head has different provenance: %j",
    (other) =>
      withSqlStore(Effect.gen(function*() {
        const local = yield* CacheStore.CacheStore
        yield* local.put({ ...expired, recordedRunId: other.runId, recordedEventSeq: other.eventSeq })
        yield* TestClock.adjust("5 seconds")
        const remote = tier()
        remote.rows.set(entry.keyDigest, fresh)
        const combined = CombinedCacheStore.make({ local, remote: remote.store })
        expect(Option.getOrThrow(yield* combined.get(entry.keyDigest, options))).toEqual(fresh)
        expect(remote.calls).toEqual(["get"])
      }))
  )

  it.effect("preserves an expired exact row recorded during the remote lookup", () =>
    withSqlStore(Effect.gen(function*() {
      const local = yield* CacheStore.CacheStore
      yield* TestClock.adjust("5 seconds")
      const combined = CombinedCacheStore.make({
        local,
        remote: CacheStore.makeNoop({
          get: () => local.put(expired).pipe(Effect.as(Option.some(fresh)))
        })
      })
      expect(yield* combined.get(entry.keyDigest, options)).toEqual(Option.none())
      expect(Option.getOrThrow(yield* local.get(entry.keyDigest, { recordedBy }))).toEqual(expired)
    })))
})

describe("selector detachment", () => {
  const recordedBy = { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
  const expired = { ...entry, createdAtMs: 0 }
  const fresh = { ...entry, result: "fresh remote result", createdAtMs: 5000, recordedRunId: "remote-run" }

  /** A real loopback shared tier that always serves `fresh` and logs every request URL. */
  const loopback = Effect.acquireRelease(
    Effect.callback<{ readonly urls: Array<string>; readonly close: () => Promise<void>; readonly port: number }>(
      (resume) => {
        const urls: Array<string> = []
        const server = createServer((request, response) => {
          urls.push(request.url ?? "")
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify(fresh))
        })
        server.listen(0, "127.0.0.1", () =>
          resume(Effect.succeed({
            urls,
            port: (server.address() as AddressInfo).port,
            close: () => new Promise<void>((done) => server.close(() => done()))
          })))
      }
    ),
    (server) => Effect.promise(server.close)
  )

  const expiredLedger = (options: () => CacheStore.GetOptions) =>
    withSqlStore(Effect.scoped(Effect.gen(function*() {
      const local = yield* CacheStore.CacheStore
      yield* local.put(expired)
      yield* local.evict(entry.keyDigest)
      yield* TestClock.adjust("5 seconds")
      const server = yield* loopback
      const remote = yield* RemoteCacheStore.make({ endpoint: `http://127.0.0.1:${server.port}` }).pipe(
        Effect.provide(FetchHttpClient.layer)
      )
      const combined = CombinedCacheStore.make({ local, remote })
      expect(yield* combined.get(entry.keyDigest, options())).toEqual(Option.none())
      expect(server.urls).toEqual([])
      expect(Option.getOrThrow(yield* local.get(entry.keyDigest, { recordedBy }))).toEqual(expired)
    })))

  it.effect("reads an accessor-backed fence once and keeps it through the expired-ledger refusal", () => {
    let reads = 0
    return expiredLedger(() =>
      Object.defineProperty({ maxAgeMs: 1000 }, "recordedBy", {
        enumerable: true,
        get() {
          return ++reads === 1 ? recordedBy : undefined
        }
      })
    ).pipe(Effect.tap(() => Effect.sync(() => expect(reads).toBe(1))))
  })

  it.effect("reads an accessor-backed age bound once", () => {
    let reads = 0
    return expiredLedger(() =>
      Object.defineProperty({ recordedBy }, "maxAgeMs", {
        enumerable: true,
        get() {
          return ++reads === 1 ? 1000 : undefined
        }
      })
    ).pipe(Effect.tap(() => Effect.sync(() => expect(reads).toBe(1))))
  })

  it.effect("reads inner provenance accessors once", () => {
    let reads = 0
    return expiredLedger(() => ({
      maxAgeMs: 1000,
      recordedBy: Object.defineProperty({ eventSeq: recordedBy.eventSeq }, "runId", {
        enumerable: true,
        get() {
          return ++reads === 1 ? recordedBy.runId : "other-run"
        }
      }) as CacheStore.RecordedBy
    })).pipe(Effect.tap(() => Effect.sync(() => expect(reads).toBe(1))))
  })

  it.effect("hands every tier the selector the caller held when the lookup began", () =>
    Effect.gen(function*() {
      const caller: { maxAgeMs?: number; recordedBy?: { runId: string; eventSeq: number } } = {
        maxAgeMs: 1000,
        recordedBy: { ...recordedBy }
      }
      const seen: Array<CacheStore.GetOptions | undefined> = []
      const local = CacheStore.makeNoop({
        get: (_key, options) =>
          Effect.sync(() => {
            seen.push(options)
            caller.recordedBy!.runId = "mutated-run"
            delete caller.maxAgeMs
            return Option.none()
          })
      })
      const remote = tier()
      const combined = CombinedCacheStore.make({ local, remote: remote.store })
      yield* combined.get(entry.keyDigest, caller)
      const expected = { maxAgeMs: 1000, recordedBy }
      expect(seen).toEqual([expected, { recordedBy }])
      expect(remote.getOptions).toEqual([expected])
      expect(Object.isFrozen(remote.getOptions[0])).toBe(true)
      expect(Object.isFrozen(remote.getOptions[0]!.recordedBy)).toBe(true)
    }))

  it.effect("rereads the local winner after a lost write-back with the selector taken at entry", () =>
    Effect.gen(function*() {
      const caller: { maxAgeMs?: number; recordedBy?: { runId: string; eventSeq: number } } = {
        maxAgeMs: 1000,
        recordedBy: { ...recordedBy }
      }
      const local = tier({ putOutcome: { _tag: "Conflict" } })
      const remote = CacheStore.makeNoop({
        get: () =>
          Effect.sync(() => {
            caller.recordedBy!.runId = "mutated-run"
            delete caller.maxAgeMs
            return Option.some(fresh)
          })
      })
      const combined = CombinedCacheStore.make({ local: local.store, remote })
      expect(Option.getOrThrow(yield* combined.get(entry.keyDigest, caller))).toEqual(fresh)
      const expected = { maxAgeMs: 1000, recordedBy }
      expect(local.calls).toEqual(["get", "get", "put", "get", "get"])
      expect(local.getOptions).toEqual([expected, { recordedBy }, expected, { recordedBy }])
    }))

  it.effect("refuses a malformed selector before either tier is read", () =>
    Effect.gen(function*() {
      const local = tier()
      const remote = tier()
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      for (const options of [{ maxAgeMs: -1 }, { recordedBy: { runId: "", eventSeq: 1 } }]) {
        const exit = yield* Effect.exit(combined.get(entry.keyDigest, options))
        expect(Exit.isFailure(exit)).toBe(true)
      }
      expect(local.calls).toEqual([])
      expect(remote.calls).toEqual([])
    }))
})

describe("publications", () => {
  it.effect("records locally and publishes to the shared tier", () =>
    Effect.gen(function*() {
      const local = tier()
      const remote = tier()
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      expect(yield* (combined.put(entry))).toEqual({ _tag: "Inserted" })
      expect(remote.rows.get(entry.keyDigest)).toEqual(entry)
    }))

  it.effect("leaves the shared write to the caller in deferred mode", () =>
    Effect.gen(function*() {
      // The engine commits the local row inside a `DurableWriter` transaction and
      // a host call must never be held across one, so its composition defers the
      // shared write to its own `CacheSync` seam. Lookups stay read-through.
      const local = tier()
      const remote = tier()
      const combined = CombinedCacheStore.make({
        local: local.store,
        remote: remote.store,
        publication: "deferred"
      })
      expect(yield* (combined.put(entry))).toEqual({ _tag: "Inserted" })
      expect(local.rows.get(entry.keyDigest)).toEqual(entry)
      expect(remote.calls).toEqual([])
    }))

  it.effect("counts a shared-tier Conflict without changing the caller's outcome", () =>
    Effect.gen(function*() {
      // A remote `Conflict` means another machine recorded a different result
      // under this key: cross-host divergence, and the only place it is
      // observable. The caller's answer stays the local outcome, so the
      // divergence has to reach an operator as a metric or not at all.
      const local = tier()
      const remote = tier({ putOutcome: { _tag: "Conflict" } })
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      expect(yield* combined.put(entry)).toEqual({ _tag: "Inserted" })
      expect(yield* count(CacheStoreMetrics.put.Conflict)).toBe(1)
      expect(yield* count(CacheStoreMetrics.put.Inserted)).toBe(0)
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))

  it.effect("counts nothing extra when the shared tier accepts the entry", () =>
    Effect.gen(function*() {
      const local = tier()
      const remote = tier()
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      expect(yield* combined.put(entry)).toEqual({ _tag: "Inserted" })
      // The stub tiers update no counters, so a zero here is the composition
      // adding none of its own: only a shared `Conflict` is worth a count.
      expect(yield* count(CacheStoreMetrics.put.Conflict)).toBe(0)
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))

  it.effect("does not publish a result the local tier says conflicts", () =>
    Effect.gen(function*() {
      // A local `Conflict` is what drives the strict `Inconsistency` verdict;
      // pushing the losing result to the shared tier would spread it.
      const local = tier({ putOutcome: { _tag: "Conflict" } })
      const remote = tier()
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      expect(yield* (combined.put(entry))).toEqual({ _tag: "Conflict" })
      expect(remote.calls).toEqual([])
    }))
})

describe("write-back races", () => {
  const localEntry: CacheStore.CacheEntry = { ...entry, result: { ok: "local" } }
  const remoteEntry: CacheStore.CacheEntry = { ...entry, result: { ok: "remote" } }

  it.effect("serves the durable local winner when a concurrent put wins the write-back", () =>
    Effect.gen(function*() {
      const gate = Deferred.makeUnsafe<void>()
      const reached = Deferred.makeUnsafe<void>()
      const local = durableTier()
      const remote = durableTier({ gateGet: gate, reachedGet: reached })
      yield* (remote.store.put(remoteEntry))
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })

      const observed = yield* (
        Effect.gen(function*() {
          // The lookup misses locally, then parks inside the remote read.
          const lookup = yield* Effect.forkChild(combined.get(entry.keyDigest), { startImmediately: true })
          yield* Deferred.await(reached)
          // A sibling run on this machine records a *different* result under the
          // same key and wins the durable row.
          const winner = yield* local.store.put(localEntry)
          expect(winner).toEqual({ _tag: "Inserted" })
          yield* Deferred.succeed(gate, undefined)
          return yield* Fiber.join(lookup)
        })
      )

      // The write-back lost: the local tier reports the row it kept is a
      // different result under the same key.
      expect(local.outcomes).toEqual([{ _tag: "Inserted" }, { _tag: "Conflict" }])
      expect(local.rows.get(entry.keyDigest)).toEqual(localEntry)
      // The caller must never be handed a result the durable tier disagrees with:
      // this machine replays `localEntry`, so serving `remoteEntry` is a cache
      // collision the caller cannot detect.
      expect(Option.getOrThrow(observed)).toEqual(localEntry)
    }))

  it.effect("serves the remote row when the losing write-back finds no local row to defer to", () =>
    Effect.gen(function*() {
      // The write-back reported a losing outcome, but by the time the durable
      // row is re-read the winner is gone again — recorded and evicted by a
      // sibling within the window. The remote entry is then the only row
      // anyone holds, and it is what the caller gets.
      const local = tier({ putOutcome: { _tag: "Conflict" } })
      const remote = tier()
      yield* (remote.store.put(remoteEntry))
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      const observed = yield* (combined.get(entry.keyDigest))
      expect(local.calls).toEqual(["get", "put", "get"])
      expect(Option.getOrThrow(observed)).toEqual(remoteEntry)
    }))

  it.effect.each(["Conflict", "ExistingSame"] as const)(
    "preserves provenance and age options after a %s write-back race",
    (outcome) =>
      Effect.gen(function*() {
        const options: CacheStore.GetOptions = {
          recordedBy: { runId: remoteEntry.recordedRunId, eventSeq: remoteEntry.recordedEventSeq },
          maxAgeMs: 1_000
        }
        const local = tier({ putOutcome: { _tag: outcome } })
        const remote = tier()
        yield* remote.store.put(remoteEntry)
        const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
        expect(Option.getOrThrow(yield* combined.get(entry.keyDigest, options))).toEqual(remoteEntry)
        expect(local.getOptions).toEqual([options, { recordedBy: options.recordedBy }, options, {
          recordedBy: options.recordedBy
        }])
        expect(remote.getOptions).toEqual([options])
      })
  )

  it.effect("keeps the local row and succeeds when the shared publication fails", () =>
    Effect.gen(function*() {
      // Partial success: the local insert committed and the shared write did
      // not. The shared tier is an accelerator, so its outage is counted but
      // cannot replace the durable local outcome with a failed run.
      const local = durableTier()
      const refused = new CacheStore.CacheStoreError({
        code: "persistence_failed",
        message: "the remote cache tier refused a publication"
      })
      const failed = durableTier({ failPut: refused })
      const combined = CombinedCacheStore.make({
        local: local.store,
        remote: failed.store
      })

      expect(yield* combined.put(entry)).toEqual({ _tag: "Inserted" })
      expect(failed.calls).toEqual(["put"])
      expect(failed.outcomes).toEqual([])
      expect(failed.rows.size).toBe(0)
      expect(Option.isNone(yield* (failed.store.get(entry.keyDigest)))).toBe(true)
      expect(local.rows.get(entry.keyDigest)).toEqual(entry)
      expect(local.outcomes).toEqual([{ _tag: "Inserted" }])
      expect(yield* count(CacheStoreMetrics.remoteFailure.put)).toBe(1)

      // Retry semantics, pinned: the same `put` against a healthy shared tier
      // republishes and reports `ExistingSame` off the surviving local row. It is
      // never a `Conflict`, so a retry after an outage cannot fail the run
      // through the `Inconsistency` receiver.
      const healthy = durableTier()
      const retried = yield* (
        CombinedCacheStore.make({ local: local.store, remote: healthy.store }).put(entry)
      )
      expect(retried).toEqual({ _tag: "ExistingSame" })
      expect(healthy.rows.get(entry.keyDigest)).toEqual(entry)
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))
})

describe("evictions", () => {
  it.effect("stays local", () =>
    Effect.gen(function*() {
      // Every engine eviction is a "this host observed this row to be poison"
      // judgement, and none of those observations generalize to a tier where
      // another machine may still hold the artifacts this one lost.
      const local = tier()
      const remote = tier()
      yield* (local.store.put(entry))
      yield* (remote.store.put(entry))
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      expect(yield* (combined.evict(entry.keyDigest))).toBe(true)
      expect(remote.rows.has(entry.keyDigest)).toBe(true)
    }))

  it.effect.each([
    { runId: "other-run", eventSeq: entry.recordedEventSeq },
    { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq + 1 }
  ])(
    "forwards a stale provenance fence to the durable local tier: %j",
    (stale) =>
      withSqlStore(Effect.gen(function*() {
        // The engine evicts under a fence because the row it observed to be
        // poison may already have been replaced. The Map-backed tiers above
        // delete by key alone, so only the real SQL tier can show that the
        // composition hands the fence through instead of dropping it.
        const local = yield* CacheStore.CacheStore
        yield* local.put(entry)
        const remote = tier()
        remote.rows.set(entry.keyDigest, entry)
        const combined = CombinedCacheStore.make({ local, remote: remote.store })

        expect(yield* combined.evict(entry.keyDigest, { ifRecordedBy: stale })).toBe(false)
        expect(Option.getOrThrow(yield* local.get(entry.keyDigest))).toEqual(entry)
        expect(remote.calls).toEqual([])
        expect(remote.rows.get(entry.keyDigest)).toEqual(entry)
      }))
  )

  it.effect("evicts the local head under a matching provenance fence without touching the remote tier", () =>
    withSqlStore(Effect.gen(function*() {
      const local = yield* CacheStore.CacheStore
      yield* local.put(entry)
      const remote = tier()
      remote.rows.set(entry.keyDigest, entry)
      const combined = CombinedCacheStore.make({ local, remote: remote.store })
      const fence = { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }

      expect(yield* combined.evict(entry.keyDigest, { ifRecordedBy: fence })).toBe(true)
      expect(yield* local.get(entry.keyDigest)).toEqual(Option.none())
      expect(remote.calls).toEqual([])
      expect(remote.rows.get(entry.keyDigest)).toEqual(entry)
    })))

  it.effect("sweeps only the local tier", () =>
    Effect.gen(function*() {
      // Retention is a per-machine judgement for the same reason eviction is.
      const local = tier()
      const remote = tier()
      yield* (local.store.put(entry))
      yield* (remote.store.put(entry))
      const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
      expect(yield* (combined.sweepExpired(0))).toBe(1)
      expect(local.calls).toContain("sweepExpired")
      expect(remote.calls).not.toContain("sweepExpired")
      expect(remote.rows.has(entry.keyDigest)).toBe(true)
    }))
})

describe("layer", () => {
  it.effect("builds both tiers from effects and provides one tag", () =>
    Effect.gen(function*() {
      const remote = tier()
      const found = yield* (
        Effect.flatMap(CacheStore.CacheStore, (store) => Effect.andThen(store.put(entry), store.get(entry.keyDigest)))
          .pipe(
            Effect.provide(
              CombinedCacheStore.layer({
                local: Effect.sync(() => tier().store),
                remote: Effect.succeed(remote.store)
              })
            )
          )
      )
      expect(Option.getOrUndefined(found)).toEqual(entry)
      expect(remote.rows.get(entry.keyDigest)).toEqual(entry)
    }))

  it.effect("passes deferred publication through the layer constructor", () =>
    Effect.gen(function*() {
      const local = tier()
      const remote = tier()
      yield* Effect.flatMap(CacheStore.CacheStore, (store) => store.put(entry)).pipe(
        Effect.provide(CombinedCacheStore.layer({
          local: Effect.succeed(local.store),
          remote: Effect.succeed(remote.store),
          publication: "deferred"
        }))
      )
      expect(local.rows.get(entry.keyDigest)).toEqual(entry)
      expect(remote.calls).toEqual([])
    }))
})
