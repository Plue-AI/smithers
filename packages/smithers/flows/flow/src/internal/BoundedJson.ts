/**
 * Human-task diagnostics over the shared inert JSON boundary.
 * @since 1.0.0
 */

import * as BoundedJson from "@smthrs/canonical/BoundedJson"

/** Resource limits for one human-task value.
 * @private
 * @since 1.0.0
 */
export type Limits = Required<Omit<BoundedJson.Limits, "maxTotalMembers">>

/** Encoded JSON bytes, without allocating an encoded copy.
 * @private
 * @since 1.0.0
 */
export const encodedStringBytes = BoundedJson.encodedStringBytes

/** Whether text is well-formed and fits its encoded byte budget.
 * @private
 * @since 1.0.0
 */
export const textFits = (value: string, maximum: number): boolean => encodedStringBytes(value, maximum) !== undefined

/** Admits a detached snapshot and gives failures a bounded field path.
 * @private
 * @since 1.0.0
 */
export const admit = (input: unknown, limits: Limits) => {
  const result = BoundedJson.admit(input, limits)
  if (result.ok) return { ok: true as const, value: result.value }
  const at = result.path.length === 0
    ? "the value"
    : `"${result.path.map((segment) => scalarPrefix(segment, 64)).join(".")}"`
  const complaint = result.code === "string"
    ? `is not well-formed text within ${limits.maxStringBytes} encoded bytes`
    : result.code === "nodes"
    ? `makes the value too large to check: it contains more than ${limits.maxNodes} JSON values`
    : result.complaint
  return { ok: false as const, complaint: `${at} ${complaint}.` }
}

/**
 * Returns a Unicode-scalar-safe bounded prefix.
 *
 * @private
 * @since 1.0.0
 */
export function scalarPrefix(value: string, maximumCodeUnits: number): string {
  let output = ""
  for (let index = 0; index < value.length;) {
    const unit = value.charCodeAt(index)
    let next: string
    let width = 1
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        next = value.slice(index, index + 2)
        width = 2
      } else {
        next = "\ufffd"
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      next = "\ufffd"
    } else {
      next = value[index]!
    }
    if (output.length + next.length > maximumCodeUnits) break
    output += next
    index += width
  }
  return output
}

/**
 * Renders an untrusted value without invoking its code or allocating from its full size.
 *
 * @private
 * @since 1.0.0
 */
export const render = (value: unknown, maximumCodeUnits: number): string => {
  if (typeof value === "string") {
    const prefix = scalarPrefix(value, Math.max(0, maximumCodeUnits - 2))
    const quoted = JSON.stringify(prefix)
    return prefix.length < value.length
      ? `${quoted} [${value.length - prefix.length} characters dropped]`
      : quoted
  }
  if (typeof value === "bigint") return scalarPrefix(`${value}n`, maximumCodeUnits)
  if (typeof value === "symbol") return "[symbol]"
  if (typeof value === "function") return "[function]"
  if (value === undefined) return "[undefined]"

  const admitted = admit(value, {
    maxNodes: 64,
    maxDepth: 6,
    maxBytes: Math.max(64, maximumCodeUnits * 4),
    maxStringBytes: Math.max(64, maximumCodeUnits * 4),
    maxKeyBytes: Math.max(32, maximumCodeUnits * 2),
    maxMembers: 32
  })
  if (!admitted.ok) return scalarPrefix(`[${admitted.complaint}]`, maximumCodeUnits)
  const rendered = JSON.stringify(admitted.value)
  const prefix = scalarPrefix(rendered, maximumCodeUnits)
  return prefix.length < rendered.length
    ? `${prefix} [${rendered.length - prefix.length} characters dropped]`
    : prefix
}
