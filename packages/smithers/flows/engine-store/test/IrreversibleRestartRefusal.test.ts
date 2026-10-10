import { executeUntilParked } from "./ExecuteUntilParked.ts"
/**
 * Issue #2290: a process that dies inside an unkeyed irreversible action
 * leaves an unresolved crossing. The engine that reclaims the run refuses to
 * dispatch that action again, and the refusal settles the run as a defect
 * that keeps its tagged fields rather than the generic defect codec's name and
 * message.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow } from "@smthrs/flow"
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

const ChargeFlow = Flow.make("IrreversibleRestartRefusal/Flow", {
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

const run = (executionId: string) =>
  Effect.gen(function*() {
    const dispatches = { count: 0 }
    // The first dispatch never settles: its process dies mid-charge. A second
    // dispatch would charge again.
    const charge = Action.make({
      name: `${executionId}-charge`,
      success: Schema.String,
      error: Schema.String,
      tier: "irreversible",
      execute: Effect.suspend(() => ++dispatches.count === 1 ? Effect.never : Effect.succeed("charged again"))
    })
    const makeEngine = EngineStore.make({
      owner: { hostId: "irreversible-restart-host" },
      journalSource: "irreversible-restart-test",
      isAlive: () => Effect.succeed(false)
    })

    // First process: dies while the charge is in flight.
    yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* makeEngine
      yield* engine.register(ChargeFlow, () => charge)
      yield* executeUntilParked(engine, ChargeFlow, { executionId, payload: {}, discard: true }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestDatabase.until(Effect.sync(() => dispatches.count >= 1))
    }))

    // Second process: a fresh engine reclaims the run from the dead owner.
    yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* makeEngine
      yield* engine.register(ChargeFlow, () => charge)
      const fiber = yield* executeUntilParked(engine, ChargeFlow, { executionId, payload: {}, discard: true }, [
        "completed",
        "failed"
      ]).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestDatabase.until(
        TestClock.adjust("1 second").pipe(Effect.map(() => fiber.pollUnsafe() !== undefined))
      )
      yield* Fiber.await(fiber)
    }))

    const store = yield* RunStore.RunStore
    return { dispatches: dispatches.count, row: yield* store.get(executionId) }
  }).pipe(
    Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
    Effect.provideService(Jj.Jj, jj),
    Effect.provide(StepBoundary.layerTest()),
    Effect.provide(TestStores.layer()),
    Effect.provide(TestClock.layer()),
    withCrypto
  )

describe("an unkeyed irreversible action interrupted by a dead process", () => {
  it.effect("fails the reclaimed run with the tagged refusal instead of charging again", () =>
    Effect.gen(function*() {
      const result = yield* run("irreversible-restart")

      expect(result.dispatches).toBe(1)
      expect(result.row.status).toBe("failed")
      const exit = JSON.parse(result.row.stateJson).result.exit
      expect(exit._tag).toBe("Failure")
      expect(exit.cause).toEqual([{
        _tag: "Die",
        defect: {
          _tag: "@smthrs/flow/IrreversibleRetryRequiresIdempotencyKey",
          code: "irreversible_retry_requires_idempotency_key",
          actionName: "irreversible-restart-charge",
          attempt: 1
        }
      }])
    }))
})
