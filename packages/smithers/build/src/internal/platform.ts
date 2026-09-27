/**
 * The one validator for a caller-supplied `Runtime.Platform`.
 *
 * Runtime options, package-manager options, and store-manifest construction
 * each take a platform from a caller and each used to check it with a copy of
 * the same rules. The copies had already drifted: the manifest copy admitted a
 * NUL that both service constructors refused, and JSON serialization then
 * preserved it into the store's identity. Sharing `Platform` across the three
 * seams is deliberate, so its validation contract lives here once and each
 * construction path calls it.
 *
 * Nothing here is reachable from outside the package: the export map maps
 * `./internal/*` to `null`.
 *
 * @since 0.1.0
 */

import * as Validate from "./validate.ts"

/** Longest `os`, `arch`, or `libc` member admitted, in UTF-8 bytes. */
const maximumMemberBytes = 256

/**
 * Validates and freezes a platform read from a caller.
 *
 * `what` names the seam in every error, so a refusal reads the same way each
 * seam's other refusals do. Members are read as own data properties only:
 * an accessor or a proxy is refused before it runs.
 *
 * @private
 * @since 0.1.0
 */
export const normalizePlatform = (
  value: unknown,
  what: string
): { readonly os: string; readonly arch: string; readonly libc: string | null } => {
  const record = Validate.plainRecord(value, what)
  Validate.exactKeys(record, new Set(["os", "arch", "libc"]), what)
  const os = Validate.ownData(record, "os", what)
  const arch = Validate.ownData(record, "arch", what)
  const libc = Validate.ownData(record, "libc", what)
  if (!Validate.usableText(os, maximumMemberBytes) || !Validate.usableText(arch, maximumMemberBytes)) {
    throw new TypeError(`${what} os and arch must be non-empty usable text no longer than ${maximumMemberBytes} bytes`)
  }
  if (libc !== null && !Validate.usableText(libc, maximumMemberBytes)) {
    throw new TypeError(
      `${what} libc must be non-empty usable text no longer than ${maximumMemberBytes} bytes, or null`
    )
  }
  return Object.freeze({ os, arch, libc })
}
