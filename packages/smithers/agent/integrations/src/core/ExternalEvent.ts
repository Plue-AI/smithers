/**
 * The normalized event every integration source produces.
 *
 * A webhook delivery and a long-poll update arrive in different shapes from
 * different providers. Both are decoded into one `ExternalEvent` before
 * anything downstream sees them, so the control-plane binding is written once
 * rather than once per provider.
 *
 * @since 1.0.0
 */

import { Schema } from "effect"
import { isEventName } from "./SignalName.ts"

/**
 * A decoded external event.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ExternalEvent = Schema.Struct({
  /** The source that produced it: `github`. */
  source: Schema.NonEmptyString,
  /**
   * The signal name, `integration:<service>:<event>`.
   *
   * The same refinement `SignalName.eventName` builds against, so a name that
   * module could not have produced, such as one whose event segment carries a
   * second colon, cannot enter persistence and become a routing identity
   * nothing can rebuild.
   */
  eventName: Schema.String.pipe(
    Schema.refine(isEventName, { expected: "an integration signal name SignalName.eventName could build" })
  ),
  /** What the event is about, or `null` when it addresses nothing narrower. */
  correlationId: Schema.NullOr(Schema.String),
  /** The provider payload, as delivered. */
  payload: Schema.Json,
  /** The provider's stable delivery identity, used to drop redeliveries. */
  dedupeKey: Schema.NonEmptyString,
  /** When the event was received, in Unix milliseconds. */
  receivedAtMs: Schema.Number
})

/**
 * A decoded external event.
 *
 * @category models
 * @since 1.0.0
 */
export type ExternalEvent = typeof ExternalEvent.Type

/**
 * Decodes an unknown value as an {@link ExternalEvent}.
 *
 * Sources decode their own output through this at the ingress boundary, so a
 * decoder bug fails loudly there instead of surfacing as a malformed signal
 * three hops later.
 *
 * @category constructors
 * @since 1.0.0
 */
export const decode = Schema.decodeUnknownEffect(ExternalEvent)
