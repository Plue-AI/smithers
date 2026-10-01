/**
 * Typed host connectivity failures, including failed command diagnostics.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"

/**
 * A temporarily unreachable resolver, connection, or HTTP service.
 *
 * @category errors
 * @since 1.0.0
 */
export class Unreachable extends Schema.TaggedError<Unreachable>()("@smthrs/kernel/Unreachable", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

const outage =
  /Could not resolve host|Failed to connect to|Connection timed out|Operation timed out|Connection reset|Recv failure|Network is unreachable|Temporary failure in name resolution|SSL_ERROR_SYSCALL|The remote end hung up unexpectedly|\bEAI_AGAIN\b|\bENOTFOUND\b|\bHTTP(?:\/\d(?:\.\d)?)?\s*(?:(?:error|status|code)\s*[:=]?\s*)?[:=]?\s*(?:429|5\d{2})\b/i

/**
 * Classifies stderr from a failed host command; other exits keep their domain error.
 *
 * @category constructors
 * @since 1.0.0
 */
export const classifyExit = (stderr: string): Unreachable | undefined =>
  outage.test(stderr) ? new Unreachable({ message: stderr }) : undefined
