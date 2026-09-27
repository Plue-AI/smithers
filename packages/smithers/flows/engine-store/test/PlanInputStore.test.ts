import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner = { hostId: "input-host", pid: 72, nonce: "input-owner" }
const address: PlanInputStore.Address = {
  runId: "input-run",
  planId: "input-plan",
  baseDigest: "base",
  environmentDigest: "environment",
  generation: 0
}
const snapshot = (generation = 0, digest = "initial"): PlanInputStore.Snapshot => ({
  version: 1,
  generation,
  nodes: [{ id: `node-${generation}`, key: "node-key", reads: [{ entry: "config", sourcePaths: ["config"] }] }],
  pins: [{ path: "config", digest }]
})
const activate = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  yield* runs.create(address.runId, "{}")
  const row = yield* runs.get(address.runId)
  const before = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
  const claim = yield* runs.claim(address.runId, before, owner, 1)
  if (claim._tag !== "Claimed") return yield* Effect.die("claim failed")
  yield* runs.activate(address.runId, owner, claim.claimedAtMs, before)
})
const fixture = <A, E>(
  effect: Effect.Effect<A, E, PlanInputStore.PlanInputStore | RunStore.RunStore | SqlClient.SqlClient | DurableWriter>
) =>
  withCrypto(effect.pipe(
    Effect.provide(TestStores.layerAt(":memory:"))
  ))

describe("PlanInputStore", () => {
  it.effect("records first-writer-wins generations and does not alias caller data", () =>
    fixture(Effect.gen(function*() {
      yield* activate
      const store = yield* PlanInputStore.PlanInputStore
      expect(yield* store.get(address, owner)).toEqual(Option.none())
      const first = snapshot()
      yield* store.record(address, first, owner)
      ;(first.pins[0] as { digest: string }).digest = "caller-mutated"
      expect(yield* store.record(address, snapshot(0, "late"), owner)).toEqual(snapshot())
      expect(yield* store.get(address, owner)).toEqual(Option.some(snapshot()))
      const next = { ...address, generation: 1 }
      expect(yield* store.get(next, owner)).toEqual(Option.none())
      yield* store.record(next, snapshot(1), owner)
      expect(yield* store.get(next, owner)).toEqual(Option.some(snapshot(1)))
      expect(yield* store.get(address, owner)).toEqual(Option.some(snapshot()))
    })))

  it.effect("refuses stale ownership and cancellation before reads or writes", () =>
    fixture(Effect.gen(function*() {
      yield* activate
      const store = yield* PlanInputStore.PlanInputStore
      const stale = { ...owner, nonce: "stale" }
      expect(yield* Effect.flip(store.get(address, stale))).toMatchObject({ code: "fence_lost" })
      expect(yield* Effect.flip(store.record(address, snapshot(), stale))).toMatchObject({ code: "fence_lost" })
      const runs = yield* RunStore.RunStore
      yield* runs.requestCancel(address.runId, 2)
      expect(yield* Effect.flip(store.record(address, snapshot(), owner))).toMatchObject({ code: "fence_lost" })
    })))

  it.effect("joins an outer record transaction but never admits speculative observations", () =>
    fixture(Effect.gen(function*() {
      yield* activate
      const store = yield* PlanInputStore.PlanInputStore
      const writer = yield* DurableWriter
      const result = yield* writer.write(Effect.gen(function*() {
        yield* store.record(address, snapshot(), owner)
        expect(yield* Effect.flip(store.get(address, owner))).toMatchObject({ code: "transaction_open" })
        return yield* Effect.fail("rollback")
      })).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* store.get(address, owner)).toEqual(Option.none())
      yield* store.record(address, snapshot(0, "retry"), owner)
      expect(yield* store.get(address, owner)).toEqual(Option.some(snapshot(0, "retry")))
    })))

  it.effect("rolls back a partial generation and permits a clean retry", () =>
    fixture(Effect.gen(function*() {
      yield* activate
      const store = yield* PlanInputStore.PlanInputStore
      const sql = yield* SqlClient.SqlClient
      yield* store.record(address, snapshot(), owner)
      yield* Dialect.trigger(sql, {
        name: `reject_inputs`,
        table: `flows_plan_input_generations`,
        event: `BEFORE INSERT`,
        when: `NEW.generation = 1`,
        reject: "injected input failure"
      })
      const next = { ...address, generation: 1 }
      expect(yield* Effect.flip(store.record(next, snapshot(1), owner))).toMatchObject({ code: "persistence_failed" })
      expect(yield* store.get(next, owner)).toEqual(Option.none())
      yield* TestDatabase.dropTrigger(sql, "reject_inputs")
      yield* store.record(next, snapshot(1), owner)
      expect(yield* store.get(next, owner)).toEqual(Option.some(snapshot(1)))
    })))

  it.effect("refuses incompatible plan identities and generation gaps", () =>
    fixture(Effect.gen(function*() {
      yield* activate
      const store = yield* PlanInputStore.PlanInputStore
      expect(yield* Effect.flip(store.get({ ...address, generation: 1 }, owner))).toMatchObject({
        code: "corrupt_state"
      })
      yield* store.record(address, snapshot(), owner)
      expect(yield* Effect.flip(store.get({ ...address, baseDigest: "other" }, owner))).toMatchObject({
        code: "incompatible_state"
      })
      expect(yield* Effect.flip(store.record({ ...address, planId: "replacement" }, snapshot(), owner))).toMatchObject({
        code: "incompatible_state"
      })
      expect(yield* Effect.flip(store.get({ ...address, environmentDigest: "changed" }, owner))).toMatchObject({
        code: "incompatible_state"
      })
      expect(
        yield* Effect.flip(
          store.record({ ...address, environmentDigest: "changed", generation: 1 }, snapshot(1), owner)
        )
      )
        .toMatchObject({ code: "incompatible_state" })
      expect(yield* Effect.flip(store.record({ ...address, generation: 2 }, snapshot(2), owner))).toMatchObject({
        code: "corrupt_state"
      })
    })))

  it.effect("validates public snapshots before mutating storage", () =>
    fixture(Effect.gen(function*() {
      yield* activate
      const store = yield* PlanInputStore.PlanInputStore
      const base = snapshot()
      const invalid = [
        { ...base, version: 2 },
        snapshot(1),
        { ...base, nodes: [...base.nodes, ...base.nodes] },
        { ...base, pins: [...base.pins, ...base.pins] },
        { ...base, nodes: [{ ...base.nodes[0]!, reads: [{ entry: "config", sourcePaths: ["wrong"] }] }] },
        { ...base, nodes: [{ ...base.nodes[0]!, reads: [{ entry: "config", sourcePaths: ["config", "config"] }] }] },
        {
          ...base,
          nodes: [{
            ...base.nodes[0]!,
            reads: [{ entry: { _tag: "Glob", include: ["src/**"] }, sourcePaths: ["outside"] }]
          }]
        },
        snapshot(0, "x".repeat(PlanInputStore.maximumSnapshotCharacters))
      ]
      for (const value of invalid) {
        expect(yield* Effect.flip(store.record(address, value as PlanInputStore.Snapshot, owner))).toMatchObject({
          code: "invalid_input"
        })
      }
      expect(yield* Effect.flip(store.get({ ...address, runId: "" }, owner))).toMatchObject({ code: "invalid_input" })
      expect(yield* Effect.flip(store.get(address, { ...owner, pid: -1 }))).toMatchObject({ code: "invalid_input" })
      expect(yield* store.get(address, owner)).toEqual(Option.none())
      const glob: PlanInputStore.Snapshot = {
        ...base,
        nodes: [{ ...base.nodes[0]!, reads: [{ entry: { _tag: "Glob", include: ["**"] }, sourcePaths: ["config"] }] }]
      }
      yield* store.record(address, glob, owner)
      expect(yield* store.get(address, owner)).toEqual(Option.some(glob))
    })))

  it.effect("detects corrupt content, oversized rows, missing generations and orphan snapshots", () =>
    fixture(Effect.gen(function*() {
      yield* activate
      const store = yield* PlanInputStore.PlanInputStore
      const sql = yield* SqlClient.SqlClient
      yield* store.record(address, snapshot(), owner)
      yield* TestDatabase.dropTrigger(sql, "flows_plan_input_generations_no_update")
      const change = (encoded: string, hash = sha256(encoded)) =>
        sql`UPDATE flows_plan_input_generations
      SET snapshot_json = ${encoded}, checksum = ${hash} WHERE run_id = ${address.runId}`
      const corrupt = [
        [JSON.stringify(snapshot()), "0".repeat(64)],
        [JSON.stringify({ ...snapshot(), version: 2 })],
        [JSON.stringify(snapshot(1))],
        [JSON.stringify({ padding: "x".repeat(PlanInputStore.maximumSnapshotCharacters) })]
      ]
      for (const [encoded, hash] of corrupt) {
        yield* change(encoded!, hash)
        expect(yield* Effect.flip(store.get(address, owner))).toMatchObject({ code: "corrupt_state" })
      }
      yield* change(JSON.stringify(snapshot()))
      yield* sql`UPDATE flows_plan_input_heads SET generation = 1 WHERE run_id = ${address.runId}`
      expect(yield* Effect.flip(store.get(address, owner))).toMatchObject({ code: "corrupt_state" })
      yield* TestDatabase.dropTrigger(sql, "flows_plan_input_heads_no_delete")
      yield* sql`DELETE FROM flows_plan_input_heads WHERE run_id = ${address.runId}`
      expect(yield* Effect.flip(store.get(address, owner))).toMatchObject({ code: "corrupt_state" })
    })))

  it.effect("keeps input rows immutable until the owning run is collected", () =>
    fixture(Effect.gen(function*() {
      yield* activate
      const store = yield* PlanInputStore.PlanInputStore
      const sql = yield* SqlClient.SqlClient
      yield* store.record(address, snapshot(), owner)
      expect(
        Exit.isFailure(
          yield* sql`UPDATE flows_plan_input_generations SET checksum = ${"0".repeat(64)}`.pipe(Effect.exit)
        )
      ).toBe(true)
      expect(Exit.isFailure(yield* sql`DELETE FROM flows_plan_input_generations`.pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* sql`DELETE FROM flows_plan_input_heads`.pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* sql`UPDATE flows_plan_input_heads SET base_digest = 'other'`.pipe(Effect.exit)))
        .toBe(true)
      expect(
        Exit.isFailure(
          yield* sql`UPDATE flows_plan_input_heads SET environment_digest = 'other', generation = 1`.pipe(Effect.exit)
        )
      )
        .toBe(true)
      yield* sql`DELETE FROM flows_runs WHERE run_id = ${address.runId}`
      expect(yield* sql`SELECT * FROM flows_plan_input_generations`).toEqual([])
      expect(yield* sql`SELECT * FROM flows_plan_input_heads`).toEqual([])
    })))

  it.effect("upgrades older observation heads without guessing their unknown environment", () =>
    withCrypto(
      Effect.gen(function*() {
        const before = Migrations.sets.map((set) =>
          set.namespace === "engine-store" ?
            {
              ...set,
              migrations: Object.fromEntries(
                Object.entries(set.migrations).filter(([name]) => name < "0004_")
              )
            } :
            set
        )
        yield* DatabaseMigrations.run(before)
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO flows_runs (run_id, status, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, created_at_ms)
        VALUES (${address.runId}, 'running', '{}', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 1, 0)`
        yield* sql`INSERT INTO flows_plan_input_heads (run_id, plan_id, base_digest, generation)
        VALUES (${address.runId}, ${address.planId}, ${address.baseDigest}, 0)`
        const encoded = JSON.stringify(snapshot())
        yield* sql`INSERT INTO flows_plan_input_generations (run_id, plan_id, generation, snapshot_json, checksum)
        VALUES (${address.runId}, ${address.planId}, 0, ${encoded}, ${sha256(encoded)})`
        yield* Migrations.run
        const store = yield* PlanInputStore.make
        expect(yield* Effect.flip(store.get(address, owner))).toMatchObject({ code: "incompatible_state" })
        expect(yield* sql`SELECT environment_digest FROM flows_plan_input_heads`).toEqual([{
          environment_digest: null
        }])
        expect(
          Exit.isFailure(
            yield* sql`UPDATE flows_plan_input_heads SET environment_digest = 'guessed', generation = 1`.pipe(
              Effect.exit
            )
          )
        )
          .toBe(true)
        expect(Exit.isFailure(
          yield* sql`INSERT INTO flows_plan_input_heads (run_id, plan_id, base_digest, generation)
        VALUES ('missing', 'plan', 'base', 0)`.pipe(Effect.exit)
        )).toBe(true)
        expect(yield* sql`SELECT migration_id FROM flows_migrations WHERE migration_id = 3004`).toHaveLength(1)
      }).pipe(Effect.provide(TestDatabase.layer))
    ))

  it.effect("upgrades an installed lower migration block and refuses pre-observation attempts", () =>
    withCrypto(
      Effect.gen(function*() {
        const before = Migrations.sets.map((set) =>
          set.namespace === "engine-store" ?
            {
              ...set,
              migrations: Object.fromEntries(
                Object.entries(set.migrations).filter(([name]) => name < "0003_")
              )
            } :
            set
        )
        yield* DatabaseMigrations.run(before)
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO flows_runs (run_id, status, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, created_at_ms)
      VALUES (${address.runId}, 'running', '{}', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 1, 0)`
        yield* sql`INSERT INTO flows_attempts (run_id, step_key_digest, attempt, state, started_at_ms, meta_json)
      VALUES (${address.runId}, 'legacy-step', 1, 'succeeded', 1, '{}')`
        yield* Migrations.run
        const store = yield* PlanInputStore.make
        expect(yield* Effect.flip(store.get(address, owner))).toMatchObject({ code: "incompatible_state" })
        expect(yield* sql`SELECT migration_id FROM flows_migrations WHERE migration_id = 3003`).toHaveLength(1)
        expect(Exit.isFailure(yield* sql`DELETE FROM flows_plan_input_legacy_runs`.pipe(Effect.exit))).toBe(true)
      }).pipe(Effect.provide(TestDatabase.layer))
    ))
})
