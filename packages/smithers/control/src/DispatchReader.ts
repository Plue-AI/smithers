/**
 * Read port from the control plane into a trigger store.
 *
 * `Control.list` answers `{ _tag: "triggers" }` and `{ _tag: "fires" }` through
 * this port. The port lives here rather than in `@smthrs/triggers` because that
 * package already depends on this one (its scheduler launches runs through
 * `Control`), so the adapter over a real `TriggerStore` is composed by the host
 * and the plane only ever sees the interface.
 *
 * A composition that provides no reader, or provides {@link layerNone}, makes
 * `Control.list` refuse the two variants with a typed `InvalidInput` naming the
 * gap. It never answers an empty page: an empty page means "this host has no
 * triggers", and a host that cannot read its store has no grounds to say so.
 *
 * @since 1.0.0
 */

import { Context, Effect, Layer } from "effect"
import type { ControlError } from "./ControlError.ts"
import { InvalidInput } from "./ControlError.ts"
import type { FireSummary, ListRequest, TriggerSummary } from "./ControlSchema.ts"

/**
 * The `triggers` listing request as the port receives it.
 *
 * @category models
 * @since 1.0.0
 */
export type TriggersRequest = Extract<ListRequest, { readonly _tag: "triggers" }>

/**
 * The `fires` listing request as the port receives it.
 *
 * @category models
 * @since 1.0.0
 */
export type FiresRequest = Extract<ListRequest, { readonly _tag: "fires" }>

/**
 * The reader `Control.list` pages trigger and fire rows from.
 *
 * Each method receives the whole request and answers every row it has for it,
 * newest fire first. A reader may narrow by the request's `filters` (a SQL
 * adapter pushes them into the query); `Control.list` applies the same filters
 * again and pages the rows with `cursor` and `limit`, so a reader that returns
 * every row is still correct. Paging stays in the plane so both variants page
 * exactly as `flows` and `runs` do.
 *
 * @category services
 * @since 1.0.0
 */
export interface Service {
  readonly list: (request: TriggersRequest) => Effect.Effect<ReadonlyArray<TriggerSummary>, ControlError>
  readonly fires: (request: FiresRequest) => Effect.Effect<ReadonlyArray<FireSummary>, ControlError>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 1.0.0
 */
export class DispatchReader extends Context.Service<DispatchReader, Service>()(
  "/control/DispatchReader"
) {}

/**
 * The refusal a host without a trigger store answers both variants with.
 *
 * @category constants
 * @since 1.0.0
 */
export const noStoreIssue = "this host serves no trigger store"

/**
 * The typed refusal for a host without a trigger store: `InvalidInput` with
 * code `invalid_input` and {@link noStoreIssue} as the issue, the same shape
 * `Control.list` refuses an unsupported run filter with.
 *
 * @category constructors
 * @since 1.0.0
 */
export const refuse = (): InvalidInput => new InvalidInput({ issue: noStoreIssue })

/**
 * Builds a {@link Service} from an implementation of its methods.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (implementation: Service): Service => DispatchReader.of(implementation)

/**
 * A {@link Service} that serves no trigger store: both methods fail with
 * {@link refuse}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeNone = (): Service =>
  make({
    list: Effect.fn("DispatchReader.list")(() => Effect.fail(refuse())),
    fires: Effect.fn("DispatchReader.fires")(() => Effect.fail(refuse()))
  })

/**
 * Provides {@link DispatchReader} from an implementation.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (implementation: Service): Layer.Layer<DispatchReader> =>
  Layer.succeed(DispatchReader)(make(implementation))

/**
 * Provides {@link makeNone}: a reader that refuses both listings because this
 * host serves no trigger store.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerNone: Layer.Layer<DispatchReader> = Layer.succeed(DispatchReader)(makeNone())
