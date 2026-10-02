import { ReviewCommentSeverity } from "../workflow/reviewCommentSeveritySchema.ts";

/**
 * A severity's position in `ReviewCommentSeverity.literals`, most severe first;
 * an unknown level ranks as `minor`.
 */
export function rankSeverity(severity: string) {
  const rank = ReviewCommentSeverity.literals.indexOf(severity as ReviewCommentSeverity);
  return rank === -1 ? ReviewCommentSeverity.literals.indexOf("minor") : rank;
}
