import { Effect, Logger } from "effect"
import type { PullRequestReviewPayload } from "./buildPullRequestReview.ts"
import type { PullRequestTarget } from "./resolvePullRequest.ts"
import { runGh as defaultRunGh } from "./runGh.ts"

// GitHub caps review bodies at 65536 chars; leave headroom for the folded note.
const MAX_FOLD_BODY = 64_000

/**
 * Fold the inline comments into the review body one at a time until the budget
 * is reached, so a large finding never gets cut mid-code-fence (a blind slice
 * of the joined string could truncate inside a ```suggestion block and corrupt
 * the render). Any findings that do not fit point to the full walkthrough.
 */
function foldCommentsIntoBody(payload: PullRequestReviewPayload): string {
  let body = `${payload.body}\n\n### Inline findings (could not anchor in the diff)\n\n`
  let appended = 0
  for (const comment of payload.comments) {
    const entry = `- \`${comment.path}:${comment.start_line ?? comment.line}\`\n\n${comment.body}`
    const candidate = appended === 0 ? `${body}${entry}` : `${body}\n\n${entry}`
    if (candidate.length > MAX_FOLD_BODY) break
    body = candidate
    appended += 1
  }
  const remaining = payload.comments.length - appended
  if (remaining > 0) {
    const note = `\n\n_…and ${remaining} more finding${remaining === 1 ? "" : "s"}; see the full walkthrough._`
    if (body.length + note.length <= MAX_FOLD_BODY) body += note
  }
  return body
}

/**
 * Post a review to the PR via `gh api`. GitHub rejects the whole batch (422,
 * typically mentioning "line" or "position") when any inline comment fails to
 * anchor in the diff, so on any failure the inline comments are folded into
 * the body and posted once more — a review is never lost. The 422 anchor case
 * is the expected trigger; folding on every error keeps transient anchor
 * validation drift (PR head moved between fetch and post) from dropping the
 * review.
 *
 * Returns the created review's id when GitHub reports one, so the caller can
 * retire its predecessors without retiring the replacement as well.
 */
export async function postPullRequestReview(
  repoDir: string,
  pr: PullRequestTarget,
  payload: PullRequestReviewPayload,
  runGh: typeof defaultRunGh = defaultRunGh
): Promise<{ url: string; inline: number; id?: number }> {
  const endpoint = `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
  const post = async (body: PullRequestReviewPayload) => {
    const raw = await runGh(repoDir, ["api", "--method", "POST", endpoint, "--input", "-"], JSON.stringify(body))
    return JSON.parse(raw) as { html_url?: string; id?: number }
  }

  try {
    const result = await post(payload)
    return {
      url: result.html_url ?? pr.url,
      inline: payload.comments.length,
      ...(result.id === undefined ? {} : { id: result.id })
    }
  } catch (error) {
    if (payload.comments.length === 0) throw error
    // Surface why the inline batch failed before falling back, or the reason
    // (rate limit, bad anchor, transient 5xx) is unrecoverable afterwards.
    await Effect.runPromise(
      Effect.logWarning(
        `smithers-review: inline comment batch failed, folding ${payload.comments.length} finding(s) into the body: ${
          (error as Error).message.slice(0, 300)
        }`
      ).pipe(Effect.provideService(Logger.LogToStderr, true))
    )
    const fallback: PullRequestReviewPayload = {
      ...payload,
      comments: [],
      body: foldCommentsIntoBody(payload)
    }
    const result = await post(fallback)
    return { url: result.html_url ?? pr.url, inline: 0, ...(result.id === undefined ? {} : { id: result.id }) }
  }
}
