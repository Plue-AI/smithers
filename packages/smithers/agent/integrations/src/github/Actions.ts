/**
 * The durable GitHub actions.
 *
 * {@link GitHubClient} is the host layer: it knows rate limits, pagination,
 * and token hygiene, and it is an ordinary Effect service. An `Action` is what
 * makes one of its calls a step of a durable flow, so a plan can name it, the
 * journal can record its result, and a restart replays it instead of posting
 * a second comment.
 *
 * Each action is declared here and implemented by {@link layer}. A flow body
 * calls `CommentOnIssue.call(...)`, which records a plan node and nothing
 * else; the layer is what a composition provides to make that node runnable.
 *
 * The write-back actions ({@link AddLabels}, {@link UpsertComment},
 * {@link CheckRun}, {@link LinkPullRequest}) read before they write. Each looks
 * for what an earlier attempt may already have done — a label already on the
 * issue, a comment carrying its key, a check run under its external id, a
 * closing reference already in the pull request — and only writes what is
 * missing. That makes a repeat safe, so they declare an `idempotencyKey` and a
 * bounded {@link retryPolicy}: a write whose answer was lost, or a process that
 * died mid-step, is resumed by repeating the step, and the repeat finds its own
 * work instead of doing it twice. They stay `irreversible`, because a reader
 * sees the change the moment GitHub accepts it.
 *
 * The limit: GitHub enforces neither the comment marker nor a check run's
 * `external_id` as unique. A write still in flight at GitHub when the repeat
 * reads can land after it, and then both exist. The engine's backoff and a
 * restart's delay make that window narrow, not closed; an upsert then edits the
 * oldest match.
 *
 * @since 1.0.0
 */

import { Action, type FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import { fromIntegrationError, IntegrationFailure } from "../core/ActionFailure.ts"
import { IntegrationError } from "../core/IntegrationError.ts"
import { GitHubClient } from "./GitHubClient.ts"
import { IssueNumber, Owner, Repo, requireRepositoryPath } from "./Repository.ts"

/**
 * What {@link CommentOnIssue} needs.
 *
 * `issueNumber` is GitHub's issue or pull-request number. GitHub numbers both
 * in one sequence, so the same action comments on either.
 *
 * The three coordinates are validated rather than merely encoded, because they
 * become the request path and `new URL` resolves `..` inside one. A payload
 * built from a webhook body or a model's output therefore cannot walk the
 * token-bearing POST to another GitHub endpoint: it fails to decode.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CommentOnIssuePayload = Schema.Struct({
  owner: Owner,
  repo: Repo,
  issueNumber: IssueNumber,
  body: Schema.String
})

/**
 * The comment GitHub created.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Comment = Schema.Struct({
  id: Schema.Number,
  url: Schema.String
})

/**
 * Posts a comment on an issue or pull request.
 *
 * The tier is `irreversible`: the comment is visible the moment GitHub
 * accepts it, and deleting it afterwards is a different call with a different
 * outcome, so the engine must never retry this step on its own. Nor does the
 * client underneath: a 5xx or a dropped connection on the POST reports
 * `outcomeUnknown` rather than posting a second comment.
 *
 * @category actions
 * @since 1.0.0
 */
export const CommentOnIssue = Action.make("integrations/github/comment-on-issue", {
  payload: CommentOnIssuePayload,
  success: Comment,
  error: IntegrationFailure,
  tier: "irreversible"
})

/**
 * Implements {@link CommentOnIssue} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerCommentOnIssue: Layer.Layer<
  Action.Requirement<"integrations/github/comment-on-issue">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = CommentOnIssue.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(payload.owner, payload.repo)
    return yield* client.request(
      "POST",
      `/repos/${repository}/issues/${payload.issueNumber}/comments`,
      { body: payload.body },
      { schema: Comment }
    )
  }).pipe(Effect.mapError(fromIntegrationError))
)

/**
 * The engine retry policy of the write-back actions.
 *
 * Three attempts, half a second then a second apart. Each attempt reads
 * before it writes, so a repeat after a lost answer finds the first
 * attempt's work rather than doing it again.
 *
 * @category constants
 * @since 1.0.0
 */
export const retryPolicy: RetryPolicy.RetryPolicy = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 5_000,
  maxAttempts: 3
})

/**
 * How many pages of 100 a reconciling read walks before it gives up.
 *
 * @category constants
 * @since 1.0.0
 */
export const RECONCILE_PAGES = 10

const refused = (operation: string, message: string): IntegrationError =>
  new IntegrationError("delivery-failed", message, { operation, retryable: false, outcomeUnknown: false })

const decodeItems = <A>(schema: Schema.Codec<A>, items: ReadonlyArray<unknown>): ReadonlyArray<A> => {
  const decode = Schema.decodeUnknownOption(schema)
  const decoded: Array<A> = []
  for (const item of items) {
    const value = decode(item)
    if (value._tag === "Some") decoded.push(value.value)
  }
  return decoded
}

/**
 * A GitHub label name.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LabelName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50))

/**
 * What {@link AddLabels} needs.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AddLabelsPayload = Schema.Struct({
  owner: Owner,
  repo: Repo,
  issueNumber: IssueNumber,
  labels: Schema.NonEmptyArray(LabelName)
})

/**
 * What {@link AddLabels} reports: the labels it added, and every label the
 * issue carries afterwards. `added` is empty when an earlier attempt already
 * added them all.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LabelsAdded = Schema.Struct({
  added: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String)
})

/**
 * Adds labels to an issue or pull request, keeping the ones it has.
 *
 * GitHub compares label names without case, and so does the check for the
 * labels already present.
 *
 * @category actions
 * @since 1.0.0
 */
export const AddLabels = Action.make("integrations/github/add-labels", {
  payload: AddLabelsPayload,
  success: LabelsAdded,
  error: IntegrationFailure,
  tier: "irreversible",
  implementationVersion: "github/add-labels/v1",
  idempotencyKey: (payload) => ({
    action: "integrations/github/add-labels",
    owner: payload.owner,
    repo: payload.repo,
    issueNumber: payload.issueNumber,
    labels: [...payload.labels]
  }),
  retryPolicy
})

const Label = Schema.Struct({ name: Schema.String })

/**
 * Implements {@link AddLabels} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerAddLabels: Layer.Layer<
  Action.Requirement<"integrations/github/add-labels">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = AddLabels.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* GitHubClient
      const repository = yield* requireRepositoryPath(payload.owner, payload.repo)
      const path = `/repos/${repository}/issues/${payload.issueNumber}/labels`
      const page = yield* client.paginate(path, { maxPages: RECONCILE_PAGES })
      const current = decodeItems(Label, page.items).map((label) => label.name)
      const present = new Set(current.map((name) => name.toLowerCase()))
      const missing = [...new Set(payload.labels)].filter((name) => !present.has(name.toLowerCase()))
      if (missing.length === 0) return { added: [], labels: current }
      const labels = yield* client.request("POST", path, { labels: missing }, { schema: Schema.Array(Label) })
      return { added: missing, labels: labels.map((label) => label.name) }
    }).pipe(Effect.mapError(fromIntegrationError)),
  { implementationVersion: "github/add-labels/v1" }
)

/**
 * The name a sticky comment is found by: letters, digits and `._:/-`, such as
 * a run id.
 *
 * @category schemas
 * @since 1.0.0
 */
export const StickyKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:/-]{1,200}$/))

/**
 * The hidden first line that marks a sticky comment as `key`'s.
 *
 * @category constructors
 * @since 1.0.0
 */
export const stickyMarker = (key: string): string => `<!-- smithers:key=${key} -->`

/**
 * What {@link UpsertComment} needs.
 *
 * `key` names the comment. A flow passes its run id to keep one progress
 * comment per run; every upsert under that key edits the same comment.
 *
 * @category schemas
 * @since 1.0.0
 */
export const UpsertCommentPayload = Schema.Struct({
  owner: Owner,
  repo: Repo,
  issueNumber: IssueNumber,
  key: StickyKey,
  body: Schema.String
})

/**
 * What {@link UpsertComment} did to the comment.
 *
 * @category schemas
 * @since 1.0.0
 */
export const UpsertOutcome = Schema.Literals(["created", "updated", "unchanged"])

/**
 * The sticky comment, and what the step did to it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const StickyComment = Schema.Struct({
  id: Schema.Number,
  url: Schema.String,
  outcome: UpsertOutcome
})

/**
 * Creates or edits the one comment `key` names on an issue or pull request.
 *
 * The comment's first line is {@link stickyMarker}, which GitHub renders as
 * nothing. The action looks for it among the thread's comments, then edits
 * that comment, leaves it alone when it already reads as asked, or posts it.
 * A thread longer than {@link RECONCILE_PAGES} pages fails rather than risk a
 * second comment.
 *
 * @category actions
 * @since 1.0.0
 */
export const UpsertComment = Action.make("integrations/github/upsert-comment", {
  payload: UpsertCommentPayload,
  success: StickyComment,
  error: IntegrationFailure,
  tier: "irreversible",
  implementationVersion: "github/upsert-comment/v1",
  idempotencyKey: (payload) => ({
    action: "integrations/github/upsert-comment",
    owner: payload.owner,
    repo: payload.repo,
    issueNumber: payload.issueNumber,
    key: payload.key,
    body: payload.body
  }),
  retryPolicy
})

const ListedComment = Schema.Struct({ id: Schema.Number, url: Schema.String, body: Schema.optional(Schema.String) })

/**
 * Implements {@link UpsertComment} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerUpsertComment: Layer.Layer<
  Action.Requirement<"integrations/github/upsert-comment">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = UpsertComment.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* GitHubClient
      const repository = yield* requireRepositoryPath(payload.owner, payload.repo)
      const marker = stickyMarker(payload.key)
      const body = `${marker}\n${payload.body}`
      const page = yield* client.paginate(`/repos/${repository}/issues/${payload.issueNumber}/comments`, {
        maxPages: RECONCILE_PAGES
      })
      const existing = decodeItems(ListedComment, page.items).find((comment) =>
        comment.body?.split("\n", 1)[0] === marker
      )
      if (existing === undefined && page.truncated) {
        return yield* Effect.fail(
          refused(
            "upsert-comment",
            `Issue ${payload.issueNumber} has more comments than ${RECONCILE_PAGES} pages; the sticky comment was not looked for further.`
          )
        )
      }
      if (existing === undefined) {
        const created = yield* client.request(
          "POST",
          `/repos/${repository}/issues/${payload.issueNumber}/comments`,
          { body },
          { schema: Comment }
        )
        return { ...created, outcome: "created" as const }
      }
      if (existing.body === body) return { id: existing.id, url: existing.url, outcome: "unchanged" as const }
      const updated = yield* client.request(
        "PATCH",
        `/repos/${repository}/issues/comments/${existing.id}`,
        { body },
        { schema: Comment }
      )
      return { ...updated, outcome: "updated" as const }
    }).pipe(Effect.mapError(fromIntegrationError)),
  { implementationVersion: "github/upsert-comment/v1" }
)

/**
 * A commit SHA, SHA-1 or SHA-256, in lowercase hex.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CommitSha = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))

/**
 * A check run's `output`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CheckRunOutput = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  text: Schema.optionalKey(Schema.String)
})

/**
 * What {@link CheckRun} needs.
 *
 * `key` becomes the check run's `external_id`, which is how a repeat finds
 * it. A flow reports progress by calling again under the same key with a new
 * `status`; `conclusion` is required once `status` is `completed`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CheckRunPayload = Schema.Struct({
  owner: Owner,
  repo: Repo,
  headSha: CommitSha,
  name: Schema.String.check(Schema.isMinLength(1)),
  key: StickyKey,
  status: Schema.optionalKey(Schema.Literals(["queued", "in_progress", "completed"])),
  conclusion: Schema.optionalKey(
    Schema.Literals(["action_required", "cancelled", "failure", "neutral", "success", "skipped", "timed_out"])
  ),
  detailsUrl: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(CheckRunOutput)
})

/**
 * The check run as GitHub left it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CheckRunReceipt = Schema.Struct({
  id: Schema.Number,
  url: Schema.NullOr(Schema.String),
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  created: Schema.Boolean
})

/**
 * Creates or updates the check run `key` names on a commit.
 *
 * Writing check runs needs a GitHub App installation token; GitHub refuses a
 * personal token with 403.
 *
 * @category actions
 * @since 1.0.0
 */
export const CheckRun = Action.make("integrations/github/check-run", {
  payload: CheckRunPayload,
  success: CheckRunReceipt,
  error: IntegrationFailure,
  tier: "irreversible",
  implementationVersion: "github/check-run/v1",
  idempotencyKey: (payload) => ({
    action: "integrations/github/check-run",
    ...(payload as unknown as Record<string, Schema.Json>)
  }),
  retryPolicy
})

const ListedCheckRun = Schema.Struct({
  id: Schema.Number,
  external_id: Schema.NullOr(Schema.String),
  html_url: Schema.NullOr(Schema.String),
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String)
})

const CheckRuns = Schema.Struct({ total_count: Schema.Number, check_runs: Schema.Array(Schema.Unknown) })

/**
 * Implements {@link CheckRun} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerCheckRun: Layer.Layer<
  Action.Requirement<"integrations/github/check-run">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = CheckRun.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* GitHubClient
      const repository = yield* requireRepositoryPath(payload.owner, payload.repo)
      const listed = yield* client.request(
        "GET",
        `/repos/${repository}/commits/${payload.headSha}/check-runs`,
        undefined,
        {
          query: { check_name: payload.name, filter: "all", per_page: 100 },
          schema: CheckRuns
        }
      )
      const runs = decodeItems(ListedCheckRun, listed.check_runs)
      const existing = runs.find((run) => run.external_id === payload.key)
      if (existing === undefined && listed.total_count > listed.check_runs.length) {
        return yield* Effect.fail(
          refused("check-run", `Commit ${payload.headSha} has more than 100 "${payload.name}" check runs.`)
        )
      }
      const fields = {
        name: payload.name,
        external_id: payload.key,
        ...(payload.status === undefined ? {} : { status: payload.status }),
        ...(payload.conclusion === undefined ? {} : { conclusion: payload.conclusion }),
        ...(payload.detailsUrl === undefined ? {} : { details_url: payload.detailsUrl }),
        ...(payload.output === undefined ? {} : { output: payload.output })
      }
      const written = existing === undefined
        ? yield* client.request("POST", `/repos/${repository}/check-runs`, { ...fields, head_sha: payload.headSha }, {
          schema: ListedCheckRun
        })
        : yield* client.request("PATCH", `/repos/${repository}/check-runs/${existing.id}`, fields, {
          schema: ListedCheckRun
        })
      return {
        id: written.id,
        url: written.html_url,
        status: written.status,
        conclusion: written.conclusion,
        created: existing === undefined
      }
    }).pipe(Effect.mapError(fromIntegrationError)),
  { implementationVersion: "github/check-run/v1" }
)

/**
 * What {@link LinkPullRequest} needs.
 *
 * The issue is in the pull request's repository unless `issueOwner` and
 * `issueRepo` name another.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LinkPullRequestPayload = Schema.Struct({
  owner: Owner,
  repo: Repo,
  pullNumber: IssueNumber,
  issueNumber: IssueNumber,
  issueOwner: Schema.optionalKey(Owner),
  issueRepo: Schema.optionalKey(Repo)
})

/**
 * The pull request, the reference it carries, and whether the step added it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PullRequestLinked = Schema.Struct({
  pullNumber: Schema.Number,
  url: Schema.String,
  reference: Schema.String,
  updated: Schema.Boolean
})

/**
 * Links a pull request to the issue it resolves.
 *
 * The link is GitHub's own: a `Closes <issue>` line in the pull request's
 * description, which shows the pull request under the issue's Development
 * section and closes the issue when it merges. A description that already
 * closes the issue, in any of GitHub's closing keywords, is left alone.
 *
 * @category actions
 * @since 1.0.0
 */
export const LinkPullRequest = Action.make("integrations/github/link-pr", {
  payload: LinkPullRequestPayload,
  success: PullRequestLinked,
  error: IntegrationFailure,
  tier: "irreversible",
  implementationVersion: "github/link-pr/v1",
  idempotencyKey: (payload) => ({
    action: "integrations/github/link-pr",
    owner: payload.owner,
    repo: payload.repo,
    pullNumber: payload.pullNumber,
    issueNumber: payload.issueNumber,
    issueOwner: payload.issueOwner ?? payload.owner,
    issueRepo: payload.issueRepo ?? payload.repo
  }),
  retryPolicy
})

const PullRequest = Schema.Struct({ html_url: Schema.String, body: Schema.NullOr(Schema.String) })

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Whether `body` already closes issue `issueNumber` of `owner/repo`, written
 * from the pull request's repository `sameRepository` or not.
 *
 * @category predicates
 * @since 1.0.0
 */
export const closesIssue = (
  body: string,
  issue: { readonly owner: string; readonly repo: string; readonly issueNumber: number },
  sameRepository: boolean
): boolean => {
  const qualified = `${escapeRegExp(issue.owner)}/${escapeRegExp(issue.repo)}`
  const target = sameRepository ? `(?:${qualified})?#` : `${qualified}#`
  const pattern = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+${target}${issue.issueNumber}(?!\\d)`,
    "i"
  )
  return pattern.test(body)
}

/**
 * Implements {@link LinkPullRequest} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerLinkPullRequest: Layer.Layer<
  Action.Requirement<"integrations/github/link-pr">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = LinkPullRequest.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* GitHubClient
      const repository = yield* requireRepositoryPath(payload.owner, payload.repo)
      const issueOwner = payload.issueOwner ?? payload.owner
      const issueRepo = payload.issueRepo ?? payload.repo
      yield* requireRepositoryPath(issueOwner, issueRepo)
      const sameRepository = issueOwner.toLowerCase() === payload.owner.toLowerCase() &&
        issueRepo.toLowerCase() === payload.repo.toLowerCase()
      const reference = sameRepository
        ? `#${payload.issueNumber}`
        : `${issueOwner}/${issueRepo}#${payload.issueNumber}`
      const path = `/repos/${repository}/pulls/${payload.pullNumber}`
      const pull = yield* client.request("GET", path, undefined, { schema: PullRequest })
      const body = pull.body ?? ""
      const linked = { pullNumber: payload.pullNumber, url: pull.html_url, reference }
      if (closesIssue(body, { owner: issueOwner, repo: issueRepo, issueNumber: payload.issueNumber }, sameRepository)) {
        return { ...linked, updated: false }
      }
      const line = `Closes ${reference}`
      yield* client.request("PATCH", path, { body: body.length === 0 ? line : `${body}\n\n${line}` }, {
        schema: PullRequest
      })
      return { ...linked, updated: true }
    }).pipe(Effect.mapError(fromIntegrationError)),
  { implementationVersion: "github/link-pr/v1" }
)

/**
 * Every GitHub action's implementation, in one layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<
  | Action.Requirement<"integrations/github/comment-on-issue">
  | Action.Requirement<"integrations/github/add-labels">
  | Action.Requirement<"integrations/github/upsert-comment">
  | Action.Requirement<"integrations/github/check-run">
  | Action.Requirement<"integrations/github/link-pr">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = Layer.mergeAll(layerCommentOnIssue, layerAddLabels, layerUpsertComment, layerCheckRun, layerLinkPullRequest)
