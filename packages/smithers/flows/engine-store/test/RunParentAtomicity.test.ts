import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issues #80 and #81: the run-parent edge table can never hold ghost
 * edges.
 *
 * #80 — `ensureRun` committed the parent edge in its own transaction before
 * `store.create`; a crash in the window left a durable edge for a child run
 * that never existed, unswept forever and able to force a false
 * `FlowCycleDetected` when the execution id was reused under an inverted
 * topology. Edge record and run-row creation now share one storage
 * transaction: either both commit or neither.
 *
 * #81 — the "call `removeRunParentsForRun` when deleting run rows" contract
 * was comment-only with zero production callers. An AFTER DELETE trigger on
 * `flows_runs` now prunes a deleted run's edges at the database level, so a
 * future retention/GC lane cannot silently leave ghosts in the cycle walk.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const AtomicFlow = Flow.make("RunParentAtomicity/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

const parentInstance = (executionId: string) => ({ executionId } as FlowRuntime.FlowInstance["Service"])

type Services = Layer.Success<typeof services> | TestClock.TestClock | Crypto.Crypto | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(Effect.scoped(effect).pipe(Effect.provide(services), Effect.provide(TestClock.layer())))

describe("run-parent edge atomicity (issues #80/#81)", () => {
  it.effect("commits the parent edge and the run row together, or neither (issue #80)", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const store = yield* RunStore.RunStore

        // Crash simulation: run-row creation dies after the edge insert
        // committed in the pre-fix world. The shared transaction must roll
        // the edge back with it.
        const crashing: RunStore.Service = {
          ...store,
          create: () => Effect.die(new Error("crash between edge record and run create"))
        }
        const crashingDriver = yield* RunDriver.make({
          owner: { hostId: "atomicity-host", pid: 1, nonce: "crasher" },
          journalSource: "run-parent-atomicity",
          isAlive: () => Effect.succeed(false),
          engine: Effect.succeed(fakeEngine)
        }).pipe(Effect.provideService(RunStore.RunStore, crashing))
        yield* crashingDriver.register(AtomicFlow, () => Effect.succeed("unused"))
        const crashed = yield* crashingDriver.execute(AtomicFlow, {
          executionId: "orphan-child",
          payload: {},
          discard: true,
          parent: parentInstance("parent-run")
        }).pipe(Effect.exit)
        const orphanEdges = yield* state.runParents("orphan-child")

        // The healthy driver commits both sides atomically.
        const driver = yield* RunDriver.make({
          owner: { hostId: "atomicity-host", pid: 1, nonce: "healthy" },
          journalSource: "run-parent-atomicity",
          isAlive: () => Effect.succeed(false),
          engine: Effect.succeed(fakeEngine)
        })
        yield* driver.register(AtomicFlow, () => Effect.succeed("done"))
        yield* driver.execute(AtomicFlow, {
          executionId: "created-child",
          payload: {},
          discard: true,
          parent: parentInstance("parent-run")
        })
        const createdEdges = yield* state.runParents("created-child")
        const createdRow = yield* store.get("created-child")
        return { crashed, orphanEdges, createdEdges, createdRow }
      }))

      expect(Exit.isFailure(result.crashed)).toBe(true)
      // The crash window leaves NO durable orphan edge.
      expect(result.orphanEdges).toEqual([])
      expect(result.createdEdges.map((edge) => edge.parentId)).toEqual(["parent-run"])
      expect(result.createdRow.status).toBe("completed")
    }))

  it.effect("prunes a deleted run's edges at the database level, without any caller (issue #81)", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter.DurableWriter
        yield* writer.write(sql`
        INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES ('gc-child', 'completed', 0, '{}')
      `).pipe(Effect.orDie)
        yield* state.recordRunParent("gc-child", "gc-parent")
        yield* state.recordRunParent("gc-grandchild", "gc-child")

        // A retention lane that knows nothing about the edge table deletes
        // the run row directly.
        yield* writer.write(sql`
        DELETE FROM flows_runs WHERE run_id = 'gc-child'
      `).pipe(Effect.orDie)

        return {
          asChild: yield* state.runParents("gc-child"),
          asParent: yield* state.runParents("gc-grandchild")
        }
      }))

      // Both directions are pruned: the deleted run appears in no future walk.
      expect(result.asChild).toEqual([])
      expect(result.asParent).toEqual([])
    }))

  it.effect("turns storage failures inside a transaction into defects", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const sql = yield* Effect.service(SqlClient.SqlClient)
        return yield* state.transaction(sql`INSERT INTO no_such_table VALUES (1)`).pipe(Effect.exit)
      }))

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons.some(Cause.isDieReason)).toBe(true)
      }
    }))
})
