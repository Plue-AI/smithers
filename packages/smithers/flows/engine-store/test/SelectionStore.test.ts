import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
/**
 * The durable suspected-edge store: schema round-trips, the natural key,
 * clock-pinned snapshots, and law 5 — training only moves confidence, with
 * the asymmetric rule (a miss halves, a hit gains five percent of the
 * remaining headroom) applied to stored edges only.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Selection from "../src/Selection.ts"
import * as SelectionStore from "../src/SelectionStore.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const storeLayer = Layer.provideMerge(SelectionStore.layer, TestStores.database)

const edge = (overrides: Partial<Selection.SuspectedEdge> = {}): Selection.SuspectedEdge => ({
  scope: "packages/smithers/flows/engine/src/**",
  affects: "update-engine-docs",
  confidence: 0.8,
  validFromMs: 0,
  evidence: ["seed"],
  ...overrides
})

const withStore = <A>(
  body: (store: SelectionStore.Service) => Effect.Effect<A, SelectionStore.SelectionStoreError>
) =>
  withCrypto(
    Effect.gen(function*() {
      const store = yield* SelectionStore.SelectionStore
      return yield* body(store)
    }).pipe(Effect.provide(storeLayer))
  )

const errorOf = (exit: Exit.Exit<unknown, unknown>): SelectionStore.SelectionStoreError => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: SelectionStore.SelectionStoreError }).error
}

describe("SelectionStore", () => {
  it.effect("keeps only the newest bounded training evidence in order", () =>
    Effect.gen(function*() {
      const expectedCap = 128
      const observations = Array.from({ length: expectedCap + 5 }, (_, index) => ({
        scope: edge().scope,
        affects: edge().affects,
        outcome: index % 2 === 0 ? "hit" as const : "miss" as const
      }))
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([edge({ evidence: [] })])
          yield* store.train(observations)
          return yield* store.list()
        })
      )

      expect(listed[0]!.evidence).toEqual(
        observations.slice(-expectedCap).map((observation) => JSON.stringify(observation))
      )
      expect(SelectionStore.maxEvidenceEntries).toBe(expectedCap)
    }))

  it.effect("round-trips edges through upsert and list, ordered by scope then affects", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([
            edge({ scope: "packages/smithers/flows/plan/**", affects: "b-flow" }),
            edge({ scope: "docs/**", affects: "a-flow", confidence: 0.2 })
          ])
          return yield* store.list()
        })
      )
      expect(listed).toEqual([
        edge({ scope: "docs/**", affects: "a-flow", confidence: 0.2 }),
        edge({ scope: "packages/smithers/flows/plan/**", affects: "b-flow" })
      ])
    }))

  it.effect("replaces on the (scope, affects) natural key instead of duplicating", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([edge()])
          yield* store.upsert([edge({ confidence: 0.3, validFromMs: 5, evidence: ["reseeded"] })])
          return yield* store.list()
        })
      )
      expect(listed).toEqual([edge({ confidence: 0.3, validFromMs: 5, evidence: ["reseeded"] })])
    }))

  it.effect("snapshot pins the injected clock's now, never the wall clock", () =>
    Effect.gen(function*() {
      const snapshot = yield* withCrypto(
        Effect.gen(function*() {
          const store = yield* SelectionStore.SelectionStore
          yield* store.upsert([edge()])
          yield* TestClock.adjust("1234 millis")
          return yield* store.snapshot()
        }).pipe(Effect.provide(storeLayer), Effect.provide(TestClock.layer()))
      )
      expect(snapshot.pinnedAtMs).toBe(1234)
      expect(snapshot.edges).toEqual([edge()])
    }))

  it.effect("law 5: a hit gains 0.05 of the remaining headroom and appends the observation as evidence", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([edge()])
          yield* store.train([{ scope: edge().scope, affects: edge().affects, outcome: "hit" }])
          return yield* store.list()
        })
      )
      expect(listed).toHaveLength(1)
      expect(listed[0]!.confidence).toBeCloseTo(0.81, 10)
      expect(listed[0]!.evidence).toEqual([
        "seed",
        JSON.stringify({ scope: edge().scope, affects: edge().affects, outcome: "hit" })
      ])
    }))

  it.effect("law 5: a miss halves — harm decays confidence faster than usefulness accrues it", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([edge()])
          yield* store.train([{ scope: edge().scope, affects: edge().affects, outcome: "miss" }])
          return yield* store.list()
        })
      )
      expect(listed[0]!.confidence).toBe(0.4)
    }))

  it.effect("law 5: an unknown (scope, affects) pair is ignored, never created", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([edge()])
          yield* store.train([{ scope: "unknown/**", affects: "nobody", outcome: "miss" }])
          return yield* store.list()
        })
      )
      expect(listed).toEqual([edge()])
    }))

  it.effect("applies observations in order within one training call", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([edge()])
          yield* store.train([
            { scope: edge().scope, affects: edge().affects, outcome: "hit" },
            { scope: edge().scope, affects: edge().affects, outcome: "miss" }
          ])
          return yield* store.list()
        })
      )
      expect(listed[0]!.confidence).toBeCloseTo(0.405, 10)
      expect(listed[0]!.evidence).toHaveLength(3)
    }))

  it.effect("rejects every non-negative-safe-integer violation before writing", () =>
    Effect.gen(function*() {
      for (
        const validFromMs of [
          -1,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          1.5,
          Number.MAX_SAFE_INTEGER + 1
        ]
      ) {
        const exit = yield* withStore((store) => store.upsert([edge({ validFromMs })]).pipe(Effect.exit))
        expect(errorOf(exit)).toMatchObject({ code: "invalid_input" })
      }
      expect(yield* withStore((store) => store.list())).toEqual([])
    }))

  it.effect("rejects malformed training observations before reading or writing", () =>
    Effect.gen(function*() {
      const exit = yield* withStore((store) =>
        store.train([{
          scope: edge().scope,
          affects: edge().affects,
          outcome: "unknown"
        } as never]).pipe(Effect.exit)
      )
      expect(errorOf(exit)).toMatchObject({ code: "invalid_input" })
    }))

  it.effect("refuses a scope over the wildcard cap before writing", () =>
    Effect.gen(function*() {
      const exit = yield* withStore((store) =>
        store.upsert([edge({ scope: "**a".repeat(12) + "**b" })]).pipe(Effect.exit)
      )
      expect(errorOf(exit)).toMatchObject({ code: "invalid_input" })
      expect(yield* withStore((store) => store.list())).toEqual([])
    }))

  it.effect("refuses to list a scope stored before the wildcard cap", () =>
    Effect.gen(function*() {
      const scope = "**a".repeat(12) + "**b"
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          const store = yield* SelectionStore.SelectionStore
          const sql = yield* SqlClient.SqlClient
          yield* store.upsert([edge()])
          yield* sql`UPDATE flows_selection_suspected_edges SET scope = ${scope}`
          return yield* store.list().pipe(Effect.exit)
        }).pipe(Effect.provide(storeLayer))
      )
      expect(errorOf(exit)).toMatchObject({ code: "decode_failed", scope })
    }))

  it.effect("reports corrupt persisted evidence with its natural key", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          const store = yield* SelectionStore.SelectionStore
          const sql = yield* SqlClient.SqlClient
          yield* store.upsert([edge()])
          yield* sql`UPDATE flows_selection_suspected_edges SET evidence_json = '{}'`
          return yield* store.list().pipe(Effect.exit)
        }).pipe(Effect.provide(storeLayer))
      )
      expect(errorOf(exit)).toMatchObject({
        code: "decode_failed",
        scope: edge().scope,
        affects: edge().affects
      })
    }))

  it.effect("reports a corrupt persisted timestamp instead of returning it", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          const store = yield* SelectionStore.SelectionStore
          const sql = yield* SqlClient.SqlClient
          yield* store.upsert([edge()])
          yield* TestDatabase.checks(sql, false)
          yield* sql`UPDATE flows_selection_suspected_edges SET valid_from_ms = -1`
          return yield* store.list().pipe(Effect.exit)
        }).pipe(Effect.provide(storeLayer))
      )
      expect(errorOf(exit)).toMatchObject({ code: "decode_failed" })
    }))

  it.effect("reports a persisted confidence outside the domain after decoding its row", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          const store = yield* SelectionStore.SelectionStore
          const sql = yield* SqlClient.SqlClient
          yield* store.upsert([edge()])
          yield* TestDatabase.checks(sql, false)
          yield* sql`UPDATE flows_selection_suspected_edges SET confidence = 2`
          return yield* store.list().pipe(Effect.exit)
        }).pipe(Effect.provide(storeLayer))
      )
      expect(errorOf(exit)).toMatchObject({
        code: "decode_failed",
        scope: edge().scope,
        affects: edge().affects
      })
    }))

  it.effect("rolls an entire multi-edge upsert back when a later row refuses", () =>
    Effect.gen(function*() {
      const observed = yield* withCrypto(
        Effect.gen(function*() {
          const store = yield* SelectionStore.SelectionStore
          const sql = yield* SqlClient.SqlClient
          yield* Dialect.trigger(sql, {
            name: `selection_refuse_insert`,
            table: `flows_selection_suspected_edges`,
            event: `BEFORE INSERT`,
            when: `NEW.affects = 'refuse'`,
            reject: "refused"
          })
          const exit = yield* store.upsert([
            edge({ scope: "a/**", affects: "accepted" }),
            edge({ scope: "b/**", affects: "refuse" })
          ]).pipe(Effect.exit)
          yield* TestDatabase.dropTrigger(sql, "selection_refuse_insert")
          return { exit, listed: yield* store.list() }
        }).pipe(Effect.provide(storeLayer))
      )
      expect(errorOf(observed.exit)).toMatchObject({ code: "persistence_failed" })
      expect(observed.listed).toEqual([])
    }))

  it.effect("rolls an entire training batch back when a later update refuses", () =>
    Effect.gen(function*() {
      const observed = yield* withCrypto(
        Effect.gen(function*() {
          const store = yield* SelectionStore.SelectionStore
          const sql = yield* SqlClient.SqlClient
          const accepted = edge({ scope: "a/**", affects: "accepted" })
          const refused = edge({ scope: "b/**", affects: "refuse" })
          yield* store.upsert([accepted, refused])
          yield* Dialect.trigger(sql, {
            name: `selection_refuse_update`,
            table: `flows_selection_suspected_edges`,
            event: `BEFORE UPDATE`,
            when: `NEW.affects = 'refuse'`,
            reject: "refused"
          })
          const exit = yield* store.train([
            { scope: accepted.scope, affects: accepted.affects, outcome: "hit" },
            { scope: refused.scope, affects: refused.affects, outcome: "hit" }
          ]).pipe(Effect.exit)
          yield* TestDatabase.dropTrigger(sql, "selection_refuse_update")
          return { exit, listed: yield* store.list() }
        }).pipe(Effect.provide(storeLayer))
      )
      expect(errorOf(observed.exit)).toMatchObject({ code: "persistence_failed" })
      expect(observed.listed.map((stored) => stored.confidence)).toEqual([0.8, 0.8])
    }))

  it.effect("normalizes unavailable-table failures for every public operation", () =>
    Effect.gen(function*() {
      const failures = yield* withCrypto(
        Effect.gen(function*() {
          const store = yield* SelectionStore.SelectionStore
          const sql = yield* SqlClient.SqlClient
          yield* sql`DROP TABLE flows_selection_suspected_edges ${
            sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
          }`
          return yield* Effect.all([
            store.upsert([edge()]).pipe(Effect.exit),
            store.list().pipe(Effect.exit),
            store.train([{ scope: edge().scope, affects: edge().affects, outcome: "hit" }]).pipe(Effect.exit)
          ])
        }).pipe(Effect.provide(storeLayer))
      )
      expect(failures.map((exit) => errorOf(exit).code)).toEqual([
        "persistence_failed",
        "persistence_failed",
        "persistence_failed"
      ])
    }))
})
