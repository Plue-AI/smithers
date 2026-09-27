// Deep reviewed and polished by a human on 2026-08-31.

/**
 * SHA-256 as an injected capability, with one stable digest representation.
 *
 * Hashing is host access, so the cryptographic operation goes through
 * `effect/Crypto`: a Node process, Bun process, browser, or test supplies the
 * implementation. Text conversion is deliberately narrower. A string must be
 * well-formed UTF-16 and is encoded as UTF-8 with the standard `TextEncoder`
 * available in every supported Smithers runtime. No Unicode normalization is
 * performed.
 *
 * `digest` copies byte input when its Effect begins; `digestSync` copies during
 * the call. The injected host therefore receives a snapshot instead of the
 * caller's mutable array. Host output is also copied before conversion to the
 * one accepted wire form: 64 lowercase hexadecimal characters.
 *
 * @since 0.1.0
 */

import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaParser from "effect/SchemaParser"
import { sha256, Sha256Prefix } from "./internal/sha256.ts"

const digestBytes = 32
const digestPattern = /^[0-9a-f]{64}$/
const hex = "0123456789abcdef"
const encoder = new TextEncoder()

/**
 * Schema for exactly 64 lowercase hexadecimal SHA-256 characters.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Digest = Schema.String.check(
  Schema.isPattern(digestPattern, {
    expected: "a 64-character lowercase hexadecimal SHA-256 digest"
  })
).pipe(Schema.brand("@smthrs/crypto/Sha256/Digest"))

/**
 * A validated lowercase hexadecimal SHA-256 digest.
 *
 * @category models
 * @since 0.1.0
 */
export type Digest = typeof Digest.Type

/**
 * Stable failure codes returned by {@link digest}.
 *
 * A missing `Crypto` service is intentionally not a member: it remains an
 * unsatisfied Effect context requirement and therefore a configuration defect,
 * distinct from a provided host failing an operation.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Sha256ErrorCode = Schema.Literals([
  "invalid_input",
  "invalid_text",
  "text_encoding_failed",
  "digest_failed",
  "invalid_digest"
])

/**
 * Stable failure codes returned by {@link digest}.
 *
 * @category models
 * @since 1.0.0
 */
export type Sha256ErrorCode = typeof Sha256ErrorCode.Type

/**
 * A typed SHA-256 boundary failure.
 *
 * `code` is stable for control flow. `message` is safe to report and never
 * contains the hashed input. `cause` preserves the original text-encoding or
 * injected-host failure for diagnostics.
 *
 * @category errors
 * @since 1.0.0
 */
export class Sha256Error extends Schema.TaggedError<Sha256Error>()(
  "@smthrs/crypto/Sha256Error",
  {
    code: Sha256ErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

const failure = (
  code: Sha256ErrorCode,
  message: string,
  cause?: unknown
): Sha256Error =>
  new Sha256Error({
    code,
    message,
    ...(cause === undefined ? {} : { cause })
  })

/** Whether UTF-8 can represent a JavaScript string without replacement. */
const isWellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

/** Copies an input and performs strict UTF-8 encoding. */
const snapshotSync = (input: string | Uint8Array): Uint8Array => {
  if (typeof input === "string") {
    if (!isWellFormed(input)) {
      throw failure(
        "invalid_text",
        "SHA-256 text input contains an unpaired UTF-16 surrogate"
      )
    }
    try {
      return encoder.encode(input)
    } catch (cause) {
      throw failure(
        "text_encoding_failed",
        "SHA-256 text input could not be encoded as UTF-8",
        cause
      )
    }
  }
  if (input instanceof Uint8Array) {
    try {
      return new Uint8Array(input)
    } catch (cause) {
      throw failure(
        "invalid_input",
        "SHA-256 byte input could not be copied",
        cause
      )
    }
  }
  throw failure(
    "invalid_input",
    "SHA-256 input must be a string or Uint8Array"
  )
}

/** Copies the input when an Effect starts, not when it is constructed. */
const snapshot = (input: string | Uint8Array): Effect.Effect<Uint8Array, Sha256Error> =>
  Effect.try({
    try: () => snapshotSync(input),
    // Every throw site in snapshotSync is normalized before it escapes.
    catch: (cause) => cause as Sha256Error
  })

const encodeHex = (bytes: Uint8Array): string => {
  let output = ""
  for (const byte of bytes) output += `${hex[byte >>> 4]}${hex[byte & 0x0f]}`
  return output
}

const hostFailure = (cause: unknown): Sha256Error =>
  failure(
    "digest_failed",
    "The injected Crypto service failed to compute SHA-256",
    cause
  )

/**
 * Hashes well-formed UTF-8 text or bytes synchronously.
 *
 * This is the explicit pure-computation entry point for synchronous plan and
 * identity construction. It uses the package-owned FIPS 180-4 implementation,
 * the same input policy and the same {@link Digest} representation as
 * {@link digest}. It throws {@link Sha256Error} for invalid input or text.
 *
 * @category hashing
 * @since 1.0.0
 */
export const digestSync = (input: string | Uint8Array): Digest => encodeHex(sha256(snapshotSync(input))) as Digest

/**
 * A synchronous, SHA-256-only Effect `Crypto` service.
 *
 * This adapter exists for synchronous code that already consumes an Effect
 * `Crypto` service. It snapshots byte input, rejects every other digest
 * algorithm, and deliberately refuses randomness. Normal application code
 * should supply its platform Crypto layer instead.
 *
 * @category services
 * @since 1.0.0
 */
export const syncCrypto: Crypto.Crypto = Crypto.make({
  randomBytes: () => {
    throw new Error("@smthrs/crypto syncCrypto provides SHA-256 only; supply a platform Crypto layer for randomness")
  },
  digest: (algorithm, input) =>
    algorithm === "SHA-256"
      ? Effect.try({
        try: () => sha256(new Uint8Array(input)),
        catch: (cause) =>
          PlatformError.badArgument({
            module: "@smthrs/crypto",
            method: "digest",
            description: "syncCrypto could not snapshot SHA-256 input",
            cause
          })
      })
      : Effect.fail(PlatformError.badArgument({
        module: "@smthrs/crypto",
        method: "digest",
        description: `syncCrypto supports only SHA-256, not ${algorithm}`
      }))
})

/**
 * Hashes well-formed UTF-8 text or a byte-array snapshot with injected Crypto.
 *
 * The returned Effect requires `Crypto.Crypto`. A missing service is an Effect
 * configuration defect. Invalid input, text-encoding failures, provided-host
 * failures, and malformed host output fail with {@link Sha256Error}. The host
 * must return exactly 32 bytes.
 *
 * @category hashing
 * @since 1.0.0
 */
export const digest = (input: string | Uint8Array): Effect.Effect<Digest, Sha256Error, Crypto.Crypto> =>
  Effect.gen(function*() {
    const bytes = yield* snapshot(input)
    const crypto = yield* Crypto.Crypto
    const operation = (yield* Effect.try({
      try: () => crypto.digest("SHA-256", bytes),
      catch: hostFailure
    })) as unknown
    if (!Effect.isEffect(operation)) {
      return yield* Effect.fail(failure(
        "digest_failed",
        "The injected Crypto service returned a non-Effect SHA-256 operation"
      ))
    }
    const hostDigest: unknown = yield* operation.pipe(
      Effect.mapError(hostFailure),
      Effect.catchDefect((cause) => Effect.fail(hostFailure(cause)))
    )
    if (!(hostDigest instanceof Uint8Array)) {
      return yield* Effect.fail(failure(
        "invalid_digest",
        "The injected Crypto service returned a non-Uint8Array SHA-256 digest"
      ))
    }
    const output = yield* Effect.try({
      try: () => new Uint8Array(hostDigest),
      catch: (cause) =>
        failure(
          "invalid_digest",
          "The injected Crypto service returned SHA-256 bytes that could not be copied",
          cause
        )
    })
    if (output.byteLength !== digestBytes) {
      return yield* Effect.fail(failure(
        "invalid_digest",
        `The injected Crypto service returned ${output.byteLength} SHA-256 bytes; expected ${digestBytes}`
      ))
    }

    // Length is fixed above and encodeHex emits only lowercase hex, so this is
    // exactly the branded representation accepted by Digest.
    return encodeHex(output) as Digest
  })

const schemaIssue = (error: Sha256Error): SchemaIssue.InvalidValue =>
  new SchemaIssue.InvalidValue({
    message: `[${error.code}] ${error.message}`,
    code: error.code,
    cause: error
  })

const Sha256Transformation = Schema.Union([Schema.String, Schema.Uint8Array]).pipe(
  Schema.decodeTo(Digest, {
    decode: SchemaGetter.transformEffect((input) => digest(input).pipe(Effect.mapError(schemaIssue))),
    encode: SchemaGetter.forbidden(() => "A digest cannot be converted back into its source bytes")
  })
)

// Own the parsing boundary: annotations do not override parser options. The
// declaration also forwards encoding through the reversed parameter codec, so
// the one-way transformation stays forbidden without retaining its input.
const Sha256Schema = Schema.declareConstructor<Digest, string | Uint8Array>()(
  [Sha256Transformation],
  ([codec]) => (input, _ast, options) =>
    SchemaParser.decodeUnknownEffect(codec)(input, { ...options, reportInput: false }),
  { identifier: "@smthrs/crypto/Sha256" }
)

/**
 * One-way schema transformation from text or bytes to {@link Digest}.
 *
 * This is the schema-composition face of {@link digest}. Operational failures
 * become `SchemaError` issues without reported input at this node. Composed
 * schemas must be decoded with `reportInput: false` at the outermost boundary
 * to suppress input capture by enclosing issues, including sibling failures.
 * Issue annotations retain the typed `Sha256Error` as `cause`; host causes and
 * custom schema diagnostics are not sanitized. Encoding is forbidden because
 * a digest cannot reconstruct its source. `Digest` and `digest` remain attached
 * properties for existing consumers; both are also ordinary named exports.
 *
 * @category transformations
 * @since 0.1.0
 */
export const Sha256 = Object.assign(Sha256Schema, { Digest, digest, digestSync })

/**
 * Hash individually well-formed UTF-8 text fragments with bounded prefix reuse.
 * Results equal digestSync(parts.join("")); only the last call's prefixes live.
 *
 * @category hashing
 * @since 1.0.0-rc.0
 */
export const makeDigestPartsSync = (): (parts: ReadonlyArray<string>) => Digest => {
  let previous: ReadonlyArray<string> = [], prefixes: Array<Sha256Prefix> = []
  return (parts) => {
    let same = 0
    while (same < parts.length && same < previous.length && parts[same] === previous[same]) same++
    const state = same ? prefixes[same - 1]!.clone() : new Sha256Prefix()
    const next = prefixes.slice(0, same)
    for (let index = same; index < parts.length; index++) {
      state.update(snapshotSync(parts[index]!))
      next.push(state.clone())
    }
    previous = [...parts]
    prefixes = next
    return encodeHex(state.finish()) as Digest
  }
}
