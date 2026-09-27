/**
 * The host seam that watches one model-backed step while it runs.
 *
 * {@link module:Agent} exposes a `Stream<AgentEvent>`; {@link module:AgentAction}
 * consumes it to produce one decoded value. The sink receives each emitted
 * agent event while the overall step runs.
 *
 * With {@link module:FlowEngineLike}, model deltas arrive at the sealed model-call boundary,
 * after the provider stream settles. That adapter records the complete provider
 * stream before emitting its events. The sink does not report live provider
 * progress. A replay emits the recorded events again without calling the provider.
 *
 * The service is optional. `AgentAction` resolves it with
 * `Effect.serviceOption`, so a composition that provides none behaves exactly
 * as it did before this module existed, and providing one changes nothing
 * about the step's answer, its correction budget, or its failures.
 *
 * Observer sinks consume the public stream. The native durable sink sets
 * `atSource`: the controller awaits its checkpoint before advancing or
 * parking. Each checkpoint commits its bounded fact with its own durable
 * outcome, before the enclosing agent action can settle. Provider work stays
 * outside the checkpoint's SQL transaction.
 *
 * @since 0.1.0
 */

import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type { StepFact } from "@smthrs/journal"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * Builds the engine-owned source checkpoint sink for a native handler.
 * @category constructors
 * @since 1.0.0
 */
export { make as durable } from "./internal/StepTrace.ts"

/**
 * The sink: one event in, nothing out.
 *
 * Ordinary observers handle delivery failures themselves. A durable source
 * sink propagates typed storage defects: a step cannot report successful
 * completion when its required facts failed to commit.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly emit: (event: AgentEvent.AgentEvent, step?: StepFact.Step) => Effect.Effect<void>
  /** Checkpoint at the controller source, before it advances or parks. */
  readonly atSource?: boolean
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class EventSink extends Context.Service<EventSink, Service>()(
  "@smthrs/agent/EventSink"
) {}

/**
 * Builds a {@link Service} from an implementation of its one method.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => EventSink.of(implementation)

/**
 * A {@link Service} that drops every event.
 *
 * This is what a composition that provides no sink already does, written down
 * so a test can provide the absence explicitly. Overrides replace the method.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    emit: () => Effect.void,
    ...overrides
  })

/**
 * Provides {@link EventSink} from an implementation.
 *
 * @example
 * ```ts
 * import * as EventSink from "@smthrs/agent/EventSink"
 * import * as Effect from "effect/Effect"
 *
 * const frames: Array<string> = []
 * const layer = EventSink.layer({
 *   emit: (event) => Effect.sync(() => frames.push(event._tag))
 * })
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (implementation: Service): Layer.Layer<EventSink> => Layer.succeed(EventSink)(make(implementation))

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<EventSink> =>
  Layer.succeed(EventSink)(makeNoop(overrides))
