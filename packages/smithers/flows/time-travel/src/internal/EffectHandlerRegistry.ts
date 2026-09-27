/**
 * Immutable registry for effect-specific compensation handlers.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Assessment, Classification, type Handler } from "../CompensationHandlers.ts"
import { EffectRecord, EffectTier } from "../EffectBoundary.ts"
import { error, type TimeTravelError } from "../TimeTravelError.ts"

export {
  /**
   * The public preflight schemas, re-exported for the machinery that consumes
   * them. `CompensationHandlers` owns them because a handler author writes
   * against them.
   *
   * @since 0.1.0
   * @category models
   */
  Assessment,
  Classification,
  /**
   * The handler shape, re-exported for the same reason. There is ONE handler
   * type: the registry validates and resolves exactly what a contributor
   * wrote, so a second shape here could only drift from it.
   *
   * @since 0.1.0
   * @category models
   */
  type Handler
}

/**
 * Durable evidence produced after one handler reverses an effect.
 *
 * The receipt contains everything the same handler needs to reverse its
 * compensation during rewind rollback or startup recovery.
 *
 * @since 0.1.0
 * @category models
 */
export const RollbackReceipt = Schema.Struct({
  id: Schema.NonEmptyString,
  effect: EffectRecord,
  data: Schema.Unknown
})
/**
 * The value form of {@link RollbackReceipt}.
 *
 * @since 0.1.0
 * @category models
 */
export type RollbackReceipt = typeof RollbackReceipt.Type

/**
 * Immutable effect-handler lookup and execution operations.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly resolve: (kind: string) => Handler | undefined
  readonly assess: (effect: EffectRecord) => Effect.Effect<Assessment, TimeTravelError>
  readonly revert: (effect: EffectRecord) => Effect.Effect<RollbackReceipt, TimeTravelError>
  readonly rollback: (receipt: RollbackReceipt) => Effect.Effect<void, TimeTravelError>
}

/**
 * Layer-provided immutable effect-handler registry.
 *
 * @since 0.1.0
 * @category services
 */
export class EffectHandlerRegistry extends Context.Service<EffectHandlerRegistry, Service>()(
  "@smthrs/time-travel/EffectHandlerRegistry"
) {}

const duplicate = (kind: string): TimeTravelError => error("unknown", `effect handler ${kind} is already registered`)

const missing = (kind: string): TimeTravelError =>
  error("irreversible", `no compensation handler is registered for effect kind ${kind}`)

/**
 * What a registration must declare before the registry accepts it.
 *
 * The public `Handler` is a TypeScript interface, so a composition assembled
 * from untyped configuration can hand over an empty kind, an unknown tier, or
 * a non-boolean flag; each of those would silently resolve nothing or resolve
 * the wrong thing at rewind time, which is the worst moment to learn it.
 */
const Declaration = Schema.Struct({
  kind: Schema.NonEmptyString,
  tier: EffectTier,
  requiresIdempotencyKey: Schema.optional(Schema.Boolean),
  compensation: Schema.optional(Schema.NonEmptyString)
})

const validate = (handler: Handler): Effect.Effect<Handler, TimeTravelError> =>
  Effect.gen(function*() {
    yield* Schema.decodeUnknownEffect(Declaration)({
      kind: handler.kind,
      tier: handler.tier,
      requiresIdempotencyKey: handler.requiresIdempotencyKey,
      compensation: handler.compensation
    }).pipe(
      Effect.mapError((cause) => error("invalid", "effect handler declaration is invalid", cause))
    )
    for (const member of ["residue", "revert", "rollback"] as const) {
      if (typeof handler[member] !== "function") {
        return yield* Effect.fail(error("invalid", `effect handler ${handler.kind} has no ${member} function`))
      }
    }
    return handler
  })

/**
 * Why a handler is not the one that owns an effect's recorded compensation.
 *
 * An effect that recorded no descriptor resolves by kind alone, because the
 * producer that wrote it had nothing more to say. An effect that recorded one
 * is owned by exactly the handler declaring it: the descriptor exists so a
 * handler replaced after a restart cannot compensate evidence another
 * implementation left behind.
 */
const descriptorMismatch = (handler: Handler, effect: EffectRecord): string | undefined => {
  if (effect.compensation === undefined || handler.compensation === effect.compensation) return undefined
  return handler.compensation === undefined
    ? `Effect ${effect.id} recorded compensation ${effect.compensation}, which handler ${handler.kind} does not declare.`
    : `Effect ${effect.id} recorded compensation ${effect.compensation}, but handler ${handler.kind} implements ${handler.compensation}.`
}

const missingKey = (handler: Handler, effect: EffectRecord): string | undefined =>
  handler.requiresIdempotencyKey && effect.idempotencyKey === undefined
    ? `Effect ${effect.id} recorded no idempotency key, which handler ${handler.kind} requires.`
    : undefined

const fromHandlers = (handlers: HashMap.HashMap<string, Handler>): Service => {
  const resolve = (kind: string): Handler | undefined => Option.getOrUndefined(HashMap.get(handlers, kind))

  const service = EffectHandlerRegistry.of({
    resolve,
    assess: (effect) => {
      const handler = resolve(effect.kind)
      if (handler === undefined) {
        return Effect.succeed({
          classification: "blocking" as const,
          reason: `No compensation handler is registered for ${effect.kind}.`,
          residue: effect.residue ?? `The ${effect.kind} effect remains outside the journal.`
        })
      }
      const blocking = (reason: string): Assessment => ({
        classification: "blocking",
        reason,
        residue: handler.residue(effect)
      })
      if (handler.tier !== effect.tier) {
        return Effect.succeed(blocking(`Handler ${effect.kind} is registered for ${handler.tier}, not ${effect.tier}.`))
      }
      if (effect.status !== "succeeded") {
        return Effect.succeed(blocking(`Effect ${effect.id} has ${effect.status} completion state.`))
      }
      const refusal = descriptorMismatch(handler, effect) ?? missingKey(handler, effect)
      if (refusal !== undefined) return Effect.succeed(blocking(refusal))
      if (handler.assess === undefined) {
        return Effect.succeed({
          classification: "revertible" as const,
          reason: `Handler ${effect.kind} can compensate the recorded effect.`,
          residue: handler.residue(effect)
        })
      }
      // The custom verdict is decoded before anything acts on it. A handler
      // returning a classification outside the closed list was neither
      // blocked nor reverted, so the rewind truncated the effect's evidence
      // and left the effect standing.
      return handler.assess(effect).pipe(
        Effect.flatMap((verdict) =>
          Schema.decodeUnknownEffect(Assessment)(verdict).pipe(
            Effect.catch((issue) =>
              Effect.succeed(blocking(`Handler ${effect.kind} returned a malformed assessment: ${issue.message}`))
            )
          )
        )
      )
    },
    revert: (effect) => {
      const handler = resolve(effect.kind)
      if (handler === undefined) return Effect.fail(missing(effect.kind))
      if (handler.tier !== effect.tier) {
        return Effect.fail(
          error(
            "irreversible",
            `handler ${effect.kind} cannot compensate ${effect.tier} effect ${effect.id}`
          )
        )
      }
      const refusal = descriptorMismatch(handler, effect) ?? missingKey(handler, effect)
      if (refusal !== undefined) {
        return Effect.fail(error("irreversible", `handler ${effect.kind} cannot compensate ${effect.id}: ${refusal}`))
      }
      return handler.revert(effect).pipe(
        Effect.map((data) => ({
          id: `${effect.id}:rollback`,
          effect,
          data
        })),
        Effect.mapError((cause) =>
          error("compensation_failed", `handler ${effect.kind} could not revert ${effect.id}`, cause)
        )
      )
    },
    rollback: (receipt) => {
      const effect = receipt.effect
      const handler = resolve(effect.kind)
      if (handler === undefined) return Effect.fail(missing(effect.kind))
      // The receipt was produced by the handler that reverted the effect, and
      // a durable receipt outlives the composition that wrote it. A handler
      // registered for another tier, or declaring another compensation, is
      // not that handler, and running its rollback against a foreign receipt
      // would perform whatever the receipt's data happens to describe.
      const refusal = handler.tier !== effect.tier
        ? `handler ${effect.kind} is registered for ${handler.tier}, and the receipt records ${effect.tier}`
        : descriptorMismatch(handler, effect)
      if (refusal !== undefined) {
        return Effect.fail(
          error("compensation_failed", `handler ${effect.kind} cannot roll back ${effect.id}: ${refusal}`)
        )
      }
      return handler.rollback(effect, receipt.data).pipe(
        Effect.mapError((cause) =>
          error(
            "compensation_failed",
            `handler ${effect.kind} could not roll back compensation for ${effect.id}`,
            cause
          )
        )
      )
    }
  })
  return service
}

/**
 * Constructs an immutable registry, validating every declaration and
 * rejecting duplicate effect kinds before exposing it.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  handlers: Iterable<Handler> = []
): Effect.Effect<Service, TimeTravelError> =>
  Effect.gen(function*() {
    let registry = HashMap.empty<string, Handler>()
    for (const handler of handlers) {
      const valid = yield* validate(handler)
      if (HashMap.has(registry, valid.kind)) return yield* Effect.fail(duplicate(valid.kind))
      registry = HashMap.set(registry, valid.kind, valid)
    }
    return fromHandlers(registry)
  })

/**
 * Constructs an empty immutable registry.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (): Service => fromHandlers(HashMap.empty())

/**
 * Provides an immutable registry after validating all registrations.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  handlers: Iterable<Handler> = []
): Layer.Layer<EffectHandlerRegistry, TimeTravelError> => Layer.effect(EffectHandlerRegistry, make(handlers))

/**
 * Provides an empty immutable registry.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerNoop: Layer.Layer<EffectHandlerRegistry> = Layer.succeed(EffectHandlerRegistry, makeNoop())
