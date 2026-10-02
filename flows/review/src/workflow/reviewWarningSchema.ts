import * as Schema from "effect/Schema";
import { withDefault } from "../schema/withDefault.ts";

/**
 * Something the run could not do, reported beside the findings rather than
 * failing the review. A file review that failed arrives here as
 * `subtask_error`.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewWarning = Schema.Struct({
  file: withDefault(Schema.String, ""),
  message: withDefault(Schema.String, ""),
  type: withDefault(Schema.String, ""),
});

/**
 * A decoded warning.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewWarning = typeof ReviewWarning.Type;
