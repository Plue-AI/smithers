/**
 * Typed failures surfaced by the workspace gateway.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"

/**
 * Stable failure codes exposed by gateway operations.
 *
 * @since 0.1.0
 * @category errors
 */
export const GatewayErrorCode = Schema.Literals([
  "bind_failed",
  "invalid_host",
  "invalid_origin",
  "unauthorized",
  "malformed_request",
  "request_too_large",
  "resource_limit",
  "run_unavailable",
  "run_not_found"
])

/**
 * A stable gateway failure code.
 *
 * @since 0.1.0
 * @category errors
 */
export type GatewayErrorCode = typeof GatewayErrorCode.Type

/**
 * A normalized gateway operation failure.
 *
 * @since 0.1.0
 * @category errors
 */
export class GatewayError extends Schema.TaggedError<GatewayError>()("@smthrs/gateway/GatewayError", {
  code: GatewayErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Struct({
    _tag: Schema.String,
    code: Schema.optional(Schema.String)
  }))
}) {}

/**
 * The refusal a numeric setting earns when it is not a positive safe integer,
 * or `undefined` when the gateway can run under it.
 *
 * The keepalive cadence and the request body limit are the same kind of
 * setting and are checked the same way. A cadence of zero turns the keepalive
 * into a tight loop and a body limit of zero refuses every request, so a
 * composition that asks for either is refused before it binds rather than
 * after it is serving.
 *
 * @param name what the value configures, named as the message will read
 * @param value the configured value, or undefined to accept the default
 * @since 1.0.0
 * @category constructors
 */
export const settingRefusal = (name: string, value: number | undefined): GatewayError | undefined =>
  value === undefined || (Number.isSafeInteger(value) && value > 0)
    ? undefined
    : new GatewayError({
      code: "bind_failed",
      message: `${name} must be a positive safe integer, not ${value}`
    })
