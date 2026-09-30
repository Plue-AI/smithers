import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #77: probing the surviving attempts for an action key must
 * not cost up to 32 sequential `AttemptStore.get` point reads per fresh
 * dispatch (doubled when the policy declares `expirationMs`). Over SQL
 * durable state the probe is one `attemptSurvivors` range read, so the
 * counting store below sees only the executor's own row lookups — a scan
 * regression reappears as dozens of gets and fails the bound.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { withCrypto } from "./Sha256.ts"

const ProbeFlow = Flow.make("AttemptProbeCost/Flow", {
  payload: {},
  success: Schema.String,
  error: Schema.String,
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "probe-cost-snapshot" as never, changeId: "probe-cost-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

describe("attempt probe cost over SQL durable state (issue #77)", () => {
  it.effect("a fresh action with an expirationMs policy dispatches without per-attempt point-read scans", () =>
    Effect.gen(function*() {
      let dispatches = 0
      const steady = Action.make({
        name: "steady",
        success: Schema.String,
        error: Schema.String,
        tier: "sealed",
        retryPolicy: RetryPolicy.make({
          initialMs: 10,
          factor: 1,
          maxMs: 10,
          expirationMs: 100_000,
          maxAttempts: 3
        }),
        execute: Effect.suspend(() => {
          dispatches++
          return Effect.succeed("ok")
        })
      })

      const stores = Layer.mergeAll(
        SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
        RunStore.layer,
        AttemptStore.layer,
        CacheStore.layer,
        DurableEngineState.layer
      ).pipe(
        Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)),
        Layer.merge(OwnerIdentity.layer)
      )

      let gets = 0
      const result = yield* withCrypto(
        Effect.gen(function*() {
          // Decorate the real store so every point read the engine issues for
          // this run is counted — the probe scan used to issue up to 64 here.
          const base = yield* AttemptStore.AttemptStore
          const counting: AttemptStore.Service = {
            ...base,
            get: (id) => Effect.suspend(() => (gets++, base.get(id)))
          }
          yield* Effect.scoped(Effect.gen(function*() {
            const engine = yield* EngineStore.make({
              owner: { hostId: "probe-cost-host" },
              journalSource: "probe-cost-test",
              isAlive: () => Effect.succeed(false)
            }).pipe(Effect.provideService(AttemptStore.AttemptStore, counting))
            yield* engine.register(ProbeFlow, () => steady)
            const fiber = yield* engine.execute(ProbeFlow, {
              executionId: "probe-cost",
              payload: {},
              discard: false
            }).pipe(Effect.forkChild({ startImmediately: true }))
            yield* TestClock.adjust("1 seconds")
            yield* Fiber.await(fiber)
          }))
          const store = yield* RunStore.RunStore
          return { row: yield* store.get("probe-cost") }
        }).pipe(
          Effect.provideService(Jj.Jj, jj),
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(stores),
          Effect.provide(TestClock.layer())
        )
      )

      expect(dispatches).toBe(1)
      expect(result.row.status).toBe("completed")
      // The executor's own persisted-row lookup remains; the probe's 32-read
      // fresh-key scan (and its expirationMs double) must not.
      expect(gets).toBeLessThan(5)
    }))
})
