/**
 * The Slack conversation change feed, against a real `node:http` Slack
 * stand-in and the in-memory `SourceStore`.
 *
 * The fixture implements the slice of Slack the feed depends on:
 * `conversations.history` answers newest first, keeps only messages strictly
 * after `oldest`, and pages with an opaque `next_cursor`;
 * `conversations.replies` answers the root and then its replies after
 * `oldest`, oldest first, and refuses an unknown root `thread_not_found`.
 */
import { Effect, Exit, Option } from "effect"
import type { ServerResponse } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import type { SourceRecord } from "../src/core/SourceRecord.ts"
import { layerMemory, SourceStore } from "../src/core/SourceStore.ts"
import { runSync } from "../src/core/Sync.ts"
import { make as makeClient } from "../src/slack/SlackClient.ts"
import {
  accessScope,
  channelTypeOf,
  compareTs,
  CursorState,
  eventChannelType,
  eventRecord,
  externalId,
  make,
  messageRecord,
  messageUrl,
  msToTs,
  type Options,
  tombstone,
  tsToMs
} from "../src/slack/Sync.ts"
import { type ApiCall, ok, refuse, type SlackFixture, startSlackFixture } from "./SlackFixture.ts"

const CONNECTION = "team-chat"
const CHANNEL = "C0GENERAL"
const WORKSPACE = "https://example-team.slack.test"

/** Seconds an hour ago, so every fixture thread is inside the default window. */
const BASE = Math.floor(Date.now() / 1000) - 3600
const ts = (offset: number) => `${BASE + offset}.000100`

type Message = Record<string, unknown> & { readonly ts: string }

const message = (offset: number, overrides: Record<string, unknown> = {}): Message => ({
  type: "message",
  user: "U0AUTHOR",
  text: `message ${offset}`,
  ts: ts(offset),
  ...overrides
})

interface State {
  /** The `conversations.info` channel object, or `undefined` to answer without one. */
  info: Record<string, unknown> | undefined
  history: Array<Message>
  /** Replies by root ts. A root absent here is `thread_not_found`. */
  replies: Map<string, Array<Message>>
  /** Refuse the next paged history request `invalid_cursor`. */
  expireCursor: boolean
  /** A Slack error code to refuse every history request with. */
  historyError: string | undefined
  /** A Slack error code to refuse every replies request with. */
  repliesError: string | undefined
  /** A raw `messages` value to answer history with, bypassing the listing. */
  historyMessages: unknown
  /** A raw `messages` value to answer replies with, bypassing the listing. */
  repliesMessages: unknown
}

const initial = (overrides: Partial<State> = {}): State => ({
  info: { id: CHANNEL, is_private: false },
  history: [],
  replies: new Map(),
  expireCursor: false,
  historyError: undefined,
  repliesError: undefined,
  historyMessages: undefined,
  repliesMessages: undefined,
  ...overrides
})

const after = (oldest: string | undefined) => (entry: Message) =>
  oldest === undefined || compareTs(entry.ts, oldest) > 0

/** One page of `items` at the offset `cursor` names, with the next cursor while more remain. */
const page = (items: ReadonlyArray<Message>, call: ApiCall) => {
  const limit = Number(call.params["limit"])
  const offset = call.params["cursor"] === undefined ? 0 : Number(call.params["cursor"].replace(/^page-/, ""))
  const next = offset + limit < items.length ? `page-${offset + limit}` : ""
  return { messages: items.slice(offset, offset + limit), response_metadata: { next_cursor: next } }
}

let fixture: SlackFixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const serve = async (state: State): Promise<SlackFixture> => {
  fixture = await startSlackFixture((call, response: ServerResponse) => {
    if (call.method === "conversations.info") {
      return state.info === undefined ? ok(response) : ok(response, { channel: state.info })
    }
    if (call.method === "conversations.history") {
      if (state.historyError !== undefined) return refuse(response, state.historyError)
      if (state.expireCursor && call.params["cursor"] !== undefined) {
        state.expireCursor = false
        return refuse(response, "invalid_cursor")
      }
      if (state.historyMessages !== undefined) return ok(response, { messages: state.historyMessages })
      const listed = state.history.filter(after(call.params["oldest"]))
        .sort((left, right) => compareTs(right.ts, left.ts))
      return ok(response, page(listed, call))
    }
    if (call.method === "conversations.replies") {
      if (state.repliesError !== undefined) return refuse(response, state.repliesError)
      if (state.repliesMessages !== undefined) return ok(response, { messages: state.repliesMessages })
      const root = call.params["ts"] as string
      const replies = state.replies.get(root)
      const parent = state.history.find((entry) => entry.ts === root)
      if (replies === undefined || parent === undefined) return refuse(response, "thread_not_found")
      const listed = [parent, ...replies.filter(after(call.params["oldest"]))]
      return ok(response, page(listed, call))
    }
    return refuse(response, "unknown_method")
  })
  return fixture
}

const adapterFor = (server: SlackFixture, options: Partial<Options> = {}) =>
  make({
    connectionId: CONNECTION,
    channel: CHANNEL,
    client: makeClient({ botToken: "xoxb-fixture-bot-token", apiBaseUrl: server.apiBaseUrl, retryBaseDelay: 0 }, {}),
    workspaceUrl: WORKSPACE,
    ...options
  })

const run = <A, E>(effect: Effect.Effect<A, E, SourceStore>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layerMemory)))

const failure = async (effect: Effect.Effect<unknown, IntegrationError>): Promise<IntegrationError> => {
  const error = Exit.findErrorOption(await Effect.runPromise(Effect.exit(effect)))
  if (error._tag === "None") throw new Error("expected a typed failure")
  return error.value
}

const stored = (id: string) =>
  Effect.flatMap(SourceStore, (store) => store.get(CONNECTION, externalId(CHANNEL, id))).pipe(
    Effect.map(Option.map((found) => found.record)),
    Effect.map(Option.getOrUndefined)
  )

const cursorOf = (cursor: string | null): CursorState => {
  if (cursor === null) throw new Error("expected a cursor")
  return JSON.parse(cursor) as CursorState
}

const calls = (server: SlackFixture, method: string) => server.calls.filter((call) => call.method === method)

describe("conversation types and timestamps", () => {
  it("maps each conversation type to the access scope it grants", () => {
    expect(accessScope("public")).toBe("workspace")
    expect(accessScope("private")).toBe("container")
    expect(accessScope("im")).toBe("private")
    expect(accessScope("mpim")).toBe("private")
  })

  it("reads the type of a conversations.info channel, direct messages first", () => {
    expect(channelTypeOf({ is_im: true, is_private: true })).toBe("im")
    expect(channelTypeOf({ is_mpim: true, is_private: true })).toBe("mpim")
    expect(channelTypeOf({ is_private: true })).toBe("private")
    expect(channelTypeOf({})).toBe("public")
  })

  it("reads only the channel types Slack documents from an event", () => {
    expect(eventChannelType("channel")).toBe("public")
    expect(eventChannelType("group")).toBe("private")
    expect(eventChannelType("im")).toBe("im")
    expect(eventChannelType("mpim")).toBe("mpim")
    expect(eventChannelType("toString")).toBeUndefined()
    expect(eventChannelType(7)).toBeUndefined()
  })

  it("converts between Slack timestamps and milliseconds", () => {
    expect(tsToMs("1700000000.123456")).toBe(1_700_000_000_123)
    expect(tsToMs("1700000000.5")).toBe(1_700_000_000_500)
    expect(msToTs(1_700_000_000_123)).toBe("1700000000.123000")
    expect(msToTs(1_700_000_000_007)).toBe("1700000000.007000")
    expect(compareTs(msToTs(1_700_000_000_123), "1700000000.123456")).toBe(-1)
  })

  it("orders timestamps one microsecond apart, and by seconds first", () => {
    expect(compareTs("1700000000.000002", "1700000000.000001")).toBe(1)
    expect(compareTs("1700000000.000001", "1700000000.000002")).toBe(-1)
    expect(compareTs("1700000000.5", "1700000000.500000")).toBe(0)
    expect(compareTs("1700000001.000000", "1700000000.999999")).toBe(1)
    expect(compareTs("999999999.9", "1000000000.1")).toBe(-1)
  })

  it("links a message, and a reply through its thread, only with a workspace URL", () => {
    expect(messageUrl(undefined, CHANNEL, "1700000000.000100")).toBeNull()
    expect(messageUrl(`${WORKSPACE}//`, CHANNEL, "1700000000.000100")).toBe(
      `${WORKSPACE}/archives/${CHANNEL}/p1700000000000100`
    )
    expect(messageUrl(WORKSPACE, CHANNEL, "1700000000.000100", "1700000000.000100")).toBe(
      `${WORKSPACE}/archives/${CHANNEL}/p1700000000000100`
    )
    expect(messageUrl(WORKSPACE, CHANNEL, "1700000009.000100", "1700000000.000100")).toBe(
      `${WORKSPACE}/archives/${CHANNEL}/p1700000009000100?thread_ts=1700000000.000100&cid=${CHANNEL}`
    )
  })
})

describe("messageRecord", () => {
  const context = {
    connectionId: CONNECTION,
    channel: CHANNEL,
    channelType: "private" as const,
    retrievedAtMs: 1_700_000_100_000,
    workspaceUrl: WORKSPACE
  }

  it("keys a root message by channel and ts, and versions it by its own ts", () => {
    const record = messageRecord(
      { ts: "1700000000.000100", user: "U0AUTHOR", username: "builder", text: "hello" },
      context
    )
    expect(record).toEqual({
      provider: "slack",
      connectionId: CONNECTION,
      externalId: `${CHANNEL}:1700000000.000100`,
      kind: "message",
      url: `${WORKSPACE}/archives/${CHANNEL}/p1700000000000100`,
      author: { id: "U0AUTHOR", label: "builder" },
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      version: "1700000000.000100",
      retrievedAtMs: 1_700_000_100_000,
      access: { scope: "container", containerId: CHANNEL },
      thread: { containerId: CHANNEL, threadId: null, parentId: null },
      text: "hello",
      deleted: false,
      payload: { ts: "1700000000.000100", user: "U0AUTHOR", username: "builder", text: "hello" }
    })
  })

  it("versions an edited message by its edit, and names a bot author without a label", () => {
    const record = messageRecord(
      { ts: "1700000000.000100", bot_id: "B0HELPER", text: 7, edited: { user: "U0AUTHOR", ts: "1700000050.000000" } },
      context
    )
    expect(record).toMatchObject({
      author: { id: "B0HELPER", label: null },
      version: "1700000050.000000",
      updatedAtMs: 1_700_000_050_000,
      text: ""
    })
  })

  it("ignores an edit marker without a valid ts, and a message without an author", () => {
    const record = messageRecord({ ts: "1700000000.000100", edited: { ts: "yesterday" } }, context)
    expect(record).toMatchObject({ author: null, version: "1700000000.000100" })
  })

  it("threads a root under itself and a reply under its root", () => {
    const root = messageRecord({ ts: "1700000000.000100", thread_ts: "1700000000.000100" }, context)
    expect(root.thread).toEqual({
      containerId: CHANNEL,
      threadId: `${CHANNEL}:1700000000.000100`,
      parentId: null
    })
    const reply = messageRecord({ ts: "1700000009.000100", thread_ts: "1700000000.000100" }, context)
    expect(reply.thread).toEqual({
      containerId: CHANNEL,
      threadId: `${CHANNEL}:1700000000.000100`,
      parentId: `${CHANNEL}:1700000000.000100`
    })
    expect(reply.url).toContain("?thread_ts=1700000000.000100")
  })

  it("maps a history tombstone to a deletion versioned when it was retrieved", () => {
    const record = messageRecord({ ts: "1700000000.000100", subtype: "tombstone", text: "gone" }, context)
    expect(record).toMatchObject({
      externalId: `${CHANNEL}:1700000000.000100`,
      deleted: true,
      text: "",
      payload: null,
      url: null,
      author: null,
      version: "1700000100.000000",
      updatedAtMs: 1_700_000_100_000
    })
  })

  it("gives a record of unknown conversation type the narrowest scope", () => {
    expect(messageRecord({ ts: "1700000000.000100" }, { ...context, channelType: undefined }).access).toEqual({
      scope: "private",
      containerId: CHANNEL
    })
    expect(tombstone("1700000000.000100", "1700000001.000000", { ...context, channelType: "public" }).access)
      .toEqual({ scope: "workspace", containerId: CHANNEL })
  })
})

describe("eventRecord", () => {
  const callback = (event: Record<string, unknown>) => ({
    type: "event_callback",
    team_id: "T0TEAM",
    event_id: "Ev0001",
    event
  })
  const context = { connectionId: CONNECTION, retrievedAtMs: 1_700_000_100_000 }

  it("ignores a delivery that is not an event callback, or not a message event", () => {
    expect(eventRecord({ type: "url_verification", challenge: "x" }, context)).toBeUndefined()
    expect(eventRecord(callback({ type: "reaction_added", user: "U0AUTHOR" }), context)).toBeUndefined()
  })

  it("records a new message with the event's own conversation type", () => {
    const record = eventRecord(
      callback({ type: "message", channel: "D0DIRECT", channel_type: "im", user: "U0AUTHOR", text: "hi", ts: ts(1) }),
      { ...context, channelType: "public", workspaceUrl: WORKSPACE }
    )
    expect(record).toMatchObject({
      externalId: `D0DIRECT:${ts(1)}`,
      access: { scope: "private", containerId: "D0DIRECT" },
      text: "hi",
      url: expect.stringContaining("/archives/D0DIRECT/")
    })
  })

  it("falls back to the configured conversation type when the event names none Slack documents", () => {
    const record = eventRecord(
      callback({ type: "message", channel: CHANNEL, channel_type: "board", user: "U0AUTHOR", ts: ts(1) }),
      { ...context, channelType: "public" }
    )
    expect(record?.access).toEqual({ scope: "workspace", containerId: CHANNEL })
  })

  it("records an edit as a newer version of the same message", () => {
    const record = eventRecord(
      callback({
        type: "message",
        subtype: "message_changed",
        channel: CHANNEL,
        channel_type: "channel",
        ts: ts(9),
        message: { type: "message", user: "U0AUTHOR", text: "fixed", ts: ts(1), edited: { ts: ts(9) } }
      }),
      context
    )
    expect(record).toMatchObject({ externalId: `${CHANNEL}:${ts(1)}`, version: ts(9), text: "fixed" })
    expect(
      eventRecord(callback({ type: "message", subtype: "message_changed", channel: CHANNEL, ts: ts(9) }), context)
    ).toBeUndefined()
  })

  it("records a deletion as a tombstone at the deletion's time", () => {
    const deletion = {
      type: "message",
      subtype: "message_deleted",
      channel: CHANNEL,
      channel_type: "group",
      ts: ts(20),
      deleted_ts: ts(1)
    }
    expect(eventRecord(callback({ ...deletion, event_ts: ts(21) }), context)).toMatchObject({
      externalId: `${CHANNEL}:${ts(1)}`,
      deleted: true,
      version: ts(21),
      access: { scope: "container", containerId: CHANNEL }
    })
    expect(eventRecord(callback(deletion), context)?.version).toBe(ts(20))
    const { deleted_ts: _deleted, ...unnamed } = deletion
    expect(eventRecord(callback(unnamed), context)).toBeUndefined()
  })
})

describe("make", () => {
  const client = makeClient({ botToken: "xoxb-fixture-bot-token", apiBaseUrl: "http://127.0.0.1:9/api" }, {})
  const base = { connectionId: CONNECTION, channel: CHANNEL, client }

  it("refuses every bound outside its range and an initialOldest that is not a timestamp", () => {
    const refused = (options: Partial<Options>, pattern: RegExp) => {
      let thrown: unknown
      try {
        make({ ...base, ...options })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(IntegrationError)
      expect((thrown as IntegrationError).reason).toBe("invalid-config")
      expect((thrown as IntegrationError).message).toMatch(pattern)
    }
    refused({ pageSize: 0 }, /pageSize/)
    refused({ pageSize: 1000 }, /pageSize/)
    refused({ pageSize: 1.5 }, /pageSize/)
    refused({ maxTrackedThreads: -1 }, /maxTrackedThreads/)
    refused({ maxTrackedThreads: 201 }, /maxTrackedThreads/)
    refused({ threadWindowSeconds: 90 * 86_400 + 1 }, /threadWindowSeconds/)
    refused({ maxReplyPages: 0 }, /maxReplyPages/)
    refused({ maxReplyPages: 51 }, /maxReplyPages/)
    refused({ initialOldest: "yesterday" }, /initialOldest/)
  })

  it("names its provider, connection and stream", () => {
    expect(make({ ...base, maxTrackedThreads: 0, threadWindowSeconds: 0, initialOldest: ts(0) })).toMatchObject({
      provider: "slack",
      connectionId: CONNECTION,
      stream: CHANNEL
    })
  })
})

describe("changes", () => {
  it("syncs a conversation page by page, newest page first, and advances only at the end of the pass", async () => {
    const state = initial({
      info: { id: CHANNEL, is_private: true },
      history: [1, 2, 3, 4, 5].map((offset) => message(offset))
    })
    const server = await serve(state)
    const adapter = adapterFor(server, { pageSize: 2 })

    const first = await Effect.runPromise(adapter.changes(null))
    expect(first.done).toBe(false)
    expect(first.reset).toBe(false)
    expect(first.records.map((record) => record.externalId)).toEqual([
      externalId(CHANNEL, ts(5)),
      externalId(CHANNEL, ts(4))
    ])
    expect(cursorOf(first.cursor)).toEqual({ v: 1, watermark: null, page: "page-2", newest: ts(5), threads: [] })

    const report = await run(Effect.gen(function*() {
      const report = yield* runSync({ adapter })
      return { report, record: yield* stored(ts(1)) }
    }))
    expect(report.report).toMatchObject({ pages: 3, inserted: 5, done: true, reset: false })
    expect(cursorOf(report.report.cursor)).toEqual({
      v: 1,
      watermark: ts(5),
      page: null,
      newest: null,
      threads: []
    })
    expect(report.record).toMatchObject({
      access: { scope: "container", containerId: CHANNEL },
      text: "message 1",
      url: `${WORKSPACE}/archives/${CHANNEL}/p${ts(1).replace(".", "")}`
    })
    // The conversation type is read once and then remembered.
    expect(calls(server, "conversations.info")).toHaveLength(1)
    expect(calls(server, "conversations.history")[0]?.params).toMatchObject({
      channel: CHANNEL,
      limit: "2",
      include_all_metadata: "true"
    })
    expect(calls(server, "conversations.history")[0]?.params["oldest"]).toBeUndefined()
  })

  it("reads only what is newer than the watermark, and keeps the watermark when nothing is", async () => {
    const state = initial({ history: [message(1), message(2)] })
    const server = await serve(state)
    const adapter = adapterFor(server, { channelType: "public" })
    const first = await Effect.runPromise(adapter.changes(null))
    expect(first.done).toBe(true)

    state.history.push(message(3))
    const second = await Effect.runPromise(adapter.changes(first.cursor))
    expect(second.records.map((record) => record.externalId)).toEqual([externalId(CHANNEL, ts(3))])
    expect(second.records[0]?.access.scope).toBe("workspace")
    expect(calls(server, "conversations.history")[1]?.params["oldest"]).toBe(ts(2))

    const third = await Effect.runPromise(adapter.changes(second.cursor))
    expect(third.records).toEqual([])
    expect(cursorOf(third.cursor).watermark).toBe(ts(3))
    // A type given up front needs no conversations.info.
    expect(calls(server, "conversations.info")).toHaveLength(0)
  })

  it("starts the first pass at initialOldest", async () => {
    const server = await serve(initial({ history: [message(1), message(2), message(3)] }))
    const changes = await Effect.runPromise(adapterFor(server, { initialOldest: ts(1) }).changes(null))
    expect(changes.records.map((record) => record.externalId)).toEqual([
      externalId(CHANNEL, ts(3)),
      externalId(CHANNEL, ts(2))
    ])
    expect(calls(server, "conversations.history")[0]?.params["oldest"]).toBe(ts(1))
  })

  it("follows tracked threads' replies on the last page of every pass", async () => {
    const root = message(1, { reply_count: 2, thread_ts: ts(1) })
    const state = initial({
      history: [root, message(2, { reply_count: 0 })],
      replies: new Map([[ts(1), [
        message(10, { thread_ts: ts(1) }),
        message(11, { thread_ts: ts(1) })
      ]]])
    })
    const server = await serve(state)
    const adapter = adapterFor(server)

    const first = await run(Effect.gen(function*() {
      const report = yield* runSync({ adapter })
      return { report, reply: yield* stored(ts(11)) }
    }))
    // Replies answer the root again; the same version is unchanged, not a duplicate.
    expect(first.report).toMatchObject({ pages: 1, inserted: 4, unchanged: 1, done: true })
    expect(cursorOf(first.report.cursor)).toEqual({
      v: 1,
      watermark: ts(2),
      page: null,
      newest: null,
      threads: [[ts(1), ts(11)]]
    })
    expect(first.reply).toMatchObject({
      thread: {
        containerId: CHANNEL,
        threadId: externalId(CHANNEL, ts(1)),
        parentId: externalId(CHANNEL, ts(1))
      }
    })
    expect(calls(server, "conversations.replies")[0]?.params).toMatchObject({ ts: ts(1), oldest: ts(1) })

    // A later reply to the tracked root arrives with no new history.
    state.replies.get(ts(1))?.push(message(12, { thread_ts: ts(1) }))
    const second = await Effect.runPromise(adapter.changes(first.report.cursor))
    expect(second.records.map((record) => record.externalId)).toEqual([
      externalId(CHANNEL, ts(1)),
      externalId(CHANNEL, ts(12))
    ])
    expect(calls(server, "conversations.replies")[1]?.params["oldest"]).toBe(ts(11))
    expect(cursorOf(second.cursor).threads).toEqual([[ts(1), ts(12)]])
  })

  it("bounds the reply pages read for one thread in one pass", async () => {
    const server = await serve(initial({
      history: [message(1, { reply_count: 5 })],
      replies: new Map([[ts(1), [2, 3, 4, 5, 6].map((offset) => message(offset, { thread_ts: ts(1) }))]])
    }))
    const changes = await Effect.runPromise(adapterFor(server, { pageSize: 2, maxReplyPages: 2 }).changes(null))
    expect(calls(server, "conversations.replies")).toHaveLength(2)
    // Root, then the root again as the replies' parent, then three replies.
    expect(changes.records).toHaveLength(5)
    expect(cursorOf(changes.cursor).threads).toEqual([[ts(1), ts(4)]])
  })

  it("drops a thread Slack no longer has, and one older than the window", async () => {
    const old = `${BASE - 10 * 86_400}.000100`
    const state = initial({
      history: [
        message(1, { reply_count: 1 }),
        message(2, { reply_count: 1 }),
        { ...message(0, { reply_count: 1 }), ts: old }
      ],
      replies: new Map([[ts(2), [message(3, { thread_ts: ts(2) })]], [old, []]])
    })
    const server = await serve(state)
    const changes = await Effect.runPromise(adapterFor(server).changes(null))
    expect(cursorOf(changes.cursor).threads).toEqual([[ts(2), ts(3)]])
    expect(calls(server, "conversations.replies").map((call) => call.params["ts"])).toEqual([ts(2), ts(1)])
  })

  it("keeps only the most recently active threads within maxTrackedThreads", async () => {
    const server = await serve(initial({
      history: [message(1, { reply_count: 1 }), message(2, { reply_count: 1 }), message(3, { reply_count: 1 })],
      replies: new Map([
        [ts(1), [message(30, { thread_ts: ts(1) })]],
        [ts(2), [message(10, { thread_ts: ts(2) })]],
        [ts(3), [message(20, { thread_ts: ts(3) })]]
      ])
    }))
    const changes = await Effect.runPromise(adapterFor(server, { maxTrackedThreads: 2 }).changes(null))
    expect(cursorOf(changes.cursor).threads).toEqual([[ts(1), ts(30)], [ts(3), ts(20)]])
  })

  it("restarts the pass from the watermark when Slack expires a page cursor", async () => {
    const state = initial({ history: [message(1, { reply_count: 1 }), message(2), message(3)] })
    state.replies.set(ts(1), [])
    const server = await serve(state)
    const adapter = adapterFor(server, { pageSize: 2 })
    const first = await Effect.runPromise(adapter.changes(null))
    expect(cursorOf(first.cursor).page).toBe("page-2")

    state.expireCursor = true
    const second = await Effect.runPromise(adapter.changes(first.cursor))
    expect(second.done).toBe(false)
    expect(second.records.map((record) => record.externalId)).toEqual([
      externalId(CHANNEL, ts(3)),
      externalId(CHANNEL, ts(2))
    ])
    const historyCalls = calls(server, "conversations.history")
    expect(historyCalls[1]?.params["cursor"]).toBe("page-2")
    expect(historyCalls[2]?.params["cursor"]).toBeUndefined()

    const third = await Effect.runPromise(adapter.changes(second.cursor))
    expect(third.done).toBe(true)
    expect(cursorOf(third.cursor)).toMatchObject({ watermark: ts(3), threads: [[ts(1), ts(1)]] })
  })

  it("keeps the reply position of a root it already tracks when history lists it again", async () => {
    const state = initial({
      history: [message(1, { reply_count: 2 })],
      replies: new Map([[ts(1), [message(5, { thread_ts: ts(1) }), message(6, { thread_ts: ts(1) })]]])
    })
    const server = await serve(state)
    // A pass that already saw reply 5 and is re-reading the root's page.
    const cursor = JSON.stringify({ v: 1, watermark: null, page: null, newest: null, threads: [[ts(1), ts(5)]] })
    const changes = await Effect.runPromise(adapterFor(server).changes(cursor))
    expect(calls(server, "conversations.replies")[0]?.params["oldest"]).toBe(ts(5))
    expect(changes.records.map((record) => record.externalId)).toEqual([
      externalId(CHANNEL, ts(1)),
      externalId(CHANNEL, ts(1)),
      externalId(CHANNEL, ts(6))
    ])
    expect(cursorOf(changes.cursor).threads).toEqual([[ts(1), ts(6)]])
  })

  it("stores a history tombstone as a deletion", async () => {
    const server = await serve(initial({ history: [message(1, { subtype: "tombstone", reply_count: 1 })] }))
    const record: SourceRecord | undefined = await run(Effect.gen(function*() {
      yield* runSync({ adapter: adapterFor(server) })
      return yield* stored(ts(1))
    }))
    expect(record).toMatchObject({ deleted: true, text: "" })
  })

  it("refuses a cursor it did not write rather than re-listing the conversation", async () => {
    const server = await serve(initial())
    const adapter = adapterFor(server)
    for (
      const cursor of ["not json", JSON.stringify({ v: 2, watermark: null, page: null, newest: null, threads: [] })]
    ) {
      const error = await failure(adapter.changes(cursor))
      expect(error.reason).toBe("invalid-config")
      expect(error.details).toMatchObject({ connectionId: CONNECTION, channel: CHANNEL })
    }
    expect(calls(server, "conversations.history")).toHaveLength(0)
  })

  it("fails when conversations.info answers without a channel", async () => {
    const server = await serve(initial({ info: undefined }))
    const error = await failure(adapterFor(server).changes(null))
    expect(error.reason).toBe("decode-failed")
    expect(error.details).toMatchObject({ channel: CHANNEL })
  })

  it("fails on history or replies it cannot key", async () => {
    for (const messages of [undefined, "none", [{ ts: "yesterday" }]]) {
      const server = await serve(initial({ historyMessages: messages ?? null }))
      const error = await failure(adapterFor(server).changes(null))
      expect(error.reason).toBe("decode-failed")
      expect(error.details).toMatchObject({ method: "conversations.history" })
      await server.close()
      fixture = undefined
    }
    const server = await serve(initial({
      history: [message(1, { reply_count: 1 })],
      repliesMessages: [{ text: "no ts" }]
    }))
    const error = await failure(adapterFor(server).changes(null))
    expect(error.details).toMatchObject({ method: "conversations.replies" })
  })

  it("passes a history or replies refusal through", async () => {
    const refusedHistory = await serve(initial({ historyError: "channel_not_found" }))
    const historyError = await failure(adapterFor(refusedHistory).changes(null))
    expect(historyError.details).toMatchObject({ slackError: "channel_not_found" })
    await refusedHistory.close()
    fixture = undefined

    // An expired cursor is only forgiven for a page cursor; the first page has none.
    const expired = await serve(initial({ historyError: "invalid_cursor" }))
    const expiredError = await failure(adapterFor(expired).changes(null))
    expect(expiredError.details).toMatchObject({ slackError: "invalid_cursor" })
    expect(calls(expired, "conversations.history")).toHaveLength(1)
    await expired.close()
    fixture = undefined

    const refusedReplies = await serve(initial({
      history: [message(1, { reply_count: 1 })],
      repliesError: "missing_scope"
    }))
    const repliesError = await failure(adapterFor(refusedReplies).changes(null))
    expect(repliesError).toMatchObject({ reason: "permission-denied" })
    expect(repliesError.details).toMatchObject({ slackError: "missing_scope" })
  })

  it("refuses a paged cursor Slack rejects for another reason", async () => {
    const state = initial({ history: [message(1), message(2)] })
    const server = await serve(state)
    const adapter = adapterFor(server, { pageSize: 1 })
    const first = await Effect.runPromise(adapter.changes(null))
    state.historyError = "ratelimited_forever"
    const error = await failure(adapter.changes(first.cursor))
    expect(error.details).toMatchObject({ slackError: "ratelimited_forever" })
  })
})
