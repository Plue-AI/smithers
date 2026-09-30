import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, DurableDeferred, Flow } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const ReplayFlow = Flow.make("Replay/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const gate = DurableDeferred.make("race-winner", {
  success: Schema.String
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "test-snapshot" as never, changeId: "test-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

describe("deterministic replay", () => {
  it.effect("replays completed work and continues the frontier through a claimed resume", () =>
    Effect.gen(function*() {
      let firstDispatches = 0
      let frontierDispatches = 0
      let claims = 0
      const decisions: Array<string> = []
      const owners: Array<Ownership.OwnerId> = []
      const state = DurableEngineState.makeMemory()

      const firstAction = Action.make({
        name: "first",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "replay-first-v1",
        execute: Effect.sync(() => {
          firstDispatches++
          return "first-result"
        })
      })
      const frontierAction = Action.make({
        name: "frontier",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "replay-frontier-v1",
        execute: Effect.sync(() => {
          frontierDispatches++
          return "frontier-result"
        })
      })
      const handler = () =>
        Effect.gen(function*() {
          const first = yield* firstAction
          decisions.push(`before:${first}`)
          const winner = yield* DurableDeferred.await(gate)
          decisions.push(`winner:${winner}`)
          const frontier = yield* frontierAction
          return `${first}/${winner}/${frontier}`
        })

      const result = yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            const baseStore = yield* RunStore.RunStore
            const countingStore = RunStore.makeNoop({
              ...baseStore,
              claim: (runId, expected, owner, nowMs) =>
                Effect.sync(() => {
                  claims++
                  owners.push(owner)
                }).pipe(
                  Effect.andThen(baseStore.claim(runId, expected, owner, nowMs))
                ),
              steal: (runId, expected, owner, nowMs, evidence) =>
                Effect.sync(() => {
                  claims++
                  owners.push(owner)
                }).pipe(
                  Effect.andThen(
                    baseStore.steal(runId, expected, owner, nowMs, evidence)
                  )
                )
            })

            const makeEngine = EngineStore.make({
              owner: { hostId: "replay-host" },
              journalSource: "replay-test",
              isAlive: () => Effect.succeed(false)
            }).pipe(Effect.provideService(RunStore.RunStore, countingStore))

            const firstScope = yield* Scope.make()
            const firstEngine = yield* Scope.provide(makeEngine, firstScope)
            yield* firstEngine.register(ReplayFlow, handler)
            yield* executeUntilParked(firstEngine, ReplayFlow, {
              executionId: "replay-run",
              payload: {},
              discard: true
            })
            const suspended = yield* baseStore.get("replay-run")

            yield* Scope.close(firstScope, Exit.void)
            const restartedEngine = yield* makeEngine
            yield* restartedEngine.register(ReplayFlow, handler)
            yield* restartedEngine.deferredDone(gate, {
              flowName: ReplayFlow._tag,
              executionId: "replay-run",
              deferredName: gate.name,
              exit: Exit.succeed("winner-a")
            })
            yield* restartedEngine.deferredDone(gate, {
              flowName: ReplayFlow._tag,
              executionId: "replay-run",
              deferredName: gate.name,
              exit: Exit.succeed("winner-b")
            })
            yield* TestDatabase.until(baseStore.get("replay-run").pipe(Effect.map((row) => row.status === "completed")))
            const value = yield* restartedEngine.execute(ReplayFlow, {
              executionId: "replay-run",
              payload: {},
              discard: false
            })
            const completed = yield* baseStore.get("replay-run")
            const journal = yield* Journal.Journal
            yield* journal.flush
            const entries = yield* journal.entries({
              runId: "replay-run" as never,
              limit: 100
            })
            return { suspended, completed, entries, value }
          }).pipe(
            Effect.provideService(DurableEngineState.DurableEngineState, state),
            Effect.provideService(Jj.Jj, jj)
          )
        ).pipe(
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layer())
        )
      )

      expect(result.suspended.status).toBe("suspended")
      expect(result.suspended.owner).toBeNull()
      expect(result.completed.status).toBe("completed")
      expect(result.value).toBe("first-result/winner-a/frontier-result")
      expect(firstDispatches).toBe(1)
      expect(frontierDispatches).toBe(1)
      expect(decisions.filter((decision) => decision === "before:first-result")).toHaveLength(2)
      expect(decisions.filter((decision) => decision.startsWith("winner:"))).toEqual([
        "winner:winner-a"
      ])
      expect(claims).toBe(2)
      expect(owners.map((owner) => owner.hostId)).toEqual(["replay-host", "replay-host"])
      expect(owners.map((owner) => owner.pid)).toEqual([process.pid, process.pid])
      expect(new Set(owners.map((owner) => owner.nonce)).size).toBe(2)
      expect(
        result.entries.entries.filter((entry) => entry.eventType === "flows.engine.deferred-completed")
      ).toHaveLength(1)
    }))
})
