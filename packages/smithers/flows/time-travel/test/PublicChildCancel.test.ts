import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Jj from "@smthrs/jj"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import type * as Ownership from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import * as TimeTravel from "../src/TimeTravel.ts"

const owner: Ownership.OwnerId = { hostId: "child-host", pid: 7, nonce: "child-owner" }
const position = { runId: "run", frame: { lineageId: "run/root", seq: 0 } }
const nowMs = 60_000

const persistence = Layer.mergeAll(
  RunStore.layer,
  SqlJournal.layer({ capacity: 16, overflow: "reject" }),
  SqlTimeTravelStore.layer,
  CacheStore.layer,
  Layer.succeed(
    Jj.Jj,
    Jj.makeNoop({
      snapshot: () => Effect.succeed({ commitId: "current", changeId: "current" }),
      restore: () => Effect.void
    })
  )
).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

const fixture = (heartbeatAtMs: number, options: TimeTravel.Options = {}) =>
  Effect.gen(function*() {
    yield* TestClock.adjust("1 minute")
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES ('run', 'suspended', 0, '{}')`
    yield* sql`INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
      VALUES ('child', 'running', 0, '{}', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, ${heartbeatAtMs})`
    yield* sql`INSERT INTO flows_consensus_leases
      (run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms)
      VALUES ('child', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, ${heartbeatAtMs}, ${heartbeatAtMs})`
    for (const seq of [0, 1]) {
      yield* sql`INSERT INTO flows_journal_events
        (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
        VALUES ('run', ${seq}, ${`event-${seq}`}, 'test', ${seq}, 0, 'test', '{}', '{"lineageId":"run/root"}')`
    }
    yield* sql`INSERT INTO flows_time_travel_edges
      (parent_run_id, parent_seq, child_run_id, kind, attached)
      VALUES ('run', 1, 'child', 'child', 0)`
    const runs = yield* RunStore.RunStore
    const evidence: Array<Ownership.LivenessEvidence> = []
    const timeTravel = yield* TimeTravel.makeWith(options).pipe(
      Effect.provideService(RunStore.RunStore, {
        ...runs,
        steal: (...args) => {
          evidence.push(args[4])
          return runs.steal(...args)
        }
      })
    )
    return { timeTravel, runs, sql, evidence }
  })

describe("public rewind cancellation of running detached children", () => {
  for (const custom of [false, true]) {
    it.effect(`steals and cancels an expired owner with ${custom ? "custom" : "default"} liveness`, () =>
      Effect.gen(function*() {
        const { timeTravel, runs, sql, evidence } = yield* fixture(
          0,
          custom ? { isAlive: () => Effect.succeed(false) } : {}
        )
        const result = yield* timeTravel.rewind(position, { detachedChildren: "cancel" })

        expect(evidence).toEqual([{ expectedOwner: owner, checkedAtMs: nowMs, kind: "lease-expired" }])
        expect(result.cancelledChildren).toEqual(["child"])
        expect(result.archive.archived).toBe(1)
        expect(yield* runs.get("child")).toMatchObject({ status: "cancelled", owner: null, claim: null })
        expect(yield* sql`SELECT seq FROM flows_journal_events WHERE run_id = 'run' ORDER BY seq`)
          .toEqual([{ seq: 0 }])
        expect(yield* sql`SELECT status FROM flows_time_travel_audits`).toEqual([{ status: "completed" }])
      }).pipe(Effect.provide(persistence), Effect.scoped))
  }

  for (
    const scenario of [
      { name: "a fresh owner lease", heartbeatAtMs: nowMs, options: {} },
      { name: "a custom live-owner veto", heartbeatAtMs: 0, options: { isAlive: () => Effect.succeed(true) } },
      {
        name: "a fresh lease even when the custom check says dead",
        heartbeatAtMs: nowMs,
        options: { isAlive: () => Effect.succeed(false) }
      }
    ]
  ) {
    it.effect(`refuses cancellation for ${scenario.name}`, () =>
      Effect.gen(function*() {
        const { timeTravel, runs, sql } = yield* fixture(scenario.heartbeatAtMs, scenario.options)
        const failure = yield* Effect.flip(timeTravel.rewind(position, { detachedChildren: "cancel" }))

        expect(failure.code).toBe("live_child")
        expect(yield* runs.get("child")).toMatchObject({ status: "running", owner, claim: null })
        expect(yield* sql`SELECT seq FROM flows_journal_events WHERE run_id = 'run' ORDER BY seq`)
          .toEqual([{ seq: 0 }, { seq: 1 }])
        expect(yield* sql`SELECT seq FROM flows_time_travel_archive`).toEqual([])
      }).pipe(Effect.provide(persistence), Effect.scoped))
  }
})
