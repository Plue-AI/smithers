/**
 * Google Calendar resources, as schemas.
 *
 * Two families live here. The provider's own resources ({@link Event},
 * {@link EventTime}) validate the fields this package reads and pass every
 * other field through untouched, so an event Google extends tomorrow still
 * decodes and a synchronized record keeps the payload as delivered. The
 * inputs a caller writes ({@link EventInput}, {@link EventPatch}) are closed
 * and strict: they are durable action payloads, so a value that Google would
 * refuse, or would read differently than the caller meant, fails to decode
 * before any request is sent.
 *
 * Time is written the way Google reads it. A timed event names an RFC 3339
 * instant with an explicit offset, so its meaning never depends on a server
 * default; an all-day event names a calendar date. A recurring event must also
 * name the IANA time zone its rule is expanded in, which is what keeps a
 * weekly 9:00 at 9:00 local time across a daylight-saving change.
 *
 * @since 1.0.0
 */

import { Schema } from "effect"

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const

const open = <Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.StructWithRest(Schema.Struct(fields), rest)

/**
 * The shape of a calendar id this package sends in a request path.
 *
 * `primary`, an account address, or a group calendar address such as
 * `team@group.calendar.google.com`. The characters are those such ids use;
 * nothing that forms a `.` or `..` path segment.
 *
 * @category constants
 * @since 1.0.0
 */
export const CALENDAR_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._%+@#-]{1,1024}$/

/**
 * A calendar id.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CalendarId = Schema.String.check(Schema.isPattern(CALENDAR_ID_PATTERN))

/**
 * Whether `value` may name a calendar in a request.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isCalendarId = (value: unknown): value is string =>
  typeof value === "string" && CALENDAR_ID_PATTERN.test(value)

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const validCalendarDate = (year: number, month: number, day: number): boolean => {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/**
 * Whether `value` is an RFC 3339 date-time with an explicit offset.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isDateTime = (value: unknown): value is string => {
  if (typeof value !== "string") return false
  const match = RFC3339.exec(value)
  if (match === null) return false
  return validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) && Number(match[4]) < 24 &&
    Number(match[5]) < 60 && Number(match[6]) < 60 && Number.isFinite(Date.parse(value))
}

/**
 * Whether `value` is a `YYYY-MM-DD` calendar date that exists.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isCalendarDate = (value: unknown): value is string => {
  if (typeof value !== "string") return false
  const match = DATE.exec(value)
  return match !== null && validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
}

/**
 * Whether `value` is an IANA time zone name this runtime knows.
 *
 * An offset such as `+02:00` is refused even where `Intl` accepts it: Google
 * expands a recurrence in a named zone, and an offset has no daylight-saving
 * rules to expand it with.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isTimeZone = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * An RFC 3339 date-time with an explicit offset.
 *
 * @category schemas
 * @since 1.0.0
 */
export const DateTime = Schema.String.check(
  Schema.makeFilter((value) => isDateTime(value) || "an RFC 3339 date-time with an explicit offset")
)

/**
 * A `YYYY-MM-DD` calendar date.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CalendarDate = Schema.String.check(
  Schema.makeFilter((value) => isCalendarDate(value) || "a YYYY-MM-DD calendar date")
)

/**
 * An IANA time zone name.
 *
 * @category schemas
 * @since 1.0.0
 */
export const TimeZone = Schema.String.check(
  Schema.makeFilter((value) => isTimeZone(value) || "an IANA time zone name")
)

/**
 * An event's start or end as Google returns it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EventTime = open({
  date: Schema.optional(Schema.String),
  dateTime: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String)
})

/**
 * An event's start or end as Google returns it.
 *
 * @category models
 * @since 1.0.0
 */
export type EventTime = typeof EventTime.Type

/**
 * A person Google names on an event.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Person = open({
  id: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  self: Schema.optional(Schema.Boolean)
})

/**
 * An attendee Google lists on an event.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Attendee = open({
  email: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  responseStatus: Schema.optional(Schema.String),
  optional: Schema.optional(Schema.Boolean)
})

/**
 * A calendar event resource.
 *
 * Only `id` is required. A cancelled event in an incremental listing carries
 * little more than its id and `status`, and a cancelled instance of a
 * recurring event adds `recurringEventId` and `originalStartTime`. A missing
 * `status` reads as `confirmed`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Event = open({
  id: Schema.String,
  status: Schema.optional(Schema.String),
  etag: Schema.optional(Schema.String),
  htmlLink: Schema.optional(Schema.String),
  created: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  start: Schema.optional(EventTime),
  end: Schema.optional(EventTime),
  recurrence: Schema.optional(Schema.Array(Schema.String)),
  recurringEventId: Schema.optional(Schema.String),
  originalStartTime: Schema.optional(EventTime),
  creator: Schema.optional(Person),
  organizer: Schema.optional(Person),
  attendees: Schema.optional(Schema.Array(Attendee)),
  visibility: Schema.optional(Schema.String),
  transparency: Schema.optional(Schema.String),
  extendedProperties: Schema.optional(open({
    private: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    shared: Schema.optional(Schema.Record(Schema.String, Schema.String))
  }))
})

/**
 * A calendar event resource.
 *
 * @category models
 * @since 1.0.0
 */
export type Event = typeof Event.Type

/**
 * One page of an event listing.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EventList = open({
  items: Schema.optional(Schema.Array(Event)),
  nextPageToken: Schema.optional(Schema.String),
  nextSyncToken: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String)
})

/**
 * Whether Google reports the event, or this instance of it, as cancelled.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isCancelled = (event: Event): boolean => event.status === "cancelled"

/**
 * The start or end of an event a caller writes.
 *
 * Exactly one of `date` (all day) and `dateTime` (timed). `timeZone` is the
 * IANA zone the time is shown and, for a recurring event, expanded in.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EventTimeInput = Schema.Struct({
  date: Schema.optionalKey(CalendarDate),
  dateTime: Schema.optionalKey(DateTime),
  timeZone: Schema.optionalKey(TimeZone)
}).check(
  Schema.makeFilter((time) =>
    (time.date === undefined) !== (time.dateTime === undefined) ||
    "an event time names exactly one of date and dateTime"
  )
)

/**
 * The start or end of an event a caller writes.
 *
 * @category models
 * @since 1.0.0
 */
export type EventTimeInput = typeof EventTimeInput.Type

/**
 * One line of an iCalendar recurrence: `RRULE`, `EXRULE`, `RDATE` or `EXDATE`.
 *
 * For example `RRULE:FREQ=WEEKLY;BYDAY=FR` or
 * `EXDATE;TZID=America/Los_Angeles:20261225T090000`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RecurrenceLine = Schema.String.check(Schema.isPattern(/^(?:RRULE|EXRULE|RDATE|EXDATE)[:;][^\r\n]+$/))

/**
 * An attendee a caller invites.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AttendeeInput = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/)),
  displayName: Schema.optionalKey(Schema.String),
  optional: Schema.optionalKey(Schema.Boolean)
})

/**
 * Key-value data stored on the event, private to the calendar that holds it
 * or shared with every attendee's copy.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ExtendedPropertiesInput = Schema.Struct({
  private: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  shared: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
})

const fields = {
  summary: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.String),
  recurrence: Schema.optionalKey(Schema.Array(RecurrenceLine)),
  attendees: Schema.optionalKey(Schema.Array(AttendeeInput)),
  visibility: Schema.optionalKey(Schema.Literals(["default", "public", "private", "confidential"])),
  transparency: Schema.optionalKey(Schema.Literals(["opaque", "transparent"])),
  extendedProperties: Schema.optionalKey(ExtendedPropertiesInput)
}

const kind = (time: EventTimeInput): "date" | "dateTime" => time.date === undefined ? "dateTime" : "date"

const instant = (time: EventTimeInput): number =>
  time.dateTime === undefined ? Date.parse(`${time.date}T00:00:00Z`) : Date.parse(time.dateTime)

const spanIssue = (start: EventTimeInput, end: EventTimeInput): string | undefined => {
  if (kind(start) !== kind(end)) return "start and end must both be dates or both be date-times"
  if (instant(end) <= instant(start)) return "end must be after start"
  return undefined
}

/**
 * The event a caller asks `Actions.UpsertEvent` to make exist.
 *
 * `start` and `end` must be the same kind, `end` after `start`, and a
 * recurring event must name the time zone of both.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EventInput = Schema.Struct({
  ...fields,
  start: EventTimeInput,
  end: EventTimeInput
}).check(
  Schema.makeFilter((event) => {
    const span = spanIssue(event.start, event.end)
    if (span !== undefined) return span
    if (
      event.recurrence !== undefined && event.recurrence.length > 0 &&
      (event.start.timeZone === undefined || event.end.timeZone === undefined)
    ) {
      return "a recurring event must name the time zone of its start and end"
    }
    return true
  })
)

/**
 * The event a caller asks to make exist.
 *
 * @category models
 * @since 1.0.0
 */
export type EventInput = typeof EventInput.Type

/**
 * The fields a caller changes on an existing event or one instance of a
 * recurring event. Fields left out keep their current value.
 *
 * `status: "cancelled"` cancels, and `confirmed` restores a cancelled event.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EventPatch = Schema.Struct({
  ...fields,
  start: Schema.optionalKey(EventTimeInput),
  end: Schema.optionalKey(EventTimeInput),
  status: Schema.optionalKey(Schema.Literals(["confirmed", "tentative", "cancelled"]))
}).check(
  Schema.makeFilter((patch) => {
    if (Object.keys(patch).length === 0) return "a patch changes at least one field"
    if ((patch.start === undefined) !== (patch.end === undefined)) return "a patch moves start and end together"
    return patch.start === undefined || patch.end === undefined ? true : spanIssue(patch.start, patch.end) ?? true
  })
)

/**
 * The fields a caller changes on an existing event.
 *
 * @category models
 * @since 1.0.0
 */
export type EventPatch = typeof EventPatch.Type

const sameTime = (desired: EventTimeInput, existing: EventTime | undefined): boolean => {
  if (existing === undefined) return false
  if (desired.dateTime !== undefined) {
    if (existing.dateTime === undefined || Date.parse(existing.dateTime) !== Date.parse(desired.dateTime)) return false
  } else if (existing.date !== desired.date) {
    return false
  }
  // Google fills in a zone the caller did not name, so only a zone both sides
  // name can disagree.
  return desired.timeZone === undefined || existing.timeZone === undefined || desired.timeZone === existing.timeZone
}

const sameSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  const a = new Set(left)
  const b = new Set(right)
  return a.size === b.size && [...a].every((item) => b.has(item))
}

const sameEntries = (
  desired: Readonly<Record<string, string>> | undefined,
  existing: Readonly<Record<string, string>> | undefined
): boolean => desired === undefined || Object.entries(desired).every(([key, value]) => existing?.[key] === value)

/**
 * The fields of `existing` that do not match what `desired` asks for.
 *
 * Only what the caller set is compared: a description the owner added to an
 * event the caller created without one is not a difference. Times compare as
 * instants, because Google answers a `Z` instant with the calendar's offset;
 * attendees compare as sets of lowercased addresses; recurrence as a set of
 * lines. A cancelled event differs in `status` whatever its other fields say.
 * An empty answer means the existing event is the one the caller asked for.
 *
 * @category comparisons
 * @since 1.0.0
 */
export const differences = (desired: EventInput, existing: Event): ReadonlyArray<string> => {
  const found: Array<string> = []
  if (isCancelled(existing)) found.push("status")
  for (const key of ["summary", "description", "location"] as const) {
    const wanted = desired[key]
    if (wanted !== undefined && (existing[key] ?? "") !== wanted) found.push(key)
  }
  if (!sameTime(desired.start, existing.start)) found.push("start")
  if (!sameTime(desired.end, existing.end)) found.push("end")
  if (desired.recurrence !== undefined && !sameSet(desired.recurrence, existing.recurrence ?? [])) {
    found.push("recurrence")
  }
  if (
    desired.attendees !== undefined &&
    !sameSet(
      desired.attendees.map((attendee) => attendee.email.toLowerCase()),
      (existing.attendees ?? []).flatMap((attendee) =>
        attendee.email === undefined ? [] : [attendee.email.toLowerCase()]
      )
    )
  ) {
    found.push("attendees")
  }
  if (desired.visibility !== undefined && (existing.visibility ?? "default") !== desired.visibility) {
    found.push("visibility")
  }
  if (desired.transparency !== undefined && (existing.transparency ?? "opaque") !== desired.transparency) {
    found.push("transparency")
  }
  const properties = desired.extendedProperties
  if (
    properties !== undefined &&
    (!sameEntries(properties.private, existing.extendedProperties?.private) ||
      !sameEntries(properties.shared, existing.extendedProperties?.shared))
  ) {
    found.push("extendedProperties")
  }
  return found
}

/**
 * Whether `event` is the instance of a recurring event that originally started
 * at `originalStart`, compared as instants for a timed event and as dates for
 * an all-day one.
 *
 * @category comparisons
 * @since 1.0.0
 */
export const isOccurrence = (event: Event, originalStart: EventTimeInput): boolean => {
  const original = event.originalStartTime
  if (original === undefined) return false
  return originalStart.dateTime === undefined
    ? original.date === originalStart.date
    : original.dateTime !== undefined && Date.parse(original.dateTime) === Date.parse(originalStart.dateTime)
}
