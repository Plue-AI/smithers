/**
 * Slack conversation history as a source-sync change feed.
 *
 * One {@link make} adapter follows one conversation. Its cursor is a
 * watermark: the newest message timestamp a completed pass has seen. A pass
 * asks `conversations.history` for everything after the watermark, one page
 * per `changes` call, newest page first, and the cursor it returns names the
 * page to read next, so a process that dies between pages re-reads one page
 * rather than skipping it. Only the last page of a pass advances the
 * watermark. Every record is keyed by `<channel>:<ts>` and versioned by its
 * last edit, so reading a page twice changes nothing.
 *
 * History lists thread roots, not replies. Each root a pass sees is tracked in
 * the cursor, and the last page of every pass also lists
 * `conversations.replies` after the newest reply seen for each tracked
 * thread. Tracking is bounded: at most `maxTrackedThreads` threads, each for
 * `threadWindowSeconds` after its root. A reply to an older, untracked thread
 * reaches the store only through an event ({@link eventRecord}).
 *
 * Edits and deletions come from two places. A pass re-lists a message only
 * while it is newer than the watermark, so the `message_changed` and
 * `message_deleted` events are the authoritative source: {@link eventRecord}
 * maps an edit to a newer version of the same record, and a deletion to a
 * tombstone. History's own `tombstone` subtype, a deleted thread root whose
 * replies remain, is mapped to a tombstone as well. This feed never answers
 * `reset: true`: a Slack watermark never expires, and a page cursor Slack
 * refuses restarts the pass from the watermark instead.
 *
 * Access scope comes from the conversation type: a direct or group direct
 * message is `private`, a private channel is `container`, and a public
 * channel is `workspace`, each relative to the conversation id. A record
 * whose conversation type is unknown takes the narrowest scope.
 *
 * @since 1.0.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import { Clock, Effect, Schema } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import type { AccessScope, SourceRecord } from "../core/SourceRecord.ts"
import type { Changes, SyncAdapter } from "../core/Sync.ts"
import { EventCallback, MessageEvent, SERVICE, Ts } from "./Payload.ts"
import { nextCursor, type SlackClient } from "./SlackClient.ts"

/**
 * A conversation's type, as far as who may read it.
 *
 * @category models
 * @since 1.0.0
 */
export type ChannelType = "public" | "private" | "im" | "mpim"

/**
 * The access scope a conversation type grants.
 *
 * @category getters
 * @since 1.0.0
 */
export const accessScope = (type: ChannelType): AccessScope =>
  type === "public" ? "workspace" : type === "private" ? "container" : "private"

/**
 * The type of a `conversations.info` channel object.
 *
 * @category getters
 * @since 1.0.0
 */
export const channelTypeOf = (channel: Readonly<Record<string, unknown>>): ChannelType =>
  channel["is_im"] === true
    ? "im"
    : channel["is_mpim"] === true
    ? "mpim"
    : channel["is_private"] === true
    ? "private"
    : "public"

const EVENT_CHANNEL_TYPES: Readonly<Record<string, ChannelType>> = {
  channel: "public",
  group: "private",
  im: "im",
  mpim: "mpim"
}

/**
 * The type an event's `channel_type` names, or `undefined` for a value Slack
 * does not document.
 *
 * @category getters
 * @since 1.0.0
 */
export const eventChannelType = (channelType: unknown): ChannelType | undefined =>
  typeof channelType === "string" && Object.hasOwn(EVENT_CHANNEL_TYPES, channelType)
    ? EVENT_CHANNEL_TYPES[channelType]
    : undefined

/**
 * A Slack timestamp in Unix milliseconds. `ts` must match `Payload.Ts`.
 *
 * @category conversions
 * @since 1.0.0
 */
export const tsToMs = (ts: string): number => {
  const [seconds, fraction] = ts.split(".") as [string, string]
  return Number(seconds) * 1000 + Number(fraction.padEnd(3, "0").slice(0, 3))
}

/**
 * Unix milliseconds as a Slack-shaped timestamp, `<seconds>.<microseconds>`,
 * which orders with real Slack timestamps.
 *
 * @category conversions
 * @since 1.0.0
 */
export const msToTs = (ms: number): string =>
  `${Math.floor(ms / 1000)}.${String(Math.floor(ms % 1000) * 1000).padStart(6, "0")}`

/**
 * Orders two Slack timestamps numerically: negative, zero, or positive. Both
 * must match `Payload.Ts`.
 *
 * @category getters
 * @since 1.0.0
 */
export const compareTs = (left: string, right: string): number => {
  // Compared in two parts: a double cannot hold ten digits of seconds and six
  // of fraction exactly, and two messages one microsecond apart must differ.
  const [leftSeconds, leftFraction] = left.split(".") as [string, string]
  const [rightSeconds, rightFraction] = right.split(".") as [string, string]
  const bySeconds = Number(leftSeconds) - Number(rightSeconds)
  return Math.sign(bySeconds !== 0 ? bySeconds : Number(`0.${leftFraction}`) - Number(`0.${rightFraction}`))
}

const newer = (current: string | null, candidate: string): string =>
  current === null || compareTs(candidate, current) > 0 ? candidate : current

const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined

const isTs = Schema.is(Ts)

/**
 * Where a record came from.
 *
 * @category models
 * @since 1.0.0
 */
export interface RecordContext {
  readonly connectionId: string
  readonly channel: string
  readonly channelType: ChannelType | undefined
  readonly retrievedAtMs: number
  /** `https://<workspace>.slack.com`, to build message links. Without it, `url` is `null`. */
  readonly workspaceUrl?: string | undefined
}

/**
 * The external id of a message: `<channel>:<ts>`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const externalId = (channel: string, ts: string): string => `${channel}:${ts}`

/**
 * The link to a message in its workspace, or `null` without a workspace URL.
 *
 * @category constructors
 * @since 1.0.0
 */
export const messageUrl = (
  workspaceUrl: string | undefined,
  channel: string,
  ts: string,
  threadTs?: string | undefined
): string | null => {
  if (workspaceUrl === undefined) return null
  const base = `${workspaceUrl.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`
  return threadTs === undefined || threadTs === ts ? base : `${base}?thread_ts=${threadTs}&cid=${channel}`
}

const access = (context: RecordContext): SourceRecord["access"] => ({
  // Unknown means narrowest: a record nobody can place is one person's data.
  scope: accessScope(context.channelType ?? "im"),
  containerId: context.channel
})

/**
 * The tombstone for a message the provider deleted.
 *
 * `version` is the deletion's own timestamp, so the tombstone supersedes every
 * earlier version of the message.
 *
 * @category constructors
 * @since 1.0.0
 */
export const tombstone = (ts: string, version: string, context: RecordContext): SourceRecord => ({
  provider: SERVICE,
  connectionId: context.connectionId,
  externalId: externalId(context.channel, ts),
  kind: "message",
  url: null,
  author: null,
  createdAtMs: tsToMs(ts),
  updatedAtMs: tsToMs(version),
  version,
  retrievedAtMs: context.retrievedAtMs,
  access: access(context),
  thread: { containerId: context.channel, threadId: null, parentId: null },
  text: "",
  deleted: true,
  payload: null
})

/**
 * The record for one message.
 *
 * The version is the last edit's timestamp, or the message's own when it was
 * never edited. A thread reply names its root as both thread and parent; a
 * root names itself as the thread. A history `tombstone` becomes a deletion,
 * versioned at the moment it was retrieved.
 *
 * @category constructors
 * @since 1.0.0
 */
export const messageRecord = (message: Readonly<Record<string, unknown>>, context: RecordContext): SourceRecord => {
  const ts = message["ts"] as string
  if (message["subtype"] === "tombstone") return tombstone(ts, msToTs(context.retrievedAtMs), context)
  const threadTs = text(message["thread_ts"])
  const edited = message["edited"]
  const version = isRecord(edited) && isTs(edited["ts"]) ? edited["ts"] : ts
  const authorId = text(message["user"]) ?? text(message["bot_id"])
  const root = threadTs === undefined ? null : externalId(context.channel, threadTs)
  return {
    provider: SERVICE,
    connectionId: context.connectionId,
    externalId: externalId(context.channel, ts),
    kind: "message",
    url: messageUrl(context.workspaceUrl, context.channel, ts, threadTs),
    author: authorId === undefined ? null : { id: authorId, label: text(message["username"]) ?? null },
    createdAtMs: tsToMs(ts),
    updatedAtMs: tsToMs(version),
    version,
    retrievedAtMs: context.retrievedAtMs,
    access: access(context),
    thread: { containerId: context.channel, threadId: root, parentId: threadTs === ts ? null : root },
    text: typeof message["text"] === "string" ? message["text"] : "",
    deleted: false,
    payload: message as SourceRecord["payload"]
  }
}

/**
 * What {@link eventRecord} needs besides the delivery.
 *
 * @category models
 * @since 1.0.0
 */
export interface EventRecordContext {
  readonly connectionId: string
  readonly retrievedAtMs: number
  /** The conversation type when the event does not carry `channel_type`. */
  readonly channelType?: ChannelType | undefined
  readonly workspaceUrl?: string | undefined
}

const asCallback = Schema.decodeUnknownOption(EventCallback)
const asMessageEvent = Schema.decodeUnknownOption(MessageEvent)
const asMessage = Schema.decodeUnknownOption(Schema.Struct({ ts: Ts }))

/**
 * The record an Events API message delivery changes, or `undefined` for a
 * delivery that is not a message event.
 *
 * A new message becomes its record; `message_changed` becomes the edited
 * message at its edit's version; `message_deleted` becomes a tombstone
 * versioned at the deletion.
 *
 * @category constructors
 * @since 1.0.0
 */
export const eventRecord = (payload: unknown, context: EventRecordContext): SourceRecord | undefined => {
  const callback = asCallback(payload)
  if (callback._tag === "None") return undefined
  const decoded = asMessageEvent(callback.value.event)
  if (decoded._tag === "None") return undefined
  const event = decoded.value
  const recordContext: RecordContext = {
    connectionId: context.connectionId,
    channel: event.channel,
    channelType: eventChannelType(event.channel_type) ?? context.channelType,
    retrievedAtMs: context.retrievedAtMs,
    workspaceUrl: context.workspaceUrl
  }
  if (event.subtype === "message_deleted") {
    const deleted = event.deleted_ts
    return deleted === undefined ? undefined : tombstone(deleted, event.event_ts ?? event.ts, recordContext)
  }
  const subject = event.subtype === "message_changed" ? event.message : event
  return subject === undefined ? undefined : messageRecord(subject, recordContext)
}

/**
 * The adapter's cursor, as stored.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CursorState = Schema.Struct({
  v: Schema.Literal(1),
  /** The newest message timestamp a completed pass has seen. */
  watermark: Schema.NullOr(Ts),
  /** The history page to read next within the current pass. */
  page: Schema.NullOr(Schema.String),
  /** The newest timestamp the current pass has seen so far. */
  newest: Schema.NullOr(Ts),
  /** Tracked threads: `[root ts, newest reply ts seen]`. */
  threads: Schema.Array(Schema.Tuple([Ts, Ts]))
})

/**
 * The adapter's cursor, as stored.
 *
 * @category models
 * @since 1.0.0
 */
export type CursorState = typeof CursorState.Type

const decodeCursor = Schema.decodeUnknownOption(Schema.fromJsonString(CursorState))

/**
 * What {@link make} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly connectionId: string
  /** The conversation id. It is also the adapter's stream. */
  readonly channel: string
  readonly client: SlackClient
  /** The conversation type. Read once from `conversations.info` when omitted. */
  readonly channelType?: ChannelType | undefined
  /** Messages per history page. Defaults to 200; 1 to 999. */
  readonly pageSize?: number | undefined
  /**
   * The lower bound of the first pass, as a Slack timestamp. Omitted, the first
   * pass reads everything. A first pass that finds nothing newer keeps it as
   * the watermark, so a feed that starts "from now" never reads older history.
   */
  readonly initialOldest?: string | undefined
  /** Threads whose replies are followed. Defaults to 20; 0 to 200. */
  readonly maxTrackedThreads?: number | undefined
  /** How long after its root a thread is followed. Defaults to seven days. */
  readonly threadWindowSeconds?: number | undefined
  /** Reply pages per tracked thread per pass. Defaults to 5; 1 to 50. */
  readonly maxReplyPages?: number | undefined
  readonly workspaceUrl?: string | undefined
}

const range = (name: string, value: number | undefined, fallback: number, min: number, max: number): number => {
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || chosen < min || chosen > max) {
    throw new IntegrationError("invalid-config", `Slack sync ${name} must be an integer from ${min} to ${max}.`, {
      [name]: chosen,
      retryable: false
    })
  }
  return chosen
}

// An IntegrationError always carries details: its reason at least.
const slackErrorOf = (error: IntegrationError): unknown =>
  (error.details as Readonly<Record<string, unknown>>)["slackError"]

const decodeFailed = (message: string, details: Record<string, unknown>): IntegrationError =>
  new IntegrationError("decode-failed", message, { ...details, retryable: false })

/**
 * Builds the change feed for one conversation.
 *
 * Throws `IntegrationError` with reason `invalid-config` for a bound outside
 * its range or an `initialOldest` that is not a Slack timestamp.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): SyncAdapter => {
  const pageSize = range("pageSize", options.pageSize, 200, 1, 999)
  const maxTrackedThreads = range("maxTrackedThreads", options.maxTrackedThreads, 20, 0, 200)
  const threadWindowMs = range("threadWindowSeconds", options.threadWindowSeconds, 7 * 86_400, 0, 90 * 86_400) *
    1000
  const maxReplyPages = range("maxReplyPages", options.maxReplyPages, 5, 1, 50)
  if (options.initialOldest !== undefined && !isTs(options.initialOldest)) {
    throw new IntegrationError("invalid-config", "Slack sync initialOldest must be a Slack timestamp.", {
      retryable: false
    })
  }
  const { channel, client, connectionId } = options
  let channelType: ChannelType | undefined = options.channelType

  const resolveType: Effect.Effect<ChannelType, IntegrationError> = Effect.suspend(() =>
    channelType !== undefined ? Effect.succeed(channelType) : client.call("conversations.info", { channel }).pipe(
      Effect.flatMap((answer) =>
        isRecord(answer["channel"])
          ? Effect.succeed(channelType = channelTypeOf(answer["channel"]))
          : Effect.fail(
            decodeFailed(`Slack conversations.info answered without a channel for ${channel}.`, { channel })
          )
      )
    )
  )

  const messagesOf = (
    method: string,
    answer: Readonly<Record<string, unknown>>
  ): Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, IntegrationError> => {
    const messages = answer["messages"]
    return Array.isArray(messages) && messages.every((message) => asMessage(message)._tag === "Some")
      ? Effect.succeed(messages as ReadonlyArray<Readonly<Record<string, unknown>>>)
      : Effect.fail(decodeFailed(`Slack ${method} answered with messages this feed cannot key.`, { method, channel }))
  }

  const history = (state: CursorState, page: string | null) =>
    client.call("conversations.history", {
      channel,
      limit: pageSize,
      include_all_metadata: true,
      oldest: state.watermark ?? options.initialOldest,
      cursor: page ?? undefined
    })

  // Replies after `seen`, bounded by the page budget. Returns the records and
  // the newest reply timestamp, or `null` when the thread no longer exists.
  const replies = (root: string, seen: string, context: RecordContext) =>
    Effect.gen(function*() {
      const records: Array<SourceRecord> = []
      let newest = seen
      let page: string | null = null
      let pages = 0
      do {
        const answer: Readonly<Record<string, unknown>> = yield* client.call("conversations.replies", {
          channel,
          ts: root,
          oldest: seen,
          limit: pageSize,
          include_all_metadata: true,
          cursor: page ?? undefined
        })
        for (const message of yield* messagesOf("conversations.replies", answer)) {
          records.push(messageRecord(message, context))
          newest = newer(newest, message["ts"] as string)
        }
        page = nextCursor(answer)
        pages += 1
      } while (page !== null && pages < maxReplyPages)
      return { records, newest }
    }).pipe(
      Effect.map((found): { readonly records: ReadonlyArray<SourceRecord>; readonly newest: string | null } => found),
      Effect.catch((error) =>
        slackErrorOf(error) === "thread_not_found" ? Effect.succeed({ records: [], newest: null }) : Effect.fail(error)
      )
    )

  const changes = (cursor: string | null): Effect.Effect<Changes, IntegrationError> =>
    Effect.gen(function*() {
      let state: CursorState = { v: 1, watermark: null, page: null, newest: null, threads: [] }
      if (cursor !== null) {
        const decoded = decodeCursor(cursor)
        // A cursor this feed cannot read is a failure, not a reason to start
        // over: starting over would re-list the whole conversation.
        if (decoded._tag === "None") {
          return yield* Effect.fail(
            new IntegrationError(
              "invalid-config",
              `Slack sync cursor for ${channel} is not a cursor this feed wrote, so reading would restart the history.`,
              { connectionId, channel, retryable: false }
            )
          )
        }
        state = decoded.value
      }
      const type = yield* resolveType
      const retrievedAtMs = yield* Clock.currentTimeMillis
      const context: RecordContext = {
        connectionId,
        channel,
        channelType: type,
        retrievedAtMs,
        workspaceUrl: options.workspaceUrl
      }
      // Slack expires page cursors. A refused one restarts the pass from the
      // watermark, which re-reads pages the store already holds, harmlessly.
      const answer = yield* history(state, state.page).pipe(
        Effect.catch((error) =>
          state.page !== null && slackErrorOf(error) === "invalid_cursor"
            ? history(state, null)
            : Effect.fail(error)
        )
      )
      const records: Array<SourceRecord> = []
      let newest = state.newest
      const threads = new Map<string, string>(state.threads)
      for (const message of yield* messagesOf("conversations.history", answer)) {
        const ts = message["ts"] as string
        records.push(messageRecord(message, context))
        newest = newer(newest, ts)
        if (typeof message["reply_count"] === "number" && message["reply_count"] > 0 && !threads.has(ts)) {
          threads.set(ts, ts)
        }
      }
      const page = nextCursor(answer)
      if (page !== null) {
        return {
          records,
          cursor: JSON.stringify({ ...state, page, newest, threads: [...threads] }),
          reset: false,
          done: false
        }
      }
      // The pass is complete: follow the tracked threads, then keep only the
      // newest threads still inside the window.
      const followed: Array<readonly [string, string]> = []
      for (const [root, seen] of threads) {
        if (retrievedAtMs - tsToMs(root) > threadWindowMs) continue
        const found = yield* replies(root, seen, context)
        records.push(...found.records)
        if (found.newest !== null) followed.push([root, found.newest])
      }
      followed.sort(([, left], [, right]) => compareTs(right, left))
      const next: CursorState = {
        v: 1,
        watermark: newest ?? state.watermark ?? options.initialOldest ?? null,
        page: null,
        newest: null,
        threads: followed.slice(0, maxTrackedThreads)
      }
      return { records, cursor: JSON.stringify(next), reset: false, done: true }
    }).pipe(Effect.withSpan("Slack.Sync.changes", { attributes: { "slack.channel": channel } }))

  return { provider: SERVICE, connectionId, stream: channel, changes }
}
