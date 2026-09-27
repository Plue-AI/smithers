import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { type Ownership } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = {
  hostId: "ordering",
  pid: 1,
  nonce: "owner"
}

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const insertOwnedRun = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`
      INSERT INTO flows_runs (
        run_id, status, created_at_ms,
        owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
      ) VALUES (
        ${runId}, 'running', 0,
        ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0, '{}'
      )
    `
  })

/**
 * Sweeper ordering is a contract in its own right: a sweeper drains the
 * earliest deadline first and must break ties deterministically, or two
 * processes reading the same store disagree about what to wake next.
 */
describe("in-memory durable state ordering", () => {
  const clockBase = {
    flowName: "Ordering/Flow",
    deferredName: "deferred",
    completedAtMs: null
  }

  it.effect("orders due clocks by deadline, then execution id, then clock name", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const listed = yield* withCrypto(Effect.gen(function*() {
        // Inserted in deliberately reverse-sorted order so a stable-but-unsorted
        // implementation would fail every assertion below.
        yield* state.scheduleClock({ ...clockBase, executionId: "b", clockName: "z", dueAtMs: 50 }, owner)
        yield* state.scheduleClock({ ...clockBase, executionId: "a", clockName: "z", dueAtMs: 10 }, owner)
        yield* state.scheduleClock({ ...clockBase, executionId: "a", clockName: "a", dueAtMs: 10 }, owner)
        yield* state.scheduleClock({ ...clockBase, executionId: "a", clockName: "m", dueAtMs: 5 }, owner)
        return yield* state.dueClocks(50)
      }))

      expect(listed.map((row) => [row.dueAtMs, row.executionId, row.clockName])).toEqual([
        [5, "a", "m"],
        [10, "a", "a"],
        [10, "a", "z"],
        [50, "b", "z"]
      ])
    }))

  it.effect("excludes clocks due after the boundary and includes the exact boundary", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const result = yield* withCrypto(Effect.gen(function*() {
        yield* state.scheduleClock({ ...clockBase, executionId: "x", clockName: "exact", dueAtMs: 100 }, owner)
        yield* state.scheduleClock({ ...clockBase, executionId: "x", clockName: "after", dueAtMs: 101 }, owner)
        return {
          before: yield* state.dueClocks(99),
          atBoundary: yield* state.dueClocks(100),
          after: yield* state.dueClocks(101)
        }
      }))

      expect(result.before).toEqual([])
      expect(result.atBoundary.map((row) => row.clockName)).toEqual(["exact"])
      expect(result.after.map((row) => row.clockName)).toEqual(["exact", "after"])
    }))

  it.effect("orders completed deferreds by execution id, then deferred name", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const listed = yield* withCrypto(Effect.gen(function*() {
        const base = { flowName: "Ordering/Flow", exit: Exit.succeed(1), completedAtMs: 0 }
        yield* state.completeDeferred({ ...base, executionId: "b", deferredName: "a" })
        yield* state.completeDeferred({ ...base, executionId: "a", deferredName: "z" })
        yield* state.completeDeferred({ ...base, executionId: "a", deferredName: "b" })
        // A different flow must never leak into the listing.
        yield* state.completeDeferred({ ...base, flowName: "Other/Flow", executionId: "a", deferredName: "a" })
        return yield* state.completedDeferreds("Ordering/Flow")
      }))

      expect(listed.map((row) => [row.executionId, row.deferredName])).toEqual([
        ["a", "b"],
        ["a", "z"],
        ["b", "a"]
      ])
    }))

  it.effect("snapshots deferred inputs and every returned value", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const exit = { nested: { value: "original" } }
      const metadata = { labels: ["original"] }
      const address = {
        flowName: "Ordering/Flow",
        executionId: "aliased",
        deferredName: "answer"
      }

      const completed = yield* state.completeDeferred({
        ...address,
        exit,
        metadata,
        completedAtMs: 0
      })
      exit.nested.value = "caller mutation"
      metadata.labels.push("caller mutation")
      ;(completed.row.exit as typeof exit).nested.value = "result mutation"
      ;(completed.row.metadata as typeof metadata).labels.push("result mutation")

      const firstRead = Option.getOrThrow(yield* state.deferred(address))
      expect(firstRead.exit).toEqual({ nested: { value: "original" } })
      expect(firstRead.metadata).toEqual({ labels: ["original"] })
      ;(firstRead.exit as typeof exit).nested.value = "read mutation"
      ;(firstRead.metadata as typeof metadata).labels.push("read mutation")
      const secondRead = Option.getOrThrow(yield* state.deferred(address))
      expect(secondRead.exit).toEqual({ nested: { value: "original" } })
      expect(secondRead.metadata).toEqual({ labels: ["original"] })
    }))

  it.effect("matches SQL by rejecting non-JSON deferred values", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const circular: Record<string, unknown> = {}
      circular["self"] = circular
      const exit = yield* Effect.exit(state.completeDeferred({
        flowName: "Ordering/Flow",
        executionId: "non-json",
        deferredName: "answer",
        exit: circular,
        completedAtMs: 0
      }))

      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect((defect as Error).message).toBe("exit must be JSON-serializable")
    }))

  it.effect("rolls every in-memory state family back when a transaction fails", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const address = {
        flowName: "Ordering/Flow",
        executionId: "rollback",
        deferredName: "answer"
      }
      const failed = yield* Effect.exit(state.transaction(Effect.gen(function*() {
        yield* state.completeDeferred({ ...address, exit: { value: 1 }, completedAtMs: 0 })
        yield* state.scheduleClock({
          ...address,
          clockName: "timer",
          dueAtMs: 1,
          completedAtMs: null
        }, owner)
        yield* state.park("rollback", { reason: "timer", wakeAt: 1 }, owner)
        yield* state.recordRunParent("rollback", "parent")
        return yield* Effect.fail("rollback")
      })))

      expect(Exit.isFailure(failed)).toBe(true)
      expect(Option.isNone(yield* state.deferred(address))).toBe(true)
      expect(Option.isNone(yield* state.clock({ ...address, clockName: "timer" }))).toBe(true)
      expect(Option.isNone(yield* state.waiting("rollback"))).toBe(true)
      expect(yield* state.runParents("rollback")).toEqual([])
    }))

  it.effect("uses nested in-memory transactions as savepoints", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      yield* state.transaction(Effect.gen(function*() {
        yield* state.recordRunParent("child", "outer-before")
        yield* state.transaction(Effect.gen(function*() {
          yield* state.recordRunParent("child", "inner")
          return yield* Effect.fail("inner rollback")
        })).pipe(Effect.catchCause(() => Effect.void))
        yield* state.recordRunParent("child", "outer-after")
      }))

      expect((yield* state.runParents("child")).map((edge) => edge.parentId)).toEqual([
        "outer-before",
        "outer-after"
      ])
    }))
})

describe("SQL durable state encoding failures", () => {
  it.effect("dies with a field-named defect when a deferred exit is not JSON-serializable", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          yield* insertOwnedRun("bad-exit")
          const state = yield* DurableEngineState.make
          const circular: Record<string, unknown> = {}
          circular["self"] = circular
          return yield* Effect.exit(state.completeDeferred({
            flowName: "Ordering/Flow",
            executionId: "bad-exit",
            deferredName: "answer",
            exit: circular,
            completedAtMs: 0
          }))
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect((defect as Error).message).toBe("exit must be JSON-serializable")
    }))

  it.effect("dies when deferred metadata encodes to `undefined` rather than persisting a null row", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          yield* insertOwnedRun("bad-metadata")
          const state = yield* DurableEngineState.make
          return yield* Effect.exit(state.completeDeferred({
            flowName: "Ordering/Flow",
            executionId: "bad-metadata",
            deferredName: "answer",
            exit: Exit.succeed("ok"),
            // `JSON.stringify` of a bare function yields `undefined`, which is
            // not a storable column value.
            metadata: () => "not serializable",
            completedAtMs: 0
          }))
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect((defect as Error).message).toBe("metadata must be JSON-serializable")
    }))

  it.effect("dies when a persisted deferred exit column holds malformed JSON", () =>
    Effect.gen(function*() {
      const address = {
        flowName: "Ordering/Flow",
        executionId: "corrupt",
        deferredName: "answer"
      }
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* insertOwnedRun("corrupt")
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const state = yield* DurableEngineState.make
          const missing = yield* state.deferred(address)
          yield* TestDatabase.checks(sql, false)
          yield* sql`
          INSERT INTO flows_deferred_completions (
            flow_name, execution_id, deferred_name, exit_json, metadata_json, completed_at_ms
          ) VALUES (
            ${address.flowName}, ${address.executionId}, ${address.deferredName}, '{not json', NULL, 0
          )
        `
          return { missing, read: yield* Effect.exit(state.deferred(address)) }
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(Option.isNone(result.missing)).toBe(true)
      expect(Exit.isFailure(result.read)).toBe(true)
      const defect = Exit.isFailure(result.read) ? Cause.squash(result.read.cause) : undefined
      expect((defect as Error).message).toBe("could not decode exit_json")
    }))
})

describe("SQL first-writer transaction integrity", () => {
  it.effect("dies rather than inventing an outcome when the conflicting row cannot be re-read", () =>
    Effect.gen(function*() {
      const address = {
        flowName: "Ordering/Flow",
        executionId: "torn",
        deferredName: "answer"
      }
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          yield* insertOwnedRun("torn")
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const first = yield* DurableEngineState.make
          yield* first.completeDeferred({ ...address, exit: Exit.succeed("first"), completedAtMs: 0 })

          // Fault injection: the second writer's INSERT conflicts (the row is
          // there), but its read-back inside the same transaction returns
          // nothing — a torn transaction. Fabricating either outcome would be
          // worse than dying.
          const blindSelect = Object.assign(
            (strings: TemplateStringsArray, ...args: ReadonlyArray<unknown>) =>
              strings.join("").includes("FROM flows_deferred_completions")
                ? Effect.succeed([])
                : (sql as unknown as (
                  strings: TemplateStringsArray,
                  ...args: ReadonlyArray<unknown>
                ) => unknown)(strings, ...args),
            sql
          )
          const torn = yield* DurableEngineState.make.pipe(
            Effect.provideService(SqlClient.SqlClient, blindSelect as never)
          )
          return yield* Effect.exit(
            torn.completeDeferred({ ...address, exit: Exit.succeed("second"), completedAtMs: 1 })
          )
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect((defect as Error).message).toBe(
        "deferred completion disappeared during first-writer transaction"
      )
    }))
})
