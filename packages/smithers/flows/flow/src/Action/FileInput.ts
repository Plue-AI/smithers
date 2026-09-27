// Deep reviewed and polished by a human on 2026-08-10.

/**
 * A file path paired with the digest measured for its contents.
 *
 * Paths alone cannot key a step — the same path holds different bytes on
 * different days — so every declared read carries the digest observed for it,
 * and a later run compares digests rather than mtimes.
 *
 * @since 0.1.0
 */

import * as FileSet from "@smthrs/plan/FileSet"
import * as Schema from "effect/Schema"

/**
 * Schema for an input file path paired with its measured content digest.
 *
 * The path is workspace-relative like every other declared path in a
 * {@link FileBoundary}: the engine measures reads through the workspace
 * sandbox, which refuses absolute and upward spellings, so a boundary that
 * admitted them here would only be refused later, at prepare or replay.
 * Checking here keeps the boundary this package admits the boundary the
 * engine accepts.
 *
 * @category models
 * @since 0.1.0
 */
export const FileInput = Schema.Struct({
  /** Workspace-relative path of the input file. */
  path: FileSet.Pattern,
  /** Non-empty digest observed for the file contents. */
  digest: Schema.NonEmptyString
})

/**
 * An input file path paired with its measured content digest.
 *
 * @category models
 * @since 0.1.0
 */
export type FileInput = typeof FileInput.Type
