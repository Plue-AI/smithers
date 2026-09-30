/**
 * A flow's `deadline` survives a restart on the durable engine: the start it
 * counts from is journaled, so the engine that resumes the run honors the
 * original deadline instead of starting a new one, and a run whose deadline
 * elapsed while no engine was up settles as soon as one comes back.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import * as Ownership from "@smthrs/run-store/Ownership"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const FlowRuntimeService = FlowRuntime.FlowRuntime

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "run-deadline" as never, changeId: "run-deadline" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

type Services =
  | Layer.Success<ReturnType<typeof TestStores.layer>>
  | StepBoundary.Service
  | DurableEngineState.DurableEngineState
  | Jj.Jj
  | TestClock.TestClock
  | Crypto.Crypto
  | Scope.Scope

const run = <A, E>(body: Effect.Effect<A, E, Services>) =>
  withCrypto(
    Effect.scoped(body).pipe(
      Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer()),
      Effect.provide(TestClock.layer())
    )
  )

const Deadlined = Flow.make("RunDeadline/Durable", {
  payload: {},
  success: Schema.String,
  deadline: "1 hour",
  body: opaqueHandlerBody
})
const gate = DurableDeferred.make("run-deadline-gate", { success: Schema.String })

/** One engine incarnation serving the flow; `body` runs while it is up. */
const incarnation = <A, E>(
  hostId: string,
  body: (engine: FlowRuntime.FlowRuntime["Service"]) => Effect.Effect<A, E, Services>
) =>
  Effect.scoped(Effect.gen(function*() {
    const engine = (yield* EngineStore.make({
      owner: { hostId },
      journalSource: hostId,
      isAlive: () => Effect.succeed(false)
    })) as FlowRuntime.FlowRuntime["Service"]
    yield* engine.register(Deadlined, () => DurableDeferred.await(gate))
    return yield* body(engine)
  }))

/** Whether the run has left `status` and no engine holds it. */
const left = (status: RunStore.RunStatus) =>
  Effect.map(
    Effect.flatMap(RunStore.RunStore, (runs) => runs.get("deadlined")),
    (row) => row.status !== status && row.owner === null
  )

/**
 * Advances the clock a minute at a time until the run leaves `status`. After
 * each minute it gives the wake that minute may have fired a moment of real
 * time to land, so a slower store cannot shift the minute it is seen in.
 */
const until = (status: RunStore.RunStatus, limitMinutes: number) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    for (let minute = 0; minute < limitMinutes && !(yield* left(status)); minute++) {
      yield* TestClock.adjust("1 minute")
      for (let poll = 0; poll < 100 && !(yield* left(status)); poll++) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
      }
    }
    return yield* runs.get("deadlined")
  })

const expiry = (row: RunStore.RunRow) => {
  const state = JSON.parse(row.stateJson) as { readonly result?: unknown }
  return state.result
}

describe("Flow deadline across restarts", () => {
  it.effect("a resumed run expires at the original deadline, not a new one", () =>
    run(Effect.gen(function*() {
      yield* incarnation("run-deadline-first", (engine) =>
        executeUntilParked(engine, Deadlined, { executionId: "deadlined", payload: {}, discard: true }))
      // Forty minutes pass with no engine up.
      yield* TestClock.adjust("40 minutes")
      const settled = yield* incarnation("run-deadline-second", (engine) =>
        Effect.gen(function*() {
          yield* executeUntilParked(engine, Deadlined, { executionId: "deadlined", payload: {}, discard: true })
          expect((yield* (yield* RunStore.RunStore).get("deadlined")).status).toBe("suspended")
          // Twenty more minutes reach the original deadline; a fresh one would
          // still have forty to go.
          return yield* until("suspended", 25)
        }))
      expect(settled.status).toBe("failed")
      expect(JSON.stringify(expiry(settled))).toContain("@smthrs/flow/DeadlineExceeded")
      expect(JSON.stringify(expiry(settled))).toContain("counted from its start at 1970-01-01T00:00:00.000Z")
      // It settled at the original hour, not forty minutes after it.
      expect(yield* Clock.currentTimeMillis).toBeLessThanOrEqual(61 * 60_000)
    })))

  it.effect("a run whose deadline elapsed while no engine was up settles when one returns", () =>
    run(Effect.gen(function*() {
      yield* incarnation(
        "run-deadline-first",
        (engine) => executeUntilParked(engine, Deadlined, { executionId: "deadlined", payload: {}, discard: true })
      )
      yield* TestClock.adjust("2 hours")
      const settled = yield* incarnation("run-deadline-second", () => until("suspended", 5))
      expect(settled.status).toBe("failed")
      expect(JSON.stringify(expiry(settled))).toContain("DeadlineExceeded")
    })))

  it.effect("a run completed in time is not touched by its armed deadline clock", () =>
    run(Effect.gen(function*() {
      const settled = yield* incarnation("run-deadline-first", (engine) =>
        Effect.gen(function*() {
          yield* executeUntilParked(engine, Deadlined, { executionId: "deadlined", payload: {}, discard: true })
          const token = DurableDeferred.tokenFromExecutionId(gate, { flow: Deadlined, executionId: "deadlined" })
          yield* DurableDeferred.succeed(gate, { token, value: "opened" }).pipe(
            Effect.provideService(FlowRuntimeService, engine)
          )
          yield* TestDatabase.until(left("suspended"))
          return yield* (yield* RunStore.RunStore).get("deadlined")
        }))
      expect(settled.status).toBe("completed")
      yield* TestClock.adjust("2 hours")
      const later = yield* (yield* RunStore.RunStore).get("deadlined")
      expect(later.status).toBe("completed")
      expect(JSON.stringify(expiry(later))).not.toContain("DeadlineExceeded")
    })))
})

// A lineage whose originator declares the hour and hands off at once to a round
// that parks. The parked round declares no deadline of its own.
const Gated = Flow.make("RunDeadline/Gated", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const Opening = Flow.make("RunDeadline/Opening", {
  payload: {},
  success: Schema.String,
  deadline: "1 hour",
  body: () => Gated.to({})
})
const gatedRound = sha256(JSON.stringify(["flow-round/v2", "opening", 1]))

/**
 * One engine incarnation serving the lineage over the SQLite file `filename`,
 * opened afresh: its stores and its engine state are read from the file alone,
 * as a process that died and came back reads them. `body` runs while it is up.
 */
const lineageIncarnation = <A, E>(
  filename: string,
  hostId: string,
  body: Effect.Effect<A, E, RunStore.RunStore | FlowRuntime.FlowRuntime | Crypto.Crypto>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const engine = (yield* EngineStore.make({
        owner: { hostId },
        journalSource: hostId,
        isAlive: () => Effect.succeed(false)
      })) as FlowRuntime.FlowRuntime["Service"]
      yield* engine.register(Gated, () => DurableDeferred.await(gate))
      const wiring = yield* Layer.build(
        Interpreter.layer(Opening).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntimeService, engine))
        )
      )
      return yield* Effect.provideContext(body, wiring)
    }).pipe(
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(filename))
    )
  )

const stateOf = (row: RunStore.RunRow) =>
  JSON.parse(row.stateJson) as { readonly deadline?: unknown; readonly result?: unknown }

const gatedRow = Effect.flatMap(RunStore.RunStore, (runs) => runs.get(gatedRound))

describe("Flow deadline across trampoline rounds", () => {
  it.effect("the round a handoff opens expires at the originator's deadline, across a restart", () =>
    withCrypto(
      Effect.gen(function*() {
        const directory = mkdtempSync(join(tmpdir(), "run-deadline-lineage-"))
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { recursive: true, force: true })))
        const filename = join(directory, "engine.db")
        const parked = yield* lineageIncarnation(
          filename,
          "run-deadline-first",
          Effect.gen(function*() {
            const engine = yield* FlowRuntimeService
            yield* engine.execute(Opening, { executionId: "opening", payload: {}, discard: true })
            yield* TestDatabase.until(Effect.map(
              Effect.option(gatedRow),
              (row) => row._tag === "Some" && row.value.status === "suspended"
            ))
            return yield* gatedRow
          })
        )
        // The parked round carries the originator's start and bound.
        expect(stateOf(parked).deadline).toEqual({ startedAtMs: 0, deadlineMs: 3_600_000 })
        // Forty minutes pass with no engine up.
        yield* TestClock.adjust("40 minutes")
        const settled = yield* lineageIncarnation(
          filename,
          "run-deadline-second",
          Effect.gen(function*() {
            for (let minute = 0; minute < 25 && (yield* gatedRow).status === "suspended"; minute++) {
              yield* TestClock.adjust("1 minute")
              for (let poll = 0; poll < 100 && (yield* gatedRow).status === "suspended"; poll++) {
                yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
              }
            }
            return yield* gatedRow
          })
        )
        expect(settled.status).toBe("failed")
        const result = JSON.stringify(stateOf(settled).result)
        expect(result).toContain("@smthrs/flow/DeadlineExceeded")
        expect(result).toContain("RunDeadline/Gated")
        expect(result).toContain("counted from its start at 1970-01-01T00:00:00.000Z")
        // It settled at the originator's hour, not an hour after the round opened.
        expect(yield* Clock.currentTimeMillis).toBeLessThanOrEqual(61 * 60_000)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()))
    ))
})

const TreeLeaf = Flow.make("RunDeadline/tree-leaf", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const TreeChild = Flow.make("RunDeadline/tree-child", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const TreeParent = Flow.make("RunDeadline/tree-parent", {
  payload: {},
  success: Schema.String,
  deadline: "1 hour",
  body: opaqueHandlerBody
})
const treeIncarnation = <A, E>(
  filename: string,
  hostId: string,
  body: (engine: FlowRuntime.FlowRuntime["Service"]) => Effect.Effect<A, E, Services>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const engine = yield* EngineStore.make({
        owner: { hostId },
        journalSource: hostId,
        isAlive: () => Effect.succeed(false)
      })
      yield* engine.register(TreeLeaf, () => DurableDeferred.await(gate))
      yield* engine.register(TreeChild, () => TreeLeaf.execute({}, { executionId: "tree-leaf" }).pipe(Effect.orDie))
      yield* engine.register(TreeParent, () => TreeChild.execute({}, { executionId: "tree-child" }).pipe(Effect.orDie))
      return yield* body(engine)
    }).pipe(
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(filename))
    )
  )
it.effect("deadline expiry cancels the persisted attached tree after reopening its database", () =>
  withCrypto(
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "run-deadline-tree-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { recursive: true, force: true })))
      const pgUrl = process.env.SMITHERS_TEST_PG_URL
      const schema = `deadline_tree_${randomUUID().replaceAll("-", "")}`
      const uri = pgUrl === undefined ? undefined : new URL(pgUrl)
      uri?.searchParams.set("schema", schema)
      const filename = uri?.toString() ?? join(directory, "engine.db")
      if (uri !== undefined) {
        yield* Effect.addFinalizer(() =>
          Effect.scoped(
            Effect.flatMap(SqlClient.SqlClient, (sql) => TestDatabase.dropSchema(sql, schema)).pipe(
              Effect.provide(TestStores.databaseAt(filename)),
              Effect.orDie
            )
          )
        )
      }
      yield* treeIncarnation(filename, "tree-before", (engine) =>
        Effect.gen(function*() {
          yield* engine.execute(TreeParent, { executionId: "tree-parent", payload: {}, discard: true })
          const runs = yield* RunStore.RunStore
          yield* TestDatabase.until(
            Effect.map(
              Effect.option(runs.get("tree-leaf")),
              (row) => row._tag === "Some" && row.value.status === "suspended"
            )
          )
          yield* TestDatabase.until(Effect.gen(function*() {
            const parent = yield* runs.get("tree-parent")
            const child = yield* runs.get("tree-child")
            return parent.status === "suspended" && child.status === "suspended"
          }))
          expect((yield* runs.get("tree-parent")).status).toBe("suspended")
          expect((yield* runs.get("tree-child")).status).toBe("suspended")
        }))
      yield* TestClock.adjust("40 minutes")
      yield* treeIncarnation(filename, "tree-after", () =>
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          for (let minute = 0; minute < 25 && (yield* runs.get("tree-parent")).status !== "failed"; minute++) {
            yield* TestClock.adjust("1 minute")
            for (
              let poll = 0;
              poll < 100 && (yield* runs.get("tree-parent")).status !== "failed";
              poll++
            ) yield* Effect.promise(() => new Promise<void>((r) => setTimeout(r, 2)))
          }
          const parent = yield* runs.get("tree-parent")
          expect(parent.status).toBe("failed")
          expect(JSON.stringify(stateOf(parent).result)).toContain("@smthrs/flow/DeadlineExceeded")
          expect(JSON.stringify(stateOf(parent).result)).toContain(
            "counted from its start at 1970-01-01T00:00:00.000Z"
          )
          expect(yield* Clock.currentTimeMillis).toBeLessThanOrEqual(61 * 60_000)
          // The parent and subtree requests commit atomically. A parked child
          // is then delivered by the configured cancellation sweep, not a live
          // body's cancel poll. Keep virtual time moving while observing it.
          const childRequest = yield* runs.get("tree-child")
          const leafRequest = yield* runs.get("tree-leaf")
          expect(parent.cancelRequestedAtMs).toBeNull()
          expect(childRequest.cancelRequestedAtMs).not.toBeNull()
          expect(leafRequest.cancelRequestedAtMs).toBe(childRequest.cancelRequestedAtMs)
          const stopped = () =>
            Effect.gen(function*() {
              return (yield* runs.get("tree-child")).status === "cancelled" &&
                (yield* runs.get("tree-leaf")).status === "cancelled"
            })
          for (let pulse = 0; pulse < 2 && !(yield* stopped()); pulse++) {
            yield* TestClock.adjust(Ownership.heartbeatInterval)
            for (let poll = 0; poll < 100 && !(yield* stopped()); poll++) {
              yield* Effect.promise(() => new Promise<void>((r) => setTimeout(r, 2)))
            }
          }
          const states = [(yield* runs.get("tree-child")).status, (yield* runs.get("tree-leaf")).status]
          expect(states).toEqual(["cancelled", "cancelled"])
          expect((yield* runs.get("tree-parent")).status).toBe("failed")
          expect((yield* runs.get("tree-parent")).stateJson).toEqual(parent.stateJson)
        }))
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()))
  ))
