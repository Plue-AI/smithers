/**
 * Mention and direct-message synchronization over the X client.
 *
 * Both feeds are newest first and both are paged backwards with a
 * `pagination_token`, so both keep a high-water mark: the newest id already
 * stored. The mark moves only when a walk ends, and the newest id the walk
 * saw rides in the cursor until then, so a crash between pages resumes the
 * same page and never skips an item.
 *
 * - {@link mentions} asks X for posts newer than the mark with `since_id`,
 *   then pages back through them.
 * - {@link directMessages} has no `since_id` to ask with: it pages back from
 *   the newest event and stops at the first page that reaches the mark,
 *   keeping only the events newer than it. X keeps direct-message events for
 *   a limited time, so a first walk returns what X still holds.
 *
 * Neither feed invalidates a cursor, so neither answers `reset`, and neither
 * reports deletions. A corrupt cursor fails as `decode-failed` rather than
 * silently starting over.
 *
 * @since 1.0.0
 */

import { Clock, Effect, Schema } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import type { Changes, SyncAdapter } from "../core/Sync.ts"
import * as Records from "./Records.ts"
import { type XClient, XId } from "./XClient.ts"

/**
 * A feed cursor: the high-water mark `since`, and while a walk is under way
 * its `page` token and the `newest` id it has seen.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Cursor = Schema.Struct({
  v: Schema.Literal(1),
  since: Schema.NullOr(XId),
  page: Schema.optionalKey(Schema.NonEmptyString),
  newest: Schema.optionalKey(XId)
})

/**
 * A feed cursor.
 *
 * @category models
 * @since 1.0.0
 */
export type Cursor = typeof Cursor.Type

/**
 * A cursor as the string a store keeps.
 *
 * @category conversions
 * @since 1.0.0
 */
export const encodeCursor = (cursor: Cursor): string =>
  JSON.stringify({
    v: cursor.v,
    since: cursor.since,
    ...(cursor.page === undefined ? {} : { page: cursor.page }),
    ...(cursor.newest === undefined ? {} : { newest: cursor.newest })
  })

/**
 * A stored cursor, or `decode-failed` when it is not one.
 *
 * @category conversions
 * @since 1.0.0
 */
export const decodeCursor = (text: string): Effect.Effect<Cursor, IntegrationError> =>
  Effect.try({ try: () => JSON.parse(text) as unknown, catch: (cause) => cause }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Cursor)),
    Effect.mapError(() =>
      new IntegrationError("decode-failed", "The stored X cursor is not an X cursor; refusing to start over.", {
        retryable: false
      })
    )
  )

/**
 * The largest of some ids, compared as numbers, or `undefined` for none.
 *
 * @category getters
 * @since 1.0.0
 */
export const newestId = (ids: ReadonlyArray<string | null | undefined>): string | undefined =>
  ids.reduce<string | undefined>(
    (best, id) => id === null || id === undefined || (best !== undefined && BigInt(best) >= BigInt(id)) ? best : id,
    undefined
  )

/**
 * What {@link mentions} syncs.
 *
 * @category models
 * @since 1.0.0
 */
export interface MentionsOptions {
  /** A client with a bound connection. */
  readonly client: XClient
  /** The account whose mentions to read. */
  readonly userId: string
  /** The stream name. Defaults to `mentions:<userId>`. */
  readonly stream?: string | undefined
  /** Posts per page, 5 to 100. Defaults to 100. */
  readonly maxResults?: number | undefined
}

/**
 * What {@link directMessages} syncs.
 *
 * @category models
 * @since 1.0.0
 */
export interface DirectMessagesOptions {
  /** A client with a bound connection. */
  readonly client: XClient
  /** The stream name. Defaults to `direct-messages`. */
  readonly stream?: string | undefined
  /** Events per page, 1 to 100. Defaults to 100. */
  readonly maxResults?: number | undefined
}

const invalid = (message: string): IntegrationError =>
  new IntegrationError("invalid-config", message, { retryable: false })

const boundConnection = (client: XClient): Effect.Effect<string, IntegrationError> =>
  client.connectionId === undefined
    ? Effect.fail(invalid("X sync needs a client bound to a connection."))
    : Effect.succeed(client.connectionId)

const state = (cursor: string | null): Effect.Effect<Cursor, IntegrationError> =>
  cursor === null ? Effect.succeed({ v: 1, since: null }) : decodeCursor(cursor)

// A walk with more pages keeps the mark and carries what it has seen; a
// finished walk moves the mark to the newest id seen.
const advance = (
  current: Cursor,
  seen: string | undefined,
  next: string | undefined
): Pick<Changes, "cursor" | "done"> =>
  next === undefined
    ? { cursor: encodeCursor({ v: 1, since: newestId([seen, current.since]) ?? null }), done: true }
    : {
      cursor: encodeCursor({
        v: 1,
        since: current.since,
        page: next,
        ...(seen === undefined ? {} : { newest: seen })
      }),
      done: false
    }

/**
 * The change feed of posts mentioning one account, as public records.
 *
 * Fails `invalid-config` for a client with no bound connection or a user id
 * that is not a decimal id.
 *
 * @category constructors
 * @since 1.0.0
 */
export const mentions = (options: MentionsOptions): Effect.Effect<SyncAdapter, IntegrationError> =>
  Effect.gen(function*() {
    const connectionId = yield* boundConnection(options.client)
    if (!Schema.is(XId)(options.userId)) return yield* Effect.fail(invalid("X mentions userId must be a decimal id."))
    const { client, userId } = options
    const changes = (cursor: string | null): Effect.Effect<Changes, IntegrationError> =>
      Effect.gen(function*() {
        const current = yield* state(cursor)
        const page = yield* client.mentions(userId, {
          sinceId: current.since ?? undefined,
          paginationToken: current.page,
          maxResults: options.maxResults ?? 100
        })
        const retrievedAtMs = yield* Clock.currentTimeMillis
        const tweets = page.data ?? []
        const records = tweets.map((tweet) =>
          Records.fromMention(tweet, page.includes, { connectionId, userId, retrievedAtMs })
        )
        const seen = newestId([current.newest, page.meta?.newest_id, ...tweets.map((tweet) => tweet.id)])
        return { records, reset: false, ...advance(current, seen, page.meta?.next_token) }
      })
    return { provider: Records.PROVIDER, connectionId, stream: options.stream ?? `mentions:${userId}`, changes }
  })

/**
 * The change feed of direct messages across the account's conversations, as
 * private records.
 *
 * Fails `invalid-config` for a client with no bound connection.
 *
 * @category constructors
 * @since 1.0.0
 */
export const directMessages = (options: DirectMessagesOptions): Effect.Effect<SyncAdapter, IntegrationError> =>
  Effect.map(boundConnection(options.client), (connectionId) => {
    const { client } = options
    const changes = (cursor: string | null): Effect.Effect<Changes, IntegrationError> =>
      Effect.gen(function*() {
        const current = yield* state(cursor)
        const page = yield* client.dmEvents({ paginationToken: current.page, maxResults: options.maxResults ?? 100 })
        const retrievedAtMs = yield* Clock.currentTimeMillis
        const events = page.data ?? []
        const since = current.since
        const fresh = events.filter((event) => since === null || BigInt(event.id) > BigInt(since))
        const records = fresh
          .filter((event) => event.event_type === "MessageCreate")
          .map((event) => Records.fromDirectMessage(event, page.includes, { connectionId, retrievedAtMs }))
        const seen = newestId([current.newest, ...fresh.map((event) => event.id)])
        // A page holding an event at or below the mark reached what is stored.
        const reachedMark = fresh.length < events.length
        return { records, reset: false, ...advance(current, seen, reachedMark ? undefined : page.meta?.next_token) }
      })
    return { provider: Records.PROVIDER, connectionId, stream: options.stream ?? "direct-messages", changes }
  })
