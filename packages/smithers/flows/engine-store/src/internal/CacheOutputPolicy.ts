/**
 * Replay authority comes from the current descriptor, never the recorded paths.
 * This preflight performs no host I/O; every path is checked before replay can prune.
 * @since 1.0.0-rc.0
 */

import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as FileSet from "@smthrs/plan/FileSet"
import * as Schema from "effect/Schema"
import type * as StepBoundary from "../StepBoundary.ts"

const Outputs = Schema.Struct({
  outputs: Schema.Array(Schema.Struct({ path: Schema.String, digest: Schema.NullOr(ArtifactStore.Digest) })),
  trees: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String, identity: Schema.String })))
})
// The existing abstract boundary protocol records its exact declared path set.
// Validate that format separately; it does not claim a filesystem blob manifest.
const DeclaredPaths = Schema.Struct({ paths: Schema.Array(FileSet.Entry) })
const samePaths = Schema.toEquivalence(Schema.Array(FileSet.Entry))

/** A typed refusal leaves both the evidence and the workspace intact.
 * @category models
 * @since 1.0.0-rc.0
 */
export type Decision =
  | { readonly _tag: "ReplayOutputs" }
  | { readonly _tag: "Refused"; readonly reason: "output-boundary-mismatch" | "unsupported-output-evidence" }

/** Validate all recorded writes, removals and pruning roots before materialization.
 * Unknown output formats cannot establish current filesystem authority.
 * @category classifiers
 * @since 1.0.0-rc.0
 */
export const replay = (
  descriptor: FileBoundary | undefined,
  evidence: StepBoundary.BoundaryEvidence
): Decision => {
  const mismatch = { _tag: "Refused", reason: "output-boundary-mismatch" } as const
  if (descriptor === undefined) return mismatch
  const decoded = Schema.decodeUnknownResult(Outputs)(evidence.declaredOutputs)
  if (decoded._tag === "Failure") {
    const paths = Schema.decodeUnknownResult(DeclaredPaths)(evidence.declaredOutputs)
    // Malformed production evidence cannot downgrade itself to the abstract
    // protocol by also supplying a matching path list.
    if (paths._tag === "Failure" || Object.hasOwn(evidence.declaredOutputs as object, "outputs")) {
      return { _tag: "Refused", reason: "unsupported-output-evidence" }
    }
    return (descriptor.removes ?? []).length === 0 && samePaths(paths.success.paths, descriptor.writeSet)
      ? { _tag: "ReplayOutputs" }
      : mismatch
  }
  const { outputs, trees = [] } = decoded.success
  const paths = [...outputs.map((output) => output.path), ...trees.map((tree) => tree.path)]
  // Use the exact coordinate spelling that replay passes to the filesystem.
  if (paths.some((path) => !FileSet.workspaceRelative(path) || FileSet.canonical(path) !== path)) return mismatch
  if (new Set(outputs.map((output) => output.path)).size !== outputs.length) return mismatch
  if (new Set(trees.map((tree) => tree.path)).size !== trees.length) return mismatch
  const removes = descriptor.removes ?? []
  for (const output of outputs) {
    if (output.digest === null) {
      if (!removes.includes(output.path)) return mismatch
    } else if (
      removes.includes(output.path) ||
      !descriptor.writeSet.some((entry) => FileSet.overlaps(entry, output.path))
    ) return mismatch
  }
  // A tree root authorizes pruning its entire subtree. A glob or a narrower
  // tree is never sufficient authority for a recorded broader pruning root.
  const declaredTrees = descriptor.writeSet.filter(FileSet.isTreeArtifact)
  // A declared tree root is a directory, never a replayable file or deletion.
  if (declaredTrees.some((entry) => outputs.some((output) => output.path === entry.path))) return mismatch
  if (trees.some((tree) => !declaredTrees.some((entry) => entry.path === tree.path))) return mismatch
  if (declaredTrees.some((entry) => !trees.some((tree) => tree.path === entry.path))) return mismatch
  if (removes.some((path) => !outputs.some((output) => output.path === path && output.digest === null))) return mismatch
  if (
    descriptor.writeSet.some((entry) =>
      typeof entry === "string" && !outputs.some((output) => output.path === entry && output.digest !== null)
    )
  ) return mismatch
  return { _tag: "ReplayOutputs" }
}
