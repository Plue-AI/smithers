/**
 * The durable Gmail actions.
 *
 * `CreateDraft` and `SendMessage` compose an RFC 2822 message and write it
 * through the client in context. Both are `irreversible`: a draft is a write
 * someone may open, and a sent message is delivered. Neither the engine nor
 * the client repeats one. A 5xx, a timeout or a dropped connection fails with
 * `outcomeUnknown`, and the next step is `FindByKey`, which looks for the
 * message by the key both writes stamp into it before anything is written
 * again. Distinct writes need distinct keys.
 *
 * Every payload names its connection, and the implementation refuses a
 * payload whose connection is not the one the client in context is bound to,
 * so a flow cannot write through an account the host did not give it. The
 * payload schemas refuse control characters in any header value, so a CR or
 * LF in a subject or an address never reaches a message.
 *
 * Which principal may run these, and whether a send needs approval first, is
 * host policy; these declarations only state what they do.
 *
 * @since 1.0.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import { Clock, Effect, Layer, Schema } from "effect"
import { fromIntegrationError, IntegrationFailure } from "../core/ActionFailure.ts"
import { IntegrationError } from "../core/IntegrationError.ts"
import { GmailClient, GmailId } from "./GmailClient.ts"
import * as Mime from "./Mime.ts"
import { findByKey, Match } from "./Reconcile.ts"

/**
 * What {@link CreateDraft} and {@link SendMessage} write.
 *
 * `threadId` files the message into an existing Gmail thread; `inReplyTo`
 * and `references` are the RFC 2822 threading headers other clients read.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ComposePayload = Schema.Struct({
  connectionId: Schema.NonEmptyString,
  threadId: Schema.optionalKey(GmailId),
  ...Mime.Draft.fields
})

/**
 * What {@link CreateDraft} and {@link SendMessage} write.
 *
 * @category models
 * @since 1.0.0
 */
export type ComposePayload = typeof ComposePayload.Type

/**
 * The draft Gmail stored.
 *
 * @category schemas
 * @since 1.0.0
 */
export const DraftCreated = Schema.Struct({
  connectionId: Schema.String,
  draftId: Schema.String,
  messageId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  rfc822MessageId: Schema.String,
  key: Schema.String
})

/**
 * The message Gmail sent.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MessageSent = Schema.Struct({
  connectionId: Schema.String,
  messageId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  labelIds: Schema.Array(Schema.String),
  rfc822MessageId: Schema.String,
  key: Schema.String
})

/**
 * What {@link FindByKey} looks for.
 *
 * @category schemas
 * @since 1.0.0
 */
export const FindByKeyPayload = Schema.Struct({
  connectionId: Schema.NonEmptyString,
  key: Mime.SmithersKey
})

/**
 * What {@link FindByKey} found.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Found = Schema.Struct({
  connectionId: Schema.String,
  key: Schema.String,
  rfc822MessageId: Schema.String,
  matches: Schema.Array(Match)
})

/**
 * Creates a draft.
 *
 * @category actions
 * @since 1.0.0
 */
export const CreateDraft = Action.make("integrations/gmail/create-draft", {
  payload: ComposePayload,
  success: DraftCreated,
  error: IntegrationFailure,
  tier: "irreversible",
  capabilities: ["net:post:https://gmail.googleapis.com/gmail/v1/users/*/drafts"]
})

/**
 * Sends a message.
 *
 * @category actions
 * @since 1.0.0
 */
export const SendMessage = Action.make("integrations/gmail/send-message", {
  payload: ComposePayload,
  success: MessageSent,
  error: IntegrationFailure,
  tier: "irreversible",
  capabilities: ["net:post:https://gmail.googleapis.com/gmail/v1/users/*/messages/send"]
})

/**
 * Looks up the messages carrying a key, after an `outcomeUnknown` write.
 *
 * Sealed and keyless, so its answer is journaled for this invocation and a
 * later lookup asks Gmail again rather than reusing it.
 *
 * @category actions
 * @since 1.0.0
 */
export const FindByKey = Action.make("integrations/gmail/find-by-key", {
  payload: FindByKeyPayload,
  success: Found,
  error: IntegrationFailure,
  tier: "sealed",
  nondeterministic: true,
  capabilities: ["net:get:https://gmail.googleapis.com/gmail/v1/users/*/messages"]
})

// The client in context is bound to one connection; a payload naming another
// one is refused before anything is composed or sent.
const boundClient = (connectionId: string) =>
  Effect.flatMap(GmailClient, (client) =>
    client.connectionId === connectionId ? Effect.succeed(client) : Effect.fail(
      new IntegrationError(
        "permission-denied",
        `The Gmail client in context is not bound to connection "${connectionId}".`,
        { connectionId, retryable: false }
      )
    ))

const composed = (payload: ComposePayload) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => Mime.compose(payload, now))

/**
 * Implements {@link CreateDraft} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerCreateDraft: Layer.Layer<
  Action.Requirement<"integrations/gmail/create-draft">,
  never,
  GmailClient | FlowRuntime.FlowRuntime
> = CreateDraft.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* boundClient(payload.connectionId)
    const message = yield* composed(payload)
    const draft = yield* client.createDraft(message.raw, { threadId: payload.threadId })
    return {
      connectionId: payload.connectionId,
      draftId: draft.id,
      messageId: draft.message.id,
      threadId: draft.message.threadId ?? null,
      rfc822MessageId: message.messageId,
      key: message.key
    }
  }).pipe(Effect.mapError(fromIntegrationError))
)

/**
 * Implements {@link SendMessage} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerSendMessage: Layer.Layer<
  Action.Requirement<"integrations/gmail/send-message">,
  never,
  GmailClient | FlowRuntime.FlowRuntime
> = SendMessage.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* boundClient(payload.connectionId)
    const message = yield* composed(payload)
    const sent = yield* client.sendMessage(message.raw, { threadId: payload.threadId })
    return {
      connectionId: payload.connectionId,
      messageId: sent.id,
      threadId: sent.threadId ?? null,
      labelIds: [...(sent.labelIds ?? [])],
      rfc822MessageId: message.messageId,
      key: message.key
    }
  }).pipe(Effect.mapError(fromIntegrationError))
)

/**
 * Implements {@link FindByKey} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerFindByKey: Layer.Layer<
  Action.Requirement<"integrations/gmail/find-by-key">,
  never,
  GmailClient | FlowRuntime.FlowRuntime
> = FindByKey.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* boundClient(payload.connectionId)
    const matches = yield* findByKey(client, payload.key)
    return {
      connectionId: payload.connectionId,
      key: payload.key,
      rfc822MessageId: Mime.messageIdFor(payload.key),
      matches
    }
  }).pipe(Effect.mapError(fromIntegrationError))
)

/**
 * Every Gmail action's implementation, in one layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<
  | Action.Requirement<"integrations/gmail/create-draft">
  | Action.Requirement<"integrations/gmail/send-message">
  | Action.Requirement<"integrations/gmail/find-by-key">,
  never,
  GmailClient | FlowRuntime.FlowRuntime
> = Layer.mergeAll(layerCreateDraft, layerSendMessage, layerFindByKey)
