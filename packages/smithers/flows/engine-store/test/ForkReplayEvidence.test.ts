/** Fork replay requires surviving attempts copied into the child. */
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import { SqlClient } from "effect/unstable/sql"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

type Services = Layer.Success<ReturnType<typeof TestStores.layerAt>> | Scope.Scope | Crypto.Crypto
const run = <A, E>(body: Effect.Effect<A, E, Services>) =>
  withCrypto(body.pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:"))))
const makePublicEngine = () =>
  EngineStore.make({ owner: { hostId: "admission-public" }, journalSource: "admission-public" })
    .pipe(
      Effect.provide(StepBoundary.layerTest()),
      // Handlers perform no filesystem effects, so Jj only satisfies the host port.
      // Journal, run state, parent edges and cancellation use production SQLite stores.
      Effect.provideService(
        Jj.Jj,
        Jj.make({
          snapshot: () => Effect.succeed({ commitId: "admission" as never, changeId: "admission" as never }),
          restore: () => Effect.void,
          diff: () => Effect.succeed(""),
          workspaceAdd: () => Effect.void,
          workspaceForget: () => Effect.void,
          status: () => Effect.succeed("")
        })
      )
    )

describe("fork action replay through durable execution", () => {
  it.effect("a vanished admitted attempt cannot invent a boundary restore or dispatch an unfenced body", () =>
    run(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const events: Array<string> = []
      const engine = yield* makePublicEngine().pipe(Effect.provideService(FlowEngine.SnapshotBoundary, {
        snapshot: () =>
          Effect.sync(() => {
            events.push("new-pre-image")
            return "new-pre-image"
          }),
        restore: () =>
          Effect.sync(() => {
            events.push("restore")
          }),
        diff: () => Effect.succeed("")
      }))
      const action = Action.make({
        name: "ForkReplayEvidence/vanished-attempt",
        tier: "compensable",
        success: Schema.String,
        execute: Effect.sync(() => {
          events.push("body")
          return "unexpected"
        })
      })
      const flow = Flow.make("ForkReplayEvidence/vanished-attempt-flow", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody,
        suspendedRetryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 1 })
      })
      yield* engine.register(flow, () => action)
      // Real SQLite retention race: the admitted attempt disappears before
      // boundary preparation. The public action must not restore invented data
      // or execute after the durable attempt fence vanishes.
      yield* sql`CREATE TRIGGER vanish_admitted_attempt AFTER INSERT ON flows_attempts
        WHEN NEW.run_id='vanished-attempt'
        BEGIN DELETE FROM flows_attempts WHERE run_id=NEW.run_id; END`
      const result = yield* Effect.exit(engine.execute(flow, { executionId: "vanished-attempt", payload: {} }))
      expect(Exit.isFailure(result)).toBe(true)
      expect(events).toEqual(["new-pre-image"])
      expect(yield* sql`SELECT run_id FROM flows_attempts WHERE run_id='vanished-attempt'`).toEqual([])
    })))

  for (const copied of [false, true]) {
    it.effect(`copied attempts ${copied}: only child-local evidence authorizes ancestor keys`, () =>
      run(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const snapshots: Array<string> = []
        const engine = yield* makePublicEngine().pipe(Effect.provideService(FlowEngine.SnapshotBoundary, {
          snapshot: () =>
            Effect.sync(() => {
              snapshots.push("snapshot")
              return "pre-image"
            }),
          restore: (handle) => Effect.sync(() => snapshots.push(`restore:${handle}`)),
          diff: () => Effect.succeed("")
        }))
        let calls = 0
        const action = Action.make({
          name: "ForkReplayEvidence/action",
          tier: "compensable",
          success: Schema.String,
          execute: Effect.sync(() => `result-${++calls}`)
        })
        const flow = Flow.make("ForkReplayEvidence/flow", {
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        })
        yield* engine.register(flow, () => action)
        expect(yield* engine.execute(flow, { executionId: "origin", payload: {} })).toBe("result-1")
        const source = yield* (yield* RunStore.RunStore).get("origin")
        const state = JSON.stringify({
          ...JSON.parse(source.stateJson),
          result: undefined,
          forkKeyRunIds: ["origin", "origin"],
          onParentExit: "detach"
        })
        yield* sql`INSERT INTO flows_runs (run_id,status,created_at_ms,state_json,lineage_id,round_ordinal)
          VALUES ('fork-child','pending',0,${state},'fork-child',0)`
        if (copied) {
          yield* sql`INSERT INTO flows_attempts
            SELECT 'fork-child', step_key_digest, attempt, state, started_at_ms,
              finished_at_ms, heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
            FROM flows_attempts WHERE run_id='origin'`
        }
        expect(yield* engine.execute(flow, { executionId: "fork-child", payload: {} })).toBe(
          copied ? "result-1" : "result-2"
        )
        expect(calls).toBe(copied ? 1 : 2)
        expect(snapshots.filter((value) => value === "snapshot")).toHaveLength(copied ? 1 : 2)
      })))
  }
})
