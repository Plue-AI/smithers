import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { executeAndDrain } from "./ExecuteAndDrain.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const flow = Flow.make("QuarantineClaimRace/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const engine = Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
const executionId = "quarantine-claim-race"

describe("quarantine arriving between preflight and claim (#2505)", () => {
  it.effect("refuses activation and releases A's claim after B parks the same suspended row", () =>
    withCrypto(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const stateJson = JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: flow._tag, payload: {} })
        const seedOwner = { hostId: "quarantine-seed", pid: 1, nonce: "seed" }
        yield* store.create(executionId, stateJson, { lineageId: executionId, roundOrdinal: 0 })
        const pending = yield* store.get(executionId)
        yield* store.claimAndOwn(
          executionId,
          { status: pending.status, owner: pending.owner, heartbeatAtMs: pending.heartbeatAtMs },
          seedOwner,
          0
        )
        yield* store.transitionOwned(executionId, seedOwner, "suspended", stateJson)

        const quarantined = new ActionPersistence.AttemptEvidenceQuarantined({
          code: "attempt_evidence_quarantined",
          keyDigest: "cafebabe",
          attempt: 1,
          path: "dist/manifest.json",
          recordedDigest: "aa".repeat(32),
          measuredDigest: "bb".repeat(32)
        })
        let handlerCount = 0
        const handler = () =>
          Effect.sync(() => {
            handlerCount++
          }).pipe(Effect.andThen(Effect.die(quarantined)))
        const workerB = yield* RunDriver.make({
          owner: { hostId: "quarantine-worker-b", pid: 2, nonce: "b" },
          journalSource: "quarantine-worker-b",
          isAlive: () => Effect.succeed(false),
          engine
        })
        yield* workerB.register(flow, handler)

        let intercepted = 0
        const workerAStore = RunStore.makeNoop({
          ...store,
          claim: (runId, expected, owner, nowMs) =>
            Effect.gen(function*() {
              intercepted++
              expect(intercepted).toBe(1)
              expect(runId).toBe(executionId)
              expect(expected.status).toBe("suspended")
              expect(expected.owner).toBeNull()
              expect(expected.heartbeatAtMs).toBeNull()
              expect(Option.isNone(yield* state.waiting(executionId))).toBe(true)

              // B uses the unwrapped SQL store. Its quarantine park returns the
              // run to the same status/owner/heartbeat snapshot A already read.
              yield* executeAndDrain(workerB, flow, { executionId, payload: {}, discard: true }).pipe(Effect.orDie)
              const parked = yield* store.get(executionId)
              expect(parked.status).toBe(expected.status)
              expect(parked.owner).toBe(expected.owner)
              expect(parked.heartbeatAtMs).toBe(expected.heartbeatAtMs)
              expect(Option.getOrThrow(yield* state.waiting(executionId)).reason).toBe("quarantine")
              expect(handlerCount).toBe(1)
              return yield* store.claim(runId, expected, owner, nowMs)
            })
        })
        const workerA = yield* RunDriver.make({
          owner: { hostId: "quarantine-worker-a", pid: 3, nonce: "a" },
          journalSource: "quarantine-worker-a",
          isAlive: () => Effect.succeed(false),
          engine
        }).pipe(Effect.provideService(RunStore.RunStore, workerAStore))
        yield* workerA.register(flow, handler)
        yield* executeAndDrain(workerA, flow, { executionId, payload: {}, discard: true })

        expect(intercepted).toBe(1)
        expect(handlerCount).toBe(1)
        const final = yield* store.get(executionId)
        expect(final.status).toBe("suspended")
        expect(final.owner).toBeNull()
        expect(final.heartbeatAtMs).toBeNull()
        expect(final.claim).toBeNull()
        expect(Option.getOrThrow(yield* state.waiting(executionId)).reason).toBe("quarantine")
      }).pipe(
        Effect.scoped,
        Effect.provide(TestStores.layerAt(":memory:")),
        Effect.provide(TestClock.layer()),
        Effect.orDie
      )
    ))
})
