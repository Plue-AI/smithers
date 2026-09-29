/**
 * The single typed error returned by every standard flow handler.
 *
 * @since 1.0.0
 */

import { Schema } from "effect"

/**
 * Stable, model-facing failure codes shared by the standard flows.
 *
 * @category models
 * @since 1.0.0
 */
export const Code = Schema.Literals([
  "not_found",
  "not_a_directory",
  "not_a_file",
  "is_directory",
  "binary_file",
  "offset_out_of_range",
  "invalid_pattern",
  "invalid_input",
  "no_match",
  "not_modified",
  "permission_denied",
  "outside_declared_reads",
  "outside_declared_writes",
  "command_failed",
  "request_failed",
  "timeout",
  "rate_limited",
  "provider_unavailable",
  "unsupported",
  "unsupported_content_type",
  "response_too_large",
  "outside_container"
])

/**
 * Stable, model-facing failure codes shared by the standard flows.
 *
 * @category models
 * @since 1.0.0
 */
export type Code = typeof Code.Type

/**
 * A recoverable standard-flow failure.
 *
 * Handlers keep ordinary outcomes (a non-zero exit code, an empty match set)
 * in the success channel; this error is reserved for failures the model must
 * see as failures.
 *
 * @category errors
 * @since 1.0.0
 */
export class StdError extends Schema.TaggedError<StdError>()("@smthrs/std/StdError", {
  code: Code,
  message: Schema.String,
  path: Schema.optional(Schema.String),
  /** Language-server request that failed. */
  method: Schema.optional(Schema.String),
  /** JSON-RPC diagnostics, bounded by the transport's maximum frame size. */
  rpcError: Schema.optional(Schema.Struct({
    code: Schema.Number,
    message: Schema.String,
    data: Schema.optional(Schema.Unknown)
  })),
  /** At most 64 KiB of the language server's most recent stderr. */
  stderr: Schema.optional(Schema.String),
  /** The limit a `timeout` ran past, in milliseconds, when the flow knows it. */
  limitMillis: Schema.optional(Schema.Number)
}) {}
