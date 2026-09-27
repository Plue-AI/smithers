/**
 * Shared declaration helpers for the standard flows.
 *
 * @since 1.0.0
 */

import type * as Capability from "@smthrs/capability/Capability"
import * as Effects from "@smthrs/core/Effects"

/**
 * Options accepted by {@link envelope}.
 *
 * @category models
 * @since 1.0.0
 */
export interface EnvelopeOptions {
  readonly tier: "sealed" | "compensable" | "irreversible"
  readonly mode: "hermetic" | "expected"
  readonly reads: Iterable<string>
  readonly writes: Iterable<string>
}

/**
 * Builds a deterministic effect declaration for a standard flow.
 *
 * Every standard flow serializes on conflict: the library owns no lane
 * partitioning of its own, so the conservative choice is the safe one.
 *
 * @category constructors
 * @since 1.0.0
 */
export const envelope = (options: EnvelopeOptions): Effects.Declaration =>
  Effects.make({
    reads: options.reads,
    writes: options.writes,
    mode: options.mode,
    onConflict: "serialize",
    tier: options.tier
  })

/**
 * Formats a capability request as the `action:resource` string carried on a
 * flow declaration.
 *
 * @category constructors
 * @since 1.0.0
 */
export const capability = (action: Capability.Action, resource: string): string => `${action}:${resource}`

/**
 * The read glob covering everything under one search root.
 *
 * `glob` and `grep` narrow their conservative `/**` declaration to the root the
 * call actually names, and a declaration that disagreed between the two would
 * make the same search reserve different paths depending on which flow ran it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const rootSubtree = (root: string): string => root === "/" ? "/**" : `${root.replace(/\/+$/, "")}/**`
