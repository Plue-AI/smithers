/**
 * Bounded inert JSON admission for control mutations.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import * as BoundedJson from "@smthrs/canonical/BoundedJson"

/** Limits and diagnostic precedence of the control mutation boundary. */
const limits = {
  maxBytes: 4 * 1024 * 1024,
  maxStringBytes: 4 * 1024 * 1024,
  maxKeyBytes: 4 * 1024 * 1024,
  maxDepth: 128,
  maxNodes: 100_000,
  maxMembers: 100_000,
  maxTotalMembers: 100_000
} satisfies BoundedJson.Limits

/** Result of admitting an unknown mutation value. */
type Result =
  | { readonly ok: true; readonly value: BoundedJson.Json }
  | { readonly ok: false; readonly complaint: string }

/**
 * Copies one mutation without invoking getters or `toJSON`.
 *
 * `bounds` defaults to the control mutation limits. Tests pass smaller ones to
 * reach a byte-exact boundary without building multi-megabyte values.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const admit = (input: unknown, bounds: BoundedJson.Limits = limits): Result => {
  const result = BoundedJson.admit(input, bounds, { preflightObjects: false })
  if (result.ok) return { ok: true, value: result.value }
  const complaint = result.code === "members"
    ? `contains more than ${bounds.maxTotalMembers} JSON members`
    : result.code === "string"
    ? "contains oversized or ill-formed text"
    : result.code === "key"
    ? "contains an oversized or ill-formed object key"
    : result.complaint
  return { ok: false, complaint }
}
