/**
 * Opaque child-workspace declarations for build-system repositories.
 *
 * A local repository is inert workspace data. The package loader validates
 * its directory and workspace marker before discovery, then treats the tree
 * as an opaque boundary unless a declared input names a path inside it.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Schema for a workspace-relative opaque child repository declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Declaration = Schema.TaggedStruct("LocalRepository", {
  path: Schema.NonEmptyString,
  branch: Schema.optional(Schema.NonEmptyString)
})

/**
 * A declared opaque child Smithers workspace.
 *
 * @category models
 * @since 0.1.0
 */
export type Declaration = typeof Declaration.Type

/**
 * Checks whether a value is a local repository declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isDeclaration: (value: unknown) => value is Declaration = Schema.is(Declaration)

/**
 * Declares an opaque child Smithers workspace at a workspace-relative path.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  path: string,
  options: { readonly branch?: string | undefined } = {}
): Declaration => Declaration.make({ path, branch: options.branch })
