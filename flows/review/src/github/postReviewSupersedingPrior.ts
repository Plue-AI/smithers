import type { PullRequestReviewPayload } from "./buildPullRequestReview.ts";
import { postPullRequestReview } from "./postPullRequestReview.ts";
import type { PullRequestTarget } from "./resolvePullRequest.ts";
import { runGh as defaultRunGh } from "./runGh.ts";
import { supersedePriorReviews } from "./supersedePriorReviews.ts";

/**
 * Publish one review to the PR and retire the ones it replaces, in that order.
 *
 * The order is the point. Superseding first prefixes every earlier smithers
 * review with "Superseded by a newer smithers review." while the replacement
 * is still hypothetical: if the post and its fold-into-body fallback both
 * fail, or the process dies in between, the PR is left carrying nothing but
 * notes pointing at a review that does not exist. Posting first means a
 * predecessor is only annotated once its successor is on the PR, and a failed
 * post propagates with the older reviews untouched.
 *
 * Retiring the predecessors is best-effort and never fails a posted review:
 * `supersedePriorReviews` swallows its own errors, and it is skipped when
 * GitHub reports no id for the new review, since without one the sweep could
 * not tell the replacement apart from what it replaces.
 */
export async function postReviewSupersedingPrior(
  repoDir: string,
  pr: PullRequestTarget,
  payload: PullRequestReviewPayload,
  runGh: typeof defaultRunGh = defaultRunGh,
): Promise<{ url: string; inline: number; superseded: number }> {
  const posted = await postPullRequestReview(repoDir, pr, payload, runGh);
  const superseded =
    posted.id === undefined ? 0 : await supersedePriorReviews(repoDir, pr, posted.id, runGh);
  return { url: posted.url, inline: posted.inline, superseded };
}
