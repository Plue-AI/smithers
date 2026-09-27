/**
 * The registration door for compensation handlers.
 *
 * Handlers could arrive through one of two doors: a construction argument on `TimeTravel.layer`, or
 * handlers contributed by the engine composition that owns the effect boundary
 * — either way without re-exposing `EffectHandlerRegistry`, which is machinery
 * and stays under `internal/`.
 *
 * **The pick is the contribution door.** The adapter that performed a tier-3
 * effect owns its compensation (`docs/guides/compensate-an-effect.md`), and the composition that wires that adapter is the only place that can close
 * over the services its `revert` needs. A construction argument on
 * `TimeTravel.layer` would have put that knowledge on whoever assembles the
 * app, one layer away from the boundary it describes. This service is
 * therefore OPTIONAL: a composition with no irreversible adapters provides
 * nothing and every crossed effect still assesses as blocking, which is the
 * pre-existing, safe behaviour.
 *
 * What stays hidden is the registry, not the handler. A caller writes a
 * {@link Handler} and provides {@link layer}; it never sees `HashMap`,
 * `register`, or the immutable-service dance behind them.
 *
 * ```ts
 * import { CompensationHandlers } from "@smthrs/time-travel"
 * import * as Effect from "effect/Effect"
 *
 * const refund = CompensationHandlers.layer([{
 *   kind: "billing/charge",
 *   tier: "irreversible",
 *   residue: (effect) => `Charge ${effect.id} was refunded, not un-charged.`,
 *   revert: (effect) => Effect.succeed({ refunded: effect.id }),
 *   rollback: () => Effect.void
 * }])
 * ```
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { EffectRecord, EffectTier } from "./EffectBoundary.ts"
import type { TimeTravelError } from "./TimeTravelError.ts"

/**
 * A handler's preflight verdict on one crossed effect: `revertible` means the
 * rewind compensates it, `warning` means it stands and the rewind discloses
 * it, `blocking` means the rewind is refused.
 *
 * @since 0.1.0
 * @category models
 */
export const Classification = Schema.Literals(["revertible", "warning", "blocking"])
/**
 * The value form of {@link Classification}.
 *
 * @since 0.1.0
 * @category models
 */
export type Classification = typeof Classification.Type

/**
 * A handler's preflight result: the {@link Classification}, why, and the
 * operator-facing `residue` that remains outside the journal if the boundary
 * is crossed.
 *
 * A custom `assess` is decoded against this schema before a rewind acts on
 * it. A result that does not decode assesses as `blocking`, so a handler bug
 * can refuse a rewind but never let one through.
 *
 * @since 0.1.0
 * @category models
 */
export const Assessment = Schema.Struct({
  classification: Classification,
  reason: Schema.String,
  residue: Schema.String
})
/**
 * The value form of {@link Assessment}.
 *
 * @since 0.1.0
 * @category models
 */
export type Assessment = typeof Assessment.Type

/**
 * One adapter's compensation for the effects it performs.
 *
 * Handlers are closed values: everything `assess`, `revert`, and `rollback`
 * need must be captured when the handler is built, because a rewind resolves
 * them outside the composition that produced the effect.
 *
 * `revert` returns whatever the handler needs to undo ITS OWN compensation —
 * that value becomes the durable rollback receipt a failed rewind replays
 * through `rollback`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Handler {
  /** The effect kind this compensates — the action name the engine journaled. */
  readonly kind: string
  /** The tier this handler is valid for. A mismatch assesses as blocking. */
  readonly tier: EffectTier
  /**
   * Whether an idempotency key is required for the compensation to be safe.
   * When true, an effect recorded without one assesses as blocking and is
   * never reverted.
   */
  readonly requiresIdempotencyKey?: boolean | undefined
  /**
   * The compensation descriptor this handler implements, matched against the
   * `compensation` the adapter recorded on the effect's boundary. An effect
   * that recorded a descriptor resolves only to the handler declaring the
   * same one: a handler swapped in after a restart with a different
   * descriptor assesses as blocking, refuses to revert, and refuses to roll a
   * receipt back. An effect that recorded none resolves by `kind` alone.
   */
  readonly compensation?: string | undefined
  /** Operator-facing disclosure of what remains outside the journal. */
  readonly residue: (effect: EffectRecord) => string
  /** Optional refinement of the default `revertible` verdict. */
  readonly assess?: ((effect: EffectRecord) => Effect.Effect<Assessment, TimeTravelError>) | undefined
  /** Performs the compensation and returns its rollback material. */
  readonly revert: (effect: EffectRecord) => Effect.Effect<unknown, TimeTravelError>
  /**
   * Undoes a compensation this handler performed, from the receipt `revert`
   * returned. A rewind that fails after compensating replays these in reverse,
   * so this is REQUIRED even when the answer is "nothing to undo": a silent
   * default would make a handler that forgot to write one indistinguishable
   * from one that deliberately has nothing to do.
   */
  readonly rollback: (effect: EffectRecord, receipt: unknown) => Effect.Effect<void, TimeTravelError>
}

/**
 * The handlers a composition contributes to time travel.
 *
 * @since 0.1.0
 * @category services
 */
export class CompensationHandlers extends Context.Service<CompensationHandlers, ReadonlyArray<Handler>>()(
  "@smthrs/time-travel/CompensationHandlers"
) {}

/**
 * Provides a set of handlers.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (handlers: ReadonlyArray<Handler>): Layer.Layer<CompensationHandlers> =>
  Layer.succeed(CompensationHandlers)(handlers)

/**
 * Provides no handlers — the default, and what a composition with no
 * irreversible adapters wants.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerNoop: Layer.Layer<CompensationHandlers> = layer([])
