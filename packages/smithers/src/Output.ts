/**
 * Deterministic rendering for the CLI projection.
 *
 * @since 0.1.0
 */

import { ControlSchema } from "@smthrs/control"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { isProxy } from "node:util/types"
import * as CliError from "./CliError.ts"
import { terminalSafeLines } from "./internal/Failure.ts"

/**
 * The two stable renderings exposed by CLI handlers.
 *
 * Choose `human` for readable indentation and `json` for compact machine
 * output. Rendering refuses executable or unbounded values before writing.
 *
 * @category models
 * @since 0.1.0
 */
export type Format = "human" | "json"

/**
 * Text ready for stdout together with the status the process should publish.
 *
 * Handlers consume this result instead of inferring status from serialized
 * text. `text` is always a string, including for top-level `undefined`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Rendered {
  readonly text: string
  readonly exitCode: number
}

/**
 * The rendering service consumed by command handlers.
 *
 * Reach for this service at the presentation boundary. It snapshots inert
 * data, normalizes explicitly supported scalar values, and refuses executable
 * or unbounded structures with a path-specific error.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly render: (value: unknown, format: Format) => Effect.Effect<Rendered, CliError.RenderingError>
}

/**
 * Context key for the CLI rendering service.
 *
 * Platform compositions provide it once for every handler. A missing service
 * is a composition defect surfaced by Effect before output is written.
 *
 * @category services
 * @since 0.1.0
 */
export class Output extends Context.Service<Output, Service>()("/cli/Output") {}

const RenderValueTypeId: unique symbol = Symbol("@smthrs/cli/Output/RenderValue")

interface RenderValue {
  readonly [RenderValueTypeId]: true
  readonly value: unknown
}

const renderValues = new WeakSet<object>()

/**
 * Marks caller-controlled data as output, never as a control receipt.
 *
 * Use this around values read from memory or projected from a run. It keeps
 * receipt-shaped user data from changing the process status.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const renderValue = (value: unknown): RenderValue => {
  const wrapped = Object.freeze({ [RenderValueTypeId]: true as const, value })
  renderValues.add(wrapped)
  return wrapped
}

const isRenderValue = (value: unknown): value is RenderValue =>
  typeof value === "object" && value !== null && renderValues.has(value)

/**
 * Maximum object/array nesting accepted by one render.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumDepth = 128

/**
 * Maximum enumerable data members accepted by one render.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumMembers = 10_000

/**
 * Maximum UTF-8 bytes written by one rendered document.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumOutputBytes = 4 * 1024 * 1024

type RenderingCode = CliError.RenderingError["code"]

type Snapshot = null | boolean | number | string | ReadonlyArray<Snapshot> | { readonly [key: string]: Snapshot }

interface SnapshotState {
  readonly ancestors: WeakMap<object, string>
  members: number
}

const clippedKey = (key: string): string => key.length <= 128 ? key : `${key.slice(0, 128)}…`

const memberPath = (path: string, key: string): string => {
  const next = `${path}[${JSON.stringify(clippedKey(key))}]`
  return next.length <= 1_024 ? next : `${next.slice(0, 1_023)}…`
}

const renderingError = (code: RenderingCode, path: string, detail: string): CliError.RenderingError =>
  new CliError.RenderingError({ code, path, message: `Cannot render ${path}: ${detail}` })

const fail = (code: RenderingCode, path: string, detail: string): never => {
  throw renderingError(code, path, detail)
}

const boundedString = (value: string, path: string): string => {
  if (Buffer.byteLength(value) > maximumOutputBytes) {
    return fail("byte_limit", path, `a string exceeds ${maximumOutputBytes} UTF-8 bytes`)
  }
  return value
}

const dataDescriptor = (descriptor: PropertyDescriptor, path: string): unknown => {
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    return fail("accessor", path, "accessor properties are executable")
  }
  return descriptor.value
}

const reserveMembers = (state: SnapshotState, count: number, path: string): void => {
  state.members += count
  if (state.members > maximumMembers) {
    fail("member_limit", path, `the document exceeds ${maximumMembers} members`)
  }
}

const snapshotArray = (
  value: ReadonlyArray<unknown>,
  descriptors: PropertyDescriptorMap,
  state: SnapshotState,
  path: string,
  depth: number
): ReadonlyArray<Snapshot> => {
  // Proxies are refused before this point, so an actual Array's own length
  // descriptor is always a non-negative uint32 data property.
  const size = dataDescriptor(descriptors["length"]!, `${path}.length`) as number
  const ownKeys = Reflect.ownKeys(descriptors)
  for (const key of ownKeys) {
    if (key === "length") continue
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= size) {
      return fail("unsupported", path, "arrays may contain only indexed data members")
    }
  }
  reserveMembers(state, size, path)
  const output: Array<Snapshot> = []
  for (let index = 0; index < size; index++) {
    const itemPath = `${path}[${index}]`
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined) return fail("unsupported", itemPath, "sparse arrays are not renderable data")
    if (descriptor.enumerable !== true) return fail("unsupported", itemPath, "array data must be enumerable")
    output.push(snapshot(dataDescriptor(descriptor, itemPath), state, itemPath, depth + 1))
  }
  return output
}

const snapshotObject = (
  descriptors: PropertyDescriptorMap,
  state: SnapshotState,
  path: string,
  depth: number
): { readonly [key: string]: Snapshot } => {
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key === "symbol")) {
    return fail("unsupported", path, "symbol-named members are not renderable data")
  }
  // The built-in default order is the specified UTF-16 code-unit order. Object
  // keys are unique, so no equality branch or locale callback is needed.
  const names = (keys as Array<string>).sort()
  reserveMembers(state, names.length, path)
  const output: Record<string, Snapshot> = Object.create(null)
  for (const key of names) {
    const pathForKey = memberPath(path, key)
    if (key === "toJSON") return fail("to_json", pathForKey, "toJSON members are executable")
    const descriptor = descriptors[key]!
    if (descriptor.enumerable !== true) {
      return fail("unsupported", pathForKey, "object data must be enumerable")
    }
    boundedString(key, pathForKey)
    const member = dataDescriptor(descriptor, pathForKey)
    // JSON omits an absent member; only array positions and a lone top-level value stay visible.
    if (member === undefined) continue
    output[key] = snapshot(member, state, pathForKey, depth + 1)
  }
  return output
}

const snapshot = (value: unknown, state: SnapshotState, path: string, depth: number): Snapshot => {
  if (depth > maximumDepth) return fail("depth_limit", path, `the document exceeds depth ${maximumDepth}`)
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? boundedString(value, path) : value
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "[NaN]"
    if (value === Number.POSITIVE_INFINITY) return "[Infinity]"
    if (value === Number.NEGATIVE_INFINITY) return "[-Infinity]"
    if (Object.is(value, -0)) return "-0"
    return value
  }
  if (value === undefined) return "[Undefined]"
  if (typeof value === "bigint") return boundedString(`${value}n`, path)
  if (typeof value === "symbol") return boundedString(String(value), path)
  if (typeof value === "function") return fail("callable", path, "functions are executable")
  if (isProxy(value)) return fail("proxy", path, "proxies are executable")
  if (Redacted.isRedacted(value)) return "<redacted>"
  const firstPath = state.ancestors.get(value)
  if (firstPath !== undefined) return fail("cycle", path, `the value already appears at ${firstPath}`)

  // Every object capable of trapping either operation is a Proxy, refused
  // above before any trap can run.
  const prototype = Object.getPrototypeOf(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const array = Array.isArray(value)
  if (!array && prototype !== Object.prototype && prototype !== null) {
    return fail("unsupported", path, "only plain objects and arrays are renderable")
  }

  state.ancestors.set(value, path)
  try {
    return array
      ? snapshotArray(value as ReadonlyArray<unknown>, descriptors, state, path, depth)
      : snapshotObject(descriptors, state, path, depth)
  } finally {
    state.ancestors.delete(value)
  }
}

interface EncodeState {
  readonly chunks: Array<string>
  bytes: number
}

const append = (state: EncodeState, text: string, path: string): void => {
  const bytes = Buffer.byteLength(text)
  if (state.bytes + bytes > maximumOutputBytes) {
    fail("byte_limit", path, `the rendered document exceeds ${maximumOutputBytes} UTF-8 bytes`)
  }
  state.bytes += bytes
  state.chunks.push(text)
}

const encode = (value: Snapshot, format: Format, state: EncodeState, path: string, depth: number): void => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    append(state, typeof value === "string" ? JSON.stringify(value) : String(value), path)
    return
  }
  const pretty = format === "human"
  const indentation = (level: number): string => "  ".repeat(level)
  if (Array.isArray(value)) {
    append(state, "[", path)
    for (let index = 0; index < value.length; index++) {
      if (index > 0) append(state, ",", path)
      if (pretty) append(state, `\n${indentation(depth + 1)}`, path)
      encode(value[index], format, state, `${path}[${index}]`, depth + 1)
    }
    if (pretty && value.length > 0) append(state, `\n${indentation(depth)}`, path)
    append(state, "]", path)
    return
  }
  const record = value as { readonly [key: string]: Snapshot }
  const keys = Object.keys(record)
  append(state, "{", path)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!
    const pathForKey = memberPath(path, key)
    if (index > 0) append(state, ",", path)
    if (pretty) append(state, `\n${indentation(depth + 1)}`, path)
    append(state, `${JSON.stringify(key)}:${pretty ? " " : ""}`, pathForKey)
    encode(record[key]!, format, state, pathForKey, depth + 1)
  }
  if (pretty && keys.length > 0) append(state, `\n${indentation(depth)}`, path)
  append(state, "}", path)
}

const renderSnapshot = (value: Snapshot, format: Format): string => {
  if (format === "human" && typeof value === "string") {
    // `snapshot` has already admitted this string against the same byte cap.
    // Human text reaches a terminal: flow, model, and task strings must not
    // be able to move the cursor, clear the screen, or set the title.
    return terminalSafeLines(value)
  }
  const state: EncodeState = { chunks: [], bytes: 0 }
  encode(value, format, state, "$", 0)
  const text = state.chunks.join("")
  // JSON escapes C0 but not C1 or format code points such as bidi overrides.
  return format === "human" ? terminalSafeLines(text) : text
}

/**
 * Renders a decoded value in a deterministic human or machine form.
 *
 * Construct this service for platform layers and focused tests. Only inert
 * plain data crosses the boundary; executable and oversized inputs fail with
 * a stable code and path before any output is written.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (): Service => ({
  render: Effect.fn("Output.render")((input, format) =>
    Effect.try({
      try: () => {
        const wrapped = isRenderValue(input)
        const value = wrapped ? input.value : input
        const normalized = snapshot(value, { ancestors: new WeakMap(), members: 0 }, "$", 0)
        return {
          text: renderSnapshot(normalized, format),
          exitCode: wrapped ? 0 : exitCode(normalized)
        }
      },
      catch: (cause) =>
        cause instanceof CliError.RenderingError
          ? cause
          : renderingError("unreadable", "$", "the value could not be inspected without executing it")
    })
  )
})

/**
 * Default deterministic output layer.
 *
 * Use it when no platform-specific exit-code transfer is needed. Construction
 * is infallible; a missing layer is reported as an Effect service requirement.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.succeed(Output, make())

/**
 * Maps validated control receipts to process status codes.
 *
 * Call this only at the output boundary. Non-receipts, including objects with
 * receipt-like field names, return zero; malformed values never throw.
 *
 * @category getters
 * @since 0.1.0
 */
export const exitCode = (value: unknown): number => {
  if (isRenderValue(value)) return 0
  try {
    if (!Schema.is(ControlSchema.Receipt)(value)) return 0
  } catch {
    return 0
  }
  if (value._tag === "Parked") return 3
  if (value._tag === "Terminal") {
    if (value.status === "cancelled") return 130
    if (value.status === "failed") return 1
  }
  if (value._tag === "Conflict") return 1
  return 0
}
