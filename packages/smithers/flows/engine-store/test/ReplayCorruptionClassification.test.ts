/**
 * Issue #150: every `replayOutputs` failure — including a digest mismatch at
 * the content-addressed blob path, an integrity violation of the store's
 * strongest invariant — was journalled as one undifferentiated
 * `replay_failed` provenance row and never routed to the Inconsistency
 * receiver, so a failing disk corrupting many blobs looked identical to a
 * one-off transient EIO. Materialization failures are now classified once:
 * a `BoundaryCorruption` routes to `Inconsistency.noteCorruption` (core
 * default STRICT — the dispatch fails with `CacheCorruptionDetected`; a
 * tolerant receiver lets it fall back to the healing re-execution), while
 * transient host errors stay retryable and never reach the receiver. Both
 * classes journal their `reason` on the `replay_failed` provenance record.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as EngineStoreMetrics from "../src/EngineStoreMetrics.ts"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { runPromise, sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "corruption-host", pid: 91, nonce: "corruption-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["dist/manifest.json"],
  boundaryMode: "hard"
}

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({ commitId: "corruption-snapshot" as never, changeId: "corruption-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

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

const dispatch = (runId: string, key: string, execute: () => Effect.Effect<unknown, unknown>, attempt = 1) =>
  ActionPersistence.make({ runId, owner, sourceId: `corruption-${runId}`, execute })({
    action: {},
    attempt,
    key,
    tier: "sealed",
    metadata: declared
  })

const corruptionError = new StepBoundary.BoundaryCorruption({
  code: "boundary_corruption",
  path: "dist/manifest.json",
  recordedDigest: "aa".repeat(32),
  measuredDigest: "bb".repeat(32)
})

/** A boundary that verifies the read set but fails materialization with `error`. */
const failingReplay = (error: StepBoundary.UnsupportedBoundary | StepBoundary.BoundaryCorruption) =>
  Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.make({
      prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
      settle: () =>
        Effect.succeed({
          declaredOutputs: { outputs: [{ path: "dist/manifest.json", digest: sha256("recorded") }] },
          diffIdentity: "corruption-diff",
          wholeTreeWritesVerified: true,
          hermeticReadsVerified: true
        }),
      replayOutputs: () => Effect.fail(error)
    })
  )

const records = (runId: string, eventType: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 50 })
    return page.entries
      .filter((entry) => entry.eventType === eventType)
      .map((entry) => entry.payload as Record<string, unknown>)
  })

describe("replay-failed classification (issue #150)", () => {
  it.effect("the noop receiver tolerates corruption by default", () =>
    Effect.gen(function*() {
      const verdict = yield* withCrypto(
        Inconsistency.makeNoop().noteCorruption({
          runId: "noop-run",
          keyDigest: "noop-key",
          path: "dist/manifest.json",
          recordedDigest: "aa".repeat(32),
          measuredDigest: "bb".repeat(32)
        })
      )
      expect(verdict).toBe("tolerate")
    }))

  it.effect("routes blob corruption on a verified hit to the Inconsistency receiver and fails strictly by default", () =>
    Effect.gen(function*() {
      const key = "corruption/strict-hit"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("corruption-strict-first")
          yield* dispatch("corruption-strict-first", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(failingReplay(corruptionError))
          )
          yield* activate("corruption-strict-second")
          const failed = yield* dispatch("corruption-strict-second", key, () => Effect.die("must not execute")).pipe(
            Effect.provide(failingReplay(corruptionError)),
            Effect.flip
          )
          const provenance = yield* records("corruption-strict-second", "flows.engine.cache-provenance")
          const corruption = yield* records("corruption-strict-second", "flows.engine.cache-corruption")
          return { failed, provenance, corruption }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.failed).toBeInstanceOf(ActionPersistence.CacheCorruptionDetected)
      const failure = outcome.failed as ActionPersistence.CacheCorruptionDetected
      expect(failure.code).toBe("cache_corruption_detected")
      expect(failure.path).toBe("dist/manifest.json")
      // The refusal record names its class — never an undifferentiated row.
      const refused = outcome.provenance.find((payload) => payload.action === "replay_failed")
      expect(refused?.reason).toBe("corruption")
      // The corruption reached the receiver's durable journal channel.
      expect(outcome.corruption).toHaveLength(1)
      expect(outcome.corruption[0]).toMatchObject({
        keyDigest: sha256(key),
        verdict: "fail",
        path: "dist/manifest.json",
        recordedDigest: "aa".repeat(32),
        measuredDigest: "bb".repeat(32)
      })
    }))

  it.effect("falls back to the healing re-execution when the receiver tolerates corruption", () =>
    Effect.gen(function*() {
      const key = "corruption/tolerated-hit"
      const noted: Array<Inconsistency.BlobCorruption> = []
      const tolerant = Layer.succeed(Inconsistency.Inconsistency)(
        Inconsistency.makeNoop({
          noteCorruption: (event) =>
            Effect.sync(() => {
              noted.push(event)
              return "tolerate" as const
            })
        })
      )
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          let executions = 0
          const body = () =>
            Effect.sync(() => {
              executions++
              return "recorded"
            })
          yield* activate("corruption-tolerated-first")
          yield* dispatch("corruption-tolerated-first", key, body).pipe(
            Effect.provide(Layer.mergeAll(failingReplay(corruptionError), tolerant))
          )
          yield* activate("corruption-tolerated-second")
          const second = yield* dispatch("corruption-tolerated-second", key, body).pipe(
            Effect.provide(Layer.mergeAll(failingReplay(corruptionError), tolerant))
          )
          return { executions, second }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // The tolerated corruption is not a hit: the body re-executes for real.
      expect(outcome.second).toBe("recorded")
      expect(outcome.executions).toBe(2)
      expect(noted).toHaveLength(1)
      expect(noted[0]).toMatchObject({ keyDigest: sha256(key), path: "dist/manifest.json" })
    }))

  it.effect("keeps transient host errors retryable and never routes them to the receiver", () =>
    Effect.gen(function*() {
      const key = "corruption/host-error"
      const hostError = new StepBoundary.UnsupportedBoundary({
        code: "unsupported_boundary",
        message: "EIO: transient host failure"
      })
      const noted: Array<Inconsistency.BlobCorruption> = []
      const watching = Layer.succeed(Inconsistency.Inconsistency)(
        Inconsistency.makeNoop({
          noteCorruption: (event) =>
            Effect.sync(() => {
              noted.push(event)
              return "fail" as const
            })
        })
      )
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          let executions = 0
          const body = () =>
            Effect.sync(() => {
              executions++
              return "recorded"
            })
          yield* activate("corruption-host-first")
          yield* dispatch("corruption-host-first", key, body).pipe(
            Effect.provide(Layer.mergeAll(failingReplay(hostError), watching))
          )
          yield* activate("corruption-host-second")
          const second = yield* dispatch("corruption-host-second", key, body).pipe(
            Effect.provide(Layer.mergeAll(failingReplay(hostError), watching))
          )
          const provenance = yield* records("corruption-host-second", "flows.engine.cache-provenance")
          return { executions, second, provenance }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // A transient refusal falls back to a real execution — even under a
      // receiver whose corruption verdict is "fail" — because it is not
      // corruption.
      expect(outcome.second).toBe("recorded")
      expect(outcome.executions).toBe(2)
      expect(noted).toHaveLength(0)
      const refused = outcome.provenance.find((payload) => payload.action === "replay_failed")
      expect(refused?.reason).toBe("host")
    }))

  it.effect("quarantines corrupt succeeded-row evidence so the next dispatch heals (issue #171)", () =>
    Effect.gen(function*() {
      const key = "corruption/succeeded-row"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate("corruption-row")
          yield* dispatch("corruption-row", key, () => Effect.succeed("durable-outcome")).pipe(
            Effect.provide(failingReplay(corruptionError))
          )
          // Evicting the cache row routes the re-dispatch to the succeeded
          // attempt row's replay branch rather than the cache-hit gate.
          yield* cache.evict(sha256(key))
          const failed = yield* Effect.exit(
            dispatch("corruption-row", key, () => Effect.die("must not re-execute")).pipe(
              Effect.provide(failingReplay(corruptionError))
            )
          )
          // The first detection quarantines only the corrupt boundary evidence.
          // A second dispatch returns the durable outcome without replaying the
          // poison or re-executing the already-succeeded action.
          const healed = yield* dispatch(
            "corruption-row",
            key,
            () => Effect.die("must not re-execute")
          ).pipe(
            Effect.provide(failingReplay(corruptionError))
          )
          const provenance = yield* records("corruption-row", "flows.engine.cache-provenance")
          const corruption = yield* records("corruption-row", "flows.engine.cache-corruption")
          const attempts = yield* AttemptStore.AttemptStore
          const row = yield* attempts.get({
            runId: "corruption-row",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          return { failed, healed, provenance, corruption, row }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // The failure is the TYPED quarantine error, not the evictable-cache
      // corruption class: the driver keys the operator park off it.
      expect(Exit.isFailure(outcome.failed) && Cause.squash(outcome.failed.cause))
        .toBeInstanceOf(ActionPersistence.AttemptEvidenceQuarantined)
      const failure = Cause.squash(
        (outcome.failed as Exit.Failure<never, never>).cause
      ) as ActionPersistence.AttemptEvidenceQuarantined
      expect(failure.code).toBe("attempt_evidence_quarantined")
      expect(failure.keyDigest).toBe(sha256(key))
      expect(outcome.healed).toBe("durable-outcome")
      // The completion and its outcome remain durable; only the poisoned replay
      // evidence is removed and marked quarantined.
      expect(Option.getOrThrow(outcome.row).state).toBe("succeeded")
      expect(Option.getOrThrow(outcome.row).meta).toMatchObject({
        tier: "sealed",
        boundaryQuarantined: true
      })
      expect(Option.getOrThrow(outcome.row).meta).not.toHaveProperty("boundary")
      const refused = outcome.provenance.find((payload) => payload.action === "replay_failed")
      expect(refused?.reason).toBe("corruption")
      // Attempt-row evidence carries no cache provenance; the record says so
      // explicitly instead of inventing one.
      expect(outcome.corruption).toHaveLength(1)
      expect(outcome.corruption[0]).toMatchObject({ recordedRunId: null, recordedEventSeq: null })
    }))

  it.effect.each(["fence", "row"] as const)(
    "interrupts when the %s changes before succeeded-row evidence quarantine",
    (failure) =>
      Effect.gen(function*() {
        const runId = `corruption-quarantine-${failure}`
        const key = `corruption/quarantine-${failure}`
        const outcome = yield* withCrypto(
          Effect.gen(function*() {
            const cache = yield* CacheStore.CacheStore
            const runs = yield* RunStore.RunStore
            const attempts = yield* AttemptStore.AttemptStore
            yield* activate(runId)
            yield* dispatch(runId, key, () => Effect.succeed("durable-outcome")).pipe(
              Effect.provide(failingReplay(corruptionError))
            )
            yield* cache.evict(sha256(key))

            let heartbeats = 0
            const guardedRuns: RunStore.Service = {
              ...runs,
              heartbeat: (heartbeatRunId, heartbeatOwner, nowMs) => {
                heartbeats++
                return failure === "fence" && heartbeats === 2
                  ? Effect.succeed({ _tag: "FenceLost" } as const)
                  : runs.heartbeat(heartbeatRunId, heartbeatOwner, nowMs)
              }
            }
            const guardedAttempts: AttemptStore.Service = {
              ...attempts,
              patch: failure === "row"
                ? () => Effect.succeed({ _tag: "NotFound" } as const)
                : attempts.patch
            }
            const interrupted = yield* dispatch(
              runId,
              key,
              () => Effect.die("must not re-execute")
            ).pipe(
              Effect.provide(failingReplay(corruptionError)),
              Effect.provideService(RunStore.RunStore, guardedRuns),
              Effect.provideService(AttemptStore.AttemptStore, guardedAttempts),
              Effect.exit
            )
            return {
              interrupted,
              row: yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
            }
          }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
        )

        expect(Exit.isFailure(outcome.interrupted) && Cause.hasInterruptsOnly(outcome.interrupted.cause)).toBe(true)
        expect(Option.getOrThrow(outcome.row).meta).toHaveProperty("boundary")
        expect(Option.getOrThrow(outcome.row).meta).not.toHaveProperty("boundaryQuarantined")
      })
  )

  it.effect("returns the durable outcome when a tolerant receiver accepts succeeded-row corruption", () =>
    Effect.gen(function*() {
      const key = "corruption/succeeded-tolerated"
      const tolerant = Inconsistency.layerTolerant(owner)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate("corruption-row-tolerated")
          yield* dispatch("corruption-row-tolerated", key, () => Effect.succeed("durable-outcome")).pipe(
            Effect.provide(Layer.mergeAll(failingReplay(corruptionError), tolerant))
          )
          yield* cache.evict(sha256(key))
          return yield* dispatch("corruption-row-tolerated", key, () => Effect.die("must not re-execute")).pipe(
            Effect.provide(Layer.mergeAll(failingReplay(corruptionError), tolerant))
          )
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // The attempt durably succeeded: under a tolerant verdict its recorded
      // outcome remains the truth.
      expect(outcome).toBe("durable-outcome")
    }))

  it.effect("quarantines tolerated succeeded-row corruption instead of converging it into the shared cache (issue #160)", () =>
    Effect.gen(function*() {
      const key = "corruption/succeeded-quarantined"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate("corruption-quarantine")
          yield* dispatch("corruption-quarantine", key, () => Effect.succeed("durable-outcome")).pipe(
            Effect.provide(Layer.mergeAll(failingReplay(corruptionError), Inconsistency.layerTolerant(owner)))
          )
          // Route the re-dispatch to the succeeded-row branch, whose issue-#24
          // convergence block would republish the row.
          yield* cache.evict(sha256(key))
          const replayed = yield* dispatch("corruption-quarantine", key, () => Effect.die("must not re-execute")).pipe(
            Effect.provide(Layer.mergeAll(failingReplay(corruptionError), Inconsistency.layerTolerant(owner)))
          )
          const cached = yield* cache.get(sha256(key))
          return { replayed, cached }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // The durable outcome is still the truth for this run…
      expect(outcome.replayed).toBe("durable-outcome")
      // …but evidence just measured corrupt never converges into the shared
      // cache for sibling runs: the row is quarantined, not recorded.
      expect(Option.isNone(outcome.cached)).toBe(true)
    }))

  it.effect("converges an idempotency conflict on the corruption record but propagates other journal failures", () =>
    Effect.gen(function*() {
      // The dedupe identity (issue #156) makes a cross-lineage duplicate an
      // `idempotency_conflict` — the evidence already exists, so the receiver
      // still returns its verdict. Any other journal failure is real.
      const event = {
        runId: "dedupe-conflict",
        keyDigest: "k",
        path: "dist/manifest.json",
        recordedDigest: "aa".repeat(32),
        measuredDigest: "bb".repeat(32)
      }
      const failing = (code: "idempotency_conflict" | "fence_lost") =>
        Inconsistency.make({
          journal: Journal.makeNoop({
            emitDurable: () => Effect.fail(new Journal.JournalError({ code, message: code }))
          }),
          verdict: "fail",
          owner
        })
      const converged = yield* withCrypto(failing("idempotency_conflict").noteCorruption(event))
      expect(converged).toBe("fail")
      const propagated = yield* withCrypto(Effect.flip(failing("fence_lost").noteCorruption(event)))
      expect(propagated).toMatchObject({ code: "fence_lost" })
    }))

  it.effect("evicts the poisoned row on detected corruption so the next dispatch re-executes cleanly (issue #164)", () =>
    Effect.gen(function*() {
      // Quarantine is journal AND evict: routing to the receiver without
      // removing the row left inline-corrupt evidence in place forever —
      // `CacheStore.put` is insert-or-nothing, so strict mode re-failed every
      // later run on the key and tolerant mode re-detected and re-executed
      // with no heal possible.
      const key = "corruption/quarantine-evicts"
      const healthyReplay = Layer.succeed(
        StepBoundary.StepBoundary,
        StepBoundary.make({
          prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
          settle: () =>
            Effect.succeed({
              declaredOutputs: { outputs: [{ path: "dist/manifest.json", digest: sha256("recorded") }] },
              diffIdentity: "corruption-diff",
              wholeTreeWritesVerified: true,
              hermeticReadsVerified: true
            }),
          replayOutputs: () => Effect.void
        })
      )
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate("corruption-evict-first")
          yield* dispatch("corruption-evict-first", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(failingReplay(corruptionError))
          )
          yield* activate("corruption-evict-second")
          const failed = yield* dispatch("corruption-evict-second", key, () => Effect.die("must not execute")).pipe(
            Effect.provide(failingReplay(corruptionError)),
            Effect.flip
          )
          const evicted = yield* cache.get(sha256(key))
          // The same key dispatched again — with a healthy boundary — must be
          // an ordinary miss that re-executes and re-records cleanly, not a
          // re-detection of the quarantined row.
          yield* activate("corruption-evict-third")
          let executions = 0
          const healed = yield* dispatch("corruption-evict-third", key, () =>
            Effect.sync(() => {
              executions++
              return "healed"
            })).pipe(Effect.provide(healthyReplay))
          const recorded = yield* cache.get(sha256(key))
          return { failed, evicted, healed, executions, recorded }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.failed).toBeInstanceOf(ActionPersistence.CacheCorruptionDetected)
      expect(Option.isNone(outcome.evicted)).toBe(true)
      expect(outcome.healed).toBe("healed")
      expect(outcome.executions).toBe(1)
      expect(Option.isSome(outcome.recorded)).toBe(true)
    }))

  it.effect("keeps a fresh competing row when corruption quarantine reaches its fenced evict (issue #173)", () =>
    Effect.gen(function*() {
      const key = "corruption/quarantine-fenced"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate("corruption-fence-first")
          yield* dispatch("corruption-fence-first", key, () => Effect.succeed("poisoned")).pipe(
            Effect.provide(failingReplay(corruptionError))
          )
          const poisoned = yield* cache.get(keyDigest)
          if (Option.isNone(poisoned)) return yield* Effect.die(new Error("poisoned row missing"))
          const fresh = {
            ...poisoned.value,
            result: "fresh",
            recordedRunId: "corruption-fence-fresh",
            recordedEventSeq: poisoned.value.recordedEventSeq + 1
          }
          let replacementLanded = false
          const racingCache: CacheStore.Service = {
            ...cache,
            evict: (digest, options) =>
              Effect.gen(function*() {
                // A sibling run replaces the poisoned generation after this
                // dispatch read it but before its quarantine delete lands.
                yield* cache.evict(digest)
                const put = yield* cache.put(fresh)
                replacementLanded = put._tag === "Inserted"
                return yield* cache.evict(digest, options)
              })
          }
          yield* activate("corruption-fence-second")
          const failed = yield* dispatch(
            "corruption-fence-second",
            key,
            () => Effect.die("must not execute")
          ).pipe(
            Effect.provide(failingReplay(corruptionError)),
            Effect.provideService(CacheStore.CacheStore, racingCache),
            Effect.flip
          )
          return { failed, replacementLanded, survivor: yield* cache.get(keyDigest) }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )

      expect(outcome.failed).toBeInstanceOf(ActionPersistence.CacheCorruptionDetected)
      expect(outcome.replacementLanded).toBe(true)
      expect(Option.getOrThrow(outcome.survivor)).toMatchObject({
        result: "fresh",
        recordedRunId: "corruption-fence-fresh"
      })
    }))

  it.effect(
    "heals a genuinely truncated artifact through corruption eviction and clean replay (issue #174)",
    () =>
      Effect.gen(function*() {
        const root = mkdtempSync(join(tmpdir(), "flows-corruption-heal-"))
        const key = "corruption/real-truncated-blob"
        const keyDigest = sha256(key)
        const inputPath = join(root, "src/input.txt")
        const outputPath = join(root, "dist/artifact.bin")
        const objectsDirectory = join(root, ".flows/objects")
        const artifact = new TextEncoder().encode("clean-artifact".repeat(100_000))
        const artifactDigest = sha256(artifact)
        const artifactPath = join(objectsDirectory, artifactDigest.slice(0, 2), artifactDigest)
        const metadata: ActionPersistence.BoundaryMetadata = {
          readSet: [{ path: "src/input.txt", digest: sha256("source") }],
          writeSet: ["dist/artifact.bin"],
          boundaryMode: "hard"
        }
        // The kernel-guarded filesystem rooted at the workspace: declarations are
        // workspace-relative, and replay refuses evidence naming anything else.
        const host = KernelFileSystem.layer.pipe(
          Layer.provide(AtomicFileSystem.layer),
          Layer.provideMerge(NodePath.layer),
          Layer.provide(KernelWorkspace.layer(root)),
          Layer.provide(GrantStore.layerNoop)
        )
        // Match NodeRuntime.layerHost: persistence owns a trusted filesystem,
        // while workspace reads and writes keep the descriptor-relative guard.
        // Required durability exercises retained file and directory handles.
        const artifacts = Layer.merge(
          ArtifactStore.layerFileSystem({ directory: objectsDirectory }).pipe(
            Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
          ),
          host
        )
        const production = Layer.merge(
          StepBoundary.layer.pipe(Layer.provide(artifacts)),
          WorkspaceSandbox.layerFileSystem().pipe(
            Layer.provide(artifacts),
            Layer.provide(KernelWorkspace.layer(root))
          )
        ).pipe(Layer.provideMerge(artifacts))

        try {
          const outcome = yield* withCrypto(
            Effect.gen(function*() {
              const cache = yield* CacheStore.CacheStore
              const fs = yield* FileSystem.FileSystem
              yield* fs.makeDirectory(join(root, "src"), { recursive: true })
              yield* fs.writeFileString(inputPath, "source")
              let executions = 0
              const execute = () =>
                Effect.gen(function*() {
                  executions++
                  const sandboxFs = yield* FileSystem.FileSystem
                  yield* sandboxFs.writeFile("dist/artifact.bin", artifact)
                  return "recorded"
                }).pipe(Effect.orDie) as unknown as Effect.Effect<unknown, unknown>
              const realDispatch = (runId: string) =>
                ActionPersistence.make({ runId, owner, sourceId: `corruption-${runId}`, execute })({
                  action: {},
                  attempt: 1,
                  key,
                  tier: "sealed",
                  metadata
                })

              yield* activate("corruption-real-first")
              yield* realDispatch("corruption-real-first")
              const poisoned = yield* cache.get(keyDigest)
              if (Option.isNone(poisoned)) return yield* Effect.die(new Error("poisoned row missing"))
              expect(yield* fs.exists(artifactPath)).toBe(true)

              // Damage the actual content-addressed file after capture. The next
              // replay must discover this through ArtifactStore's digest check.
              yield* fs.writeFileString(artifactPath, "truncated")
              yield* fs.remove(outputPath)

              let evictionResult: boolean | undefined
              let cacheAbsentAtEvict = false
              const observingCache: CacheStore.Service = {
                ...cache,
                evict: (digest, options) =>
                  Effect.gen(function*() {
                    evictionResult = yield* cache.evict(digest, options)
                    cacheAbsentAtEvict = Option.isNone(yield* cache.get(digest))
                    return evictionResult
                  })
              }
              yield* activate("corruption-real-second")
              const healed = yield* realDispatch("corruption-real-second").pipe(
                Effect.provide(Inconsistency.layerTolerant(owner)),
                Effect.provideService(CacheStore.CacheStore, observingCache)
              )
              const recorded = yield* cache.get(keyDigest)
              const provenance = yield* records("corruption-real-second", "flows.engine.cache-provenance")
              const corruption = yield* records("corruption-real-second", "flows.engine.cache-corruption")
              const healedBlob = yield* fs.readFile(artifactPath)

              // Remove the materialized output once more. The third run must be a
              // clean cache hit that restores it without executing the body.
              yield* fs.remove(outputPath)
              yield* activate("corruption-real-third")
              const replayed = yield* realDispatch("corruption-real-third")
              const replayedOutput = yield* fs.readFile(outputPath)
              const hit = yield* records("corruption-real-third", "flows.engine.cache-provenance")
              return {
                cacheAbsentAtEvict,
                corruption,
                evictionResult,
                executions,
                healed,
                healedBlob,
                hit,
                provenance,
                recorded,
                replayed,
                replayedOutput
              }
            }).pipe(
              Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer, production)),
              Effect.scoped
            )
          )

          expect(outcome.evictionResult).toBe(true)
          expect(outcome.cacheAbsentAtEvict).toBe(true)
          expect(outcome.healed).toBe("recorded")
          expect(outcome.executions).toBe(2)
          expect(Option.getOrThrow(outcome.recorded).recordedRunId).toBe("corruption-real-second")
          expect(sha256(outcome.healedBlob)).toBe(artifactDigest)
          expect(outcome.provenance.find((payload) => payload.action === "replay_failed")?.reason)
            .toBe("corruption")
          expect(outcome.corruption).toEqual([
            expect.objectContaining({
              keyDigest,
              path: "dist/artifact.bin",
              recordedDigest: artifactDigest,
              measuredDigest: sha256("truncated")
            })
          ])
          expect(outcome.replayed).toBe("recorded")
          expect(sha256(outcome.replayedOutput)).toBe(artifactDigest)
          expect(outcome.hit).toEqual([
            expect.objectContaining({ keyDigest, recordedRunId: "corruption-real-second" })
          ])
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }),
    { timeout: 120_000 }
  )

  it.effect("replaces the poisoned row when a tolerant receiver falls back to re-execution (issue #164)", () =>
    Effect.gen(function*() {
      const key = "corruption/quarantine-replaces"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate("corruption-replace-first")
          yield* dispatch("corruption-replace-first", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(Layer.mergeAll(failingReplay(corruptionError), Inconsistency.layerTolerant(owner)))
          )
          yield* activate("corruption-replace-second")
          yield* dispatch("corruption-replace-second", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(Layer.mergeAll(failingReplay(corruptionError), Inconsistency.layerTolerant(owner)))
          )
          return yield* cache.get(sha256(key))
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // Without the evict, `CacheStore.put`'s insert-or-nothing left the first
      // run's corrupt row in place; the healing re-execution must own the row.
      expect(Option.isSome(outcome)).toBe(true)
      expect(Option.map(outcome, (entry) => entry.recordedRunId)).toEqual(Option.some("corruption-replace-second"))
    }))

  it.effect("journals identical corruption after healing as a distinct record (issue #172)", () =>
    Effect.gen(function*() {
      const key = "corruption/re-corrupted-record"
      const runId = "corruption-recorrupt"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate(runId)
          yield* dispatch(runId, key, () => Effect.succeed("recorded"), 1).pipe(
            Effect.provide(failingReplay(corruptionError))
          )

          // Both detections hit the shared cache before succeeded-attempt lookup,
          // so issue #171's attempt-evidence quarantine cannot mask this cell.
          // The first detection evicts before attempt 2 is admitted; healing can
          // therefore execute attempt 2 and publish a new row generation, which
          // attempt 3 observes with the same corruption evidence.
          const firstFailure = yield* dispatch(
            runId,
            key,
            () => Effect.die("must not execute poisoned row"),
            2
          ).pipe(Effect.provide(failingReplay(corruptionError)), Effect.flip)

          let executions = 0
          const healed = yield* dispatch(runId, key, () =>
            Effect.sync(() => {
              executions++
              return "healed"
            }), 2).pipe(Effect.provide(StepBoundary.layerTest()))

          const secondFailure = yield* dispatch(
            runId,
            key,
            () => Effect.die("must not execute re-corrupted row"),
            3
          ).pipe(Effect.provide(failingReplay(corruptionError)), Effect.flip)

          return {
            firstFailure,
            secondFailure,
            healed,
            executions,
            corruption: yield* records(runId, "flows.engine.cache-corruption")
          }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )

      expect(outcome.firstFailure).toBeInstanceOf(ActionPersistence.CacheCorruptionDetected)
      expect(outcome.secondFailure).toBeInstanceOf(ActionPersistence.CacheCorruptionDetected)
      expect(outcome.healed).toBe("healed")
      expect(outcome.executions).toBe(1)
      expect(outcome.corruption).toHaveLength(2)
      expect(outcome.corruption).toEqual([
        expect.objectContaining({
          path: corruptionError.path,
          recordedDigest: corruptionError.recordedDigest,
          measuredDigest: corruptionError.measuredDigest,
          recordedRunId: runId
        }),
        expect.objectContaining({
          path: corruptionError.path,
          recordedDigest: corruptionError.recordedDigest,
          measuredDigest: corruptionError.measuredDigest,
          recordedRunId: runId
        })
      ])
      expect(outcome.corruption[0]!.recordedEventSeq).not.toBe(outcome.corruption[1]!.recordedEventSeq)
    }))

  it.effect("journals distinct corruptions of the same key as distinct records (issue #167)", () =>
    Effect.gen(function*() {
      // The dedupe cell alone is satisfiable by a constant identity: a
      // regression dropping the digest/path interpolation from the producer
      // identity would still journal "exactly once" while silently swallowing
      // genuinely different corruption evidence through the converging
      // idempotency-conflict branch. Two observations of the SAME key whose
      // measured evidence differs must each land durably.
      const key = "corruption/distinct-records"
      const secondCorruption = new StepBoundary.BoundaryCorruption({
        code: "boundary_corruption",
        path: "dist/manifest.json",
        recordedDigest: "aa".repeat(32),
        measuredDigest: "cc".repeat(32)
      })
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate("corruption-distinct-first")
          yield* dispatch("corruption-distinct-first", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(failingReplay(corruptionError))
          )
          yield* activate("corruption-distinct-second")
          const poisoned = yield* cache.get(sha256(key))
          if (Option.isNone(poisoned)) return yield* Effect.die(new Error("row missing"))
          for (const error of [corruptionError, secondCorruption]) {
            yield* dispatch("corruption-distinct-second", key, () => Effect.die("must not execute")).pipe(
              Effect.provide(failingReplay(error)),
              Effect.flip
            )
            yield* cache.put(poisoned.value)
          }
          return yield* records("corruption-distinct-second", "flows.engine.cache-corruption")
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome).toHaveLength(2)
      expect(outcome.map((payload) => payload.measuredDigest).sort()).toEqual([
        "bb".repeat(32),
        "cc".repeat(32)
      ])
    }))

  it.effect("journals a repeated identical corruption exactly once (issue #156)", () =>
    Effect.gen(function*() {
      const key = "corruption/deduped-record"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("corruption-dedupe-first")
          yield* dispatch("corruption-dedupe-first", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(failingReplay(corruptionError))
          )
          yield* activate("corruption-dedupe-second")
          // The same corrupt evidence observed twice — since issue #164 each
          // detection evicts the row, so the second observation models the
          // cross-process race in which a sibling re-records the identical
          // corrupt row between detections. Neither observation may append a
          // second durable corruption record: the producer identity is the
          // cache key, so the re-emission collapses into a journal duplicate.
          const cache = yield* CacheStore.CacheStore
          const poisoned = yield* cache.get(sha256(key))
          if (Option.isNone(poisoned)) return yield* Effect.die(new Error("row missing"))
          for (let attempt = 1; attempt <= 2; attempt++) {
            yield* ActionPersistence.make({
              runId: "corruption-dedupe-second",
              owner,
              sourceId: "corruption-corruption-dedupe-second",
              execute: () => Effect.die("must not execute")
            })({
              action: {},
              // The attempt number varies across the two observations (issue
              // #168): folding it into either durable identity would restore
              // per-attempt journal growth while a constant-attempt cell
              // stayed green.
              attempt,
              key,
              tier: "sealed",
              metadata: declared
            }).pipe(
              Effect.provide(failingReplay(corruptionError)),
              Effect.flip
            )
            yield* cache.put(poisoned.value)
          }
          return {
            corruption: yield* records("corruption-dedupe-second", "flows.engine.cache-corruption"),
            provenance: yield* records("corruption-dedupe-second", "flows.engine.cache-provenance")
          }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.corruption).toHaveLength(1)
      // Both per-attempt durable rows converge, not just the corruption record
      // (issue #168): the replay-refusal provenance identity is
      // per-(key, action, recorded-provenance), so the varying attempt above
      // must not multiply `replay_failed` rows either.
      expect(outcome.provenance.filter((payload) => payload.action === "replay_failed")).toHaveLength(1)
    }))
})

describe("the effective decision counter under replay failure", () => {
  const replayFailedCount = Effect.map(
    Metric.value(EngineStoreMetrics.stepCacheDecision.ReplayFailed),
    (state) => state.count
  )

  it("records no replay_failed decision when the strict corruption verdict terminates the dispatch", async () => {
    const key = "corruption/metered-strict"
    const observed = await runPromise(
      Effect.gen(function*() {
        yield* activate("metered-strict-first")
        yield* dispatch("metered-strict-first", key, () => Effect.succeed("recorded")).pipe(
          Effect.provide(failingReplay(corruptionError))
        )
        yield* activate("metered-strict-second")
        const failed = yield* dispatch("metered-strict-second", key, () => Effect.die("must not execute")).pipe(
          Effect.provide(failingReplay(corruptionError)),
          Effect.flip
        )
        return { failed, replayFailed: yield* replayFailedCount }
      }).pipe(
        Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
        Effect.scoped,
        Effect.provideService(Metric.MetricRegistry, new Map())
      )
    )
    expect(observed.failed).toBeInstanceOf(ActionPersistence.CacheCorruptionDetected)
    // `replay_failed` is the fall-through decision: the strict verdict failed
    // the dispatch instead of re-executing, so nothing lands in the series —
    // the failed dispatch's exit is what `flows_engine_dispatches` records.
    expect(observed.replayFailed).toBe(0)
  })

  it("counts replay_failed for the tolerated fall-through that re-executes", async () => {
    const key = "corruption/metered-tolerated"
    const observed = await runPromise(
      Effect.gen(function*() {
        let executions = 0
        const body = () =>
          Effect.sync(() => {
            executions++
            return "recorded"
          })
        yield* activate("metered-tolerated-first")
        yield* dispatch("metered-tolerated-first", key, body).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(corruptionError), Inconsistency.layerTolerant(owner)))
        )
        yield* activate("metered-tolerated-second")
        const second = yield* dispatch("metered-tolerated-second", key, body).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(corruptionError), Inconsistency.layerTolerant(owner)))
        )
        return { executions, second, replayFailed: yield* replayFailedCount }
      }).pipe(
        Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
        Effect.scoped,
        Effect.provideService(Metric.MetricRegistry, new Map())
      )
    )
    expect(observed.second).toBe("recorded")
    expect(observed.executions).toBe(2)
    expect(observed.replayFailed).toBe(1)
  })
})
