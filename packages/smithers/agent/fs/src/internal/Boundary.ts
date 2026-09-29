/**
 * Descriptor-only admission for values crossing the filesystem router.
 *
 * @private
 * @since 0.1.0
 */

import * as BoundedJson from "@smthrs/canonical/BoundedJson"

/**
 * Strict JSON accepted by agent and CLI invocations.
 *
 * @private
 * @since 0.1.0
 */
export type Json = BoundedJson.Json

/**
 * Resource limits for one admitted JSON tree.
 *
 * @private
 * @since 0.1.0
 */
export type JsonLimits = BoundedJson.StrictLimits

/**
 * Successful inert admission.
 *
 * @private
 * @since 0.1.0
 */
export interface AdmissionSuccess<A> {
  readonly ok: true
  readonly value: A
}

/**
 * Refusal with a stable value path.
 *
 * @private
 * @since 0.1.0
 */
export interface AdmissionFailure {
  readonly ok: false
  readonly path: string
  readonly complaint: string
}

/**
 * Result of inert admission.
 *
 * @private
 * @since 0.1.0
 */
export type Admission<A> = AdmissionSuccess<A> | AdmissionFailure

/**
 * Default bounds for one invocation value.
 *
 * @private
 * @since 0.1.0
 */
export const defaultJsonLimits: JsonLimits = Object.freeze({
  maxBytes: 1024 * 1024,
  maxDepth: 64,
  maxMembers: 4_096,
  maxNodes: 8_192,
  maxStringBytes: 64 * 1024,
  maxKeyBytes: 1_024
})

/**
 * Tests whether every UTF-16 surrogate is paired.
 *
 * @private
 * @since 0.1.0
 */
export const isWellFormedText = (value: string): boolean => value.isWellFormed()

const childPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`

/**
 * Copies and freezes one strict JSON tree without invoking user code.
 *
 * @private
 * @since 0.1.0
 */
export const admitJson = (
  input: unknown,
  limits: JsonLimits = defaultJsonLimits
): Admission<Json> => BoundedJson.admitStrict(input, limits)

/**
 * Strict decoded-value admission with detached native Date leaves.
 *
 * @private
 * @since 0.1.0
 */
export const admitDecoded = (input: unknown): Admission<unknown> =>
  BoundedJson.admitStrict(input, defaultJsonLimits, {
    native: (value) => {
      if (Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length !== 0) return undefined
      const time = Date.prototype.getTime.call(value)
      return Number.isFinite(time) ? { value: new Date(time), bytes: 26 } : undefined
    }
  })

/**
 * Reads a fixed set of own enumerable data fields without invoking accessors.
 *
 * @private
 * @since 0.1.0
 */
export const inspectRecord = (
  input: unknown,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = []
): Admission<Readonly<Record<string, unknown>>> => {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, path: "$", complaint: "must be an ordinary record" }
    }
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, path: "$", complaint: "must be an ordinary record" }
    }
    const allowed = new Set([...required, ...optional])
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => typeof key === "symbol" || !allowed.has(key))) {
      return { ok: false, path: "$", complaint: "contains an unknown or symbol field" }
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of required) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return { ok: false, path: childPath("$", key), complaint: "must be an enumerable data property" }
      }
      output[key] = descriptor.value
    }
    for (const key of optional) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (descriptor === undefined) continue
      if (!("value" in descriptor) || !descriptor.enumerable) {
        return { ok: false, path: childPath("$", key), complaint: "must be an enumerable data property" }
      }
      output[key] = descriptor.value
    }
    return { ok: true, value: Object.freeze(output) }
  } catch {
    return { ok: false, path: "$", complaint: "could not be inspected without executing user code" }
  }
}

/**
 * Copies an ordinary dense string array under explicit bounds.
 *
 * @private
 * @since 0.1.0
 */
export const stringArray = (
  input: unknown,
  options: { readonly maxItems: number; readonly maxLength: number; readonly allowEmpty?: boolean | undefined }
): Admission<ReadonlyArray<string>> => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      return { ok: false, path: "$", complaint: "must be an ordinary array" }
    }
    if (input.length > options.maxItems || Reflect.ownKeys(input).length !== input.length + 1) {
      return { ok: false, path: "$", complaint: `must contain at most ${options.maxItems} dense items` }
    }
    const output: Array<string> = []
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
      const value = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
      if (
        descriptor === undefined || !descriptor.enumerable || typeof value !== "string" ||
        (options.allowEmpty !== true && value.length === 0) || value.length > options.maxLength ||
        !isWellFormedText(value) || value.includes("\0")
      ) {
        return { ok: false, path: `$[${index}]`, complaint: "must be bounded, well-formed text" }
      }
      output.push(value)
    }
    return { ok: true, value: Object.freeze(output) }
  } catch {
    return { ok: false, path: "$", complaint: "could not be inspected without executing user code" }
  }
}
