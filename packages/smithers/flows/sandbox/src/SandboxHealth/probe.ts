/**
 * Probes sandbox liveness under a deadline.
 *
 * @since 0.1.0
 */

import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { boundedMessage } from "../internal/boundedMessage.ts"
import type { HealthState } from "./HealthState.ts"
import { Healthy } from "./Healthy.ts"
import type { PingProvider } from "./PingProvider.ts"
import type { ProbeOptions } from "./ProbeOptions.ts"
import { Unhealthy } from "./Unhealthy.ts"

/**
 * Default deadline used when a probe does not specify one.
 *
 * @private
 * @since 0.1.0
 */
const defaultDeadline: Duration.Input = "5 seconds"

/**
 * Runs one ping under a deadline and reports a typed health state.
 *
 * A failed ping becomes `Unhealthy(reason: "ping_failed")`; a ping that
 * outlives the deadline becomes `Unhealthy(reason: "unresponsive")`. The
 * probe opens a `SandboxHealth.probe` span annotated with the outcome.
 *
 * A failed ping is logged at debug level as its provider `code` and its
 * `message`, bounded at 512 characters with control characters collapsed, and
 * the verdict carries that same bounded message. The `ProviderError` itself,
 * and above all its `cause`, never reaches a logger from here: adapters attach
 * raw vendor errors there, which can quote credentials, request headers,
 * proxies, or response bodies, and rendering an arbitrary object can throw or
 * run without bound. A host that wants the raw failure taps the ping it hands
 * in, `Effect.tapError` on `PingProvider.ping`, and applies its own redaction.
 *
 * @category constructors
 * @since 0.1.0
 */
export const probe = (
  provider: PingProvider,
  options?: ProbeOptions
): Effect.Effect<HealthState> =>
  Effect.timeoutOrElse(
    Effect.matchEffect(provider.ping, {
      onSuccess: (): Effect.Effect<HealthState> => Effect.succeed(new Healthy()),
      onFailure: (error): Effect.Effect<HealthState> => {
        const message = boundedMessage(error.message)
        return Effect.logDebug("sandbox ping failed", { code: error.code, message }).pipe(
          Effect.as(
            new Unhealthy({
              component: "sandbox",
              reason: "ping_failed",
              message
            })
          )
        )
      }
    }),
    {
      duration: options?.deadline ?? defaultDeadline,
      orElse: () =>
        Effect.succeed<HealthState>(
          new Unhealthy({
            component: "sandbox",
            reason: "unresponsive",
            message: "sandbox ping did not answer within the probe deadline"
          })
        )
    }
  ).pipe(
    Effect.tap((state) => Effect.annotateCurrentSpan({ outcome: state._tag === "Healthy" ? "healthy" : state.reason })),
    Effect.withSpan("SandboxHealth.probe", {}, { captureStackTrace: false })
  )
