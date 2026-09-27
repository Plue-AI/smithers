/**
 * Provider error classification.
 *
 * Every integration failure is one `IntegrationError` carrying a
 * machine-readable {@link Reason}. A caller maps the reason to whatever its
 * transport needs, `invalid-signature` to 401 and `permission-denied` to 403,
 * without reading message text, and the control plane maps it to a typed
 * `ControlError` at the channel boundary.
 *
 * Details are provider-safe by construction: no constructor in this package
 * ever puts a token, an API key, or a webhook secret into `details`.
 *
 * @since 1.0.0
 */

import { InvalidInput, Unauthorized } from "@smthrs/control/ControlError"
import { hasSmithersErrorShape, SmithersError } from "@smthrs/errors/SmithersError"

/**
 * Every classification an integration failure can carry, in one runtime list.
 *
 * {@link Reason} is derived from it and `core/ActionFailure.ts` builds the
 * action-boundary schema from it, so adding a reason is a single edit and the
 * durable error schema cannot drift from the class.
 *
 * @category models
 * @since 1.0.0
 */
export const reasons = [
  "invalid-config",
  "invalid-signature",
  "decode-failed",
  "poll-failed",
  "delivery-failed",
  "credentials-missing",
  "permission-denied",
  "listener-conflict"
] as const

/**
 * What went wrong, coarsely enough for a caller to act on.
 *
 * @category models
 * @since 1.0.0
 */
export type Reason = typeof reasons[number]

/**
 * Whether `value` is a classification this build can encode.
 *
 * `reason` is a type, not a runtime check: the constructor stores whatever it
 * is given, so a JavaScript caller or a widened cast can put a string outside
 * {@link reasons} on a real `IntegrationError`. Exported because the refinement
 * and the action-boundary conversion both have to answer this the same way. A
 * value one accepts and the other refuses is how a throw gets into
 * `Effect.mapError`, where it becomes a defect rather than a typed failure.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isReason = (value: unknown): value is Reason => reasons.includes(value as Reason)

/**
 * A failure raised by an integration client, webhook source, or listener
 * reconciliation.
 *
 * @category errors
 * @since 1.0.0
 */
export class IntegrationError extends SmithersError {
  /** The machine-readable classification. */
  readonly reason: Reason

  constructor(
    reason: Reason,
    message: string,
    details?: Record<string, unknown>,
    options?: { readonly cause?: unknown }
  ) {
    super("INTEGRATION_ERROR", message, { reason, ...details }, {
      cause: options?.cause,
      name: "IntegrationError"
    })
    this.reason = reason
  }
}

/**
 * Whether `error` is an {@link IntegrationError}.
 *
 * The name check catches an error that crossed a module-instance boundary,
 * where `instanceof` alone would miss it. A name alone is not enough: it is
 * forgeable, and an error from a copy of this module whose reason list has
 * drifted carries a `reason` this instance cannot encode. So the name branch
 * also requires the shape the conversions read, and anything else falls
 * through to the caller's unclassified path instead of throwing there.
 * Every structural read is guarded because a property getter on a
 * caller-supplied error is executable code; one that throws answers `false`.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isIntegrationError = (error: unknown): error is IntegrationError => {
  try {
    if (
      !(error instanceof Error) ||
      (!(error instanceof IntegrationError) && error.name !== "IntegrationError") ||
      !hasSmithersErrorShape(error) ||
      error.code !== "INTEGRATION_ERROR"
    ) return false
    const reason = Object.getOwnPropertyDescriptor(error, "reason")
    return reason !== undefined && "value" in reason && isReason(reason.value)
  } catch {
    return false
  }
}

/**
 * Whether the failure is worth another attempt. Set by the clients on the
 * responses that a retry can plausibly clear.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isRetryable = (error: unknown): boolean =>
  isIntegrationError(error) && error.details?.["retryable"] === true

/**
 * Maps a failure onto the control plane's `Unauthorized`.
 *
 * Only the reason reaches the control plane. A verifier that leaked which
 * byte of a digest mismatched would be a verification oracle.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toUnauthorized = (error: IntegrationError): Unauthorized => new Unauthorized({ message: error.summary })

/**
 * Maps a failure onto the control plane's `InvalidInput`.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toInvalidInput = (error: IntegrationError): InvalidInput => new InvalidInput({ issue: error.summary })
