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
import { EDITED_MESSAGE_EVENT, MESSAGE_EVENT, type Source } from "./Source.ts"

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
      Effect.runPromise(options.runtime.execute(Delete, { payload, executionId }))
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
        if (d.event === "comment.reaction") {
          return { messageId: d.message_id, unsupported: "Telegram reaction mirroring is unavailable" }
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
  const ingest = async (event: ExternalEvent): Promise<"ignored" | "applied"> => {
    if (event.eventName !== MESSAGE_EVENT && event.eventName !== EDITED_MESSAGE_EVENT) return "ignored"
    const m = event.payload
    if (!isRecord(m) || !isRecord(m["chat"]) || !isRecord(m["from"])) return "ignored"
    const user = m["from"], chat = m["chat"]
    if (
      !numeric(m["message_id"]) || !numeric(user["id"]) || user["is_bot"] !== false ||
      String(user["id"]) === options.botId || !options.allowedChatIds.includes(String(chat["id"])) ||
      (options.allowedUserIds !== undefined && !options.allowedUserIds.includes(String(user["id"])))
    ) return "ignored"
    if (typeof m["text"] !== "string" || m["text"].trim() === "") return "ignored"
    if (m["message_thread_id"] !== undefined && !numeric(m["message_thread_id"])) return "ignored"
    const version = m["edit_date"] ?? m["date"]
    if (!numeric(version)) return "ignored"
    // Topic sources emit both chat and topic correlations. Canonicalize those
    // variants to one delivery and host admission identity.
    const prefix = `update:${event.source.length}:${event.source}:`
    if (!event.dedupeKey.startsWith(prefix)) return "ignored"
    const updateId = event.dedupeKey.slice(prefix.length).replace(/:thread$/, "")
    if (!/^[0-9]{1,10}$/.test(updateId)) return "ignored"
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
