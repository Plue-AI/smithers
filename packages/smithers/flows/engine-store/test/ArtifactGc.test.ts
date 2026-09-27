/**
 * Mark/sweep artifact garbage collection over the real durable stores.
 *
 * The suite drives the production SQL stores over one in-memory database and
 * an instrumented in-memory filesystem, so every liveness claim is exercised
 * against the same rows and blobs production writes: attempt rows and cache
 * entries are the roots, the grace period and the put-side freshening are
 * what protect a writer racing the collector, and a crash mid-sweep leaves a
 * store the next collection converges from.
 */
// Every case here runs on real elapsed time — subprocess spawns, file locks,
// mtimes, and poll loops — so the suite uses `it.live`; `it.effect`'s
// TestClock never advances for them.

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { ArtifactStore, ArtifactSweep } from "@smthrs/artifacts"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as ArtifactGc from "../src/ArtifactGc.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { at } from "./Clocks.ts"
import { memoryFileSystem } from "./fixtures/MemoryFileSystem.ts"
import { hostPath } from "./HostPath.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const encoder = new TextEncoder()
const bytes = (content: string): Uint8Array => encoder.encode(content)

const objectsDirectory = ".flows/objects"
const blobPathOf = (digest: string): string => `${objectsDirectory}/${digest.slice(0, 2)}/${digest}`

const minuteMs = 60_000
const dayMs = 24 * 60 * 60 * 1000

/**
 * An in-memory host filesystem with controllable per-path mtimes, a removal
 * failure knob for the crash case, and a pre-removal hook for the concurrent
 * writer case.
 */
const memoryFs = () => {
  const host = memoryFileSystem()
  const { files, mtimes } = host
  /** Seeds a published blob whose last write happened `ageMs` ago. */
  const seedBlob = (content: string, ageMs: number): string => {
    const digest = sha256(bytes(content))
    const path = blobPathOf(digest)
    files.set(path, bytes(content))
    mtimes.set(path, Date.now() - ageMs)
    return digest
  }
  const hasBlob = (digest: string): boolean => files.has(blobPathOf(digest))
  return { ...host, seedBlob, hasBlob }
}

type Host = ReturnType<typeof memoryFs>

/**
 * The production stores over one in-memory database, the sweep surface over
 * the host double, and the collector wired across both. Providing the durable
 * bundle once to the collector and caller keeps every store on the migrated
 * connection, including the caller's directly exposed SQL client.
 */
const harness = (host: Host, options?: {
  readonly pageSize?: number | undefined
  readonly policy?: ArtifactGc.Policy | undefined
  readonly sweep?: ArtifactSweep.Service | undefined
}) => {
  const durable = Layer.provideMerge(
    Layer.mergeAll(RunStore.layer, AttemptStore.layer, CacheStore.layer),
    TestStores.database
  )
  const sweep = Layer.succeed(ArtifactSweep.ArtifactSweep)(
    options?.sweep ?? ArtifactSweep.makeFileSystem(host.fs, { coordination: "process" })
  )
  const policy = options?.policy === undefined
    ? Layer.empty
    : ArtifactGc.layerPolicy(options.policy)
  const collector = ArtifactGc.layer(options?.pageSize === undefined ? {} : { pageSize: options.pageSize }).pipe(
    Layer.provide(Layer.mergeAll(sweep, policy))
  )
  return Layer.mergeAll(
    collector,
    Layer.succeed(ArtifactStore.ArtifactStore)(
      ArtifactStore.makeFileSystem(host.fs, hostPath, {
        durability: "best-effort",
        coordination: "process"
      })
    )
  ).pipe(Layer.provideMerge(durable))
}

const owner: Ownership.OwnerId = { hostId: "gc-host", pid: 7, nonce: "gc-nonce" }

const runState = JSON.stringify({ version: 1, flowName: "ArtifactGc/Test", payload: {} })

/** Creates a run and takes ownership, so fenced attempt writes are admitted. */
const activateRun = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, runState)
    const row = yield* runs.get(runId)
    const expected = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, expected, owner, 0)
    expect(claim._tag).toBe("Claimed")
    if (claim._tag !== "Claimed") return
    expect(yield* runs.activate(runId, owner, claim.claimedAtMs, expected)).toEqual({ _tag: "Activated" })
  })

/** Boundary evidence referencing one spilled output by digest. */
const evidence = (digest: string) => ({
  declaredOutputs: { outputs: [{ path: `out/${digest.slice(0, 8)}.bin`, digest, sizeBytes: 3 }] },
  diffIdentity: `diff-${digest.slice(0, 8)}`
})

/** Records a succeeded attempt row whose evidence references `digest`. */
const recordAttempt = (runId: string, stepKeyDigest: string, digest: string) =>
  Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    const put = yield* attempts.put({
      runId,
      stepKeyDigest,
      attempt: 1,
      state: "succeeded",
      startedAtMs: 0,
      finishedAtMs: 1,
      meta: { tier: "sealed", boundary: evidence(digest) }
    }, owner)
    expect(put._tag).toBe("Inserted")
  })

/** Records a step cache entry whose evidence references `digest`. */
const recordCacheEntry = (keyDigest: string, digest: string, meta?: unknown) =>
  Effect.gen(function*() {
    const cache = yield* CacheStore.CacheStore
    const put = yield* cache.put({
      keyDigest,
      result: { ok: true },
      meta: meta ?? { tier: "sealed", boundary: evidence(digest) },
      createdAtMs: 0,
      recordedRunId: "recorder",
      recordedEventSeq: 0
    })
    expect(put._tag).toBe("Inserted")
  })

const gc = (options?: ArtifactGc.GcOptions) =>
  Effect.gen(function*() {
    const collector = yield* ArtifactGc.ArtifactGc
    return yield* collector.gc(options)
  })

describe("option bounds", () => {
  const invalidPositive = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]
  const invalidNonNegative = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]

  it.live("rejects an invalid page size before scanning any durable roots", () =>
    Effect.gen(function*() {
      for (const pageSize of invalidPositive) {
        const host = memoryFs()
        const garbage = host.seedBlob(`invalid-page-${String(pageSize)}`, 100 * dayMs)
        const failure = yield* withCrypto(
          gc().pipe(Effect.flip, Effect.provide(harness(host, { pageSize })))
        )
        expect(failure).toMatchObject({
          code: "invalid_options",
          message: "artifact GC pageSize must be a positive safe integer"
        })
        expect(host.hasBlob(garbage)).toBe(true)
      }
    }))

  it.live("rejects invalid call and policy grace bounds before inventory or deletion", () =>
    Effect.gen(function*() {
      for (const graceMs of invalidNonNegative) {
        const directHost = memoryFs()
        const directGarbage = directHost.seedBlob(`invalid-direct-${String(graceMs)}`, 100 * dayMs)
        const direct = yield* withCrypto(
          gc({ graceMs }).pipe(Effect.flip, Effect.provide(harness(directHost)))
        )
        expect(direct).toMatchObject({
          code: "invalid_options",
          message: "artifact GC graceMs must be a non-negative safe integer"
        })
        expect(directHost.hasBlob(directGarbage)).toBe(true)

        const policyHost = memoryFs()
        const policyGarbage = policyHost.seedBlob(`invalid-policy-${String(graceMs)}`, 100 * dayMs)
        const policy = yield* withCrypto(
          gc().pipe(Effect.flip, Effect.provide(harness(policyHost, { policy: { graceMs } })))
        )
        expect(policy.code).toBe("invalid_options")
        expect(policyHost.hasBlob(policyGarbage)).toBe(true)
      }
    }))
})

describe("mark: durable roots keep their referenced blobs", () => {
  it.live("never collects a blob referenced by a run's attempt row or a cache entry", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const attemptRef = host.seedBlob("attempt-referenced-output", 100 * dayMs)
      const cacheRef = host.seedBlob("cache-referenced-output", 100 * dayMs)
      const garbage = host.seedBlob("orphaned-output", 100 * dayMs)
      const young = host.seedBlob("recent-orphan", minuteMs)
      const report = yield* withCrypto(
        Effect.gen(function*() {
          yield* activateRun("run-live")
          yield* recordAttempt("run-live", "step-a", attemptRef)
          yield* recordCacheEntry("cache-key-a", cacheRef)
          return yield* gc()
        }).pipe(Effect.provide(harness(host)))
      )
      expect(report.sweptDigests).toEqual([garbage])
      expect(report.scannedBlobs).toBe(4)
      expect(report.liveDigests).toBe(2)
      expect(report.keptByGrace).toBe(1)
      expect(report.reclaimedBytes).toBe(bytes("orphaned-output").length)
      expect(report.dryRun).toBe(false)
      expect(host.hasBlob(attemptRef)).toBe(true)
      expect(host.hasBlob(cacheRef)).toBe(true)
      expect(host.hasBlob(young)).toBe(true)
      expect(host.hasBlob(garbage)).toBe(false)
    }))

  it.live("keeps a blob referenced only by an attempt checkpoint", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const checkpointRef = host.seedBlob("checkpoint-referenced-output", 100 * dayMs)
      const garbage = host.seedBlob("checkpoint-orphan", 100 * dayMs)
      const report = yield* withCrypto(
        Effect.gen(function*() {
          yield* activateRun("run-checkpoint")
          const attempts = yield* AttemptStore.AttemptStore
          const put = yield* attempts.put({
            runId: "run-checkpoint",
            stepKeyDigest: "step-checkpoint",
            attempt: 1,
            state: "running",
            startedAtMs: 0,
            checkpoint: { retainedArtifacts: [checkpointRef, "not-a-digest", null] },
            meta: { tier: "sealed" }
          }, owner)
          expect(put._tag).toBe("Inserted")
          return yield* gc()
        }).pipe(Effect.provide(harness(host)))
      )
      expect(report.sweptDigests).toEqual([garbage])
      expect(host.hasBlob(checkpointRef)).toBe(true)
    }))

  it.live("pages the mark scan by primary key across both root tables", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const referenced: Array<string> = []
      const garbage = host.seedBlob("paged-orphan", 100 * dayMs)
      const report = yield* withCrypto(
        Effect.gen(function*() {
          yield* activateRun("run-paged")
          for (let index = 0; index < 5; index++) {
            const attemptRef = host.seedBlob(`attempt-output-${index}`, 100 * dayMs)
            const cacheRef = host.seedBlob(`cache-output-${index}`, 100 * dayMs)
            referenced.push(attemptRef, cacheRef)
            yield* recordAttempt("run-paged", `step-${index}`, attemptRef)
            yield* recordCacheEntry(`cache-key-${index}`, cacheRef)
          }
          return yield* gc()
        }).pipe(Effect.provide(harness(host, { pageSize: 2 })))
      )
      expect(report.sweptDigests).toEqual([garbage])
      expect(report.liveDigests).toBe(10)
      expect(referenced.every((digest) => host.hasBlob(digest))).toBe(true)
    }))

  it.live("collects nothing and reports an empty sweep over an empty composition", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const report = yield* withCrypto(gc().pipe(Effect.provide(harness(host))))
      expect(report).toEqual({
        scannedBlobs: 0,
        liveDigests: 0,
        sweptDigests: [],
        reclaimedBytes: 0,
        keptByGrace: 0,
        dryRun: false
      })
    }))

  it.live("ignores root metadata that carries no boundary evidence", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const garbage = host.seedBlob("meta-shapes-orphan", 100 * dayMs)
      const report = yield* withCrypto(
        Effect.gen(function*() {
          // Null, non-object, and boundary-free metadata are all legitimate
          // rows that reference nothing.
          yield* recordCacheEntry("cache-null", "unused", null)
          yield* recordCacheEntry("cache-scalar", "unused", 42)
          yield* recordCacheEntry("cache-plain", "unused", { tier: "sealed" })
          return yield* gc()
        }).pipe(Effect.provide(harness(host)))
      )
      expect(report.sweptDigests).toEqual([garbage])
    }))

  it.live("fails the collection when a root carries undecodable boundary evidence", () =>
    Effect.gen(function*() {
      // FAIL-SAFE: reading such a row as "references nothing" is exactly how a
      // live blob would be collected, so the mark aborts and nothing sweeps.
      const host = memoryFs()
      const garbage = host.seedBlob("protected-by-refusal", 100 * dayMs)
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          yield* recordCacheEntry("cache-foreign", "unused", {
            boundary: { declaredOutputs: {}, diffIdentity: "" }
          })
          return yield* gc().pipe(Effect.flip)
        }).pipe(Effect.provide(harness(host)))
      )
      expect(failure.code).toBe("mark_failed")
      expect(host.hasBlob(garbage)).toBe(true)
    }))

  it.live("fails the collection when an attempt checkpoint is not valid JSON", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const garbage = host.seedBlob("protected-by-checkpoint-refusal", 100 * dayMs)
      const roots = Layer.succeed(SqlClient.SqlClient)(
        ((strings: TemplateStringsArray) =>
          strings.join("?").includes("flows_attempts")
            ? Effect.succeed([{
              run_id: "run-corrupt-checkpoint",
              step_key_digest: "step-corrupt-checkpoint",
              attempt: 1,
              checkpoint_json: "{",
              meta_json: "{}"
            }])
            : Effect.succeed([])) as never
      )
      const collector = ArtifactGc.layer().pipe(
        Layer.provide(Layer.mergeAll(
          roots,
          Layer.succeed(ArtifactSweep.ArtifactSweep)(
            ArtifactSweep.makeFileSystem(host.fs, { coordination: "process" })
          )
        ))
      )
      const failure = yield* withCrypto(
        gc().pipe(Effect.flip, Effect.provide(collector))
      )
      expect(failure.code).toBe("mark_failed")
      expect(host.hasBlob(garbage)).toBe(true)
    }))

  it.live("fails the collection when a root table cannot be scanned", () =>
    Effect.gen(function*() {
      // A stub client that refuses the named table's scan and returns no rows
      // for the other: the mark must surface the refusal rather than treat an
      // unreadable root set as empty.
      const refusing = (table: string) =>
        Layer.succeed(SqlClient.SqlClient)(
          ((strings: TemplateStringsArray) =>
            strings.join("?").includes(table)
              ? Effect.fail(new Error(`refused scan of ${table}`))
              : Effect.succeed([])) as never
        )
      const host = memoryFs()
      const garbage = host.seedBlob("protected-by-scan-failure", 100 * dayMs)
      const collector = (table: string) =>
        ArtifactGc.layer().pipe(
          Layer.provide(Layer.mergeAll(
            refusing(table),
            Layer.succeed(ArtifactSweep.ArtifactSweep)(
              ArtifactSweep.makeFileSystem(host.fs, { coordination: "process" })
            )
          ))
        )
      const cacheFailure = yield* withCrypto(
        gc().pipe(Effect.flip, Effect.provide(collector("flows_step_cache")))
      )
      const attemptFailure = yield* withCrypto(
        gc().pipe(Effect.flip, Effect.provide(collector("flows_attempts")))
      )
      expect(cacheFailure.code).toBe("mark_failed")
      expect(attemptFailure.code).toBe("mark_failed")
      expect(host.hasBlob(garbage)).toBe(true)
    }))
})

describe("sweep: grace period, pins, and policy", () => {
  it.live("layerFileSystem sweeps the objects directory it is given", () =>
    Effect.gen(function*() {
      // The composition `smthrs gc` runs: the collector with the filesystem
      // sweep beneath it, needing only the database and the host filesystem.
      const host = memoryFs()
      const garbage = host.seedBlob("filesystem-orphan", 100 * dayMs)
      const report = yield* withCrypto(
        gc({ graceMs: dayMs }).pipe(
          Effect.provide(
            ArtifactGc.layerFileSystem({ directory: objectsDirectory, coordination: "process" }).pipe(
              Layer.provide(Layer.mergeAll(TestStores.database, Layer.succeed(FileSystem.FileSystem)(host.fs)))
            )
          )
        )
      )
      expect(report.sweptDigests).toEqual([garbage])
      expect(host.hasBlob(garbage)).toBe(false)
    }))

  it.live("honours the grace period from options, policy, and the default", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const older = host.seedBlob("ten-minute-orphan", 10 * minuteMs)
      const younger = host.seedBlob("one-minute-orphan", minuteMs)
      const layer = harness(host, { policy: { graceMs: 5 * minuteMs } })
      const policyReport = yield* withCrypto(gc().pipe(Effect.provide(layer)))
      expect(policyReport.sweptDigests).toEqual([older])
      expect(policyReport.keptByGrace).toBe(1)
      expect(host.hasBlob(younger)).toBe(true)
      // Explicit options override the installed policy: under a two-week bound
      // the surviving one-minute orphan stays untouchable.
      const optionsReport = yield* withCrypto(gc({ graceMs: 14 * dayMs }).pipe(Effect.provide(layer)))
      expect(optionsReport.sweptDigests).toEqual([])
      expect(optionsReport.keptByGrace).toBe(1)
    }))

  it.live("keeps pinned digests regardless of reachability", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const pinnedByCall = host.seedBlob("pinned-by-call", 100 * dayMs)
      const pinnedByPolicy = host.seedBlob("pinned-by-policy", 100 * dayMs)
      const garbage = host.seedBlob("unpinned-orphan", 100 * dayMs)
      const report = yield* withCrypto(
        gc({ pins: [pinnedByCall] }).pipe(
          Effect.provide(harness(host, { policy: { pins: Effect.succeed([pinnedByPolicy]) } }))
        )
      )
      expect(report.sweptDigests).toEqual([garbage])
      expect(report.liveDigests).toBe(2)
      expect(host.hasBlob(pinnedByCall)).toBe(true)
      expect(host.hasBlob(pinnedByPolicy)).toBe(true)
    }))

  it.live("reports a dry run without deleting anything", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const garbage = host.seedBlob("dry-run-orphan", 100 * dayMs)
      const layer = harness(host)
      const dry = yield* withCrypto(gc({ dryRun: true }).pipe(Effect.provide(layer)))
      expect(dry.dryRun).toBe(true)
      expect(dry.sweptDigests).toEqual([garbage])
      expect(dry.reclaimedBytes).toBe(bytes("dry-run-orphan").length)
      expect(host.hasBlob(garbage)).toBe(true)
      // The real collection then does exactly what the dry run promised.
      const real = yield* withCrypto(gc().pipe(Effect.provide(layer)))
      expect(real.sweptDigests).toEqual([garbage])
      expect(host.hasBlob(garbage)).toBe(false)
    }))

  it.live("is idempotent: a second collection over the same state sweeps nothing", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const referenced = host.seedBlob("kept-output", 100 * dayMs)
      host.seedBlob("swept-output", 100 * dayMs)
      const layer = harness(host)
      const [first, second] = yield* withCrypto(
        Effect.gen(function*() {
          yield* activateRun("run-idempotent")
          yield* recordAttempt("run-idempotent", "step-a", referenced)
          const initial = yield* gc()
          const repeat = yield* gc()
          return [initial, repeat] as const
        }).pipe(Effect.provide(layer))
      )
      expect(first.sweptDigests).toHaveLength(1)
      expect(second.sweptDigests).toEqual([])
      expect(second.scannedBlobs).toBe(1)
      expect(host.hasBlob(referenced)).toBe(true)
    }))
})

describe("sweep: liveness under concurrency and crashes", () => {
  it.live("retains a publication committed after marking even when inventory outlasts grace", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const content = bytes("published-after-mark")
      const digest = sha256(content)
      const report = yield* withCrypto(
        Effect.gen(function*() {
          const store = yield* ArtifactStore.ArtifactStore
          const cache = yield* CacheStore.CacheStore
          const sweep = ArtifactSweep.makeFileSystem(host.fs, { coordination: "process" })
          const collector = yield* ArtifactGc.make().pipe(
            Effect.provideService(ArtifactSweep.ArtifactSweep, {
              ...sweep,
              inventory: Effect.gen(function*() {
                // Both root scans have finished. Publish bytes and commit their
                // reference, then let the inventory take longer than graceMs.
                yield* store.put(content)
                yield* recordCacheEntry("late-publication", digest).pipe(
                  Effect.provideService(CacheStore.CacheStore, cache)
                )
                yield* Effect.sleep("20 millis")
                return yield* sweep.inventory
              }).pipe(Effect.provide(NodeCrypto.layer), Effect.orDie)
            })
          )
          const result = yield* collector.gc({ graceMs: 1 })
          expect((yield* gc({ graceMs: 1 })).liveDigests).toBe(1)
          return result
        }).pipe(Effect.provide(harness(host)))
      )
      expect(report.liveDigests).toBe(0)
      expect(report.scannedBlobs).toBe(1)
      expect(report.sweptDigests).toEqual([])
      expect(report.keptByGrace).toBe(1)
      expect(host.hasBlob(digest)).toBe(true)
    }))

  it.live("retains cutoff-equal mtimes in real and dry-run inventories, including zero grace", () =>
    Effect.gen(function*() {
      const start = 10_000
      for (const graceMs of [0, 1]) {
        for (const dryRun of [false, true]) {
          const host = memoryFs()
          const equal = host.seedBlob("cutoff-equal", 0)
          const older = host.seedBlob("cutoff-older", 0)
          host.mtimes.set(blobPathOf(equal), start - graceMs)
          host.mtimes.set(blobPathOf(older), start - graceMs - 1)
          const report = yield* withCrypto(
            at(start, gc({ graceMs, dryRun }).pipe(Effect.provide(harness(host))))
          )
          expect(report.sweptDigests).toEqual([older])
          expect(report.keptByGrace).toBe(1)
          expect(host.hasBlob(equal)).toBe(true)
          expect(host.hasBlob(older)).toBe(dryRun)
        }
      }
    }))

  it.live("retains a blob freshened to the cutoff after inventory, including zero grace", () =>
    Effect.gen(function*() {
      const start = 10_000
      for (const graceMs of [0, 1]) {
        const host = memoryFs()
        const digest = host.seedBlob("freshened-to-cutoff", 0)
        host.mtimes.set(blobPathOf(digest), start - graceMs - 1)
        const sweep = ArtifactSweep.makeFileSystem(host.fs, { coordination: "process" })
        const report = yield* withCrypto(
          at(
            start,
            gc({ graceMs }).pipe(Effect.provide(harness(host, {
              sweep: {
                ...sweep,
                inventory: Effect.gen(function*() {
                  const blobs = yield* sweep.inventory
                  host.mtimes.set(blobPathOf(digest), start - graceMs)
                  return blobs
                })
              }
            })))
          )
        )
        expect(report.sweptDigests).toEqual([])
        expect(report.keptByGrace).toBe(1)
        expect(host.hasBlob(digest)).toBe(true)
      }
    }))

  it.live("a blob written or freshened during the sweep survives it", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      // Two old orphans: the first removal triggers the concurrent writer, the
      // second is the freshened blob whose fence must then refuse.
      const trigger = host.seedBlob("sweep-trigger-orphan", 100 * dayMs)
      const freshened = host.seedBlob("re-referenced-output", 100 * dayMs)
      const fresh = "written-during-sweep"
      const freshDigest = sha256(bytes(fresh))
      const store = ArtifactStore.makeFileSystem(host.fs, hostPath, {
        durability: "best-effort",
        coordination: "process"
      })
      host.hooks.beforeRemove = () =>
        // A concurrent writer publishes a brand-new blob and re-publishes the
        // bytes of an old unreferenced one — the dedupe path that freshens the
        // blob's mtime instead of rewriting it.
        store.put(bytes(fresh)).pipe(
          Effect.andThen(store.put(bytes("re-referenced-output"))),
          Effect.provide(NodeCrypto.layer),
          Effect.orDie,
          Effect.asVoid
        )
      const report = yield* withCrypto(gc().pipe(Effect.provide(harness(host))))
      expect(report.sweptDigests).toEqual([trigger])
      // The freshened blob failed the deletion fence; the brand-new blob was
      // never a candidate at all.
      expect(report.keptByGrace).toBe(1)
      expect(host.hasBlob(freshened)).toBe(true)
      expect(host.hasBlob(freshDigest)).toBe(true)
    }))

  it.live("a crash mid-sweep deletes garbage only, and a re-run converges", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const referenced = host.seedBlob("crash-survivor-output", 100 * dayMs)
      // Inventory follows the filesystem's directory order, not seed order.
      const [first, second] = [
        host.seedBlob("first-orphan", 100 * dayMs),
        host.seedBlob("second-orphan", 100 * dayMs)
      ].sort() as [string, string]
      host.failure.removeOf = blobPathOf(second)
      // One provision throughout: the durable roots live in one in-memory
      // database, and the recovery collection must see the same rows the
      // crashed one did.
      const [failure, recovery] = yield* withCrypto(
        Effect.gen(function*() {
          yield* activateRun("run-crash")
          yield* recordAttempt("run-crash", "step-a", referenced)
          const crashed = yield* gc().pipe(Effect.flip)
          // The interrupted sweep deleted only garbage: the referenced blob is
          // untouched and the fenced remainder is still present.
          expect(host.hasBlob(referenced)).toBe(true)
          expect(host.hasBlob(first)).toBe(false)
          expect(host.hasBlob(second)).toBe(true)
          yield* Effect.sync(() => {
            host.failure.removeOf = undefined
          })
          const converged = yield* gc()
          return [crashed, converged] as const
        }).pipe(Effect.provide(harness(host)))
      )
      expect(failure.code).toBe("sweep_failed")
      expect(recovery.sweptDigests).toEqual([second])
      expect(host.hasBlob(referenced)).toBe(true)
    }))

  it.live("fails the collection when the inventory itself refuses", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const failure = yield* withCrypto(
        gc().pipe(
          Effect.flip,
          Effect.provide(harness(host, { sweep: ArtifactSweep.makeNoop() }))
        )
      )
      expect(failure.code).toBe("sweep_failed")
    }))
})
