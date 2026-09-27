/**
 * A calendar's events as a change feed.
 *
 * The adapter speaks Google's incremental synchronization. The first call,
 * with no cursor, lists every event page by page and marks the first page
 * `reset`, so the driver replaces whatever it held for the calendar once the
 * listing is complete. The last page carries a `nextSyncToken`, and every later
 * call asks only for what changed since it. When Google answers `410 Gone`
 * (the sync token, or a page token of an interrupted listing, has expired) the
 * adapter starts a fresh full listing, again marked `reset`, rather than
 * failing or skipping changes.
 *
 * Recurring events arrive as they are stored: one record for the series, with
 * its `recurrence` rules, and one record for each exception. A cancelled
 * occurrence, or a deleted event, becomes a tombstone for its own id, so a
 * cancelled Friday leaves the series in place and removes that one instance.
 *
 * Every record is scoped to the calendar: `access.containerId` and
 * `thread.containerId` are the calendar id, and `access.scope` defaults to
 * `private`, a personal calendar only its owner's principal may read. An
 * exception's thread is its series.
 *
 * The cursor is this module's own JSON, `{"v":1,"sync":…,"page":…}`. A stored
 * cursor that does not parse fails with `invalid-config` rather than starting
 * over, which would replay the calendar as new.
 *
 * @since 1.0.0
 */

import { Clock, Effect, Option, Schema } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import type { AccessScope, SourceRecord } from "../core/SourceRecord.ts"
import { tombstone } from "../core/SourceRecord.ts"
import type { Changes, SyncAdapter } from "../core/Sync.ts"
import { CalendarClient, type ListQuery, MAX_PAGE_SIZE } from "./CalendarClient.ts"
import { type Event, isCalendarId, isCancelled } from "./Event.ts"

/**
 * The provider name records carry.
 *
 * @category constants
 * @since 1.0.0
 */
export const PROVIDER = "googlecalendar"

/**
 * The record kind of a calendar event.
 *
 * @category constants
 * @since 1.0.0
 */
export const KIND = "event"

/**
 * The page size the adapter asks for by default.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_PAGE_SIZE = 250

/**
 * What {@link make} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The configured connection the client reads through. */
  readonly connectionId: string
  /** The calendar to follow. It is also the stream name and the record container. */
  readonly calendarId: string
  /** Events per page, 1 to 2500. Defaults to {@link DEFAULT_PAGE_SIZE}. */
  readonly pageSize?: number | undefined
  /** Who may read the records. Defaults to `private`. */
  readonly access?: AccessScope | undefined
}

const Cursor = Schema.Struct({
  v: Schema.Literal(1),
  sync: Schema.NullOr(Schema.String),
  page: Schema.NullOr(Schema.String)
})

type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownOption(Schema.fromJsonString(Cursor))

const encodeCursor = (cursor: Cursor): string => JSON.stringify(cursor)

const parseMs = (value: string | undefined): number | null => {
  if (value === undefined) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const when = (time: Event["start"]): string | null =>
  time === undefined
    ? null
    : `${time.dateTime ?? time.date ?? ""}${time.timeZone === undefined ? "" : ` (${time.timeZone})`}`

/**
 * The searchable text of an event: title, time, place, repetition and
 * description, one per line. Data, never instructions.
 *
 * @category constructors
 * @since 1.0.0
 */
export const render = (event: Event): string => {
  const lines: Array<string> = []
  if (event.summary !== undefined && event.summary.length > 0) lines.push(event.summary)
  const start = when(event.start)
  const end = when(event.end)
  if (start !== null) lines.push(end === null ? `When: ${start}` : `When: ${start} to ${end}`)
  if (event.location !== undefined && event.location.length > 0) lines.push(`Where: ${event.location}`)
  if (event.recurrence !== undefined && event.recurrence.length > 0) {
    lines.push(`Repeats: ${event.recurrence.join("; ")}`)
  }
  if (event.description !== undefined && event.description.length > 0) lines.push(event.description)
  return lines.join("\n")
}

/**
 * The provenance record for one event of `calendarId`.
 *
 * A cancelled event or occurrence is a tombstone: identity, placement and
 * times only.
 *
 * @category constructors
 * @since 1.0.0
 */
export const toRecord = (
  options: {
    readonly connectionId: string
    readonly calendarId: string
    readonly access?: AccessScope | undefined
  },
  event: Event,
  retrievedAtMs: number
): SourceRecord => {
  const calendarId = options.calendarId
  const series = event.recurringEventId === undefined ? null : `${calendarId}/${event.recurringEventId}`
  const identity = {
    provider: PROVIDER,
    connectionId: options.connectionId,
    externalId: `${calendarId}/${event.id}`,
    kind: KIND,
    access: { scope: options.access ?? "private", containerId: calendarId },
    thread: { containerId: calendarId, threadId: series, parentId: series },
    createdAtMs: parseMs(event.created),
    updatedAtMs: parseMs(event.updated),
    version: event.etag ?? event.updated ?? null
  }
  if (isCancelled(event)) return tombstone(identity, identity.updatedAtMs ?? retrievedAtMs, retrievedAtMs)
  const author = event.creator ?? event.organizer
  const authorId = author?.email ?? author?.id
  return {
    ...identity,
    url: event.htmlLink ?? null,
    author: authorId === undefined ? null : { id: authorId, label: author?.displayName ?? null },
    retrievedAtMs,
    text: render(event),
    deleted: false,
    payload: event as unknown as Schema.Json
  }
}

const invalid = (message: string, details: Record<string, unknown>): IntegrationError =>
  new IntegrationError("invalid-config", message, { ...details, retryable: false })

/**
 * The change feed of one calendar, reading through the client in context.
 *
 * Fails with `invalid-config` for an empty connection id, a calendar id that
 * cannot be sent, or a page size outside 1 to 2500.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): Effect.Effect<SyncAdapter, IntegrationError, CalendarClient> =>
  Effect.gen(function*() {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
    if (typeof options.connectionId !== "string" || options.connectionId.length === 0) {
      return yield* Effect.fail(invalid("Google Calendar sync needs a connection id.", {}))
    }
    if (!isCalendarId(options.calendarId)) {
      return yield* Effect.fail(invalid("Google Calendar sync calendar id is not valid.", {}))
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      return yield* Effect.fail(
        invalid(`Google Calendar sync pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`, { pageSize })
      )
    }
    const client = yield* CalendarClient
    const { calendarId, connectionId } = options

    const page = (cursor: Cursor | null, reset: boolean): Effect.Effect<Changes, IntegrationError> =>
      Effect.gen(function*() {
        const query: ListQuery = {
          maxResults: pageSize,
          ...(cursor === null || cursor.sync === null ? {} : { syncToken: cursor.sync }),
          ...(cursor === null || cursor.page === null ? {} : { pageToken: cursor.page })
        }
        const listed = yield* client.listEvents(calendarId, query)
        const retrievedAtMs = yield* Clock.currentTimeMillis
        const records = listed.items.map((event) => toRecord(options, event, retrievedAtMs))
        if (listed.nextPageToken !== null) {
          return {
            records,
            cursor: encodeCursor({ v: 1, sync: cursor?.sync ?? null, page: listed.nextPageToken }),
            reset,
            done: false
          }
        }
        return {
          records,
          // Without a sync token nothing says where the listing ended, so the
          // next call lists the calendar again from the start.
          cursor: listed.nextSyncToken === null ? null : encodeCursor({ v: 1, sync: listed.nextSyncToken, page: null }),
          reset,
          done: true
        }
      })

    const changes = (stored: string | null): Effect.Effect<Changes, IntegrationError> =>
      Effect.gen(function*() {
        if (stored === null) return yield* page(null, true)
        const cursor = decodeCursor(stored)
        if (Option.isNone(cursor)) {
          return yield* Effect.fail(
            invalid(
              `Google Calendar sync for "${connectionId}" has a stored cursor it did not write, so listing would replay the calendar.`,
              { connectionId }
            )
          )
        }
        return yield* page(cursor.value, false).pipe(
          Effect.catchIf(
            (error) => error.details?.["status"] === 410,
            () => page(null, true)
          )
        )
      }).pipe(
        Effect.withSpan("GoogleCalendarSync.changes", {
          attributes: { "integration.provider": PROVIDER, "integration.connection": connectionId }
        })
      )

    return { provider: PROVIDER, connectionId, stream: calendarId, changes }
  })
