// Deep reviewed and polished by a human on 2026-08-10.

/**
 * An action's declaration of which files it reads and which it may write.
 *
 * The declaration is what makes a step hermetic enough to cache: the read set
 * is the dependency edge set folded into the step key, and the write set is
 * what the host measures the execution against afterwards. `boundaryMode`
 * decides what happens when the two disagree — a hard boundary refuses the
 * result, an expected one records the deviation and carries on.
 *
 * @since 0.1.0
 */

import * as FileSet from "@smthrs/plan/FileSet"
import * as Schema from "effect/Schema"
import { BoundaryMode } from "./BoundaryMode.ts"
import { FileInput } from "./FileInput.ts"

/**
 * Schema for the filesystem boundary of an action.
 *
 * @category models
 * @since 0.1.0
 */
export const FileBoundary = Schema.Struct({
  /**
   * Exact files already measured, or globs to expand while preparing.
   *
   * Workspace-relative in both forms: a measured {@link FileInput} path is
   * checked like every pattern, because the engine measures reads inside the
   * workspace sandbox and would refuse an absolute or upward path only at
   * prepare time.
   */
  readSet: Schema.Array(Schema.Union([FileInput, FileSet.Glob])),
  /** Files or patterns the action is allowed to write. */
  writeSet: Schema.Array(FileSet.Entry),
  /**
   * Files the action is allowed to DELETE.
   *
   * A declared write that is absent when the action finishes is a defect —
   * Bazel's `SkyframeActionExecutor.checkOutputs` reports "output was not
   * created" and fails the action — because recording the absence as valid
   * evidence caches the claim "this file should not exist", which a later
   * replay then acts on by deleting the path. Deletion stays a feature here,
   * but only when it was declared, and a declared removal is what makes an
   * absent path legitimate rather than a crash mid-execution.
   *
   * Optional with an empty default, so boundaries persisted before it keep
   * decoding. Disjoint from {@link writeSet}: a path cannot be both promised
   * and disclaimed. Workspace-relative like every other declared path —
   * replay acts on a removal by deleting it, so an absolute or upward
   * spelling would hand evidence an eraser aimed outside the workspace.
   */
  removes: Schema.optional(Schema.Array(FileSet.Pattern)),
  /** Whether undeclared access is rejected immediately or validated later. */
  boundaryMode: BoundaryMode
}).check(
  Schema.makeFilter(
    (boundary) => {
      const both = (boundary.removes ?? []).filter((path) =>
        boundary.writeSet.some((entry) => FileSet.overlaps(entry, path))
      )
      return both.length === 0 ||
        `a path cannot be both written and removed: ${both.join(", ")}`
    },
    { title: "disjointWritesAndRemoves" }
  )
)

/**
 * The filesystem boundary of an action.
 *
 * @category models
 * @since 0.1.0
 */
export type FileBoundary = typeof FileBoundary.Type
