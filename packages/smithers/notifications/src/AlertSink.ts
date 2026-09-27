/**
 * The alert sink port: where a raised alert is sent, and why a send failed.
 *
 * The port is a tag and an error so a deployment supplies the transport and
 * the policy needs none. `./layerWebhook.ts` is the transport this package
 * ships, and {@link layerNoop} is the one a test composes.
 *
 * @since 1.0.0
 */

import { Context, Effect, Layer, Schema } from "effect"
import type { Alert } from "./AlertPolicy.ts"

/**
 * Why a sink did not take an alert.
 *
 * `sink_rejected` is an answer that refused the page, `sink_unreachable` a
 * request that never got one, and `sink_timeout` one that got no answer inside
 * the sink's bound. `sink_misconfigured` is an endpoint the sink may not POST
 * to at all; it is raised when the layer is built, before any alert exists,
 * so it never reaches a journal.
 *
 * @category models
 * @since 1.0.0
 */
export const FailureCode = Schema.Literals(["sink_rejected", "sink_unreachable", "sink_timeout", "sink_misconfigured"])

/**
 * Why a sink did not take an alert.
 *
 * @category models
 * @since 1.0.0
 */
export type FailureCode = typeof FailureCode.Type

/**
 * A sink refused or could not take an alert.
 *
 * The error carries a code, the answering status when there was one, and a
 * short reason. It deliberately holds no request: a webhook request carries
 * the credential the deployment handed {@link layerWebhook}, and an error is
 * logged, encoded, and journaled in places a credential must never reach.
 *
 * @category errors
 * @since 0.1.0
 */
export class AlertError extends Schema.TaggedError<AlertError>()(
  "/notifications/AlertError",
  {
    code: FailureCode.pipe(Schema.withConstructorDefault(Effect.succeed("sink_rejected" as const))),
    message: Schema.String,
    /** The HTTP status that refused the page, when the sink speaks HTTP. */
    status: Schema.optional(Schema.Int),
    /** A short, credential-free description of the transport failure. */
    reason: Schema.optional(Schema.String)
  }
) {}

/**
 * Where a raised alert is sent.
 *
 * Injected rather than fixed, because who gets paged is a deployment's
 * decision and the policy is not: the same rules feed a webhook in production
 * and nothing at all in a test.
 *
 * @category services
 * @since 0.1.0
 */
export interface SinkService {
  /**
   * Sends one alert, and does so idempotently on {@link alertId}.
   *
   * Delivery is at-least-once: the `flows.alerts.delivered` record is written
   * after this effect succeeds, so a process that dies in between pages again
   * on the next tick. Every field of the alert, {@link Alert.firedAt}
   * included, is derived from the journal, so the same alert is byte-identical
   * on every attempt and `alertId(alert)` is the deduplication key a receiving
   * system should key on. A sink that cannot dedupe is a sink that will
   * occasionally page twice about one condition.
   *
   * A failure means the page did not go out. Succeeding on a page that was
   * dropped is the one thing this port must never do.
   */
  readonly deliver: (alert: Alert) => Effect.Effect<void, AlertError>
}

/**
 * The {@link SinkService} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class Sink extends Context.Service<Sink, SinkService>()("/notifications/AlertSink") {}

/**
 * A sink that accepts every alert and sends it nowhere.
 *
 * The admission and the delivery record still happen, so a composition without
 * an outbound channel still has the durable evidence of what it would have
 * paged about.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Sink> = Layer.succeed(Sink)({ deliver: () => Effect.void })
