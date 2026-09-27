/**
 * Typed failures of one model host turn.
 *
 * Each failure names where the turn stopped, so a log line or a metric can
 * tell a provider outage from a journal fencing refusal without reading cause
 * text. Messages are fixed strings and status codes only: provider and
 * transport causes can carry signed requests and never reach these values.
 *
 * @since 1.0.0-rc.1
 */

import { Data } from "effect"

/**
 * The trusted host could not resolve the owner's configured model.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export class ResolveFailed extends Data.TaggedError("ResolveFailed")<{ readonly message: string }> {}

/**
 * The durable producer endpoint could not be reached.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export class ProducerUnreachable extends Data.TaggedError("ProducerUnreachable")<{
  readonly message: string
  readonly step: "provider_started" | "commit"
}> {}

/**
 * The durable producer refused the provider-start acknowledgment.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export class ProviderStartRefused extends Data.TaggedError("ProviderStartRefused")<{
  readonly message: string
  readonly status: number
}> {}

/**
 * The durable producer refused a frame commit, for example a lost fence.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export class CommitRefused extends Data.TaggedError("CommitRefused")<{
  readonly message: string
  readonly status: number
}> {}

/**
 * A commit receipt was malformed or did not extend the committed cursor.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export class ReceiptMismatch extends Data.TaggedError("ReceiptMismatch")<{ readonly message: string }> {}

/**
 * Every failure the durable producer reports.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export type ProducerError = ProducerUnreachable | ProviderStartRefused | CommitRefused | ReceiptMismatch
