// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Defines filesystem boundary enforcement modes.
 *
 * The schema itself is `@smthrs/plan`'s `FileSet.BoundaryMode`, because the
 * same two words are what a plan node's `effects.boundaryMode` carries. This
 * module is the name an action reaches for; there is one declaration behind
 * both.
 *
 * @since 0.1.0
 */

import * as FileSet from "@smthrs/plan/FileSet"

/**
 * Schema for how strictly an action's filesystem boundary is enforced.
 *
 * `hard` rejects undeclared access. `expected` records access for validation
 * after execution without requiring the sandbox to reject it immediately.
 *
 * @category models
 * @since 0.1.0
 */
export const BoundaryMode = FileSet.BoundaryMode

/**
 * How strictly an action's filesystem boundary is enforced.
 *
 * @category models
 * @since 0.1.0
 */
export type BoundaryMode = FileSet.BoundaryMode
