import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

/**
 * Cross-owner cycle races against the REAL SQL `DurableEngineState` (issue
 * #65): every writer is its own service instance over one shared database,
 * mirroring separate owner processes. The property under test is the one
 * the in-memory twin cannot exercise — that the SQL write transaction
 * serializes concurrent `recordRunParent` calls so the insert-plus-walk is
 * atomic, exactly one of two jointly cycle-closing writers fails with
 * `RunParentCycleError`, and the durable graph stays acyclic.
 */
const run = <A, E>(
  body: (
    services: readonly [DurableEngineState.Service, DurableEngineState.Service]
  ) => Effect.Effect<A, E, never>
) =>
  withCrypto(
    Effect.gen(function*() {
      const first = yield* DurableEngineState.make
      const second = yield* DurableEngineState.make
      return yield* body([first, second])
    }).pipe(Effect.provide(migratedDatabase))
  )

const cycleFailure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined

/** Asserts the durable edge graph reachable from `ids` has no cycle. */
const expectAcyclic = (state: DurableEngineState.Service, ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    for (const start of ids) {
      const stack: Array<{ readonly id: string; readonly seen: ReadonlySet<string> }> = [
        { id: start, seen: new Set([start]) }
      ]
      while (stack.length > 0) {
        const { id, seen } = stack.pop()!
        const edges = yield* state.runParents(id)
        for (const edge of edges) {
          expect(seen.has(edge.parentId)).toBe(false)
          stack.push({ id: edge.parentId, seen: new Set([...seen, edge.parentId]) })
        }
      }
    }
  })

describe("SQL cycle rejection under concurrency (issue #65)", () => {
  it.effect("exactly one of two writers racing to close a mutual cycle fails, and the graph stays acyclic", () =>
    Effect.gen(function*() {
      const result = yield* run(([first, second]) =>
        Effect.gen(function*() {
          const exits = yield* Effect.all([
            Effect.exit(first.recordRunParent("race-a", "race-b")),
            Effect.exit(second.recordRunParent("race-b", "race-a"))
          ], { concurrency: "unbounded" })
          yield* expectAcyclic(first, ["race-a", "race-b"])
          const edges = [
            ...(yield* first.runParents("race-a")),
            ...(yield* first.runParents("race-b"))
          ]
          return { exits, edges }
        })
      )

      const failures = result.exits.filter(Exit.isFailure)
      expect(failures).toHaveLength(1)
      expect(cycleFailure(failures[0]!)).toBeInstanceOf(DurableEngineState.RunParentCycleError)
      // The loser's insert rolled back: exactly the winner's edge is durable.
      expect(result.edges).toHaveLength(1)
    }))

  it.effect("refuses the cycle-closing writer, never a legitimate chord, whatever the interleaving (issue #54)", () =>
    Effect.gen(function*() {
      const result = yield* run(([first, second]) =>
        Effect.gen(function*() {
          // Lineage chord-a -> chord-b -> chord-c (child -> parent edges).
          yield* first.recordRunParent("chord-b", "chord-c")
          yield* first.recordRunParent("chord-a", "chord-b")
          // Writer 1 closes the cycle (chord-c gains parent chord-a); writer 2
          // records a legitimate chord (chord-a gains its grandparent chord-c
          // as a second parent). The max-seq arbitration this design replaces
          // picked the chord as the loser and let the closer proceed.
          const [closing, chord] = yield* Effect.all([
            Effect.exit(first.recordRunParent("chord-c", "chord-a")),
            Effect.exit(second.recordRunParent("chord-a", "chord-c"))
          ], { concurrency: "unbounded" })
          yield* expectAcyclic(first, ["chord-a", "chord-b", "chord-c"])
          return { closing, chord }
        })
      )

      expect(Exit.isSuccess(result.chord)).toBe(true)
      expect(cycleFailure(result.closing)).toBeInstanceOf(DurableEngineState.RunParentCycleError)
    }))

  it.effect("exactly one of two writers whose edges jointly close a 3-node cycle fails", () =>
    Effect.gen(function*() {
      const result = yield* run(([first, second]) =>
        Effect.gen(function*() {
          // Pre-existing edge tri-y -> tri-x. Writer 1 makes tri-x a child of
          // tri-z; writer 2 makes tri-z a child of tri-y. Each edge alone is
          // acyclic — only their union closes tri-x -> tri-z -> tri-y -> tri-x.
          yield* first.recordRunParent("tri-y", "tri-x")
          const exits = yield* Effect.all([
            Effect.exit(first.recordRunParent("tri-x", "tri-z")),
            Effect.exit(second.recordRunParent("tri-z", "tri-y"))
          ], { concurrency: "unbounded" })
          yield* expectAcyclic(first, ["tri-x", "tri-y", "tri-z"])
          return { exits }
        })
      )

      const failures = result.exits.filter(Exit.isFailure)
      expect(failures).toHaveLength(1)
      expect(cycleFailure(failures[0]!)).toBeInstanceOf(DurableEngineState.RunParentCycleError)
    }))

  it.effect("rejects a sequentially closed 3-node cycle with the full path", () =>
    Effect.gen(function*() {
      const result = yield* run(([first, second]) =>
        Effect.gen(function*() {
          yield* first.recordRunParent("seq-b", "seq-a")
          yield* second.recordRunParent("seq-c", "seq-b")
          const closing = yield* Effect.exit(first.recordRunParent("seq-a", "seq-c"))
          return { closing, edgesOfA: yield* second.runParents("seq-a") }
        })
      )

      const error = cycleFailure(result.closing)
      expect(error).toBeInstanceOf(DurableEngineState.RunParentCycleError)
      expect((error as DurableEngineState.RunParentCycleError).path).toEqual([
        "seq-a",
        "seq-b",
        "seq-c"
      ])
      // The rejected insert rolled back inside its own transaction.
      expect(result.edgesOfA).toEqual([])
    }))
})

/**
 * Issue #74: the shared-`:memory:` fixtures above serialize both writers on
 * one connection's in-process transaction mutex, which is not the mechanism
 * that exists between processes. This suite gives each writer its OWN SQLite
 * connection over one database file, so serialization can only come from the
 * database's cross-connection write transaction lock — the property the
 * `Database.write` contract documents and the cycle detector's safety
 * argument rests on. The insert precedes the ancestor walk, so each
 * transaction holds the write lock while walking; the loser retries on busy
 * and then sees the winner's committed edge.
 */
describe("cross-connection cycle rejection (issue #74)", () => {
  it.effect("two writers on separate connections racing a mutual cycle: exactly one fails, graph stays acyclic", () =>
    Effect.gen(function*() {
      const filename = join(mkdtempSync(join(tmpdir(), "flows-cycle-")), "cycle.sqlite")
      // Each owner builds its OWN connection layer over the same file, and the
      // layer scope stays open for the whole race so both connections are live
      // concurrently.
      const owner = Effect.gen(function*() {
        const context = yield* Layer.build(
          Layer.provideMerge(
            Migrations.layer,
            Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
          )
        )
        return yield* DurableEngineState.make.pipe(Effect.provide(context))
      })

      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const first = yield* owner
          const second = yield* owner
          const exits = yield* Effect.all([
            Effect.exit(first.recordRunParent("xproc-a", "xproc-b")),
            Effect.exit(second.recordRunParent("xproc-b", "xproc-a"))
          ], { concurrency: "unbounded" })
          // Read the graph back through BOTH connections: a durable edge must
          // be visible to the writer that did not create it.
          const edges = [
            ...(yield* second.runParents("xproc-a")),
            ...(yield* first.runParents("xproc-b"))
          ]
          return { exits, edges }
        }))
      )

      const failures = result.exits.filter(Exit.isFailure)
      expect(failures).toHaveLength(1)
      expect(cycleFailure(failures[0]!)).toBeInstanceOf(DurableEngineState.RunParentCycleError)
      // Exactly the winner's edge is durable, and it is the one whose writer
      // succeeded — the loser's edge was rolled back with its transaction.
      expect(result.edges).toHaveLength(1)
      const winner = result.exits.findIndex(Exit.isSuccess)
      expect(result.edges[0]!.childId).toBe(winner === 0 ? "xproc-a" : "xproc-b")
    }))
})
