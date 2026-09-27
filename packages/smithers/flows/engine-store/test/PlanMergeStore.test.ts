import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { KeyMaterial, Plan, StepKey } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, Option } from "effect"
import * as Crypto from "effect/Crypto"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as PlanMerges from "../src/internal/PlanMerges.ts"
import * as Migrations from "../src/Migrations.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as PlanMergeStore from "../src/PlanMergeStore.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner = { hostId: "merge-store", pid: 71, nonce: "merge-store" }
const runId = "merge-store-run"
const fixture = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | RunStore.RunStore
    | PlanStore.PlanStore
    | PlanInputStore.PlanInputStore
    | PlanMergeStore.PlanMergeStore
    | SqlClient.SqlClient
    | DurableWriter
    | Crypto.Crypto
  >
) => withCrypto(effect.pipe(Effect.provide(TestStores.layerAt(":memory:"))))
const activate = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  yield* runs.create(runId, "{}")
  const row = yield* runs.get(runId)
  yield* runs.claimAndOwn(runId, { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }, owner, 1)
})
const inputSnapshot = (plan: Plan.Plan): PlanInputStore.Snapshot => ({
  version: 1,
  generation: plan.generation,
  nodes: Plan.generationNodes(plan).map((node) => ({ id: node.id, key: node.key, reads: [] })),
  pins: []
})
const seed = Effect.gen(function*() {
  yield* activate
  const base = yield* Plan.compile({
    planId: "merge-plan",
    flow: "test/MergeStore",
    nodes: ["a", "b"].map((id) => ({
      id,
      material: { version: KeyMaterial.version, kind: "sealed", body: id, inputs: [], layers: [], capabilities: [] },
      effects: { reads: [], writes: ["shared"], boundaryMode: "hard" },
      ...(id === "b" ? { conflictStrategy: "lane" as const, runtimeStrategy: "stop-merge" as const } : {})
    }))
  })
  const identity: PlanMergeStore.Identity = {
    runId,
    planId: base.planId,
    baseDigest: base.baseDigest,
    environmentDigest: yield* StepKey.environmentIdentity()
  }
  const inputs = yield* PlanInputStore.PlanInputStore
  const plans = yield* PlanStore.PlanStore
  const merges = yield* PlanMergeStore.PlanMergeStore
  yield* plans.record(base, 0)
  yield* inputs.record({ ...identity, generation: 0 }, inputSnapshot(base), owner)
  const node = base.nodes.find((node) => node.id === "b")!
  const intent: PlanMergeStore.Intent = {
    version: 1,
    nodeId: node.id,
    nodeKey: node.key,
    dispatchKey: "dispatch",
    attempts: 1,
    rebases: 0,
    peers: ["a"]
  }
  const grown = yield* Plan.append(base, [PlanMerges.draft(node, "b+merge", ["a"])])
  const completion: PlanMergeStore.Completion = {
    version: 1,
    generation: 1,
    parentDigest: base.digest,
    planDigest: grown.digest,
    mergeId: "b+merge",
    mergeKey: Plan.generationNodes(grown)[0]!.key,
    winners: ["a"]
  }
  const append = Effect.gen(function*() {
    yield* inputs.record({ ...identity, generation: 1 }, inputSnapshot(grown), owner)
    yield* plans.append(grown)
    return yield* merges.complete(identity, "b", completion, owner)
  })
  return { base, identity, inputs, plans, merges, intent, completion, grown, append }
})

describe("PlanMergeStore", () => {
  it.effect("records immutable first-writer intent and atomic completion, including outer rollback", () =>
    fixture(Effect.gen(function*() {
      const { identity, merges, intent, completion, append, plans } = yield* seed
      const writer = yield* DurableWriter
      expect(yield* merges.list(identity, owner)).toEqual([])
      yield* merges.intend(identity, intent, owner)
      expect(yield* merges.intend(identity, { ...intent, peers: [] }, owner)).toEqual(intent)
      ;(intent.peers as Array<string>).push("caller-mutation")
      expect((yield* merges.list(identity, owner))[0]!.intent.peers).toEqual(["a"])
      expect(yield* Effect.flip(merges.complete(identity, "b", completion, owner))).toMatchObject({
        code: "transaction_required"
      })
      yield* writer.write(append.pipe(Effect.andThen(Effect.fail("rollback")))).pipe(Effect.exit)
      expect((yield* merges.list(identity, owner))[0]!.completion).toBeUndefined()
      expect(Option.getOrThrow(yield* plans.get(identity.planId)).generation).toBe(0)
      yield* writer.write(append)
      expect((yield* merges.list(identity, owner))[0]!.completion).toEqual(completion)
      expect(yield* writer.write(merges.complete(identity, "b", completion, owner))).toEqual(completion)
      expect(
        yield* Effect.flip(writer.write(merges.complete(identity, "b", { ...completion, mergeId: "other" }, owner)))
      )
        .toMatchObject({ code: "incompatible_state" })
    })))

  it.effect("keeps merge write SQL and hashing linear and recovery SQL constant as history grows", () =>
    fixture(Effect.gen(function*() {
      const { identity, intent, completion, merges, append } = yield* seed
      const writer = yield* DurableWriter
      const sql = yield* SqlClient.SqlClient
      yield* merges.intend(identity, intent, owner)
      yield* writer.write(append)
      const crypto = yield* Crypto.Crypto
      let hashes = 0
      let statements = 0
      const instrumented = new Proxy(sql, {
        apply(target, receiver, args) {
          statements++
          return Reflect.apply(target, receiver, args)
        }
      })
      const measured = yield* PlanMergeStore.make.pipe(
        Effect.provideService(SqlClient.SqlClient, instrumented),
        Effect.provideService(Crypto.Crypto, {
          ...crypto,
          digest: (algorithm, data) => {
            hashes++
            return crypto.digest(algorithm, data)
          }
        })
      )
      const batchSize = 12
      const counts: Array<{ intend: number; complete: number; list: number; hashes: number }> = []
      for (let batch = 0; batch < 3; batch++) {
        let intends = 0
        let completes = 0
        hashes = 0
        for (let index = 0; index < batchSize; index++) {
          statements = 0
          yield* measured.intend(identity, { ...intent, nodeId: `stored-${batch * batchSize + index}` }, owner)
          intends += statements
          statements = 0
          expect(yield* writer.write(measured.complete(identity, intent.nodeId, completion, owner)))
            .toEqual(completion)
          completes += statements
        }
        const writeHashes = hashes
        statements = 0
        const decisions = yield* measured.list(identity, owner)
        expect(decisions).toHaveLength(1 + (batch + 1) * batchSize)
        expect(decisions[0]).toEqual({ intent, completion })
        expect(decisions.slice(1).every((decision) => decision.completion === undefined)).toBe(true)
        expect(decisions.map((decision) => decision.intent.nodeId))
          .toEqual(decisions.map((decision) => decision.intent.nodeId).sort())
        counts.push({ intend: intends, complete: completes, list: statements, hashes: writeHashes })
      }
      expect(counts[1]).toEqual(counts[0])
      expect(counts[2]).toEqual(counts[0])
      expect(counts[0]!.intend).toBeLessThanOrEqual(batchSize * 6)
      expect(counts[0]!.complete).toBeLessThanOrEqual(batchSize * 4)
      expect(counts[0]!.list).toBeLessThanOrEqual(4)
      expect(counts[0]!.hashes).toBe(batchSize * 4)
    })))

  it.effect("fences every operation and rejects speculative reads", () =>
    fixture(Effect.gen(function*() {
      const { identity, merges, intent, completion } = yield* seed
      const writer = yield* DurableWriter
      const stale = { ...owner, nonce: "stale" }
      expect(yield* Effect.flip(merges.list(identity, stale))).toMatchObject({ code: "fence_lost" })
      expect(yield* Effect.flip(merges.intend(identity, intent, stale))).toMatchObject({ code: "fence_lost" })
      expect(yield* Effect.flip(writer.write(merges.complete(identity, "b", completion, stale)))).toMatchObject({
        code: "fence_lost"
      })
      expect(yield* Effect.flip(writer.write(merges.list(identity, owner)))).toMatchObject({ code: "transaction_open" })
      for (
        const changed of [{ ...identity, planId: "other" }, { ...identity, baseDigest: "other" }, {
          ...identity,
          environmentDigest: "other"
        }]
      ) {
        expect(yield* Effect.flip(merges.list(changed, owner))).toMatchObject({ code: "incompatible_state" })
      }
      const runs = yield* RunStore.RunStore
      yield* runs.requestCancel(runId, 2)
      expect(yield* Effect.flip(merges.list(identity, owner))).toMatchObject({ code: "fence_lost" })
    })))

  it.effect("rejects malformed inputs, missing intents and incomplete append transactions", () =>
    fixture(Effect.gen(function*() {
      const { identity, merges, intent, completion } = yield* seed
      const writer = yield* DurableWriter
      const invalid = [{ ...intent, version: 2 }, { ...intent, peers: ["a", "a"] }, { ...intent, peers: ["b"] }, {
        ...intent,
        nodeKey: "x".repeat(PlanMergeStore.maximumDecisionCharacters)
      }]
      for (const value of invalid) {
        expect(yield* Effect.flip(merges.intend(identity, value as PlanMergeStore.Intent, owner))).toMatchObject({
          code: "invalid_input"
        })
      }
      expect(yield* Effect.flip(merges.list({ ...identity, runId: "" }, owner))).toMatchObject({
        code: "invalid_input"
      })
      expect(yield* Effect.flip(writer.write(merges.complete(identity, "missing", completion, owner)))).toMatchObject({
        code: "corrupt_state"
      })
      yield* merges.intend(identity, intent, owner)
      expect(
        yield* Effect.flip(
          writer.write(merges.complete(identity, "b", { ...completion, winners: ["outsider"] }, owner))
        )
      )
        .toMatchObject({ code: "invalid_input" })
      expect(yield* Effect.flip(writer.write(merges.complete(identity, "b", completion, owner)))).toMatchObject({
        code: "corrupt_state"
      })
    })))

  it.effect("detects tampered intent and completion content without trusting their row keys", () =>
    fixture(Effect.gen(function*() {
      const { identity, merges, intent, completion, append } = yield* seed
      const writer = yield* DurableWriter
      const sql = yield* SqlClient.SqlClient
      yield* merges.intend(identity, intent, owner)
      yield* writer.write(append)
      const assertCorrupt = Effect.gen(function*() {
        for (
          const operation of [
            merges.list(identity, owner).pipe(Effect.asVoid),
            merges.intend(identity, intent, owner).pipe(Effect.asVoid),
            writer.write(merges.complete(identity, intent.nodeId, completion, owner)).pipe(Effect.asVoid)
          ]
        ) {
          expect(yield* Effect.flip(operation)).toMatchObject({ code: "corrupt_state" })
        }
      })
      yield* TestDatabase.dropTrigger(sql, "flows_plan_merge_intents_no_update")
      yield* TestDatabase.dropTrigger(sql, "flows_plan_merge_completions_no_update")
      const changeIntent = (value: unknown, checksum?: string) => {
        const json = JSON.stringify(value)
        return sql`UPDATE flows_plan_merge_intents SET intent_json = ${json}, checksum = ${checksum ?? sha256(json)}`
      }
      for (
        const value of [{ ...intent, version: 2 }, { ...intent, nodeId: "other" }, { ...intent, peers: ["b"] }, {
          ...intent,
          peers: ["a", "a"]
        }, { ...intent, nodeKey: "x".repeat(PlanMergeStore.maximumDecisionCharacters) }]
      ) {
        yield* changeIntent(value)
        yield* assertCorrupt
      }
      yield* changeIntent(intent, "0".repeat(64))
      yield* assertCorrupt
      yield* changeIntent(intent)
      for (
        const value of [{ ...completion, generation: 2 }, { ...completion, mergeId: "other" }, {
          ...completion,
          winners: ["outsider"]
        }, { ...completion, winners: ["a", "a"] }]
      ) {
        const json = JSON.stringify(value)
        yield* sql`UPDATE flows_plan_merge_completions SET completion_json = ${json}, checksum = ${sha256(json)}`
        yield* assertCorrupt
      }
    })))

  it.effect("requires an admitted head and retains decisions until their run is collected", () =>
    fixture(Effect.gen(function*() {
      yield* activate
      const merges = yield* PlanMergeStore.PlanMergeStore
      const identity = { runId, planId: "none", baseDigest: "base", environmentDigest: "env" }
      const intent: PlanMergeStore.Intent = {
        version: 1,
        nodeId: "b",
        nodeKey: "node",
        dispatchKey: "dispatch",
        attempts: 1,
        rebases: 0,
        peers: []
      }
      expect(yield* merges.list(identity, owner)).toEqual([])
      expect(yield* Effect.flip(merges.intend(identity, intent, owner))).toMatchObject({ code: "corrupt_state" })
      const inputs = yield* PlanInputStore.PlanInputStore
      yield* inputs.record({ ...identity, generation: 0 }, { version: 1, generation: 0, nodes: [], pins: [] }, owner)
      yield* merges.intend(identity, intent, owner)
      const sql = yield* SqlClient.SqlClient
      expect(Exit.isFailure(yield* sql`DELETE FROM flows_plan_merge_intents`.pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(yield* sql`UPDATE flows_plan_merge_intents SET checksum = ${"0".repeat(64)}`.pipe(Effect.exit))
      ).toBe(true)
      yield* TestDatabase.dropTrigger(sql, "flows_plan_input_heads_no_delete")
      yield* sql`DELETE FROM flows_plan_input_heads`
      expect(yield* Effect.flip(merges.list(identity, owner))).toMatchObject({ code: "corrupt_state" })
      yield* sql`DELETE FROM flows_runs WHERE run_id = ${runId}`
      expect(yield* sql`SELECT * FROM flows_plan_merge_intents`).toEqual([])
    })))

  it.effect("preserves unknown merge state when upgrading an older execution", () =>
    withCrypto(
      Effect.gen(function*() {
        const before = Migrations.sets.map((set) =>
          set.namespace === "engine-store" ?
            {
              ...set,
              migrations: Object.fromEntries(Object.entries(set.migrations).filter(([name]) => name < "0005_"))
            } :
            set
        )
        yield* DatabaseMigrations.run(before)
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO flows_runs (run_id, status, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, created_at_ms)
      VALUES (${runId}, 'running', '{}', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 1, 0)`
        yield* sql`INSERT INTO flows_plan_input_heads (run_id, plan_id, base_digest, environment_digest, generation) VALUES (${runId}, 'plan', 'base', 'env', 0)`
        yield* Migrations.run
        const merges = yield* PlanMergeStore.make
        expect(
          yield* Effect.flip(
            merges.list({ runId, planId: "plan", baseDigest: "base", environmentDigest: "env" }, owner)
          )
        )
          .toMatchObject({ code: "incompatible_state" })
        expect(
          Exit.isFailure(
            yield* sql`UPDATE flows_plan_input_heads SET merge_state_version = 1, generation = 1`.pipe(Effect.exit)
          )
        ).toBe(true)
      }).pipe(Effect.provide(TestDatabase.layer))
    ))

  it.effect(
    "enforces the exact decision-count ceiling without refusing an existing decision",
    () =>
      fixture(Effect.gen(function*() {
        const { identity, merges, intent } = yield* seed
        const sql = yield* SqlClient.SqlClient
        const writer = yield* DurableWriter
        const maximum = Plan.maximumPlanNodes
        // Populate a real database at N-1; each row has distinct valid content
        // and its actual checksum, so the ceiling uses real stored rows.
        const rows = Array.from({ length: maximum - 1 }, (_, index) => {
          const nodeId = `stored-${index}`
          const json = JSON.stringify({ ...intent, nodeId, peers: [] })
          return { run_id: runId, stopped_node_id: nodeId, intent_json: json, checksum: sha256(json) }
        })
        yield* writer.write(Effect.gen(function*() {
          for (let offset = 0; offset < rows.length; offset += 500) {
            yield* sql`INSERT INTO flows_plan_merge_intents ${sql.insert(rows.slice(offset, offset + 500))}`
          }
        }))
        expect(yield* merges.intend(identity, intent, owner)).toEqual(intent)
        expect(yield* merges.intend(identity, intent, owner)).toEqual(intent)
        expect(yield* Effect.flip(merges.intend(identity, { ...intent, nodeId: "overflow" }, owner)))
          .toMatchObject({ code: "invalid_input", message: "too many merge intents for one plan" })
        expect(yield* sql`SELECT count(*) AS count FROM flows_plan_merge_intents`).toEqual([{ count: maximum }])
        // Storage corruption at N+1 is refused before decoding or returning a
        // misleading truncated list. This insert is deliberately outside the API.
        yield* sql`INSERT INTO flows_plan_merge_intents (run_id, stopped_node_id, intent_json, checksum)
        VALUES (${runId}, 'overflow', '{}', ${"0".repeat(64)})`
        expect(yield* Effect.flip(merges.list(identity, owner)))
          .toMatchObject({ code: "corrupt_state", message: "too many merge decisions for one plan" })
      })),
    120_000
  )

  it.effect("translates database failures without treating unreadable decisions as absent", () =>
    fixture(Effect.gen(function*() {
      const { identity, merges, intent, completion } = yield* seed
      yield* merges.intend(identity, intent, owner)
      const sql = yield* SqlClient.SqlClient
      const writer = yield* DurableWriter
      yield* sql`DROP TABLE flows_plan_merge_completions ${
        sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
      }`
      for (
        const operation of [
          merges.list(identity, owner).pipe(Effect.asVoid),
          merges.intend(identity, intent, owner).pipe(Effect.asVoid),
          writer.write(merges.complete(identity, "b", completion, owner)).pipe(Effect.asVoid)
        ]
      ) {
        const error = yield* Effect.flip(operation)
        expect(error).toMatchObject({ code: "persistence_failed", message: "could not access plan merge decisions" })
        expect(error.cause).toBeDefined()
      }
      expect(yield* sql`SELECT count(*) AS count FROM flows_plan_merge_intents`).toEqual([{ count: 1 }])
    })))
})
