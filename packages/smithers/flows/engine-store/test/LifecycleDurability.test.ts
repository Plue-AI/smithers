/**
 * Pins issue #10: every engine-store lifecycle journal write must go through
 * the journal's durable (undroppable) channel, fenced to the owning process
 * where the write is owned — never the optimistic lossy queue.
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as Notifying from "@smthrs/journal/test/Notifying"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as Clocks from "./Clocks.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const ownerA: Ownership.OwnerId = { hostId: "lifecycle-host-a", pid: 1, nonce: "lifecycle-owner-a" }
const ownerB: Ownership.OwnerId = { hostId: "lifecycle-host-b", pid: 2, nonce: "lifecycle-owner-b" }

const boundary: ActionPersistence.BoundaryMetadata = {
  readSet: [],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({ commitId: "lifecycle-snapshot" as never, changeId: "lifecycle-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const layer = Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jj)

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | AttemptStore.AttemptStore
    | CacheStore.CacheStore
    | Journal.Journal
    | RunStore.RunStore
    | StepBoundary.Service
    | Jj.Jj
    | Scope.Scope
    | Crypto.Crypto
  >
) =>
  withCrypto(
    effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped)
  )

/**
 * A journal whose ownerless lossy channel drops every admission on the floor
 * (the saturated-queue worst case). The durable channel still works, so a
 * call site that uses the lifecycle channel keeps its events; a call site on
 * the lossy channel silently loses them.
 */
const droppingLossy = (real: Journal.Service): Journal.Service =>
  Journal.make({
    ...real,
    emitLossy: () =>
      Effect.succeed(
        {
          _tag: "Dropped",
          seq: 0 as JournalEvent.Seq,
          sourceSeq: 0 as JournalEvent.SourceSeq,
          policy: "drop-newest"
        } as const
      )
  })

const activate = (runId: string, owner: Ownership.OwnerId) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    yield* takeover(runs, runId, owner)
  })

const takeover = (runs: RunStore.Service, runId: string, claimant: Ownership.OwnerId) =>
  Effect.gen(function*() {
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const stealing = row.status === "running" && row.owner !== null
    const now = (yield* Clock.currentTimeMillis) +
      (stealing ? Duration.toMillis(Ownership.heartbeatStaleAfter) + 1 : 0)
    const evidence: Ownership.LivenessEvidence | undefined = stealing
      ? { expectedOwner: row.owner!, checkedAtMs: now, kind: "cross-host-unreachable-stale" }
      : undefined
    // The store decides staleness from the clock IT reads, never from `now`,
    // so the steal is taken at the skewed moment rather than merely described
    // by it (`@smthrs/run-store` `claimAndOwn`).
    const outcome = yield* Clocks.at(now, runs.claimAndOwn(runId, snapshot, claimant, now, evidence))
    if (outcome._tag !== "Activated") {
      return yield* Effect.die(new Error(`run ${runId} takeover was lost: ${outcome._tag}`))
    }
  })

const makeExecutor = (options: {
  readonly runId: string
  readonly owner: Ownership.OwnerId
  readonly key: string
  readonly result: unknown
}) =>
  ActionPersistence.make({
    runId: options.runId,
    owner: options.owner,
    sourceId: `lifecycle-${options.owner.nonce}`,
    execute: () => Effect.succeed(options.result)
  })

const eventTypes = (entries: ReadonlyArray<JournalEvent.Entry>): ReadonlyArray<string> =>
  entries.map((entry) => entry.eventType)

describe("lifecycle journal durability", () => {
  it.effect("lifecycle events survive a lossy channel that drops every ownerless admission", () =>
    Effect.gen(function*() {
      const key = "lifecycle/drop-proof"
      const result = yield* run(Effect.gen(function*() {
        yield* activate("drop-proof", ownerA)
        const journal = yield* Journal.Journal
        const cache = yield* CacheStore.CacheStore
        const executor = makeExecutor({ runId: "drop-proof", owner: ownerA, key, result: "v1" })
        const value = yield* executor({
          action: {},
          attempt: 1,
          key,
          tier: "sealed",
          metadata: boundary
        }).pipe(Effect.provideService(Journal.Journal, droppingLossy(journal)))
        yield* journal.flush
        const entries = yield* journal.entries({ runId: "drop-proof" as never, limit: 100 })
        const cached = yield* cache.get(sha256(key))
        return { value, entries: entries.entries, cached }
      }))

      expect(result.value).toBe("v1")
      const types = eventTypes(result.entries)
      expect(types).toContain("flows.engine.attempt-started")
      expect(types).toContain("flows.engine.attempt-finished")
      expect(types).toContain("flows.engine.cache-provenance")
      // The cache row's provenance must reference the committed cache-provenance
      // event, not an optimistic (possibly dropped) receipt.
      const provenanceSeq = result.entries.find(
        (entry) => entry.eventType === "flows.engine.cache-provenance"
      )!.seq
      expect(Option.getOrThrow(result.cached).recordedEventSeq).toBe(provenanceSeq)
    }))

  it.effect("a zombie owner cannot journal attempt-finished after fence loss", () =>
    Effect.gen(function*() {
      const key = "lifecycle/fence-proof"
      const result = yield* run(Effect.gen(function*() {
        yield* activate("fence-proof", ownerA)
        const attempts = yield* AttemptStore.AttemptStore
        const runs = yield* RunStore.RunStore
        const journal = yield* Journal.Journal
        // Steal the run to owner B in the window between the attempt row
        // sealing and the attempt-finished journal append.
        const stealing = Notifying.wrap(
          attempts,
          (op, order, args) =>
            op === "finish" && order === "after" &&
              (args[0] as { readonly state: string }).state === "succeeded"
              ? takeover(runs, "fence-proof", ownerB).pipe(Effect.orDie)
              : Effect.void
        )
        const executor = makeExecutor({ runId: "fence-proof", owner: ownerA, key, result: "v1" })
        const exit = yield* executor({
          action: {},
          attempt: 1,
          key,
          tier: "sealed",
          metadata: boundary
        }).pipe(
          Effect.provideService(AttemptStore.AttemptStore, stealing),
          Effect.forkChild({ startImmediately: true }),
          Effect.flatMap(Fiber.await)
        )
        yield* journal.flush
        const entries = yield* journal.entries({ runId: "fence-proof" as never, limit: 100 })
        return { exit, entries: entries.entries }
      }))

      expect(Exit.isSuccess(result.exit)).toBe(false)
      expect(eventTypes(result.entries)).not.toContain("flows.engine.attempt-finished")
    }))

  it.effect("a tolerated cache conflict keeps its journal evidence even when the lossy channel drops", () =>
    Effect.gen(function*() {
      const key = "lifecycle/conflict-proof"
      const result = yield* run(Effect.gen(function*() {
        yield* activate("conflict-proof", ownerA)
        const journal = yield* Journal.Journal
        const cache = yield* CacheStore.CacheStore
        // A pre-existing divergent cache row forces cache.put into Conflict.
        yield* cache.put({
          keyDigest: sha256(key),
          result: "other-value",
          meta: { tier: "sealed" },
          createdAtMs: 0,
          recordedRunId: "some-other-run",
          recordedEventSeq: 0
        })
        const lossy = droppingLossy(journal)
        const executor = makeExecutor({ runId: "conflict-proof", owner: ownerA, key, result: "v1" })
        const value = yield* executor({
          action: {},
          attempt: 1,
          key,
          tier: "sealed",
          metadata: boundary
        }).pipe(
          Effect.provideService(Journal.Journal, lossy),
          Effect.provideService(
            Inconsistency.Inconsistency,
            Inconsistency.make({ journal: lossy, verdict: "tolerate", owner: ownerA })
          )
        )
        yield* journal.flush
        const entries = yield* journal.entries({ runId: "conflict-proof" as never, limit: 100 })
        return { value, entries: entries.entries }
      }))

      expect(result.value).toBe("v1")
      expect(eventTypes(result.entries)).toContain("flows.engine.cache-conflict")
    }))
})
