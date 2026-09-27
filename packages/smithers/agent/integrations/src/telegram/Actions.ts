/**
 * The durable Telegram actions.
 *
 * {@link TelegramClient} is the host layer: it chunks a long message, converts
 * markdown to MarkdownV2 and falls back to plain text when Telegram rejects
 * the entities, and retries a 429. An `Action` is what makes a send a step of
 * a durable flow, so a restart replays the recorded message ids instead of
 * sending the text twice.
 *
 * @since 1.0.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import { Effect, type Layer, Layer as Layers, Schema } from "effect"
import { fromIntegrationError, IntegrationFailure, MessageId } from "../core/ActionFailure.ts"
import type { IntegrationError } from "../core/IntegrationError.ts"
import { chunk } from "./Chunk.ts"
import { TelegramClient, toIntegrationError } from "./TelegramClient.ts"

/**
 * What {@link SendMessage} needs.
 *
 * `chatId` is a string because Telegram uses both numeric ids and `@channel`
 * usernames, and a numeric id exceeds the range JSON round-trips exactly.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SendMessagePayload = Schema.Struct({
  chatId: Schema.String,
  text: Schema.String,
  parseMode: Schema.optional(Schema.Literals(["markdown", "MarkdownV2", "HTML", "none"])),
  messageThreadId: Schema.optional(Schema.Number),
  disableNotification: Schema.optional(Schema.Boolean)
})

/**
 * What Telegram accepted.
 *
 * One send can become several messages, so the ids are a list and
 * `usedPlainTextFallback` records whether any chunk lost its formatting.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Sent = Schema.Struct({
  chatId: Schema.String,
  messageIds: Schema.Array(MessageId),
  chunkCount: Schema.Number,
  usedPlainTextFallback: Schema.Boolean
})

/**
 * Sends a message to a chat.
 *
 * The tier is `irreversible`: the message is delivered and may already have
 * been read, so the engine must never retry this step on its own. The client
 * underneath retries only a 429, which Telegram refused rather than
 * delivered.
 *
 * A send is not atomic. Text over Telegram's 4096-character limit becomes
 * several `sendMessage` calls inside this one step, and a failure partway
 * through leaves the earlier chunks visible in the chat. The failure names
 * them, in `deliveredMessageIds` on the client error and in the message the
 * action journals, so an operator deciding whether to resend can see what the
 * reader already has.
 *
 * @category actions
 * @since 1.0.0
 */
export const SendMessage = Action.make("integrations/telegram/send-message", {
  payload: SendMessagePayload,
  success: Sent,
  error: IntegrationFailure,
  tier: "irreversible"
})

/**
 * Implements {@link SendMessage} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerSendMessage: Layer.Layer<
  Action.Requirement<"integrations/telegram/send-message">,
  never,
  TelegramClient | FlowRuntime.FlowRuntime
> = SendMessage.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* TelegramClient
    const sent = yield* client.sendMessageSmart(payload.chatId, payload.text, {
      ...(payload.parseMode === undefined ? {} : { parseMode: payload.parseMode }),
      ...(payload.messageThreadId === undefined ? {} : { messageThreadId: payload.messageThreadId }),
      ...(payload.disableNotification === undefined ? {} : { disableNotification: payload.disableNotification })
    })
    return {
      chatId: sent.chatId,
      messageIds: sent.messageIds,
      chunkCount: sent.chunkCount,
      usedPlainTextFallback: sent.usedPlainTextFallback
    }
    // `TelegramApiError` is not an `IntegrationError`, so without this every
    // Telegram failure journaled as an unclassified non-retryable
    // `delivery-failed`: an exhausted rate limit was indistinguishable from a
    // chat that does not exist.
  }).pipe(Effect.mapError(toIntegrationError), Effect.mapError(fromIntegrationError))
)

/**
 * Every Telegram action's implementation, in one layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<
  Action.Requirement<"integrations/telegram/send-message">,
  never,
  TelegramClient | FlowRuntime.FlowRuntime
> = layerSendMessage

/** Connection-scoped payload for issue sync. Credentials resolve at dispatch.
 * @category schemas
 * @since 1.0.0
 */
export const IssueMessagePayload = Schema.Struct({
  connectionId: Schema.String,
  chatId: Schema.String,
  text: Schema.String,
  messageThreadId: Schema.optional(MessageId),
  messageIds: Schema.Array(MessageId)
})
/** External identities retained for every chunk.
 * @category schemas
 * @since 1.0.0
 */
export const IssueMessageResult = Schema.Struct({ messageIds: Schema.Array(MessageId) })
/** Send a comment using the existing chunked send path.
 * @category actions
 * @since 1.0.0
 */
export const PostIssueMessage = Action.make("integrations/telegram/issue-post", {
  payload: IssueMessagePayload,
  success: IssueMessageResult,
  error: IntegrationFailure,
  tier: "irreversible"
})
/** Edit all chunks of a mirrored comment.
 * @category actions
 * @since 1.0.0
 */
export const UpdateIssueMessage = Action.make("integrations/telegram/issue-update", {
  payload: IssueMessagePayload,
  success: IssueMessageResult,
  error: IntegrationFailure,
  tier: "irreversible"
})
/** Delete all chunks Telegram permits this bot to remove.
 * @category actions
 * @since 1.0.0
 */
export const DeleteIssueMessage = Action.make("integrations/telegram/issue-delete", {
  payload: IssueMessagePayload,
  success: IssueMessageResult,
  error: IntegrationFailure,
  tier: "irreversible"
})

/** Host connection resolver, backed by the existing credential broker.
 * @category models
 * @since 1.0.0
 */
export type IssueClientResolver = (
  connectionId: string,
  chatId: string
) => Effect.Effect<TelegramClient, IntegrationError>

/** Provider implementations. A partially applied mutation must never retry as a fresh write.
 * @category layers
 * @since 1.0.0
 */
export const layerIssueSync = (resolve: IssueClientResolver) => {
  const implement = (kind: "post" | "update" | "delete") => (payload: typeof IssueMessagePayload.Type) =>
    Effect.gen(function*() {
      const client = yield* resolve(payload.connectionId, payload.chatId)
      if (kind === "post") {
        const sent = yield* client.sendMessageSmart(payload.chatId, payload.text, {
          parseMode: "none",
          typing: false,
          ...(payload.messageThreadId === undefined ? {} : { messageThreadId: payload.messageThreadId })
        })
        return { messageIds: sent.messageIds }
      }
      const chunks = kind === "update" ? chunk(payload.text) : []
      let applied = false
      const ids: Array<number> = []
      const mutation = Effect.gen(function*() {
        for (let n = 0; n < payload.messageIds.length; n++) {
          const id = payload.messageIds[n]!
          if (n < chunks.length) {
            yield* client.editMessageSmart(payload.chatId, id, chunks[n]!, { parseMode: "none" })
            ids.push(id)
          } else yield* client.call("deleteMessage", { chat_id: payload.chatId, message_id: id })
          applied = true
        }
        for (let n = payload.messageIds.length; n < chunks.length; n++) {
          const sent = yield* client.sendMessageSmart(payload.chatId, chunks[n]!, {
            parseMode: "none",
            typing: false,
            ...(payload.messageThreadId === undefined ? {} : { messageThreadId: payload.messageThreadId })
          })
          ids.push(...sent.messageIds)
          applied = true
        }
        return { messageIds: kind === "delete" ? payload.messageIds : ids }
      })
      return yield* mutation.pipe(Effect.mapError((error) => {
        const failure = fromIntegrationError(toIntegrationError(error))
        const delivered = [...ids, ...(failure.deliveredMessageIds ?? [])]
        return new IntegrationFailure({
          reason: failure.reason,
          message: failure.message,
          retryable: failure.retryable,
          outcomeUnknown: applied || failure.outcomeUnknown === true,
          ...(delivered.length === 0 ? {} : { deliveredMessageIds: delivered })
        })
      }))
    }).pipe(
      Effect.mapError((error) =>
        error instanceof IntegrationFailure ? error : fromIntegrationError(toIntegrationError(error))
      )
    )
  return Layers.mergeAll(
    PostIssueMessage.toLayer(implement("post")),
    UpdateIssueMessage.toLayer(implement("update")),
    DeleteIssueMessage.toLayer(implement("delete"))
  )
}
