/**
 * A tab-control refusal: retry, stop, wait, or a new cap on a tab that cannot
 * take it. The message is for the model; a person sees the sentence
 * `Failures` builds from `code` and `subject`.
 */
import { Data } from "effect"

export type Code =
  /** No worker tab or flow run has that id. */
  | "unknown_tab"
  /** Only a failed, stopped, or parked tab can be retried. */
  | "not_retryable"
  /** Only a worker stopped at its run cap takes a new cap. */
  | "not_capped"
  /** Only a failed tab can wait for a provider reset. */
  | "not_failed"
  /** The session is closing. */
  | "closed"
  /** This session has no flow host. */
  | "flows_unavailable"

export class TabError extends Data.TaggedError("TabError")<{
  readonly code: Code
  readonly message: string
  readonly subject?: string
}> {
  constructor(code: Code, message: string, subject?: string) {
    super({ code, message, ...(subject === undefined ? {} : { subject }) })
  }
}
