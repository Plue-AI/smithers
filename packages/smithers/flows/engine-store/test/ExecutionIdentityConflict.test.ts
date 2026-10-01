import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const flow = Flow.make("DurableIdentityConflict/flow", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: () => Node.succeed(1)
})
const other = Flow.make("DurableIdentityConflict/other", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: () => Node.succeed(1)
})
// No action runs in these admission-refusal tests, so the workspace port is unused.
const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "identity" as never, changeId: "identity" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})
const layer = EngineStore.layer({
  owner: { hostId: "identity-conflict" },
  journalSource: "identity-conflict",
  isAlive: () => Effect.succeed(true)
}).pipe(Layer.provideMerge(Layer.mergeAll(
  TestStores.layerAt(":memory:"),
  StepBoundary.layerTest(),
  Layer.succeed(Jj.Jj, jj)
)))

describe("durable public execute identity refusal (#3371)", () => {
  for (const status of ["pending", "running", "suspended", "completed", "failed", "cancelled"] as const) {
    for (const field of ["flow", "payload", "capabilities"] as const) {
      it.effect(`${field} conflict reports persisted ${status} without claiming or driving it`, () =>
        withCrypto(
          Effect.scoped(Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const sql = yield* SqlClient.SqlClient
            const engine = yield* FlowRuntime.FlowRuntime
            let workers = 0
            yield* engine.register(flow, () => Effect.sync(() => ++workers))
            yield* engine.register(other, () => Effect.sync(() => ++workers))
            yield* store.create(
              "existing",
              JSON.stringify({
                version: 1,
                flowName: flow._tag,
                payload: { value: 1 },
                capabilityCeilings: []
              })
            )
            // Seed admission states in real SQLite; conflict must precede ownership
            // acquisition and result decoding even for a parked or terminal row.
            if (status === "running") {
              yield* sql`UPDATE flows_runs SET status = ${status}, owner_host_id = ${"other-host"},
              owner_pid = ${7}, owner_nonce = ${"other-worker"}, heartbeat_at_ms = ${0}
              WHERE run_id = ${"existing"}`
            } else {
              yield* sql`UPDATE flows_runs SET status = ${status} WHERE run_id = ${"existing"}`
            }
            const before = yield* store.get("existing")
            const request = (field === "flow" ? other : flow).execute(
              { value: field === "payload" ? 2 : 1 },
              { executionId: "existing", discard: true }
            )
            const exit = yield* Effect.exit(
              field === "capabilities"
                ? request.pipe(
                  CapabilitySet.attenuate([new CapabilityPattern({ action: "fs:read", resource: "src/**" })])
                )
                : request
            )
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.hasDies(exit.cause)).toBe(false)
              const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
              expect(failure).toBeInstanceOf(FlowEngine.ExecutionIdentityConflict)
              expect(failure).toMatchObject({
                _tag: "@smthrs/engine/ExecutionIdentityConflict",
                executionId: "existing",
                field,
                status
              })
            }
            expect(workers).toBe(0)
            expect(yield* store.get("existing")).toEqual(before)
          })).pipe(Effect.provide(layer), Effect.scoped)
        ))
    }
  }
})
