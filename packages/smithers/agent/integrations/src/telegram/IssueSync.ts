/** Telegram connector for the shared issue/comment sync transport.
 * @since 1.0.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import { Flow, type FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect } from "effect"
import type { ExternalEvent } from "../core/ExternalEvent.ts"
import { IntegrationError } from "../core/IntegrationError.ts"
import * as IssueSync from "../core/IssueSync.ts"
import * as Actions from "./Actions.ts"
import { EDITED_MESSAGE_EVENT, MESSAGE_EVENT, MESSAGE_REACTION_EVENT, type Source } from "./Source.ts"

/** Post a comment through the host's durable engine.
 * @category flows
 * @since 1.0.0
 */
export const Post = Flow.make("integrations/telegram/issue-post", {
  payload: Actions.IssueMessagePayload,
  success: Actions.IssueMessageResult,
  error: Actions.PostIssueMessage.errorSchema,
  body: Node.capture({ action: Actions.PostIssueMessage.name }, (p) => Actions.PostIssueMessage.call(p))
})
/** Edit a mirrored comment.
 * @category flows
 * @since 1.0.0
 */
export const Update = Flow.make("integrations/telegram/issue-update", {
  payload: Actions.IssueMessagePayload,
  success: Actions.IssueMessageResult,
  error: Actions.UpdateIssueMessage.errorSchema,
  body: Node.capture({ action: Actions.UpdateIssueMessage.name }, (p) => Actions.UpdateIssueMessage.call(p))
})
/** Delete a mirrored comment.
 * @category flows
 * @since 1.0.0
 */
export const Delete = Flow.make("integrations/telegram/issue-delete", {
  payload: Actions.IssueMessagePayload,
  success: Actions.IssueMessageResult,
  error: Actions.DeleteIssueMessage.errorSchema,
  body: Node.capture({ action: Actions.DeleteIssueMessage.name }, (p) => Actions.DeleteIssueMessage.call(p))
})
/** Set or clear the bot's reaction on a mirrored comment.
 * @category flows
 * @since 1.0.0
 */
export const React = Flow.make("integrations/telegram/issue-react", {
  payload: Actions.IssueReactionPayload,
  success: Actions.SetIssueReaction.successSchema,
  error: Actions.SetIssueReaction.errorSchema,
  body: Node.capture({ action: Actions.SetIssueReaction.name }, (p) => Actions.SetIssueReaction.call(p))
})
/** The `allowed_updates` a Source feeding this connector requests.
 * @category constants
 * @since 1.0.0
 */
export const ALLOWED_UPDATES: ReadonlyArray<string> = ["message", "edited_message", "message_reaction"]
/** Explicit admission policy; botId namespaces Telegram's message identities.
 * @category models
 * @since 1.0.0
 */
export interface Options extends Omit<IssueSync.Options, "connector"> {
  readonly connectionId: string
  readonly botId: string
  readonly allowedChatIds: ReadonlyArray<string>
  readonly allowedUserIds?: ReadonlyArray<string>
  readonly runtime: FlowRuntime.FlowRuntime["Service"]
}
const numeric = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
const personaText = (body: string, persona: unknown) =>
  isRecord(persona) && typeof persona["username"] === "string" ? `${persona["username"]}\n${body}` : body
/** Compose Source admission and provider actions with the common transport.
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
      Effect.runPromise(options.runtime.execute(React, { payload, executionId }))
  }
  if (!/^[1-9][0-9]*$/.test(options.botId) || options.allowedChatIds.length === 0) {
    throw new IntegrationError("invalid-config", "Telegram issue sync requires a bot id and allowed chats")
  }
  const bridge = IssueSync.make({
    ...options,
    connector: {
      accepts: (m) =>
        m.provider === "telegram" && m.connection_id === options.connectionId && m.scope_id === options.botId &&
        options.allowedChatIds.includes(m.conversation_id),
      // Bot API has neither arbitrary message history nor a send idempotency key.
      // A missing journal/provider receipt stays unknown; absence never permits resend.
      reconcile: async () => undefined,
      deliver: async (d, run) => {
        if (d.event === "comment.reaction" && d.payload.reaction !== undefined) {
          const reaction = Actions.toReaction(d.payload.reaction.name)
          if (reaction === undefined) {
            return { messageId: d.message_id, unsupported: `Telegram has no ${d.payload.reaction.name} reaction` }
          }
          // Every chunk is one comment; the reaction lives on its first message.
          const first = Number(d.message_id.split(",")[0])
          if (!numeric(first)) throw new Error("No Telegram identity for issue comment")
          const result = await execute.react({
            connectionId: options.connectionId,
            chatId: d.mapping.conversation_id,
            messageId: first,
            reaction,
            active: d.payload.reaction.active
          }, run)
          return result.status === "unsupported"
            ? { messageId: d.message_id, unsupported: `Telegram chat refuses the ${d.payload.reaction.name} reaction` }
            : { messageId: d.message_id }
        }
        const payload = {
          connectionId: options.connectionId,
          chatId: d.mapping.conversation_id,
          text: personaText(d.payload.comment.body ?? "", d.payload.comment.persona),
          messageIds: d.message_id === "" ? [] : d.message_id.split(",").map(Number),
          ...(d.mapping.thread_id === "chat" ? {} : { messageThreadId: Number(d.mapping.thread_id) })
        }
        let result: typeof Actions.IssueMessageResult.Type
        if (d.event === "comment.created") {
          result = await execute.post(payload, run)
        } else if (payload.messageIds.length === 0) throw new Error("No Telegram identity for issue comment")
        else if (d.event === "comment.edited") result = await execute.update(payload, run)
        else if (d.event === "comment.deleted") result = await execute.delete(payload, run)
        else throw new Error("Unsupported issue event")
        return { messageId: result.messageIds.join(",") }
      }
    }
  })
  // Canonical update id from the Source dedupe key; topic variants share it.
  const updateIdOf = (event: ExternalEvent): string | undefined => {
    const prefix = `update:${event.source.length}:${event.source}:`
    if (!event.dedupeKey.startsWith(prefix)) return undefined
    const updateId = event.dedupeKey.slice(prefix.length).replace(/:thread$/, "")
    return /^[0-9]{1,10}$/.test(updateId) ? updateId : undefined
  }
  const admitted = (user: Record<string, unknown>, chat: Record<string, unknown>) =>
    numeric(user["id"]) && user["is_bot"] === false && String(user["id"]) !== options.botId &&
    options.allowedChatIds.includes(String(chat["id"])) &&
    (options.allowedUserIds === undefined || options.allowedUserIds.includes(String(user["id"])))
  // A reaction update carries the actor's whole old and new lists; each
  // difference is one attributed add or remove. Anonymous (actor_chat) and
  // paid or unmapped reactions have no issue identity and are ignored.
  const ingestReaction = async (event: ExternalEvent): Promise<"ignored" | "applied"> => {
    const r = event.payload
    if (!isRecord(r) || !isRecord(r["chat"]) || !isRecord(r["user"])) return "ignored"
    if (!admitted(r["user"], r["chat"]) || !numeric(r["message_id"]) || !numeric(r["date"])) return "ignored"
    if (!Array.isArray(r["old_reaction"]) || !Array.isArray(r["new_reaction"])) return "ignored"
    const updateId = updateIdOf(event)
    if (updateId === undefined) return "ignored"
    const before = new Set(r["old_reaction"].map(Actions.fromReaction).filter((n) => n !== undefined))
    const after = new Set(r["new_reaction"].map(Actions.fromReaction).filter((n) => n !== undefined))
    const changes = [
      ...[...before].filter((n) => !after.has(n)).map((name) => ({ name, kind: "reaction_remove" })),
      ...[...after].filter((n) => !before.has(n)).map((name) => ({ name, kind: "reaction_add" }))
    ]
    let outcome: "ignored" | "applied" = "ignored"
    for (const change of changes) {
      const applied = await bridge.ingest({
        provider: "telegram",
        connection_id: options.connectionId,
        scope_id: options.botId,
        conversation_id: String(r["chat"]["id"]),
        thread_id: "",
        delivery_key: `telegram:${options.botId}:${updateId}:${change.kind}:${change.name}`,
        kind: change.kind,
        message_id: String(r["message_id"]),
        version: `${r["date"]}.${updateId.padStart(10, "0")}`,
        user_id: String(r["user"]["id"]),
        reaction: change.name
      })
      if (applied === "applied") outcome = "applied"
    }
    return outcome
  }
  const ingest = async (event: ExternalEvent): Promise<"ignored" | "applied"> => {
    if (event.eventName === MESSAGE_REACTION_EVENT) return ingestReaction(event)
    if (event.eventName !== MESSAGE_EVENT && event.eventName !== EDITED_MESSAGE_EVENT) return "ignored"
    const m = event.payload
    if (!isRecord(m) || !isRecord(m["chat"]) || !isRecord(m["from"])) return "ignored"
    const user = m["from"], chat = m["chat"]
    if (!numeric(m["message_id"]) || !admitted(user, chat)) return "ignored"
    if (typeof m["text"] !== "string" || m["text"].trim() === "") return "ignored"
    if (m["message_thread_id"] !== undefined && !numeric(m["message_thread_id"])) return "ignored"
    const version = m["edit_date"] ?? m["date"]
    if (!numeric(version)) return "ignored"
    // Topic sources emit both chat and topic correlations. Canonicalize those
    // variants to one delivery and host admission identity.
    const updateId = updateIdOf(event)
    if (updateId === undefined) return "ignored"
    const key = `telegram:${options.botId}:${updateId}`
    return bridge.ingest({
      provider: "telegram",
      connection_id: options.connectionId,
      scope_id: options.botId,
      conversation_id: String(chat["id"]),
      thread_id: m["message_thread_id"] === undefined ? "" : String(m["message_thread_id"]),
      delivery_key: key,
      kind: event.eventName === EDITED_MESSAGE_EVENT ? "edit" : "message",
      message_id: String(m["message_id"]),
      version: `${version}.${updateId.padStart(10, "0")}`,
      user_id: String(user["id"]),
      body: m["text"]
    }, { ...event, dedupeKey: key })
  }
  return {
    ingest,
    drain: bridge.drain,
    run: (source: Source) =>
      source.run((events) =>
        Effect.tryPromise(async () => {
          for (const event of events) await ingest(event)
        })
      )
  }
}
