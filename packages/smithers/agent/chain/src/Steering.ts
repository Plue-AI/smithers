/**
 * The steering port: messages from outside the chain, drained at link
 * boundaries into author-call context.
 *
 * The port is shaped so the notifications package's durable queue slots
 * in as the production binding when the engine mounts; the in-memory
 * layer is the stand-in. Chains that provide no steering service run
 * unchanged and journal identically — the chain looks the service up
 * optionally (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */

import { Context, Effect, Layer, Ref, Schema } from "effect"

/**
 * A steering queue that cannot be admitted to or drained.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class SteeringError extends Schema.TaggedError<SteeringError>()("/chain/SteeringError", {
  code: Schema.Literal("steering_unavailable").pipe(
    Schema.withConstructorDefault(Effect.succeed("steering_unavailable"))
  ),
  message: Schema.String
}) {}

/**
 * The two operations the chain needs: admit a message from outside, and
 * drain the queue at a named link boundary.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly admit: (message: string) => Effect.Effect<void, SteeringError>
  /**
   * Takes every queued message. The boundary names the journal position
   * the drain feeds (`link/ordinal`, or `chain/link/ordinal` for a named
   * root), so a durable binding can make the take exactly-once by deduping
   * on it; the in-memory binding ignores it
   * and accepts the volatile loss window that implies.
   */
  readonly drain: (boundary: string) => Effect.Effect<ReadonlyArray<string>, SteeringError>
}

/**
 * The steering service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Steering extends Context.Service<Steering, Service>()("/chain/Steering") {}

/**
 * Builds a steering port from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => Steering.of(implementation)

const unavailable = (operation: string): SteeringError => new SteeringError({ message: `${operation} is unavailable` })

/**
 * A steering port whose every operation fails as unavailable, with
 * per-operation overrides — the default a test starts from.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    admit: Effect.fn("Steering.admit")(() => Effect.fail(unavailable("admit"))),
    drain: Effect.fn("Steering.drain")(() => Effect.fail(unavailable("drain"))),
    ...overrides
  })

/**
 * The unavailable steering port as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Steering> =>
  Layer.succeed(Steering)(makeNoop(overrides))

/**
 * An in-memory steering queue: `admit` appends, `drain` takes everything.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerMemory = (initial: ReadonlyArray<string> = []): Layer.Layer<Steering> => {
  // Snapshot now, not when the lazy layer is later built: a caller may
  // mutate its seed after constructing the layer but before providing it.
  const snapshot = [...initial]
  return Layer.effect(Steering)(
    Effect.gen(function*() {
      const ref = yield* Ref.make<ReadonlyArray<string>>(snapshot)
      return make({
        admit: Effect.fn("Steering.admit")((message) => Ref.update(ref, (queue) => [...queue, message])),
        drain: Effect.fn("Steering.drain")(() => Ref.getAndSet(ref, []))
      })
    })
  )
}
