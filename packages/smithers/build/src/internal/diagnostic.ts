/**
 * The JSON-encodable description of a host failure that a typed error carries.
 *
 * Both errors in this package are declared error schemas of durable Actions.
 * `Action.executeEncoded` encodes a failure through `Schema.toCodecJson` and
 * `Effect.orDie`s the encode, so an error field that cannot become JSON turns
 * the most ordinary failure into a defect that kills the run instead of a
 * journaled result. A raw `Error` is exactly such a field: `Schema.Unknown`
 * accepts it at construction and `toCodecJson` refuses it at the boundary.
 *
 * This module is what a construction site attaches instead: three bounded
 * strings taken off the host failure, chosen so the operator still reads the
 * same sentence they used to read in the stack.
 *
 * Nothing here is reachable from outside the package: the export map maps
 * `./internal/*` to `null`.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/** Longest failure name or code retained. */
const maximumLabelLength = 128

/** Longest failure message retained. Enough for a spawn or `errno` sentence. */
const maximumMessageLength = 2_048

/**
 * Schema for the JSON-encodable description of a host failure.
 *
 * The bounds are on the schema, not only on {@link diagnostic}, so a value that
 * arrives by decoding a journaled error is held to the same limits the
 * construction site applies. An unbounded string field would make the retention
 * promise true only for causes this package happened to build.
 *
 * @private
 * @since 0.1.0
 */
export const Diagnostic = Schema.Struct({
  /** The failure's own name or tag: `PlatformError`, `TypeError`. */
  name: Schema.String.check(Schema.isMaxLength(maximumLabelLength)),
  /** The platform error code where the host reports one: `ENOENT`, `EACCES`. */
  code: Schema.optional(Schema.String.check(Schema.isMaxLength(maximumLabelLength))),
  /** The failure's message, and the message of one nested cause. */
  message: Schema.String.check(Schema.isMaxLength(maximumMessageLength))
})

/**
 * The JSON-encodable description of a host failure.
 *
 * @private
 * @since 0.1.0
 */
export type Diagnostic = typeof Diagnostic.Type

/** Reads one property off a possibly hostile value without invoking a getter. */
const dataProperty = (value: object, name: string): unknown => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name) ??
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value) ?? {}, name)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/** Trims one string to a bound, or reports that it was not usable text. */
const label = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" && value !== "" ? value.slice(0, limit) : undefined

/**
 * Describes an arbitrary host failure as bounded JSON.
 *
 * `undefined` in, `undefined` out, so an error constructed without a cause
 * stays without one. Everything else answers with at least a name and a
 * message, because a diagnostic that can be absent for some failures is a
 * diagnostic nothing can be written against.
 *
 * One level of nesting is read and no more. Effect wraps a host `Error` in a
 * `PlatformError` whose own message names the operation and whose nested cause
 * carries the `errno` sentence, so a diagnostic that stopped at the outer
 * message would drop the `ENOENT` a reader needs. Going deeper would start
 * accumulating the whole chain, which is the unbounded retention this schema
 * exists to prevent.
 *
 * @private
 * @since 0.1.0
 */
export const diagnostic = (cause: unknown): Diagnostic | undefined => {
  if (cause === undefined) return undefined
  if (typeof cause !== "object" && typeof cause !== "function") {
    if (typeof cause === "symbol") return { name: "symbol", message: cause.toString().slice(0, maximumMessageLength) }
    return { name: typeof cause, message: String(cause).slice(0, maximumMessageLength) }
  }
  if (cause === null) return { name: "null", message: "null" }
  const name = label(dataProperty(cause, "name"), maximumLabelLength) ??
    label(dataProperty(cause, "_tag"), maximumLabelLength) ??
    "Error"
  const own = label(dataProperty(cause, "message"), maximumMessageLength)
  const nested = dataProperty(cause, "cause")
  const nestedObject = typeof nested === "object" && nested !== null ? nested : undefined
  const nestedMessage = nestedObject === undefined
    ? undefined
    : label(dataProperty(nestedObject, "message"), maximumMessageLength)
  const code = label(dataProperty(cause, "code"), maximumLabelLength) ??
    (nestedObject === undefined ? undefined : label(dataProperty(nestedObject, "code"), maximumLabelLength))
  const message = own === undefined
    ? nestedMessage ?? "unknown failure"
    : nestedMessage === undefined || own.includes(nestedMessage)
    ? own
    : `${own}: ${nestedMessage}`.slice(0, maximumMessageLength)
  return code === undefined ? { name, message } : { name, code, message }
}
