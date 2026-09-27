/**
 * Replay-stable scorer sampling.
 *
 * A ratio policy decides from the target step key, the scorer key, and the
 * seed alone, so the same step reaches the same decision on every replay and
 * in every process. Two properties make that promise real, and both were once
 * broken here:
 *
 * - The hash runs over UTF-8 *bytes*. Hashing UTF-16 code units through
 *   `charCodeAt(0)` read only the high surrogate of an astral code point, so
 *   every emoji in the same 1024-code-point block hashed identically.
 * - The three components are length-prefixed rather than joined with a
 *   delimiter. `"a:b" + ":" + "c"` and `"a" + ":" + "b:c"` produce the same
 *   `":"`-joined material, so two unrelated steps shared one decision.
 *
 * Both are silent collisions, which is why `test/Sampling.test.ts` freezes
 * golden hash vectors: a change to either rule moves every sampling decision
 * already recorded downstream and has to be a deliberate, noted change.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ScorerError } from "./ScorerError.ts"

/**
 * Sampling policy for a scorer binding.
 *
 * `"all"` and `"none"` are the endpoints; a ratio policy covers the open
 * interval `(0, 1)` only, so "sample everything" and "sample nothing" have
 * exactly one spelling each. The bound lives in the schema, so a policy that
 * `decide` would reject cannot be constructed and carried into a run.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Sampling = Schema.Union([
  Schema.Literals(["all", "none"]),
  Schema.Struct({
    ratio: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThan(1)),
    seed: Schema.String.check(Schema.isMinLength(1))
  })
])

/**
 * Sampling policy for a scorer binding.
 *
 * @category models
 * @since 0.1.0
 */
export type Sampling = typeof Sampling.Type

const encoder = new TextEncoder()

const hash = (text: string): number => {
  let value = 2166136261
  for (const byte of encoder.encode(text)) {
    value ^= byte
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0) / 4294967296
}

/**
 * Length-prefixed, unambiguous encoding of the decision's components.
 *
 * @internal
 */
const material = (parts: ReadonlyArray<string>): string => parts.map((part) => `${part.length}:${part}`).join("")

const received = (sampling: Sampling): string => {
  try {
    return typeof sampling === "object" && sampling !== null && "ratio" in sampling
      ? `, received ratio ${String(sampling.ratio)}`
      : ""
  } catch {
    return ""
  }
}

const invalid = (sampling: Sampling, cause: unknown): ScorerError =>
  new ScorerError({
    code: "invalid_sampling",
    message: `A sampling policy must be "all", "none", or a ratio strictly between 0 and 1 with a non-empty seed${
      received(sampling)
    }`,
    cause
  })

const decodeSampling = Schema.decodeUnknownSync(Sampling)

/**
 * Decides a ratio sample from stable target, scorer, and seed material.
 *
 * @category predicates
 * @since 0.1.0
 */
export const decide = (
  sampling: Sampling,
  targetStepKey: string,
  scorerKey: string
): Effect.Effect<boolean, ScorerError> =>
  Effect.try({ try: () => decodeSampling(sampling), catch: (cause) => invalid(sampling, cause) }).pipe(
    Effect.map((value) =>
      value === "all"
        ? true
        : value === "none"
        ? false
        : hash(material([targetStepKey, scorerKey, value.seed])) < value.ratio
    )
  )
