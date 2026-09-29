/**
 * Descriptor-only JSON admission and encoded-byte accounting for durable boundaries.
 * Never invokes getters or `toJSON`; admitted values are detached and frozen.
 * A Proxy's `ownKeys`, `getOwnPropertyDescriptor`, and `getPrototypeOf` traps
 * still run, so only JSON.parse output or other inert data is untrusted input.
 *
 * @since 1.0.0-rc.0
 */

/**
 * Resource limits for one admitted JSON tree.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Limits {
  readonly maxBytes?: number | undefined
  readonly maxDepth: number
  readonly maxMembers: number
  /** Optional cumulative member limit, in addition to the per-container limit. */
  readonly maxTotalMembers?: number | undefined
  readonly maxNodes: number
  readonly maxStringBytes?: number | undefined
  readonly maxKeyBytes?: number | undefined
}

/**
 * Detached JSON value accepted by the persistence boundary.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/** The rule that refused a JSON value.
 * @category models
 * @since 1.0.0
 */
export type IssueCode =
  | "depth"
  | "nodes"
  | "bytes"
  | "number"
  | "string"
  | "value"
  | "cycle"
  | "arrayLength"
  | "arrayMember"
  | "arrayExtra"
  | "members"
  | "object"
  | "symbol"
  | "accessor"
  | "key"
  | "inspection"

/**
 * Result of admitting or refusing an unknown JSON candidate.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Result =
  | { readonly ok: true; readonly value: Json; readonly bytes: number }
  | { readonly ok: false; readonly code: IssueCode; readonly complaint: string; readonly path: ReadonlyArray<string> }

/** Backspace, tab, newline, form feed, and carriage return. */
const shortEscaped = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

/**
 * Encoded JSON-string bytes without allocating an encoded copy.
 *
 * The count has to match what the canonical encoder emits, or the budget
 * refuses a value whose encoded form is inside it. RFC 8785 and
 * `JSON.stringify` write the five controls above as a two-character escape and
 * every other C0 control as `\u00XX`, so those five cost two bytes here and the
 * rest cost six.
 *
 * @category encoding
 * @since 1.0.0
 */
export const encodedStringBytes = (value: string, maximum = Infinity): number | undefined => {
  let bytes = 2
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return undefined
      bytes += 4
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return undefined
    else if (unit === 0x22 || unit === 0x5c || shortEscaped.has(unit)) bytes += 2
    else if (unit <= 0x1f) bytes += 6
    else if (unit <= 0x7f) bytes++
    else if (unit <= 0x7ff) bytes += 2
    else bytes += 3
    if (bytes > maximum) return undefined
  }
  return bytes <= maximum ? bytes : undefined
}

/**
 * Strict tree admission also rejects repeated references, hidden members,
 * reserved keys, and nonordinary arrays. Depth counts containers; members are
 * cumulative across the tree.
 *
 * @category models
 * @since 1.0.0
 */
export type StrictLimits = { readonly [K in Exclude<keyof Limits, "maxTotalMembers">]: number }

/**
 * Output and diagnostic policies for strict tree admission. The container
 * callback receives detached children in postorder, suitable for indexing
 * admitted trees without inspecting caller-owned objects again.
 *
 * @category models
 * @since 1.0.0
 */
export interface StrictOptions {
  readonly ordinaryRecords?: boolean
  /** Preflight text lengths and identify rejected keys by position. */
  readonly boundedText?: boolean
  readonly onContainer?: (value: ReadonlyArray<Json> | { readonly [key: string]: Json }) => void
  /** Detach an explicitly supported non-ordinary leaf with its encoded byte size. */
  readonly native?: (value: object) => { readonly value: unknown; readonly bytes: number } | undefined
}

type Segment = string | number | { readonly key: number }
type WalkResult =
  | Extract<Result, { readonly ok: true }>
  | (Omit<Extract<Result, { readonly ok: false }>, "path"> & { readonly path: ReadonlyArray<Segment> })
interface Request {
  readonly value: unknown
  readonly depth: number
  readonly path: ReadonlyArray<Segment>
}
const reservedKeys = new Set(["__proto__", "constructor", "prototype"])

const walk = (
  input: unknown,
  limits: Limits,
  preflightObjects: boolean,
  strict?: StrictOptions
): WalkResult => {
  let bytes = 0
  let nodes = 0
  let totalMembers = 0
  const active = new WeakSet<object>()
  const add = (count: number): boolean => {
    bytes += count
    return Number.isSafeInteger(bytes) && bytes <= (limits.maxBytes ?? Infinity)
  }
  const countMembers = (count: number): boolean => {
    totalMembers += count
    return count <= limits.maxMembers && totalMembers <= (limits.maxTotalMembers ?? Infinity)
  }

  function* visit({ value, depth, path }: Request): Generator<Request, WalkResult, WalkResult> {
    const refuse = (code: IssueCode, complaint: string, at = path): WalkResult => ({
      ok: false,
      code,
      complaint,
      path: at
    })
    const byteFailure = () =>
      refuse("bytes", strict ? `exceeds the ${limits.maxBytes}-byte limit` : "exceeds the JSON byte limit")
    const memberFailure = () =>
      refuse("members", strict ? `exceeds the ${limits.maxMembers}-member limit` : "exceeds the JSON members limit")
    const nodeFailure = () =>
      refuse(
        "nodes",
        strict ? `exceeds the ${limits.maxNodes}-node limit` : `contains more than ${limits.maxNodes} JSON values`
      )
    if (!strict && depth > limits.maxDepth) {
      return refuse("depth", `exceeds the maximum JSON depth of ${limits.maxDepth}`)
    }
    if (++nodes > limits.maxNodes) return nodeFailure()
    if (value === null) return add(4) ? { ok: true, value, bytes } : byteFailure()
    switch (typeof value) {
      case "boolean":
        return add(value ? 4 : 5) ? { ok: true, value, bytes } : byteFailure()
      case "number":
        if (!Number.isFinite(value)) {
          return refuse("number", strict ? "must be a finite JSON number" : "contains a non-finite number")
        }
        return add(String(value).length) ? { ok: true, value, bytes } : byteFailure()
      case "string": {
        if (strict?.boundedText && value.length > limits.maxStringBytes!) {
          return refuse("string", `exceeds the ${limits.maxStringBytes}-byte string limit`)
        }
        const size = encodedStringBytes(value, strict ? Infinity : limits.maxStringBytes)
        if (strict && size === undefined) return refuse("string", "contains an unpaired UTF-16 surrogate")
        if (size === undefined || size > (limits.maxStringBytes ?? Infinity)) {
          return refuse(
            "string",
            strict ? `exceeds the ${limits.maxStringBytes}-byte string limit` : "contains unbounded or ill-formed text"
          )
        }
        return add(size) ? { ok: true, value, bytes } : byteFailure()
      }
      case "object":
        break
      default:
        return refuse("value", strict ? "must contain only JSON values" : `contains a non-JSON ${typeof value}`)
    }
    if (strict && depth >= limits.maxDepth) return refuse("depth", `exceeds the depth limit of ${limits.maxDepth}`)
    if (active.has(value)) {
      return refuse("cycle", strict ? "contains a cycle or repeated object reference" : "contains a cycle")
    }
    active.add(value)
    const finish = (output: ReadonlyArray<Json> | { readonly [key: string]: Json }): WalkResult => {
      Object.freeze(output)
      strict?.onContainer?.(output)
      return { ok: true, value: output, bytes }
    }
    try {
      const keys = strict ? Reflect.ownKeys(value) : undefined
      const prototype = strict ? Object.getPrototypeOf(value) : undefined
      if (Array.isArray(value)) {
        if (strict && prototype !== Array.prototype) return refuse("object", "must be an ordinary array")
        // `length` is always an own, non-configurable data property of an
        // array, and a Proxy that reports it as absent or as an accessor
        // throws rather than being believed, which lands in the `inspection`
        // refusal below. A Proxy may still report a bogus numeric value, so
        // the value itself is checked; its presence needs no check.
        const length = Object.getOwnPropertyDescriptor(value, "length")!.value
        if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) {
          return refuse("arrayLength", "has an invalid array length")
        }
        if (!countMembers(length)) return memberFailure()
        if (strict && (keys!.length !== length + 1 || !keys!.includes("length"))) {
          return refuse("arrayExtra", "must be dense and have no extra properties")
        }
        if (!add(2 + Math.max(0, length - 1))) return byteFailure()
        const output: Array<Json> = []
        const inspected: Array<unknown> = []
        if (strict) {
          for (let index = length - 1; index >= 0; index--) {
            const member = Object.getOwnPropertyDescriptor(value, String(index))
            if (member === undefined || !("value" in member) || !member.enumerable) {
              return refuse("arrayMember", "must be an enumerable data property", [...path, index])
            }
            inspected[index] = member.value
          }
        }
        for (let index = 0; index < length; index++) {
          const member = strict ? { value: inspected[index] } : Object.getOwnPropertyDescriptor(value, String(index))
          if (member === undefined || !("value" in member)) {
            return refuse("arrayMember", "contains a sparse or accessor array member", [...path, index])
          }
          const admitted = yield { value: member.value, depth: depth + 1, path: [...path, index] }
          if (!admitted.ok) return admitted
          output.push(admitted.value)
        }
        if (!strict) {
          for (const key of Reflect.ownKeys(value)) {
            if (key === "length") continue
            if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) {
              const index = Number(key)
              if (index < length && String(index) === key) continue
            }
            if (Object.getOwnPropertyDescriptor(value, key)?.enumerable) {
              return refuse("arrayExtra", "has an enumerable non-index array member")
            }
          }
        }
        return finish(output)
      }
      const recordPrototype = strict ? prototype : Object.getPrototypeOf(value)
      if (recordPrototype !== Object.prototype && recordPrototype !== null) {
        const native = strict?.native?.(value)
        if (native !== undefined) {
          if (!Number.isSafeInteger(native.bytes) || native.bytes < 0) return refuse("bytes", "has an invalid native size")
          return add(native.bytes) ? { ok: true, value: native.value as Json, bytes } : byteFailure()
        }
        return refuse("object", strict ? "must be an ordinary record" : "contains a non-plain object")
      }
      const ownKeys = keys ?? Reflect.ownKeys(value)
      if (strict && ownKeys.some((key) => typeof key === "symbol")) {
        return refuse("symbol", "must not contain symbol keys")
      }
      if (strict && !countMembers(ownKeys.length)) return memberFailure()
      const members: Array<readonly [string, unknown]> = []
      let structuralBytes = 2 + Math.max(0, ownKeys.length - 1)
      for (let index = 0; index < ownKeys.length; index++) {
        const key = ownKeys[index]!
        if (strict && typeof key === "string") {
          const at = [...path, strict.boundedText ? { key: index } : key]
          if (strict.boundedText && key.length > limits.maxKeyBytes!) {
            return refuse("key", `exceeds the ${limits.maxKeyBytes}-byte key limit`, at)
          }
          const keyBytes = encodedStringBytes(key)
          if (keyBytes === undefined) return refuse("key", "has an ill-formed property name", at)
          if (!strict.boundedText && reservedKeys.has(key)) {
            return refuse("key", "uses a reserved property name", [...path, key])
          }
          if (keyBytes > limits.maxKeyBytes!) {
            return refuse("key", `exceeds the ${limits.maxKeyBytes}-byte key limit`, at)
          }
          if (reservedKeys.has(key)) return refuse("key", "uses a reserved property name", [...path, key])
          structuralBytes += keyBytes + 1
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (strict && (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)) {
          return refuse("accessor", "must be an enumerable data property", [...path, String(key)])
        }
        if (descriptor === undefined || !descriptor.enumerable) continue
        if (typeof key !== "string") return refuse("symbol", "contains an enumerable symbol")
        if (!("value" in descriptor)) return refuse("accessor", "contains an accessor", [...path, key])
        const count = members.length + 1
        if (!strict && (count > limits.maxMembers || totalMembers + count > (limits.maxTotalMembers ?? Infinity))) {
          return memberFailure()
        }
        if (!strict && preflightObjects) {
          if (nodes + count > limits.maxNodes) return nodeFailure()
          // Braces, commas, and a minimum empty key, colon, and one-byte value.
          if (bytes + 2 + (count - 1) + 4 * count > (limits.maxBytes ?? Infinity)) return byteFailure()
        }
        members.push([key, descriptor.value])
      }
      if (!strict && !countMembers(members.length)) return memberFailure()
      if (!add(strict ? structuralBytes : 2 + Math.max(0, members.length - 1))) return byteFailure()
      const output: Record<string, Json> = strict?.ordinaryRecords ? {} : Object.create(null)
      for (const [key, member] of members) {
        if (!strict) {
          const size = encodedStringBytes(key, limits.maxKeyBytes)
          if (size === undefined) return refuse("key", "contains an unbounded or ill-formed object key", [...path, key])
          if (!add(size + 1)) return byteFailure()
        }
        const admitted = yield { value: member, depth: depth + 1, path: [...path, key] }
        if (!admitted.ok) return admitted
        Object.defineProperty(output, key, { value: admitted.value, enumerable: true })
      }
      return finish(output)
    } catch {
      return refuse(
        "inspection",
        strict
          ? "could not be inspected without executing user code"
          : "cannot be inspected without executing object code"
      )
    } finally {
      if (!strict) active.delete(value)
    }
  }

  // Resume parents explicitly so configured depth limits do not depend on the
  // JavaScript call stack. Each generator retains only one container's work.
  const stack = [visit({ value: input, depth: 0, path: [] })]
  let result: WalkResult = { ok: true, value: null, bytes: 0 }
  while (stack.length > 0) {
    const next = stack[stack.length - 1]!.next(result)
    if (next.done) {
      result = next.value
      stack.pop()
    } else stack.push(visit(next.value))
  }
  return result
}

/**
 * Copies a JSON tree without invoking getters or `toJSON`, under explicit
 * byte, depth, node, and member limits. Proxy inspection traps still run.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const admit = (
  input: unknown,
  limits: Limits,
  options: { readonly preflightObjects?: boolean } = {}
): Result => {
  const result = walk(input, limits, options.preflightObjects !== false)
  return result.ok ? result : { ...result, path: result.path.map(String) }
}

/**
 * Copies a strict JSON tree with cumulative bounds and stable value paths.
 *
 * @category validation
 * @since 1.0.0
 */
export const admitStrict = (
  input: unknown,
  limits: StrictLimits,
  options: StrictOptions = {}
): { readonly ok: true; readonly value: Json } | {
  readonly ok: false
  readonly path: string
  readonly complaint: string
} => {
  const result = walk(input, { ...limits, maxTotalMembers: limits.maxMembers }, false, options)
  if (result.ok) return { ok: true, value: result.value }
  let path = "$"
  for (const segment of result.path) {
    path += typeof segment === "number"
      ? `[${segment}]`
      : typeof segment === "object"
      ? `[key:${segment.key}]`
      : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
      ? `.${segment}`
      : `[${JSON.stringify(segment)}]`
  }
  return { ok: false, path, complaint: result.complaint }
}
