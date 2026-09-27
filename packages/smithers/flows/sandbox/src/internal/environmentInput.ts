/**
 * Carries environment operands before the command's stdin.
 *
 * @since 0.1.0
 */

import * as Stream from "effect/Stream"
import { encodeBase64 } from "./base64.ts"

const encoder = new TextEncoder()

/**
 * Reads exactly one line with the shell builtin so binary stdin remains untouched.
 * Operands must already be shell-quoted. The decoded operands set positional
 * parameters in the guest shell; their values never appear in local argv.
 * The temporary variable lives in a subshell, preserving inherited variables
 * even when the guest environment contains that same name.
 *
 * @category constructors
 * @since 0.1.0
 */
export const environmentInput = (operands: ReadonlyArray<string>, stdin: Uint8Array | undefined) => ({
  script: operands.length === 0
    ? ""
    : `eval "$(IFS= read -r smthrs_env && smthrs_env=$(printf %s "$smthrs_env" | base64 -d) && printf 'set -- %s' "$smthrs_env" || printf 'exit 125')" || exit 125; `,
  prefix: operands.length === 0 ? "" : `env "$@" `,
  stdin: operands.length === 0
    ? stdin === undefined ? undefined : Stream.make(stdin)
    : Stream.make(
      encoder.encode(`${encodeBase64(encoder.encode(operands.join(" ")))}\n`),
      ...stdin === undefined ? [] : [stdin]
    )
})
