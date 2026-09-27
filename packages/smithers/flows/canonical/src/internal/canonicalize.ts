/**
 * Digest-safe RFC 8785 serialization internals.
 *
 * Date remains governed by its inherited `toJSON`. Map, Set, WeakMap,
 * WeakSet, ArrayBuffer, typed arrays, RegExp, Error, and other non-plain
 * instances are rejected: their `{}` or index-keyed `JSON.stringify` forms
 * can collide with empty collections or ordinary objects in a digest library.
 *
 * @since 0.1.0
 */

import { describe } from "./describe.ts"

/**
 * Maximum supported nesting below the root value.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_CANONICAL_DEPTH = 10_000

/**
 * Stable canonicalization failure identifiers.
 *
 * @category models
 * @since 0.1.0
 */
export type CanonicalErrorCode =
  | "canonical_bigint"
  | "canonical_circular"
  | "canonical_depth_exceeded"
  | "canonical_getter_threw"
  | "canonical_lone_surrogate"
  | "canonical_nan"
  | "canonical_non_finite"
  | "canonical_tojson_threw"
  | "canonical_unsupported_value"

/**
 * A stable, located canonicalization failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class CanonicalError extends TypeError {
  readonly code: CanonicalErrorCode
  readonly path: string
  constructor(code: CanonicalErrorCode, detail: string, path: string, options?: ErrorOptions) {
    super(`${code}: ${detail} at ${path}`, options)
    this.name = "CanonicalError"
    this.code = code
    this.path = path
  }
}

const propertyPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`

const assertWellFormed = (value: string, path: string, position: "key" | "value"): string => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalError("canonical_lone_surrogate", `lone surrogate in ${position}`, path)
      }
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalError("canonical_lone_surrogate", `lone surrogate in ${position}`, path)
    }
  }
  return value
}

const builtInName = (value: object): string | undefined => {
  if (value instanceof Map) return "Map"
  if (value instanceof Set) return "Set"
  if (value instanceof WeakMap) return "WeakMap"
  if (value instanceof WeakSet) return "WeakSet"
  if (value instanceof ArrayBuffer) return "ArrayBuffer"
  if (ArrayBuffer.isView(value)) return value.constructor.name
  if (value instanceof RegExp) return "RegExp"
  // An Error subclass reports its concrete constructor so the message names
  // the actual leaked value ("TypeError at $.x"), falling back to "Error" for
  // a subclass whose constructor name was erased.
  if (value instanceof Error) return value.constructor?.name || "Error"
  return undefined
}

type Slot = { value?: string }
type Task = { readonly kind: "leave"; readonly value: object } | {
  readonly kind: "finishArray"
  readonly slots: Array<Slot>
  readonly slot: Slot
} | {
  readonly kind: "finishObject"
  readonly keys: Array<string>
  readonly slots: Array<Slot>
  readonly slot: Slot
  readonly path: string
} | {
  readonly kind: "read"
  readonly parent: Record<string, unknown>
  readonly key: string
  readonly path: string
  readonly depth: number
  readonly slot: Slot
} | {
  readonly kind: "value"
  readonly value: unknown
  readonly key: string
  readonly path: string
  readonly depth: number
  readonly slot: Slot
}

// ECMAScript ToLength (ES2026 §7.1.20): Number, NaN -> 0, truncate, clamp to [0, 2^53 - 1].
const toLength = (value: unknown): number => {
  const number = Math.trunc(Number(value))
  if (Number.isNaN(number) || number <= 0) return 0
  return Math.min(number, Number.MAX_SAFE_INTEGER)
}

const caused = (
  code: "canonical_getter_threw" | "canonical_tojson_threw",
  cause: unknown,
  path: string
): CanonicalError => new CanonicalError(code, describe(cause), path, { cause })

/**
 * Serializes a value into RFC 8785 canonical JSON.
 *
 * This matches `JSON.stringify` for JSON values, `toJSON(key)`, boxed
 * primitives, sparse arrays, and omission/null substitution. It rejects
 * non-finite numbers, BigInt, lone surrogates, cycles, and non-plain built-ins
 * whose lossy stringify forms could collide in a digest. The iterative walk
 * supports 10,000 nested levels below the root.
 *
 * `loneSurrogates: "escape"` preserves legacy sorted-JSON formats that accepted
 * unpaired UTF-16 code units. It emits their JSON escapes; this opt-in format
 * is not RFC 8785. Strict canonicalization remains the default.
 *
 * Two deliberate divergences favor digest determinism over byte parity: a
 * `toJSON` result is canonicalized recursively (stringify serializes it
 * as-is, so a chained `toJSON` stops after one level there), and a boxed
 * primitive unboxes from its internal slot (stringify consults overridden
 * `toString`/`valueOf`, letting a mutated wrapper change the bytes).
 *
 * @category constructors
 * @since 0.1.0
 */
export const canonicalize = (
  input: unknown,
  options: { readonly loneSurrogates?: "escape" } = {}
): string => {
  const text = options.loneSurrogates === "escape" ? (value: string) => value : assertWellFormed
  const root: Slot = {}
  const ancestors = new WeakSet<object>()
  const tasks: Array<Task> = [{ kind: "value", value: input, key: "", path: "$", depth: 0, slot: root }]
  while (tasks.length > 0) {
    const task = tasks.pop()!
    if (task.kind === "leave") {
      ancestors.delete(task.value)
      continue
    }
    if (task.kind === "finishArray") {
      task.slot.value = `[${task.slots.map((item) => item.value ?? "null").join(",")}]`
      continue
    }
    if (task.kind === "finishObject") {
      task.slot.value = `{${
        task.keys.flatMap((key, index) =>
          task.slots[index]!.value === undefined
            ? []
            : `${JSON.stringify(text(key, task.path, "key"))}:${task.slots[index]!.value}`
        ).join(",")
      }}`
      continue
    }
    if (task.kind === "read") {
      let child: unknown
      try {
        child = task.parent[task.key]
      } catch (cause) {
        throw caused("canonical_getter_threw", cause, task.path)
      }
      tasks.push({ kind: "value", value: child, key: task.key, path: task.path, depth: task.depth, slot: task.slot })
      continue
    }

    const { depth, key, path, slot } = task
    let value = task.value
    if (depth > MAX_CANONICAL_DEPTH) {
      throw new CanonicalError(
        "canonical_depth_exceeded",
        `depth ${depth.toLocaleString("en-US")} exceeds ${MAX_CANONICAL_DEPTH.toLocaleString("en-US")}`,
        path
      )
    }
    if (typeof value === "number") {
      if (Number.isNaN(value)) throw new CanonicalError("canonical_nan", "NaN", path)
      if (!Number.isFinite(value)) throw new CanonicalError("canonical_non_finite", String(value), path)
      slot.value = JSON.stringify(value)
      continue
    }
    if (typeof value === "bigint") throw new CanonicalError("canonical_bigint", "BigInt", path)
    if (typeof value === "string") {
      slot.value = JSON.stringify(text(value, path, "value"))
      continue
    }
    if (value === null || typeof value === "boolean") {
      slot.value = JSON.stringify(value)
      continue
    }
    if (typeof value === "undefined" || typeof value === "symbol") continue

    const object = value as object
    if (ancestors.has(object)) throw new CanonicalError("canonical_circular", "circular reference", path)
    ancestors.add(object)
    tasks.push({ kind: "leave", value: object })
    let toJSON: unknown
    try {
      toJSON = (value as { readonly toJSON?: unknown }).toJSON
    } catch (cause) {
      throw caused("canonical_getter_threw", cause, path)
    }
    if (typeof toJSON === "function") {
      try {
        value = Reflect.apply(toJSON, value, [key])
      } catch (cause) {
        throw caused("canonical_tojson_threw", cause, path)
      }
      tasks.push({ kind: "value", value, key, path: `${path}.toJSON()`, depth: depth + 1, slot })
      continue
    }
    if (typeof value === "function") continue

    try {
      if (value instanceof Number) value = Number.prototype.valueOf.call(value)
      else if (value instanceof String) value = String.prototype.valueOf.call(value)
      else if (value instanceof Boolean) value = Boolean.prototype.valueOf.call(value)
      else if (Object.prototype.toString.call(value) === "[object BigInt]") {
        throw new CanonicalError("canonical_bigint", "boxed BigInt", path)
      }
    } catch (cause) {
      if (cause instanceof CanonicalError) throw cause
      throw caused("canonical_getter_threw", cause, path)
    }
    if (value !== object) {
      tasks.push({ kind: "value", value, key, path, depth, slot })
      continue
    }
    if (Array.isArray(value)) {
      // `value.length` on a proxy runs its get trap and may return anything;
      // JSON.stringify applies ToLength once and reads the integer indices
      // below it, so normalize once here and use the same integer for both
      // allocation and iteration. A throwing trap or coercion is a getter
      // failure like any other and must not escape as the raw error.
      let length: number
      try {
        length = toLength(value.length)
      } catch (cause) {
        throw caused("canonical_getter_threw", cause, path)
      }
      const slots = Array.from({ length }, (): Slot => ({}))
      tasks.push({ kind: "finishArray", slots, slot })
      for (let index = length - 1; index >= 0; index--) {
        tasks.push({
          kind: "read",
          parent: value as unknown as Record<string, unknown>,
          key: String(index),
          path: `${path}[${index}]`,
          depth: depth + 1,
          slot: slots[index]!
        })
      }
      continue
    }
    let unsupported: string | undefined
    try {
      unsupported = builtInName(object)
      const prototype = Object.getPrototypeOf(object) as { readonly constructor?: { readonly name?: string } } | null
      if (unsupported === undefined && prototype !== null && prototype !== Object.prototype) {
        unsupported = prototype.constructor?.name || "non-plain object"
      }
    } catch (cause) {
      throw caused("canonical_getter_threw", cause, path)
    }
    if (unsupported !== undefined) throw new CanonicalError("canonical_unsupported_value", unsupported, path)

    let keys: Array<string>
    try {
      keys = Object.keys(value).sort()
    } catch (cause) {
      throw caused("canonical_getter_threw", cause, path)
    }
    const slots = keys.map((): Slot => ({}))
    tasks.push({ kind: "finishObject", keys, slots, slot, path })
    for (let index = keys.length - 1; index >= 0; index--) {
      const member = keys[index]!
      const memberPath = propertyPath(path, member)
      text(member, memberPath, "key")
      tasks.push({
        kind: "read",
        parent: value as Record<string, unknown>,
        key: member,
        path: memberPath,
        depth: depth + 1,
        slot: slots[index]!
      })
    }
  }
  if (root.value === undefined) throw new CanonicalError("canonical_unsupported_value", typeof input, "$")
  return root.value
}
