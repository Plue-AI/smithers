/**
 * The single typed error returned by the file-routing surfaces.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"

/**
 * Stable failure codes for routing, parsing, loading, and decoding.
 *
 * @category models
 * @since 0.1.0
 */
export const Code = Schema.Literals([
  "root_missing",
  "read_failed",
  "invalid_root",
  "discovery_failed",
  "parse_failed",
  "unknown_command",
  "duplicate_route",
  "invalid_route",
  "resource_limit",
  "load_failed",
  "unsupported_body",
  "unsupported_schema",
  "decode_failed",
  "encode_failed",
  "invocation_unavailable"
])

/**
 * Stable failure codes for routing, parsing, loading, and decoding.
 *
 * @category models
 * @since 0.1.0
 */
export type Code = typeof Code.Type

/**
 * A recoverable file-routing failure.
 *
 * `method` names the surface that failed so a CLI or an agent can report the
 * origin without a stack trace. Raw argv, schema issues, and implementation
 * causes are deliberately not retained at this boundary.
 *
 * @category errors
 * @since 0.1.0
 */
export class FsError extends Schema.TaggedError<FsError>()("flows/fs/FsError", {
  code: Code,
  method: Schema.String,
  description: Schema.String,
  path: Schema.optional(Schema.String)
}) {}
