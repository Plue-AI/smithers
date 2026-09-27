/**
 * The variables panel: what the realm holds, stated every frame.
 *
 * A run's memory is not a JSON document the cell filed — it is the set of names
 * the realm is holding, and the model can only act on what the prompt says about
 * them. This is what the prompt says.
 *
 * Every line is a name, its type, one *cheap* size, and when it was last bound.
 * Nothing here is serialized whole: a panel that stringified every global would
 * pay the heap for it every frame, and the value the model wants is already
 * under the name the panel prints.
 *
 * Freshness is derived from the cheap size, which is what makes the panel cost
 * nothing. A binding rewritten to a value of the same type and the same size —
 * a 40-character string replaced by a different 40-character string — reads as
 * unchanged and keeps its stamp. That bound is stated rather than hidden: the
 * panel is a roster, and the run's own prints are what say a value moved.
 *
 * @since 0.1.0
 */

import { Effect, Schema } from "effect"
import * as CallLedger from "./CallLedger.ts"
import * as elide from "./internal/elide.ts"
import { NonNegativeSafeInt } from "./internal/nonNegativeSafeInt.ts"

/**
 * How many names the panel prints before it starts counting instead.
 *
 * Sixty-four is the same order as `CallLedger` `bound` and well above what a
 * round near par binds: the five golfed instances hold between 6 and 21 names
 * at their last frame. A run past the bound is shown its most recently bound
 * names and told how many older ones it still holds.
 *
 * @category constants
 * @since 0.1.0
 */
export const bound = 64

/**
 * One name the realm holds, with the cheap facts a probe can read off it.
 *
 * `size` is already rendered by the probe — a string's length, an array's
 * length, an object's key count, a function's arity, a number or boolean by
 * value — because the value itself never crosses the realm boundary.
 *
 * @category models
 * @since 0.1.0
 */
export class Binding extends Schema.Class<Binding>("flows/harness/VariablesPanel/Binding")({
  name: Schema.String,
  /**
   * The name's JavaScript type, `unset` for a name a throw left unassigned, or
   * `unreadable` for one whose value the probe could not even read — a throwing
   * accessor, a proxy that refuses its own keys. The two are named apart because
   * they say different things: one name holds nothing, the other holds something
   * that will not be looked at.
   */
  type: Schema.String,
  /** One cheap measure of the value, already rendered; empty when there is none. */
  size: Schema.String
}) {}

/**
 * One name the realm holds, with the frames that first and last bound it.
 *
 * @category models
 * @since 0.1.0
 */
export class Stamp extends Schema.Class<Stamp>("flows/harness/VariablesPanel/Stamp")({
  name: Schema.String,
  type: Schema.String,
  size: Schema.String,
  /** The frame whose cell last changed the binding's cheap shape. */
  frame: NonNegativeSafeInt,
  /** The frame whose cell first bound the name. */
  since: NonNegativeSafeInt
}) {}

/**
 * Every name the realm holds, with the frames that bound it.
 *
 * @category models
 * @since 0.1.0
 */
export const Ledger = Schema.Array(Stamp).pipe(
  Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Stamp>>([])),
  Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<Stamp>>([]))
)

/**
 * Every name the realm holds, with the frames that bound it.
 *
 * @category models
 * @since 0.1.0
 */
export type Ledger = typeof Ledger.Type

/**
 * Re-stamps the panel against the bindings a frame closed on.
 *
 * A name whose type and size are unchanged keeps both of its frames, so the
 * panel says when a binding last moved rather than that every name was touched
 * again. A name the realm no longer reports is dropped: a `var` global cannot
 * be deleted, so the only way a name leaves the probe's answer is the realm
 * being rebuilt, and a roster that outlived its realm would be a lie.
 *
 * @category combinators
 * @since 0.1.0
 */
export const stamp = (known: Ledger, bindings: ReadonlyArray<Binding>, frame: number): Ledger => {
  const previous = new Map(known.map((entry) => [entry.name, entry] as const))
  return bindings.map((binding) => {
    const before = previous.get(binding.name)
    if (before === undefined) {
      return new Stamp({ name: binding.name, type: binding.type, size: binding.size, frame, since: frame })
    }
    return before.type === binding.type && before.size === binding.size
      ? before
      : new Stamp({ name: binding.name, type: binding.type, size: binding.size, frame, since: before.since })
  })
}

/** Names how a binding stands relative to the frame that just ran. */
const marked = (entry: Stamp, frame: number): string => {
  if (entry.since === frame) return "new this frame"
  if (entry.frame === frame) return "changed this frame"
  const age = frame - entry.frame
  return `bound at frame ${entry.frame}, ${age} frame${age === 1 ? "" : "s"} ago`
}

/**
 * Renders the panel for one frame's prompt.
 *
 * `frame` is the frame whose cell just ran, which is what `new` and `changed`
 * are relative to.
 *
 * @category conversions
 * @since 0.1.0
 */
export const render = (options: {
  readonly ledger: Ledger
  readonly frame: number
}): string => {
  if (options.ledger.length === 0) {
    return "Your realm holds no names yet. Anything a cell declares at the top level is still bound in every later cell of this run."
  }
  const ordered = [...options.ledger].sort((left, right) => left.frame - right.frame)
  const listed = ordered.slice(Math.max(0, ordered.length - bound))
  const uncounted = ordered.length - listed.length
  const lines = listed.map((entry) =>
    elide.head(
      `- ${entry.name} (${entry.type}${entry.size === "" ? "" : `, ${entry.size}`}) — ${marked(entry, options.frame)}`,
      CallLedger.width,
      "the name is what recalls the value"
    )
  )
  return [
    `Names your realm holds (${options.ledger.length}), least recently bound first. Read and compute with these instead of fetching them again:`,
    ...lines,
    ...(uncounted > 0
      ? [`- … and ${uncounted} older name${uncounted === 1 ? "" : "s"} not listed here; they are still bound.`]
      : [])
  ].join("\n")
}
