/**
 * The bounded, deep-frozen JSON snapshot `PermissionRequired` takes of caller
 * metadata.
 *
 * @since 0.1.0
 */

import { Schema, SchemaIssue } from "effect"
import { isPlainObject } from "./isPlainObject.ts"

// Match the kernel GrantStore envelope without depending on the kernel.
const maximumMetadataDepth = 16
const maximumMetadataMembers = 1_024
const maximumMetadataBytes = 64 * 1024
const metadataEncoder = new TextEncoder()

const invalidMetadata = (path: string, reason: string): Schema.SchemaError =>
  new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: `Expected JSON value at ${path}: ${reason}` }))

const metadataStringBytes = (value: string, path: string): number => {
  // Check before escaping/encoding so a single huge string cannot allocate an
  // unbounded temporary serialization. JSON's UTF-8 size is at least this long.
  if (value.length > maximumMetadataBytes) {
    throw invalidMetadata(path, `metadata exceeds ${maximumMetadataBytes} bytes`)
  }
  return metadataEncoder.encode(JSON.stringify(value)).byteLength
}

type MetadataSnapshot = {
  readonly value: Schema.Json
  readonly members: number
  readonly bytes: number
  readonly height: number
}

type MetadataFrame = {
  readonly input: object
  readonly path: string
  readonly depth: number
  readonly key: string
  readonly array: boolean
  readonly keys: Iterator<string>
  readonly entries: Array<[string, Schema.Json]>
  members: number
  bytes: number
  height: number
}

const metadataKeys = function*(value: Record<string, unknown> | Array<unknown>): Generator<string> {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) yield String(index)
  } else {
    for (const key in value) {
      if (Object.hasOwn(value, key)) yield key
    }
  }
}

/**
 * @since 0.1.0
 * @private
 */
export const permissionMetaSnapshot = (
  meta: Readonly<Record<string, unknown>>
): Readonly<Record<string, Schema.Json>> => {
  if (!isPlainObject(meta)) throw invalidMetadata("meta", "metadata must be a plain record")
  const snapshots = new WeakMap<object, MetadataSnapshot>()
  const active = new WeakSet<object>()
  const stack: Array<MetadataFrame> = []
  let visitedMembers = 0

  const push = (input: Record<string, unknown> | Array<unknown>, path: string, depth: number, key: string) => {
    active.add(input)
    stack.push({
      input,
      path,
      depth,
      key,
      array: Array.isArray(input),
      keys: metadataKeys(input),
      entries: [],
      members: 0,
      bytes: 2,
      height: 0
    })
  }
  const append = (frame: MetadataFrame, key: string, child: MetadataSnapshot, path: string) => {
    // Count repeated references as expanded JSON, but reuse their computed
    // totals. Neither validation nor copying expands a shared DAG into a tree.
    frame.members += 1 + child.members
    frame.height = Math.max(frame.height, 1 + child.height)
    if (frame.depth + frame.height > maximumMetadataDepth) {
      throw invalidMetadata(path, `metadata exceeds depth ${maximumMetadataDepth}`)
    }
    if (frame.members > maximumMetadataMembers) {
      throw invalidMetadata(path, `metadata exceeds ${maximumMetadataMembers} members`)
    }
    frame.bytes += child.bytes + (frame.entries.length === 0 ? 0 : 1) +
      (frame.array ? 0 : metadataStringBytes(key, path) + 1)
    if (frame.bytes > maximumMetadataBytes) {
      throw invalidMetadata(path, `metadata exceeds ${maximumMetadataBytes} bytes`)
    }
    frame.entries.push([key, child.value])
  }

  push(meta, "meta", 0, "")
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!
    const next = frame.keys.next()
    if (next.done) {
      // fromEntries installs own data properties, including __proto__. Only
      // copy a container after its depth, members and encoded size are checked.
      const snapshot: MetadataSnapshot = {
        value: Object.freeze(frame.array ? frame.entries.map(([, value]) => value) : Object.fromEntries(frame.entries)),
        members: frame.members,
        bytes: frame.bytes,
        height: frame.height
      }
      snapshots.set(frame.input, snapshot)
      active.delete(frame.input)
      stack.pop()
      if (stack.length > 0) append(stack[stack.length - 1]!, frame.key, snapshot, frame.path)
      continue
    }

    const key = next.value
    // Bound key encoding before putting it in an error path, too.
    metadataStringBytes(key, frame.path)
    const path = `${frame.path}[${JSON.stringify(key)}]`
    if (++visitedMembers > maximumMetadataMembers) {
      throw invalidMetadata(path, `metadata exceeds ${maximumMetadataMembers} members`)
    }
    const value = (frame.input as Record<string, unknown>)[key]
    if (value === undefined && !frame.array) {
      if (++frame.members > maximumMetadataMembers) {
        throw invalidMetadata(path, `metadata exceeds ${maximumMetadataMembers} members`)
      }
      continue
    }
    const depth = frame.depth + 1
    if (depth > maximumMetadataDepth) throw invalidMetadata(path, `metadata exceeds depth ${maximumMetadataDepth}`)
    if (value !== null && typeof value === "object") {
      if (active.has(value)) throw invalidMetadata(path, "metadata must not contain cycles")
      const existing = snapshots.get(value)
      if (existing !== undefined) {
        append(frame, key, existing, path)
      } else if (Array.isArray(value) || isPlainObject(value)) {
        push(value, path, depth, key)
      } else {
        throw invalidMetadata(path, "metadata objects must be plain records")
      }
      continue
    }
    let bytes: number
    if (typeof value === "string") bytes = metadataStringBytes(value, path)
    else if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      bytes = JSON.stringify(value).length
    } else {
      throw invalidMetadata(path, "metadata must be JSON data")
    }
    append(frame, key, { value, bytes, members: 0, height: 0 }, path)
  }
  return snapshots.get(meta)!.value as Readonly<Record<string, Schema.Json>>
}
