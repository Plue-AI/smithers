import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Issue #59: the retry verdict is durable. A persisted `failed` attempt row
 * replays by rethrowing the persisted domain failure — never by surfacing
 * `AttemptAdmissionRejected` — so a policy-declared `nonRetryable` error
 * matches on resume: the action body is not re-dispatched and the backoff
 * ladder is not re-slept.
 *
 * Temporal prior art: mutable state persists the attempt failure alongside
 * `ExecutionInfo.Attempt`, and the no-retry decision
 * (`service/history/workflow/retry.go`) is re-evaluated against that
 * persisted failure after a restart — the failure itself is durable, not
 * just the fact that an attempt happened.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import * as Notifying from "@smthrs/journal/test/Notifying"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { key, sha256, withCrypto } from "./Sha256.ts"

const ReplayFlow = Flow.make("NonRetryableReplay/Flow", {
  payload: {},
  success: Schema.String,
  error: Schema.Struct({ _tag: Schema.Literal("FatalBoom"), detail: Schema.String }),
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "non-retryable-snapshot" as never, changeId: "non-retryable-snapshot" as never }),
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
  | Layer.Success<ReturnType<typeof Action.layerCacheEnvironment>>
  | Crypto.Crypto

const provide = <A, E>(effect: Effect.Effect<A, E, Services>, state: DurableEngineState.Service) =>
  withCrypto(
    effect.pipe(
      Effect.provideService(DurableEngineState.DurableEngineState, state),
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer()),
      Effect.provide(TestClock.layer()),
      // Sealed cache keys hash the resolved environment. Declaring an empty
      // one — what a hand-wired composition does through
      // `Action.layerCacheEnvironment` — keeps the key run-independent so
      // the mirror below can reproduce it; leaving it undeclared would pin
      // each key to its own execution.
      Effect.provide(Action.layerCacheEnvironment(environment))
    )
  )

// The engine derives a sealed action's string idempotency key through the
// generic `Key` schema; the test mirrors the engine-owned input to inspect the persisted rows.
// Since issue #120 the body also folds the declared success/error schemas
// (their stable `SchemaRepresentation` document form) — both actions
// below share the same declaration.
const declaration = {
  success: SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(Schema.String.ast)),
  error: SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(
    Schema.Struct({ _tag: Schema.Literal("FatalBoom"), detail: Schema.String }).ast
  ))
}
const environment = { layers: [], capabilities: {} } satisfies Action.CacheEnvironment
// `form` names which idempotency-key form built `input`, so a caller object
// that spells the string form's encoding cannot alias it (B3).
const actionKey = (name: string, idempotencyKey: string) =>
  key({
    kind: "cache",
    form: "declared",
    input: { action: name, idempotencyKey, declaration: key(declaration) },
    environment
  })

describe("non-retryable classification against the real error class (issue #165)", () => {
  it("classifies a real CacheCorruptionDetected instance non-retryable under every policy", () => {
    // `defaultNonRetryable` matches by string so engine never depends on
    // engine-store, and RetryPolicy's own test asserts against a synthetic
    // `{ _tag }` object for the same reason — so nothing pinned the literal
    // to the exported class. Renaming the tag in ActionPersistence left
    // every suite green while cache corruption silently became retryable
    // again. This cross-package cell feeds the REAL instance through the
    // classification, so either side of the seam moving alone fails here.
    const corruption = new ActionPersistence.CacheCorruptionDetected({
      code: "cache_corruption_detected",
      keyDigest: "deadbeef",
      path: "dist/manifest.json",
      recordedDigest: "aa".repeat(32),
      measuredDigest: "bb".repeat(32)
    })
    expect(RetryPolicy.errorTag(corruption)).toBe("@smthrs/engine-store/CacheCorruptionDetected")
    expect(RetryPolicy.defaultNonRetryable).toContain(RetryPolicy.errorTag(corruption))
    const policy = RetryPolicy.make({ initialMs: 1, factor: 2, maxMs: 10, maxAttempts: 10 })
    expect(RetryPolicy.isNonRetryable(policy, corruption)).toBe(true)
  })
})

describe("non-retryable verdict durability across resume", () => {
  it.effect("does not re-dispatch a durably failed non-retryable action and propagates the original error without backoff sleeps", () =>
    Effect.gen(function*() {
      let dispatches = 0
      const fatal = Action.make({
        name: "NonRetryableReplay/fatal",
        success: Schema.String,
        error: Schema.Struct({ _tag: Schema.Literal("FatalBoom"), detail: Schema.String }),
        tier: "sealed",
        idempotencyKey: "non-retryable-v1",
        retryPolicy: RetryPolicy.make({
          initialMs: 60_000,
          factor: 2,
          maxMs: 600_000,
          maxAttempts: 10,
          nonRetryable: ["FatalBoom"]
        }),
        execute: Effect.suspend(() => {
          dispatches++
          return Effect.fail({ _tag: "FatalBoom" as const, detail: "durable" })
        })
      })
      const state = DurableEngineState.makeMemory()
      const makeEngine = EngineStore.make({
        owner: { hostId: "non-retryable-host" },
        journalSource: "non-retryable-test",
        isAlive: () => Effect.succeed(false)
      })
      const key = actionKey("NonRetryableReplay/fatal", "non-retryable-v1")
      const attemptId = {
        runId: "non-retryable-run",
        stepKeyDigest: sha256(key),
        attempt: 1
      }

      const result = yield* provide(
        Effect.gen(function*() {
          const attempts = yield* AttemptStore.AttemptStore
          const journal = yield* Journal.Journal
          // First process: the attempt fails and `attempts.finish` durably
          // records the non-retryable failure, then the process dies before
          // the failure propagates to the engine's retry decision — the hook
          // parks the fiber right after the failed finish and the scope close
          // interrupts it there, releasing the run.
          yield* Effect.scoped(Effect.gen(function*() {
            // The park sits on the journal transaction that commits the failed
            // attempt: its `after` firing is the first instant at which the
            // failure is durable — the row and its `attemptFinished` entry land
            // together — and it is still before the engine sees the failure and
            // takes a retry decision. Parking inside `attempts.finish` instead
            // would hold an open write transaction on this suite's single
            // SQLite connection, deadlocking the assertion below against it.
            let terminal = false
            let parked = false
            const blocked = Notifying.wrap(
              journal,
              (op, order, args) => {
                if (
                  op === "emitDurable" && order === "after" &&
                  (args[0] as { readonly eventType: string }).eventType === "flows.engine.attempt-finished"
                ) {
                  terminal = true
                  return Effect.void
                }
                if (op !== "transact" || order !== "after" || !terminal || parked) return Effect.void
                // Park exactly once. The scope close below interrupts the fiber
                // here, and the driver's interrupt finalizer releases the run
                // through another transaction — which must not park again.
                parked = true
                return Effect.interruptible(Effect.never)
              }
            )
            const engine = yield* Effect.provideService(
              makeEngine,
              Journal.Journal,
              blocked
            )
            yield* engine.register(ReplayFlow, () => fatal)
            yield* engine.execute(ReplayFlow, {
              executionId: "non-retryable-run",
              payload: {},
              discard: true
            }).pipe(Effect.forkChild({ startImmediately: true }))
            // Let the attempt run and durably fail; the fiber is now parked in
            // the post-finish hook.
            yield* Effect.yieldNow
            yield* TestDatabase.until(
              attempts.get(attemptId).pipe(Effect.map((row) => Option.isSome(row) && row.value.state === "failed"))
            )
            const row = yield* attempts.get(attemptId)
            expect(Option.isSome(row) && row.value.state === "failed").toBe(true)
          }))
          const dispatchesBeforeResume = dispatches

          // Second process: reclaim and re-drive. The persisted failed attempt
          // must replay the original `FatalBoom` — no readmission, no real
          // dispatch, and no backoff sleep (the clock is never advanced).
          yield* Effect.scoped(Effect.gen(function*() {
            const engine = yield* makeEngine
            yield* engine.register(ReplayFlow, () => fatal)
            const result = yield* engine.poll(ReplayFlow, "non-retryable-run")
            expect(Option.isNone(result)).toBe(true)
            yield* engine.execute(ReplayFlow, {
              executionId: "non-retryable-run",
              payload: {},
              discard: true
            })
            // Join the resumed drive's durable terminal commit. One scheduler
            // yield is not a completion receipt; closing here otherwise
            // interrupts a still-running drive and releases it as suspended.
          }))
          const store = yield* RunStore.RunStore
          return {
            dispatchesBeforeResume,
            dispatchesAfterResume: dispatches,
            row: yield* store.get("non-retryable-run")
          }
        }),
        state
      )

      expect(result.dispatchesBeforeResume).toBe(1)
      // The action body is never re-executed after resume.
      expect(result.dispatchesAfterResume).toBe(1)
      expect(result.row.status).toBe("failed")
      // The original domain error propagates — not the admission wrapper.
      expect(result.row.stateJson).toContain("FatalBoom")
      expect(result.row.stateJson).not.toContain("AttemptAdmissionRejected")
    }))

  it.effect("replays a persisted failed attempt row by rethrowing the persisted domain error", () =>
    Effect.gen(function*() {
      // Unit-level pin on `ActionPersistence`: a `failed` row must rethrow
      // the persisted cause — the `_tag` survives the JSON round trip so
      // `RetryPolicy` non-retryable matching works on replay.
      const { default: makeState } = { default: DurableEngineState.makeMemory }
      const state = makeState()
      const makeEngine = EngineStore.make({
        owner: { hostId: "failed-row-host" },
        journalSource: "failed-row-test",
        isAlive: () => Effect.succeed(false)
      })
      let dispatches = 0
      const flaky = Action.make({
        name: "NonRetryableReplay/tagged",
        success: Schema.String,
        error: Schema.Struct({ _tag: Schema.Literal("FatalBoom"), detail: Schema.String }),
        tier: "sealed",
        idempotencyKey: "tagged-v1",
        execute: Effect.suspend(() => {
          dispatches++
          return Effect.fail({ _tag: "FatalBoom" as const, detail: "unit" })
        })
      })

      const outcome = yield* provide(
        Effect.gen(function*() {
          // First run records the failure durably and fails the run.
          yield* Effect.scoped(Effect.gen(function*() {
            const engine = yield* makeEngine
            yield* engine.register(ReplayFlow, () => flaky)
            yield* engine.execute(ReplayFlow, {
              executionId: "failed-row-run",
              payload: {},
              discard: false
            }).pipe(Effect.exit)
          }))
          const attempts = yield* AttemptStore.AttemptStore
          const row = yield* attempts.get({
            runId: "failed-row-run",
            stepKeyDigest: sha256(actionKey("NonRetryableReplay/tagged", "tagged-v1")),
            attempt: 1
          })
          return { row, dispatches }
        }),
        state
      )

      expect(outcome.dispatches).toBe(1)
      const row = Option.getOrThrow(outcome.row)
      expect(row.state).toBe("failed")
      // The persisted cause is JSON-shaped Fail material whose `_tag`
      // survives, which is exactly what the replay branch rehydrates.
      const cause = row.error as {
        readonly reasons: ReadonlyArray<{ readonly _tag: string; readonly error?: unknown }>
      }
      expect(cause.reasons[0]?._tag).toBe("Fail")
      expect((cause.reasons[0]?.error as { readonly _tag: string })._tag).toBe("FatalBoom")
    }))

  it.effect("rehydrates persisted Die, Interrupt, and unrecognizable failure material", () =>
    Effect.gen(function*() {
      // A failed row can hold defect or interrupt reasons (a crashed boundary
      // preparation persists `Die` material), and a row written by an older
      // schema may hold anything: replay must never re-dispatch for any of
      // them.
      const owner = { hostId: "rehydrate-host", pid: 1, nonce: "rehydrate-owner" }
      const seedAndReplay = (key: string, error: AttemptStore.JsonValue) =>
        Effect.gen(function*() {
          const attempts = yield* AttemptStore.AttemptStore
          const runs = yield* RunStore.RunStore
          const runId = `rehydrate-${sha256(key).slice(0, 8)}`
          yield* runs.create(runId, "{}")
          const row = yield* runs.get(runId)
          yield* runs.claimAndOwn(
            runId,
            { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
            owner,
            0
          )
          const attemptId = { runId, stepKeyDigest: sha256(key), attempt: 1 }
          yield* attempts.put({ ...attemptId, state: "running", startedAtMs: 0, meta: { tier: "sealed" } }, owner)
          yield* attempts.finish(
            { ...attemptId, state: "failed", finishedAtMs: 0, error, meta: { tier: "sealed" } },
            owner
          )
          let dispatches = 0
          const executor = ActionPersistence.make({
            runId,
            owner,
            sourceId: "rehydrate-test",
            execute: () => Effect.sync(() => dispatches++)
          })
          const exit = yield* executor({ action: {}, attempt: 1, key, tier: "sealed" }).pipe(Effect.exit)
          return { exit, dispatches }
        })

      const outcome = yield* provide(
        Effect.all({
          die: seedAndReplay("rehydrate/die", { reasons: [{ _tag: "Die", defect: { boom: true } }] }),
          interrupt: seedAndReplay("rehydrate/interrupt", { reasons: [{ _tag: "Interrupt", fiberId: null }] }),
          raw: seedAndReplay("rehydrate/raw", "not-a-cause-shape")
        }),
        DurableEngineState.makeMemory()
      )

      expect(outcome.die.dispatches).toBe(0)
      expect(Exit.isFailure(outcome.die.exit)).toBe(true)
      if (Exit.isFailure(outcome.die.exit)) {
        expect(outcome.die.exit.cause.reasons[0]?._tag).toBe("Die")
      }
      expect(outcome.interrupt.dispatches).toBe(0)
      expect(Exit.isFailure(outcome.interrupt.exit)).toBe(true)
      if (Exit.isFailure(outcome.interrupt.exit)) {
        expect(outcome.interrupt.exit.cause.reasons[0]?._tag).toBe("Interrupt")
      }
      // Unrecognizable persisted material degrades to a defect carrying it.
      expect(outcome.raw.dispatches).toBe(0)
      expect(Exit.isFailure(outcome.raw.exit)).toBe(true)
      if (Exit.isFailure(outcome.raw.exit)) {
        expect(outcome.raw.exit.cause.reasons[0]?._tag).toBe("Die")
      }
    }))
})
