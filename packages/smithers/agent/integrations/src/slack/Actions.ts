/**
 * The durable Slack actions.
 *
 * {@link PostMessage} and {@link UpdateMessage} are `irreversible`: the
 * message is visible the moment Slack accepts it, so neither the engine nor
 * the client repeats one. `chat.postMessage` takes no idempotency key, so a
 * post whose answer was lost (a 5xx, a dropped connection, a timeout) fails
 * with `outcomeUnknown: true`, and the message may or may not be in the
 * channel.
 *
 * What makes that recoverable is the key. Every post carries the caller's
 * `key` in Slack message metadata, as
 * `metadata: { event_type: "smithers_message", event_payload: { smithers_key } }`,
 * and {@link Reconcile} looks for that key in the conversation (or the thread)
 * before a flow decides to post again. It answers `found` with the message's
 * `ts`, `absent` when it searched the whole window and the key is not there,
 * or `inconclusive` when its page budget ran out first: only `absent` makes a
 * resend safe. Choose a key unique to one logical message, such as
 * `<run id>/<purpose>`; the key is data in the channel, never a secret.
 *
 * The lookup depends on Slack returning metadata from `conversations.history`
 * and `conversations.replies` when `include_all_metadata` is set. That is
 * exercised against fixture servers here, not against a live workspace.
 *
 * One Slack app can speak as several personas: a post may name a
 * {@link Persona}, a display name and icon Slack shows instead of the app's
 * own. That needs the `chat:write.customize` bot scope; without it Slack
 * refuses the post (`missing_scope`), which is a known outcome.
 *
 * Each action resolves its client through `Connections.SlackConnections`, so
 * the channel must be one the connection grants.
 *
 * @since 1.0.0
 */
import { Action, type FlowRuntime } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import { fromIntegrationError, IntegrationFailure } from "../core/ActionFailure.ts"
import { IntegrationError } from "../core/IntegrationError.ts"
import { SlackConnections } from "./Connections.ts"
import { ChannelId, Ts } from "./Payload.ts"
import { nextCursor, type SlackClient } from "./SlackClient.ts"

/**
 * The metadata event type every post is stamped with.
 *
 * @category constants
 * @since 1.0.0
 */
export const METADATA_EVENT_TYPE = "smithers_message"

/**
 * The longest message text an action sends. Slack truncates beyond it.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_TEXT_LENGTH = 40_000

/**
 * A reconcile key: 1 to 128 letters, digits, and `.`, `_`, `:`, `/`, `-`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SmithersKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:/-]{1,128}$/))

const MessageText = Schema.NonEmptyString.check(Schema.isMaxLength(MAX_TEXT_LENGTH))

/**
 * The name and icon a post is shown under, for one app speaking as several
 * roles. Give at most one of `iconEmoji` (`:robot_face:`) and `iconUrl`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Persona = Schema.Struct({
  /** The display name, 1 to 80 characters. */
  username: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
  iconEmoji: Schema.optional(Schema.String.check(Schema.isPattern(/^:[a-z0-9_+'-]{1,100}:$/))),
  iconUrl: Schema.optional(Schema.String.check(Schema.isPattern(/^https:\/\/\S{1,2000}$/)))
}).check(
  Schema.makeFilter((persona) =>
    persona.iconEmoji === undefined || persona.iconUrl === undefined || "must name one icon, not both"
  )
)

/**
 * The persona fields `chat.postMessage` takes.
 *
 * @category constructors
 * @since 1.0.0
 */
export const personaParams = (persona: typeof Persona.Type | undefined): Readonly<Record<string, string>> =>
  persona === undefined ? {} : {
    username: persona.username,
    ...(persona.iconEmoji === undefined ? {} : { icon_emoji: persona.iconEmoji }),
    ...(persona.iconUrl === undefined ? {} : { icon_url: persona.iconUrl })
  }

/**
 * What {@link PostMessage} needs.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PostMessagePayload = Schema.Struct({
  connectionId: Schema.NonEmptyString,
  channel: ChannelId,
  text: MessageText,
  /** Replies in this thread when set. */
  threadTs: Schema.optional(Ts),
  /** Block Kit blocks; `text` stays the notification fallback. */
  blocks: Schema.optional(Schema.Array(Schema.Json)),
  /** The reconcile key stamped into the message's metadata. */
  key: SmithersKey,
  /** Shows the post under this name and icon. Needs `chat:write.customize`. */
  persona: Schema.optional(Persona)
})

/**
 * What Slack accepted.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Posted = Schema.Struct({
  connectionId: Schema.String,
  channel: Schema.String,
  ts: Ts,
  key: SmithersKey,
  /** The message link, when Slack answered `chat.getPermalink`. */
  permalink: Schema.optional(Schema.String)
})

/**
 * Posts a message to a channel or thread.
 *
 * @category actions
 * @since 1.0.0
 */
export const PostMessage = Action.make("integrations/slack/post-message", {
  payload: PostMessagePayload,
  success: Posted,
  error: IntegrationFailure,
  tier: "irreversible"
})

/**
 * What {@link UpdateMessage} needs.
 *
 * @category schemas
 * @since 1.0.0
 */
export const UpdateMessagePayload = Schema.Struct({
  connectionId: Schema.NonEmptyString,
  channel: ChannelId,
  ts: Ts,
  text: MessageText,
  blocks: Schema.optional(Schema.Array(Schema.Json))
})

/**
 * The message Slack updated.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Updated = Schema.Struct({
  connectionId: Schema.String,
  channel: Schema.String,
  ts: Ts
})

/**
 * Replaces a message's text and blocks. The metadata the post stamped stays.
 *
 * An update sets content rather than adding it, so a flow may run the same
 * update again after an `outcomeUnknown`; the action itself never does.
 *
 * @category actions
 * @since 1.0.0
 */
export const UpdateMessage = Action.make("integrations/slack/update-message", {
  payload: UpdateMessagePayload,
  success: Updated,
  error: IntegrationFailure,
  tier: "irreversible"
})

/**
 * What {@link Reconcile} needs.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ReconcilePayload = Schema.Struct({
  connectionId: Schema.NonEmptyString,
  channel: ChannelId,
  key: SmithersKey,
  /** Searches this thread's replies instead of the conversation. */
  threadTs: Schema.optional(Ts),
  /** Searches only messages after this timestamp. */
  oldest: Schema.optional(Ts),
  /** Pages of 200 messages to search at most. Defaults to 5. */
  maxPages: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })))
})

/**
 * Whether the key is in the conversation.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ReconcileStatus = Schema.Literals(["found", "absent", "inconclusive"])

/**
 * What {@link Reconcile} found.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Reconciled = Schema.Struct({
  connectionId: Schema.String,
  channel: Schema.String,
  key: SmithersKey,
  status: ReconcileStatus,
  /** The found message's timestamp, or `null`. */
  ts: Schema.NullOr(Ts),
  pagesSearched: Schema.Int
})

/**
 * Looks for a post's key after an unknown outcome.
 *
 * It reads and never writes. The result is recorded like any sealed step, so
 * a replayed run sees the answer its first execution acted on.
 *
 * @category actions
 * @since 1.0.0
 */
export const Reconcile = Action.make("integrations/slack/reconcile-post", {
  payload: ReconcilePayload,
  success: Reconciled,
  error: IntegrationFailure,
  tier: "sealed",
  nondeterministic: true
})

/**
 * The metadata a post carries so {@link Reconcile} can find it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const metadata = (key: string) => ({ event_type: METADATA_EVENT_TYPE, event_payload: { smithers_key: key } })

const Stamped = Schema.Struct({
  ts: Ts,
  metadata: Schema.Struct({
    event_type: Schema.Literal(METADATA_EVENT_TYPE),
    event_payload: Schema.Struct({ smithers_key: Schema.String })
  })
})
const asStamped = Schema.decodeUnknownOption(Stamped)
const isTs = Schema.is(Ts)

/**
 * What {@link findPosted} searches.
 *
 * @category models
 * @since 1.0.0
 */
export interface FindOptions {
  readonly channel: string
  readonly key: string
  readonly threadTs?: string | undefined
  readonly oldest?: string | undefined
  readonly maxPages?: number | undefined
}

/**
 * The search {@link Reconcile} runs, over a client.
 *
 * @category constructors
 * @since 1.0.0
 */
export const findPosted = (
  client: SlackClient,
  options: FindOptions
): Effect.Effect<
  { readonly status: typeof ReconcileStatus.Type; readonly ts: string | null; readonly pagesSearched: number },
  IntegrationError
> =>
  Effect.gen(function*() {
    const method = options.threadTs === undefined ? "conversations.history" : "conversations.replies"
    const maxPages = options.maxPages ?? 5
    let cursor: string | null = null
    let pages = 0
    do {
      const answer: Readonly<Record<string, unknown>> = yield* client.call(method, {
        channel: options.channel,
        ts: options.threadTs,
        oldest: options.oldest,
        include_all_metadata: true,
        limit: 200,
        cursor: cursor ?? undefined
      })
      const messages = answer["messages"]
      if (!Array.isArray(messages)) {
        return yield* Effect.fail(
          new IntegrationError("decode-failed", `Slack ${method} answered without messages.`, {
            method,
            retryable: false,
            outcomeUnknown: false
          })
        )
      }
      pages += 1
      for (const message of messages) {
        const stamped = asStamped(message)
        if (stamped._tag === "Some" && stamped.value.metadata.event_payload.smithers_key === options.key) {
          return { status: "found" as const, ts: stamped.value.ts, pagesSearched: pages }
        }
      }
      cursor = nextCursor(answer)
    } while (cursor !== null && pages < maxPages)
    return { status: cursor === null ? "absent" as const : "inconclusive" as const, ts: null, pagesSearched: pages }
  })

// The post happened; a link is a convenience. Failing to read one must not
// turn a delivered message into a failed step.
const permalinkOf = (client: SlackClient, channel: string, ts: string) =>
  client.call("chat.getPermalink", { channel, message_ts: ts }).pipe(
    Effect.map((answer) => typeof answer["permalink"] === "string" ? answer["permalink"] : undefined),
    Effect.catch((error) =>
      Effect.logWarning("Slack chat.getPermalink failed after a delivered post", error).pipe(Effect.as(undefined))
    )
  )

/**
 * Implements {@link PostMessage} over the connections in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerPostMessage: Layer.Layer<
  Action.Requirement<"integrations/slack/post-message">,
  never,
  SlackConnections | FlowRuntime.FlowRuntime
> = PostMessage.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* (yield* SlackConnections).resolve(payload.connectionId, payload.channel)
    const answer = yield* client.call("chat.postMessage", {
      channel: payload.channel,
      text: payload.text,
      thread_ts: payload.threadTs,
      blocks: payload.blocks,
      metadata: metadata(payload.key),
      ...personaParams(payload.persona)
    })
    const ts = answer["ts"]
    if (!isTs(ts)) {
      // Slack said ok, so the message is there; only its name is missing.
      return yield* Effect.fail(
        new IntegrationError("decode-failed", "Slack chat.postMessage answered ok without a message ts.", {
          retryable: false,
          outcomeUnknown: true
        })
      )
    }
    const permalink = yield* permalinkOf(client, payload.channel, ts)
    return {
      connectionId: payload.connectionId,
      channel: payload.channel,
      ts,
      key: payload.key,
      ...(permalink === undefined ? {} : { permalink })
    }
  }).pipe(Effect.mapError(fromIntegrationError))
)

/**
 * Implements {@link UpdateMessage} over the connections in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerUpdateMessage: Layer.Layer<
  Action.Requirement<"integrations/slack/update-message">,
  never,
  SlackConnections | FlowRuntime.FlowRuntime
> = UpdateMessage.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* (yield* SlackConnections).resolve(payload.connectionId, payload.channel)
    yield* client.call("chat.update", {
      channel: payload.channel,
      ts: payload.ts,
      text: payload.text,
      blocks: payload.blocks
    })
    return { connectionId: payload.connectionId, channel: payload.channel, ts: payload.ts }
  }).pipe(Effect.mapError(fromIntegrationError))
)

/**
 * Implements {@link Reconcile} over the connections in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerReconcile: Layer.Layer<
  Action.Requirement<"integrations/slack/reconcile-post">,
  never,
  SlackConnections | FlowRuntime.FlowRuntime
> = Reconcile.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* (yield* SlackConnections).resolve(payload.connectionId, payload.channel)
    const found = yield* findPosted(client, payload)
    return { connectionId: payload.connectionId, channel: payload.channel, key: payload.key, ...found }
  }).pipe(Effect.mapError(fromIntegrationError))
)

/** Delete a bot-authored message. Slack refuses deletion of other authors' posts.
 * @category actions
 * @since 1.0.0
 */
export const DeleteMessage = Action.make("integrations/slack/delete-message", {
  payload: Schema.Struct({ connectionId: Schema.NonEmptyString, channel: ChannelId, ts: Ts }),
  success: Updated,
  error: IntegrationFailure,
  tier: "irreversible"
})

/** Add/remove this bot's reaction. Missing scope is an explicit unsupported receipt.
 * @category actions
 * @since 1.0.0
 */
export const SetReaction = Action.make("integrations/slack/set-reaction", {
  payload: Schema.Struct({
    connectionId: Schema.NonEmptyString,
    channel: ChannelId,
    ts: Ts,
    name: Schema.String.check(Schema.isPattern(/^[a-z0-9_+-]{1,64}$/)),
    active: Schema.Boolean
  }),
  success: Schema.Struct({ status: Schema.Literals(["applied", "unsupported"]) }),
  error: IntegrationFailure,
  tier: "irreversible"
})

/** Implements message deletion through the authorized connection.
 * @category layers
 * @since 1.0.0
 */
export const layerDeleteMessage = DeleteMessage.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* (yield* SlackConnections).resolve(payload.connectionId, payload.channel)
    yield* client.call("chat.delete", { channel: payload.channel, ts: payload.ts }).pipe(
      Effect.catch((error) => error.details?.["slackError"] === "message_not_found" ? Effect.void : Effect.fail(error))
    )
    return { connectionId: payload.connectionId, channel: payload.channel, ts: payload.ts }
  }).pipe(Effect.mapError(fromIntegrationError))
)

/** Implements reaction changes and explicit missing-scope receipts.
 * @category layers
 * @since 1.0.0
 */
export const layerSetReaction = SetReaction.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* (yield* SlackConnections).resolve(payload.connectionId, payload.channel)
    return yield* client.call(payload.active ? "reactions.add" : "reactions.remove", {
      channel: payload.channel,
      timestamp: payload.ts,
      name: payload.name
    }).pipe(
      Effect.as({ status: "applied" as const }),
      Effect.catch((error): Effect.Effect<{ readonly status: "applied" | "unsupported" }, IntegrationError> => {
        const code = error.details?.["slackError"]
        if (code === "missing_scope") return Effect.succeed({ status: "unsupported" as const })
        if (code === (payload.active ? "already_reacted" : "no_reaction")) {
          return Effect.succeed({ status: "applied" as const })
        }
        return Effect.fail(error)
      })
    )
  }).pipe(Effect.mapError(fromIntegrationError))
)

/**
 * Every Slack action's implementation, in one layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<
  | Action.Requirement<"integrations/slack/post-message">
  | Action.Requirement<"integrations/slack/update-message">
  | Action.Requirement<"integrations/slack/reconcile-post">
  | Action.Requirement<"integrations/slack/delete-message">
  | Action.Requirement<"integrations/slack/set-reaction">,
  never,
  SlackConnections | FlowRuntime.FlowRuntime
> = Layer.mergeAll(layerPostMessage, layerUpdateMessage, layerReconcile, layerDeleteMessage, layerSetReaction)
