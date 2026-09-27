/**
 * The rows the nested-wait walk reads, including the ones nothing well-formed
 * writes.
 *
 * `NestedHumanWaits.test.ts` drives a real engine, which only ever produces
 * well-formed parks. A control plane reads whatever is in the database it was
 * pointed at, and a listing that failed — or silently dropped a run — because
 * one row was odd would be worse than the gap this walk closes.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"

const stack = Layer.provideMerge(
  SqlControlRuntime.layer({}).pipe(Layer.orDie),
  Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
    Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)),
    Layer.provideMerge(Layer.merge(TestDatabase.layer, NodeCrypto.layer))
  )
)

const run = <A, E, R>(body: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(Effect.provide(body, stack as unknown as Layer.Layer<R>).pipe(Effect.scoped, Effect.orDie))

/** Inserts one execution row exactly as written, checks and all. */
const insert = (options: {
  readonly runId: string
  readonly parent?: string | undefined
  readonly createdAtMs: number
  readonly stateJson: string
  readonly waiting?: { readonly reason: string; readonly token?: string | undefined } | undefined
}) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter.DurableWriter
    yield* writer.write(sql`
      INSERT INTO flows_runs (run_id, status, created_at_ms, waiting_reason, waiting_token, state_json)
      VALUES (
        ${options.runId},
        ${options.waiting === undefined ? "pending" : "suspended"},
        ${options.createdAtMs},
        ${options.waiting?.reason ?? null},
        ${options.waiting?.token ?? null},
        ${options.stateJson}
      )
    `)
    if (options.parent !== undefined) {
      yield* writer.write(
        sql`INSERT INTO flows_run_parents (child_id, parent_id, seq) VALUES (${options.runId}, ${options.parent}, ${options.createdAtMs})`
      )
    }
  })

/** The engine's own state envelope; a control summary row carries none of it. */
const engineState = JSON.stringify({ version: 1, flowName: "coding/PreparePlan", payload: {} })

describe("reading a nested human wait out of odd rows", () => {
  it("keeps a wait whose flow and declared question the row cannot supply", async () => {
    const waits = await run(Effect.gen(function*() {
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const writer = yield* DurableWriter.DurableWriter
      const runtime = yield* ControlRuntime

      yield* insert({ runId: "root", createdAtMs: 1, stateJson: engineState })
      // No `flowName`: the row says nothing about which flow it is, which is
      // what a control-plane summary row written into this table looks like.
      yield* insert({
        runId: "anonymous",
        parent: "root",
        createdAtMs: 2,
        stateJson: JSON.stringify({ version: 1, payload: {} }),
        waiting: { reason: "approval", token: "anonymous-token" }
      })
      // Past the column's own `json_valid` check, which is the only way this
      // value can exist. A park nobody can render is still a park.
      yield* writer.write(TestDatabase.checks(sql, false))
      yield* writer.write(sql`UPDATE flows_runs SET waiting_request = 'not json' WHERE run_id = 'anonymous'`)
      yield* writer.write(TestDatabase.checks(sql, true))

      return (yield* runtime.getRun("root")).pendingWaits ?? []
    }))

    expect(waits.map((wait) => wait.runId)).toEqual(["anonymous"])
    expect(Object.keys(waits[0]!)).not.toContain("flowId")
    expect(Object.keys(waits[0]!)).not.toContain("request")
  })

  it("passes over an approval park that recorded no wait address", async () => {
    const observed = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      yield* insert({ runId: "root", createdAtMs: 1, stateJson: engineState })
      // `waiting_reason` alone is a legal row: the CHECK only forbids the
      // reverse. There is nothing to address a decision to, so the run owes
      // nobody an answer they could give.
      yield* insert({
        runId: "addressless",
        parent: "root",
        createdAtMs: 2,
        stateJson: engineState,
        waiting: { reason: "approval" }
      })
      return yield* runtime.getRun("root")
    }))

    expect(observed.pendingWaits).toBeUndefined()
    expect(observed.status).not.toBe("waiting-approval")
  })
})
