/**
 * A replay-only engine serves recorded dispatches and executes none.
 *
 * The run is parked by an ordinary engine, then driven again by a second
 * engine composed with `ReplayOnly` over the same store, the way
 * `smthrs runs verify` drives a copy of a project's store under current code.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, DurableDeferred, Flow, type FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as ReplayOnly from "../src/ReplayOnly.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "replay-only" as never, changeId: "replay-only" as never }),
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

const engineFor = (hostId: string) =>
  Effect.map(
    EngineStore.make({ owner: { hostId }, journalSource: hostId, isAlive: () => Effect.succeed(false) }),
    (engine) => engine as FlowRuntime.FlowRuntime["Service"]
  )

const VerifiedFlow = Flow.make("ReplayOnly/Flow", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const gate = DurableDeferred.make("replay-only-gate", { success: Schema.String })
const Refused = Schema.Struct({ _tag: Schema.Literal("Refused") })

/** Counts body runs per action name, so a replay that executed anything shows. */
const bodies = () => {
  const ran: Array<string> = []
  const action = (name: string, tier: Action.Tier) =>
    Action.make({
      name,
      tier,
      success: Schema.String,
      execute: Effect.sync(() => {
        ran.push(name)
        return `${name}-result`
      })
    })
  return { ran, action }
}

/** The steps a fixture flow dispatches before it parks on the gate. */
type Steps = Effect.Effect<unknown, never, FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Crypto.Crypto>

/** Parks the run after its steps, under an ordinary engine that is then shut down. */
const park = (steps: Steps) =>
  Effect.scoped(Effect.gen(function*() {
    const engine = yield* engineFor("replay-only-origin")
    yield* engine.register(VerifiedFlow, () => Effect.andThen(steps, DurableDeferred.await(gate)))
    yield* executeUntilParked(engine, VerifiedFlow, { executionId: "verified", payload: {}, discard: true })
  }))

/** Drives the parked run again with a replay-only engine, returning what it reported. */
const verify = (steps: Steps) =>
  Effect.scoped(Effect.gen(function*() {
    const seen: Array<ReplayOnly.Dispatch> = []
    const engine = yield* engineFor("replay-only-verifier").pipe(
      Effect.provide(ReplayOnly.layer((dispatch) => Effect.sync(() => seen.push(dispatch))))
    )
    let drives = 0
    yield* engine.register(
      VerifiedFlow,
      () => Effect.sync(() => drives++).pipe(Effect.andThen(steps), Effect.andThen(DurableDeferred.await(gate)))
    )
    // The run is already parked, so its status alone cannot say the verifier
    // re-drove it: wait for the body to be entered, then for the run to settle.
    yield* engine.execute(VerifiedFlow, { executionId: "verified", payload: {}, discard: true })
    const runs = yield* RunStore.RunStore
    yield* TestDatabase.until(
      Effect.map(
        runs.get("verified"),
        (row) => drives > 0 && row.owner === null && (row.status === "suspended" || row.status === "failed")
      )
    )
    const row = yield* runs.get("verified")
    return { seen, row }
  }))

/** The attempt row a step key was recorded under, if any. */
const attempt = (stepKeyDigest: string) =>
  Effect.flatMap(
    AttemptStore.AttemptStore,
    (attempts) => Effect.map(attempts.get({ runId: "verified", stepKeyDigest, attempt: 1 }), Option.getOrUndefined)
  )

describe("ReplayOnly", () => {
  it.effect("an unchanged flow replays every recorded step and parks where it was", () =>
    run(Effect.gen(function*() {
      const { ran, action } = bodies()
      const steps = Effect.andThen(action("ReplayOnly/a", "sealed"), action("ReplayOnly/b", "irreversible"))
      yield* park(steps)
      const { seen, row } = yield* verify(steps)

      expect(ran).toEqual(["ReplayOnly/a", "ReplayOnly/b"])
      expect(row.status).toBe("suspended")
      expect(seen.map((dispatch) => [dispatch.action, dispatch.outcome, dispatch.tier])).toEqual([
        ["ReplayOnly/a", "replayed", "sealed"],
        ["ReplayOnly/b", "replayed", "irreversible"]
      ])
      for (const dispatch of seen) expect((yield* attempt(dispatch.stepKeyDigest))?.state).toBe("succeeded")
      expect(seen.every((dispatch) => dispatch.runId === "verified" && dispatch.attempt === 1)).toBe(true)
    })))

  it.effect("a re-keyed step stops at the gate before any attempt, body or retry", () =>
    run(Effect.gen(function*() {
      const { ran, action } = bodies()
      yield* park(Effect.andThen(action("ReplayOnly/a", "sealed"), action("ReplayOnly/b", "irreversible")))
      const renamed = Action.make({
        name: "ReplayOnly/b-renamed",
        tier: "irreversible",
        idempotencyKey: "b",
        success: Schema.String,
        // A typed failure would retry forever under this policy; the gate's
        // defect is never retried, so the run settles after one refusal.
        retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1 }),
        execute: Effect.sync(() => {
          ran.push("ReplayOnly/b-renamed")
          return "unexpected"
        })
      })
      const { seen, row } = yield* verify(Effect.andThen(action("ReplayOnly/a", "sealed"), renamed))

      expect(ran).toEqual(["ReplayOnly/a", "ReplayOnly/b"])
      expect(row.status).toBe("failed")
      expect(seen.map((dispatch) => [dispatch.action, dispatch.outcome])).toEqual([
        ["ReplayOnly/a", "replayed"],
        ["ReplayOnly/b-renamed", "would-execute"]
      ])
      const refused = seen[1]!
      expect(refused.tier).toBe("irreversible")
      // No attempt row was admitted for the refused key.
      expect(yield* attempt(refused.stepKeyDigest)).toBeUndefined()
      expect((yield* attempt(seen[0]!.stepKeyDigest))?.state).toBe("succeeded")
    })))

  it.effect("a recorded failure the flow recovered from replays as a failure, not a new attempt", () =>
    run(Effect.gen(function*() {
      let failures = 0
      const failing = Action.make({
        name: "ReplayOnly/failing",
        tier: "sealed",
        success: Schema.String,
        error: Refused,
        execute: Effect.suspend(() => {
          failures += 1
          return Effect.fail({ _tag: "Refused" as const })
        })
      })
      const steps = failing.pipe(Effect.catch(() => Effect.succeed("recovered")))
      yield* park(steps)
      const { seen, row } = yield* verify(steps)

      expect(failures).toBe(1)
      expect(row.status).toBe("suspended")
      expect(seen.map((dispatch) => [dispatch.action, dispatch.outcome])).toEqual([["ReplayOnly/failing", "replayed"]])
    })))

  it.effect("a step parked inside its own body is re-entered, reported as resumes", () =>
    run(Effect.gen(function*() {
      let entered = 0
      const inner = DurableDeferred.make("replay-only-inner", { success: Schema.String })
      const waiter = Action.make({
        name: "ReplayOnly/waiter",
        tier: "irreversible",
        idempotencyKey: "waiter",
        success: Schema.String,
        execute: Effect.suspend(() => {
          entered += 1
          return DurableDeferred.await(inner)
        })
      })
      yield* park(waiter)
      const { seen, row } = yield* verify(waiter)

      expect(entered).toBe(1)
      expect(row.status).toBe("failed")
      expect(seen.map((dispatch) => [dispatch.action, dispatch.outcome])).toEqual([["ReplayOnly/waiter", "resumes"]])
      expect((yield* attempt(seen[0]!.stepKeyDigest))?.state).toBe("running")
    })))

  it("names the refused dispatch in its message", () => {
    const refused = new ReplayOnly.WouldExecute({ runId: "r", stepKeyDigest: "d", attempt: 2, action: "a" })
    expect(refused.message).toBe("Action a (step d, attempt 2) would execute")
  })
})
