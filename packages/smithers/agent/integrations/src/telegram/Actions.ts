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
import { isTelegramApiError, TelegramClient, toIntegrationError } from "./TelegramClient.ts"

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

/** A Telegram `ReactionType` a bot may set: a standard emoji or a custom emoji.
 * @category schemas
 * @since 1.0.0
 */
export const Reaction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("emoji"), emoji: Schema.NonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("custom_emoji"),
    custom_emoji_id: Schema.String.check(Schema.isPattern(/^[0-9]{1,32}$/))
  })
])

// Issue reaction names use Slack short names. Only emoji Telegram accepts as
// standard reactions appear here; the first name for an emoji is canonical.
const names: ReadonlyArray<readonly [string, string]> = [
  ["+1", "👍"],
  ["thumbsup", "👍"],
  ["-1", "👎"],
  ["thumbsdown", "👎"],
  ["heart", "❤"],
  ["fire", "🔥"],
  ["smiling_face_with_3_hearts", "🥰"],
  ["clap", "👏"],
  ["grin", "😁"],
  ["thinking_face", "🤔"],
  ["exploding_head", "🤯"],
  ["scream", "😱"],
  ["cry", "😢"],
  ["tada", "🎉"],
  ["star-struck", "🤩"],
  ["pray", "🙏"],
  ["ok_hand", "👌"],
  ["dove_of_peace", "🕊"],
  ["clown_face", "🤡"],
  ["yawning_face", "🥱"],
  ["woozy_face", "🥴"],
  ["heart_eyes", "😍"],
  ["whale", "🐳"],
  ["hotdog", "🌭"],
  ["100", "💯"],
  ["rolling_on_the_floor_laughing", "🤣"],
  ["zap", "⚡"],
  ["banana", "🍌"],
  ["trophy", "🏆"],
  ["broken_heart", "💔"],
  ["face_with_raised_eyebrow", "🤨"],
  ["neutral_face", "😐"],
  ["strawberry", "🍓"],
  ["champagne", "🍾"],
  ["kiss", "💋"],
  ["smiling_imp", "😈"],
  ["sleeping", "😴"],
  ["sob", "😭"],
  ["nerd_face", "🤓"],
  ["ghost", "👻"],
  ["eyes", "👀"],
  ["jack_o_lantern", "🎃"],
  ["see_no_evil", "🙈"],
  ["innocent", "😇"],
  ["fearful", "😨"],
  ["handshake", "🤝"],
  ["writing_hand", "✍"],
  ["hugging_face", "🤗"],
  ["saluting_face", "🫡"],
  ["santa", "🎅"],
  ["christmas_tree", "🎄"],
  ["snowman", "☃"],
  ["nail_care", "💅"],
  ["zany_face", "🤪"],
  ["moyai", "🗿"],
  ["cool", "🆒"],
  ["cupid", "💘"],
  ["hear_no_evil", "🙉"],
  ["unicorn_face", "🦄"],
  ["kissing_heart", "😘"],
  ["pill", "💊"],
  ["speak_no_evil", "🙊"],
  ["sunglasses", "😎"],
  ["space_invader", "👾"],
  ["shrug", "🤷"],
  ["rage", "😡"]
]
const byName = new Map(names)
const byEmoji = new Map<string, string>()
for (const [name, emoji] of names) if (!byEmoji.has(emoji)) byEmoji.set(emoji, name)
const customPrefix = "telegram_custom_"

/** The Telegram reaction for an issue reaction name, if Telegram has one.
 * @category conversions
 * @since 1.0.0
 */
export const toReaction = (name: string): typeof Reaction.Type | undefined => {
  const emoji = byName.get(name)
  if (emoji !== undefined) return { type: "emoji", emoji }
  const id = name.startsWith(customPrefix) ? name.slice(customPrefix.length) : ""
  return /^[0-9]{1,32}$/.test(id) ? { type: "custom_emoji", custom_emoji_id: id } : undefined
}
/** The issue reaction name for a Telegram `ReactionType`; paid and unknown reactions have none.
 * @category conversions
 * @since 1.0.0
 */
export const fromReaction = (reaction: unknown): string | undefined => {
  if (typeof reaction !== "object" || reaction === null) return undefined
  const r = reaction as Record<string, unknown>
  if (r["type"] === "emoji" && typeof r["emoji"] === "string") return byEmoji.get(r["emoji"].replace(/\uFE0F/g, ""))
  if (r["type"] === "custom_emoji" && typeof r["custom_emoji_id"] === "string") {
    return /^[0-9]{1,32}$/.test(r["custom_emoji_id"]) ? `${customPrefix}${r["custom_emoji_id"]}` : undefined
  }
  return undefined
}
/** What {@link SetIssueReaction} needs.
 * @category schemas
 * @since 1.0.0
 */
export const IssueReactionPayload = Schema.Struct({
  connectionId: Schema.String,
  chatId: Schema.String,
  messageId: MessageId,
  reaction: Reaction,
  active: Schema.Boolean
})
/** Set or clear the bot's reaction. A chat that refuses the reaction is an explicit unsupported receipt.
 * Telegram gives a bot one reaction per message, so an add replaces and a removal clears it.
 * @category actions
 * @since 1.0.0
 */
export const SetIssueReaction = Action.make("integrations/telegram/issue-react", {
  payload: IssueReactionPayload,
  success: Schema.Struct({ status: Schema.Literals(["applied", "unsupported"]) }),
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
  const react = (payload: typeof IssueReactionPayload.Type) =>
    Effect.gen(function*() {
      const client = yield* resolve(payload.connectionId, payload.chatId)
      return yield* client.call("setMessageReaction", {
        chat_id: payload.chatId,
        message_id: payload.messageId,
        reaction: payload.active ? [payload.reaction] : []
      }).pipe(
        Effect.as({ status: "applied" as const }),
        Effect.catch((error) =>
          isTelegramApiError(error) && error.errorCode === 400 &&
            /REACTION_INVALID|REACTIONS_TOO_MANY|REACTION_EMPTY/.test(String(error.details?.["description"] ?? ""))
            ? Effect.succeed({ status: "unsupported" as const })
            : Effect.fail(error)
        )
      )
    }).pipe(Effect.mapError((error) => fromIntegrationError(toIntegrationError(error))))
  return Layers.mergeAll(
    PostIssueMessage.toLayer(implement("post")),
    UpdateIssueMessage.toLayer(implement("update")),
    DeleteIssueMessage.toLayer(implement("delete")),
    SetIssueReaction.toLayer(react)
  )
}
