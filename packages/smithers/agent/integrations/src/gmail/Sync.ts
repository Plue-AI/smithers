/**
 * Mailbox synchronization and search over the Gmail client.
 *
 * {@link mailbox} is a `SyncAdapter`. With no cursor it reads the mailbox's
 * current history id first, then lists messages page by page (filtered by
 * `query` and `labelId`), reading each message's headers. After the last page
 * it reads history from the id it started at, so a message that changed
 * while the listing ran is caught up, and from then on each call reads one
 * page of `users.history.list`: added and relabeled messages are read again,
 * deleted ones become tombstones. The cursor advances to the mailbox's history
 * id only after the last history page, so a crash between pages resumes the
 * same page rather than skipping it.
 *
 * Google answers a history read whose start id is too old with a 404. The
 * adapter then starts a fresh listing in the same call and answers
 * `reset: true` on its first page: whatever the fresh listing and the history
 * that follows it do not contain is gone. `done` is `false` throughout a
 * listing and becomes `true` only on a history page with nothing after it.
 *
 * A message in the trash or spam, or one that lost `labelId`, is reported as a
 * tombstone, because a fresh listing would not contain it. `query` narrows
 * only the listing: Gmail's history carries no search, so later changes cover
 * the whole mailbox, or `labelId` when one is set.
 *
 * A corrupt cursor fails as `decode-failed` rather than silently starting
 * over.
 *
 * @since 1.0.0
 */
import { Clock, Effect, Schema } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import type { SourceRecord } from "../core/SourceRecord.ts"
import type { Changes, SyncAdapter } from "../core/Sync.ts"
import { type GmailClient, HistoryId, type HistoryRecord } from "./GmailClient.ts"
import * as Records from "./Records.ts"

/**
 * Messages listed, or history records read, per page by default.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_PAGE_SIZE = 50

/**
 * Messages read at once by default.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_FETCH_CONCURRENCY = 4

/**
 * The most messages read at once.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_FETCH_CONCURRENCY = 16

/**
 * A mailbox cursor: a listing (`list`) or history (`history`) position.
 * `start` is the history id the position counts from and `page` the provider
 * page token within it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Cursor = Schema.Struct({
  v: Schema.Literal(1),
  mode: Schema.Literals(["list", "history"]),
  start: HistoryId,
  page: Schema.optionalKey(Schema.NonEmptyString)
})

/**
 * A mailbox cursor.
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
  JSON.stringify(
    cursor.page === undefined
      ? { v: cursor.v, mode: cursor.mode, start: cursor.start }
      : { v: cursor.v, mode: cursor.mode, start: cursor.start, page: cursor.page }
  )

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
      new IntegrationError("decode-failed", "The stored Gmail cursor is not a Gmail cursor; refusing to start over.", {
        retryable: false
      })
    )
  )

/**
 * What {@link mailbox} syncs.
 *
 * @category models
 * @since 1.0.0
 */
export interface MailboxOptions {
  /** A client with a bound connection. */
  readonly client: GmailClient
  /** The stream name. Defaults to `mailbox`, or `label:<labelId>`. */
  readonly stream?: string | undefined
  /** The container records belong to. Defaults to the client's mailbox. */
  readonly container?: string | undefined
  /** A Gmail search narrowing the listing. Needs the `read` operation. */
  readonly query?: string | undefined
  /** A label narrowing the listing and the history. */
  readonly labelId?: string | undefined
  /** Messages or history records per page, 1 to 500. Defaults to 50. */
  readonly pageSize?: number | undefined
  /** Messages read at once, 1 to 16. Defaults to 4. */
  readonly fetchConcurrency?: number | undefined
}

/**
 * What {@link search} finds.
 *
 * @category models
 * @since 1.0.0
 */
export interface SearchOptions {
  /** A client with a bound connection. */
  readonly client: GmailClient
  /** A Gmail search query. */
  readonly query: string
  readonly container?: string | undefined
  readonly pageToken?: string | undefined
  /** Messages per page, 1 to 500. Defaults to 50. */
  readonly maxResults?: number | undefined
  readonly fetchConcurrency?: number | undefined
}

/**
 * One page of search results.
 *
 * @category models
 * @since 1.0.0
 */
export interface SearchPage {
  readonly records: ReadonlyArray<SourceRecord>
  readonly nextPageToken: string | null
}

const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] as const

const invalid = (message: string): IntegrationError =>
  new IntegrationError("invalid-config", message, { retryable: false })

const isNotFound = (error: IntegrationError): boolean => error.details?.["status"] === 404

interface Ref {
  readonly id: string
  readonly threadId?: string | undefined
  /** The history id a tombstone for this message carries. */
  readonly historyId?: string | undefined
  readonly deleted?: boolean | undefined
}

interface Reader {
  readonly connectionId: string
  readonly read: (
    refs: ReadonlyArray<Ref>,
    labelId: string | undefined
  ) => Effect.Effect<ReadonlyArray<SourceRecord>, IntegrationError>
}

const reader = (
  client: GmailClient,
  container: string | undefined,
  fetchConcurrency: number | undefined
): Effect.Effect<Reader, IntegrationError> => {
  const connectionId = client.connectionId
  const mailboxContainer = container ?? client.userId
  const concurrency = fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY
  if (connectionId === undefined) {
    return Effect.fail(invalid("Gmail sync needs a client bound to a connection."))
  }
  if (mailboxContainer.trim().length === 0) return Effect.fail(invalid("Gmail sync container must not be empty."))
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_FETCH_CONCURRENCY) {
    return Effect.fail(invalid(`Gmail fetchConcurrency must be an integer between 1 and ${MAX_FETCH_CONCURRENCY}.`))
  }
  const read: Reader["read"] = (refs, labelId) =>
    Effect.flatMap(Clock.currentTimeMillis, (retrievedAtMs) => {
      const context = { connectionId, container: mailboxContainer, retrievedAtMs }
      return Effect.forEach(refs, (ref) =>
        ref.deleted === true
          ? Effect.succeed(Records.tombstone(ref, ref.historyId, context))
          : client.getMessage(ref.id, { format: "metadata", metadataHeaders: Records.HEADERS }).pipe(
            Effect.map((message) =>
              Records.isGone(message, labelId)
                ? Records.tombstone(message, message.historyId ?? ref.historyId, context)
                : Records.fromMessage(message, context)
            ),
            // Deleted between the listing and the read.
            Effect.catchIf(isNotFound, () => Effect.succeed(Records.tombstone(ref, ref.historyId, context)))
          ), { concurrency })
    })
  return Effect.succeed({ connectionId, read })
}

// The last change named for each message wins, in history order.
const collect = (history: ReadonlyArray<HistoryRecord>): ReadonlyArray<Ref> => {
  const changes = new Map<string, Ref>()
  for (const record of history) {
    const touched = [...(record.messagesAdded ?? []), ...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]
    for (const change of touched) changes.set(change.message.id, { ...change.message, historyId: record.id })
    for (const change of record.messagesDeleted ?? []) {
      changes.set(change.message.id, { ...change.message, historyId: record.id, deleted: true })
    }
  }
  return [...changes.values()]
}

/**
 * The change feed for one Gmail mailbox.
 *
 * Fails `invalid-config` for a client with no bound connection, an empty
 * container, or a fetch concurrency out of range.
 *
 * @category constructors
 * @since 1.0.0
 */
export const mailbox = (options: MailboxOptions): Effect.Effect<SyncAdapter, IntegrationError> =>
  Effect.map(reader(options.client, options.container, options.fetchConcurrency), (read): SyncAdapter => {
    const { client, labelId, query } = options
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE

    const listPage = (start: string, pageToken: string | undefined, reset: boolean) =>
      Effect.gen(function*() {
        const page = yield* client.listMessages({
          q: query,
          labelIds: labelId === undefined ? undefined : [labelId],
          pageToken,
          maxResults: pageSize
        })
        const refs = (page.messages ?? []).map((ref) => ({ ...ref, historyId: start }))
        const records = yield* read.read(refs, labelId)
        const next = page.nextPageToken
        const cursor: Cursor = next === undefined
          ? { v: 1, mode: "history", start }
          : { v: 1, mode: "list", start, page: next }
        // Never done inside a listing: the history since `start` is still to read.
        return { records, cursor: encodeCursor(cursor), reset, done: false } satisfies Changes
      })

    const startListing = (reset: boolean) =>
      Effect.flatMap(client.getProfile, (profile) => listPage(profile.historyId, undefined, reset))

    const historyPage = (start: string, pageToken: string | undefined) =>
      Effect.gen(function*() {
        const page = yield* client.listHistory({
          startHistoryId: start,
          pageToken,
          maxResults: pageSize,
          labelId,
          historyTypes: HISTORY_TYPES
        })
        const records = yield* read.read(collect(page.history ?? []), labelId)
        const next = page.nextPageToken
        const cursor: Cursor = next === undefined
          ? { v: 1, mode: "history", start: page.historyId }
          : { v: 1, mode: "history", start, page: next }
        return {
          records,
          cursor: encodeCursor(cursor),
          reset: false,
          done: next === undefined
        } satisfies Changes
      })

    const changes = (cursor: string | null): Effect.Effect<Changes, IntegrationError> =>
      cursor === null ? startListing(false) : Effect.flatMap(decodeCursor(cursor), (state) =>
        state.mode === "list"
          ? listPage(state.start, state.page, false)
          : historyPage(state.start, state.page).pipe(
            // The start id is older than Google keeps: list afresh.
            Effect.catchIf(isNotFound, () => startListing(true))
          ))

    return {
      provider: Records.PROVIDER,
      connectionId: read.connectionId,
      stream: options.stream ?? (labelId === undefined ? "mailbox" : `label:${labelId}`),
      changes
    }
  })

/**
 * One page of messages matching a Gmail search, as records. Needs the `read`
 * operation. A message deleted between the search and the read is left out.
 *
 * @category constructors
 * @since 1.0.0
 */
export const search = (options: SearchOptions): Effect.Effect<SearchPage, IntegrationError> =>
  Effect.gen(function*() {
    const read = yield* reader(options.client, options.container, options.fetchConcurrency)
    const page = yield* options.client.listMessages({
      q: options.query,
      pageToken: options.pageToken,
      maxResults: options.maxResults ?? DEFAULT_PAGE_SIZE
    })
    const records = yield* read.read(page.messages ?? [], undefined)
    return { records: records.filter((record) => !record.deleted), nextPageToken: page.nextPageToken ?? null }
  })
