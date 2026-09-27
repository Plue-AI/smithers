/**
 * The Google Calendar API client.
 *
 * Typed calls for the operations the connector needs, `events.list`,
 * `events.instances`, `events.get`, `events.insert`, `events.patch`,
 * `events.delete` and `freeBusy.query`, over one request path with the
 * behaviors the other provider clients share:
 *
 * - **Rate limits.** Google signals them as a 429 and as a 403 whose error
 *   reason is `rateLimitExceeded` or `userRateLimitExceeded`. Both are retried
 *   for every method, because a refused request was not performed, waiting a
 *   `Retry-After` when one is sent, capped at a minute.
 * - **Ambiguous writes.** A 5xx, a timeout or a dropped connection is retried
 *   for a read (`freeBusy.query` is a POST, and a read). On an insert, patch
 *   or delete the outcome is unknown, so the client reports `outcomeUnknown`
 *   and does not repeat it. A deterministic event id is what lets the caller
 *   repeat an insert safely: see `Actions.UpsertEvent`.
 * - **Expired tokens.** A 401 means the request was refused before it ran, so
 *   the client invalidates the token source and sends the request once more
 *   with a fresh token. A second 401 is `permission-denied`, as is any 403
 *   that is not a rate limit.
 * - **Token hygiene.** The bearer token reaches the `Authorization` header and
 *   nothing else. Every request goes to the configured API origin, redirects
 *   are not followed, calendar and event ids are validated before they become
 *   path segments, and errors remove every configured credential and the
 *   token in use from their text.
 * - **Allowlist.** A client built with `allowedCalendars`, which
 *   {@link layerFromConnection} takes from the connection's containers, refuses
 *   any other calendar before sending anything. An empty list allows none.
 *
 * Writes default to `sendUpdates: "none"`: attendees are not emailed unless a
 * caller asks.
 *
 * @since 1.0.0
 */

import { Credential } from "@smthrs/control/Credential"
import { Context, Duration, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect"
import { type AccessTokenSource, fixed } from "../core/AccessToken.ts"
import { ANY_CONTAINER, type Authorize, type Connection, resolveSecret } from "../core/Connection.ts"
import { IntegrationError, isIntegrationError, isRetryable } from "../core/IntegrationError.ts"
import * as OAuthToken from "../core/OAuthToken.ts"
import { redactedError } from "../core/RedactedError.ts"
import * as Environment from "../Environment.ts"
import { type GoogleCalendarConfig, resolve } from "./Config.ts"
import { Event, type EventInput, EventList, type EventPatch, isCalendarId, isDateTime, isTimeZone } from "./Event.ts"
import { isEventId, isEventReference } from "./EventId.ts"

// Upper bound on an honored Retry-After, so a hostile header cannot park a call.
const MAX_RETRY_AFTER_MS = 60_000

/**
 * The largest page `events.list` and `events.instances` accept.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_PAGE_SIZE = 2500

/**
 * The most calendars one `freeBusy.query` may name.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_FREE_BUSY_CALENDARS = 50

/**
 * The 403 error reasons Google uses for a rate limit.
 *
 * @category constants
 * @since 1.0.0
 */
export const RATE_LIMIT_REASONS: ReadonlyArray<string> = ["rateLimitExceeded", "userRateLimitExceeded"]

/**
 * The 403 error reasons Google uses for an exhausted quota.
 *
 * Not retried, because waiting seconds does not restore a daily quota, and
 * not `permission-denied`, because the credential is fine.
 *
 * @category constants
 * @since 1.0.0
 */
export const QUOTA_REASONS: ReadonlyArray<string> = ["dailyLimitExceeded", "quotaExceeded"]

/**
 * Who Google emails about a write: every attendee, only attendees outside
 * Google Calendar, or nobody.
 *
 * @category models
 * @since 1.0.0
 */
export type SendUpdates = "all" | "externalOnly" | "none"

/**
 * Options for a write.
 *
 * @category models
 * @since 1.0.0
 */
export interface WriteOptions {
  /** Defaults to `none`. */
  readonly sendUpdates?: SendUpdates | undefined
}

/**
 * Parameters of an `events.list` call.
 *
 * `syncToken` asks for the changes since the listing that issued it, and
 * cannot be combined with a time bound.
 *
 * @category models
 * @since 1.0.0
 */
export interface ListQuery {
  readonly pageToken?: string | undefined
  readonly syncToken?: string | undefined
  readonly maxResults?: number | undefined
  readonly timeMin?: string | undefined
  readonly timeMax?: string | undefined
  readonly singleEvents?: boolean | undefined
  readonly showDeleted?: boolean | undefined
}

/**
 * Parameters of an `events.instances` call.
 *
 * @category models
 * @since 1.0.0
 */
export interface InstancesQuery {
  readonly pageToken?: string | undefined
  readonly maxResults?: number | undefined
  readonly timeMin?: string | undefined
  readonly timeMax?: string | undefined
  readonly showDeleted?: boolean | undefined
}

/**
 * One page of events.
 *
 * @category models
 * @since 1.0.0
 */
export interface EventsPage {
  readonly items: ReadonlyArray<Event>
  /** Present when more pages follow. */
  readonly nextPageToken: string | null
  /** Present on the last page of a listing: the cursor for its changes. */
  readonly nextSyncToken: string | null
}

/**
 * A `freeBusy.query` request.
 *
 * @category models
 * @since 1.0.0
 */
export interface FreeBusyQuery {
  /** An RFC 3339 instant with an offset. */
  readonly timeMin: string
  /** An RFC 3339 instant with an offset, after `timeMin`. */
  readonly timeMax: string
  readonly calendarIds: ReadonlyArray<string>
  /** The zone Google answers in. Defaults to UTC. */
  readonly timeZone?: string | undefined
}

/**
 * One busy interval.
 *
 * @category models
 * @since 1.0.0
 */
export interface BusyInterval {
  readonly start: string
  readonly end: string
  readonly startMs: number
  readonly endMs: number
}

/**
 * One calendar's answer.
 *
 * A calendar with `errors` is unknown, not free: Google could not read it,
 * and `busy` is empty because nothing was learned. `notReturned` is this
 * client's reason for a calendar the response left out.
 *
 * @category models
 * @since 1.0.0
 */
export interface CalendarAvailability {
  readonly calendarId: string
  readonly busy: ReadonlyArray<BusyInterval>
  readonly errors: ReadonlyArray<string>
}

/**
 * A `freeBusy.query` answer, one entry per requested calendar in request order.
 *
 * @category models
 * @since 1.0.0
 */
export interface FreeBusy {
  readonly timeMin: string
  readonly timeMax: string
  readonly calendars: ReadonlyArray<CalendarAvailability>
}

/**
 * The client service.
 *
 * @category services
 * @since 1.0.0
 */
export interface CalendarClient {
  /** `events.list`: one page of a calendar's events, or of its changes since a sync token. */
  readonly listEvents: (calendarId: string, query?: ListQuery) => Effect.Effect<EventsPage, IntegrationError>
  /** `events.instances`: one page of a recurring event's instances. */
  readonly instances: (
    calendarId: string,
    eventId: string,
    query?: InstancesQuery
  ) => Effect.Effect<EventsPage, IntegrationError>
  /** `events.get`: one event or instance. Google answers a deleted one with `status: "cancelled"`. */
  readonly getEvent: (calendarId: string, eventId: string) => Effect.Effect<Event, IntegrationError>
  /**
   * `events.insert`. With `id`, the event gets that id and a second insert of
   * it fails with status 409.
   */
  readonly insertEvent: (
    calendarId: string,
    event: EventInput,
    options?: WriteOptions & { readonly id?: string | undefined }
  ) => Effect.Effect<Event, IntegrationError>
  /** `events.patch`: changes the named fields of an event or one instance. */
  readonly patchEvent: (
    calendarId: string,
    eventId: string,
    patch: EventPatch,
    options?: WriteOptions
  ) => Effect.Effect<Event, IntegrationError>
  /** `events.delete`: cancels an event, or one instance of a recurring event. */
  readonly deleteEvent: (
    calendarId: string,
    eventId: string,
    options?: WriteOptions
  ) => Effect.Effect<void, IntegrationError>
  /** `freeBusy.query`. */
  readonly freeBusy: (query: FreeBusyQuery) => Effect.Effect<FreeBusy, IntegrationError>
}

/**
 * Service tag for the Google Calendar client.
 *
 * @category services
 * @since 1.0.0
 */
export const CalendarClient: Context.Service<CalendarClient, CalendarClient> = Context.Service(
  "@smthrs/integrations/GoogleCalendarClient"
)

const GoogleErrorBody = Schema.Struct({
  error: Schema.Struct({
    message: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    errors: Schema.optional(Schema.Array(Schema.Struct({ reason: Schema.optional(Schema.String) })))
  })
})

const decodeGoogleError = Schema.decodeUnknownOption(GoogleErrorBody)

/**
 * The first error reason in a Google error body, or `null`.
 *
 * @category getters
 * @since 1.0.0
 */
export const errorReason = (body: unknown): string | null => {
  const decoded = decodeGoogleError(body)
  return Option.isSome(decoded) ? decoded.value.error.errors?.[0]?.reason ?? null : null
}

/**
 * Whether a response is Google telling the client to slow down.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isRateLimitResponse = (status: number, body: unknown): boolean => {
  if (status === 429) return true
  if (status !== 403) return false
  const reason = errorReason(body)
  return reason !== null && RATE_LIMIT_REASONS.includes(reason)
}

/**
 * How long to wait before retrying, from `Retry-After` seconds, capped at one
 * minute.
 *
 * @category getters
 * @since 1.0.0
 */
export const retryAfterMs = (headers: Headers): number | null => {
  const value = headers.get("retry-after")
  if (value === null) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null
}

const FreeBusyBody = Schema.Struct({
  calendars: Schema.optional(Schema.Record(
    Schema.String,
    Schema.Struct({
      busy: Schema.optional(Schema.Array(Schema.Struct({ start: Schema.String, end: Schema.String }))),
      errors: Schema.optional(Schema.Array(Schema.Struct({ reason: Schema.optional(Schema.String) })))
    })
  ))
})

interface Call {
  readonly operation: string
  readonly method: "GET" | "POST" | "PATCH" | "DELETE"
  readonly path: string
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>> | undefined
  readonly body?: unknown
  /** Whether the request changes the calendar, which makes a lost answer ambiguous. */
  readonly write: boolean
}

interface Answer {
  readonly status: number
  readonly headers: Headers
  readonly json: unknown
}

const invalid = (message: string, details: Record<string, unknown> = {}): IntegrationError =>
  new IntegrationError("invalid-config", message, { ...details, retryable: false })

/**
 * Builds a client bound to `config`.
 *
 * Throws a typed `invalid-config` `IntegrationError` for a malformed base URL,
 * retry budget or timeout, like the other providers' constructors.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  config: GoogleCalendarConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): CalendarClient => {
  const resolved = resolve(config, env)
  const configured = [resolved.accessToken, resolved.clientSecret, resolved.refreshToken]
  const baseUrl = resolved.apiBaseUrl.replace(/\/+$/, "")
  const parsedBase = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
  if (parsedBase === undefined || (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:")) {
    throw invalid("Google Calendar apiBaseUrl must be a valid HTTP or HTTPS URL.", {
      apiBaseUrl: resolved.apiBaseUrl
    })
  }
  if (!Number.isSafeInteger(resolved.maxRetries) || resolved.maxRetries < 0 || resolved.maxRetries > 10) {
    throw invalid("Google Calendar maxRetries must be an integer between 0 and 10.", {
      maxRetries: resolved.maxRetries
    })
  }
  const requestTimeout = Option.getOrUndefined(Duration.fromInput(resolved.requestTimeout))
  if (
    requestTimeout === undefined || !Duration.isFinite(requestTimeout) || Duration.toMillis(requestTimeout) <= 0
  ) {
    throw invalid("Google Calendar requestTimeout must be a finite, positive duration.", {
      requestTimeout: String(resolved.requestTimeout)
    })
  }
  const requestTimeoutMs = Duration.toMillis(requestTimeout)

  const tokens: AccessTokenSource | undefined = resolved.tokens ??
    (resolved.accessToken !== undefined
      ? fixed(Redacted.make(resolved.accessToken))
      : resolved.clientId !== undefined && resolved.refreshToken !== undefined
      ? OAuthToken.make({
        provider: "Google",
        tokenUrl: resolved.tokenUrl,
        clientId: resolved.clientId,
        clientSecret: resolved.clientSecret === undefined ? undefined : Redacted.make(resolved.clientSecret),
        refreshToken: OAuthToken.memoryStore(Redacted.make(resolved.refreshToken)),
        requestTimeout: resolved.requestTimeout
      })
      : undefined)

  const allowed = resolved.allowedCalendars === undefined || resolved.allowedCalendars.includes(ANY_CONTAINER)
    ? undefined
    : new Set(resolved.allowedCalendars)

  const calendarSegment = (calendarId: string): Effect.Effect<string, IntegrationError> => {
    if (!isCalendarId(calendarId)) return Effect.fail(invalid("Google Calendar calendar id is not valid."))
    if (allowed !== undefined && !allowed.has(calendarId)) {
      return Effect.fail(
        new IntegrationError(
          "permission-denied",
          "Google Calendar calendar is not one this connection may use.",
          { calendarId, retryable: false }
        )
      )
    }
    return Effect.succeed(encodeURIComponent(calendarId))
  }

  const eventSegment = (eventId: string): Effect.Effect<string, IntegrationError> =>
    isEventReference(eventId)
      ? Effect.succeed(encodeURIComponent(eventId))
      : Effect.fail(invalid("Google Calendar event id is not valid."))

  const pageSize = (value: number | undefined): Effect.Effect<number | undefined, IntegrationError> =>
    value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE_SIZE)
      ? Effect.succeed(value)
      : Effect.fail(invalid(`Google Calendar maxResults must be an integer between 1 and ${MAX_PAGE_SIZE}.`, {
        maxResults: value
      }))

  const send = (
    spec: Call,
    url: string,
    body: string | undefined,
    token: Redacted.Redacted<string>,
    failure: ReturnType<typeof redactedError>
  ): Effect.Effect<Answer, IntegrationError> => {
    const ambiguous = spec.write
    const suffix = ambiguous ? " (outcome unknown: the write was not repeated)" : ""
    return Effect.tryPromise({
      try: async (signal) => {
        const headers: Record<string, string> = {
          accept: "application/json",
          authorization: `Bearer ${Redacted.value(token)}`,
          "user-agent": "smithers-integrations"
        }
        if (body !== undefined) headers["content-type"] = "application/json"
        const response = await fetch(url, {
          method: spec.method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal
        })
        const text = await response.text()
        let json: unknown = null
        try {
          json = text.length === 0 ? null : JSON.parse(text)
        } catch {
          json = text
        }
        return { status: response.status, headers: response.headers, json }
      },
      // The transport's own message stays on the (redacted) cause.
      catch: (cause) =>
        failure(
          "delivery-failed",
          `Google Calendar ${spec.operation} failed before an answer arrived${suffix}`,
          { operation: spec.operation, method: spec.method, retryable: !ambiguous, outcomeUnknown: ambiguous },
          { cause }
        )
    }).pipe(
      // The deadline spans headers and body. On a write it is the same
      // ambiguity as a dropped connection: Google may have applied it.
      Effect.timeoutOrElse({
        duration: requestTimeout,
        orElse: () =>
          Effect.fail(failure(
            "delivery-failed",
            `Google Calendar ${spec.operation} timed out after ${requestTimeoutMs} ms${suffix}`,
            {
              operation: spec.operation,
              method: spec.method,
              retryable: !ambiguous,
              outcomeUnknown: ambiguous,
              timedOut: true
            }
          ))
      })
    )
  }

  const classify = (spec: Call, answer: Answer, failure: ReturnType<typeof redactedError>): IntegrationError => {
    const rateLimited = isRateLimitResponse(answer.status, answer.json)
    const serverError = answer.status >= 500
    const outcomeUnknown = serverError && spec.write
    const retryable = rateLimited || (serverError && !spec.write)
    const decoded = decodeGoogleError(answer.json)
    const message = Option.isSome(decoded) && decoded.value.error.message !== undefined
      ? decoded.value.error.message
      : typeof answer.json === "string"
      ? answer.json.slice(0, 200)
      : ""
    const reason = errorReason(answer.json)
    const refused = answer.status === 401 ||
      (answer.status === 403 && !rateLimited && (reason === null || !QUOTA_REASONS.includes(reason)))
    return failure(
      refused ? "permission-denied" : "delivery-failed",
      `Google Calendar ${spec.operation} failed: ${answer.status}${message.length === 0 ? "" : ` ${message}`}${
        outcomeUnknown ? " (outcome unknown: the write was not repeated)" : ""
      }`,
      {
        operation: spec.operation,
        method: spec.method,
        status: answer.status,
        googleReason: reason,
        retryable,
        rateLimited,
        outcomeUnknown,
        retryAfterMs: retryable ? retryAfterMs(answer.headers) : null
      }
    )
  }

  const attemptOnce = (spec: Call, url: string, body: string | undefined): Effect.Effect<Answer, IntegrationError> =>
    Effect.gen(function*() {
      if (tokens === undefined) {
        return yield* Effect.fail(
          new IntegrationError(
            "credentials-missing",
            "Google Calendar has no access token: configure a token source, an access token, or an OAuth client id and refresh token.",
            { operation: spec.operation, retryable: false }
          )
        )
      }
      let reauthorized = false
      while (true) {
        const token = yield* tokens.token
        const failure = redactedError([...configured, Redacted.value(token), `Bearer ${Redacted.value(token)}`])
        const answer = yield* send(spec, url, body, token, failure)
        // A 401 is a refusal: the request did not run, so one resend with a
        // freshly minted token is safe even for a write.
        if (answer.status === 401 && !reauthorized) {
          reauthorized = true
          yield* tokens.invalidate
          continue
        }
        if (answer.status >= 200 && answer.status < 300) return answer
        return yield* Effect.fail(classify(spec, answer, failure))
      }
    })

  const request = (spec: Call): Effect.Effect<Answer, IntegrationError> => {
    const url = new URL(`${baseUrl}${spec.path}`)
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const schedule = Schedule.exponential("250 millis").pipe(
      Schedule.upTo({ times: resolved.maxRetries }),
      Schedule.while(({ input }) => isRetryable(input)),
      Schedule.passthrough,
      Schedule.addDelay(({ input }) => {
        const wait = (input as IntegrationError).details?.["retryAfterMs"]
        return Effect.succeed(typeof wait === "number" && wait > 0 ? Duration.millis(wait) : Duration.zero)
      })
    )
    // Serialized once, before the attempt: a body that cannot be serialized
    // was never sent, so it is a configuration failure, not an unknown write.
    return Effect.try({
      try: () => spec.body === undefined ? undefined : JSON.stringify(spec.body),
      catch: (cause) =>
        new IntegrationError(
          "invalid-config",
          `Google Calendar ${spec.operation} body could not be serialized as JSON.`,
          { operation: spec.operation, retryable: false, outcomeUnknown: false },
          { cause }
        )
    }).pipe(
      Effect.flatMap((body) => attemptOnce(spec, url.toString(), body).pipe(Effect.retry(schedule))),
      Effect.withSpan("CalendarClient.request", {
        attributes: { "http.request.method": spec.method, "calendar.operation": spec.operation }
      })
    )
  }

  const decode = <S extends Schema.Constraint>(schema: S, operation: string) => (answer: Answer) =>
    (Schema.decodeUnknownEffect(schema)(answer.json) as Effect.Effect<S["Type"], unknown>).pipe(
      Effect.mapError((cause) =>
        new IntegrationError(
          "decode-failed",
          `Google Calendar ${operation} response failed schema validation.`,
          { operation, retryable: false },
          { cause }
        )
      )
    )

  const toPage = (list: typeof EventList.Type): EventsPage => ({
    items: list.items ?? [],
    nextPageToken: list.nextPageToken ?? null,
    nextSyncToken: list.nextSyncToken ?? null
  })

  const listEvents: CalendarClient["listEvents"] = (calendarId, query = {}) =>
    Effect.gen(function*() {
      const calendar = yield* calendarSegment(calendarId)
      const maxResults = yield* pageSize(query.maxResults)
      const answer = yield* request({
        operation: "events.list",
        method: "GET",
        path: `/calendars/${calendar}/events`,
        query: { ...query, maxResults },
        write: false
      })
      return toPage(yield* decode(EventList, "events.list")(answer))
    })

  const instances: CalendarClient["instances"] = (calendarId, eventId, query = {}) =>
    Effect.gen(function*() {
      const calendar = yield* calendarSegment(calendarId)
      const event = yield* eventSegment(eventId)
      const maxResults = yield* pageSize(query.maxResults)
      const answer = yield* request({
        operation: "events.instances",
        method: "GET",
        path: `/calendars/${calendar}/events/${event}/instances`,
        query: { ...query, maxResults },
        write: false
      })
      return toPage(yield* decode(EventList, "events.instances")(answer))
    })

  const getEvent: CalendarClient["getEvent"] = (calendarId, eventId) =>
    Effect.gen(function*() {
      const calendar = yield* calendarSegment(calendarId)
      const event = yield* eventSegment(eventId)
      const answer = yield* request({
        operation: "events.get",
        method: "GET",
        path: `/calendars/${calendar}/events/${event}`,
        write: false
      })
      return yield* decode(Event, "events.get")(answer)
    })

  const insertEvent: CalendarClient["insertEvent"] = (calendarId, event, options = {}) =>
    Effect.gen(function*() {
      const calendar = yield* calendarSegment(calendarId)
      if (options.id !== undefined && !isEventId(options.id)) {
        return yield* Effect.fail(invalid("Google Calendar event id must be 5-1024 base32hex characters."))
      }
      const answer = yield* request({
        operation: "events.insert",
        method: "POST",
        path: `/calendars/${calendar}/events`,
        query: { sendUpdates: options.sendUpdates ?? "none" },
        body: options.id === undefined ? event : { ...event, id: options.id },
        write: true
      })
      return yield* decode(Event, "events.insert")(answer)
    })

  const patchEvent: CalendarClient["patchEvent"] = (calendarId, eventId, patch, options = {}) =>
    Effect.gen(function*() {
      const calendar = yield* calendarSegment(calendarId)
      const event = yield* eventSegment(eventId)
      const answer = yield* request({
        operation: "events.patch",
        method: "PATCH",
        path: `/calendars/${calendar}/events/${event}`,
        query: { sendUpdates: options.sendUpdates ?? "none" },
        body: patch,
        write: true
      })
      return yield* decode(Event, "events.patch")(answer)
    })

  const deleteEvent: CalendarClient["deleteEvent"] = (calendarId, eventId, options = {}) =>
    Effect.gen(function*() {
      const calendar = yield* calendarSegment(calendarId)
      const event = yield* eventSegment(eventId)
      yield* request({
        operation: "events.delete",
        method: "DELETE",
        path: `/calendars/${calendar}/events/${event}`,
        query: { sendUpdates: options.sendUpdates ?? "none" },
        write: true
      })
    })

  const freeBusy: CalendarClient["freeBusy"] = (query) =>
    Effect.gen(function*() {
      if (!isDateTime(query.timeMin) || !isDateTime(query.timeMax)) {
        return yield* Effect.fail(invalid("Google Calendar freeBusy bounds must be RFC 3339 date-times with offsets."))
      }
      if (Date.parse(query.timeMax) <= Date.parse(query.timeMin)) {
        return yield* Effect.fail(invalid("Google Calendar freeBusy timeMax must be after timeMin."))
      }
      if (query.calendarIds.length === 0 || query.calendarIds.length > MAX_FREE_BUSY_CALENDARS) {
        return yield* Effect.fail(
          invalid(`Google Calendar freeBusy names between 1 and ${MAX_FREE_BUSY_CALENDARS} calendars.`)
        )
      }
      if (query.timeZone !== undefined && !isTimeZone(query.timeZone)) {
        return yield* Effect.fail(invalid("Google Calendar freeBusy timeZone must be an IANA time zone name."))
      }
      for (const calendarId of query.calendarIds) yield* calendarSegment(calendarId)
      const answer = yield* request({
        operation: "freeBusy.query",
        method: "POST",
        path: "/freeBusy",
        body: {
          timeMin: query.timeMin,
          timeMax: query.timeMax,
          ...(query.timeZone === undefined ? {} : { timeZone: query.timeZone }),
          items: query.calendarIds.map((id) => ({ id }))
        },
        // A POST, but a read: repeating it after a lost answer changes nothing.
        write: false
      })
      const body = yield* decode(FreeBusyBody, "freeBusy.query")(answer)
      const calendars: Array<CalendarAvailability> = []
      for (const calendarId of query.calendarIds) {
        const entry = body.calendars?.[calendarId]
        if (entry === undefined) {
          calendars.push({ calendarId, busy: [], errors: ["notReturned"] })
          continue
        }
        const busy: Array<BusyInterval> = []
        for (const interval of entry.busy ?? []) {
          const startMs = Date.parse(interval.start)
          const endMs = Date.parse(interval.end)
          if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
            return yield* Effect.fail(
              new IntegrationError(
                "decode-failed",
                "Google Calendar freeBusy.query returned an interval that is not a pair of instants.",
                { operation: "freeBusy.query", retryable: false }
              )
            )
          }
          busy.push({ start: interval.start, end: interval.end, startMs, endMs })
        }
        const errors = (entry.errors ?? []).map((error) => error.reason ?? "unknown")
        calendars.push({ calendarId, busy: errors.length === 0 ? busy : [], errors })
      }
      return { timeMin: query.timeMin, timeMax: query.timeMax, calendars }
    })

  return CalendarClient.of({ listEvents, instances, getEvent, insertEvent, patchEvent, deleteEvent, freeBusy })
}

const fromMake = (build: () => CalendarClient): Effect.Effect<CalendarClient, IntegrationError> =>
  Effect.suspend(() => {
    // A config error is a typed layer failure. Anything else is a defect.
    try {
      return Effect.succeed(build())
    } catch (error) {
      if (isIntegrationError(error)) return Effect.fail(error)
      throw error
    }
  })

/**
 * Layer for a client bound to `config`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  config: GoogleCalendarConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Layer.Layer<CalendarClient, IntegrationError> => Layer.effect(CalendarClient)(fromMake(() => make(config, env)))

/**
 * Who is asking to use a connection, and the host policy that decides.
 *
 * @category models
 * @since 1.0.0
 */
export interface ConnectionAccess {
  /** The principal the running task acts as, from trusted host state. */
  readonly principal: string
  /** The host's decision, such as `Connection.personalPolicy`. */
  readonly authorize: Authorize
}

/**
 * Layer for a client acting through a configured connection.
 *
 * The connection's credential holds the refresh token. Every read of it goes
 * through `Connection.resolveSecret`, so `access.authorize` decides whether
 * `access.principal` may use the connection before the broker is asked, and a
 * personal connection stays with the principals the policy names. A rotated
 * refresh token is written back through the broker's compare-and-set. The
 * OAuth client id and secret come from `config` or the `SMITHERS_GOOGLE_*`
 * environment, the API root from the connection when it names one, and the
 * connection's containers are the calendars the client may touch.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerFromConnection = (
  connection: Connection,
  access: ConnectionAccess,
  config: Omit<GoogleCalendarConfig, "tokens" | "accessToken" | "refreshToken" | "allowedCalendars"> = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Layer.Layer<CalendarClient, IntegrationError, Credential> =>
  Layer.effect(CalendarClient)(Effect.gen(function*() {
    const credentials = yield* Credential
    return yield* fromMake(() => {
      if (connection.provider !== "googlecalendar") {
        throw invalid("Google Calendar connection must name the googlecalendar provider.", {
          connectionId: connection.id
        })
      }
      const explicit = {
        ...config,
        ...(connection.apiBaseUrl === undefined ? {} : { apiBaseUrl: connection.apiBaseUrl })
      }
      const resolved = resolve(explicit, env)
      const load = resolveSecret({ credentials, connection, principal: access.principal, authorize: access.authorize })
      const rotation = OAuthToken.credentialStore(credentials, connection.credential)
      const tokens = OAuthToken.make({
        provider: "Google",
        tokenUrl: resolved.tokenUrl,
        clientId: resolved.clientId ?? "",
        clientSecret: resolved.clientSecret === undefined ? undefined : Redacted.make(resolved.clientSecret),
        // The policy is asked again before a rotation is written back.
        refreshToken: { load, replace: (previous, next) => Effect.andThen(load, rotation.replace(previous, next)) },
        requestTimeout: resolved.requestTimeout
      })
      return make({ ...explicit, tokens, allowedCalendars: connection.containers }, env)
    })
  }))
