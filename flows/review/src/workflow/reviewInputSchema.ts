/**
 * The review flow's own input: an OpenCodeReview target plus the walkthrough,
 * and verification switches.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema"
import { withDefault } from "../schema/withDefault.ts"
import { OpenCodeReviewInput } from "./openCodeReviewInputSchema.ts"

/**
 * The full review request.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewInput = Schema.Struct({
  ...OpenCodeReviewInput.fields,
  out: withDefault(Schema.String, ""),
  narrate: withDefault(Schema.Boolean, true),
  title: withDefault(Schema.String, ""),
  split: withDefault(Schema.Boolean, false),
  verify: withDefault(Schema.Boolean, true)
})

/**
 * The decoded review request.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewInput = typeof ReviewInput.Type
