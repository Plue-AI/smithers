/**
 * Drafts a TODO from an install issue on this machine, for maintainers only.
 *
 * @since 1.0.0
 */

import { Refused, UsageError } from "../../CliError.ts"
import { type IssueDraftSource, issueTodoDraftRequest, readIssueTodoDraft } from "../../IssueTodoDraft.ts"
import { type Client, object } from "./Client.ts"

/**
 * Draft locally from the install's reader-bound snapshot; never create a TODO here.
 *
 * @since 1.0.0
 * @private
 */
export const draftFromIssue = async (client: Client, payload: Record<string, unknown>, signal?: AbortSignal) => {
  const number = payload.number
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw new UsageError({ message: "Expected a positive issue number" })
  }
  const thread = object(await client.request("GET", `/api/issues/${number}`))
  if (thread.make_todo_allowed !== true) {
    throw new Refused({
      fault: "policy",
      code: "forbidden",
      class: "permission",
      message: "Only a maintainer can make a TODO from this issue"
    })
  }
  const issue = object(thread.issue), user = object(issue.user)
  const invalid = () => new Refused({ fault: "infra", code: "backend_protocol", message: "Invalid issue snapshot" })
  if (
    issue.number !== number || typeof issue.title !== "string" || typeof issue.body !== "string" ||
    typeof issue.html_url !== "string" || typeof thread.issue_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(thread.issue_digest) || !Array.isArray(thread.comments)
  ) throw invalid()
  if (payload.repo != null) {
    let repository: string
    try {
      repository = new URL(issue.html_url).pathname.split("/").slice(1, 3).join("/")
    } catch {
      throw invalid()
    }
    if (typeof payload.repo !== "string" || payload.repo.toLowerCase() !== repository.toLowerCase()) {
      throw new UsageError({ message: "The issue belongs to another repository" })
    }
  }
  const comments = thread.comments.map((value: unknown) => {
    const comment = object(value), author = object(comment.user)
    if (typeof comment.body !== "string" || (comment.user != null && typeof author.login !== "string")) throw invalid()
    return { author: typeof author.login === "string" ? author.login : null, body: comment.body }
  })
  const source: IssueDraftSource = {
    number,
    title: issue.title,
    body: issue.body,
    url: issue.html_url,
    author: typeof user.login === "string" ? user.login : null,
    digest: thread.issue_digest,
    comments
  }
  const response = await client.response(
    "POST",
    "/api/model/stream",
    issueTodoDraftRequest(source),
    signal ? { signal } : {}
  )
  let draft: ReturnType<typeof readIssueTodoDraft>
  try {
    draft = readIssueTodoDraft(await client.text(response, 16 * 1024 * 1024))
  } catch {
    throw new Refused({ fault: "infra", code: "backend_protocol", message: "Could not draft this issue" })
  }
  return { ...draft, issue: number, issue_digest: source.digest, fixes: true, place: { mode: "append" } }
}
