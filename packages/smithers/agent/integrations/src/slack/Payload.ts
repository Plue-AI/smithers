/**
 * Slack payload schemas, and the one decoding every Slack ingress shares.
 *
 * An Events API delivery arrives over HTTP (`Slack.Webhook`) or inside a
 * Socket Mode envelope (`Slack.SocketSource`), and a Block Kit button press
 * arrives as a `block_actions` interaction. All of them pass through
 * {@link classify} and {@link toExternalEvent} here, so both doors admit
 * exactly the same deliveries and name them the same way.
 *
 * Admission fails closed. A delivery is admitted only when its workspace is in
 * `allowedTeamIds`, its channel is in `allowedChannelIds` (or it is a direct
 * message and `allowedUserIds` is set), its author is neither a bot nor this
 * app itself, and, when `allowedUserIds` is set, its author is one of those
 * people. A delivery whose channel or author cannot be determined is refused,
 * because an allowlist that admits what it cannot classify is not one. Refusing the app's own messages is the echo filter: an
 * agent that answers in a channel must not wake on its own answer.
 *
 * The delivered payload keeps Slack's shape, minus the fields that are
 * credentials: the legacy verification `token` and the `response_url`
 * capability are removed before the payload can reach a journal.
 *
 * @since 1.0.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import { Schema } from "effect"
import type { ExternalEvent } from "../core/ExternalEvent.ts"
import { IntegrationError } from "../core/IntegrationError.ts"
import * as SignalName from "../core/SignalName.ts"

/**
 * The service segment of every Slack signal name.
 *
 * @category constants
 * @since 1.0.0
 */
export const SERVICE = "slack"

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const

const open = <Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.StructWithRest(Schema.Struct(fields), rest)

/**
 * A Slack message timestamp, `<seconds>.<fraction>`: a message's identity
 * within its channel.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Ts = Schema.String.check(Schema.isPattern(/^\d{1,12}\.\d{1,9}$/))

/**
 * A conversation id: a public or private channel, a group, or a direct
 * message. Names are refused, because a name can be renamed onto another
 * conversation and an allowlist compares ids.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ChannelId = Schema.String.check(Schema.isPattern(/^[CDG][A-Z0-9]{2,31}$/))

/**
 * The edit marker on a changed message.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Edited = open({ user: Schema.optional(Schema.String), ts: Ts })

/**
 * A message as `conversations.history`, `conversations.replies`, and message
 * events carry it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Message = open({
  type: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  ts: Ts,
  thread_ts: Schema.optional(Ts),
  reply_count: Schema.optional(Schema.Number),
  latest_reply: Schema.optional(Ts),
  edited: Schema.optional(Edited),
  metadata: Schema.optional(open({ event_type: Schema.String, event_payload: Schema.optional(Schema.Unknown) }))
})

/**
 * A `message` event, including the `message_changed` and `message_deleted`
 * subtypes, whose subject is nested under `message` and `previous_message`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MessageEvent = open({
  type: Schema.Literal("message"),
  channel: Schema.String,
  channel_type: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  ts: Ts,
  event_ts: Schema.optional(Ts),
  user: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thread_ts: Schema.optional(Ts),
  message: Schema.optional(Message),
  previous_message: Schema.optional(Message),
  deleted_ts: Schema.optional(Ts)
})

/**
 * One installation an Events API delivery was sent for.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Authorization = open({
  team_id: Schema.optional(Schema.NullOr(Schema.String)),
  user_id: Schema.optional(Schema.String),
  is_bot: Schema.optional(Schema.Boolean)
})

/**
 * An Events API delivery, delivered for `integration:slack:<event type>`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EventCallback = open({
  type: Schema.Literal("event_callback"),
  team_id: Schema.String,
  api_app_id: Schema.optional(Schema.String),
  event_id: Schema.String,
  event_time: Schema.optional(Schema.Number),
  event: open({ type: Schema.String }),
  authorizations: Schema.optional(Schema.Array(Authorization))
})

/**
 * The Events API's endpoint check, answered by the HTTP host.
 *
 * @category schemas
 * @since 1.0.0
 */
export const UrlVerification = open({ type: Schema.Literal("url_verification"), challenge: Schema.String })

/**
 * One pressed Block Kit element.
 *
 * @category schemas
 * @since 1.0.0
 */
export const BlockAction = open({
  action_id: Schema.String,
  block_id: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  action_ts: Schema.optional(Schema.String)
})

/**
 * A Block Kit interaction, delivered for `integration:slack:block_actions`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const BlockActions = open({
  type: Schema.Literal("block_actions"),
  team: Schema.NullOr(open({ id: Schema.String })),
  user: open({ id: Schema.String, team_id: Schema.optional(Schema.String) }),
  channel: Schema.optional(open({ id: Schema.String })),
  container: Schema.optional(open({
    channel_id: Schema.optional(Schema.String),
    message_ts: Schema.optional(Schema.String),
    thread_ts: Schema.optional(Schema.String)
  })),
  trigger_id: Schema.optional(Schema.String),
  actions: Schema.Array(BlockAction)
})

/**
 * One Socket Mode frame: `hello`, `disconnect`, or an envelope to acknowledge.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SocketEnvelope = open({
  type: Schema.String,
  envelope_id: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
  reason: Schema.optional(Schema.String),
  retry_attempt: Schema.optional(Schema.Number)
})

const asCallback = Schema.decodeUnknownOption(EventCallback)
const asBlockActions = Schema.decodeUnknownOption(BlockActions)

/**
 * Who may reach a flow through a Slack door.
 *
 * @category models
 * @since 1.0.0
 */
export interface Policy {
  /** Workspace ids admitted. Required and non-empty. */
  readonly allowedTeamIds: ReadonlyArray<string>
  /**
   * Conversation ids admitted. Required and non-empty unless `allowedUserIds`
   * is set.
   */
  readonly allowedChannelIds?: ReadonlyArray<string> | undefined
  /**
   * The people who may reach a flow. When set and non-empty, every admitted
   * delivery must be authored (or, for a button press, pressed) by one of
   * them, and their direct messages (`D…` conversations) are admitted without
   * listing the conversation, so an owner's first DM works before its id is
   * known.
   */
  readonly allowedUserIds?: ReadonlyArray<string> | undefined
  /**
   * User ids that are this app, beyond the bot users a delivery's
   * `authorizations` name. Their deliveries are echoes and are refused.
   */
  readonly selfUserIds?: ReadonlyArray<string> | undefined
}

const nonEmptyIds = (list: unknown): boolean =>
  Array.isArray(list) && list.length > 0 && list.every((id) => typeof id === "string" && id.length > 0)

const idsOrAbsent = (list: unknown): boolean =>
  list === undefined || (Array.isArray(list) && list.every((id) => typeof id === "string" && id.length > 0))

/**
 * Returns `policy` when `allowedTeamIds` is a non-empty list of ids and
 * `allowedChannelIds` or `allowedUserIds` is too.
 *
 * Throws `IntegrationError` with reason `invalid-config` otherwise: an empty
 * allowlist would either admit nothing, silently, or be mistaken for "admit
 * everything", and neither belongs in a running door.
 *
 * @category constructors
 * @since 1.0.0
 */
export const requirePolicy = (policy: Policy, where: string): Policy => {
  const channels = policy?.allowedChannelIds
  const users = policy?.allowedUserIds
  if (
    !nonEmptyIds(policy?.allowedTeamIds) || !idsOrAbsent(channels) || !idsOrAbsent(users) ||
    !idsOrAbsent(policy?.selfUserIds) || !(nonEmptyIds(channels) || nonEmptyIds(users))
  ) {
    throw new IntegrationError(
      "invalid-config",
      `${where} requires non-empty allowedTeamIds, and non-empty allowedChannelIds or allowedUserIds, before it can admit a delivery.`,
      { source: SERVICE, retryable: false }
    )
  }
  return policy
}

/**
 * Whether a conversation id names a direct message.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isDirectMessage = (channelId: string): boolean => channelId.startsWith("D")

/**
 * Why a delivery was not admitted.
 *
 * - `unsupported`: not an event callback or a block action this module can
 *   name and deduplicate.
 * - `team-not-allowed`: the workspace is not in `allowedTeamIds`.
 * - `channel-not-allowed`: the conversation is not in `allowedChannelIds`, or
 *   the delivery names none.
 * - `bot-author`: a bot wrote it.
 * - `self-author`: this app wrote it.
 * - `user-not-allowed`: `allowedUserIds` is set and does not name the author.
 *
 * @category models
 * @since 1.0.0
 */
export type RefusalReason =
  | "unsupported"
  | "team-not-allowed"
  | "channel-not-allowed"
  | "bot-author"
  | "self-author"
  | "user-not-allowed"

/**
 * The admission decision for one delivery.
 *
 * @category models
 * @since 1.0.0
 */
export type Classification =
  | {
    readonly _tag: "Admitted"
    readonly teamId: string
    readonly channelId: string
    /** The delivery identity, `slack:<team>:<event id>`. */
    readonly key: string
    readonly names: ReadonlyArray<string>
  }
  | { readonly _tag: "Refused"; readonly reason: RefusalReason }

const refused = (reason: RefusalReason): Classification => ({ _tag: "Refused", reason })

const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined

const channelOfEvent = (event: Readonly<Record<string, unknown>>): string | undefined => {
  const item = event["item"]
  return text(event["channel"]) ?? (isRecord(item) ? text(item["channel"]) : undefined)
}

// The subject of an edit or a deletion is the nested message, not the event.
const authorOfEvent = (event: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const inner = event["subtype"] === "message_changed"
    ? event["message"]
    : event["subtype"] === "message_deleted"
    ? event["previous_message"]
    : undefined
  return isRecord(inner) ? inner : event
}

const threadOfEvent = (event: Readonly<Record<string, unknown>>): string | undefined =>
  text(event["thread_ts"]) ?? text(authorOfEvent(event)["thread_ts"])

const eventNamesOf = (type: string, subtype: unknown): ReadonlyArray<string> => {
  if (!SignalName.isSegment(type)) return []
  const base = SignalName.eventName(SERVICE, type)
  return SignalName.isSegment(subtype) ? [SignalName.eventName(SERVICE, `${type}.${subtype}`), base] : [base]
}

interface Subject {
  readonly teamId: string
  readonly channelId: string | undefined
  readonly thread: string | undefined
  readonly author: Readonly<Record<string, unknown>>
  readonly selfIds: ReadonlyArray<string>
  readonly key: string | undefined
  readonly names: ReadonlyArray<string>
}

const subjectOf = (payload: unknown): Subject | undefined => {
  const callback = asCallback(payload)
  if (callback._tag === "Some") {
    const { authorizations, event, event_id, team_id } = callback.value
    return {
      teamId: team_id,
      channelId: channelOfEvent(event),
      thread: threadOfEvent(event),
      author: authorOfEvent(event),
      selfIds: (authorizations ?? []).flatMap((entry) =>
        entry.is_bot === true && entry.user_id !== undefined ? [entry.user_id] : []
      ),
      key: `${SERVICE}:${team_id}:${event_id}`,
      names: eventNamesOf(event.type, event["subtype"])
    }
  }
  const interaction = asBlockActions(payload)
  if (interaction._tag === "Some") {
    const { channel, container, team, trigger_id, user } = interaction.value
    const teamId = team?.id ?? user.team_id ?? ""
    return {
      teamId,
      channelId: channel?.id ?? container?.channel_id,
      thread: container?.thread_ts,
      author: { user: user.id },
      selfIds: [],
      key: trigger_id === undefined ? undefined : `${SERVICE}:${teamId}:action:${trigger_id}`,
      names: eventNamesOf("block_actions", undefined)
    }
  }
  return undefined
}

/**
 * Decides whether one delivery may reach a flow.
 *
 * The checks run in a fixed order, and the first failing one names the
 * refusal: shape, workspace, conversation, bot author, self author, person.
 *
 * @category constructors
 * @since 1.0.0
 */
export const classify = (payload: unknown, policy: Policy): Classification => {
  const subject = subjectOf(payload)
  if (subject === undefined || subject.key === undefined || subject.names.length === 0) return refused("unsupported")
  if (!policy.allowedTeamIds.includes(subject.teamId)) return refused("team-not-allowed")
  const channelId = subject.channelId
  const people = policy.allowedUserIds ?? []
  const channelAllowed = channelId !== undefined &&
    ((policy.allowedChannelIds ?? []).includes(channelId) || (people.length > 0 && isDirectMessage(channelId)))
  if (!channelAllowed) return refused("channel-not-allowed")
  if (typeof subject.author["bot_id"] === "string" || subject.author["subtype"] === "bot_message") {
    return refused("bot-author")
  }
  const user = subject.author["user"]
  if (typeof user === "string" && [...(policy.selfUserIds ?? []), ...subject.selfIds].includes(user)) {
    return refused("self-author")
  }
  if (people.length > 0 && (typeof user !== "string" || !people.includes(user))) return refused("user-not-allowed")
  return { _tag: "Admitted", teamId: subject.teamId, channelId, key: subject.key, names: subject.names }
}

/**
 * The delivery identity of an event callback or a block action,
 * `slack:<team>:<event id>` or `slack:<team>:action:<trigger id>`, or
 * `undefined` for anything else.
 *
 * A Slack retry of the same event carries the same identity, so this is the
 * key `Channels.ingest` and `Control.signal` deduplicate on.
 *
 * @category getters
 * @since 1.0.0
 */
export const idempotencyKey = (payload: unknown): string | undefined => subjectOf(payload)?.key

/**
 * The correlation for a conversation.
 *
 * @category constructors
 * @since 1.0.0
 */
export const channelCorrelationId = (channelId: string): string => `channel:${channelId}`

/**
 * The correlation for a thread within a conversation.
 *
 * @category constructors
 * @since 1.0.0
 */
export const threadCorrelationId = (channelId: string, threadTs: string): string =>
  `channel:${channelId}:thread:${threadTs}`

/**
 * The correlations a delivery answers to, most specific first: the thread,
 * the conversation, then `null`.
 *
 * @category getters
 * @since 1.0.0
 */
export const correlations = (payload: unknown): ReadonlyArray<string | null> => {
  const subject = subjectOf(payload)
  const channelId = subject?.channelId
  if (channelId === undefined) return [null]
  const thread = subject?.thread
  return thread === undefined
    ? [channelCorrelationId(channelId), null]
    : [threadCorrelationId(channelId, thread), channelCorrelationId(channelId), null]
}

/**
 * The signal names a delivery answers to, most specific first: a message
 * subtype (`integration:slack:message.message_changed`) ahead of the bare
 * type (`integration:slack:message`). Empty for a delivery this module does
 * not name.
 *
 * @category getters
 * @since 1.0.0
 */
export const names = (payload: unknown): ReadonlyArray<string> => subjectOf(payload)?.names ?? []

/**
 * The payload without the fields that are credentials: the legacy
 * verification `token` and the `response_url` capabilities.
 *
 * @category conversions
 * @since 1.0.0
 */
export const redact = (payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const { response_url: _responseUrl, response_urls: _responseUrls, token: _token, ...kept } = payload
  return kept
}

/**
 * A policy refusal, classified independently of the message.
 *
 * @category errors
 * @since 1.0.0
 */
export class SlackRefused extends IntegrationError {
  readonly refusal: RefusalReason

  constructor(refusal: RefusalReason) {
    super("permission-denied", `Slack delivery refused: ${refusal}.`, {
      source: SERVICE,
      refusal,
      retryable: false
    })
    this.refusal = refusal
  }
}

/**
 * What {@link toExternalEvent} needs beyond the payload.
 *
 * @category models
 * @since 1.0.0
 */
export interface DecodeOptions {
  /** The event's `source`: the channel or source id. Defaults to {@link SERVICE}. */
  readonly source?: string | undefined
  readonly policy: Policy
  readonly receivedAtMs?: number | undefined
}

/**
 * Decodes one admitted delivery into the normalized event.
 *
 * The event is named at its most specific form and correlated to its thread
 * when it has one; {@link names} and {@link correlations} expose the ladder.
 * Its dedupe key is the delivery identity, so a Slack retry dedupes.
 *
 * Throws {@link SlackRefused} for a delivery {@link classify} refuses.
 *
 * @category constructors
 * @since 1.0.0
 */
export const toExternalEvent = (payload: unknown, options: DecodeOptions): ExternalEvent => {
  const verdict = classify(payload, options.policy)
  if (verdict._tag === "Refused") throw new SlackRefused(verdict.reason)
  return {
    source: options.source ?? SERVICE,
    eventName: verdict.names[0] as string,
    correlationId: correlations(payload)[0] as string | null,
    payload: redact(payload as Readonly<Record<string, unknown>>) as ExternalEvent["payload"],
    dedupeKey: verdict.key,
    receivedAtMs: options.receivedAtMs ?? Date.now()
  }
}
