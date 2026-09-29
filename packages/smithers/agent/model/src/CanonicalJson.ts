/**
 * Deterministic JSON encoding for model-step inputs.
 *
 * @since 0.1.0
 */

const encoder = new TextEncoder()

const invalid = (path: string): never => {
  throw new TypeError(`Value at ${path} is not valid JSON`)
}

const canonicalize = (value: unknown, path = "$", ancestors = new Set<object>()): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : invalid(path)
  }
  if (Array.isArray(value)) {
    // A subclass may override `toJSON` or `Symbol.species`, so only plain arrays pass.
    if (Object.getPrototypeOf(value) !== Array.prototype) return invalid(path)
    if (ancestors.has(value)) return invalid(path)
    // `JSON.stringify` writes a hole as `null` and drops every non-index
    // member, so such an array would key differently from the body sent.
    if (Object.getOwnPropertySymbols(value).length > 0) return invalid(path)
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) return invalid(`${path}[${index}]`)
    }
    // Every index plus `length`; anything more is a named member.
    if (Object.getOwnPropertyNames(value).length !== value.length + 1) return invalid(path)
    ancestors.add(value)
    const result: Array<unknown> = []
    for (let index = 0; index < value.length; index++) {
      result.push(canonicalize(value[index], `${path}[${index}]`, ancestors))
    }
    ancestors.delete(value)
    return result
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return invalid(path)
    if (ancestors.has(value)) return invalid(path)
    if (Object.getOwnPropertySymbols(value).length > 0) return invalid(path)
    ancestors.add(value)
    // A null-prototype accumulator, not `{}`: an own member literally named
    // `__proto__` (which `JSON.parse` produces, and which a tool's JSON Schema
    // may legitimately declare as a property) would otherwise reach
    // `Object.prototype`'s setter and vanish from the encoding, so the bytes a
    // sealed step keys on would not be the bytes sent to the provider.
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key]
      result[key] = canonicalize(member, `${path}.${key}`, ancestors)
    }
    ancestors.delete(value)
    return result
  }
  return invalid(path)
}

/**
 * Serializes a JSON value with recursively sorted object keys. Array order is
 * retained. Non-JSON values are rejected instead of being silently coerced or
 * omitted by `JSON.stringify`.
 *
 * This is deliberately stricter than `@smthrs/canonical`, which mirrors
 * `JSON.stringify` exactly. A model request body is sealed-step key material:
 * a value `JSON.stringify` would drop (`undefined`, a function) or reshape
 * (`toJSON`, a `Date`, a `Map`) means the key and the wire body describe
 * different requests, so it is rejected here rather than encoded. Everything
 * both encoders accept they encode identically, including an own member named
 * `__proto__`.
 *
 * @category encoding
 * @since 0.1.0
 * @slop
 */
export const stringify = (value: unknown): string => JSON.stringify(canonicalize(value))

/**
 * Encodes the canonical JSON representation as UTF-8 bytes.
 *
 * @category encoding
 * @since 0.1.0
 * @slop
 */
export const bytes = (value: unknown): Uint8Array => encoder.encode(stringify(value))

/**
 * Computes pi's dependency-free, deterministic two-lane short hash. This is
 * copied from pi's historical `packages/ai/src/utils/hash.ts` so synthetic
 * OpenAI tool-search call ids remain stable across transcript replay.
 *
 * @category hashing
 * @since 0.1.0
 * @slop
 */
export const shortHash = (input: string): string => {
  let first = 0xdeadbeef
  let second = 0x41c6ce57
  for (let index = 0; index < input.length; index++) {
    const character = input.charCodeAt(index)
    first = Math.imul(first ^ character, 2654435761)
    second = Math.imul(second ^ character, 1597334677)
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909)
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909)
  return (second >>> 0).toString(36) + (first >>> 0).toString(36)
}
