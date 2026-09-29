/**
 * The durable Google Calendar actions, executed through the real flow runtime
 * against a real `node:http` server standing in for the Calendar API.
 *
 * Each case builds a flow whose body is one action call and runs it on
 * `FlowEngine.layerMemory`, so the payload is decoded, the idempotency key is
 * computed, the engine's retry policy applies, and the result crosses the
 * journal's schema. The cases that matter most are the recoveries the module
 * exists for: an insert whose answer was lost is repeated under the same id
 * and finds its own event, a 409 over someone else's edit is a conflict and
 * not a retry, and a cancel that already happened is a success.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, type Schema } from "effect"
import type { ServerResponse } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { IntegrationFailure } from "../src/core/ActionFailure.ts"
import * as Actions from "../src/googlecalendar/Actions.ts"
import * as CalendarClient from "../src/googlecalendar/CalendarClient.ts"
import type { EventInput } from "../src/googlecalendar/Event.ts"
import { fromKey } from "../src/googlecalendar/EventId.ts"
import { type Fixture, json, type Recorded, startFixture } from "./Fixture.ts"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const EVENT_ID = fromKey("weekly-sync/lead")
const SERIES = "series0001"

const EVENT: EventInput = {
  summary: "Weekly sync",
  start: { dateTime: "2026-10-02T09:00:00-07:00", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-10-02T09:30:00-07:00", timeZone: "America/Los_Angeles" },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR"]
}

/** The event as Google stores {@link EVENT}: instants in UTC, extra fields. */
const stored = (extra: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  etag: "\"3\"",
  htmlLink: "https://calendar.example.test/event?eid=1",
  summary: "Weekly sync",
  start: { dateTime: "2026-10-02T16:00:00Z", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-10-02T16:30:00Z", timeZone: "America/Los_Angeles" },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR"],
  ...extra
})

const googleError = (response: ServerResponse, status: number, reason: string) =>
  json(response, status, { error: { code: status, message: reason, errors: [{ domain: "calendar", reason }] } })

const noContent = (response: ServerResponse) => {
  response.writeHead(204)
  response.end()
}

const lines = (): ReadonlyArray<string> =>
  (fixture as Fixture).requests.map((request) => `${request.method} ${request.url}`)

/** Every action tag {@link Actions.layer} implements. */
type CalendarTag = Layer.Success<typeof Actions.layer> extends Action.Requirement<infer Tag> ? Tag : never

/** A schema whose codec needs no services, which every Calendar action schema is. */
type PureSchema = { readonly DecodingServices: never; readonly EncodingServices: never }

const runAction = <
  Tag extends CalendarTag,
  Payload extends Flow.AnyStructSchema & PureSchema,
  Success extends Schema.Top & PureSchema,
  Error extends Schema.Top & PureSchema
>(
  declaration: Action.Declared<Tag, Payload, Success, Error>,
  payload: Payload["~type.make.in"]
): Promise<Success["Type"]> => {
  const flow = Flow.make(`${declaration.name}/test-flow`, {
    payload: declaration.payloadSchema,
    success: declaration.successSchema,
    error: declaration.errorSchema,
    // The cast is on the payload value only (decoded Type vs planned make-in); R is untouched.
    body: (input) => declaration.call(input as never)
  })
  const clientLayer = CalendarClient.layer(
    { accessToken: "ya29.fixture", apiBaseUrl: (fixture as Fixture).origin, maxRetries: 0 },
    {}
  )
  // Narrows only the provided side to this tag, which `Tag extends CalendarTag`
  // guarantees `Actions.layer` implements; its requirements (RIn) are kept.
  const implementation = Actions.layer as Layer.Layer<
    Action.Requirement<Tag>,
    never,
    Layer.Services<typeof Actions.layer>
  >
  const layer = Layer.mergeAll(implementation, Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, clientLayer, NodeCrypto.layer))
  )
  return Effect.runPromise(
    flow.execute(payload, { executionId: `run-${declaration.name}-${Math.random()}` }).pipe(
      Effect.provide(layer),
      Effect.scoped
    )
  )
}

/** An action nothing in {@link runAction}'s layer implements. */
const Unprovided = Action.make("test/integrations/GoogleCalendarActions/Unprovided", { payload: {} })

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = () => {
  // @ts-expect-error Actions.layer does not implement the Unprovided action
  runAction(Unprovided, {})
  runAction(Actions.CancelEvent, { calendarId: "primary", eventId: "e" })
}

describe("regression: provide-then-cast test helpers erase layer requirements (#2704)", () => {
  it("rejects an action the Calendar layer does not implement", () => {
    // The assertion is the `@ts-expect-error` directive above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})

const rejected = async (promise: Promise<unknown>): Promise<any> => {
  const failure: any = await promise.then(() => undefined, (error: unknown) => error)
  return failure?.cause?.error ?? failure?.error ?? failure
}

describe("UpsertEvent", () => {
  it("inserts under the caller's id and emails nobody by default", async () => {
    fixture = await startFixture((request, response) => json(response, 200, stored({ ...JSON.parse(request.body) })))
    const upserted = await runAction(Actions.UpsertEvent, {
      calendarId: "primary",
      eventId: EVENT_ID,
      event: EVENT
    })
    expect(upserted).toEqual({
      calendarId: "primary",
      eventId: EVENT_ID,
      externalId: `primary/${EVENT_ID}`,
      url: "https://calendar.example.test/event?eid=1",
      status: "confirmed",
      etag: "\"3\"",
      created: true
    })
    expect(lines()).toEqual(["POST /calendars/primary/events?sendUpdates=none"])
    expect(JSON.parse((fixture.requests[0] as Recorded).body)).toEqual({ ...EVENT, id: EVENT_ID })
  })

  it("reads the event back after a 409 and succeeds when it is the one asked for", async () => {
    fixture = await startFixture((request, response) =>
      request.method === "POST"
        ? googleError(response, 409, "duplicate")
        : json(response, 200, { ...stored(), htmlLink: undefined, etag: undefined, status: undefined })
    )
    const upserted = await runAction(Actions.UpsertEvent, {
      calendarId: "primary",
      eventId: EVENT_ID,
      event: EVENT,
      sendUpdates: "all"
    })
    expect(upserted).toMatchObject({ created: false, url: null, etag: null, status: "confirmed" })
    expect(lines()).toEqual([
      "POST /calendars/primary/events?sendUpdates=all",
      `GET /calendars/primary/events/${EVENT_ID}`
    ])
  })

  it("fails with a conflict, once, when the existing event was changed", async () => {
    fixture = await startFixture((request, response) =>
      request.method === "POST"
        ? googleError(response, 409, "duplicate")
        : json(response, 200, stored({ status: "cancelled", summary: "Renamed by the owner" }))
    )
    const conflict = await rejected(
      runAction(Actions.UpsertEvent, { calendarId: "primary", eventId: EVENT_ID, event: EVENT })
    )
    expect(conflict).toBeInstanceOf(Actions.EventConflict)
    expect(conflict.fields).toEqual(["status", "summary"])
    expect(conflict.message).toContain("differs in status, summary")
    // A conflict is never retried: one insert, one read.
    expect(lines()).toHaveLength(2)
  })

  it("repeats an insert whose answer was lost, and the repeat finds its own event", async () => {
    let inserts = 0
    fixture = await startFixture((request, response) => {
      if (request.method === "GET") return json(response, 200, stored())
      inserts += 1
      // The first insert was applied but its answer lost; the retry meets the duplicate.
      return inserts === 1 ? googleError(response, 503, "backendError") : googleError(response, 409, "duplicate")
    })
    const upserted = await runAction(Actions.UpsertEvent, {
      calendarId: "primary",
      eventId: EVENT_ID,
      event: EVENT
    })
    expect(upserted.created).toBe(false)
    expect(lines()).toEqual([
      "POST /calendars/primary/events?sendUpdates=none",
      "POST /calendars/primary/events?sendUpdates=none",
      `GET /calendars/primary/events/${EVENT_ID}`
    ])
  })

  it("keys the step by what it writes, defaulting the recipients, and never retries a conflict", () => {
    const key = Actions.UpsertEvent.idempotencyKey as (payload: unknown) => unknown
    const payload = { calendarId: "primary", eventId: EVENT_ID, event: EVENT }
    expect(key(payload)).toEqual({
      action: "integrations/googlecalendar/upsert-event",
      calendarId: "primary",
      eventId: EVENT_ID,
      event: EVENT,
      sendUpdates: "none"
    })
    expect(key({ ...payload, sendUpdates: "all" })).not.toEqual(key(payload))
    expect(Actions.UpsertEvent.tier).toBe("irreversible")
    expect(Actions.retryPolicy.maxAttempts).toBe(3)
    expect(Actions.retryPolicy.nonRetryable).toEqual(["/integrations/googlecalendar/EventConflict"])
  })
})

describe("PatchEvent", () => {
  it("patches the event itself when no occurrence is named", async () => {
    fixture = await startFixture((request, response) =>
      json(response, 200, stored({ ...JSON.parse(request.body), status: "tentative" }))
    )
    const receipt = await runAction(Actions.PatchEvent, {
      calendarId: "primary",
      eventId: EVENT_ID,
      patch: { summary: "Moved", status: "tentative" },
      sendUpdates: "externalOnly"
    })
    expect(receipt).toMatchObject({ eventId: EVENT_ID, status: "tentative", externalId: `primary/${EVENT_ID}` })
    expect(lines()).toEqual([`PATCH /calendars/primary/events/${EVENT_ID}?sendUpdates=externalOnly`])
    expect(JSON.parse((fixture.requests[0] as Recorded).body)).toEqual({ summary: "Moved", status: "tentative" })
  })

  it("finds one occurrence across instance pages and patches the instance Google names", async () => {
    const instanceId = `${SERIES}_20261009T160000Z`
    fixture = await startFixture((request, response) => {
      const url = new URL(request.url, "http://fixture")
      if (url.pathname.endsWith("/instances")) {
        return url.searchParams.get("pageToken") === null
          ? json(response, 200, {
            items: [{ id: `${SERIES}_20261002T160000Z`, originalStartTime: { dateTime: "2026-10-02T16:00:00Z" } }],
            nextPageToken: "page-2"
          })
          : json(response, 200, {
            items: [{ id: instanceId, originalStartTime: { dateTime: "2026-10-09T09:00:00-07:00" } }]
          })
      }
      return json(response, 200, { id: instanceId, recurringEventId: SERIES, summary: "Moved" })
    })
    const receipt = await runAction(Actions.PatchEvent, {
      calendarId: "primary",
      eventId: SERIES,
      originalStart: { dateTime: "2026-10-09T16:00:00Z" },
      patch: { summary: "Moved" }
    })
    expect(receipt.eventId).toBe(instanceId)
    const first = new URL((fixture.requests[0] as Recorded).url, "http://fixture")
    expect(first.pathname).toBe(`/calendars/primary/events/${SERIES}/instances`)
    expect(Object.fromEntries(first.searchParams)).toEqual({
      timeMin: "2026-10-02T16:00:00.000Z",
      timeMax: "2026-10-16T16:00:00.000Z",
      showDeleted: "true",
      maxResults: "250"
    })
    expect(new URL((fixture.requests[1] as Recorded).url, "http://fixture").searchParams.get("pageToken")).toBe(
      "page-2"
    )
    expect(lines()[2]).toBe(`PATCH /calendars/primary/events/${instanceId}?sendUpdates=none`)
  })

  it("fails without writing when no instance starts at the named time", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { items: [] }))
    const failure = await rejected(
      runAction(Actions.PatchEvent, {
        calendarId: "primary",
        eventId: SERIES,
        originalStart: { date: "2026-10-09" },
        patch: { summary: "Moved" }
      })
    )
    expect(failure).toBeInstanceOf(IntegrationFailure)
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.message).toContain("originally starts at 2026-10-09")
    expect(lines().every((line) => line.startsWith(`GET /calendars/primary/events/${SERIES}/instances`))).toBe(true)
  })

  it("stops looking after its page budget", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        items: [{ id: "other", originalStartTime: { date: "2026-01-01" } }],
        nextPageToken: "more"
      })
    )
    const failure = await rejected(
      runAction(Actions.PatchEvent, {
        calendarId: "primary",
        eventId: SERIES,
        originalStart: { dateTime: "2026-10-09T16:00:00Z" },
        patch: { summary: "Moved" }
      })
    )
    expect(failure.message).toContain("originally starts at 2026-10-09T16:00:00Z")
    // Ten pages per attempt, and the engine may repeat the attempt.
    expect(lines().length % 10).toBe(0)
    expect(lines().some((line) => line.startsWith("PATCH"))).toBe(false)
  })
})

describe("CancelEvent", () => {
  it("deletes the event and reports it was not already cancelled", async () => {
    fixture = await startFixture((_request, response) => noContent(response))
    const cancelled = await runAction(Actions.CancelEvent, {
      calendarId: "primary",
      eventId: EVENT_ID,
      sendUpdates: "all"
    })
    expect(cancelled).toEqual({
      calendarId: "primary",
      eventId: EVENT_ID,
      externalId: `primary/${EVENT_ID}`,
      alreadyCancelled: false
    })
    expect(lines()).toEqual([`DELETE /calendars/primary/events/${EVENT_ID}?sendUpdates=all`])
  })

  it("treats 410 Gone as already cancelled", async () => {
    fixture = await startFixture((_request, response) => googleError(response, 410, "deleted"))
    const cancelled = await runAction(Actions.CancelEvent, {
      calendarId: "primary",
      eventId: EVENT_ID
    })
    expect(cancelled.alreadyCancelled).toBe(true)
    expect(lines()).toHaveLength(1)
  })

  it("does not delete an occurrence that is already cancelled", async () => {
    const instanceId = `${SERIES}_20261009`
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        items: [{ id: instanceId, status: "cancelled", originalStartTime: { date: "2026-10-09" } }]
      })
    )
    const cancelled = await runAction(Actions.CancelEvent, {
      calendarId: "primary",
      eventId: SERIES,
      originalStart: { date: "2026-10-09" }
    })
    expect(cancelled).toMatchObject({ eventId: instanceId, alreadyCancelled: true })
    const query = new URL((fixture.requests[0] as Recorded).url, "http://fixture").searchParams
    expect(query.get("timeMin")).toBe("2026-10-02T00:00:00.000Z")
    expect(lines().some((line) => line.startsWith("DELETE"))).toBe(false)
  })

  it("deletes only the named occurrence of a live series", async () => {
    const instanceId = `${SERIES}_20261009T160000Z`
    fixture = await startFixture((request, response) =>
      request.method === "DELETE"
        ? noContent(response)
        : json(response, 200, {
          items: [{ id: instanceId, status: "confirmed", originalStartTime: { dateTime: "2026-10-09T16:00:00Z" } }]
        })
    )
    const cancelled = await runAction(Actions.CancelEvent, {
      calendarId: "primary",
      eventId: SERIES,
      originalStart: { dateTime: "2026-10-09T09:00:00-07:00", timeZone: "America/Los_Angeles" }
    })
    expect(cancelled).toMatchObject({ eventId: instanceId, alreadyCancelled: false })
    expect(lines()[1]).toBe(`DELETE /calendars/primary/events/${instanceId}?sendUpdates=none`)
  })

  it("reports any other refusal as a typed failure", async () => {
    fixture = await startFixture((_request, response) => googleError(response, 403, "forbidden"))
    const failure = await rejected(runAction(Actions.CancelEvent, { calendarId: "primary", eventId: EVENT_ID }))
    expect(failure).toBeInstanceOf(IntegrationFailure)
    expect(failure.reason).toBe("permission-denied")
  })
})

describe("FreeBusy", () => {
  it("answers each calendar's busy intervals, with and without a time zone", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        calendars: {
          primary: { busy: [{ start: "2026-10-02T16:00:00Z", end: "2026-10-02T16:30:00Z" }] },
          "team@group.calendar.example.test": { errors: [{ reason: "notFound" }] }
        }
      })
    )
    const window = { timeMin: "2026-10-02T00:00:00Z", timeMax: "2026-10-03T00:00:00Z" }
    const zoned = await runAction(Actions.FreeBusy, {
      ...window,
      calendarIds: ["primary", "team@group.calendar.example.test"],
      timeZone: "America/Los_Angeles"
    })
    expect(zoned.calendars).toEqual([
      {
        calendarId: "primary",
        busy: [{
          start: "2026-10-02T16:00:00Z",
          end: "2026-10-02T16:30:00Z",
          startMs: Date.parse("2026-10-02T16:00:00Z"),
          endMs: Date.parse("2026-10-02T16:30:00Z")
        }],
        errors: []
      },
      { calendarId: "team@group.calendar.example.test", busy: [], errors: ["notFound"] }
    ])
    await runAction(Actions.FreeBusy, { ...window, calendarIds: ["primary"] })
    const bodies = fixture.requests.map((request) => JSON.parse(request.body))
    expect(bodies[0].timeZone).toBe("America/Los_Angeles")
    expect(bodies[1]).toEqual({ ...window, items: [{ id: "primary" }] })
  })

  it("reports a refused query as a typed failure", async () => {
    fixture = await startFixture((_request, response) => googleError(response, 400, "badRequest"))
    const failure = await rejected(
      runAction(Actions.FreeBusy, {
        timeMin: "2026-10-02T00:00:00Z",
        timeMax: "2026-10-03T00:00:00Z",
        calendarIds: ["primary"]
      })
    )
    expect(failure).toBeInstanceOf(IntegrationFailure)
  })
})
