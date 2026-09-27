// Deep reviewed and polished by a human on 2026-08-10.

/**
 * RFC 8785 canonical JSON: one document, one byte sequence.
 *
 * Everything `flows` digests goes through here first. A step key, a plan
 * digest, and a cache key are all hashes of JSON, so two structurally equal
 * values must serialize identically or the same work would key differently on
 * two hosts — property order, number formatting, and escaping all have to be
 * pinned, and RFC 8785 is the standard that pins them.
 *
 * The schema is a *decode*, not a formatter: it validates the value is
 * representable (no lone surrogates, no non-finite numbers, no cycles) and
 * fails with a schema issue when it is not, rather than emitting something
 * that would hash.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"
import { canonicalize } from "./internal/canonicalize.ts"
import { describe } from "./internal/describe.ts"

/** @private */
const CanonicalString = Schema.String.pipe(
  Schema.brand("@smthrs/canonical/Canonical")
)

/**
 * An RFC 8785 canonical JSON document.
 *
 * Branded, so a string that merely looks like JSON cannot be passed where a
 * canonical document is required — the brand is only obtainable by decoding
 * through {@link Canonical}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Canonical = typeof Canonical.Type

/**
 * Converts a JSON value into an RFC 8785 canonical JSON document.
 *
 * Decoding fails rather than approximates: a value carrying a lone surrogate,
 * a non-finite number, or a cycle has no canonical form, and emitting a
 * best-effort string for it would produce a digest that silently disagrees
 * with another host's. The refusals live in the serializer itself, so they
 * hold for every string it emits — including one a `toJSON` mints during
 * serialization, which no pre-pass over the input value could ever see.
 * Encoding parses the document back into a plain value. The brand is the
 * guarantee of canonical form: a `Canonical` is only minted by decoding, so
 * the typed encode path never sees malformed text. An unknown-string encode
 * (`encodeUnknownEffect`, `encodeUnknownSync`) can, and a string that does
 * not parse fails with a `canonical_malformed` schema issue in the error
 * channel rather than a raw `SyntaxError`.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Canonical = Schema.Unknown.pipe(
  Schema.decodeTo(CanonicalString, {
    decode: SchemaGetter.transformEffect((value, parseOptions) =>
      Effect.try({
        // The serializer refuses every value it cannot emit canonically, so
        // what it returns is a JSON document by construction; parsing it back
        // would cost a full pass per digest and could refuse nothing.
        try: () => canonicalize(value),
        catch: (cause) =>
          new SchemaIssue.InvalidValue(
            { message: describe(cause) },
            value,
            parseOptions
          )
      })
    ),
    encode: SchemaGetter.transformEffect((document, parseOptions) =>
      Effect.try({
        try: () => JSON.parse(document) as unknown,
        catch: (cause) =>
          new SchemaIssue.InvalidValue(
            { message: `canonical_malformed: ${describe(cause)}` },
            document,
            parseOptions
          )
      })
    )
  })
)
