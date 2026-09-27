/**
 * PACKAGE.ts fetch target: `S.Fetch`.
 *
 * A fetch target declares one remote file pinned by content digest. `url`
 * names where the bytes come from, `sha256` is the hex digest the fetched
 * bytes must match, and `out` is the package-relative path the verified
 * bytes are written to. The declaration is the whole input contract, so the
 * target is a `build` producer: another target names it in `data` and the
 * file materializes before that consumer dispatches.
 *
 * The constructor validates attrs by schema and declares `out` as the
 * target's output tree. PACKAGE.ts execution is supplied by build-cli's
 * package executor; the declaration-time Flow implementation stays a typed
 * {@link Target.notImplemented} refusal rather than duplicating host access
 * in a declaration constructor.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Target from "./Target.ts"

/** A lowercase hex sha256 digest. */
const hexDigest = /^[0-9a-f]{64}$/

/** An absolute http or https URL with no whitespace. */
const httpUrl = /^https?:\/\/\S+$/

/**
 * Attrs for {@link Fetch}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FetchAttrs = Schema.Struct({
  url: Schema.NonEmptyString.check(Schema.isPattern(httpUrl)),
  sha256: Schema.NonEmptyString.check(Schema.isPattern(hexDigest)),
  out: Schema.NonEmptyString
})

/**
 * Attrs for {@link Fetch}.
 *
 * @category models
 * @since 0.1.0
 */
export type FetchAttrs = typeof FetchAttrs.Type

/**
 * The target id every {@link Fetch} target reports as `Target.Metadata.target`.
 *
 * @category constants
 * @since 0.1.0
 */
export const ruleId = "Fetch"

const fetchDefinition = Target.make(ruleId, {
  attrs: FetchAttrs,
  kinds: ["build"],
  // The declared output tree: the one file the verified bytes land in.
  // Declaring it here keeps `out` under the shared output-path law (relative,
  // inside the workspace, outside the cache and .git) at construction time.
  outputs: (attrs) => ({ cwd: ".", paths: [attrs.out] }),
  implementation: () => Target.notImplemented(ruleId)
})

/**
 * A remote file pinned by sha256 and written to `out`.
 *
 * @category targets
 * @since 0.1.0
 */
export const Fetch = Target.guard(fetchDefinition, (attrs) => {
  if (typeof attrs !== "object" || attrs === null) throw new TypeError("Fetch attrs must be an object")
})

/**
 * Checks whether a value is a {@link Fetch} target.
 *
 * @category guards
 * @since 0.1.0
 */
export const isFetch = (value: unknown): value is Target.AnyTarget =>
  Target.isTarget(value) && Target.metadata(value).target === ruleId

/**
 * The validated attrs of one `Fetch` target.
 *
 * @category accessors
 * @since 0.1.0
 */
export const fetchAttrsOf = (target: Target.AnyTarget): FetchAttrs => {
  const metadata = Target.metadata(target)
  if (metadata.target !== ruleId) {
    throw new TypeError(`expected a Fetch target, received ${metadata.target}`)
  }
  return metadata.attrs as FetchAttrs
}
