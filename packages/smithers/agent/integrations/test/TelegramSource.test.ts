import { Effect, Layer, Schedule, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { CursorStore, layerMemory } from "../src/core/CursorStore.ts"
import type { ExternalEvent } from "../src/core/ExternalEvent.ts"
import * as Payload from "../src/telegram/Payload.ts"
import {
  CALLBACK_QUERY_EVENT,
  chatCorrelationId,
  EDITED_MESSAGE_EVENT,
  idempotencyKey,
  make,
  MESSAGE_EVENT,
  threadCorrelationId,
  updateToEvents,
  WEB_APP_DATA_EVENT
} from "../src/telegram/Source.ts"
import { make as makeClient, type TelegramClient } from "../src/telegram/TelegramClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

const TOKEN = "123456:AA-bot-token"
const NOW = 1_700_000_000_000

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const message = (overrides: Record<string, unknown> = {}) => ({
  message_id: 1,
  date: 1,
  chat: { id: -100 },
  text: "hello",
  ...overrides
})

describe("updateToEvents", () => {
  it("emits a chat-scoped message event", () => {
    expect(updateToEvents("telegram", { update_id: 7, message: message() }, NOW)).toEqual([{
      source: "telegram",
      eventName: MESSAGE_EVENT,
      correlationId: chatCorrelationId(-100),
      payload: message(),
      dedupeKey: "update:8:telegram:7",
      receivedAtMs: NOW
    }])
  })

  // `update_id` is scoped per bot, so two configured sources routinely produce
  // the same number. `SignalName.toNotification` uses the dedupe key as the
  // durable notification id, so an unscoped key drops the second bot's event.
  it("scopes the dedupe key to the source, so two bots cannot collide", () => {
    const update = { update_id: 7, message: message() }
    const [first] = updateToEvents("telegram", update, NOW)
    const [second] = updateToEvents("telegram-ops", update, NOW)
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey)
    // Length-prefixed, so a source id carrying the delimiter cannot forge
    // another source's key.
    expect(updateToEvents("a:b", update, NOW)[0]?.dedupeKey)
      .not.toBe(updateToEvents("a", { ...update, update_id: "b:7" as never }, NOW)[0]?.dedupeKey)
  })

  // One delivered event carries one correlation, and each variant dedupes on
  // its own key, so a redelivery cannot double-signal either listener.
  it("adds a thread-scoped variant with its own dedupe key", () => {
    const events = updateToEvents("telegram", {
      update_id: 7,
      message: message({ message_thread_id: 5 })
    }, NOW)
    expect(events.map((event) => [event.correlationId, event.dedupeKey])).toEqual([
      [chatCorrelationId(-100), "update:8:telegram:7"],
      [threadCorrelationId(-100, 5), "update:8:telegram:7:thread"]
    ])
  })

  it("emits a separately deduped Mini App data event alongside the message", () => {
    const events = updateToEvents("telegram", {
      update_id: 7,
      message: message({ web_app_data: { data: "{}" }, message_thread_id: 5 })
    }, NOW)
    expect(events.map((event) => [event.eventName, event.dedupeKey])).toEqual([
      [MESSAGE_EVENT, "update:8:telegram:7"],
      [MESSAGE_EVENT, "update:8:telegram:7:thread"],
      [WEB_APP_DATA_EVENT, "update:8:telegram:7:webappdata"],
      [WEB_APP_DATA_EVENT, "update:8:telegram:7:webappdata:thread"]
    ])
  })

  it("names an edited message differently", () => {
    const events = updateToEvents("telegram", { update_id: 8, edited_message: message() }, NOW)
    expect(events.map((event) => event.eventName)).toEqual([EDITED_MESSAGE_EVENT])
  })

  it("carries a callback query's chat and thread when it has them", () => {
    const query = { id: "q", data: "sap:t:a", message: { chat: { id: -100 }, message_thread_id: 5 } }
    const events = updateToEvents("telegram", { update_id: 9, callback_query: query }, NOW)
    expect(events.map((event) => [event.eventName, event.correlationId, event.dedupeKey])).toEqual([
      [CALLBACK_QUERY_EVENT, chatCorrelationId(-100), "update:8:telegram:9"],
      [CALLBACK_QUERY_EVENT, threadCorrelationId(-100, 5), "update:8:telegram:9:thread"]
    ])
  })

  it("emits an uncorrelated callback query when the message is inaccessible", () => {
    const events = updateToEvents("telegram", { update_id: 9, callback_query: { id: "q" } }, NOW)
    expect(events[0]?.correlationId).toBeNull()
  })

  it("drops a message with no chat, and an update of a kind it does not handle", () => {
    expect(updateToEvents("telegram", { update_id: 1, message: { message_id: 1 } }, NOW)).toEqual([])
    expect(updateToEvents("telegram", { update_id: 1, poll: {} }, NOW)).toEqual([])
  })
})

const source = (options: Partial<Parameters<typeof make>[0]> = {}) =>
  make({
    allowedChatIds: [-100],
    client: makeClient({ botToken: TOKEN, apiBaseUrl: (fixture as Fixture).origin }),
    ...options
  })

const runWithCursors = <A, E>(effect: Effect.Effect<A, E, CursorStore>, layer = layerMemory) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

describe("source authorization", () => {
  it.each([[undefined], [[]]])("refuses to start with allowedChatIds %s", async (allowedChatIds) => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    expect(() => source({ allowedChatIds } as never)).toThrow(/allowedChatIds.*non-empty/)
    expect(fixture.requests).toHaveLength(0)
  })
})

describe("poll", () => {
  it("sends the Bot API long-poll parameters and the stored offset", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    await Effect.runPromise(source().poll("41"))
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).toEqual({
      timeout: 25,
      allowed_updates: ["message", "edited_message", "callback_query"],
      offset: 41
    })
  })

  it("omits the offset for a source that has never polled", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    await Effect.runPromise(source().poll(null))
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).not.toHaveProperty("offset")
  })

  it("proposes the acknowledgement offset as last update_id plus one", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        ok: true,
        result: [{ update_id: 10, message: message() }, { update_id: 12, message: message() }]
      })
    )
    const batch = await Effect.runPromise(source().poll(null))
    expect(batch.events).toHaveLength(2)
    expect(batch.cursor).toBe("13")
  })

  // An update with no numeric `update_id` cannot be acknowledged, so reading
  // it as an empty batch would poll the same broken batch forever.
  it("refuses an update with no numeric update_id rather than skipping it", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [{ no_id: true }] }))
    const failure = await Effect.runPromise(Effect.flip(source().poll(null)))
    expect(failure.reason).toBe("decode-failed")
    expect(failure.details).toMatchObject({ index: 0, sourceId: "telegram" })
  })

  // A Bot API contract change read as "no updates" looks like a healthy idle
  // poll forever, which is the worst possible way to be broken.
  it("refuses a result that is not an update array", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: true }))
    const failure = await Effect.runPromise(Effect.flip(source().poll(null)))
    expect(failure.reason).toBe("decode-failed")
    expect(failure.message).toContain("not an update array")
    expect(failure.details).toMatchObject({ resultType: "boolean" })
  })

  // `typeof null` is "object", which would have named the one malformed answer
  // an operator is most likely to see after the one shape it is not.
  it("names a null result as null rather than as an object", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: null }))
    const failure = await Effect.runPromise(Effect.flip(source().poll(null)))
    expect(failure.reason).toBe("decode-failed")
    expect(failure.details).toMatchObject({ resultType: "null" })
  })

  // A cursor that does not parse used to be dropped, which sent getUpdates
  // with no offset and replayed Telegram's whole retained backlog.
  it("refuses a corrupt stored cursor instead of replaying the backlog", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    for (const cursor of ["not-a-number", "-1", "1.5"]) {
      const failure = await Effect.runPromise(Effect.flip(source().poll(cursor)))
      expect(failure.reason).toBe("invalid-config")
      expect(failure.details).toMatchObject({ cursor })
    }
    expect(fixture.requests).toHaveLength(0)
  })

  // The offset still advances past a dropped update, or the source would
  // re-poll it forever.
  it("drops updates from chats outside the allow list but still advances past them", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        ok: true,
        result: [
          { update_id: 1, message: message({ chat: { id: -999 } }) },
          { update_id: 2, message: message() }
        ]
      })
    )
    const batch = await Effect.runPromise(source({ allowedChatIds: [-100] }).poll(null))
    expect(batch.events).toHaveLength(1)
    expect(batch.cursor).toBe("3")
  })

  // An allowlist that admits what it cannot classify is not one. A press on an
  // inline keyboard whose message is inaccessible is exactly that case.
  it("drops an update whose chat it cannot determine when an allow list is set", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        ok: true,
        result: [{ update_id: 4, callback_query: { id: "q", data: "sap:t:a" } }]
      })
    )
    const batch = await Effect.runPromise(source({ allowedChatIds: [-100] }).poll(null))
    expect(batch.events).toEqual([])
    // The offset still advances, or the source re-polls the same update forever.
    expect(batch.cursor).toBe("5")
  })

  it("drops unclassifiable updates with the required allowlist", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { ok: true, result: [{ update_id: 4, callback_query: { id: "q" } }] })
    )
    expect((await Effect.runPromise(source().poll(null))).events).toHaveLength(0)
  })

  it("takes an explicit source id, timeout, and allowed updates", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { ok: true, result: [{ update_id: 1, message: message() }] })
    )
    const batch = await Effect.runPromise(
      source({ sourceId: "telegram-ops", pollTimeoutSeconds: 5, allowedUpdates: ["message"] }).poll(null)
    )
    expect(batch.events[0]?.source).toBe("telegram-ops")
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).toMatchObject({ timeout: 5, allowed_updates: ["message"] })
  })

  it("classifies a Bot API failure as poll-failed and names the source", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 401, { ok: false, error_code: 401, description: "Unauthorized" })
    )
    const failure = await Effect.runPromise(Effect.flip(source().poll(null)))
    expect(failure.reason).toBe("poll-failed")
    expect(failure.details).toMatchObject({ sourceId: "telegram" })
  })

  it("builds its own client from a bot token when given no client", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    await Effect.runPromise(make({ allowedChatIds: [-100], botToken: TOKEN, apiBaseUrl: fixture.origin }).poll(null))
    expect(fixture.requests[0]?.url).toBe(`/bot${TOKEN}/getUpdates`)
  })

  // Every doc names SMITHERS_TELEGRAM_BOT_TOKEN as the source a Telegram
  // source reads. It has to actually read it.
  it("takes the bot token from the environment it was built with", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    await Effect.runPromise(
      make({ allowedChatIds: [-100], apiBaseUrl: fixture.origin }, { SMITHERS_TELEGRAM_BOT_TOKEN: TOKEN }).poll(null)
    )
    expect(fixture.requests[0]?.url).toBe(`/bot${TOKEN}/getUpdates`)
  })

  it("refuses to build when neither the config nor the environment has a token", () => {
    expect(() => make({ allowedChatIds: [-100], apiBaseUrl: "https://example.invalid" }, {}))
      .toThrow(/SMITHERS_TELEGRAM_BOT_TOKEN/)
  })
})

describe("run", () => {
  it.each([
    { schedule: Schedule.forever.pipe(Schedule.upTo({ times: 0 })), polls: 1 },
    { schedule: Schedule.recurs(1), polls: 2 }
  ])("succeeds with undefined when a finite schedule ends after $polls polls", async ({ schedule, polls }) => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    const result = await runWithCursors(
      source().run(() => Effect.void, { schedule })
    )
    expect(fixture.requests).toHaveLength(polls)
    expect(fixture.requests[0]?.url).toBe(`/bot${TOKEN}/getUpdates`)
    expect(result).toBeUndefined()
  })

  it("commits the offset only after the handler succeeded", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { ok: true, result: [{ update_id: 10, message: message() }] })
    )
    const handled: Array<ReadonlyArray<ExternalEvent>> = []
    const cursor = await runWithCursors(Effect.gen(function*() {
      const store = yield* CursorStore
      yield* Effect.timeout(
        source().run((events) => Effect.sync(() => handled.push(events)), { schedule: Schedule.spaced("5 millis") }),
        "120 millis"
      ).pipe(Effect.catchCause(() => Effect.void))
      return yield* store.get("telegram")
    }))
    expect(handled.length).toBeGreaterThan(0)
    expect(cursor).toBe("11")
  })

  // If a failed handler still advanced the offset, Telegram would forget the
  // batch and the events would be lost.
  it("leaves the offset alone when the handler fails", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { ok: true, result: [{ update_id: 10, message: message() }] })
    )
    const cursor = await runWithCursors(Effect.gen(function*() {
      const store = yield* CursorStore
      yield* source().run(() => Effect.fail("handler failed" as const)).pipe(Effect.catchCause(() => Effect.void))
      return yield* store.get("telegram")
    }))
    expect(cursor).toBeNull()
  })

  it("resumes from the stored offset", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    await runWithCursors(Effect.gen(function*() {
      const store = yield* CursorStore
      yield* store.set("telegram", "500")
      yield* Effect.timeout(
        source().run(() => Effect.void, { schedule: Schedule.spaced("5 millis") }),
        "60 millis"
      ).pipe(Effect.catchCause(() => Effect.void))
    }))
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}").offset).toBe(500)
  })

  // One network blip or Bot API 5xx used to end `run` for good, so the bot
  // stopped receiving messages until the host restarted it.
  it("keeps polling after a transient getUpdates failure", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls++
      if (calls === 1) {
        response.socket?.destroy()
        return
      }
      json(response, 200, { ok: true, result: [{ update_id: calls, message: message() }] })
    })
    const handled: Array<ReadonlyArray<ExternalEvent>> = []
    await runWithCursors(
      source().run((events) => Effect.sync(() => handled.push(events)), { schedule: Schedule.recurs(1) })
    )
    expect(fixture.requests.length).toBeGreaterThanOrEqual(2)
    expect(handled.length).toBe(2)
  })

  it("keeps polling after a Bot API 502", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls++
      if (calls === 1) return json(response, 502, { ok: false, error_code: 502, description: "Bad Gateway" })
      json(response, 200, { ok: true, result: [] })
    })
    await runWithCursors(source().run(() => Effect.void, { schedule: Schedule.recurs(0) }))
    expect(fixture.requests).toHaveLength(2)
  })

  it("retries a failure from an injected client that is not a Bot API error", async () => {
    let calls = 0
    const client = {
      call: () => {
        calls++
        return calls === 1 ? Effect.fail(new Error("socket hang up")) : Effect.succeed([])
      }
    } as unknown as TelegramClient
    await runWithCursors(
      make({ allowedChatIds: [-100], client }).run(() => Effect.void, { schedule: Schedule.recurs(0) })
    )
    expect(calls).toBe(2)
  })

  it("stops on a permanent getUpdates failure", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 401, { ok: false, error_code: 401, description: "Unauthorized" })
    )
    const exit = await Effect.runPromise(
      Effect.exit(source().run(() => Effect.void).pipe(Effect.provide(layerMemory as Layer.Layer<CursorStore>)))
    )
    expect(exit._tag).toBe("Failure")
    expect(fixture.requests).toHaveLength(1)
  })

  it("stops when the fiber is interrupted", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.timeout(source().run(() => Effect.void, { schedule: Schedule.spaced("5 millis") }), "60 millis")
          .pipe(Effect.provide(layerMemory as Layer.Layer<CursorStore>))
      )
    )
    expect(exit._tag).toBe("Failure")
    // Let any poll that was already in flight settle, then prove the loop is
    // not still turning.
    await Effect.runPromise(Effect.sleep("100 millis"))
    const settled = fixture.requests.length
    await Effect.runPromise(Effect.sleep("150 millis"))
    expect(fixture.requests.length).toBe(settled)
  })
})

describe("payload schemas", () => {
  const decodeWith = <A>(schema: Schema.Schema<A>, value: unknown) =>
    Effect.runPromise(Effect.exit(Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<A, unknown>))

  const full = {
    message_id: 1,
    date: 2,
    chat: { id: -100, type: "supergroup", title: "ops", username: "ops" },
    from: { id: 7, is_bot: false, first_name: "Will", last_name: "C", username: "will" },
    text: "hello",
    caption: "c",
    message_thread_id: 5,
    is_topic_message: true,
    reply_to_message: { message_id: 0 },
    photo: [{ file_id: "p" }],
    document: { file_id: "d", file_name: "a.txt" },
    unheard_of: true
  }

  it("types a message and keeps unmodelled Bot API fields", async () => {
    const exit = await decodeWith(Payload.Message, full)
    expect(exit._tag).toBe("Success")
    expect(exit._tag === "Success" ? exit.value : undefined).toHaveProperty("unheard_of", true)
  })

  it("types a callback query, a Mini App message, and the raw web_app_data", async () => {
    expect(
      (await decodeWith(Payload.CallbackQuery, {
        id: "q",
        from: { id: 7 },
        data: "sap:t:a",
        message: full
      }))._tag
    ).toBe("Success")
    expect((await decodeWith(Payload.WebAppData, { data: "{}", button_text: "Send" }))._tag).toBe("Success")
    expect(
      (await decodeWith(Payload.WebAppDataMessage, {
        message_id: 1,
        date: 2,
        chat: { id: -100 },
        web_app_data: { data: "{}" }
      }))._tag
    ).toBe("Success")
  })

  it("still rejects a modelled field of the wrong type", async () => {
    expect((await decodeWith(Payload.Message, { ...full, message_id: "one" }))._tag).toBe("Failure")
    expect((await decodeWith(Payload.Chat, { id: "-100" }))._tag).toBe("Failure")
    expect((await decodeWith(Payload.User, { id: 7 }))._tag).toBe("Success")
  })
})

describe("idempotencyKey", () => {
  // A long poll has no `Channels.ingest` in front of it, but a host routing
  // these events through the control plane needs the same delivery identity
  // the webhook providers supply.
  it("is the event's source-scoped dedupe key", () => {
    const [event] = updateToEvents("telegram", { update_id: 7, message: message() }, NOW)
    expect(idempotencyKey(event as ExternalEvent)).toBe(event?.dedupeKey)
    const [other] = updateToEvents("telegram-ops", { update_id: 7, message: message() }, NOW)
    expect(idempotencyKey(event as ExternalEvent)).not.toBe(idempotencyKey(other as ExternalEvent))
  })
})

describe("the poll refuses what it cannot read", () => {
  // `Number()` accepts "", "0x10", and " 7 ", so a corrupt cursor could
  // silently skip or replay updates instead of failing before the request.
  it("accepts only a canonical decimal offset", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: [] }))
    for (const cursor of ["", "0x10", " 7 ", "1e3", "+7"]) {
      const failure = await Effect.runPromise(Effect.flip(source().poll(cursor)))
      expect(failure.reason).toBe("invalid-config")
    }
    expect(fixture.requests).toHaveLength(0)
    await Effect.runPromise(source().poll("41"))
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}").offset).toBe(41)
  })

  // `update["message"] !== undefined` is true for `null`, and updateToEvents
  // then reads through it and throws, which dies as a defect.
  it("refuses an update member that is not an object rather than dying", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { ok: true, result: [{ update_id: 1, message: null }] })
    )
    const failure = await Effect.runPromise(Effect.flip(source().poll(null)))
    expect(failure.reason).toBe("decode-failed")
    expect(failure.details).toMatchObject({ member: "message", index: 0 })
  })

  // The source id is every event's `source` and the scope of every dedupe key.
  it("refuses a source id that would make an unusable event", () => {
    for (const sourceId of ["", "   ", " telegram"]) {
      expect(() => make({ allowedChatIds: [-100], sourceId, botToken: TOKEN, apiBaseUrl: "https://example.invalid" }))
        .toThrow(/source id must be a non-empty string/)
    }
  })
})
