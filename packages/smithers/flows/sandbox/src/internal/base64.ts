/**
 * Byte-faithful base64 for transports that can only carry text.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Result from "effect/Result"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/**
 * Encodes bytes as base64 text.
 *
 * Most vendor sandbox APIs move files as strings, and a machine that cannot
 * move bytes cannot move a tarball, an image, or a compiled binary. Rather
 * than let each provider decide what to do about that, they all route the
 * byte path through this pair, so "the session promises bytes" stays true
 * whatever the transport underneath is willing to carry.
 *
 * The transform itself is `effect/Encoding`, which the workspace already uses
 * for exactly this job in `@smthrs/kernel`. The pair here exists for the
 * provider-shaped error surface and the wrapped-payload tolerance below, not
 * for a second base64 implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const encodeBase64 = (content: Uint8Array): string => Encoding.encodeBase64(content)

/**
 * Encodes bytes as base64 and returns the text as bytes, ready to be written
 * to a guest command's standard input.
 *
 * @category constructors
 * @since 0.1.0
 */
export const encodeBase64Bytes = (content: Uint8Array): Uint8Array => encoder.encode(encodeBase64(content))

/**
 * Decodes base64 text back to bytes, failing with the provider vocabulary
 * rather than throwing.
 *
 * Whitespace is stripped first because guest tools line-wrap their base64
 * output at various widths, and a decoder refuses a wrapped payload.
 *
 * @category constructors
 * @since 0.1.0
 */
export const decodeBase64 = (
  encoded: string,
  what: string
): Effect.Effect<Uint8Array, ProviderError> =>
  Effect.suspend(() => {
    const decoded = Encoding.decodeBase64(encoded.replaceAll(/\s/g, ""))
    return Result.isFailure(decoded)
      ? Effect.fail(
        new ProviderError({
          code: "unknown",
          message: `the sandbox returned invalid base64 ${what}`,
          cause: decoded.failure
        })
      )
      : Effect.succeed(decoded.success)
  })

/**
 * Decodes base64 that arrived as bytes rather than text.
 *
 * @category constructors
 * @since 0.1.0
 */
export const decodeBase64Bytes = (
  encoded: Uint8Array,
  what: string
): Effect.Effect<Uint8Array, ProviderError> => decodeBase64(decoder.decode(encoded), what)
