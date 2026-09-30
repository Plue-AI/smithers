import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Cell from "@smthrs/harness/Cell"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Jj from "@smthrs/jj"
import * as Model from "@smthrs/model/Model"
import { Node } from "@smthrs/plan"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import materialV1 from "./fixtures/cell-call-material-effect-rc115.json" with { type: "json" }
import * as V1 from "./fixtures/CellCallV1.ts"
import * as Safety from "./Safety.ts"

// This proves wire-declaration compatibility within rc.115. The archived
// rc.112 material has a different key and requires finishing or archiving runs.
const flow = Flow.make("agent/test/cell-call-v1-reopen", {
  payload: {},
  success: Schema.Json,
  error: Schema.Unknown,
  body: () => Node.succeed(null)
})
const proceed = DurableDeferred.make("agent/test/cell-call-v1-proceed", { success: Schema.Void })

it("resumes a prior wire declaration from reopened SQLite under the same Effect lock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-m1-cell-key-"))
  const filename = join(directory, "engine.sqlite")
  const dispatched: Array<string> = []
  let entered = 0
  const result = { written: "historical fixture" }
  const host = (historical: boolean) => {
    const registration = Layer.effectDiscard(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const scope = yield* Effect.scope
      yield* engine.register(flow, () =>
        Effect.gen(function*() {
          entered++
          const settled = historical
            ? yield* Action.make({
              name: materialV1.input.action,
              success: V1.CallResult,
              error: HarnessError,
              tier: "sealed",
              idempotencyKey: materialV1.input.idempotencyKey,
              metadata: { boundaryMode: "hard", readSet: [], writeSet: [] },
              execute: Effect.map(Action.CurrentInvocationKey, (key) => {
                dispatched.push(key!)
                return new V1.CallResult({ outcome: "success", value: result })
              })
            }).pipe(Effect.provideService(Action.CurrentCacheEnvironment, materialV1.environment))
            : yield* Effect.gen(function*() {
              const port = yield* FlowEngineLike.make({
                model: Model.make({ stream: () => Stream.empty }),
                route: { prepare: () => Effect.die("no model request expected") },
                layers: ["golden-host-layer"],
                capabilities: {},
                calls: {
                  run: () =>
                    Effect.map(Action.CurrentInvocationKey, (key) => {
                      dispatched.push(key!)
                      return new Cell.CallResult({ outcome: "success", value: { written: "unexpected redispatch" } })
                    })
                }
              })
              return yield* port.call(
                new Cell.Call({
                  flowName: "fs/write",
                  input: { path: "out.txt", text: "done" },
                  capabilities: [],
                  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
                  placement: Option.none(),
                  identity: new Cell.CallIdentity({
                    session: "golden-session",
                    frame: 0,
                    cell: "golden-cell-digest",
                    ordinal: 0,
                    declaration: "golden-declaration-digest",
                    layers: []
                  })
                })
              )
            })
          yield* DurableDeferred.await(proceed)
          return settled.value
        })).pipe(Scope.provide(scope))
    })).pipe(Layer.provide(Safety.layer))
    return NodeRuntime.layer(
      {
        filename,
        workspaceRoot: directory,
        owner: { hostId: historical ? "fixture-writer" : "fixture-reader" },
        // Incarnations are sequential and the preceding scope is closed.
        isAlive: () => Effect.succeed(false)
      },
      StepBoundary.layer,
      WorkspaceSandbox.layerFileSystem(),
      registration
    ).pipe(
      Layer.provide([
        NodeCrypto.layer,
        AtomicFileSystem.layer,
        Jj.layerNoop({ snapshot: () => Effect.die("sealed calls take no snapshot") })
      ])
    )
  }
  try {
    const first = await Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.execute(flow, { executionId: "persisted-v1", payload: {}, discard: true })
      return yield* (yield* RunStore.RunStore).get("persisted-v1")
    }).pipe(Effect.provide(host(true)), Effect.scoped, Effect.runPromise)
    expect(first.status).toBe("suspended")
    expect(dispatched).toEqual([V1.effect115Key])

    // Read with an independent connection after the writer and its pool close.
    const database = new DatabaseSync(filename)
    try {
      expect(database.prepare("SELECT status FROM flows_runs WHERE run_id = ?").get("persisted-v1"))
        .toEqual({ status: "suspended" })
      expect(
        database.prepare("SELECT step_key_digest, state FROM flows_attempts WHERE run_id = ?")
          .all("persisted-v1")
      ).toEqual([{
        // AttemptStore indexes SHA-256 of the complete key, including key1_.
        // Moves with `V1.effect115Key`, which moved when `HarnessErrorCode`
        // gained `completion_unjudged` and again when it gained
        // `claim_unproven`, and moved when CallFailureCode gained
        // flow_withheld (#1929), then completion_incomplete (#2937).
        step_key_digest: "35aec95b8ae0405ef3be9062325f3ed76d4033404faff6afbb1c8d5b5ea86452",
        state: "succeeded"
      }])
    } finally {
      database.close()
    }

    const resumed = await Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.deferredDone(proceed, {
        flowName: flow._tag,
        executionId: "persisted-v1",
        deferredName: proceed.name,
        exit: Exit.succeed(undefined)
      })
      return yield* engine.execute(flow, { executionId: "persisted-v1", payload: {} })
    }).pipe(Effect.provide(host(false)), Effect.scoped, Effect.runPromise)
    expect(resumed).toEqual(result)
    expect(entered).toBeGreaterThanOrEqual(2)
    expect(dispatched).toEqual([V1.effect115Key])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
