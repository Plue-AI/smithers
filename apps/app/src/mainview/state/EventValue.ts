import { Data } from "effect"
/** JSON plus explicit field clears. JSON.stringify alone loses patch semantics. */
export type EventJson = null | boolean | number | string | ReadonlyArray<EventJson> | { readonly [key: string]: EventJson }
export type EventValuePath = ReadonlyArray<string | number>
export interface EncodedEventValue {
  readonly value: EventJson
  readonly undefinedPaths: ReadonlyArray<EventValuePath>
}

export class InvalidEventValueError extends Data.TaggedError("InvalidEventValueError")<{
  readonly reason: "unsupported-value" | "invalid-clear-path"
  readonly message: string
}> {
  constructor(reason: "unsupported-value" | "invalid-clear-path") {
    // Values can contain private documents. Errors identify the contract, never its payload.
    super({ reason, message: `The app event contains ${reason === "unsupported-value" ? "an unsupported value" : "an invalid field-clear path"}.` })
  }
}

const unsupported = (): never => { throw new InvalidEventValueError("unsupported-value") }
const invalidPath = (): never => { throw new InvalidEventValueError("invalid-clear-path") }

/** Own data properties only: encoding must not execute an accessor or toJSON. */
export const encodeEventValue = (input: unknown): EncodedEventValue => {
  const undefinedPaths: Array<EventValuePath> = []
  const ancestors = new Set<object>()
  const visit = (value: unknown, path: Array<string | number>): EventJson => {
    if (value === undefined) {
      undefinedPaths.push([...path])
      return null
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? value : unsupported()
    if (typeof value !== "object" || ancestors.has(value)) return unsupported()
    const array = Array.isArray(value)
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return unsupported()
    ancestors.add(value)
    try {
      const keys = Reflect.ownKeys(value)
      if (array && keys.length !== value.length + 1) return unsupported()
      const entries: Array<[string, EventJson]> = []
      for (const key of keys) {
        if (array && key === "length") continue
        const property = Object.getOwnPropertyDescriptor(value, key)!
        if (typeof key !== "string" || !property.enumerable || !("value" in property)) return unsupported()
        path.push(array ? Number(key) : key)
        const item = visit(property.value, path)
        path.pop()
        entries.push([key, item])
      }
      if (array) {
        if (entries.some(([key], index) => key !== String(index))) return unsupported()
        return entries.map(([, item]) => item)
      }
      return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    } finally {
      ancestors.delete(value)
    }
  }
  const value = visit(input, [])
  // Clear ordering is part of the wire normal form, independent of input key insertion order.
  undefinedPaths.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)
  return { value, undefinedPaths }
}

/** Decode a detached value and reject ambiguous, duplicate or inherited paths. */
export const decodeEventValue = (encoded: EncodedEventValue): unknown => {
  const normalized = encodeEventValue(encoded.value)
  if (normalized.undefinedPaths.length !== 0 || !Array.isArray(encoded.undefinedPaths)) return unsupported()
  let value: unknown = normalized.value
  const seen = new Set<string>()
  for (const path of encoded.undefinedPaths) {
    if (!Array.isArray(path)) return invalidPath()
    const key = JSON.stringify(path)
    if (seen.has(key)) return invalidPath()
    seen.add(key)
    if (path.length === 0) {
      if (value !== null || encoded.undefinedPaths.length !== 1) return invalidPath()
      value = undefined
      continue
    }
    let parent: unknown = value
    for (let index = 0; index < path.length; index += 1) {
      const part = path[index]!
      if (typeof parent !== "object" || parent === null) return invalidPath()
      if (Array.isArray(parent) ? typeof part !== "number" || !Number.isSafeInteger(part) || part < 0 || part >= parent.length : typeof part !== "string") return invalidPath()
      if (!Object.hasOwn(parent, part)) return invalidPath()
      const property = Object.getOwnPropertyDescriptor(parent, part)!
      if (index + 1 === path.length) {
        if (property.value !== null) return invalidPath()
        Object.defineProperty(parent, part, { value: undefined, writable: true, enumerable: true, configurable: true })
      } else parent = property.value
    }
  }
  return value
}

/** Canonical, lossless bytes used by journal integrity and state verification. */
export const canonicalEventValue = (value: unknown): string => JSON.stringify(encodeEventValue(value))

/**
 * Canonical stored-row bytes without allocating a JSON round-trip tree. Optional
 * object fields disappear and undefined array entries become null, exactly as
 * the materialized JSON row contract requires. Every invocation inspects the
 * current own data properties; mutable row identities are never trusted.
 */
export const canonicalStoredJsonValue = (input: unknown): string => {
  const ancestors = new Set<object>()
  const visit = (value: unknown): EventJson => {
    if (value === undefined) return null
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? value : unsupported()
    if (typeof value !== "object" || ancestors.has(value)) return unsupported()
    const array = Array.isArray(value)
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return unsupported()
    ancestors.add(value)
    try {
      const keys = Reflect.ownKeys(value)
      if (array && keys.length !== value.length + 1) return unsupported()
      const entries: Array<[string, EventJson]> = []
      for (const key of keys) {
        if (array && key === "length") continue
        const property = Object.getOwnPropertyDescriptor(value, key)!
        if (typeof key !== "string" || !property.enumerable || !("value" in property)) return unsupported()
        if (array || property.value !== undefined) entries.push([key, visit(property.value)])
      }
      if (array) {
        if (entries.some(([key], index) => key !== String(index))) return unsupported()
        return entries.map(([, item]) => item)
      }
      return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    } finally { ancestors.delete(value) }
  }
  if (input === undefined) return unsupported()
  return JSON.stringify(visit(input))
}
