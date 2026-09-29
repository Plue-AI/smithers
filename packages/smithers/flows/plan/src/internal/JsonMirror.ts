/**
 * The inert JSON mirror of a value: what `JSON.stringify` would see, as data.
 *
 * The AST stores payloads this way, the plan compiler stores key material this
 * way, and a plan diff compares declarations this way, so all three share the
 * one walk. A planned value is the only member with no JSON meaning of its
 * own, and each caller decides what it becomes.
 *
 * @since 0.1.0
 * @private
 */

import { GraphBuildError } from "../GraphBuildError.ts"
import * as Planned from "../Planned.ts"

/**
 * One container being cloned: the object walked, the clone being filled, and
 * the member position the walk has reached. `keys` is `undefined` for an
 * array, whose members are positional.
 *
 * @since 0.1.0
 * @private
 */
interface CloneFrame {
  readonly source: Record<string, unknown> | ReadonlyArray<unknown>
  readonly output: Record<string, unknown> | Array<unknown>
  readonly descriptors: PropertyDescriptorMap
  readonly keys: ReadonlyArray<string> | undefined
  readonly path: ClonePath
  index: number
}

/**
 * Where the walk stands, as a link to its parent rather than a copy of the
 * whole path. Payload depth is bounded only by the caller, and copying the
 * path at each member made a clone cost memory quadratic in that depth: a
 * 20,000-deep payload held 20,000 live frames whose paths together ran to
 * hundreds of millions of entries, several gigabytes, for a result that is
 * linear. The path is read only to name a member in a refusal, so it stays a
 * chain here and is flattened at the throw.
 *
 * `undefined` is the root, whose path is empty.
 *
 * @since 0.1.0
 * @private
 */
type ClonePath = { readonly parent: ClonePath; readonly key: string } | undefined

/** The chain read outwards, root first: the array the refusals report. */
const clonePath = (path: ClonePath): ReadonlyArray<string> => {
  const keys: Array<string> = []
  for (let current = path; current !== undefined; current = current.parent) keys.push(current.key)
  return keys.reverse()
}

const payloadError = (at: ClonePath, reason: string): GraphBuildError => {
  const path = clonePath(at)
  return new GraphBuildError({
    code: "invalid_payload",
    node: "payload",
    path,
    message: `Plan payload at ${path.length === 0 ? "$" : `$.${path.join(".")}`} ${reason}`
  })
}

const cyclicPayloadError = (at: ClonePath): GraphBuildError => {
  const path = clonePath(at)
  return new GraphBuildError({
    code: "cyclic_payload",
    node: "payload",
    path,
    message: `Plan payload at ${
      path.length === 0 ? "$" : `$.${path.join(".")}`
    } has a toJSON method that returns itself`
  })
}

const inheritedDataProperty = (
  value: object,
  key: PropertyKey
):
  | { readonly kind: "data"; readonly value: unknown }
  | { readonly kind: "accessor" }
  | { readonly kind: "missing" } => {
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) {
      return "value" in descriptor ? { kind: "data", value: descriptor.value } : { kind: "accessor" }
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return { kind: "missing" }
}

/**
 * Clones the JSON mirror of the input, so {@link module:StepKey.content} over
 * the clone and the input produce the same key and the clone holds only inert
 * JSON data. The walk uses an explicit stack, memoizes shared references and
 * cycles, honors callable `toJSON`, omits object members without a JSON
 * representation, and writes `null` for those values in arrays.
 *
 * A planned value becomes whatever `plannedValue` returns for it. Refusals
 * throw a {@link GraphBuildError} naming the member's path.
 *
 * @since 0.1.0
 * @private
 */
export const jsonMirror = (
  input: unknown,
  plannedValue: (value: unknown, reference: Planned.Reference) => unknown
): unknown => {
  const missing = Symbol("missing JSON representation")
  const seen = new WeakMap<object, unknown>()
  let result: unknown
  const frames: Array<CloneFrame> = []
  /** Resolves one member, opening a frame when it is an unseen container. */
  const enter = (
    initial: unknown,
    place: (member: unknown | typeof missing) => void,
    path: ClonePath
  ): void => {
    let current = initial
    const replacements: Array<object> = []
    const resolving = new WeakSet<object>()
    const finish = (member: unknown | typeof missing): void => {
      for (const replacement of replacements) seen.set(replacement, member)
      place(member)
    }
    while (true) {
      const reference = Planned.reference(current)
      if (reference !== undefined) {
        finish(plannedValue(current, reference))
        return
      }
      const kind = typeof current
      if (current === null || (kind !== "object" && kind !== "function")) {
        finish(kind === "undefined" || kind === "symbol" ? missing : current)
        return
      }
      const source = current as object
      if (seen.has(source)) {
        finish(seen.get(source))
        return
      }
      if (resolving.has(source)) {
        throw cyclicPayloadError(path)
      }
      const toJSON = inheritedDataProperty(source, "toJSON")
      if (toJSON.kind === "accessor") {
        throw payloadError(path, "has an accessor-backed toJSON member")
      }
      if (toJSON.kind === "data" && typeof toJSON.value === "function") {
        resolving.add(source)
        replacements.push(source)
        current = Reflect.apply(toJSON.value, source, [])
        continue
      }
      if (kind === "function") {
        seen.set(source, missing)
        finish(missing)
        return
      }
      const prototype = Object.getPrototypeOf(source)
      if (!Array.isArray(source) && prototype !== Object.prototype && prototype !== null) {
        throw payloadError(path, "has an unsupported prototype and no data-valued toJSON method")
      }
      const container = current as Record<string, unknown> | ReadonlyArray<unknown>
      const descriptors = Object.getOwnPropertyDescriptors(container) as PropertyDescriptorMap
      const output: Record<string, unknown> | Array<unknown> = Array.isArray(container)
        ? []
        : Object.create(null) as Record<string, unknown>
      seen.set(container, output)
      finish(output)
      frames.push({
        source: container,
        output,
        descriptors,
        keys: Array.isArray(container)
          ? undefined
          : Reflect.ownKeys(descriptors).filter((key): key is string =>
            typeof key === "string" && descriptors[key]!.enumerable === true
          ),
        path,
        index: 0
      })
      return
    }
  }
  enter(input, (member) => {
    result = member === missing ? undefined : member
  }, undefined)
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!
    if (frame.index >= (frame.keys ?? frame.source as ReadonlyArray<unknown>).length) {
      frames.pop()
      continue
    }
    const position = frame.index
    frame.index = position + 1
    if (frame.keys === undefined) {
      const members = frame.output as Array<unknown>
      const descriptor = frame.descriptors[String(position)]
      if (descriptor !== undefined && !("value" in descriptor)) {
        throw payloadError({ parent: frame.path, key: String(position) }, "is an accessor")
      }
      enter(descriptor === undefined ? undefined : descriptor.value, (member) => {
        members.push(member === missing ? null : member)
      }, { parent: frame.path, key: String(position) })
    } else {
      const key = frame.keys[position]!
      const descriptor = frame.descriptors[key]!
      if (!("value" in descriptor)) throw payloadError({ parent: frame.path, key }, "is an accessor")
      enter(descriptor.value, (member) => {
        if (member === missing) return
        Object.defineProperty(frame.output, key, {
          configurable: true,
          enumerable: true,
          value: member,
          writable: true
        })
      }, { parent: frame.path, key })
    }
  }
  return result
}
