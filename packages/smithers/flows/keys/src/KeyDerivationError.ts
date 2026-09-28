// Deep reviewed and polished by a human on 2026-08-31.

/**
 * The typed failure key derivation reports, and its stable codes.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Stable failure codes returned by `deriveKey`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const KeyDerivationErrorCode = Schema.Literals([
  "canonicalization_failed",
  "digest_failed"
])

/**
 * Stable failure codes returned by `deriveKey`.
 *
 * @category models
 * @since 1.0.0
 */
export type KeyDerivationErrorCode = typeof KeyDerivationErrorCode.Type

/**
 * A safe, typed failure from canonicalization or injected hashing.
 *
 * `message` never contains the input. `cause` retains the original schema or
 * crypto failure for in-process diagnostics. It is a non-enumerable runtime
 * property, not a schema field, so encoding the error for a journal or an API
 * carries only `_tag`, `code`, and `message`: a canonicalization cause can
 * name property paths and repeat a throwing getter's message.
 *
 * @category errors
 * @since 1.0.0
 */
export class KeyDerivationError extends Schema.TaggedError<KeyDerivationError>()(
  "@smthrs/keys/KeyDerivationError",
  {
    code: KeyDerivationErrorCode,
    message: Schema.String
  }
) {
  constructor(
    props: { readonly code: KeyDerivationErrorCode; readonly message: string; readonly cause?: unknown },
    options?: Schema.MakeOptions
  ) {
    super({ code: props.code, message: props.message }, options)
    Object.defineProperty(this, "cause", { value: props.cause, configurable: true, writable: true })
  }
}
