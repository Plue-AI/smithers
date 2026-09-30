import { executeUntilParked } from "./ExecuteUntilParked.ts"
/**
 * Issue #1805: the compensable restore-before-retry handle is durable. The
 * engine's `SnapshotBoundary` handle taken before attempt 1 is persisted in
 * the attempt row, so a process that reclaims the run restores that original
 * pre-image before attempt 2 instead of losing it with the dead process.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const RestartFlow = Flow.make("CompensableSnapshotRestart/Flow", {
  payload: {},
  success: Schema.String,
  error: Schema.String,
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "engine-pre-image" as never, changeId: "engine-pre-image" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/** A host boundary whose handles are only meaningful if carried across processes. */
const recordingBoundary = (
  events: Array<string>,
  handleFor: (count: number) => unknown = (count) => `handle-${count}`
) => {
  let taken = 0
  return FlowEngine.SnapshotBoundary.of({
    snapshot: ({ attempt }) =>
      Effect.sync(() => {
        const handle = handleFor(++taken)
        events.push(`snapshot:${attempt}:${String(handle)}`)
        return handle
      }),
    restore: (handle, { attempt }) => Effect.sync(() => events.push(`restore:${attempt}:${String(handle)}`)),
    diff: (handle, { attempt }) =>
      Effect.sync(() => {
        events.push(`diff:${attempt}:${String(handle)}`)
        return ""
      })
  })
}

type Step = "fail" | "hang" | "succeed"

/** Each dispatch follows the next scripted step; `hang` never settles. */
const scriptedAction = (name: string, script: ReadonlyArray<Step>, dispatches: { count: number }) =>
  Action.make({
    name,
    success: Schema.String,
    error: Schema.String,
    tier: "compensable",
    retryPolicy: RetryPolicy.make({ initialMs: 10_000, factor: 1, maxMs: 10_000, maxAttempts: 3 }),
    execute: Effect.suspend(() => {
      const step = script[dispatches.count++] ?? "succeed"
      return step === "fail" ? Effect.fail("boom") : step === "hang" ? Effect.never : Effect.succeed("done")
    })
  })

const run = (options: {
  readonly executionId: string
  readonly script?: ReadonlyArray<Step>
  readonly handleFor?: (count: number) => unknown
}) =>
  Effect.gen(function*() {
    const dispatches = { count: 0 }
    const script = options.script ?? ["fail", "succeed"]
    const action = scriptedAction(`${options.executionId}-action`, script, dispatches)
    const makeEngine = EngineStore.make({
      owner: { hostId: "compensable-restart-host" },
      journalSource: "compensable-restart-test",
      isAlive: () => Effect.succeed(false)
    })
    const first: Array<string> = []
    const second: Array<string> = []
    let handles = 0
    const handleFor = (count: number) => (options.handleFor ?? ((n: number) => `handle-${n}`))(count + handles)

    // First process: attempt 1 fails, then the process dies mid-backoff.
    yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* makeEngine
      yield* engine.register(RestartFlow, () => action)
      yield* executeUntilParked(engine, RestartFlow, {
        executionId: options.executionId,
        payload: {},
        discard: true
      }).pipe(Effect.forkChild({ startImmediately: true }))
      const journal = yield* Journal.Journal
      if (script[0] === "hang") {
        // Dies mid-attempt: the row stays running with its persisted handle.
        yield* TestDatabase.until(Effect.sync(() => dispatches.count >= 1))
        return
      }
      yield* TestDatabase.until(
        journal.entries({ runId: options.executionId as never, limit: 200 }).pipe(
          Effect.map((page) => page.entries.some((entry) => entry.eventType === "flows.engine.attempt-finished"))
        )
      )
    })).pipe(Effect.provideService(FlowEngine.SnapshotBoundary, recordingBoundary(first, handleFor)))
    handles = first.filter((event) => event.startsWith("snapshot:")).length

    // Second process: a fresh engine with no in-memory state reclaims the run.
    yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* makeEngine
      yield* engine.register(RestartFlow, () => action)
      const fiber = yield* executeUntilParked(engine, RestartFlow, {
        executionId: options.executionId,
        payload: {},
        discard: true
      }, ["completed", "failed"]).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestDatabase.until(
        TestClock.adjust("1 second").pipe(Effect.map(() => fiber.pollUnsafe() !== undefined))
      )
      yield* Fiber.await(fiber)
    })).pipe(Effect.provideService(FlowEngine.SnapshotBoundary, recordingBoundary(second, handleFor)))

    const store = yield* RunStore.RunStore
    return { first, second, dispatches: dispatches.count, row: yield* store.get(options.executionId) }
  }).pipe(
    Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
    Effect.provideService(Jj.Jj, jj),
    Effect.provide(StepBoundary.layerTest()),
    Effect.provide(TestStores.layer()),
    Effect.provide(TestClock.layer()),
    withCrypto
  )

describe("durable compensable snapshot handle", () => {
  it.effect("restores the original compensable handle after a restart before attempt 2", () =>
    Effect.gen(function*() {
      const result = yield* run({ executionId: "compensable-restart" })

      expect(result.first).toEqual(["snapshot:1:handle-1", "diff:1:handle-1"])
      // The replayed failed attempt 1 touches no boundary; attempt 2 first
      // restores the pre-image the dead process took.
      expect(result.second).toEqual(["restore:2:handle-1", "snapshot:2:handle-2", "diff:2:handle-2"])
      expect(result.dispatches).toBe(2)
      expect(result.row.status).toBe("completed")
    }))

  it.effect("keeps the dead incarnation's handle when an unfinished attempt is adopted", () =>
    Effect.gen(function*() {
      const result = yield* run({ executionId: "compensable-adopted", script: ["hang", "fail", "succeed"] })

      expect(result.first).toEqual(["snapshot:1:handle-1", "diff:1:handle-1"])
      // The adopted attempt 1 and the retry both restore the first handle,
      // not the fresh snapshot the re-execution took for its own diff.
      expect(result.second).toEqual([
        "restore:1:handle-1",
        "snapshot:1:handle-2",
        "diff:1:handle-2",
        "restore:2:handle-1",
        "snapshot:2:handle-3",
        "diff:2:handle-3"
      ])
      expect(result.dispatches).toBe(3)
      expect(result.row.status).toBe("completed")
    }))

  it.effect("carries a null handle across the restart as a handle, not as no handle", () =>
    Effect.gen(function*() {
      const result = yield* run({
        executionId: "compensable-restart-null",
        handleFor: (count) => count === 1 ? null : `handle-${count}`
      })

      expect(result.first).toEqual(["snapshot:1:null", "diff:1:null"])
      expect(result.second).toEqual(["restore:2:null", "snapshot:2:handle-2", "diff:2:handle-2"])
      expect(result.row.status).toBe("completed")
    }))

  it.effect("carries an undefined handle across the restart", () =>
    Effect.gen(function*() {
      const result = yield* run({
        executionId: "compensable-restart-undefined",
        handleFor: (count) => count === 1 ? undefined : `handle-${count}`
      })

      expect(result.second).toEqual(["restore:2:undefined", "snapshot:2:handle-2", "diff:2:handle-2"])
    }))
})
