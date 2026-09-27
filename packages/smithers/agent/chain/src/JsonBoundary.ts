/**
 * The gate both runner bindings answer to: the strict JSON boundary every
 * value crosses, the outcome decode over what crossed, and the messages
 * both bindings refuse with.
 *
 * It is a leaf on purpose. `ScriptRunner.ts` is the interpreter port and
 * its in-process binding, `QuickJsRunner.ts` is the sealed realm; whatever
 * the two must agree about byte for byte lives here, so a limit or a
 * refusal sentence has ONE home instead of a copy per binding
 * (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */

import { Option, Schema } from "effect"
import * as Outcome from "./Outcome.ts"

const decodeOutcomeShape = Schema.decodeUnknownOption(Outcome.Outcome)

/**
 * Decodes a script's returned value into an outcome; shared by every
 * runner binding so they reject the same shapes and normalize identically.
 *
 * A `To` is rebuilt through {@link Outcome.to}, which re-derives the
 * successor's digest from its text: a script may choose the text it hands
 * on, never the replay identity that text is keyed by.
 *
 * @category gates
 * @since 0.1.0
 * @slop
 */
export const decodeOutcome = (value: unknown): Option.Option<Outcome.Outcome> =>
  Option.map(
    decodeOutcomeShape(value),
    (outcome) => outcome._tag === "To" ? Outcome.to(outcome.script) : outcome
  )

/**
 * The deepest nesting a value may carry across the boundary. Journal
 * payloads are shallow; the cap exists so a pathological value is REFUSED
 * rather than overflowing the host stack inside the walk.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxJsonDepth = 128

/**
 * The boundary's size budget, in units: one per node plus one per code unit
 * of every string and key. It bounds the serialized form well below the
 * length at which `JSON.stringify` throws, which is what keeps the
 * host-side stringify in the QuickJS bridge total.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxJsonSize = 8 * 1024 * 1024

const refused = { _tag: "Refused" } as const

/**
 * The bridge's strict JSON boundary, shared by every binding: only null,
 * finite numbers, strings, booleans, and acyclic plain objects/arrays
 * within {@link maxJsonDepth} and {@link maxJsonSize} cross, and what
 * crosses is a structural copy. Mirrors the check the QuickJS prelude
 * performs in-realm, so both runners refuse the same shapes with the same
 * message.
 *
 * The walk is TOTAL and SINGLE-READ. It builds the copy as it validates,
 * reading every property exactly once, so a getter or proxy trap that
 * answers differently on a second read cannot smuggle an unvalidated
 * subtree across; and it converts every throw — a throwing accessor, a
 * throwing `ownKeys` trap, a cycle, a depth or size overrun — into
 * `Refused`. A host handler returning something unserializable is a
 * rejected call the script can observe, never a defect.
 *
 * `undefined` is refused everywhere except as the whole value, where it
 * becomes `null`. Array holes read as `undefined` and are refused too:
 * `JSON.stringify` would silently rewrite them to `null`, and this
 * boundary never changes a value it accepts. The one exception is `-0`,
 * which JSON cannot represent at all and which crosses as `0`.
 *
 * @category gates
 * @since 0.1.0
 * @slop
 */
export const jsonBoundary = (
  value: unknown
): { readonly _tag: "Ok"; readonly value: unknown } | { readonly _tag: "Refused" } => {
  const seen = new Set<object>()
  let budget = maxJsonSize
  const spend = (units: number): void => {
    budget = budget - units
    if (budget < 0) throw refused
  }
  const copy = (candidate: unknown, depth: number): unknown => {
    if (depth > maxJsonDepth) throw refused
    spend(1)
    if (candidate === null || typeof candidate === "boolean") return candidate
    if (typeof candidate === "string") {
      spend(candidate.length)
      return candidate
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw refused
      // `-0` is the one value normalized rather than refused. JSON has no
      // negative zero, so it would survive here and become `0` the moment
      // the event was serialized — and the QuickJS binding, which encodes
      // in-realm, already hands `0` to the host. Normalizing keeps the two
      // bindings byte-identical and keeps a replayed payload comparable to
      // the journaled one.
      return candidate === 0 ? 0 : candidate
    }
    if (typeof candidate !== "object") throw refused
    if (seen.has(candidate)) throw refused
    seen.add(candidate)
    if (Array.isArray(candidate)) {
      // Read once: the doc promise is that no property is read twice, and a
      // proxy over an array can answer `length` differently each time.
      const length = candidate.length
      const copied: Array<unknown> = []
      for (let index = 0; index < length; index = index + 1) {
        copied.push(copy(candidate[index], depth + 1))
      }
      seen.delete(candidate)
      return copied
    }
    const prototype = Object.getPrototypeOf(candidate)
    if (prototype !== Object.prototype && prototype !== null) throw refused
    const copied: Record<string, unknown> = {}
    for (const key of Object.keys(candidate)) {
      spend(key.length)
      // Defined, never assigned. `copied.__proto__ = x` invokes the setter
      // Object.prototype inherits: the key would silently vanish from the
      // copy and the copy's PROTOTYPE would become an object this walk
      // validated as data. An own `__proto__` reaches here from any value
      // built with `Object.create(null)`, which the prototype check above
      // admits by design.
      Object.defineProperty(copied, key, {
        configurable: true,
        enumerable: true,
        value: copy((candidate as Record<string, unknown>)[key], depth + 1),
        writable: true
      })
    }
    seen.delete(candidate)
    return copied
  }
  try {
    return { _tag: "Ok", value: copy(value === undefined ? null : value, 0) }
  } catch {
    return refused
  }
}

/**
 * Renders a script failure value the way the QuickJS binding renders a
 * dumped realm error, so runtime failure messages match across runners.
 *
 * @category gates
 * @since 0.1.0
 * @slop
 */
export const failureMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { readonly message: unknown }).message)
    : String(error)

/**
 * The message every binding reports when a script's returned value is not
 * JSON — the first half of the shared outcome gate.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const unserializableOutcome = "the script returned a value that is not JSON-serializable"

/**
 * The message every binding reports when a script's returned value is JSON
 * but not one of the three outcomes — the second half of the shared gate.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const notAnOutcome = "the script did not return done(...), to(...), or park(...)"

/**
 * The message every binding rejects a `ctx.call` with when its input does
 * not cross the boundary. The QuickJS prelude interpolates it the way it
 * interpolates {@link maxJsonDepth}, so the in-realm refusal and the
 * host-side one are the same sentence by construction.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const unserializableInput = "ctx.call input must be JSON-serializable"

/**
 * The message every binding rejects a `ctx.call` with when its first
 * argument is not a call name.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const missingCallName = "ctx.call expects a call name as its first argument"

/**
 * The message every queued call settles with once a failed handler aborts
 * the link: the script may not catch its way past a gate, and the realm
 * must hold no dangling promise when its scope disposes it.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const abortedLink = "the link was aborted"

/**
 * The runtime failure every binding reports when nothing can advance the
 * script: it awaited something outside the one supported async door.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const neverSettles =
  "the script awaited something that never settles — the only thing worth awaiting is ctx.call"
