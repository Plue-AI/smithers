import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const database = Layer.provideMerge(Migrations.layer, TestDatabase.sqliteLayer)
const address = { flowName: "Fault/Test", executionId: "run", deferredName: "answer" }
const row = { ...address, exit: Exit.succeed("ready"), completedAtMs: 1 }

const insertRun = (runId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
    VALUES (${runId}, 'pending', 0, '{}')`
})

const fault = <A, E>(
  exit: Exit.Exit<A, E>,
  reason: DurableEngineState.EngineStateFault["reason"],
  message: string
) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("Expected a defect")
  const defect = exit.cause.reasons.find(Cause.isDieReason)?.defect
  expect(defect).toBeInstanceOf(DurableEngineState.EngineStateFault)
  if (!(defect instanceof DurableEngineState.EngineStateFault)) throw new Error("Expected EngineStateFault")
  expect(defect._tag).toBe("@smthrs/engine-store/EngineStateFault")
  expect(defect.reason).toBe(reason)
  expect(defect.message).toBe(message)
  return defect
}

describe("EngineStateFault", () => {
  for (const field of ["exit", "metadata"] as const) {
    it.effect(`rejects unserializable ${field} without recording a completion`, () =>
      withCrypto(Effect.gen(function*() {
        const state = DurableEngineState.makeMemory()
        const defect = fault(
          yield* Effect.exit(state.completeDeferred({ ...row, [field]: { size: 1n } })),
          "value_not_serializable",
          `${field} must be JSON-serializable`
        )
        expect(defect.field).toBe(field)
        expect(defect.cause).toBeDefined()
        expect(Option.isNone(yield* state.deferred(address))).toBe(true)
        expect((yield* state.completeDeferred(row))._tag).toBe("Completed")
        expect((yield* state.completeDeferred(row))._tag).toBe("Existing")
      })))
  }

  for (const field of ["exit_json", "metadata_json"] as const) {
    it.effect(`reports corrupt ${field} when reading a completion`, () =>
      withCrypto(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const state = yield* DurableEngineState.make
        yield* insertRun("run")
        yield* state.completeDeferred(row)
        yield* TestDatabase.checks(sql, false)
        yield* sql`UPDATE flows_deferred_completions SET ${sql(field)} = '{broken'`
        const defect = fault(
          yield* Effect.exit(state.deferred(address)),
          "value_not_decodable",
          `could not decode ${field}`
        )
        expect(defect.field).toBe(field)
        expect(defect.cause).toBeDefined()
      }).pipe(Effect.provide(database))))
  }

  it.effect("reports a missing deferred row and can retry after the storage fault is removed", () =>
    withCrypto(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const state = yield* DurableEngineState.make
      yield* insertRun("run")
      yield* sql`CREATE TRIGGER suppress_completion BEFORE INSERT ON flows_deferred_completions BEGIN SELECT RAISE(IGNORE); END`
      const defect = fault(
        yield* Effect.exit(state.completeDeferred(row)),
        "deferred_completion_missing",
        "deferred completion disappeared during first-writer transaction"
      )
      expect(defect.field).toBeUndefined()
      expect(defect.cause).toBeUndefined()
      expect(Option.isNone(yield* state.deferred(address))).toBe(true)
      yield* sql`DROP TRIGGER suppress_completion`
      expect((yield* state.completeDeferred(row))._tag).toBe("Completed")
    }).pipe(Effect.provide(database))))

  it.effect("reports a missing parent edge and can retry after the storage fault is removed", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const state = yield* DurableEngineState.make
      yield* insertRun("child")
      yield* insertRun("parent")
      yield* sql`CREATE TRIGGER suppress_parent BEFORE INSERT ON flows_run_parents BEGIN SELECT RAISE(IGNORE); END`
      const defect = fault(
        yield* Effect.exit(state.recordRunParent("child", "parent")),
        "run_parent_edge_missing",
        "run parent edge disappeared during first-writer transaction"
      )
      expect(defect.field).toBeUndefined()
      expect(defect.cause).toBeUndefined()
      expect(yield* state.runParents("child")).toEqual([])
      yield* sql`DROP TRIGGER suppress_parent`
      expect((yield* state.recordRunParent("child", "parent"))._tag).toBe("Recorded")
      expect((yield* state.recordRunParent("child", "parent"))._tag).toBe("Existing")
    }).pipe(Effect.provide(database)))
})
