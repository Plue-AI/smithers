/**
 * The compiler's effect analysis. The direct cases pin what
 * `internal/ConflictAnnotation.ts` hands `Plan`: annotations for the nodes it
 * may annotate, and a refusal carrying a `PlanError`'s code and message. The
 * compiled cases pin the same passes through `Plan.compile`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Conflicts from "../src/internal/ConflictAnnotation.ts"
import * as KeyMaterial from "../src/KeyMaterial.ts"
import * as Plan from "../src/Plan.ts"
import { compile, draft } from "../src/test/PlanFixtures.ts"
import { withCrypto, withCryptoFailure } from "./Crypto.ts"

const keyOf = (plan: Plan.Plan, id: string) => plan.nodes.find((node) => node.id === id)!.key

/** A keyed node as the analysis sees it; the key itself is never read. */
const node = (
  id: string,
  options: Parameters<typeof draft>[1] & { readonly effects?: Plan.NodeEffects } = {},
  generation = 0
): Plan.PlanNode => {
  const source = draft(id, options)
  return {
    id,
    kind: "step",
    key: "key1_unread" as Plan.PlanNode["key"],
    material: source.material,
    effects: options.effects ?? source.effects,
    dependsOn: KeyMaterial.dependencies(source.material),
    conflicts: [],
    strategy: source.conflictStrategy ?? "serialize",
    runtime: source.runtimeStrategy ?? "delay-rebase",
    priority: 0,
    generation
  }
}

const serialized = (other: string, paths: ReadonlyArray<string>): Plan.ConflictAnnotation => ({
  with: other,
  paths,
  strategy: "serialize",
  runtime: "delay-rebase"
})

describe("ConflictAnnotation.annotate", () => {
  it.effect("annotates both writers of a pair and orders the later behind the earlier", () =>
    Effect.gen(function*() {
      const found = yield* Conflicts.annotate(
        [
          node("a", { writes: ["shared", "a.out"] }),
          node("b", { writes: ["shared"] }),
          node("reader", { reads: ["a.out"] })
        ],
        0,
        false
      )
      expect([...found.conflicts]).toEqual([
        ["a", [serialized("b", ["shared"])]],
        ["b", [serialized("a", ["shared"])]]
      ])
      expect([...found.ordering]).toEqual([["b", ["a"]], ["reader", ["a"]]])
    }))

  it.effect("serializes two writers whose paths differ only in letter case", () =>
    Effect.gen(function*() {
      // One file on a case-insensitive filesystem; the candidate trie must
      // select the pair so the final overlap check can see it.
      const found = yield* Conflicts.annotate(
        [
          node("a", { writes: ["src/A.ts"] }),
          node("b", { writes: ["SRC/a.ts"] }),
          node("reader", { reads: ["Src/a.TS"] })
        ],
        0,
        false
      )
      expect([...found.conflicts]).toEqual([
        ["a", [serialized("b", ["src/A.ts"])]],
        ["b", [serialized("a", ["src/A.ts"])]]
      ])
      expect([...found.ordering]).toEqual([["b", ["a"]], ["reader", ["a", "b"]]])
    }))

  it.effect("reads a string holding * as a literal path and a Glob as the pattern on both passes", () =>
    Effect.gen(function*() {
      const literal = yield* Conflicts.annotate(
        [
          node("a", { writes: ["out/*.js"] }),
          node("b", { writes: ["out/a.js"] }),
          node("gen", { writes: ["src/gen.ts"] }),
          node("reader", { reads: ["src/*.ts"] })
        ],
        0,
        false
      )
      // Execution captures and admits `out/*.js` as that one file name
      // (#2440), so it neither conflicts with `out/a.js` nor feeds the reader.
      expect([...literal.conflicts]).toEqual([])
      expect([...literal.ordering]).toEqual([])

      const effects = (writes: Plan.NodeEffects["writes"], reads: Plan.NodeEffects["reads"] = []) => ({
        effects: { reads, writes, boundaryMode: "expected" as const }
      })
      const globbed = yield* Conflicts.annotate(
        [
          node("a", effects([{ _tag: "Glob", include: ["out/*.js"] }])),
          node("b", { writes: ["out/a.js"] }),
          node("gen", { writes: ["src/gen.ts"] }),
          node("reader", effects([], [{ _tag: "Glob", include: ["src/*.ts"] }]))
        ],
        0,
        false
      )
      expect([...globbed.conflicts].map(([id, notes]) => [id, notes.map((note) => note.with)])).toEqual([
        ["a", ["b"]],
        ["b", ["a"]]
      ])
      // Two Globs overlap conservatively, so the reader also waits for `a`.
      expect([...globbed.ordering]).toEqual([["b", ["a"]], ["reader", ["a", "gen"]]])
    }))

  it.effect("never annotates the frozen prefix, and lands every edge on a new node", () =>
    Effect.gen(function*() {
      const found = yield* Conflicts.annotate(
        [
          node("a", { writes: ["shared", "a.out"] }),
          node("b", { writes: ["shared"] }, 1),
          node("reader", { reads: ["a.out"] }, 1)
        ],
        1,
        false
      )
      expect([...found.conflicts]).toEqual([["b", [serialized("a", ["shared"])]]])
      expect([...found.ordering]).toEqual([["b", ["a"]], ["reader", ["a"]]])
    }))

  it.effect("replays each generation as its own append", () =>
    Effect.gen(function*() {
      const nodes = [node("a", { writes: ["shared"] }), node("b", { writes: ["shared"] }, 1)]
      const replayed = yield* Conflicts.annotate(nodes, 0, true)
      expect([...replayed.conflicts]).toEqual([["b", [serialized("a", ["shared"])]]])
      const single = yield* Conflicts.annotate(nodes, 0, false)
      expect([...single.conflicts.keys()]).toEqual(["a", "b"])
    }))

  it.effect("names a tree by its path and a glob by its includes", () =>
    Effect.gen(function*() {
      const found = yield* Conflicts.annotate(
        [
          node("tree", {
            effects: { reads: [], writes: [{ _tag: "TreeArtifact", path: "dist" }], boundaryMode: "hard" }
          }),
          node("file", { writes: ["dist/app.js"] }),
          node("glob", {
            effects: { reads: [], writes: [{ _tag: "Glob", include: ["docs/**", "notes"] }], boundaryMode: "hard" }
          }),
          node("page", { writes: ["docs/index.md"] })
        ],
        0,
        false
      )
      expect(found.conflicts.get("file")).toEqual([serialized("tree", ["dist"])])
      expect(found.conflicts.get("page")).toEqual([serialized("glob", ["docs/**,notes"])])
    }))

  it.effect("refuses with the code and message a PlanError carries", () =>
    Effect.gen(function*() {
      const forbidden = yield* Effect.flip(Conflicts.annotate(
        [
          node("a", { writes: ["shared"] }),
          node("b", { writes: ["shared"], conflictStrategy: "fail" })
        ],
        0,
        false
      ))
      expect(forbidden).toEqual({ code: "overlap_forbidden", message: "Nodes a and b both write shared" })
      const cycle = yield* Effect.flip(Conflicts.annotate(
        [
          node("a", { reads: ["b.out"], writes: ["a.out"] }),
          node("b", { reads: ["a.out"], writes: ["b.out"] })
        ],
        0,
        false
      ))
      expect(cycle).toEqual({
        code: "cycle",
        message: "Plan cycle: node b reads a.out, which node a produces, so b must follow a, " +
          "but a already depends on b through a -> b"
      })
      // Plan maps the refusal to its typed error without changing either field.
      const error = yield* withCryptoFailure(compile([
        draft("a", { writes: ["shared"] }),
        draft("b", { writes: ["shared"], conflictStrategy: "fail" })
      ]))
      expect(error).toBeInstanceOf(Plan.PlanError)
      expect({ code: (error as Plan.PlanError).code, message: (error as Plan.PlanError).message }).toEqual(forbidden)
    }))
})

/**
 * The reader-after-writer pass. Before it existed, `overlap` compared write
 * sets against write sets only, so a node reading what another node wrote was
 * ordered by nothing and the wavefront could admit both in the same round —
 * the reader measuring pre-producer bytes and caching that as legitimate.
 */
describe("Plan.compile reader-after-writer edges", () => {
  const acyclic = (plan: Plan.Plan): boolean => {
    const order = new Map(plan.nodes.map((node, index) => [node.id, index]))
    const edges = new Map(plan.nodes.map((node) => [node.id, node.dependsOn]))
    const state = new Map<string, "visiting" | "done">()
    const visit = (id: string): boolean => {
      const mark = state.get(id)
      if (mark === "done") return true
      if (mark === "visiting") return false
      state.set(id, "visiting")
      for (const next of edges.get(id) ?? []) if (!visit(next)) return false
      state.set(id, "done")
      return true
    }
    return [...order.keys()].every(visit)
  }

  it.effect("treats a declared removal as a write for ordering and for conflict detection", () =>
    Effect.gen(function*() {
      // A removal moves a path's content exactly as a write does: a reader that
      // runs before it sees different bytes than one that runs after, and two
      // nodes that both claim a path's post-state conflict whether either of
      // them claims it by creating the path or by deleting it.
      const ordered = yield* withCrypto(compile([
        draft("remover", { writes: ["remover.out"], removes: ["stale"] }),
        draft("reader", { reads: ["stale"] })
      ]))
      expect(ordered.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual(["remover"])

      const conflicting = yield* withCrypto(compile([
        draft("writer", { writes: ["shared"] }),
        draft("remover", { writes: ["remover.out"], removes: ["shared"] })
      ]))
      expect(conflicting.nodes.find((node) => node.id === "remover")!.conflicts).toMatchObject([
        { with: "writer", paths: ["shared"] }
      ])
    }))

  it.effect("orders a reader behind the node that writes what it reads", () =>
    Effect.gen(function*() {
      const unrelated = yield* withCrypto(compile([
        draft("writer", { writes: ["other"] }),
        draft("reader", { reads: ["out"] })
      ]))
      const plan = yield* withCrypto(compile([
        draft("writer", { writes: ["out"] }),
        draft("reader", { reads: ["out"] })
      ]))
      const reader = plan.nodes.find((node) => node.id === "reader")!
      expect(reader.dependsOn).toEqual(["writer"])
      // An ordering edge, not a conflict: nothing was double-written.
      expect(plan.nodes.flatMap((node) => node.conflicts)).toEqual([])
      // And ordering is not key material, so the reader keeps its cache hit.
      expect(keyOf(plan, "reader")).toBe(keyOf(unrelated, "reader"))
    }))

  it.effect("keeps material order while requiring a reader declared first to wait for its writer", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("reader", { reads: ["out"] }),
        draft("writer", { writes: ["out"] })
      ]))
      expect(plan.nodes.map((node) => node.id)).toEqual(["reader", "writer"])
      expect(plan.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual(["writer"])
      expect(plan.nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id)).toEqual(["writer"])
      expect(acyclic(plan)).toBe(true)
      expect(yield* withCrypto(Plan.verify(JSON.parse(JSON.stringify(plan))))).toEqual(plan)
    }))

  it.effect("adds nothing when a dependency path already orders the pair", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("writer", { writes: ["out"] }),
        draft("middle", { inputs: [{ _tag: "Ref", from: "writer", path: [] }] }),
        draft("reader", { reads: ["out"], inputs: [{ _tag: "Ref", from: "middle", path: [] }] })
      ]))
      expect(plan.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual(["middle"])
    }))

  it.effect("preserves an explicit read-before-write dependency", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("reader", { reads: ["out"] }),
        draft("writer", { writes: ["out"], inputs: [{ _tag: "Ref", from: "reader", path: [] }] })
      ]))
      expect(plan.nodes.map((node) => [node.id, node.dependsOn])).toEqual([
        ["reader", []],
        ["writer", ["reader"]]
      ])
      yield* withCrypto(Plan.verify(plan))
    }))

  it.effect("preserves a transitive Pending read-before-write sequence", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("reader", { reads: ["out"] }),
        draft("middle", { inputs: [{ _tag: "Pending", from: "reader" }] }),
        draft("writer", { writes: ["out"], inputs: [{ _tag: "Pending", from: "middle" }] })
      ]))
      expect(plan.nodes.map((node) => [node.id, node.dependsOn])).toEqual([
        ["reader", []],
        ["middle", ["reader"]],
        ["writer", ["middle"]]
      ])
      expect(acyclic(plan)).toBe(true)
    }))

  it.effect("refuses two nodes that each read what the other writes", () =>
    Effect.gen(function*() {
      // The first pair puts a behind b. The second pair needs b behind a, and
      // the only edge that could honor it closes a loop with the first.
      const error = yield* withCryptoFailure(compile([
        draft("a", { reads: ["b.out"], writes: ["a.out"] }),
        draft("b", { reads: ["a.out"], writes: ["b.out"] })
      ]))
      expect(error).toMatchObject({
        code: "cycle",
        message: "Plan cycle: node b reads a.out, which node a produces, so b must follow a, " +
          "but a already depends on b through a -> b"
      })
    }))

  it.effect("preserves explicit ordering for overlapping exact and glob reads", () =>
    Effect.gen(function*() {
      const reader = draft("reader")
      const plan = yield* withCrypto(compile([
        {
          ...reader,
          effects: { ...reader.effects, reads: ["out/a.txt", { _tag: "Glob", include: ["out/**"] }] }
        },
        draft("writer", {
          writes: ["out/a.txt", "out/b.txt"],
          inputs: [{ _tag: "Ref", from: "reader", path: [] }]
        })
      ]))
      expect(plan.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual([])
      expect(plan.nodes.find((node) => node.id === "writer")!.dependsOn).toEqual(["reader"])
    }))

  it.effect("reads the intervening version in an explicitly ordered write-read-write chain", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("last", { writes: ["out"], inputs: [{ _tag: "Pending", from: "reader" }] }),
        draft("reader", { reads: ["out"], inputs: [{ _tag: "Pending", from: "first" }] }),
        draft("first", { writes: ["out"] })
      ]))
      expect(plan.nodes.map((node) => [node.id, node.dependsOn])).toEqual([
        ["first", []],
        ["reader", ["first"]],
        ["last", ["reader"]]
      ])
      yield* withCrypto(Plan.verify(plan))
    }))

  it.effect("refuses a serialize edge that points against a read, and accepts the other declaration order", () =>
    Effect.gen(function*() {
      // Both nodes write `shared`, so the later declaration is serialized
      // behind the earlier one. Declared reader-first, that inferred edge
      // orders the producer of `b.out` after its reader; declared
      // producer-first, the same edge is the one the read needs.
      const reader = draft("reader", { reads: ["b.out"], writes: ["shared"] })
      const producer = draft("producer", { writes: ["shared", "b.out"] })
      const error = yield* withCryptoFailure(compile([reader, producer]))
      expect(error).toMatchObject({
        code: "cycle",
        message: "Plan cycle: node reader reads b.out, which node producer produces, so reader must follow producer, " +
          "but producer already depends on reader through producer -> reader"
      })

      const plan = yield* withCrypto(compile([producer, reader]))
      expect(plan.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual(["producer"])
      expect(plan.nodes.find((node) => node.id === "reader")!.conflicts).toMatchObject([
        { with: "producer", paths: ["shared"], strategy: "serialize" }
      ])
      expect(acyclic(plan)).toBe(true)
    }))

  it.effect("never gives a node an edge to itself for reading its own write", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("both", { reads: ["out"], writes: ["out"] })]))
      expect(plan.nodes[0]!.dependsOn).toEqual([])
    }))

  it.effect("visits a diamond of existing edges once while searching for the pair", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("base"),
        draft("left", { inputs: [{ _tag: "Ref", from: "base", path: [] }] }),
        draft("right", { inputs: [{ _tag: "Ref", from: "base", path: [] }] }),
        draft("writer", { writes: ["out"] }),
        draft("reader", {
          reads: ["out"],
          inputs: [{ _tag: "Ref", from: "left", path: [] }, { _tag: "Ref", from: "right", path: [] }]
        })
      ]))
      expect(plan.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual(["left", "right", "writer"])
      expect(acyclic(plan)).toBe(true)
    }))

  it.effect("keeps a whole read-write chain acyclic and ordered", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("c", { reads: ["b.out"], writes: ["c.out"] }),
        draft("a", { writes: ["a.out"] }),
        draft("b", { reads: ["a.out"], writes: ["b.out"] })
      ]))
      expect(acyclic(plan)).toBe(true)
      expect(plan.nodes.find((node) => node.id === "b")!.dependsOn).toEqual(["a"])
      expect(plan.nodes.find((node) => node.id === "c")!.dependsOn).toEqual(["b"])
    }))
})
