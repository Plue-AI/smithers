/**
 * A fresh process reclaims a hard-killed owner with no application code.
 *
 * `EngineStore.Options.isAlive` used to be required, so the durable engine
 * could not answer its own liveness question: a deployment that had nothing
 * but the persisted lease still had to write a probe, and one that wrote
 * `() => Effect.succeed(true)` to be safe could never recover from a SIGKILL
 * at all. The default is now the lease itself
 * (`Ownership.leaseLiveness`) — the owner is alive while its heartbeat is
 * younger than `heartbeatStaleAfter`, and gone once it is not — and the steal
 * it admits carries `lease-expired` evidence the store verifies in the same
 * write.
 *
 * Real SQLite, because the evidence being reasoned about (a `running` row with
 * a frozen `heartbeat_at_ms`) lives in `flows_runs`.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("LeaseLiveness/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const deadOwner: Ownership.OwnerId = { hostId: "dead-host", pid: 424242, nonce: "dead-nonce" }

/** A driver with NO application-supplied liveness probe. */
const makeDriver = (nonce: string) =>
  RunDriver.make({
    owner: { hostId: "lease-host", pid: 1, nonce },
    journalSource: "lease-liveness",
    engine: Effect.succeed(fakeEngine)
  })

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

/**
 * A run whose owner died without releasing it: `running`, a foreign owner, and
 * a heartbeat frozen at `heartbeatAtMs`.
 */
const insertOwnedRun = (runId: string, heartbeatAtMs: number) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter.DurableWriter
    const stateJson = JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, capabilityCeilings: [[]] })
    yield* writer.write(sql`
      INSERT INTO flows_runs (
        run_id, status, created_at_ms, started_at_ms,
        owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
      ) VALUES (
        ${runId}, 'running', 0, 0,
        ${deadOwner.hostId}, ${deadOwner.pid}, ${deadOwner.nonce}, ${heartbeatAtMs}, ${stateJson}
      )
    `).pipe(Effect.orDie)
  })

const decisionsOf = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const entries = yield* journal.entries({ runId: runId as never, limit: 200 })
    return entries.entries
      .filter((entry) => entry.eventType === "flows.engine.run-decision")
      .map((entry) => entry.payload as { readonly decision: string; readonly evidence?: string })
  })

type Services = Layer.Success<typeof services> | TestClock.TestClock | Crypto.Crypto | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(Effect.scoped(effect).pipe(Effect.provide(services), Effect.provide(TestClock.layer())))

const staleAfterMs = Duration.toMillis(Ownership.heartbeatStaleAfter)
const heartbeatMs = Duration.toMillis(Ownership.heartbeatInterval)

describe("lease-based default liveness", () => {
  it.effect("reclaims a hard-killed owner's run without any application-supplied probe", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* insertOwnedRun("lease-reclaim", 0)

        const driver = yield* makeDriver("reclaimer")
        yield* driver.register(TestFlow, () => Effect.succeed("reclaimed"))

        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        let row = yield* store.get("lease-reclaim")
        for (let tick = 0; tick < 2000 && row.status !== "completed"; tick++) {
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
          yield* TestClock.adjust(heartbeatMs)
          row = yield* store.get("lease-reclaim")
        }
        return { row, decisions: yield* decisionsOf("lease-reclaim") }
      }))

      expect(result.row.status).toBe("completed")
      expect(result.decisions).toContainEqual(
        expect.objectContaining({ decision: "stolen-and-activated", evidence: "lease-expired" })
      )
    }))

  it.effect("refuses the steal while the lease is fresh, and journals why", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        // Heartbeated one tick ago: well inside the staleness window.
        yield* TestClock.adjust(staleAfterMs)
        yield* insertOwnedRun("lease-fresh", staleAfterMs - heartbeatMs)

        const driver = yield* makeDriver("bystander")
        let bodyRuns = 0
        yield* driver.register(TestFlow, () =>
          Effect.sync(() => {
            bodyRuns += 1
            return "stolen-too-early"
          }))
        yield* driver.resume(TestFlow, "lease-fresh")

        return {
          bodyRuns,
          row: yield* store.get("lease-fresh"),
          decisions: yield* decisionsOf("lease-fresh")
        }
      }))

      expect(result.bodyRuns).toBe(0)
      expect(result.row.status).toBe("running")
      expect(result.row.owner).toEqual(deadOwner)
      expect(result.decisions).toContainEqual(
        expect.objectContaining({ decision: "steal-refused-owner-alive", evidence: "lease-fresh" })
      )
    }))

  it.effect("keeps a supplied probe authoritative once the lease has expired", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* insertOwnedRun("lease-probe-refuses", 0)

        let probes = 0
        const driver = yield* RunDriver.make({
          owner: { hostId: "lease-host", pid: 1, nonce: "prober" },
          journalSource: "lease-liveness",
          isAlive: (owner, context) =>
            Effect.sync(() => {
              probes += 1
              expect(owner).toEqual(deadOwner)
              expect(context.claimant.hostId).toBe("lease-host")
              expect(context.heartbeatAtMs).toBe(0)
              return true
            }),
          engine: Effect.succeed(fakeEngine)
        })
        yield* driver.register(TestFlow, () => Effect.succeed("stolen"))

        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        yield* driver.resume(TestFlow, "lease-probe-refuses")
        return {
          probes,
          row: yield* store.get("lease-probe-refuses"),
          decisions: yield* decisionsOf("lease-probe-refuses")
        }
      }))

      expect(result.probes).toBeGreaterThanOrEqual(1)
      expect(result.row.status).toBe("running")
      expect(result.decisions).toContainEqual(
        expect.objectContaining({ decision: "steal-refused-owner-alive", evidence: "probe" })
      )
    }))

  it.effect("records probe-shaped evidence when the deployment supplied the probe", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* insertOwnedRun("lease-probe-allows", 0)

        const driver = yield* RunDriver.make({
          owner: { hostId: "lease-host", pid: 1, nonce: "prober" },
          journalSource: "lease-liveness",
          isAlive: () => Effect.succeed(false),
          engine: Effect.succeed(fakeEngine)
        })
        yield* driver.register(TestFlow, () => Effect.succeed("stolen"))

        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        yield* driver.resume(TestFlow, "lease-probe-allows")
        return {
          row: yield* store.get("lease-probe-allows"),
          decisions: yield* decisionsOf("lease-probe-allows")
        }
      }))

      expect(result.row.status).toBe("completed")
      // The claimant is on another host than `dead-host`, so the probe's
      // answer is recorded as the unreachability judgement it is.
      expect(result.decisions).toContainEqual(
        expect.objectContaining({
          decision: "stolen-and-activated",
          evidence: "cross-host-unreachable-stale"
        })
      )
    }))
})
