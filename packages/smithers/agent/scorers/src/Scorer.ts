/**
 * Flow-native scorer declarations and result validation.
 *
 * A scorer is a *declaration-only* flow: it carries the input and output
 * schemas so a caller can read its contract, and its execution entry point is
 * {@link Scorer.score}, never a flow body. {@link MakeOptions} therefore omits
 * `body`, `model`, and `flows` as well as `input` and `output`, so a scorer
 * cannot declare two implementations that disagree.
 *
 * Package documentation: `packages/smithers/agent/scorers/docs/api.md`.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Json from "./internal/json.ts"
import { ScorerError } from "./ScorerError.ts"

/**
 * Input supplied to a scorer flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  input: Schema.Unknown,
  output: Schema.Unknown,
  groundTruth: Schema.optionalKey(Schema.Unknown),
  context: Schema.optionalKey(Schema.Unknown),
  latencyMs: Schema.optionalKey(Schema.Finite)
})

/**
 * Input supplied to a scorer flow.
 *
 * @category models
 * @since 0.1.0
 */
export type Input = typeof Input.Type

/**
 * Successful scorer output.
 *
 * The inclusive `[0, 1]` range lives in the schema, so the declared flow output
 * and {@link validate} enforce one contract. They used to disagree: the schema
 * accepted any finite score while `validate` rejected anything outside the
 * range, so ordinary flow output validation and runner validation gave
 * different answers for the same declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Result = Schema.Struct({
  score: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  reason: Schema.optionalKey(Schema.String),
  meta: Schema.optionalKey(Schema.Unknown)
})

/**
 * Successful scorer output.
 *
 * @category models
 * @since 0.1.0
 */
export type Result = typeof Result.Type

/**
 * A scorer is an ordinary flow with an independent declaration identity.
 *
 * @category models
 * @since 0.1.0
 */
export interface Scorer<E = never> extends Flow.Flow<typeof Input, typeof Result> {
  readonly scorerKey: string
  readonly score: (input: Input) => Effect.Effect<Result, E | ScorerError>
}

/**
 * Options accepted by {@link make}.
 *
 * `input` and `output` are owned by this module. `body`, `model`, and `flows`
 * are omitted and rejected at runtime so `score` is the single implementation.
 *
 * @category models
 * @since 0.1.0
 */
export type MakeOptions<E = never> =
  & Omit<
    Parameters<typeof Flow.make<typeof Input, typeof Result>>[0],
    "input" | "output" | "body" | "model" | "flows"
  >
  & {
    /** Stable module-owned scorer identity. */
    readonly id: string
    /** Stable scorer contract/configuration version. */
    readonly version: string
    /** Canonical, inert configuration that changes scoring semantics. */
    readonly config?: unknown
    readonly score: (input: Input) => Effect.Effect<Result, E | ScorerError>
  }

const declaration = (message: string, cause?: unknown): ScorerError =>
  new ScorerError({
    code: "invalid_declaration",
    message,
    ...(cause === undefined ? {} : { cause })
  })

/**
 * Declares a scorer flow and derives its scorer key from its own declaration.
 *
 * This is a plan-time constructor and it *throws*, because a bad declaration is
 * a programming error with no run to fail. Every throw is a `ScorerError` with
 * code `invalid_declaration`: a `body`, `model`, or `flows` option (even if
 * `undefined`), a non-string or blank `id` or `version`, a
 * `config` carrying a member canonical JSON would drop, a `config` nested more
 * than 1,000 levels, a non-enumerable property, or a `toJSON` member, and a
 * `config` the canonical encoder refuses outright. These cases are rejected
 * because `scorerKey` is the durable identity written into every stored
 * observation: two configurations differing only in lost data would otherwise
 * be one scorer forever. Calling `toJSON` here to inspect its replacement would
 * execute caller code a second time with no promise that both calls agree.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <E = never>(options: MakeOptions<E>): Scorer<E> => {
  for (const key of ["body", "model", "flows"] as const) {
    if (key in options) {
      throw declaration(`A scorer must not declare ${key}; use score as its only implementation`)
    }
  }
  const { config, id, score, version, ...rest } = options
  if (typeof id !== "string") throw declaration("A scorer id must be a string")
  if (typeof version !== "string") throw declaration("A scorer version must be a string")
  if (id.trim().length === 0) throw declaration("A scorer id must not be empty")
  if (version.trim().length === 0) throw declaration("A scorer version must not be empty")
  let lossy: string | undefined
  try {
    lossy = config === undefined ? undefined : Json.lossyPath(config, "config")
  } catch (cause) {
    throw declaration("A scorer configuration could not be inspected", cause)
  }
  if (lossy !== undefined) {
    throw declaration(`A scorer configuration must be representable as canonical JSON: ${lossy}`)
  }
  let scorerKey: string
  try {
    scorerKey = Digest.digest(Digest.canonical({ id, version, config: config ?? null }))
  } catch (cause) {
    throw declaration("A scorer configuration could not be canonicalized", cause)
  }
  // A scorer that named nothing is declared under its own `id`. A flow needs a
  // name to be addressed by, `id` is already the stable module-owned identity
  // this scorer is known by, and an anonymous declaration would otherwise have
  // to be given one somewhere that does not know what the scorer is.
  const flow = Flow.make({ ...rest, name: rest.name ?? id, input: Input, output: Result })
  return Object.assign(flow, { scorerKey, score })
}

const decodeResult = Schema.decodeUnknownSync(Result)

const receivedScore = (value: unknown): string => {
  try {
    return typeof value === "object" && value !== null && "score" in value
      ? `, received ${String((value as { readonly score: unknown }).score)}`
      : ""
  } catch {
    return ""
  }
}

/**
 * Decodes a scorer result against {@link Result}.
 *
 * The failure names the offending score and carries the schema issue, which
 * reports the failing path, as its cause. It never retains the whole result:
 * a scorer result can hold a model response body.
 *
 * @category validation
 * @since 0.1.0
 */
export const validate = (value: unknown): Effect.Effect<Result, ScorerError> =>
  Effect.try({
    try: () => decodeResult(value),
    catch: (cause) =>
      new ScorerError({
        code: "invalid_score",
        message: `A scorer result must carry a finite score in [0, 1]${receivedScore(value)}`,
        cause
      })
  })
