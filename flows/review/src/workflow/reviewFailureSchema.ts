import * as Schema from "effect/Schema";

/** Repository preparation failed before a review could start. */
export class ChangeSetUnreadable extends Schema.TaggedError<ChangeSetUnreadable>()("smithers-review/ChangeSetUnreadable", {
  repo: Schema.String,
  message: Schema.String,
}) {}

/** The rendered walkthrough could not be stored. */
export class WalkthroughUnwritable extends Schema.TaggedError<WalkthroughUnwritable>()("smithers-review/WalkthroughUnwritable", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** Operational failures preserved across every review round. */
export const ReviewFailure = Schema.Union([ChangeSetUnreadable, WalkthroughUnwritable]);

/** A diagnostic from a failed local operation. */
export const reasonOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
