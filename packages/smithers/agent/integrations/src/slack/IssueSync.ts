/**
 * Bidirectional transport for the shared backend's issue/comment API.
 * The backend owns identities, mappings, claims and receipts. This adapter owns
 * no message store or worker runtime: a host schedules drain() and runs its
 * existing SocketSource with ingest(). Actions execute through the host's Flow
 * runtime. A crashed claim is reconciled, never blindly posted again.
 * @since 1.0.0
 */
import { isRecord } from "@smthrs/canonical/Record"
import { Flow, type FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { IntegrationFailure } from "../core/ActionFailure.ts"
import * as IssueSync from "../core/IssueSync.ts"
import * as Actions from "./Actions.ts"
import * as Payload from "./Payload.ts"
import type { Source } from "./SocketSource.ts"
import * as Sync from "./Sync.ts"

/** The host registers these thin flows with its existing durable engine.
 * @category flows
 * @since 1.0.0
 */
export const Post = Flow.make("integrations/slack/issue-post", {
  payload: Actions.PostMessagePayload,
  success: Actions.Posted,
  error: Actions.PostMessage.errorSchema,
  body: Node.capture({ action: Actions.PostMessage.name }, (p) => Actions.PostMessage.call(p))
})
/** Edits an issue message through the existing Slack action.
 * @category flows
 * @since 1.0.0
 */
export const Update = Flow.make("integrations/slack/issue-update", {
  payload: Actions.UpdateMessagePayload,
  success: Actions.Updated,
  error: Actions.UpdateMessage.errorSchema,
  body: Node.capture({ action: Actions.UpdateMessage.name }, (p) => Actions.UpdateMessage.call(p))
})
/** Deletes an issue message through the existing Slack action.
 * @category flows
 * @since 1.0.0
 */
export const Delete = Flow.make("integrations/slack/issue-delete", {
  payload: Actions.DeleteMessage.payloadSchema,
  success: Actions.Updated,
  error: Actions.DeleteMessage.errorSchema,
  body: Node.capture({ action: Actions.DeleteMessage.name }, (p) => Actions.DeleteMessage.call(p))
})
/** Sets the bot reaction through the existing Slack action.
 * @category flows
 * @since 1.0.0
 */
export const React = Flow.make("integrations/slack/issue-react", {
  payload: Actions.SetReaction.payloadSchema,
  success: Actions.SetReaction.successSchema,
  error: Actions.SetReaction.errorSchema,
  body: Node.capture({ action: Actions.SetReaction.name }, (p) => Actions.SetReaction.call(p))
})
/** Looks up an unknown issue delivery by its durable key.
 * @category flows
 * @since 1.0.0
 */
export const Reconcile = Flow.make("integrations/slack/issue-reconcile", {
  payload: Actions.ReconcilePayload,
  success: Actions.Reconciled,
  error: Actions.Reconcile.errorSchema,
  body: Node.capture({ action: Actions.Reconcile.name }, (p) => Actions.Reconcile.call(p))
})

/** Authenticated product HTTP transport; credentials never enter action payloads.
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly connectionId: string
  readonly policy: Payload.Policy
  readonly owner: string
  readonly repo: string
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly runtime: FlowRuntime.FlowRuntime["Service"]
  /** Dispatch to the host's durable signal/flow admission, keyed by event.dedupeKey. */
  readonly onMessage?:
    | ((
      receipt: { readonly issueId: number; readonly event: ReturnType<typeof Payload.toExternalEvent> }
    ) => Promise<void>)
    | undefined
}
// Slack truncates beyond MAX_TEXT_LENGTH and the action refuses it; cut on a code point and mark the cut.
const fit = (body: string) => {
  if (body.length <= Actions.MAX_TEXT_LENGTH) return body
  const cut = Actions.MAX_TEXT_LENGTH - 1
  return `${body.slice(0, /[\uD800-\uDBFF]/.test(body[cut - 1]!) ? cut - 1 : cut)}…`
}
// A payload the action would refuse was provably never sent: settle it failed, not unknown.
const admit = <S extends Schema.Top>(schema: S, payload: S["Type"]): S["Type"] => {
  if (Schema.is(schema)(payload)) return payload
  throw new IntegrationFailure({ reason: "delivery-failed", message: "Slack refuses this message", retryable: false })
}
/** Slack connector over the shared issue sync mechanism.
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options) => {
  IssueSync.requireDurableRuntime(options.runtime)
  const execute = {
    post: (payload: typeof Post.payloadSchema.Type, executionId: string) =>
      Effect.runPromise(options.runtime.execute(Post, { payload, executionId })),
    update: (payload: typeof Update.payloadSchema.Type, executionId: string) =>
      Effect.runPromise(options.runtime.execute(Update, { payload, executionId })),
    delete: (payload: typeof Delete.payloadSchema.Type, executionId: string) =>
      Effect.runPromise(options.runtime.execute(Delete, { payload, executionId })),
    react: (payload: typeof React.payloadSchema.Type, executionId: string) =>
      Effect.runPromise(options.runtime.execute(React, { payload, executionId })),
    reconcile: (payload: typeof Reconcile.payloadSchema.Type, executionId: string) =>
      Effect.runPromise(options.runtime.execute(Reconcile, { payload, executionId }))
  }
  const policy = Payload.requirePolicy(options.policy, "Slack.IssueSync")
  const common = (d: typeof IssueSync.Delivery.Type) => ({
    connectionId: options.connectionId,
    channel: d.mapping.conversation_id
  })
  const thread = (d: typeof IssueSync.Delivery.Type) =>
    d.mapping.thread_id === "" || d.mapping.thread_id.startsWith("dm:") ? {} : { threadTs: d.mapping.thread_id }
  const bridge = IssueSync.make({
    ...options,
    connector: {
      accepts: (m) =>
        m.provider === "slack" && m.connection_id === options.connectionId &&
        policy.allowedTeamIds.includes(m.scope_id) &&
        ((policy.allowedChannelIds ?? []).includes(m.conversation_id) ||
          (m.conversation_id.startsWith("D") && (policy.allowedUserIds?.length ?? 0) > 0)),
      reconcile: async (d, run) => {
        const found = await execute.reconcile({ ...common(d), ...thread(d), key: `issue-sync:${d.key}` }, run)
        return found.status === "found" && found.ts !== null ? found.ts : undefined
      },
      deliver: async (d, run) => {
        let ts = d.message_id
        if (d.event === "comment.created") {
          const persona = Schema.decodeUnknownOption(Actions.Persona)(d.payload.comment.persona)
          const posted = await execute.post(
            admit(Actions.PostMessagePayload, {
              ...common(d),
              ...thread(d),
              key: `issue-sync:${d.key}`,
              text: fit(d.payload.comment.body ?? ""),
              ...(persona._tag === "Some" ? { persona: persona.value } : {})
            }),
            run
          )
          ts = posted.ts
        } else if (ts === "") throw new Error("No Slack identity for issue comment")
        else if (d.event === "comment.edited") {
          await execute.update(
            admit(Actions.UpdateMessagePayload, { ...common(d), ts, text: fit(d.payload.comment.body ?? "") }),
            run
          )
        } else if (d.event === "comment.deleted") {
          await execute.delete({ ...common(d), ts }, run)
        } else if (d.event === "comment.reaction" && d.payload.reaction !== undefined) {
          const result = await execute.react({ ...common(d), ts, ...d.payload.reaction }, run)
          if (result.status === "unsupported") {
            return { messageId: ts, unsupported: "Slack reactions:write scope missing" }
          }
        } else throw new Error("Unsupported issue event")
        return { messageId: ts }
      }
    }
  })
  const ingest = async (raw: unknown): Promise<"ignored" | "applied"> => {
    const verdict = Payload.classify(raw, policy)
    if (verdict._tag === "Refused" || !isRecord(raw) || !isRecord(raw["event"])) return "ignored"
    const event = raw["event"]
    const common = {
      provider: "slack",
      connection_id: options.connectionId,
      scope_id: verdict.teamId,
      conversation_id: verdict.channelId,
      delivery_key: verdict.key
    }
    if (event["type"] === "reaction_added" || event["type"] === "reaction_removed") {
      const item = event["item"]
      if (!isRecord(item) || item["type"] !== "message") return "ignored"
      return bridge.ingest({
        ...common,
        kind: event["type"] === "reaction_added" ? "reaction_add" : "reaction_remove",
        message_id: item["ts"],
        version: event["event_ts"],
        user_id: event["user"],
        reaction: event["reaction"]
      })
    }
    const record = Sync.eventRecord(
      event["type"] === "app_mention" ? { ...raw, event: { ...event, type: "message" } } : raw,
      { connectionId: options.connectionId, retrievedAtMs: Date.now() }
    )
    if (record === undefined) return "ignored"
    const subject = event["subtype"] === "message_deleted" ?
      event["previous_message"]
      : event["subtype"] === "message_changed"
      ? event["message"]
      : event
    if (!isRecord(subject)) return "ignored"
    return bridge.ingest({
      ...common,
      kind: record.deleted ? "delete" : event["subtype"] === "message_changed" ? "edit" : "message",
      message_id: subject["ts"],
      version: record.version,
      thread_id: subject["thread_ts"],
      user_id: subject["user"],
      body: record.text
    }, Payload.toExternalEvent(raw, { policy }))
  }
  return {
    ingest,
    drain: bridge.drain,
    run: (source: Source) =>
      source.run((events) =>
        Effect.tryPromise(async () => {
          for (const event of events) await ingest(event.payload)
        })
      )
  }
}
