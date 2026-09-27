/**
 * The compiler's effect analysis: which writers conflict, and which readers
 * must wait for a producer. Its vocabulary is pairs of declared effects; it
 * never re-keys a node, because ordering is not key material.
 *
 * @since 0.1.0
 * @private
 */

import * as Effect from "effect/Effect"
import * as FileSet from "../FileSet.ts"
import * as KeyMaterial from "../KeyMaterial.ts"
import type * as Plan from "../Plan.ts"
import * as EffectCandidates from "./EffectCandidates.ts"

/**
 * What {@link annotate} found, by node id and in discovery order: the conflict
 * annotations a node carries and the ordering edges it gains. A frozen node
 * never appears, because its row is never rewritten.
 *
 * @private
 */
interface Annotations {
  readonly conflicts: ReadonlyMap<string, ReadonlyArray<Plan.ConflictAnnotation>>
  readonly ordering: ReadonlyMap<string, ReadonlyArray<string>>
}

/**
 * A graph the analysis refuses, in the fields a `PlanError` carries.
 *
 * @private
 */
interface Refusal {
  readonly code: "cycle" | "graph_too_large" | "overlap_forbidden"
  readonly message: string
}

/** @private */
const refuse = (code: Refusal["code"], message: string) => Effect.fail<Refusal>({ code, message })

/**
 * Resolves the pair's verdict. `fail` dominates — a flow that promised
 * disjointness must not be quietly serialized — then `lane`, because "when
 * either writer requests `lane`, both receive lane annotations"; `serialize`
 * is the default whenever an overlap is detected at all.
 *
 * @private
 */
const pairStrategy = (left: Plan.PairStrategy, right: Plan.PairStrategy): Plan.PairStrategy =>
  left === "fail" || right === "fail" ? "fail" : left === "lane" || right === "lane" ? "lane" : "serialize"

/**
 * `stop-merge` dominates for the same reason `lane` does: it is the strategy a
 * declaration opts into, and a pair cannot half-merge.
 *
 * @private
 */
const pairRuntime = (left: Plan.RuntimeStrategy, right: Plan.RuntimeStrategy): Plan.RuntimeStrategy =>
  left === "stop-merge" || right === "stop-merge" ? "stop-merge" : "delay-rebase"

/**
 * Every path a node mutates. A removal moves a path's content exactly as a
 * write does — a reader that runs before it sees different bytes than one that
 * runs after — so both passes below treat the two as one set.
 *
 * @private
 */
const producedPaths = (effects: Plan.NodeEffects): ReadonlyArray<FileSet.Entry> => [
  ...FileSet.expand(effects.writes),
  ...effects.removes ?? []
]

/**
 * How an annotation and a refusal name one declared entry.
 *
 * @private
 */
const describe = (entry: FileSet.Entry): string =>
  typeof entry === "string" ? entry : entry._tag === "TreeArtifact" ? entry.path : entry.include.join(",")

/** @private */
const overlap = (
  left: ReadonlyArray<FileSet.Entry>,
  right: ReadonlyArray<FileSet.Entry>
): ReadonlyArray<string> =>
  left.flatMap((leftEntry) =>
    right.some((rightEntry) => FileSet.overlaps(leftEntry, rightEntry)) ? [describe(leftEntry)] : []
  )

/**
 * The read declarations of one node that a writer's produced set covers. The
 * conflict pass compares write sets against write sets, so this relation is
 * the one it cannot see. Rendered the way {@link overlap} renders a write,
 * because a refusal names them.
 *
 * @private
 */
const readOverlap = (
  reads: ReadonlyArray<FileSet.ReadEntry>,
  produced: ReadonlyArray<FileSet.Entry>
): ReadonlyArray<string> =>
  reads.flatMap((entry) => produced.some((output) => FileSet.overlaps(entry, output)) ? [describe(entry)] : [])

/**
 * Two passes over the graph.
 *
 * The first detects write overlaps and annotates the conflicting pair, adding
 * the ordering edge a `serialize` verdict implies. Nodes already ordered by a
 * dependency path are not conflicts.
 *
 * The second adds reader-after-writer edges: a node that reads a path another
 * node writes is ordered behind its producer. That pair is not a conflict,
 * because nothing needs annotating and no strategy applies. It is a missing
 * edge, so only `dependsOn` grows. When the graph already orders the producer
 * behind its reader by explicit material dependencies, the reader consumes
 * the earlier version. An opposing inferred ordering still fails with `cycle`.
 *
 * Nodes are visited in plan order, so a `serialize` edge always points from
 * the earlier declaration to the later one and can never close a cycle. The
 * first `frozen` nodes were recorded by an earlier generation: append-only
 * means their rows are never rewritten, so a pair discovered during
 * elaboration is annotated on the NEW node only — which is also the node the
 * ordering edge lands on, and the annotation names the other side either way.
 * `replayGenerations` re-derives a recorded plan one generation at a time
 * under that same rule.
 *
 * @since 0.1.0
 * @private
 */
export const annotate = (
  nodes: ReadonlyArray<Plan.PlanNode>,
  frozen: number,
  replayGenerations: boolean
): Effect.Effect<Annotations, Refusal> =>
  Effect.gen(function*() {
    const expanded = new Map(nodes.map((node) => [node.id, {
      produced: producedPaths(node.effects),
      reads: FileSet.expandReads(node.effects.reads)
    }]))
    const candidates = EffectCandidates.make(nodes.map((node) => expanded.get(node.id)!.produced))
    const conflicts = new Map<string, Array<Plan.ConflictAnnotation>>()
    const ordering = new Map<string, Array<string>>()
    const edges = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn)]))
    // Keep declaration sequencing separate from inferred ordering, including
    // for frozen generations whose `dependsOn` already contains inferred edges.
    const declaredEdges = new Map(nodes.map((node) => [node.id, KeyMaterial.dependencies(node.material)]))
    // One index and mutable graph serve every replayed generation. Future
    // producers are filtered at the generation boundary, never re-indexed.
    const ordinals = new Map(nodes.map((node, index) => [node.id, index]))
    const dependents = new Map(nodes.map((node) => [node.id, new Set<string>()]))
    for (const node of nodes) {
      for (const dependency of node.dependsOn) dependents.get(dependency)!.add(node.id)
    }
    const words = Math.ceil(nodes.length / 32)
    const ancestors = new Map<string, Uint32Array>()
    // Charge a pair for bookkeeping as well as its path comparisons. The
    // separate pair ceiling also bounds persisted annotations and edges.
    let work = 0
    let pairs = 0
    let nextYield = 2_048
    const checkpoint = Effect.gen(function*() {
      if (work > 10_000_000 || pairs > 250_000) {
        return yield* refuse(
          "graph_too_large",
          "Plan effect analysis exceeds its work budget (10000000 work units or 250000 candidate pairs)"
        )
      }
      nextYield = Math.min(work + 2_048, 10_000_001)
      yield* Effect.yieldNow
    })
    // Cache transitive ancestors as bitsets. Adding an edge updates its source
    // immediately and invalidates only cached dependents. In particular, dense
    // writers never walk the growing dependency DAG for each conflicting pair.
    const closure = (id: string): Effect.Effect<Uint32Array, Refusal> =>
      Effect.gen(function*() {
        const cached = ancestors.get(id)
        if (cached !== undefined) return cached
        const frame = (id: string) => {
          const bits = new Uint32Array(words)
          const ordinal = ordinals.get(id)!
          bits[ordinal >>> 5]! |= 1 << (ordinal & 31)
          return { id, bits, dependencies: Array.from(edges.get(id)!), next: 0 }
        }
        const stack = [frame(id)]
        while (stack.length > 0) {
          const current = stack[stack.length - 1]!
          const dependency = current.dependencies[current.next]
          if (dependency === undefined) {
            ancestors.set(current.id, current.bits)
            stack.pop()
            continue
          }
          const bits = ancestors.get(dependency)
          if (bits === undefined) {
            stack.push(frame(dependency))
            continue
          }
          for (let word = 0; word < words; word++) {
            current.bits[word]! |= bits[word]!
            if (++work >= nextYield) yield* checkpoint
          }
          current.next++
        }
        return ancestors.get(id)!
      })
    const reaches = (from: string, to: string) =>
      Effect.gen(function*() {
        const bits = yield* closure(from)
        const ordinal = ordinals.get(to)!
        return (bits[ordinal >>> 5]! & (1 << (ordinal & 31))) !== 0
      })
    const addEdge = (from: string, to: string) =>
      Effect.gen(function*() {
        const source = yield* closure(from)
        const target = yield* closure(to)
        for (let word = 0; word < words; word++) {
          source[word]! |= target[word]!
          if (++work >= nextYield) yield* checkpoint
        }
        const stack = [from]
        while (stack.length > 0) {
          for (const dependent of dependents.get(stack.pop()!)!) {
            if (++work >= nextYield) yield* checkpoint
            if (!ancestors.delete(dependent)) continue
            stack.push(dependent)
          }
        }
        edges.get(from)!.add(to)
        dependents.get(to)!.add(from)
      })
    // Routes are only needed for explicit version sequencing and a cycle's
    // diagnostic. Bound and yield these walks too.
    const route = (
      from: string,
      to: string,
      graph: ReadonlyMap<string, Iterable<string>> = edges
    ): Effect.Effect<ReadonlyArray<string> | undefined, Refusal> =>
      Effect.gen(function*() {
        const arrivedFrom = new Map<string, string>()
        const seen = new Set<string>([from])
        const stack = [from]
        while (stack.length > 0) {
          const current = stack.pop()!
          if (current === to) {
            const chain = [current]
            for (let step = arrivedFrom.get(current); step !== undefined; step = arrivedFrom.get(step)) {
              chain.push(step)
            }
            return chain.reverse()
          }
          for (const next of graph.get(current)!) {
            if (++work >= nextYield) yield* checkpoint
            if (seen.has(next)) continue
            seen.add(next)
            arrivedFrom.set(next, current)
            stack.push(next)
          }
        }
        return undefined
      })
    const ranges: Array<{ start: number; end: number }> = []
    let start = frozen
    for (let end = start + 1; end <= nodes.length; end++) {
      if (end === nodes.length || (replayGenerations && nodes[end]!.generation !== nodes[start]!.generation)) {
        ranges.push({ start, end })
        start = end
      }
    }
    for (const { start, end } of ranges) {
      for (let index = start; index < end; index++) {
        const later = nodes[index]!
        const laterProduced = expanded.get(later.id)!.produced
        if (laterProduced.length === 0) continue
        const matches = candidates(laterProduced)
        work += matches.length + laterProduced.length
        if (work >= nextYield) yield* checkpoint
        for (const before of matches) {
          if (before >= index) break
          pairs++
          work += 32
          if (work >= nextYield || pairs > 250_000) yield* checkpoint
          const earlier = nodes[before]!
          const earlierProduced = expanded.get(earlier.id)!.produced
          work += earlierProduced.length * laterProduced.length
          if (work >= nextYield) yield* checkpoint
          const paths = overlap(earlierProduced, laterProduced)
          if (paths.length === 0) continue
          if (yield* reaches(later.id, earlier.id)) continue
          const strategy = pairStrategy(earlier.strategy, later.strategy)
          const runtime = pairRuntime(earlier.runtime, later.runtime)
          if (strategy === "fail") {
            return yield* refuse(
              "overlap_forbidden",
              `Nodes ${earlier.id} and ${later.id} both write ${paths.join(", ")}`
            )
          }
          const annotation = (other: string): Plan.ConflictAnnotation => ({ with: other, paths, strategy, runtime })
          if (before >= start) {
            const previous = conflicts.get(earlier.id) ?? []
            previous.push(annotation(later.id))
            conflicts.set(earlier.id, previous)
          }
          const previous = conflicts.get(later.id) ?? []
          previous.push(annotation(earlier.id))
          conflicts.set(later.id, previous)
          if (strategy === "serialize") {
            const added = ordering.get(later.id) ?? []
            added.push(earlier.id)
            ordering.set(later.id, added)
            yield* addEdge(later.id, earlier.id)
          }
        }
      }
      // Reader-after-writer. A node that READS a path another node WRITES was
      // ordered by nothing: the pass above compares write sets against write
      // sets, so reader and writer could be admitted in the same wavefront
      // round. The reader then measures pre-producer bytes and — because the
      // dispatch key honestly folds the digest it measured — caches that wrong
      // execution as a legitimate one. `PlanScheduler.measure` already assumes
      // "their preceding producer has settled"; this pass is what makes that
      // assumption true. Explicit read-before-write sequencing instead consumes
      // an earlier version: a source input, or another preceding writer's output.
      //
      // Ordering only, exactly like a `serialize` edge: it enters `dependsOn`
      // and never key material, because the reader computes the same result
      // either way and its content dependence is already keyed by the hermetic
      // boundary digests measured at dispatch.
      for (let index = start; index < end; index++) {
        const reader = nodes[index]!
        // Append-only: a frozen node's row is never rewritten, so the edge lands
        // on the new node only — the same rule the conflict pass follows.
        const reads = expanded.get(reader.id)!.reads
        if (reads.length === 0) continue
        const matches = candidates(reads)
        work += matches.length + reads.length
        if (work >= nextYield) yield* checkpoint
        for (const writerIndex of matches) {
          if (writerIndex >= end) break
          pairs++
          work += 32
          if (work >= nextYield || pairs > 250_000) yield* checkpoint
          const writer = nodes[writerIndex]!
          if (writer.id === reader.id) continue
          const produced = expanded.get(writer.id)!.produced
          work += reads.length * produced.length
          if (work >= nextYield) yield* checkpoint
          const paths = readOverlap(reads, produced)
          if (paths.length === 0) continue
          // Already ordered, by a material edge, a serialize edge, or a path
          // through either.
          if (yield* reaches(reader.id, writer.id)) continue
          // Explicit sequencing selects the version being read. Do not reverse
          // it just because a later node writes the same path. Only declared
          // Ref/Pending paths establish this intent; a serialize edge or an
          // earlier inferred producer edge cannot silently select old bytes.
          if (yield* reaches(writer.id, reader.id)) {
            if ((yield* route(writer.id, reader.id, declaredEdges)) !== undefined) continue
            const contradiction = (yield* route(writer.id, reader.id))!
            return yield* refuse(
              "cycle",
              `Plan cycle: node ${reader.id} reads ${paths.join(", ")}, which node ${writer.id} produces, ` +
                `so ${reader.id} must follow ${writer.id}, but ${writer.id} already depends on ${reader.id} ` +
                `through ${contradiction.join(" -> ")}`
            )
          }
          const added = ordering.get(reader.id) ?? []
          added.push(writer.id)
          ordering.set(reader.id, added)
          yield* addEdge(reader.id, writer.id)
        }
      }
    }
    return { conflicts, ordering }
  })
