/**
 * The durable Linear actions.
 *
 * {@link LinearClient} is the host layer: it resolves team keys, state names,
 * and label names to ids, caches those lookups, and retries a rate limit. An
 * `Action` is what makes one of its mutations a step of a durable flow, so a
 * restart replays the recorded issue instead of filing a second one.
 *
 * @since 1.0.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import { Effect, type Layer, Schema } from "effect"
import { fromIntegrationError, IntegrationFailure } from "../core/ActionFailure.ts"
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
 * Every Linear action's implementation, in one layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<
  Action.Requirement<"integrations/linear/create-issue">,
  never,
  LinearClient | FlowRuntime.FlowRuntime
> = layerCreateIssue
