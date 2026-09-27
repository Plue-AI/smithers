/**
 * The durable Google Calendar actions.
 *
 * {@link CalendarClient} is the host layer: rate limits, token refresh and
 * token hygiene. An `Action` makes one of its calls a step of a durable flow,
 * so the journal records the receipt and a restart replays it instead of
 * writing again.
 *
 * The writes differ from the other providers' in one way that matters: Google
 * lets the caller choose an event's id. {@link UpsertEvent} inserts under a
 * deterministic id (`EventId.fromKey`), so a lost answer is recoverable. The
 * retry inserts the same id, Google refuses the duplicate with a 409, and the
 * action reads the event back and compares it with what was asked for. The
 * write actions therefore declare an `idempotencyKey`, an
 * `implementationVersion` and a bounded {@link retryPolicy}, and the engine may
 * repeat them: a repeated upsert finds its own event, a repeated patch sets the
 * same fields, and a repeated cancel finds the event already cancelled. They
 * stay `irreversible`, because an attendee may have seen the change the moment
 * Google accepted it.
 *
 * Writes default to `sendUpdates: "none"`, so no attendee is emailed unless the
 * payload asks.
 *
 * A recurring event is one event with `recurrence` rules and a `timeZone` on
 * its start and end. One occurrence is changed or cancelled by naming the
 * series id and the occurrence's `originalStart`; the action finds that
 * instance through `events.instances` and writes to the instance id Google
 * reports, rather than assembling an instance id itself.
 *
 * @since 1.0.0
 */

import { Action, type FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import { fromIntegrationError, IntegrationFailure } from "../core/ActionFailure.ts"
import { IntegrationError } from "../core/IntegrationError.ts"
import { CalendarClient } from "./CalendarClient.ts"
import {
  CalendarId,
  DateTime,
  differences,
  type Event,
  EventInput,
  EventPatch,
  EventTimeInput,
  isCancelled,
  isOccurrence,
  TimeZone
} from "./Event.ts"
import { EventId, EventReference } from "./EventId.ts"

/**
 * Who Google emails about a write.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SendUpdates = Schema.Literals(["all", "externalOnly", "none"])

/**
 * What a write action reports about the event it left behind.
 *
 * `externalId` is `<calendarId>/<eventId>`, the identity a synchronized record
 * of the same event carries.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EventReceipt = Schema.Struct({
  calendarId: Schema.String,
  eventId: Schema.String,
  externalId: Schema.String,
  url: Schema.NullOr(Schema.String),
  status: Schema.String,
  etag: Schema.NullOr(Schema.String)
})

/**
 * What a write action reports about the event it left behind.
 *
 * @category models
 * @since 1.0.0
 */
export type EventReceipt = typeof EventReceipt.Type

const receipt = (calendarId: string, event: Event): EventReceipt => ({
  calendarId,
  eventId: event.id,
  externalId: `${calendarId}/${event.id}`,
  url: event.htmlLink ?? null,
  status: event.status ?? "confirmed",
  etag: event.etag ?? null
})

/**
 * The event already under the chosen id is not the event the caller asked for.
 *
 * `fields` names what differs, such as a start time the owner moved or a
 * `status` of `cancelled`. It is a decision for the caller, not a failure to
 * retry: overwriting it could undo someone's edit, and leaving it could leave
 * the wrong event in place. `PatchEvent` changes it deliberately.
 *
 * @category errors
 * @since 1.0.0
 */
export class EventConflict extends Schema.TaggedError<EventConflict>()(
  "/integrations/googlecalendar/EventConflict",
  {
    calendarId: Schema.String,
    eventId: Schema.String,
    fields: Schema.Array(Schema.String),
    message: Schema.String
  }
) {}

/**
 * The engine retry policy of the write actions.
 *
 * Three attempts, half a second then a second apart. Each attempt already
 * carries the client's own rate-limit retries. {@link EventConflict} is never
 * retried: the same comparison would fail the same way.
 *
 * @category constants
 * @since 1.0.0
 */
export const retryPolicy: RetryPolicy.RetryPolicy = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 5_000,
  maxAttempts: 3,
  nonRetryable: ["/integrations/googlecalendar/EventConflict"]
})

/**
 * What {@link UpsertEvent} needs.
 *
 * `eventId` is the caller's choice, normally `EventId.fromKey` of a key that
 * names the event, such as a meeting series and a principal.
 *
 * @category schemas
 * @since 1.0.0
 */
export const UpsertEventPayload = Schema.Struct({
  calendarId: CalendarId,
  eventId: EventId,
  event: EventInput,
  sendUpdates: Schema.optionalKey(SendUpdates)
})

/**
 * What {@link UpsertEvent} reports. `created` is false when the event already
 * existed as asked, which is what a retried or replayed upsert sees.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Upserted = Schema.Struct({
  ...EventReceipt.fields,
  created: Schema.Boolean
})

/**
 * Makes the event exist under the caller's id.
 *
 * Inserts it; on a 409 reads the event under that id back and compares the
 * fields the payload sets. A match succeeds with `created: false`, anything
 * else fails with {@link EventConflict}.
 *
 * @category actions
 * @since 1.0.0
 */
export const UpsertEvent = Action.make("integrations/googlecalendar/upsert-event", {
  payload: UpsertEventPayload,
  success: Upserted,
  error: Schema.Union([IntegrationFailure, EventConflict]),
  tier: "irreversible",
  implementationVersion: "googlecalendar/upsert-event/v1",
  idempotencyKey: (payload) => ({
    action: "integrations/googlecalendar/upsert-event",
    calendarId: payload.calendarId,
    eventId: payload.eventId,
    event: payload.event as unknown as Schema.Json,
    sendUpdates: payload.sendUpdates ?? "none"
  }),
  retryPolicy
})

const isStatus = (status: number) => (error: IntegrationError): boolean => error.details?.["status"] === status

const toFailure = (error: IntegrationError | EventConflict): IntegrationFailure | EventConflict =>
  error instanceof EventConflict ? error : fromIntegrationError(error)

/**
 * Implements {@link UpsertEvent} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerUpsertEvent: Layer.Layer<
  Action.Requirement<"integrations/googlecalendar/upsert-event">,
  never,
  CalendarClient | FlowRuntime.FlowRuntime
> = UpsertEvent.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* CalendarClient
      const sendUpdates = payload.sendUpdates ?? "none"
      const inserted = yield* client.insertEvent(payload.calendarId, payload.event, {
        id: payload.eventId,
        sendUpdates
      }).pipe(
        Effect.map((event): Event | null => event),
        Effect.catchIf(isStatus(409), () => Effect.succeed(null))
      )
      if (inserted !== null) return { ...receipt(payload.calendarId, inserted), created: true }
      const existing = yield* client.getEvent(payload.calendarId, payload.eventId)
      const differing = differences(payload.event, existing)
      if (differing.length === 0) return { ...receipt(payload.calendarId, existing), created: false }
      return yield* Effect.fail(
        new EventConflict({
          calendarId: payload.calendarId,
          eventId: payload.eventId,
          fields: differing,
          message: `Event ${payload.eventId} already exists and differs in ${differing.join(", ")}.`
        })
      )
    }).pipe(Effect.mapError(toFailure)),
  { implementationVersion: "googlecalendar/upsert-event/v1" }
)

/**
 * How far either side of an occurrence's original start its instance is
 * looked for.
 *
 * `events.instances` filters by an instance's current time, so an occurrence
 * moved further than this from where it began is not found.
 *
 * @category constants
 * @since 1.0.0
 */
export const OCCURRENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const OCCURRENCE_PAGES = 10

const startMs = (time: EventTimeInput): number =>
  time.dateTime === undefined ? Date.parse(`${time.date}T00:00:00Z`) : Date.parse(time.dateTime)

/**
 * The instance of `eventId` that originally started at `originalStart`,
 * cancelled ones included.
 */
const findOccurrence = (
  client: CalendarClient,
  calendarId: string,
  eventId: string,
  originalStart: EventTimeInput
): Effect.Effect<Event, IntegrationError> =>
  Effect.gen(function*() {
    const at = startMs(originalStart)
    const timeMin = new Date(at - OCCURRENCE_WINDOW_MS).toISOString()
    const timeMax = new Date(at + OCCURRENCE_WINDOW_MS).toISOString()
    let pageToken: string | undefined
    for (let page = 0; page < OCCURRENCE_PAGES; page++) {
      const listed = yield* client.instances(calendarId, eventId, {
        timeMin,
        timeMax,
        showDeleted: true,
        maxResults: 250,
        pageToken
      })
      const found = listed.items.find((instance) => isOccurrence(instance, originalStart))
      if (found !== undefined) return found
      if (listed.nextPageToken === null) break
      pageToken = listed.nextPageToken
    }
    return yield* Effect.fail(
      new IntegrationError(
        "delivery-failed",
        `No instance of event ${eventId} originally starts at ${originalStart.dateTime ?? originalStart.date}.`,
        { operation: "events.instances", status: 404, retryable: false }
      )
    )
  })

/**
 * What {@link PatchEvent} needs.
 *
 * With `originalStart`, the patch applies to that one occurrence of the
 * recurring event `eventId`; without it, to `eventId` itself, which for a
 * recurring event is the whole series.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PatchEventPayload = Schema.Struct({
  calendarId: CalendarId,
  eventId: EventReference,
  originalStart: Schema.optionalKey(EventTimeInput),
  patch: EventPatch,
  sendUpdates: Schema.optionalKey(SendUpdates)
})

/**
 * Changes the named fields of an event, or of one occurrence of a recurring
 * event.
 *
 * Setting the same fields twice leaves the same event, which is why the engine
 * may repeat it after a lost answer.
 *
 * @category actions
 * @since 1.0.0
 */
export const PatchEvent = Action.make("integrations/googlecalendar/patch-event", {
  payload: PatchEventPayload,
  success: EventReceipt,
  error: IntegrationFailure,
  tier: "irreversible",
  implementationVersion: "googlecalendar/patch-event/v1",
  idempotencyKey: (payload) => ({
    action: "integrations/googlecalendar/patch-event",
    calendarId: payload.calendarId,
    eventId: payload.eventId,
    originalStart: (payload.originalStart ?? null) as unknown as Schema.Json,
    patch: payload.patch as unknown as Schema.Json,
    sendUpdates: payload.sendUpdates ?? "none"
  }),
  retryPolicy
})

/**
 * Implements {@link PatchEvent} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerPatchEvent: Layer.Layer<
  Action.Requirement<"integrations/googlecalendar/patch-event">,
  never,
  CalendarClient | FlowRuntime.FlowRuntime
> = PatchEvent.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* CalendarClient
      const target = payload.originalStart === undefined
        ? payload.eventId
        : (yield* findOccurrence(client, payload.calendarId, payload.eventId, payload.originalStart)).id
      const patched = yield* client.patchEvent(payload.calendarId, target, payload.patch, {
        sendUpdates: payload.sendUpdates ?? "none"
      })
      return receipt(payload.calendarId, patched)
    }).pipe(Effect.mapError(fromIntegrationError)),
  { implementationVersion: "googlecalendar/patch-event/v1" }
)

/**
 * What {@link CancelEvent} needs.
 *
 * With `originalStart`, only that occurrence of the recurring event `eventId`
 * is cancelled; without it, the event itself, every occurrence of a series.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CancelEventPayload = Schema.Struct({
  calendarId: CalendarId,
  eventId: EventReference,
  originalStart: Schema.optionalKey(EventTimeInput),
  sendUpdates: Schema.optionalKey(SendUpdates)
})

/**
 * What {@link CancelEvent} reports. `alreadyCancelled` is true when the event
 * or occurrence was cancelled before this step, which is what a retried
 * cancel sees.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Cancelled = Schema.Struct({
  calendarId: Schema.String,
  eventId: Schema.String,
  externalId: Schema.String,
  alreadyCancelled: Schema.Boolean
})

/**
 * Cancels an event, or one occurrence of a recurring event.
 *
 * Google answers `410 Gone` for an event that is already deleted, and lists a
 * cancelled occurrence with `status: "cancelled"`; both succeed with
 * `alreadyCancelled: true`.
 *
 * @category actions
 * @since 1.0.0
 */
export const CancelEvent = Action.make("integrations/googlecalendar/cancel-event", {
  payload: CancelEventPayload,
  success: Cancelled,
  error: IntegrationFailure,
  tier: "irreversible",
  implementationVersion: "googlecalendar/cancel-event/v1",
  idempotencyKey: (payload) => ({
    action: "integrations/googlecalendar/cancel-event",
    calendarId: payload.calendarId,
    eventId: payload.eventId,
    originalStart: (payload.originalStart ?? null) as unknown as Schema.Json,
    sendUpdates: payload.sendUpdates ?? "none"
  }),
  retryPolicy
})

/**
 * Implements {@link CancelEvent} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerCancelEvent: Layer.Layer<
  Action.Requirement<"integrations/googlecalendar/cancel-event">,
  never,
  CalendarClient | FlowRuntime.FlowRuntime
> = CancelEvent.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* CalendarClient
      const cancelled = (eventId: string, alreadyCancelled: boolean) => ({
        calendarId: payload.calendarId,
        eventId,
        externalId: `${payload.calendarId}/${eventId}`,
        alreadyCancelled
      })
      let target = payload.eventId
      if (payload.originalStart !== undefined) {
        const occurrence = yield* findOccurrence(client, payload.calendarId, payload.eventId, payload.originalStart)
        if (isCancelled(occurrence)) return cancelled(occurrence.id, true)
        target = occurrence.id
      }
      return yield* client.deleteEvent(payload.calendarId, target, { sendUpdates: payload.sendUpdates ?? "none" }).pipe(
        Effect.as(cancelled(target, false)),
        Effect.catchIf(isStatus(410), () => Effect.succeed(cancelled(target, true)))
      )
    }).pipe(Effect.mapError(fromIntegrationError)),
  { implementationVersion: "googlecalendar/cancel-event/v1" }
)

/**
 * What {@link FreeBusy} needs.
 *
 * @category schemas
 * @since 1.0.0
 */
export const FreeBusyPayload = Schema.Struct({
  timeMin: DateTime,
  timeMax: DateTime,
  calendarIds: Schema.NonEmptyArray(CalendarId),
  timeZone: Schema.optionalKey(TimeZone)
})

/**
 * One busy interval, as given and as Unix milliseconds.
 *
 * @category schemas
 * @since 1.0.0
 */
export const BusyInterval = Schema.Struct({
  start: Schema.String,
  end: Schema.String,
  startMs: Schema.Number,
  endMs: Schema.Number
})

/**
 * The availability {@link FreeBusy} found, one entry per requested calendar.
 *
 * A calendar with `errors` is unknown, not free.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Availability = Schema.Struct({
  timeMin: Schema.String,
  timeMax: Schema.String,
  calendars: Schema.Array(Schema.Struct({
    calendarId: Schema.String,
    busy: Schema.Array(BusyInterval),
    errors: Schema.Array(Schema.String)
  }))
})

/**
 * Reads when calendars are busy.
 *
 * A read, so the tier is `sealed`: the journal keeps the answer and a replay
 * reuses it rather than asking again. It is `nondeterministic`, because two
 * asks at different moments may legitimately answer differently.
 *
 * @category actions
 * @since 1.0.0
 */
export const FreeBusy = Action.make("integrations/googlecalendar/free-busy", {
  payload: FreeBusyPayload,
  success: Availability,
  error: IntegrationFailure,
  nondeterministic: true
})

/**
 * Implements {@link FreeBusy} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerFreeBusy: Layer.Layer<
  Action.Requirement<"integrations/googlecalendar/free-busy">,
  never,
  CalendarClient | FlowRuntime.FlowRuntime
> = FreeBusy.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* CalendarClient
    return yield* client.freeBusy({
      timeMin: payload.timeMin,
      timeMax: payload.timeMax,
      calendarIds: payload.calendarIds,
      ...(payload.timeZone === undefined ? {} : { timeZone: payload.timeZone })
    })
  }).pipe(Effect.mapError(fromIntegrationError))
)

/**
 * Every Google Calendar action's implementation, in one layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<
  | Action.Requirement<"integrations/googlecalendar/upsert-event">
  | Action.Requirement<"integrations/googlecalendar/patch-event">
  | Action.Requirement<"integrations/googlecalendar/cancel-event">
  | Action.Requirement<"integrations/googlecalendar/free-busy">,
  never,
  CalendarClient | FlowRuntime.FlowRuntime
> = Layer.mergeAll(layerUpsertEvent, layerPatchEvent, layerCancelEvent, layerFreeBusy)
