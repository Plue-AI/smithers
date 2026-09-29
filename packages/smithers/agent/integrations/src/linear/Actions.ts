/**
 * The durable Linear actions.
 *
 * {@link LinearClient} is the host layer: it resolves team keys, state names,
 * and label names to ids, caches those lookups, and retries a rate limit. An
 * `Action` is what makes one of its mutations a step of a durable flow, so a
 * restart replays the recorded issue instead of filing a second one.
 *
 * {@link UpdateIssue} and {@link CommentOnIssue} may also be repeated after a
 * lost answer or a process that died mid-step, so they declare an
 * `idempotencyKey` and a bounded {@link retryPolicy}. An update sets fields,
 * so a repeat leaves the same issue. A comment is posted under a UUID derived
 * from the step's key, and a repeat looks for that comment before posting.
 *
 * @since 1.0.0
 */

import { Action, type FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { fromIntegrationError, IntegrationFailure } from "../core/ActionFailure.ts"
import { IntegrationError } from "../core/IntegrationError.ts"
import { LinearClient } from "./LinearClient.ts"

/**
 * What {@link CreateIssue} needs.
 *
 * The name fields are the point: a flow says `ENG`, `In Progress`, and `bug`,
 * and the client turns them into the ids Linear's API wants. Exactly one of
 * `teamKey` and `teamId` is required, which the client enforces.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CreateIssuePayload = Schema.Struct({
  title: Schema.String,
  teamKey: Schema.optional(Schema.String),
  teamId: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  stateName: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String))
})

/**
 * The issue Linear created.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Issue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String
})

/**
 * Files an issue.
 *
 * The tier is `irreversible`: the issue exists and notifies its team as soon
 * as Linear accepts the mutation, so the engine must never retry this step on
 * its own. Nor does the client underneath: a 5xx on `issueCreate` reports that
 * the outcome is unknown rather than filing a second issue.
 *
 * @category actions
 * @since 1.0.0
 */
export const CreateIssue = Action.make("integrations/linear/create-issue", {
  payload: CreateIssuePayload,
  success: Issue,
  error: IntegrationFailure,
  tier: "irreversible"
})

/**
 * Implements {@link CreateIssue} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerCreateIssue: Layer.Layer<
  Action.Requirement<"integrations/linear/create-issue">,
  never,
  LinearClient | FlowRuntime.FlowRuntime
> = CreateIssue.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* LinearClient
    const issue = yield* client.createIssue(payload)
    return { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url }
  }).pipe(Effect.mapError(fromIntegrationError))
)

/**
 * The engine retry policy of {@link UpdateIssue} and {@link CommentOnIssue}.
 *
 * Three attempts, half a second then a second apart.
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
 * A Linear priority: `0` none to `4` low, or the name of one.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Priority = Schema.Union([
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
  Schema.Literals(["none", "urgent", "high", "normal", "medium", "low"])
])

/**
 * What {@link UpdateIssue} needs.
 *
 * `issue` is a UUID or an identifier such as `ENG-123`. Only the fields given
 * change. Names resolve as {@link CreateIssue}'s do; an empty `labels` clears
 * the issue's labels.
 *
 * @category schemas
 * @since 1.0.0
 */
export const UpdateIssuePayload = Schema.Struct({
  issue: Schema.NonEmptyString,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Priority),
  stateName: Schema.optionalKey(Schema.String),
  stateId: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
  assigneeId: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(Schema.String),
  estimate: Schema.optionalKey(Schema.Number),
  dueDate: Schema.optionalKey(Schema.String)
})

/**
 * Changes an issue's fields.
 *
 * @category actions
 * @since 1.0.0
 */
export const UpdateIssue = Action.make("integrations/linear/update-issue", {
  payload: UpdateIssuePayload,
  success: Issue,
  error: IntegrationFailure,
  tier: "irreversible",
  implementationVersion: "linear/update-issue/v1",
  idempotencyKey: (payload) => ({
    action: "integrations/linear/update-issue",
    ...(payload as unknown as Record<string, Schema.Json>)
  }),
  retryPolicy
})

/**
 * Implements {@link UpdateIssue} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerUpdateIssue: Layer.Layer<
  Action.Requirement<"integrations/linear/update-issue">,
  never,
  LinearClient | FlowRuntime.FlowRuntime
> = UpdateIssue.toLayer(
  ({ issue, ...fields }) =>
    Effect.gen(function*() {
      const client = yield* LinearClient
      const updated = yield* client.updateIssue(issue, fields)
      return { id: updated.id, identifier: updated.identifier, title: updated.title, url: updated.url }
    }).pipe(Effect.mapError(fromIntegrationError)),
  { implementationVersion: "linear/update-issue/v1" }
)

/**
 * What {@link CommentOnIssue} needs. `issue` is a UUID or an identifier such
 * as `ENG-123`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CommentOnIssuePayload = Schema.Struct({
  issue: Schema.NonEmptyString,
  body: Schema.String
})

/**
 * The comment, and whether this step posted it. `created` is false when an
 * earlier attempt of the same step already had.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Comment = Schema.Struct({
  id: Schema.String,
  issueId: Schema.String,
  body: Schema.String,
  created: Schema.Boolean
})

/**
 * Posts a comment on an issue, once per step.
 *
 * @category actions
 * @since 1.0.0
 */
export const CommentOnIssue = Action.make("integrations/linear/comment-on-issue", {
  payload: CommentOnIssuePayload,
  success: Comment,
  error: IntegrationFailure,
  tier: "irreversible",
  implementationVersion: "linear/comment-on-issue/v1",
  idempotencyKey: (payload) => ({
    action: "integrations/linear/comment-on-issue",
    issue: payload.issue,
    body: payload.body
  }),
  retryPolicy
})

/**
 * The comment UUID a step posts under, derived from the step's key.
 *
 * @category constructors
 * @since 1.0.0
 */
export const commentId = (key: string): string => {
  const hex = createHash("sha256").update(`smithers/linear/comment:${key}`).digest("hex")
  const variant = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${
    hex.slice(20, 32)
  }`
}

const FIND_COMMENT = `query SmithersComment($issue: String!, $comment: ID!) {
  issue(id: $issue) { id comments(first: 1, filter: { id: { eq: $comment } }) { nodes { id body } } }
}`

const Found = Schema.Struct({
  issue: Schema.Struct({
    id: Schema.String,
    comments: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ id: Schema.String, body: Schema.String })) })
  })
})

/**
 * Implements {@link CommentOnIssue} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerCommentOnIssue: Layer.Layer<
  Action.Requirement<"integrations/linear/comment-on-issue">,
  never,
  LinearClient | FlowRuntime.FlowRuntime
> = CommentOnIssue.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* LinearClient
      // The engine provides the key to every dispatched step; outside one there is no step to key.
      const key = yield* Action.CurrentInvocationKey.pipe(Effect.flatMap(Effect.fromNullishOr), Effect.orDie)
      const id = commentId(key)
      const data = yield* client.query(FIND_COMMENT, { issue: payload.issue, comment: id })
      const found = yield* Schema.decodeUnknownEffect(Found)(data).pipe(
        Effect.mapError(() =>
          new IntegrationError("decode-failed", `Linear issue "${payload.issue}" did not decode.`, {
            retryable: false
          })
        )
      )
      const existing = found.issue.comments.nodes[0]
      if (existing !== undefined) {
        return { id: existing.id, issueId: found.issue.id, body: existing.body, created: false }
      }
      const comment = yield* client.commentOnIssue(found.issue.id, payload.body, { id })
      return { id: comment.id, issueId: found.issue.id, body: comment.body, created: true }
    }).pipe(Effect.mapError(fromIntegrationError)),
  { implementationVersion: "linear/comment-on-issue/v1" }
)

/**
 * Every Linear action's implementation, in one layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<
  | Action.Requirement<"integrations/linear/create-issue">
  | Action.Requirement<"integrations/linear/update-issue">
  | Action.Requirement<"integrations/linear/comment-on-issue">,
  never,
  LinearClient | FlowRuntime.FlowRuntime
> = Layer.mergeAll(layerCreateIssue, layerUpdateIssue, layerCommentOnIssue)
