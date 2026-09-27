/**
 * The automated restore drill: a live durable engine takes real writes, a hot
 * backup is captured mid-action over a second connection, the backup is
 * restored into a fresh directory, and the restored store both fences the
 * pre-backup owner out and resumes the run under a new owner.
 *
 * The drill pins the four DR guarantees end to end:
 *
 * 1. `backup` is hot: it runs while the run is `running` under a live owner,
 *    with an admitted attempt still in flight and a journal writer appending.
 * 2. `restore` + `fence` close the resurrection hazard: before the fence the
 *    pre-backup owner's heartbeat still lands on the restored store; after it
 *    every fenced operation reports `FenceLost` / `fence_lost`.
 * 3. The restored run resumes correctly: recorded attempts replay without
 *    re-executing, the in-flight attempt re-executes under the new owner, and
 *    post-backup work is simply absent.
 * 4. The source store is untouched: its owner keeps its fence there.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Action, Flow } from "@smthrs/flow"
import { Journal, type JournalEvent, SqlJournal } from "@smthrs/journal"
import { Input, type RunId, type SourceId, type SourceSeq } from "@smthrs/journal/JournalEvent"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Layer, Option } from "effect"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DisasterRecovery from "../src/DisasterRecovery.ts"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as Migrations from "../src/Migrations.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const ownerA: Ownership.OwnerId = { hostId: "drill-host", pid: 11, nonce: "owner-a" }
const ownerB: Ownership.OwnerId = { hostId: "drill-host", pid: 12, nonce: "owner-b" }
const staleClaimant: Ownership.OwnerId = { hostId: "drill-host", pid: 13, nonce: "claimant-stale" }
const freshClaimant: Ownership.OwnerId = { hostId: "drill-host", pid: 14, nonce: "claimant-fresh" }

const runId = "drill-run"
const claimedRunId = "drill-claimed-run"
const encoder = new TextEncoder()
const engineRunId = "drill-flow-run"

const boundary: ActionPersistence.BoundaryMetadata = {
  readSet: [],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "drill-snapshot" as never, changeId: "drill-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** The whole durable stack over one SQLite file, plus the real host. */
const services = (
  filename: string,
  objectsDirectory: string,
  owner: Ownership.OwnerId = ownerA
) =>
  Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(
    Layer.provideMerge(
      Layer.provideMerge(Migrations.layer, Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename })))
    ),
    Layer.merge(StepBoundary.layerTest()),
    Layer.merge(jj),
    Layer.merge(OwnerIdentity.layerConstant(owner)),
    Layer.provideMerge(ArtifactStore.layerFileSystem({ directory: objectsDirectory })),
    Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer))
  )

const dispatch = (options: {
  readonly owner: Ownership.OwnerId
  readonly key: string
  readonly execute: Effect.Effect<unknown>
}) =>
  ActionPersistence.make({
    runId,
    owner: options.owner,
    sourceId: `drill-${runId}`,
    execute: () => options.execute
  })({ action: {}, attempt: 1, key: options.key, tier: "sealed", metadata: boundary })

const counted = (counter: { count: number }, result: string): Effect.Effect<unknown> =>
  Effect.sync(() => {
    counter.count++
    return result
  })

const hotEvent = (seq: number): Input =>
  new Input({
    runId: runId as RunId,
    sourceId: "drill-hot" as SourceId,
    sourceSeq: seq as SourceSeq,
    eventType: "drill.hot",
    payload: seq
  }, { disableChecks: true })

const hotEventCount = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const page = yield* journal.entries({ runId: runId as JournalEvent.RunId, limit: 200 })
  return page.entries.filter((entry) => entry.eventType === "drill.hot").length
})

const snapshotOf = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

describe("restore drill", () => {
  it.effect("restores and resumes a real registered flow from a mid-action hot backup", () =>
    Effect.gen(function*() {
      const base = mkdtempSync(join(tmpdir(), "flows-drill-engine-"))
      mkdirSync(join(base, "live"), { recursive: true })
      const liveDatabase = join(base, "live", DisasterRecovery.databaseFileName)
      const liveObjects = join(base, "live", DisasterRecovery.objectsDirectoryName)
      const backupDirectory = join(base, "backup")
      const targetDirectory = join(base, "restored")
      const counters = { recorded: 0, inflightLive: 0, inflightRestored: 0 }
      let mode: "live" | "restored" = "live"
      let liveGate: Deferred.Deferred<void>
      let liveStarted: Deferred.Deferred<void>

      const recorded = Action.make({
        name: "restore-drill-recorded",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "restore-drill-recorded-v1",
        execute: Effect.sync(() => {
          counters.recorded++
          return "recorded-live"
        })
      })
      const inflight = Action.make({
        name: "restore-drill-inflight",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "restore-drill-inflight-v1",
        execute: Effect.gen(function*() {
          if (mode === "live") {
            counters.inflightLive++
            yield* Deferred.succeed(liveStarted, undefined)
            yield* Deferred.await(liveGate)
            return "inflight-live"
          }
          counters.inflightRestored++
          return "inflight-restored"
        })
      })
      const flow = Flow.make("RestoreDrill/Flow", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const handler = () =>
        Effect.gen(function*() {
          const first = yield* recorded
          const second = yield* inflight
          return `${first}/${second}`
        })

      const live = yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            liveGate = yield* Deferred.make<void>()
            liveStarted = yield* Deferred.make<void>()
            const engine = yield* EngineStore.make({
              owner: { hostId: ownerA.hostId },
              journalSource: "restore-drill-engine",
              isAlive: () => Effect.succeed(false)
            })
            yield* engine.register(flow, handler)
            const fiber = yield* engine.execute(flow, {
              executionId: engineRunId,
              payload: {},
              discard: false
            }).pipe(Effect.forkChild({ startImmediately: true }))

            // The action body runs only after durable admission, so its
            // signal means the running attempt row is committed. Awaiting it
            // never touches the frozen TestClock, unlike a sleep-poll.
            yield* Deferred.await(liveStarted)
            const sql = yield* SqlClient.SqlClient
            expect(
              (yield* sql<{ readonly state: string }>`
            SELECT state FROM flows_attempts
            WHERE run_id = ${engineRunId} AND state = 'running'
          `).length
            ).toBe(1)

            const manifest = yield* DisasterRecovery.backup({
              directory: backupDirectory,
              objectsDirectory: liveObjects,
              snapshotDatabaseLayer: (databaseFile) => NodeDatabase.layer({ filename: databaseFile })
            }).pipe(Effect.provide(NodeDatabase.layer({ filename: liveDatabase })))

            yield* Deferred.succeed(liveGate, undefined)
            const value = yield* Fiber.join(fiber)
            const runs = yield* RunStore.RunStore
            return { manifest, value, row: yield* runs.get(engineRunId) }
          }).pipe(Effect.provide(services(liveDatabase, liveObjects, ownerA)))
        )
      )

      expect(live.value).toBe("recorded-live/inflight-live")
      expect(live.row.status).toBe("completed")
      expect(counters).toEqual({ recorded: 1, inflightLive: 1, inflightRestored: 0 })

      const restored = yield* withCrypto(
        DisasterRecovery.restore({ backupDirectory, targetDirectory }).pipe(
          Effect.provide(NodeFileSystem.layer)
        )
      )
      mode = "restored"

      const drill = yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            const beforeFenceRow = yield* runs.get(engineRunId)
            const heartbeatBeforeFence = yield* runs.heartbeat(engineRunId, ownerA, yield* Clock.currentTimeMillis)
            const summary = yield* DisasterRecovery.fence(restored.manifest)
            const heartbeatAfterFence = yield* runs.heartbeat(engineRunId, ownerA, yield* Clock.currentTimeMillis)
            const engine = yield* EngineStore.make({
              owner: { hostId: ownerB.hostId },
              journalSource: "restore-drill-engine-restored",
              isAlive: () => Effect.succeed(false)
            })
            yield* engine.register(flow, handler)
            const value = yield* engine.execute(flow, {
              executionId: engineRunId,
              payload: {},
              discard: false
            })
            return {
              beforeFenceRow,
              heartbeatBeforeFence,
              summary,
              heartbeatAfterFence,
              value,
              row: yield* runs.get(engineRunId)
            }
          }).pipe(Effect.provide(services(restored.databaseFile, restored.objectsDirectory, ownerB)))
        )
      )

      expect(drill.beforeFenceRow.status).toBe("running")
      expect(drill.beforeFenceRow.owner).toEqual(ownerA)
      expect(drill.heartbeatBeforeFence).toEqual({ _tag: "Updated" })
      expect(drill.summary).toEqual({ clearedClaims: 0, suspendedRuns: 1 })
      expect(drill.heartbeatAfterFence).toEqual({ _tag: "FenceLost" })
      expect(drill.value).toBe("recorded-live/inflight-restored")
      expect(drill.row.status).toBe("completed")
      expect(counters).toEqual({ recorded: 1, inflightLive: 1, inflightRestored: 1 })
    }))

  it.effect("hot-backs-up mid-action, fences the pre-backup owner, and resumes on the restored store", () =>
    Effect.gen(function*() {
      const base = mkdtempSync(join(tmpdir(), "flows-drill-"))
      mkdirSync(join(base, "live"), { recursive: true })
      const liveDatabase = join(base, "live", DisasterRecovery.databaseFileName)
      const liveObjects = join(base, "live", DisasterRecovery.objectsDirectoryName)
      const backupDirectory = join(base, "backup")
      const targetDirectory = join(base, "restored")

      // Phase 1 — a live engine takes real writes, and the backup is captured
      // mid-action from a second connection to the same file.
      const live = yield* withCrypto(
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const journal = yield* Journal.Journal
          const artifacts = yield* ArtifactStore.ArtifactStore

          yield* runs.create(runId, "{}")
          const created = yield* runs.get(runId)
          const activatedAt = yield* Clock.currentTimeMillis
          const activated = yield* runs.claimAndOwn(runId, snapshotOf(created), ownerA, activatedAt)

          // A second run holding a pending claim, so the drill covers claim
          // invalidation too.
          yield* runs.create(claimedRunId, "{}")
          const claimedRow = yield* runs.get(claimedRunId)
          const claimedAt = yield* Clock.currentTimeMillis
          const claimed = yield* runs.claim(claimedRunId, snapshotOf(claimedRow), staleClaimant, claimedAt)

          const digestOne = yield* artifacts.put(encoder.encode("drill-artifact-one"))
          const recordedCounter = { count: 0 }
          const recorded = yield* dispatch({
            owner: ownerA,
            key: "drill/recorded",
            execute: counted(recordedCounter, "recorded-live")
          })

          // Real writes that are provably inside the snapshot.
          for (let seq = 0; seq < 5; seq++) {
            yield* journal.emitDurable(hotEvent(seq), ownerA)
          }

          // An admitted attempt still executing when the backup runs.
          const gate = yield* Deferred.make<void>()
          const started = yield* Deferred.make<void>()
          const inflight = yield* dispatch({
            owner: ownerA,
            key: "drill/inflight",
            execute: Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as("inflight-live")
            )
          }).pipe(Effect.forkChild({ startImmediately: true }))
          // Signalled from the body after durable admission; a sleep-poll
          // here would park forever on the frozen TestClock.
          yield* Deferred.await(started)
          expect(
            Option.isSome(yield* attempts.get({ runId, stepKeyDigest: sha256("drill/inflight"), attempt: 1 }))
          ).toBe(true)

          // A journal writer that keeps appending while the backup runs.
          let hotSeq = 5
          const writer = yield* Effect.gen(function*() {
            yield* journal.emitDurable(hotEvent(hotSeq), ownerA)
            hotSeq++
            yield* Effect.sleep(Duration.millis(2))
          }).pipe(Effect.forever, Effect.forkChild({ startImmediately: true }))

          // The hot backup, over its own connection — the operator's view of a
          // live store.
          const manifest = yield* DisasterRecovery.backup({
            directory: backupDirectory,
            objectsDirectory: liveObjects,
            snapshotDatabaseLayer: (databaseFile) => NodeDatabase.layer({ filename: databaseFile })
          }).pipe(Effect.provide(NodeDatabase.layer({ filename: liveDatabase })))

          yield* Fiber.interrupt(writer)
          yield* Deferred.succeed(gate, undefined)
          const inflightLive = yield* Fiber.join(inflight)

          // Post-backup divergence: work that must be absent from the restore.
          const digestTwo = yield* artifacts.put(encoder.encode("drill-artifact-two"))
          const afterCounter = { count: 0 }
          yield* dispatch({ owner: ownerA, key: "drill/after", execute: counted(afterCounter, "after-live") })

          const row = yield* runs.get(runId)
          const hotEvents = yield* hotEventCount
          return {
            activated,
            claimed,
            digestOne,
            digestTwo,
            recorded,
            recordedExecutions: recordedCounter.count,
            inflightLive,
            manifest,
            row,
            hotEvents
          }
        }).pipe(Effect.provide(services(liveDatabase, liveObjects)))
      )

      expect(live.activated).toEqual({ _tag: "Activated" })
      expect(live.claimed._tag).toBe("Claimed")
      expect(live.recorded).toBe("recorded-live")
      expect(live.recordedExecutions).toBe(1)
      expect(live.inflightLive).toBe("inflight-live")
      // The backup was captured while the run was running under a live owner.
      expect(live.row.status).toBe("running")
      expect(live.row.owner).toEqual(ownerA)
      // The snapshot carries the pre-backup artifact and none of the later work.
      expect(live.manifest.artifacts.map((entry) => entry.digest)).toContain(live.digestOne)
      expect(live.manifest.artifacts.map((entry) => entry.digest)).not.toContain(live.digestTwo)

      // Phase 2 — restore the backup into a fresh directory, files only.
      const restored = yield* withCrypto(
        DisasterRecovery.restore({ backupDirectory, targetDirectory }).pipe(
          Effect.provide(NodeFileSystem.layer)
        )
      )
      expect(restored.databaseFile).toBe(join(targetDirectory, DisasterRecovery.databaseFileName))

      // Phase 3 — the restored store: fence, prove the old owner is out, resume
      // under a new owner.
      const drill = yield* withCrypto(
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const journal = yield* Journal.Journal
          const artifacts = yield* ArtifactStore.ArtifactStore

          // The resurrection hazard the fence closes: before fencing, the
          // restored store still records ownerA, so its heartbeat lands.
          const preFenceAt = yield* Clock.currentTimeMillis
          const preFenceHeartbeat = yield* runs.heartbeat(runId, ownerA, preFenceAt)
          const preFenceRow = yield* runs.get(runId)

          const summary = yield* DisasterRecovery.fence(restored.manifest)

          // Every fenced operation from the pre-backup owner is now refused.
          const fencedAt = yield* Clock.currentTimeMillis
          const fencedHeartbeat = yield* runs.heartbeat(runId, ownerA, fencedAt)
          const fencedTransition = yield* runs.transitionOwned(runId, ownerA, "completed")
          const fencedAppend = yield* journal.emitDurable(
            new Input({
              runId: runId as RunId,
              sourceId: "drill-zombie" as SourceId,
              sourceSeq: 0 as SourceSeq,
              eventType: "drill.zombie",
              payload: null
            }, { disableChecks: true }),
            ownerA
          ).pipe(Effect.exit)

          const fencedRow = yield* runs.get(runId)
          const claimedRow = yield* runs.get(claimedRunId)
          const reclaimAt = yield* Clock.currentTimeMillis
          const reclaimed = yield* runs.claim(claimedRunId, snapshotOf(claimedRow), freshClaimant, reclaimAt)

          // The captured history is intact, and the post-backup work is absent.
          const hotEvents = yield* hotEventCount
          const recordedRow = yield* attempts.get({
            runId,
            stepKeyDigest: sha256("drill/recorded"),
            attempt: 1
          })
          const inflightRow = yield* attempts.get({
            runId,
            stepKeyDigest: sha256("drill/inflight"),
            attempt: 1
          })
          const afterRow = yield* attempts.get({ runId, stepKeyDigest: sha256("drill/after"), attempt: 1 })

          // Resume under a fresh owner: the suspended run is claimable
          // immediately, with no staleness wait and no liveness evidence.
          const resumeAt = yield* Clock.currentTimeMillis
          const resumed = yield* runs.claimAndOwn(runId, snapshotOf(fencedRow), ownerB, resumeAt)

          const replayCounter = { count: 0 }
          const replayed = yield* dispatch({
            owner: ownerB,
            key: "drill/recorded",
            execute: counted(replayCounter, "must-not-run")
          })
          const inflightCounter = { count: 0 }
          const inflightRestored = yield* dispatch({
            owner: ownerB,
            key: "drill/inflight",
            execute: counted(inflightCounter, "inflight-restored")
          })
          const afterCounter = { count: 0 }
          const afterRestored = yield* dispatch({
            owner: ownerB,
            key: "drill/after",
            execute: counted(afterCounter, "after-restored")
          })

          const artifactOne = yield* artifacts.get(live.digestOne)
          const artifactTwo = yield* artifacts.get(live.digestTwo).pipe(Effect.exit)
          const completed = yield* runs.transitionOwned(runId, ownerB, "completed")
          return {
            preFenceHeartbeat,
            preFenceRow,
            summary,
            fencedHeartbeat,
            fencedTransition,
            fencedAppend,
            fencedRow,
            claimedRow,
            reclaimed,
            hotEvents,
            recordedRow,
            inflightRow,
            afterRow,
            resumed,
            replayed,
            replayExecutions: replayCounter.count,
            inflightRestored,
            inflightExecutions: inflightCounter.count,
            afterRestored,
            afterExecutions: afterCounter.count,
            artifactOne,
            artifactTwo,
            completed
          }
        }).pipe(Effect.provide(services(restored.databaseFile, restored.objectsDirectory)))
      )

      // The hazard, then the fence.
      expect(drill.preFenceHeartbeat).toEqual({ _tag: "Updated" })
      expect(drill.preFenceRow.status).toBe("running")
      expect(drill.preFenceRow.owner).toEqual(ownerA)
      expect(drill.summary).toEqual({ clearedClaims: 1, suspendedRuns: 1 })
      // The pre-backup owner is fenced out of the restored store.
      expect(drill.fencedHeartbeat).toEqual({ _tag: "FenceLost" })
      expect(drill.fencedTransition).toEqual({ _tag: "FenceLost" })
      expect(Exit.isFailure(drill.fencedAppend)).toBe(true)
      if (!Exit.isFailure(drill.fencedAppend)) {
        throw new Error("expected the restored zombie append to be fenced")
      }
      expect((Cause.squash(drill.fencedAppend.cause) as { code: string }).code).toBe("fence_lost")
      expect(drill.fencedRow.status).toBe("suspended")
      expect(drill.fencedRow.owner).toBeNull()
      // The stale claim is gone and the run is claimable by anyone fresh.
      expect(drill.claimedRow.claim).toBeNull()
      expect(drill.reclaimed._tag).toBe("Claimed")
      // The captured history survived the round trip; the divergence did not.
      expect(drill.hotEvents).toBeGreaterThanOrEqual(5)
      expect(drill.hotEvents).toBeLessThanOrEqual(live.hotEvents)
      expect(Option.getOrThrow(drill.recordedRow).state).toBe("succeeded")
      expect(Option.getOrThrow(drill.inflightRow).state).toBe("running")
      expect(Option.isNone(drill.afterRow)).toBe(true)
      // The engine resumes from the restored state: recorded work replays
      // without re-executing, in-flight work re-executes, missing work reruns.
      expect(drill.resumed).toEqual({ _tag: "Activated" })
      expect(drill.replayed).toBe("recorded-live")
      expect(drill.replayExecutions).toBe(0)
      expect(drill.inflightRestored).toBe("inflight-restored")
      expect(drill.inflightExecutions).toBe(1)
      expect(drill.afterRestored).toBe("after-restored")
      expect(drill.afterExecutions).toBe(1)
      expect(new TextDecoder().decode(drill.artifactOne)).toBe("drill-artifact-one")
      expect(Exit.isFailure(drill.artifactTwo)).toBe(true)
      expect(drill.completed).toEqual({ _tag: "Transitioned" })

      // Phase 4 — the source store is untouched: its owner still holds the
      // fence there, and the post-backup work is present.
      const source = yield* withCrypto(
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const nowMs = yield* Clock.currentTimeMillis
          return {
            heartbeat: yield* runs.heartbeat(runId, ownerA, nowMs),
            afterRow: yield* attempts.get({ runId, stepKeyDigest: sha256("drill/after"), attempt: 1 })
          }
        }).pipe(Effect.provide(services(liveDatabase, liveObjects)))
      )
      expect(source.heartbeat).toEqual({ _tag: "Updated" })
      expect(Option.getOrThrow(source.afterRow).state).toBe("succeeded")
    }))
})
