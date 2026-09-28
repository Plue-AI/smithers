import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Issue #171: corrupt recorded evidence on a SUCCEEDED attempt row under the
 * strict verdict is an OPERATOR event, not a terminal run failure. The attempt
 * cannot be evicted and re-executed like a corrupt cache row (#164) — its side
 * effects already ran, so blind re-execution would break exactly-once. Instead,
 * the corrupt boundary evidence is journalled and quarantined off the succeeded
 * row. The first resume parks visibly; the next returns the durable outcome
 * without touching the poisoned evidence or re-running the action.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import * as Notifying from "@smthrs/journal/test/Notifying"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const QuarantineFlow = Flow.make("AttemptQuarantine/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "quarantine-snapshot" as never, changeId: "quarantine-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const corruptionError = new StepBoundary.BoundaryCorruption({
  code: "boundary_corruption",
  path: "dist/manifest.json",
  recordedDigest: "aa".repeat(32),
  measuredDigest: "bb".repeat(32)
})

describe("succeeded-row corruption quarantines its evidence and heals on resume (issue #171)", () => {
  it("classifies the real AttemptEvidenceQuarantined instance non-retryable under every policy", () => {
    // Same cross-package seam pin as issue #165 for CacheCorruptionDetected:
    // the engine matches by tag string, so nothing else stops a rename from
    // silently making quarantine retryable — each retry would re-detect the
    // identical corruption before the driver ever parks the run.
    const quarantined = new ActionPersistence.AttemptEvidenceQuarantined({
      code: "attempt_evidence_quarantined",
      keyDigest: "deadbeef",
      attempt: 1,
      path: "dist/manifest.json",
      recordedDigest: "aa".repeat(32),
      measuredDigest: "bb".repeat(32)
    })
    expect(RetryPolicy.errorTag(quarantined)).toBe("@smthrs/engine-store/AttemptEvidenceQuarantined")
    expect(RetryPolicy.defaultNonRetryable).toContain(RetryPolicy.errorTag(quarantined))
    const policy = RetryPolicy.make({ initialMs: 1, factor: 2, maxMs: 10, maxAttempts: 10 })
    expect(RetryPolicy.isNonRetryable(policy, quarantined)).toBe(true)
  })

  it.effect("parks once, then resumes from the durable outcome while the evidence remains corrupt", () =>
    Effect.gen(function*() {
      let dispatches = 0
      const sealed = Action.make({
        name: "AttemptQuarantine/sealed",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "quarantine-v1",
        metadata: { readSet: [], writeSet: ["dist/manifest.json"], boundaryMode: "hard" },
        execute: Effect.suspend(() => {
          dispatches++
          return Effect.succeed("durable-outcome")
        })
      })
      const state = DurableEngineState.makeMemory()
      let evidenceCorrupt = false
      const boundary = Layer.succeed(
        StepBoundary.StepBoundary,
        StepBoundary.make({
          prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
          settle: () =>
            Effect.succeed({
              declaredOutputs: { paths: ["dist/manifest.json"] },
              diffIdentity: "quarantine-diff",
              wholeTreeWritesVerified: true
            }),
          replayOutputs: () => evidenceCorrupt ? Effect.fail(corruptionError) : Effect.succeed(undefined)
        })
      )
      // One built context shared by every round, the way `ManagedRuntime` shared
      // it before: the stores and the durable state must survive across runs.
      const layer = Layer.mergeAll(
        TestStores.layer(),
        TestClock.layer(),
        Layer.succeed(DurableEngineState.DurableEngineState, state),
        Layer.succeed(Jj.Jj, jj),
        Action.layerCacheEnvironment({ layers: [], capabilities: {} }),
        boundary
      ).pipe(Layer.provideMerge(NodeCrypto.layer))
      const services = yield* Layer.build(layer)
      const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.provide(effect, services)
      const makeEngine = EngineStore.make({
        owner: { hostId: "quarantine-host" },
        journalSource: "quarantine-test",
        isAlive: () => Effect.succeed(false)
      })
      // The sealed step key folds declaration and metadata material the test
      // must not re-derive by hand: a probe run discovers the real digest from
      // its own attempt-started journal record.
      const keyDigest = yield* run(
        Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(QuarantineFlow, () => sealed)
          yield* engine.execute(QuarantineFlow, {
            executionId: "quarantine-probe",
            payload: {},
            discard: true
          })
          const journal = yield* Journal.Journal
          yield* journal.flush
          const page = yield* journal.entries({ runId: "quarantine-probe" as never, limit: 50 })
          const started = page.entries.find((entry) => entry.eventType === "flows.engine.attempt-started")
          const digest = (started?.payload as { readonly stepKeyDigest: string }).stepKeyDigest
          // The probe converged its result into the shared cache; the seam
          // under test is the succeeded ATTEMPT row, so clear the cache.
          const cache = yield* CacheStore.CacheStore
          yield* cache.evict(digest)
          return digest
        }).pipe(Effect.scoped)
      )
      expect(dispatches).toBe(1)
      const attemptId = {
        runId: "quarantine-run",
        stepKeyDigest: keyDigest,
        attempt: 1
      }

      // Process 1 (modelled durably, like the rehydration cells): the attempt
      // sealed — its side effects ran and `attempts.finish` recorded the
      // outcome with its boundary evidence — but the process died before the
      // run finished, releasing the run reclaimably. No cache row converged
      // (the crash landed between `finish` and `cache.put`), so the next
      // dispatch replays the succeeded ATTEMPT row — the seam under test.
      const seedOwner = { hostId: "quarantine-seed", pid: 1, nonce: "quarantine-seed" }
      yield* run(
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const stateJson = JSON.stringify({
            version: 1,
            flowName: "AttemptQuarantine/Flow",
            payload: {}
          })
          yield* runs.create("quarantine-run", stateJson, {
            lineageId: "quarantine-run",
            roundOrdinal: 0
          })
          const row = yield* runs.get("quarantine-run")
          yield* runs.claimAndOwn(
            "quarantine-run",
            { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
            seedOwner,
            0
          )
          yield* attempts.put(
            { ...attemptId, state: "running", startedAtMs: 0, meta: { tier: "sealed" } },
            seedOwner
          )
          yield* attempts.finish({
            ...attemptId,
            state: "succeeded",
            finishedAtMs: 0,
            outcome: "durable-outcome",
            meta: {
              tier: "sealed",
              boundary: {
                // Match the abstract boundary's declared output before testing
                // corruption during its replay.
                declaredOutputs: { paths: ["dist/manifest.json"] },
                diffIdentity: "quarantine-diff",
                wholeTreeWritesVerified: true
              },
              readSetVerified: true
            }
          }, seedOwner)
          // The dying process released the run reclaimably.
          yield* runs.transitionOwned("quarantine-run", seedOwner, "suspended", stateJson)
        })
      )

      // Process 2: a disk fault corrupted the recorded evidence. The resume
      // must not fail the run terminally and must not re-execute the sealed
      // body — it parks the run for an operator.
      evidenceCorrupt = true
      const parked = yield* run(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          let claims = 0
          const engine = yield* makeEngine.pipe(Effect.provideService(
            RunStore.RunStore,
            RunStore.makeNoop({
              ...store,
              claim: (...args) =>
                Effect.gen(function*() {
                  claims++
                  return yield* store.claim(...args)
                })
            })
          ))
          yield* engine.register(QuarantineFlow, () => sealed)
          yield* engine.execute(QuarantineFlow, {
            executionId: "quarantine-run",
            payload: {},
            discard: true
          })
          // The discard follower joins the first drive. Observe its durable
          // quarantine park without waiting for another claim.
          yield* TestDatabase.until(Effect.gen(function*() {
            const row = yield* store.get("quarantine-run")
            const waiting = yield* state.waiting("quarantine-run")
            return row.status === "suspended" &&
              Option.isSome(waiting) && waiting.value.reason === "quarantine"
          }))
          return {
            claims,
            row: yield* store.get("quarantine-run"),
            waiting: yield* state.waiting("quarantine-run"),
            sweep: yield* state.waitingRuns({ reason: "quarantine" }),
            releasedSweep: yield* state.waitingRuns({ reason: "released" })
          }
        }).pipe(Effect.scoped)
      )

      // Parked, not failed: the run is suspended under the typed quarantine
      // reason, keyed to the poisoned attempt for the operator.
      expect(parked.claims).toBe(1)
      expect(parked.row.status).toBe("suspended")
      const waiting = Option.getOrThrow(parked.waiting)
      expect(waiting.reason).toBe("quarantine")
      expect(waiting.token).toBe(keyDigest)
      expect(parked.sweep.map((row) => row.runId)).toEqual(["quarantine-run"])
      // The reclaim sweep must never see it: quarantine is not `released`.
      expect(parked.releasedSweep).toEqual([])
      expect(dispatches).toBe(1)

      // No operator repairs the bytes. The first detection must have quarantined
      // only the poisoned replay evidence off the succeeded row, so the next
      // resume completes from the durable outcome without re-reading that
      // evidence or re-executing the sealed body.
      const resumed = yield* run(
        Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(QuarantineFlow, () => sealed)
          yield* engine.execute(QuarantineFlow, {
            executionId: "quarantine-run",
            payload: {},
            discard: true
          })
          const store = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          return {
            row: yield* store.get("quarantine-run"),
            waiting: yield* state.waiting("quarantine-run"),
            attempt: yield* attempts.get(attemptId)
          }
        }).pipe(Effect.scoped)
      )

      expect(resumed.row.status).toBe("completed")
      expect(Option.isNone(resumed.waiting)).toBe(true)
      expect(Option.getOrThrow(resumed.attempt).meta).toMatchObject({
        tier: "sealed",
        boundaryQuarantined: true
      })
      expect(Option.getOrThrow(resumed.attempt).meta).not.toHaveProperty("boundary")
      expect(dispatches).toBe(1)
      // The built context is released with the test's own scope.
    }))
})

const CancelRaceFlow = Flow.make("AttemptQuarantine/CancelRace", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

describe("a cancel that races the quarantine park", () => {
  it.effect("cancels the run instead of parking it, because the park's transition guard sees the request", () =>
    Effect.gen(function*() {
      // The quarantine park and the transition that follows it are separated by
      // exactly one instant, and `requestCancel` is unfenced — another process
      // can land one there. The transition carries `cancelRequested: "absent"`,
      // so it reports `GuardFailed` and the run cancels rather than parking for
      // an operator who was already told to stop. Injecting the request in the
      // park's `after` hook makes that instant deterministic; racing it against
      // the cancel poll would not be.
      const executionId = "quarantine-cancel-race"
      const quarantined = new ActionPersistence.AttemptEvidenceQuarantined({
        code: "attempt_evidence_quarantined",
        keyDigest: "cafebabe",
        attempt: 1,
        path: "dist/manifest.json",
        recordedDigest: "aa".repeat(32),
        measuredDigest: "bb".repeat(32)
      })

      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const state = DurableEngineState.makeMemory()
          const driver = yield* RunDriver.make({
            owner: { hostId: "quarantine-race-host", pid: 1, nonce: "quarantine-race" },
            journalSource: "quarantine-race",
            isAlive: () => Effect.succeed(false),
            engine: Effect.succeed(fakeEngine)
          }).pipe(
            Effect.provideService(
              DurableEngineState.DurableEngineState,
              Notifying.wrap(state, (op, order, args) =>
                op === "park" && order === "after" &&
                  (args[1] as { readonly reason: string }).reason === "quarantine"
                  ? store.requestCancel(executionId, 1).pipe(Effect.asVoid, Effect.orDie)
                  : Effect.void)
            )
          )
          yield* driver.register(CancelRaceFlow, () => Effect.die(quarantined))
          yield* driver.execute(CancelRaceFlow, { executionId, payload: {}, discard: true })
          const journal = yield* Journal.Journal
          yield* journal.flush
          const page = yield* journal.entries({ runId: executionId as never, limit: 50 })
          return {
            row: yield* store.get(executionId),
            waiting: yield* state.waiting(executionId),
            decisions: page.entries
              .filter((entry) => entry.eventType === "flows.engine.run-decision")
              .map((entry) => (entry.payload as { readonly decision: string }).decision),
            interruptions: page.entries.filter((entry) => entry.eventType === "flows.engine.interrupted")
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(TestStores.layer()),
          Effect.provide(TestClock.layer()),
          Effect.orDie
        )
      )

      expect(outcome.row.status).toBe("cancelled")
      // No `quarantined` decision: the park never became durable state.
      expect(outcome.decisions).not.toContain("quarantined")
      expect(outcome.interruptions).toHaveLength(1)
      // The cancel clears the waiting row it raced.
      expect(Option.isNone(outcome.waiting)).toBe(true)
    }))
})
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
