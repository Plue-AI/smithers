/**
 * The verifier's answer: one verdict per finding index.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
import { arrayOf, withDefault } from "../schema/withDefault.ts";
import { ReviewCommentSeverity } from "./reviewCommentSeveritySchema.ts";

/**
 * One verdict. `index` defaults to -1 so a verdict that lost its index is
 * ignored instead of silently targeting finding 0.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FindingVerdict = Schema.Struct({
  index: withDefault(Schema.Number, -1),
  verdict: withDefault(Schema.Literals(["keep", "drop", "demote"]), "keep" as const),
  severity: Schema.optional(ReviewCommentSeverity),
  reason: withDefault(Schema.String, ""),
});

/**
 * The decoded verdict.
 *
 * @since 1.0.0
 * @category models
 */
export type FindingVerdict = typeof FindingVerdict.Type;

/**
 * Every verdict the verifier produced.
 *
 * @since 1.0.0
 * @category schemas
 */
export const VerifyVerdicts = Schema.Struct({
  verdicts: arrayOf(FindingVerdict),
});

/**
 * The decoded verdict set.
 *
 * @since 1.0.0
 * @category models
 */
export type VerifyVerdicts = typeof VerifyVerdicts.Type;
