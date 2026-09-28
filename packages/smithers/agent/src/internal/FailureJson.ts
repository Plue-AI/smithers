/**
 * The one JSON rendering every durable agent failure goes through.
 * @since 1.0.0
 */

import * as Cause from "effect/Cause"

/**
 * How deep the walk follows a failure before it calls the value unrenderable.
 */
const jsonDepthLimit = 200

/**
 * Whether the codec would take this value as JSON.
 *
 * A class instance is not one, however plain its fields look, so this walks
 * the structure rather than trusting `JSON.stringify`, which turns an `Error`
 * into `{}` and reports success.
 *
 * The walk runs inside `Effect.mapError` on the failure channel, so it must
 * never throw: a self-referencing failure value or one nested past the stack
 * would turn a clean failure into a defect thrown by the mapper. A cycle and
 * a depth past {@link jsonDepthLimit} both answer "not JSON", which sends the
 * value down the rendering path, where `Cause.pretty` prints it safely.
 */
const isJsonValue = (value: unknown, ancestors: WeakSet<object> = new WeakSet(), depth = 0): boolean => {
  if (value === null) return true
  const kind = typeof value
  if (kind === "string" || kind === "boolean") return true
  if (kind === "number") return Number.isFinite(value)
  if (kind !== "object") return false
  if (depth >= jsonDepthLimit) return false
  const object = value as object
  if (ancestors.has(object)) return false
  ancestors.add(object)
  try {
    if (Array.isArray(value)) return value.every((item) => isJsonValue(item, ancestors, depth + 1))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.values(value as Record<string, unknown>).every((member) => isJsonValue(member, ancestors, depth + 1))
  } finally {
    // A value repeated in sibling positions is not a cycle, so it leaves the
    // ancestor set with its own subtree.
    ancestors.delete(object)
  }
}

/**
 * Keeps an `Error`'s message inside the failure's JSON round trip.
 *
 * `message` is an own property of an `Error` but a NON-ENUMERABLE one, so
 * `JSON.stringify` drops it: a failure carrying `{ cause: new Error("no such
 * file") }` recorded as `{ cause: {} }`, which says that something failed and
 * nothing about what. A schema-declared `message` field is enumerable and
 * already survives, so it is spread last and wins.
 */
const replacer = (_key: string, value: unknown): unknown =>
  value instanceof Error && value.message !== "" ? Object.assign({ message: value.message }, value) : value

/**
 * Renders a failure into a value a `Schema.Unknown` JSON codec accepts.
 *
 * Every durable agent boundary needs the same conversion — the flow
 * settlement, the action's error channel, the budget's accounting failure —
 * and each one used to carry its own copy. The copies diverged: a native
 * `Error` nested in a cause kept its message through the settlement and became
 * `{}` through the other two, so the same provider refusal was legible in one
 * record and empty in the next. One renderer means one answer.
 *
 * Values already accepted by the JSON codec retain their identity. An OBJECT
 * the codec rejects is then round-tripped through JSON so its enumerable
 * refusal fields, `_tag` above all, survive while its prototype and stack do
 * not, and {@link replacer} carries an `Error`'s message across with them.
 * Anything else falls back to `Cause.pretty`. That order keeps typed failures
 * machine-readable without letting a cycle throw from a failure mapper, and a
 * defect stays a defect because callers map the failure channel only.
 *
 * The round trip is reserved for objects because `JSON.stringify` does not
 * refuse the non-JSON PRIMITIVES, it rewrites them: `Infinity` and `NaN` both
 * serialize to `null`, so a run that failed on an arithmetic result recorded
 * the same failure as one that failed with a literal `null`, and no reader
 * could tell them apart. `Cause.pretty` is no better on one, printing
 * `Error: null` for either, so a primitive is rendered directly.
 *
 * @category conversions
 * @since 1.0.0
 */
export const failureJson = (error: unknown): unknown => {
  try {
    if (isJsonValue(error)) return error
  } catch {
    // Admission reflects over arbitrary failures; getters and proxy traps can
    // throw before either rendering fallback gets a chance to handle them.
  }
  // `null` is JSON and has already returned, so anything here that is not an
  // object is a non-JSON primitive, and neither renderer below can carry one:
  // `JSON.stringify` rewrites `Infinity` and `NaN` to `null`, and
  // `Cause.pretty` prints a bare primitive as `Error: null`. The value prints
  // itself instead.
  if (typeof error !== "object") return `A failure of type ${typeof error}: ${String(error)}`
  try {
    const rendered = JSON.stringify(error, replacer)
    if (rendered !== undefined) {
      const decoded: unknown = JSON.parse(rendered)
      if (isJsonValue(decoded)) return decoded
    }
  } catch {
    // A cycle, a BigInt field, or excessive depth still has the text fallback
    // below.
  }
  try {
    return String(Cause.pretty(Cause.fail(error)))
  } catch {
    // The renderer walks the value too, and a value deep enough to overflow it
    // must still not throw from the mapper: the record is the last thing
    // standing between a failed run and a row that never reaches terminal.
    return `A failure of type ${typeof error} that could not be rendered.`
  }
}
