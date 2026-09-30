/**
 * A plan scheduler composed with `ReplayOnly` serves recorded nodes and runs
 * no node body, the way `smthrs runs verify` drives a copy of a store: a
 * plan-scheduled run under verify reports what it would execute instead of
 * executing it.
 */
import { describe, expect, it } from "@effect/vitest"
import { Sha256 } from "@smthrs/crypto"
import { Jj } from "@smthrs/kernel"
import { KeyMaterial, Plan } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { Clock, Effect, Exit, Layer, Option, Schema } from "effect"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as ReplayOnly from "../src/ReplayOnly.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const owner = { hostId: "replay-only-plan", pid: 1, nonce: "replay-only-plan" }

const draft = (id: string, operation: string, tier: "sealed" | "compensable" = "sealed"): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: tier,
    body: { operation },
    inputs: [],
    layers: [],
    capabilities: []
  },
  effects: { reads: [], writes: [], boundaryMode: "hard" }
})

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "plan-replay" as never, changeId: "plan-replay" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

describe("PlanScheduler under ReplayOnly", () => {
  it.effect("replays recorded nodes and stops a node that would execute before its body or attempt row", () =>
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const attempts = yield* AttemptStore.AttemptStore
      const activate = (runId: string) =>
        Effect.gen(function*() {
          yield* runs.create(runId, "{}")
          yield* runs.claimAndOwn(
            runId,
            { status: "pending", owner: null, heartbeatAtMs: null },
            owner,
            yield* Clock.currentTimeMillis
          )
        })
      const runId = "plan-verify"
      yield* activate(runId)
      const executed: Array<string> = []
      const services = Layer.mergeAll(
        StepBoundary.layerTest(),
        jj,
        PlanScheduler.layerExecutor({
          execute: ({ node }) => Effect.sync(() => {
            executed.push(node.id)
            return `${node.id}-result`
          })
        })
      )
      const scheduler = PlanScheduler.make({ runId, owner, sourceId: "replay-only-plan" })
      const recorded = yield* Plan.compile({ planId: "recorded", flow: "replay-only/plan", nodes: [draft("a", "one")] })
      const first = yield* scheduler.run(recorded).pipe(Effect.provide(services))
      expect(first.settlements[0]!.outcome).toBe("built")
      expect(executed).toEqual(["a"])

      const observed: Array<ReplayOnly.Dispatch> = []
      const replayOnly = ReplayOnly.layer((dispatch) => Effect.sync(() => observed.push(dispatch)))

      // The recorded node replays: served from its record, body not run.
      const again = yield* scheduler.run(recorded).pipe(Effect.provide(Layer.merge(services, replayOnly)))
      expect(again.results).toEqual(first.results)
      expect(executed).toEqual(["a"])
      const recordedDigest = yield* Schema.decodeUnknownEffect(Sha256)(first.settlements[0]!.dispatchKey)
      expect(observed).toEqual([
        expect.objectContaining({ runId, stepKeyDigest: recordedDigest, attempt: 1, outcome: "replayed" })
      ])

      // A node no record serves stops before its body and its attempt row.
      observed.length = 0
      const driftedRun = "plan-verify-drifted"
      yield* activate(driftedRun)
      const drifted = yield* Plan.compile({ planId: "drifted", flow: "replay-only/plan", nodes: [draft("b", "two")] })
      const exit = yield* PlanScheduler.make({ runId: driftedRun, owner, sourceId: "replay-only-plan" }).run(drifted).pipe(Effect.provide(Layer.merge(services, replayOnly)), Effect.exit)
      // The scheduler settles the refused node failed instead of running it.
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.settlements.map((settlement) => [settlement.nodeId, settlement.outcome])).toEqual([
          ["b", "failed"]
        ])
      }
      expect(executed).toEqual(["a"])
      expect(observed).toHaveLength(1)
      expect(observed[0]).toMatchObject({ runId: driftedRun, attempt: 1, tier: "sealed", outcome: "would-execute" })
      const refused = yield* attempts.get({
        runId: driftedRun,
        stepKeyDigest: yield* Schema.decodeUnknownEffect(Sha256)(observed[0]!.stepKeyDigest),
        attempt: 1
      })
      expect(Option.isNone(refused)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))
})
