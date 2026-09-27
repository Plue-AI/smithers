import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Plan from "@smthrs/plan/Plan"
import { compile, draft } from "@smthrs/plan/test/PlanFixtures"
import { Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as PlanStore from "../src/PlanStore.ts"
import { withCrypto } from "./Crypto.ts"

const stores = PlanStore.layer.pipe(Layer.provideMerge(Migrations.layer.pipe(Layer.provideMerge(TestDatabase.layer))))
const key = `key1_${"0".repeat(64)}`

describe("plan integrity admission", () => {
  it.effect("refuses forged store admission without writing or misreporting ExistingSame", () =>
    withCrypto(
      Effect.gen(function*() {
        const plan = yield* compile([draft("a")])
        const store = yield* PlanStore.PlanStore
        const sql = yield* SqlClient.SqlClient
        const forged = { ...plan, digest: key, baseDigest: key } as Plan.Plan
        expect((yield* Effect.flip(store.record(forged, 0))).code).toBe("invalid_plan")
        expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plans`)[0]!.count).toBe(0)
        expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`)[0]!.count).toBe(0)
        expect(yield* store.record(plan, 0)).toEqual({ _tag: "Recorded" })
        const changed = {
          ...plan,
          nodes: [{ ...plan.nodes[0]!, material: { ...plan.nodes[0]!.material, body: "changed" } }]
        }
        expect((yield* Effect.flip(store.record(changed, 1))).code).toBe("invalid_plan")
        expect(Option.getOrThrow(yield* store.get(plan.planId))).toEqual(plan)
      }).pipe(Effect.provide(stores))
    ))

  it.effect("detects schema-valid stored corruption on read and duplicate admission", () =>
    withCrypto(
      Effect.gen(function*() {
        const plan = yield* compile([draft("a")])
        const store = yield* PlanStore.PlanStore
        const sql = yield* SqlClient.SqlClient
        yield* store.record(plan, 0)
        yield* TestDatabase.dropTrigger(sql, "flows_plan_nodes_append_only")
        const json = yield* Schema.encodeEffect(Schema.fromJsonString(Plan.PlanNode))({
          ...plan.nodes[0]!,
          key: key as Plan.PlanNode["key"]
        })
        yield* sql`UPDATE flows_plan_nodes SET node_json = ${json}`
        expect((yield* Effect.flip(store.get(plan.planId))).code).toBe("decode_failed")
        expect((yield* Effect.flip(store.record(plan, 1))).code).toBe("decode_failed")
      }).pipe(Effect.provide(stores))
    ))

  it.effect("round-trips an empty plan and rolls back rejected storage metadata", () =>
    withCrypto(
      Effect.gen(function*() {
        const empty = yield* compile([])
        const store = yield* PlanStore.PlanStore
        expect((yield* Effect.flip(store.record(empty, -1))).code).toBe("constraint")
        expect(Option.isNone(yield* store.get(empty.planId))).toBe(true)
        yield* store.record(empty, 0)
        expect(Option.getOrThrow(yield* store.get(empty.planId))).toEqual(empty)
      }).pipe(Effect.provide(stores))
    ))

  it.effect("rolls back the envelope when SQL refuses a verified node", () =>
    withCrypto(
      Effect.gen(function*() {
        const plan = yield* compile([draft("a")])
        const store = yield* PlanStore.PlanStore
        const sql = yield* SqlClient.SqlClient
        yield* Dialect.trigger(sql, {
          name: `refuse_plan_node`,
          table: `flows_plan_nodes`,
          event: `BEFORE INSERT`,
          reject: "storage constraint"
        })
        const failure = yield* Effect.flip(store.record(plan, 0))
        expect(failure.code).toBe("constraint")
        expect(Option.isNone(yield* store.get(plan.planId))).toBe(true)
        expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`)[0]!.count).toBe(0)
      }).pipe(Effect.provide(stores))
    ))
})
