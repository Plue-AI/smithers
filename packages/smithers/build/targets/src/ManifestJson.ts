/**
 * Strict JSON validation for package-manifest values.
 *
 * `package.json` fields originate in executable PACKAGE.ts modules. TypeScript's
 * `unknown` type is not a runtime boundary: a caller can still supply a Proxy,
 * an accessor, a cycle, a bigint, or another value that `JSON.stringify`
 * executes or changes. This module copies exactly the JSON domain without
 * invoking user getters and applies resource ceilings before the value enters
 * target attrs or a generated file.
 *
 * @since 0.1.0
 */

import * as NodeUtil from "node:util/types"

/**
 * A JSON value accepted in a package manifest.
 *
 * @category models
 * @since 0.1.0
 */
export type Value = null | boolean | number | string | ReadonlyArray<Value> | JsonObject

/**
 * A JSON object accepted in a package manifest.
 *
 * @category models
 * @since 0.1.0
 */
export interface JsonObject {
  readonly [key: string]: Value
}

/**
 * Maximum encoded bytes accepted for one complete manifest value.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumBytes = 4 * 1024 * 1024
/**
 * Maximum nesting depth accepted for one manifest value.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumDepth = 128
/**
 * Maximum object members and array elements accepted for one manifest value.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumMembers = 100_000

interface Budget {
  bytes: number
  members: number
}

interface Limits {
  readonly bytes: number
  readonly depth: number
  readonly members: number
}

const defaultLimits: Limits = {
  bytes: maximumBytes,
  depth: maximumDepth,
  members: maximumMembers
}

const step = (path: string, key: string): string => `${path}[${JSON.stringify(key)}]`

const inspect = <A>(path: string, operation: () => A): A => {
  try {
    return operation()
  } catch {
    throw new TypeError(`${path} could not be inspected without executing hostile object behavior`)
  }
}

const encodedStringBytes = (value: string, path: string): number => {
  if (!value.isWellFormed()) throw new TypeError(`${path} contains an unpaired UTF-16 surrogate`)
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

const spend = (budget: Budget, limits: Limits, bytes: number, path: string, member = false): void => {
  budget.bytes += bytes
  if (member) budget.members += 1
  if (budget.bytes > limits.bytes) {
    throw new TypeError(`${path} exceeds the ${limits.bytes}-byte manifest JSON limit`)
  }
  if (budget.members > limits.members) {
    throw new TypeError(`${path} exceeds the ${limits.members}-member manifest JSON limit`)
  }
}

const clone = (
  value: unknown,
  seen: Set<object>,
  budget: Budget,
  limits: Limits,
  path: string,
  depth: number
): Value => {
  if (depth > limits.depth) {
    throw new TypeError(`${path} exceeds the maximum manifest JSON depth of ${limits.depth}`)
  }
  if (value === null) {
    spend(budget, limits, 4, path, true)
    return null
  }
  switch (typeof value) {
    case "boolean":
      spend(budget, limits, value ? 4 : 5, path, true)
      return value
    case "string":
      spend(budget, limits, encodedStringBytes(value, path), path, true)
      return value
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${path} is the non-finite number ${String(value)}`)
      if (Object.is(value, -0)) throw new TypeError(`${path} is negative zero, which JSON would change to zero`)
      spend(budget, limits, String(value).length, path, true)
      return value
    case "undefined":
      throw new TypeError(`${path} is undefined, which JSON would omit or change to null`)
    case "bigint":
      throw new TypeError(`${path} is a bigint`)
    case "symbol":
      throw new TypeError(`${path} is a symbol`)
    case "function":
      throw new TypeError(`${path} is a function`)
    case "object":
      break
    default:
      throw new TypeError(`${path} is an unsupported ${typeof value} value`)
  }

  const object = value
  if (NodeUtil.isProxy(object)) throw new TypeError(`${path} is a Proxy`)
  if (seen.has(object)) throw new TypeError(`${path} closes a reference cycle`)
  const prototype = inspect(path, () => Object.getPrototypeOf(object))
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      if (prototype !== Array.prototype) throw new TypeError(`${path} is an array subclass instance`)
      const names = inspect(path, () => Object.getOwnPropertyNames(object))
      const symbols = inspect(path, () => Object.getOwnPropertySymbols(object))
      if (names.length !== object.length + 1 || names.at(-1) !== "length" || symbols.length > 0) {
        throw new TypeError(`${path} is a sparse array or carries extra own properties`)
      }
      spend(budget, limits, 2, path, true)
      const copied: Array<Value> = []
      for (let index = 0; index < object.length; index += 1) {
        if (index > 0) spend(budget, limits, 1, path)
        const memberPath = `${path}[${index}]`
        if (names[index] !== String(index)) {
          throw new TypeError(`${path} is a sparse array or carries extra own properties`)
        }
        const descriptor = inspect(memberPath, () => Object.getOwnPropertyDescriptor(object, String(index)))
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
          throw new TypeError(`${memberPath} is an accessor or non-enumerable property`)
        }
        copied.push(clone(descriptor.value, seen, budget, limits, memberPath, depth + 1))
      }
      return copied
    }

    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} is an object whose prototype is not a plain object`)
    }
    if (inspect(path, () => Object.getOwnPropertySymbols(object)).length > 0) {
      throw new TypeError(`${path} carries symbol-keyed own properties`)
    }
    spend(budget, limits, 2, path, true)
    const copied = Object.create(null) as Record<string, Value>
    const names = inspect(path, () => Object.getOwnPropertyNames(object))
    for (let index = 0; index < names.length; index += 1) {
      const key = names[index]!
      const memberPath = step(path, key)
      const descriptor = inspect(memberPath, () => Object.getOwnPropertyDescriptor(object, key))
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${memberPath} is an accessor or non-enumerable property`)
      }
      if (index > 0) spend(budget, limits, 1, path)
      spend(budget, limits, encodedStringBytes(key, memberPath) + 1, memberPath)
      copied[key] = clone(descriptor.value, seen, budget, limits, memberPath, depth + 1)
    }
    return copied
  } finally {
    seen.delete(object)
  }
}

/**
 * Copies a manifest object after proving it belongs exactly to the JSON domain.
 * The returned object has a null prototype, so a `__proto__` field remains
 * ordinary data throughout merging and rendering.
 */
const freeze = (value: Value): Value => {
  if (Array.isArray(value)) {
    for (const member of value) freeze(member)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === "object") {
    for (const member of Object.values(value)) freeze(member)
    return Object.freeze(value)
  }
  return value
}

/**
 * Copies, validates, and deeply freezes one JSON-domain value.
 *
 * @category validation
 * @since 0.1.0
 */
export const cloneValue = (value: unknown, path = "manifest value"): Value =>
  freeze(clone(value, new Set(), { bytes: 0, members: 0 }, defaultLimits, path, 0))

/**
 * Copies and validates a manifest's top-level JSON object.
 *
 * @category validation
 * @since 0.1.0
 */
export const cloneObject = (value: unknown, path = "manifest fields"): Record<string, Value> => {
  const copied = cloneValue(value, path)
  if (Array.isArray(copied) || copied === null || typeof copied !== "object") {
    throw new TypeError(`${path} is not a JSON object`)
  }
  return copied as Record<string, Value>
}
