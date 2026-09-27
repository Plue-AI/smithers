// Deep reviewed and polished by a human on 2026-08-31.

/**
 * Key derivation expressed as a schema transformation.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaParser from "effect/SchemaParser"
import { deriveKey } from "./deriveKey.ts"
import type { KeyDerivationError } from "./KeyDerivationError.ts"
import { KeyV1 } from "./KeyV1.ts"

const schemaIssue = (error: KeyDerivationError): SchemaIssue.InvalidValue =>
  new SchemaIssue.InvalidValue({
    message: `[${error.code}] ${error.message}`,
    code: error.code,
    cause: error
  })

const transformation = Schema.Unknown.pipe(
  Schema.decodeTo(KeyV1, {
    decode: SchemaGetter.transformEffect((input) => deriveKey(input).pipe(Effect.mapError(schemaIssue))),
    encode: SchemaGetter.forbidden(
      () => "A key cannot be converted back into its input"
    )
  })
)

/**
 * Schema that derives a fresh key from its decoded input.
 *
 * This does not parse stored keys: decoding the text `key1_…` derives a new
 * key from that text. Use `StoredKey` to validate persisted or received key
 * values. Prefer {@link deriveKey} when typed operational failures are useful;
 * this schema maps them to redacted schema issues for composition.
 *
 * @category transformations
 * @since 1.0.0
 */
export const DerivedKey = Schema.declareConstructor<typeof KeyV1.Type, unknown>()(
  [transformation],
  // Enclosing schemas still need reportInput: false. This local parser keeps
  // both decoding and forbidden encoding issues from retaining key material.
  ([codec]) => (input, _ast, options) =>
    SchemaParser.decodeUnknownEffect(codec)(input, { ...options, reportInput: false }),
  { identifier: "@smthrs/keys/Key" }
)
