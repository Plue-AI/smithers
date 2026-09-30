/**
 * The host seam that turns a declared seat string into a live model.
 *
 * A flow declares `model: anthropic:claude-sonnet-4-5` and an action declares
 * `seat: "anthropic:claude-sonnet-4-5"`. Neither declaration carries an API
 * key, an endpoint, or a client, and that is the whole point: a declaration is
 * portable, so the credentialed half has to live somewhere the declaration
 * cannot reach. This service is that half. `@smthrs/cli`'s `NodeControl`
 * installs the resolver that reads keys from the environment; a test installs
 * one that answers with a scripted model and never touches the network.
 *
 * Because the resolver owns the seat vocabulary, a host is free to define its
 * own. The `provider:modelId` convention is what the Node resolver understands,
 * not a rule the agent enforces — a resolver that maps `reviewer` onto a
 * particular model is an ordinary implementation of this one method. The
 * returned seat retains `id: "reviewer"` and supplies the provider model id in
 * `modelId` for generation and compaction.
 *
 * @since 1.0.0-rc.0
 */

import { HarnessError } from "@smthrs/harness/HarnessError"
import * as ModelCatalog from "@smthrs/model/ModelCatalog"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Seat from "./Seat.ts"
import type * as SeatRouter from "./SeatRouter.ts"

/**
 * The resolver: one seat string in, one resolved seat out.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export interface Service {
  readonly resolve: (id: string) => Effect.Effect<Seat.Seat, Seat.SeatUnresolved>
  /**
   * How the host routes `id` by the routing graph instead of resolving it to
   * one seat, as a declared {@link Seat.auto} routes: a host that maps a role
   * to `auto` answers here with the phase the role routes as. `undefined`,
   * or no method, resolves `id` as declared.
   */
  readonly routedAs?: ((id: string) => Routed | undefined) | undefined
}

/**
 * A seat id the host routes by the graph: the phase it routes as, or
 * `undefined` for Jev to classify.
 *
 * @category models
 * @since 1.0.0
 */
export interface Routed {
  readonly phase: SeatRouter.Phase | undefined
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export class SeatResolver extends Context.Service<SeatResolver, Service>()(
  "@smthrs/agent/SeatResolver"
) {}

/**
 * Builds a {@link Service} from an implementation of its one method.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = (implementation: Service): Service => SeatResolver.of(implementation)

/**
 * A {@link Service} that resolves nothing.
 *
 * Refusing is the honest default: a composition with no configured resolver has
 * no credentials, and inventing a model here would turn a missing key into a
 * failed provider call halfway through a run. Overrides replace the method.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    resolve: (id) => Effect.fail(new Seat.SeatUnresolved({ seat: id, message: "No seat resolver is configured" })),
    ...overrides
  })

/**
 * Provides {@link SeatResolver} from an implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (implementation: Service): Layer.Layer<SeatResolver> =>
  Layer.succeed(SeatResolver)(make(implementation))

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<SeatResolver> =>
  Layer.succeed(SeatResolver)(makeNoop(overrides))

/**
 * The context window, in tokens, of a known model id, with a conservative
 * floor for models the catalog has not met. Never zero: zero is `CellTurn`'s
 * "compaction disabled", and a resolver that resolves a window must not
 * silently disable it.
 *
 * @category resolvers
 * @since 1.0.0-rc.0
 */
export const contextWindowTokensFor = ModelCatalog.contextWindowTokensFor

/**
 * Resolves steered context budgets through the host's seat vocabulary.
 *
 * @category resolvers
 * @since 1.0.0-rc.0
 */
export const contextWindowResolver = (self: Service): (id: string) => Effect.Effect<number, HarnessError> => (id) =>
  self.resolve(id).pipe(
    Effect.map((seat) => seat.contextWindowTokens),
    Effect.mapError((cause) => new HarnessError({ code: "assembly_failed", message: cause.message, cause }))
  )
