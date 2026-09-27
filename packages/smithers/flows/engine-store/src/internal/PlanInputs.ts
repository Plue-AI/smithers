/**
 * Cross-check stored or newly measured observations against a verified plan.
 * @since 1.0.0
 */

import { FileSet, type Plan } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import * as PlanInputStore from "../PlanInputStore.ts"

/**
 * Validates without publishing or mutating either the old pins or observations.
 * @since 1.0.0
 * @category validation
 */
export const validate = (
  snapshot: PlanInputStore.Snapshot,
  nodes: ReadonlyArray<Plan.PlanNode>,
  pinned: ReadonlyMap<string, string>,
  writerScopesBefore: (node: Plan.PlanNode) => ReadonlyArray<FileSet.Entry>
): Effect.Effect<Map<string, string>, PlanInputStore.PlanInputError> =>
  Effect.gen(function*() {
    const corrupt = (message: string) =>
      Effect.fail(new PlanInputStore.PlanInputError({ code: "corrupt_state", message }))
    if (snapshot.nodes.length !== nodes.length) return yield* corrupt("source observation node count changed")
    const nextPins = new Map(pinned)
    const newPins = new Set<string>()
    for (const pin of snapshot.pins) {
      if (nextPins.has(pin.path)) return yield* corrupt("a later generation replaced an existing source pin")
      nextPins.set(pin.path, pin.digest)
      newPins.add(pin.path)
    }
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!
      const recorded = snapshot.nodes[index]!
      const reads = FileSet.expandReads(node.effects.reads)
      const writerScopes = reads.length === 0 ? [] : writerScopesBefore(node)
      if (recorded.id !== node.id || recorded.key !== node.key || recorded.reads.length !== reads.length) {
        return yield* corrupt("source observation does not match its plan node")
      }
      for (let readIndex = 0; readIndex < reads.length; readIndex++) {
        const expected = Schema.decodeUnknownSync(FileSet.ReadEntry)(reads[readIndex]!)
        const read = recorded.reads[readIndex]!
        if (JSON.stringify(read.entry) !== JSON.stringify(expected)) {
          return yield* corrupt("source observation declaration changed")
        }
        if (typeof expected === "string") {
          const source = !writerScopes.some((scope) => FileSet.overlaps(scope, expected))
          if (read.sourcePaths.length !== (source ? 1 : 0)) {
            return yield* corrupt("source observation selects the wrong file version")
          }
        }
        for (const path of read.sourcePaths) {
          if (!nextPins.has(path) || writerScopes.some((scope) => FileSet.overlaps(scope, path))) {
            return yield* corrupt("source observation has a missing pin or preceding writer")
          }
          newPins.delete(path)
        }
      }
    }
    if (newPins.size > 0) return yield* corrupt("source observation contains unreferenced pins")
    return nextPins
  })
