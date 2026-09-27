/**
 * Immutable snapshots of filesystem declarations crossing an async boundary.
 *
 * @since 1.0.0
 */

import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as FileSet from "@smthrs/plan/FileSet"

const freeze = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => Object.freeze([...values])

const glob = (entry: FileSet.Glob): FileSet.Glob =>
  Object.freeze({
    _tag: "Glob",
    include: freeze(entry.include) as FileSet.Glob["include"],
    ...(entry.exclude === undefined ? {} : { exclude: freeze(entry.exclude) })
  })

/**
 * Copies and freezes every mutable member of a boundary declaration.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (boundary: FileBoundary): FileBoundary =>
  Object.freeze({
    readSet: freeze(boundary.readSet.map((entry) =>
      FileSet.isGlob(entry) ? glob(entry) : Object.freeze({ path: entry.path, digest: entry.digest })
    )),
    writeSet: freeze(boundary.writeSet.map((entry) =>
      typeof entry === "string"
        ? entry
        : FileSet.isGlob(entry)
        ? glob(entry)
        : Object.freeze({ _tag: "TreeArtifact" as const, path: entry.path })
    )),
    ...(boundary.removes === undefined ? {} : { removes: freeze(boundary.removes) }),
    boundaryMode: boundary.boundaryMode
  })
