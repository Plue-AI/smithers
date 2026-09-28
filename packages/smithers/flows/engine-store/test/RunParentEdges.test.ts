import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

/**
 * The durable run-parent DAG (issues #40/#41) is the single source of truth
 * for cycle detection: both implementations must agree on first-writer-wins,
 * on the store-global insertion order, on atomic in-transaction cycle
 * rejection (issues #54/#55/#56), and on run-scoped edge GC (issue #66).
 */
interface Harness {
  readonly label: string
  readonly run: <A, E>(
    body: (state: DurableEngineState.Service) => Effect.Effect<A, E, never>
  ) => Effect.Effect<A, unknown>
}

const sqlHarness: Harness = {
  label: "sql",
  run: <A, E>(body: (state: DurableEngineState.Service) => Effect.Effect<A, E, never>) =>
    withCrypto(Effect.flatMap(DurableEngineState.make, body).pipe(Effect.provide(migratedDatabase)))
}

const memoryHarness: Harness = {
  run: <A, E>(body: (state: DurableEngineState.Service) => Effect.Effect<A, E, never>) =>
    withCrypto(body(DurableEngineState.makeMemory())),
  label: "memory"
}

const describeContract = (harness: Harness) => {
  describe(`run parent edges (${harness.label})`, () => {
    it.effect("records each distinct edge once with a monotonic store-global sequence", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((state) =>
          Effect.gen(function*() {
            const first = yield* state.recordRunParent("child", "parent-a")
            const second = yield* state.recordRunParent("child", "parent-b")
            const other = yield* state.recordRunParent("other-child", "parent-a")
            return { first, second, other, listed: yield* state.runParents("child") }
          })
        )

        expect(result.first._tag).toBe("Recorded")
        expect(result.second._tag).toBe("Recorded")
        expect(result.first.edge.seq).toBeLessThan(result.second.edge.seq)
        // The sequence is store-global, not per child.
        expect(result.other.edge.seq).toBeGreaterThan(result.second.edge.seq)
        expect(result.listed.map((edge) => edge.parentId)).toEqual(["parent-a", "parent-b"])
        expect(result.listed.map((edge) => edge.childId)).toEqual(["child", "child"])
      }))

    it.effect("keeps the first writer's sequence when the same edge is recorded again", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((state) =>
          Effect.gen(function*() {
            const first = yield* state.recordRunParent("child", "parent")
            const again = yield* state.recordRunParent("child", "parent")
            return { first, again, listed: yield* state.runParents("child") }
          })
        )

        expect(result.first._tag).toBe("Recorded")
        expect(result.again._tag).toBe("Existing")
        expect(result.again.edge).toEqual(result.first.edge)
        expect(result.listed).toHaveLength(1)
      }))

    it.effect("withdraws only the named edge and tolerates withdrawing what is not there", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((state) =>
          Effect.gen(function*() {
            yield* state.recordRunParent("child", "parent-a")
            yield* state.recordRunParent("child", "parent-b")
            yield* state.removeRunParentsForRun("parent-a")
            const afterOne = yield* state.runParents("child")
            // Withdrawing an edge that was never recorded, and one for a child
            // with no edges at all, are both no-ops.
            yield* state.removeRunParentsForRun("parent-a")
            yield* state.removeRunParentsForRun("unknown-child")
            yield* state.removeRunParentsForRun("parent-b")
            return {
              afterOne,
              afterAll: yield* state.runParents("child"),
              unknown: yield* state.runParents("unknown-child")
            }
          })
        )

        expect(result.afterOne.map((edge) => edge.parentId)).toEqual(["parent-b"])
        expect(result.afterAll).toEqual([])
        expect(result.unknown).toEqual([])
      }))

    it.effect("re-records a withdrawn edge behind every edge recorded since", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((state) =>
          Effect.gen(function*() {
            const original = yield* state.recordRunParent("child", "parent")
            yield* state.removeRunParentsForRun("parent")
            const later = yield* state.recordRunParent("child", "other-parent")
            const readded = yield* state.recordRunParent("child", "parent")
            return { original, later, readded, listed: yield* state.runParents("child") }
          })
        )

        expect(result.readded._tag).toBe("Recorded")
        // A withdrawal never rewinds the sequence: the re-added edge sorts last.
        expect(result.readded.edge.seq).toBeGreaterThan(result.later.edge.seq)
        expect(result.listed.map((edge) => edge.parentId)).toEqual(["other-parent", "parent"])
      }))

    it.effect("atomically rejects an edge that would close a cycle, leaving no trace (issues #54/#55/#56)", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((state) =>
          Effect.gen(function*() {
            const selfCycle = yield* Effect.exit(state.recordRunParent("s", "s"))
            yield* state.recordRunParent("cyc-b", "cyc-a")
            const mutual = yield* Effect.exit(state.recordRunParent("cyc-a", "cyc-b"))
            yield* state.recordRunParent("cyc-c", "cyc-b")
            const transitive = yield* Effect.exit(state.recordRunParent("cyc-a", "cyc-c"))
            return {
              selfCycle,
              mutual,
              transitive,
              // The rejected inserts rolled back: nothing durable remains.
              edgesOfA: yield* state.runParents("cyc-a"),
              edgesOfS: yield* state.runParents("s")
            }
          })
        )

        const cyclePath = (exit: Exit.Exit<unknown, unknown>) => {
          expect(Exit.isFailure(exit)).toBe(true)
          const error = Exit.isFailure(exit)
            ? exit.cause.reasons.find(Cause.isFailReason)?.error
            : undefined
          expect(error).toBeInstanceOf(DurableEngineState.RunParentCycleError)
          return (error as DurableEngineState.RunParentCycleError).path
        }
        expect(cyclePath(result.selfCycle)).toEqual(["s"])
        expect(cyclePath(result.mutual)).toEqual(["cyc-a", "cyc-b"])
        expect(cyclePath(result.transitive)).toEqual(["cyc-a", "cyc-b", "cyc-c"])
        expect(result.edgesOfA).toEqual([])
        expect(result.edgesOfS).toEqual([])
      }))

    it.effect("removeRunParentsForRun prunes edges in both directions (issue #66)", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((state) =>
          Effect.gen(function*() {
            yield* state.recordRunParent("gc-x", "gc-p")
            yield* state.recordRunParent("gc-y", "gc-x")
            yield* state.recordRunParent("gc-y", "gc-q")
            yield* state.removeRunParentsForRun("gc-x")
            return {
              ofX: yield* state.runParents("gc-x"),
              ofY: yield* state.runParents("gc-y")
            }
          })
        )

        // gc-x's own parent edge and the edge naming it as a parent are gone;
        // the unrelated gc-y -> gc-q edge survives.
        expect(result.ofX).toEqual([])
        expect(result.ofY.map((edge) => edge.parentId)).toEqual(["gc-q"])
      }))

    it.effect("admits an edge whose ancestor walk revisits a shared diamond ancestor", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((state) =>
          Effect.gen(function*() {
            // dia-d reaches dia-g through two parents: the cycle walk must
            // skip the already-seen ancestor instead of re-walking (or
            // looping) and still admit the acyclic edge.
            yield* state.recordRunParent("dia-d", "dia-p1")
            yield* state.recordRunParent("dia-d", "dia-p2")
            yield* state.recordRunParent("dia-p1", "dia-g")
            yield* state.recordRunParent("dia-p2", "dia-g")
            const admitted = yield* state.recordRunParent("dia-x", "dia-d")
            return { admitted }
          })
        )

        expect(result.admitted._tag).toBe("Recorded")
      }))
  })
}

describeContract(sqlHarness)
describeContract(memoryHarness)

describe("run parent edges (sql fault injection)", () => {
  it.effect("dies rather than inventing an edge when the conflicting row cannot be re-read", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const first = yield* DurableEngineState.make
          yield* first.recordRunParent("child", "parent")

          // Torn transaction: the INSERT conflicts (the edge exists) but the
          // read-back inside the same write returns nothing.
          const blindSelect = Object.assign(
            (strings: TemplateStringsArray, ...args: ReadonlyArray<unknown>) =>
              strings.join("").includes("FROM flows_run_parents\n      WHERE child_id")
                ? Effect.succeed([])
                : (sql as unknown as (
                  strings: TemplateStringsArray,
                  ...args: ReadonlyArray<unknown>
                ) => unknown)(strings, ...args),
            sql
          )
          const torn = yield* DurableEngineState.make.pipe(
            Effect.provideService(SqlClient.SqlClient, blindSelect as never)
          )
          return yield* Effect.exit(torn.recordRunParent("child", "parent"))
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect((defect as Error).message).toBe(
        "run parent edge disappeared during first-writer transaction"
      )
    }))

  it.effect("dies (not a typed failure) when the write transaction itself fails", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          const writer = yield* DurableWriter.DurableWriter
          // Writes succeed during `make` (table/index bootstrap), then fail.
          let breakWrites = false
          const broken = yield* DurableEngineState.make.pipe(
            Effect.provideService(
              DurableWriter.DurableWriter,
              DurableWriter.DurableWriter.of({
                write: (effect) =>
                  breakWrites
                    ? Effect.fail(new DurableWriter.DatabaseError({ code: "busy" })) as never
                    : writer.write(effect)
              })
            )
          )
          breakWrites = true
          // Only a cycle is a typed failure on this surface; a storage error
          // must escape as a defect exactly like every other store mutation.
          return yield* Effect.exit(broken.recordRunParent("child", "parent"))
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true)
    }))
})
