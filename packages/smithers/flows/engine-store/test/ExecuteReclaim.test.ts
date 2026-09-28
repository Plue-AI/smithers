/**
 * N-07: `execute` against a hard-killed run reclaims the lease itself.
 *
 * The parity audit's extra finding 3 said an `execute` naming the execution id
 * of a run whose owner was SIGKILLed neither reclaims the expired lease nor
 * fails typed, leaving only the ~30 s stale-running sweep to notice. What that
 * would mean in practice is an operator re-running a flow after a crash and
 * watching nothing happen for half a minute.
 *
 * It does reclaim, and these cases pin it against the real SQLite stores, with
 * the sweep held still so the only thing that can take the run over is the
 * `execute` call itself. They also pin the other side, which is the reason
 * this is a lease and not a takeover: while the dead owner's lease is still
 * inside its window, `execute` does not steal the run.
 *
 * Uses the SQL `DurableEngineState` over the same database as `RunStore`,
 * because the hard-kill evidence — a `running` row with a frozen
 * `heartbeat_at_ms` and no waiting row — lives in `flows_runs` itself.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
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

const TestFlow = Flow.make("ExecuteReclaim/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const deadOwner: Ownership.OwnerId = { hostId: "killed-host", pid: 424242, nonce: "killed-nonce" }

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

const staleAfterMs = Duration.toMillis(Ownership.heartbeatStaleAfter)

/**
 * What SIGKILL leaves behind: a `running` row under an owner whose heartbeat
 * stopped where it stood, no waiting row, and no release. Written straight
 * through SQL because no live composition can produce it — the owner never
 * got to run another line.
 */
const insertHardKilledRun = (runId: string, heartbeatAtMs: number) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter.DurableWriter
    const stateJson = JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
    yield* writer.write(sql`
      INSERT INTO flows_runs (
        run_id,
        status,
        created_at_ms,
        started_at_ms,
        owner_host_id,
        owner_pid,
        owner_nonce,
        heartbeat_at_ms,
        state_json,
        lineage_id,
        round_ordinal
      ) VALUES (
        ${runId},
        'running',
        0,
        0,
        ${deadOwner.hostId},
        ${deadOwner.pid},
        ${deadOwner.nonce},
        ${heartbeatAtMs},
        ${stateJson},
        ${runId},
        0
      )
    `).pipe(Effect.orDie)
  })

type Services = Layer.Success<typeof services> | TestClock.TestClock | Crypto.Crypto | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(Effect.scoped(effect).pipe(Effect.provide(services), Effect.provide(TestClock.layer())))

describe("execute reclaims a hard-killed run (N-07)", () => {
  it.effect("takes over an expired lease and runs the flow to completion", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* insertHardKilledRun("execute-reclaim", 0)
        // Cross the lease window BEFORE the driver exists, so no sweep tick
        // can run against this row: whatever takes the run over is the
        // `execute` call below and nothing else.
        yield* TestClock.adjust(staleAfterMs + 1)

        const driver = yield* RunDriver.make({
          owner: { hostId: "reclaiming-host", pid: 2, nonce: "reclaimer" },
          journalSource: "execute-reclaim",
          // No application probe: the expired lease is the only evidence.
          engine: Effect.succeed(fakeEngine)
        })
        let executions = 0
        yield* driver.register(TestFlow, () =>
          Effect.sync(() => {
            executions = executions + 1
            return "reclaimed"
          }))

        const settled = yield* driver.execute(TestFlow, {
          executionId: "execute-reclaim",
          payload: {},
          discard: false
        })
        return { settled, executions, row: yield* store.get("execute-reclaim") }
      }))

      // The caller gets the run's value, not a suspension it has to poll for.
      expect(result.settled._tag).toBe("Complete")
      expect(result.executions).toBe(1)
      expect(result.row.status).toBe("completed")
      // The dead owner's fence is gone, released by the terminal transition.
      expect(result.row.owner).toBeNull()
    }))

  it.effect("leaves a run alone while the dead owner's lease is still inside its window", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* insertHardKilledRun("execute-fresh-lease", 0)
        // One millisecond short of the cutoff: the lease is the refusal, and
        // it is the same cutoff every other reclaim decision is made against.
        yield* TestClock.adjust(staleAfterMs - 1)

        const driver = yield* RunDriver.make({
          owner: { hostId: "reclaiming-host", pid: 3, nonce: "too-early" },
          journalSource: "execute-reclaim",
          engine: Effect.succeed(fakeEngine)
        })
        let executions = 0
        yield* driver.register(TestFlow, () =>
          Effect.sync(() => {
            executions = executions + 1
            return "should not run"
          }))

        const settled = yield* driver.execute(TestFlow, {
          executionId: "execute-fresh-lease",
          payload: {},
          discard: false
        })
        return { settled, executions, row: yield* store.get("execute-fresh-lease") }
      }))

      // No takeover, no second execution of a body that may still be running
      // somewhere: the caller is told the run has not settled, and the lease
      // decides when it may be reclaimed.
      expect(result.settled._tag).toBe("Suspended")
      expect(result.executions).toBe(0)
      expect(result.row.status).toBe("running")
      expect(result.row.owner).toEqual(deadOwner)
    }))
})
