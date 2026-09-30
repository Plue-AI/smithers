import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Jj from "@smthrs/jj"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Effect, Layer, Option, Schedule, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import * as ControlRuntime from "../src/ControlRuntime.ts"
import { controlPlane } from "./DurableStack.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-approval-gate-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const errors = Schema.Union([ControlRuntime.ApprovalPending, ControlRuntime.ApprovalDenied])
const Gate = Action.make("test/DecisionGate", { payload: {}, success: Schema.String, error: errors })
const After = Action.make("test/AfterDecisionGate", { payload: {}, success: Schema.String })
const Gated = Flow.make("test/DecisionGated", {
  payload: {},
  success: Schema.String,
  error: errors,
  body: () => Node.andThen(Gate.call({}), After.call({}))
})
const wake = DurableDeferred.make("test/DecisionGateWake", { success: Schema.Json })
const request = (runId: string) => ({
  _tag: "Node" as const,
  runId,
  requestId: "gate",
  digest: "test-gate-v1",
  envelope: { capabilities: [], flows: [], budget: {} }
})

const stack = (filename: string, reads: Array<string>, after: () => string) => {
  const stores = TestStores.layerAt(filename).pipe(Layer.provideMerge(NodeCrypto.layer))
  const runtime = Layer.mergeAll(
    EngineStore.layer({
      owner: { hostId: "approval-gate" },
      journalSource: "approval-gate",
      isAlive: () => Effect.succeed(false)
    }),
    controlPlane()
  ).pipe(
    Layer.provideMerge(stores),
    Layer.provide(StepBoundary.layerTest()),
    Layer.provide(Layer.succeed(
      Jj.Jj,
      Jj.make({
        snapshot: () => Effect.succeed({ commitId: "approval-gate" as never, changeId: "approval-gate" as never }),
        restore: () => Effect.void,
        diff: () => Effect.succeed(""),
        workspaceAdd: () => Effect.void,
        workspaceForget: () => Effect.void,
        status: () => Effect.succeed("")
      })
    ))
  )
  return Layer.mergeAll(
    Gate.toLayer(() =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        const control = yield* ControlRuntime.ControlRuntime
        const target = request(instance.executionId)
        let token = yield* Effect.orDie(control.registerApproval(target))
        reads.push(token._tag)
        if (token._tag === "Pending") {
          yield* FlowRuntime.annotateWaiting({ reason: "approval", token: target.requestId })
          yield* DurableDeferred.await(wake)
          token = yield* Effect.orDie(control.registerApproval(target))
        }
        return (yield* ControlRuntime.requireApproved(token)).tokenId
      })
    ),
    After.toLayer(() => Effect.sync(after)),
    Interpreter.layer(Gated)
  ).pipe(Layer.provide(Action.layerImplementations), Layer.provideMerge(runtime))
}

describe("public approval gate across durable engine reopen", () => {
  for (const decision of ["approve", "deny", "wake-only"] as const) {
    it(`${decision}: never substitutes a wake or denial for approval`, async () => {
      const filename = join(directory, `${decision}.sqlite`)
      const runId = `gate-${decision}`
      const reads: Array<string> = []
      let effects = 0
      const after = () => {
        effects += 1
        return "effect completed"
      }
      await Effect.runPromise(
        Effect.gen(function*() {
          yield* Gated.execute({}, { executionId: runId, discard: true })
          yield* Gated.poll(runId).pipe(
            Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced(10) }),
            Effect.timeout(10_000)
          )
        }).pipe(
          Effect.provide(stack(filename, reads, after)),
          Effect.scoped
        )
      )
      expect(reads).toEqual(["Pending"])
      expect(effects).toBe(0)

      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const input = { target: request(runId), scope: "once" as const, idempotencyKey: "gate:decision" }
          if (decision === "wake-only") {
            yield* DurableDeferred.succeed(wake, {
              token: DurableDeferred.tokenFromExecutionId(wake, { flow: Gated, executionId: runId }),
              value: null
            })
          } else {
            yield* (decision === "approve" ? control.approve(input) : control.deny(input))
          }
          if (decision === "approve") {
            expect(yield* Gated.execute({}, { executionId: runId })).toBe("effect completed")
          } else {
            const error = yield* Effect.flip(Gated.execute({}, { executionId: runId }))
            expect(error._tag).toBe(decision === "deny" ? "/control/ApprovalDenied" : "/control/ApprovalPending")
          }
          const store = yield* RunStore.RunStore
          expect((yield* store.get(runId)).status).toBe(decision === "approve" ? "completed" : "failed")
        }).pipe(Effect.provide(stack(filename, reads, after)), Effect.scoped)
      )
      expect(effects).toBe(decision === "approve" ? 1 : 0)
      const readsAfter = [...reads]

      // A third independent engine reads the terminal result without running
      // either the gate or the downstream effect again.
      await Effect.runPromise(
        Effect.gen(function*() {
          if (decision === "approve") {
            expect(yield* Gated.execute({}, { executionId: runId })).toBe("effect completed")
          } else {
            const error = yield* Effect.flip(Gated.execute({}, { executionId: runId }))
            expect(error._tag).toBe(decision === "deny" ? "/control/ApprovalDenied" : "/control/ApprovalPending")
          }
        }).pipe(Effect.provide(stack(filename, reads, after)), Effect.scoped)
      )
      expect(reads).toEqual(readsAfter)
      expect(effects).toBe(decision === "approve" ? 1 : 0)
    })
  }
})
