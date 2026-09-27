/**
 * Pure effect declarations used to describe flow read and write envelopes.
 *
 * This is the ONE effect-envelope model. `@smthrs/flow` enforces it while it
 * builds a graph, `@smthrs/core` re-exports it, and `@smthrs/patterns` reads it
 * to intersect a decorator's declaration with the flow it wraps. It lives here
 * because `@smthrs/plan` is the lowest package all three depend on, beside the
 * `tier` and `onConflict` vocabularies a plan already speaks.
 *
 * Two layers: the declaration API, which a flow author and a catalog use, and
 * the prepared matching API below it, which a graph builder uses to check one
 * envelope against many steps without re-reading the envelope each time.
 *
 * Governing contract: `packages/smithers/flows/plan/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/plan.
 *
 * @since 0.0.0
 */

import * as Context from "effect/Context"
import * as Schema from "effect/Schema"
import * as Index from "./internal/effects.ts"

/**
 * How reversible the work beneath a declaration is.
 *
 * This is the ONE tier vocabulary. `KeyMaterial.kind` is this schema, and so
 * is `@smthrs/flow`'s `Action.Tier`: an action's durability and a declared
 * envelope's ceiling are the same three words, and a fourth spelling of them
 * in one of the three places would fork identity silently.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Tier = Schema.Literals(["sealed", "compensable", "irreversible"])

/**
 * The value form of {@link Tier}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Tier = typeof Tier.Type

/**
 * How hermetic the work beneath a declaration is.
 *
 * This is the ONE mode vocabulary: the two words were written out in
 * `Declaration`, in `MakeOptions`, and twice more inside the matcher.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Mode = Schema.Literals(["hermetic", "expected"])

/**
 * The value form of {@link Mode}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Mode = typeof Mode.Type

/**
 * What a plan does when two nodes write the same path.
 *
 * This is the ONE conflict vocabulary: `Declaration.onConflict` declares it and
 * `Plan.PairStrategy` is this same schema, resolved per pair by
 * `Plan.compile`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const ConflictStrategy = Schema.Literals(["serialize", "lane", "fail"])

/**
 * The value form of {@link ConflictStrategy}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ConflictStrategy = typeof ConflictStrategy.Type

/**
 * The annotation key a flow's declared effect ENVELOPE is carried under.
 *
 * One key, here, because two graph builders read it: `@smthrs/flow`'s
 * `Graph.build` enforces the envelope it names, and `@smthrs/core` re-exports
 * this key as `Annotations.Effects`. While they were separate keys a flow
 * annotated for one builder was invisible to the other.
 *
 * It is a `Context` key, not hashed material: annotating a flow with an
 * envelope changes what a build ADMITS, and the declaration reaches identity
 * only through `KeyMaterial.kind`.
 *
 * @category annotations
 * @since 1.0.0-rc.0
 */
export const Envelope = Context.Service<Declaration>("@smthrs/plan/Effects/Envelope")

/**
 * The prepared matching API: what a graph builder needs to check one envelope
 * against every step it encloses, and to find the write overlaps between two
 * declarations, at the cost the public functions above pay once rather than
 * once per step.
 *
 * {@link prepareEnvelope} reads an envelope once into the form
 * {@link narrowPrepared} answers from, which is what makes a wide envelope cost
 * its size per build rather than per node. {@link indexPaths},
 * {@link rankPaths} and {@link overlapRanks} are the same decomposition for
 * write overlap, which {@link overlaps} wraps for the pairwise case.
 * {@link boundedEffects} snapshots a declaration into builder-owned data,
 * refusing through the caller's own error before the copy grows past its limit,
 * and {@link maximumPathLength} and {@link maximumGlobs} are the per-path bounds
 * that refusal enforces.
 *
 * @category matching
 * @since 1.0.0-rc.0
 */
export type { PathIndex, PreparedEnvelope, Ranked } from "./internal/effects.ts"

/**
 * The prepared matching API. See the type re-exports above for what each member
 * is for.
 *
 * @category matching
 * @since 1.0.0-rc.0
 */
export {
  boundedEffects,
  indexPaths,
  maximumGlobs,
  maximumPathLength,
  narrowPrepared,
  overlapRanks,
  prepareEnvelope,
  rankPaths
} from "./internal/effects.ts"

/**
 * A normalized description of the resources a flow or step may read and
 * write.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Declaration {
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly mode: Mode
  readonly onConflict: ConflictStrategy
  readonly tier?: Tier | undefined
}

/**
 * Input accepted by {@link make}. Iterables are normalized into sorted,
 * duplicate-free arrays so declarations are deterministic key material.
 * Envelope entries and declared paths must already be path-normalized: no
 * separator or dot-segment rewriting is performed. A declared path containing
 * a whole `.` or `..` segment is never covered and therefore surfaces from
 * {@link narrow} as an `effect_outside_envelope` diagnostic.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface MakeOptions {
  readonly reads: Iterable<string>
  readonly writes: Iterable<string>
  readonly mode: Mode
  readonly onConflict: ConflictStrategy
  readonly tier?: Tier | undefined
}

/**
 * A result of checking that a step declaration narrows a flow envelope.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type NarrowResult =
  | { readonly ok: true }
  | {
    readonly ok: false
    readonly code: "effect_outside_envelope" | "effect_mode_widening" | "effect_tier_widening"
    readonly paths: ReadonlyArray<string>
  }

const normalize = (paths: Iterable<string>): ReadonlyArray<string> => [...new Set(paths)].sort()

/**
 * Constructs a deterministic effect declaration.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const make = (input: MakeOptions): Declaration => ({
  reads: normalize(input.reads),
  writes: normalize(input.writes),
  mode: input.mode,
  onConflict: input.onConflict,
  ...(input.tier === undefined ? {} : { tier: input.tier })
})

/**
 * Checks whether `path` is covered by an envelope entry.
 *
 * The grammar is exhaustive: an exact path matches itself; `*` and `**` match
 * everything; `prefix*` matches by string prefix; and `prefix/**` matches
 * `prefix/` and everything below it, but not bare `prefix`. This is
 * intentionally not full minimatch syntax. Envelope entries and declared paths
 * must be normalized. A path containing a whole `.` or `..` segment is never
 * covered, so {@link narrow} reports it as `effect_outside_envelope` rather
 * than silently accepting an escape.
 *
 * @category predicates
 * @since 0.0.0
 * @slop
 */
export const covers = (envelope: string, path: string): boolean => {
  if (Index.hasDotSegment(path)) return false
  return envelope === path || (Index.isGlob(envelope) && path.startsWith(Index.globPrefix(envelope)))
}

/**
 * Verifies that a step declaration stays within an enclosing flow envelope.
 *
 * Read and write paths must be covered independently. A step may tighten
 * `expected` to `hermetic`, but cannot widen `hermetic` to `expected`.
 * Effect tiers narrow from irreversible to compensable to sealed.
 *
 * The envelope's lists are prepared once: exact entries go into a set and
 * covering patterns collapse to their outermost prefixes, sorted, so each step
 * path costs one dot-segment scan, one lookup, and one binary search ending in
 * one prefix comparison, whatever the envelope's width or how many of its
 * patterns nest. A graph build prepares each envelope once for every node it
 * encloses.
 *
 * @category validation
 * @since 0.0.0
 * @slop
 */
export const narrow = (envelope: Declaration, step: Declaration): NarrowResult =>
  Index.narrowPrepared(Index.prepareEnvelope(envelope), step)

/**
 * Returns the concrete or narrower write declarations shared by two effect
 * declarations. The result is sorted and duplicate-free.
 *
 * Two declarations of the same literal path always overlap, including a path
 * {@link covers} refuses to match because it carries a `.` or `..` segment.
 * Glob coverage stays strict for those paths, so an unnormalized declaration
 * still escapes no envelope, but two writers naming the same unnormalized path
 * are still detected as writing the same resource.
 *
 * The union of both declarations is indexed once: the distinct paths are
 * sorted, each is scanned once for a dot segment, and each pattern's prefix
 * is located by binary search. Exact paths then match through a merge of two
 * rank lists and each covering pattern enumerates the other declaration's
 * ranks inside its interval, so the cost is linear in the two declarations
 * plus the matches, whatever the paths' lengths or how many patterns nest.
 *
 * @category analysis
 * @since 0.0.0
 * @slop
 */
export const overlaps = (a: Declaration, b: Declaration): ReadonlyArray<string> => {
  const indexed = Index.indexPaths([a.writes, b.writes])
  return Index.overlapRanks(indexed, Index.rankPaths(indexed, a.writes), Index.rankPaths(indexed, b.writes))
    .map((rank) => indexed.paths[rank]!)
}

/**
 * Returns a sealed, hermetic copy of an effect declaration.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const sealed = (declaration: Declaration): Declaration =>
  make({ ...declaration, mode: "hermetic", tier: "sealed" })
