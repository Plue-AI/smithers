import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Plan from "@smthrs/plan/Plan"
import { compile, draft } from "@smthrs/plan/test/PlanFixtures"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as PlanStore from "../src/PlanStore.ts"
import { withCrypto } from "./Crypto.ts"

const stores = Layer.provideMerge(PlanStore.layer, Layer.provideMerge(Migrations.layer, TestDatabase.layer))

const withStore = <A, E>(
  use: (store: PlanStore.Service) => Effect.Effect<A, E, SqlClient.SqlClient>
) =>
  withCrypto(
    Effect.flatMap(PlanStore.PlanStore, use).pipe(Effect.provide(stores))
  )

/** The message SQLite's `RAISE(ABORT, ...)` carried, through the SqlError. */
const raised = (error: unknown): string =>
  (error as { readonly reason?: { readonly cause?: { readonly message?: string } } }).reason?.cause?.message ??
    String(error)

const samplePlan = () =>
  compile([
    draft("root", { writes: ["out"] }),
    draft("child", { inputs: [{ _tag: "Ref", from: "root", path: [] }] })
  ])

const assertAppendQueries = (queries: ReadonlyArray<string>) => {
  // Check the complete ordered statement list, including each statement's shape.
  // Extra reads or writes must fail regardless of quoting, aliases or SQL syntax.
  expect(queries).toEqual([
    "UPDATE flows_plans SET digest = ?, generation = ? WHERE plan_id = ? " +
    "AND generation = ? AND flow = ? AND base_digest = ? AND digest = ?",
    "INSERT INTO flows_plan_nodes (plan_id, node_id, generation, ordinal, kind, key_digest, node_json) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
    "INSERT INTO flows_plan_edges (plan_id, from_node, to_node) VALUES (?, ?, ?)"
  ])
}

describe("PlanStore", () => {
  it.effect("records a plan and reads it back node for node", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const { read, recorded } = yield* withStore((store) =>
        Effect.gen(function*() {
          const recorded = yield* store.record(plan, 1)
          const read = yield* store.get(plan.planId)
          return { read, recorded }
        })
      )
      expect(recorded).toEqual({ _tag: "Recorded" })
      expect(Option.getOrThrow(read)).toEqual(plan)
    }))

  it.effect("is first-writer-wins: an identical re-record is not an error, a different one is a conflict", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const other = yield* withCrypto(compile([draft("root", { body: { seed: 9 } })]))
      const { conflict, same } = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(plan, 1)
          const same = yield* store.record(plan, 2)
          const conflict = yield* store.record({ ...other, planId: plan.planId }, 3)
          return { conflict, same }
        })
      )
      expect(same).toEqual({ _tag: "ExistingSame" })
      expect(conflict).toEqual({ _tag: "Conflict", digest: plan.digest })
    }))

  it.effect("appends an elaborated subgraph and advances the digest", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(samplePlan())
      const grown = yield* withCrypto(
        Plan.append(base, [draft("late", { inputs: [{ _tag: "Pending", from: "child" }] })])
      )
      const read = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          yield* store.append(grown)
          return yield* store.get(base.planId)
        })
      )
      expect(Option.getOrThrow(read)).toEqual(grown)
    }))

  it.effect("refuses a divergent branch and rolls the attempted append back byte for byte", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const planA = yield* withCrypto(Plan.append(base, [draft("a")]))
      const planB = yield* withCrypto(Plan.append(base, [draft("b")]))
      const planB2 = yield* withCrypto(Plan.append(planB, [
        draft("c", { inputs: [{ _tag: "Ref", from: "b", path: [] }] })
      ]))
      const { after, afterCount, before, beforeCount, failure } = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(base, 1)
          yield* store.append(planA)
          const before = yield* store.get(base.planId)
          const beforeRows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`
          const failure = yield* Effect.flip(store.append(planB2))
          const after = yield* store.get(base.planId)
          const afterRows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`
          return {
            after,
            afterCount: afterRows[0]!.count,
            before,
            beforeCount: beforeRows[0]!.count,
            failure
          }
        })
      )

      expect(failure).toMatchObject({
        code: "constraint",
        message: `plan ${base.planId} recorded plan's nodes diverge from the plan this append was grown from`
      })
      expect(after).toEqual(before)
      expect(afterCount).toBe(beforeCount)
    }))

  it.effect("refuses a same-key priority-divergent prefix and rolls the append back byte for byte", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const branchA = yield* withCrypto(Plan.append(base, [draft("a", { priority: 1 })]))
      const branchB = yield* withCrypto(Plan.append(base, [draft("a", { priority: 2 })]))
      const branchB2 = yield* withCrypto(Plan.append(branchB, [
        draft("c", { inputs: [{ _tag: "Ref", from: "a", path: [] }] })
      ]))
      expect(branchA.nodes[1]!.key).toBe(branchB.nodes[1]!.key)

      const result = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(base, 1)
          yield* store.append(branchA)
          const beforePlan = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${base.planId}
          `
          const beforeNodes = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plan_nodes WHERE plan_id = ${base.planId} ORDER BY ordinal
          `
          const failure = yield* Effect.flip(store.append(branchB2))
          const afterPlan = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${base.planId}
          `
          const afterNodes = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plan_nodes WHERE plan_id = ${base.planId} ORDER BY ordinal
          `
          return { afterNodes, afterPlan, beforeNodes, beforePlan, failure }
        })
      )

      expect(result.failure).toMatchObject({
        code: "constraint",
        message: `plan ${base.planId} recorded plan's nodes diverge from the plan this append was grown from`
      })
      expect(result.afterPlan).toEqual(result.beforePlan)
      expect(result.afterNodes).toEqual(result.beforeNodes)
      expect(result.afterPlan[0]).toMatchObject({ digest: branchA.digest, generation: 1 })
    }))

  it.effect("refuses a skipped generation and rolls the attempted append back byte for byte", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("a")]))
      const generation1 = yield* withCrypto(Plan.append(base, [draft("b")]))
      const generation2 = yield* withCrypto(Plan.append(generation1, [
        draft("c", { inputs: [{ _tag: "Ref", from: "b", path: [] }] })
      ]))
      const { after, before, failure } = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          const before = yield* store.get(base.planId)
          const failure = yield* Effect.flip(store.append(generation2))
          const after = yield* store.get(base.planId)
          return { after, before, failure }
        })
      )

      expect(failure).toMatchObject({
        code: "constraint",
        message: `plan ${base.planId} was never recorded, or generation 2 was skipped or moved under the append`
      })
      expect(after).toEqual(before)
    }))

  it.effect("stores successive append ordinals contiguously in plan order", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("a"), draft("b")]))
      const generation1 = yield* withCrypto(Plan.append(base, [draft("c"), draft("d")]))
      const generation2 = yield* withCrypto(Plan.append(generation1, [
        draft("e", { inputs: [{ _tag: "Pending", from: "d" }] })
      ]))
      const rows = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          yield* store.append(generation1)
          yield* store.append(generation2)
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{ node_id: string; ordinal: number }>`
            SELECT node_id, ordinal FROM flows_plan_nodes
            WHERE plan_id = ${base.planId}
            ORDER BY ordinal
          `
        })
      )

      expect(rows).toEqual(generation2.nodes.map((node, ordinal) => ({ node_id: node.id, ordinal })))
    }))

  it.effect("returns none for a plan that was never recorded", () =>
    Effect.gen(function*() {
      expect(yield* withStore((store) => store.get("absent"))).toEqual(Option.none())
    }))

  it.effect("refuses to append to a plan that was never recorded, and leaves no orphan rows", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(samplePlan())
      const grown = yield* withCrypto(
        Plan.append(base, [draft("late", { inputs: [{ _tag: "Pending", from: "child" }] })])
      )
      const { failure, orphans } = yield* withStore((store) =>
        Effect.gen(function*() {
          // The UPDATE matches nothing while the node inserts succeed, so
          // without the check this wrote a generation of a plan that does not
          // exist — and the append-only triggers mean those rows could never be
          // taken back out again.
          const failure = yield* Effect.flip(store.append(grown))
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{ n: number }>`SELECT count(*) AS n FROM flows_plan_nodes`
          return { failure, orphans: rows[0]!.n }
        })
      )
      expect(failure).toMatchObject({
        code: "constraint",
        message: `plan ${base.planId} was never recorded, or generation 1 was skipped or moved under the append`
      })
      expect(orphans).toBe(0)
    }))

  it.effect("refuses every non-generation-zero record shape with an exact invalid_plan error", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const grown = yield* withCrypto(Plan.append(base, [draft("late")]))
      const other = yield* withCrypto(compile([draft("other")], "other-plan"))
      const wrongBase: Plan.Plan = { ...base, baseDigest: other.digest }
      const wrongNode: Plan.Plan = {
        ...base,
        nodes: [{ ...base.nodes[0]!, generation: 1 }]
      }
      const [grownFailure, baseFailure, nodeFailure] = yield* withStore((store) =>
        Effect.all([
          Effect.flip(store.record(grown, 1)),
          Effect.flip(store.record(wrongBase, 1)),
          Effect.flip(store.record(wrongNode, 1))
        ], { concurrency: 1 })
      )

      expect(grownFailure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} has generation 1; record requires generation 0`
      })
      expect(baseFailure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} has base digest ${other.digest}, but generation 0 digest is ${base.digest}`
      })
      expect(nodeFailure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} node root has generation 1; record requires node generation 0`
      })
    }))

  it.effect("refuses an append whose newest generation has no nodes", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const empty: Plan.Plan = { ...base, generation: 1 }
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          return yield* Effect.flip(store.append(empty))
        })
      )

      expect(failure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} generation 1 has no nodes to append`
      })
    }))

  it.effect("refuses a value that is not a plan", () =>
    Effect.gen(function*() {
      const failure = yield* withStore((store) =>
        Effect.flip(
          store.record(
            { planId: "", flow: "f", generation: 0, baseDigest: "x", digest: "x", nodes: [] } as unknown as Plan.Plan,
            1
          )
        )
      )
      expect(failure).toMatchObject({ code: "invalid_plan" })
    }))

  it.effect("refuses an append that re-inserts a node id the plan already holds", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const forged: Plan.Plan = {
        ...plan,
        generation: 1,
        nodes: [...plan.nodes, { ...plan.nodes[0]!, generation: 1 }]
      }
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(plan, 1)
          // Persistence verifies imported plans before any SQL mutation.
          return yield* Effect.flip(store.append(forged))
        })
      )
      expect(failure).toMatchObject({ code: "invalid_plan" })
    }))

  it.effect("raises when a recorded node row is rewritten or deleted", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failures = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          const update = yield* Effect.flip(sql`UPDATE flows_plan_nodes SET kind = 'agent'`)
          const remove = yield* Effect.flip(sql`DELETE FROM flows_plan_nodes`)
          const edge = yield* Effect.flip(sql`UPDATE flows_plan_edges SET to_node = 'x'`)
          const edgeDelete = yield* Effect.flip(sql`DELETE FROM flows_plan_edges`)
          const backwards = yield* Effect.flip(sql`UPDATE flows_plans SET generation = 0`)
          return [update, remove, edge, edgeDelete, backwards].map(raised)
        })
      )
      expect(failures.filter((message) => message.includes("append-only")).length).toBe(4)
      expect(failures[4]).toBe("a plan only grows")
    }))

  it.effect("refuses deleting a recorded plan row", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          return yield* Effect.flip(sql`DELETE FROM flows_plans WHERE plan_id = ${plan.planId}`)
        })
      )

      expect(raised(failure)).toBe("flows_plans is append-only")
    }))

  it.effect("refuses rewriting a recorded plan's flow, creation time, or base digest as it moves forward", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const other = yield* withCrypto(compile([draft("other")], "other-plan"))
      const grown = yield* withCrypto(Plan.append(plan, [draft("late")]))
      const { after, baseDigest, before, createdAt, flow, forward } = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          const before = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${plan.planId}
          `
          // Each mutation ALSO advances the generation, so the forward-only
          // predicate cannot be what rejects it and only the field's own guard
          // can. Without the advance all three statements are refused by
          // `NEW.generation <= OLD.generation` alone and still pass with the
          // flow, creation-time, and base-digest guards deleted.
          const flow = yield* Effect.flip(sql`
            UPDATE flows_plans SET flow = 'other/Flow', generation = generation + 1
            WHERE plan_id = ${plan.planId}
          `)
          const createdAt = yield* Effect.flip(sql`
            UPDATE flows_plans SET created_at_ms = 2, generation = generation + 1
            WHERE plan_id = ${plan.planId}
          `)
          const baseDigest = yield* Effect.flip(sql`
            UPDATE flows_plans SET base_digest = ${other.digest}, generation = generation + 1
            WHERE plan_id = ${plan.planId}
          `)
          const after = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${plan.planId}
          `
          // The control: the one UPDATE the schema exists to admit. A guard
          // wide enough to catch the three above must still let this through.
          yield* sql`
            UPDATE flows_plans SET digest = ${grown.digest}, generation = generation + 1
            WHERE plan_id = ${plan.planId}
          `
          const forward = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${plan.planId}
          `
          return { after, baseDigest, before, createdAt, flow, forward }
        })
      )

      expect(raised(flow)).toBe("a plan only grows")
      expect(raised(createdAt)).toBe("a plan only grows")
      expect(raised(baseDigest)).toBe("a plan only grows")
      // Not just the raise: no refused statement left a field behind.
      expect(after).toEqual(before)
      expect(forward).toEqual([{ ...before[0], digest: grown.digest, generation: 1 }])
    }))

  it.effect("refuses rewriting a plan id during a forward update and preserves the row", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const { after, before, failure } = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          const before = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${plan.planId}
          `
          const failure = yield* Effect.flip(sql`
            UPDATE flows_plans
            SET plan_id = 'stolen', generation = generation + 1, digest = 'd1'
            WHERE plan_id = ${plan.planId}
          `)
          const after = yield* sql<Record<string, unknown>>`SELECT * FROM flows_plans`
          return { after, before, failure }
        })
      )

      expect(raised(failure)).toBe("a plan only grows")
      expect(after).toEqual(before)
    }))

  it.effect("refuses two nodes with the same plan ordinal", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          return yield* Effect.flip(sql`
            INSERT INTO flows_plan_nodes (
              plan_id, node_id, generation, ordinal, kind, key_digest, node_json
            )
            SELECT plan_id, 'duplicate-ordinal', generation, ordinal, kind, key_digest, node_json
            FROM flows_plan_nodes
            WHERE plan_id = ${plan.planId} AND node_id = 'root'
          `)
        })
      )

      expect(raised(failure)).toMatch(
        /UNIQUE constraint failed: flows_plan_nodes.plan_id, flows_plan_nodes.ordinal|duplicate key value violates unique constraint/
      )
    }))

  it.effect("reports an undecodable node row rather than returning a broken plan", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          yield* TestDatabase.dropTrigger(sql, "flows_plan_nodes_append_only")
          yield* sql`UPDATE flows_plan_nodes SET node_json = '{"id":"broken"}'`
          return yield* Effect.flip(store.get(plan.planId))
        })
      )
      expect(failure).toMatchObject({ code: "decode_failed", message: expect.stringContaining("flows_plan_nodes") })
    }))

  it.effect("reports an undecodable plan row rather than returning a broken plan", () =>
    Effect.gen(function*() {
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          // Every `flows_plans` CHECK holds — the digests are nonempty strings
          // — so SQLite admits this row. They are still not `StoredKey`s,
          // which is the syntax the envelope decoder requires, so the schema's
          // constraints do not make this branch unreachable.
          yield* sql`
            INSERT INTO flows_plans (plan_id, flow, base_digest, digest, generation, created_at_ms)
            VALUES ('malformed', 'example/Build', 'x', 'x', 0, 1)
          `
          return yield* Effect.flip(store.get("malformed"))
        })
      )
      expect(failure).toMatchObject({ code: "decode_failed", message: "could not decode flows_plans row" })
    }))

  it.effect("refuses a node the encoder cannot serialize", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const forged: Plan.Plan = {
        ...plan,
        nodes: [{ ...plan.nodes[0]!, material: { ...plan.nodes[0]!.material, body: 1n } }]
      }
      const failure = yield* withStore((store) => Effect.flip(store.record(forged, 1)))
      expect(failure).toMatchObject({ code: "invalid_plan" })
    }))

  it.effect("maps a missing table to a persistence failure", () =>
    Effect.gen(function*() {
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`DROP TABLE flows_plans ${
            sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
          }`
          return yield* Effect.flip(store.get("anything"))
        })
      )
      expect(failure).toMatchObject({ code: "persistence_failed" })
    }))

  it.effect("reports a stored envelope digest that drifted from its rows as decode_failed on append", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const other = yield* withCrypto(compile([draft("other")], "other-plan"))
      const grown = yield* withCrypto(Plan.append(base, [draft("late")]))
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(base, 1)
          yield* TestDatabase.dropTrigger(sql, "flows_plans_forward_only")
          yield* sql`UPDATE flows_plans SET digest = ${other.digest} WHERE plan_id = ${base.planId}`
          return yield* Effect.flip(store.append(grown))
        })
      )
      expect(failure).toMatchObject({ code: "decode_failed" })
    }))

  it.effect.each([
    {
      name: "appends 300 generations without reading stored node rows or rewriting the prefix",
      readPrefix: false
    },
    {
      name: "rejects quoted prefix reads, decoding and verification across 300 generations",
      readPrefix: true
    }
  ])(
    "$name",
    ({ readPrefix }) =>
      Effect.gen(function*() {
        const spans: Array<Tracer.NativeSpan> = []
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options)
            spans.push(span)
            return span
          }
        })
        yield* withStore((store) =>
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const decodeNode = Schema.decodeUnknownEffect(Schema.fromJsonString(Plan.PlanNode))
            let prefixRowsRead = 0
            let plan = yield* withCrypto(compile([draft("n0", { writes: ["out/0"] })]))
            yield* store.record(plan, 1)
            for (let generation = 1; generation <= 300; generation++) {
              const prefix = plan
              plan = yield* withCrypto(
                Plan.append(plan, [
                  draft(`n${generation}`, {
                    writes: [`out/${generation}`],
                    inputs: [{ _tag: "Pending", from: `n${generation - 1}` }]
                  })
                ])
              )
              spans.length = 0
              yield* Effect.gen(function*() {
                if (readPrefix) {
                  // Negative control: the SQL identifier helper quotes the table.
                  // Read, decode and verify the actual prefix before each append.
                  const rows = yield* sql<{ node_json: string }>`
                    SELECT node_json FROM ${sql("flows_plan_nodes")}
                    WHERE plan_id = ${prefix.planId} ORDER BY ordinal
                  `
                  expect(rows).toHaveLength(generation)
                  prefixRowsRead += rows.length
                  const nodes = yield* Effect.forEach(rows, (row) => decodeNode(row.node_json))
                  expect(yield* withCrypto(Plan.verify({ ...prefix, nodes }))).toEqual(prefix)
                }
                yield* store.append(plan)
              }).pipe(Effect.provideService(Tracer.Tracer, tracer))
              const queries = spans.flatMap((span) => {
                const query = span.attributes.get("db.query.text")
                return typeof query === "string" ? [query.replace(/\$\d+/g, "?").replace(/\s+/g, " ").trim()] : []
              })
              // Observe real SQLite executions. A successful append authenticates
              // the prefix through the envelope CAS, then inserts only its new
              // node and edge. Re-reading and verifying the growing prefix is the
              // regression; wall-time ratios also charge unrelated machine load.
              if (readPrefix) {
                expect(queries[0]).toBe(
                  "SELECT node_json FROM \"flows_plan_nodes\" WHERE plan_id = ? ORDER BY ordinal"
                )
                expect(() => assertAppendQueries(queries)).toThrow()
                assertAppendQueries(queries.slice(1))
              } else {
                assertAppendQueries(queries)
              }
            }
            expect(prefixRowsRead).toBe(readPrefix ? 45_150 : 0)
            expect(Option.getOrThrow(yield* store.get(plan.planId))).toEqual(plan)
          })
        )
      }),
    300_000
  )
})
