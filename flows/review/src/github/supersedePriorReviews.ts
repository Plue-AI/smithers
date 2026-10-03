import { Effect, Logger } from "effect"
import type { PullRequestTarget } from "./resolvePullRequest.ts"
import { runGh as defaultRunGh, runGhJsonLines } from "./runGh.ts"

const MARKER = "<!-- smithers-review -->"
// Re-running the sweep is a no-op: a body that already starts with this
// prefix is skipped, so a retry after a partial failure adds nothing twice.
const SUPERSEDED_PREFIX = "Superseded by a newer smithers review."
// GitHub caps review bodies at 65536 characters; leave room for the prefix.
const MAX_UPDATED_BODY = 64_000

/**
 * Mark earlier smithers reviews on the PR as superseded once the replacement
 * has been posted: list the PR's reviews, find ones by the replacement's author
 * whose body carries the smithers marker, and prefix their body with a
 * superseded note via `PUT /pulls/{n}/reviews/{id}` (the update-review
 * endpoint accepts a body update; dismissal is a different endpoint and needs
 * a dismissable state).
 *
 * `newReviewId` is the replacement's id and is required, not optional: taking
 * it forces the caller to have posted first, so a run that dies or fails on
 * the way to GitHub can never leave the PR carrying only superseded notes. The
 * list read after the POST contains the replacement, and its author is the
 * identity that posted it, so no `GET /user` is needed. That endpoint answers
 * 403 to the action's installation token. Only reviews created before the
 * replacement (smaller ids) are swept, so it never supersedes itself or a
 * newer review from an overlapping run.
 *
 * Best-effort by design: any failure returns 0 and the posted review stands.
 */
export async function supersedePriorReviews(
  repoDir: string,
  pr: PullRequestTarget,
  newReviewId: number,
  runGh: typeof defaultRunGh = defaultRunGh
): Promise<number> {
  try {
    const records = await runGhJsonLines(
      repoDir,
      [
        "api",
        "--paginate",
        `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
        "--jq",
        ".[] | {id, body, login: .user.login} | @json"
      ],
      runGh
    )
    const reviews = records as Array<{ id?: unknown; body?: unknown; login?: unknown }>
    const login = reviews.find((review) => review.id === newReviewId)?.login
    if (typeof login !== "string" || !login) {
      await Effect.runPromise(
        Effect.logWarning(
          `smithers-review: new review ${newReviewId} missing from the PR's review list; nothing superseded`
        ).pipe(Effect.provideService(Logger.LogToStderr, true))
      )
      return 0
    }
    let superseded = 0
    for (const review of reviews) {
      if (typeof review.id !== "number" || typeof review.body !== "string") continue
      // Only predecessors: GitHub review ids grow with creation, so a review
      // with a larger id was posted after this one by an overlapping run and
      // must stay current even if this sweep finishes last.
      if (review.id >= newReviewId) continue
      if (review.login !== login) continue
      if (!review.body.includes(MARKER) || review.body.startsWith(SUPERSEDED_PREFIX)) continue
      const updated = `${SUPERSEDED_PREFIX}\n\n${review.body}`.slice(0, MAX_UPDATED_BODY)
      try {
        await runGh(
          repoDir,
          [
            "api",
            "--method",
            "PUT",
            `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews/${review.id}`,
            "--input",
            "-"
          ],
          JSON.stringify({ body: updated })
        )
        superseded += 1
      } catch (error) {
        await Effect.runPromise(
          Effect.logWarning(
            `smithers-review: could not mark prior review ${review.id} superseded: ${
              (error as Error).message.slice(0, 200)
            }`
          ).pipe(Effect.provideService(Logger.LogToStderr, true))
        )
      }
    }
    return superseded
  } catch (error) {
    await Effect.runPromise(
      Effect.logWarning(
        `smithers-review: supersede check failed (non-fatal): ${(error as Error).message.slice(0, 200)}`
      ).pipe(Effect.provideService(Logger.LogToStderr, true))
    )
    return 0
  }
}
