import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Effect, Layer, ManagedRuntime } from "effect"
import { expect, it } from "vitest"
import { IntegrationFailure } from "../src/core/ActionFailure.ts"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import * as Actions from "../src/telegram/Actions.ts"
import * as Sync from "../src/telegram/IssueSync.ts"
import * as Source from "../src/telegram/Source.ts"
import * as Client from "../src/telegram/TelegramClient.ts"
import { json, startFixture } from "./Fixture.ts"
const options = { connectionId: "bot", botId: "123", allowedChatIds: ["-100"], owner: "owner", repo: "repo" }
const executor = (patch: Partial<Sync.Executor> = {}): Sync.Executor => ({
  post: async () => ({ messageIds: [10, 11] }),
  update: async (p) => ({ messageIds: p.messageIds }),
  delete: async (p) => ({ messageIds: p.messageIds }),
  ...patch
})
const message = { message_id: 7, date: 100, chat: { id: -100 }, from: { id: 42, is_bot: false }, text: "hello" }
const events = (m: any = message, edit = false, id = 1) =>
  Source.updateToEvents("source", { update_id: id, [edit ? "edited_message" : "message"]: m }, 0)
const row = (patch: any = {}) => ({
  id: 1,
  key: "key",
  issue_id: 42,
  state: "pending",
  event: "comment.created",
  payload: { comment: { id: 7, body: "hello", persona: { username: "Builder" } } },
  message_id: "10,11",
  mapping: { provider: "telegram", connection_id: "bot", scope_id: "123", conversation_id: "-100", thread_id: "chat" },
  ...patch
})
const fixture = (rows: any[], execute = executor(), extra: any = {}) => {
  const receipts: any[] = []
  const calls: any[] = []
  const sync = Sync.make({
    ...options,
    execute,
    request: async (path, init) => {
      calls.push({ path, init })
      if (path.endsWith("/deliveries")) return Response.json(rows)
      if (init?.method === "POST") return Response.json({ state: "dispatching", token: "claim" })
      receipts.push(JSON.parse(String(init?.body)))
      return Response.json({})
    },
    ...extra
  })
  return { sync, receipts, calls }
}
it("normalizes replies, topics and same-second edits to durable identities across restart", async () => {
  const bodies: any[] = []
  const wakes: string[] = []
  const make = () =>
    Sync.make({
      ...options,
      execute: executor(),
      request: async (_, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ issue_id: 42 })
      },
      onMessage: async (r) => {
        wakes.push(r.event.dedupeKey)
      }
    })
  await make().ingest(events()[0]!)
  for (const e of events({ ...message, message_thread_id: 3, reply_to_message: { message_id: 6 } })) {
    await make().ingest(e)
  }
  await make().ingest(events({ ...message, edit_date: 100, text: "edit" }, true, 2)[0]!)
  expect(bodies[0]).toMatchObject({
    provider: "telegram",
    conversation_id: "-100",
    thread_id: "",
    message_id: "7",
    version: "100.0000000001"
  })
  expect(bodies[1]).toMatchObject({ thread_id: "3" })
  expect(wakes.slice(0, 3)).toEqual(["telegram:123:1", "telegram:123:1", "telegram:123:1"])
  expect(bodies[3]).toMatchObject({ kind: "edit", version: "100.0000000002" })
})
it.each([
  { ...message, from: { id: 123, is_bot: false } },
  { ...message, from: { id: 42, is_bot: true } },
  { ...message, from: { id: 42 } },
  { ...message, from: { id: 0, is_bot: false } },
  { ...message, chat: { id: -999 } },
  { ...message, message_id: 0 },
  { ...message, text: undefined },
  { ...message, text: " " },
  { ...message, message_thread_id: 0 },
  { ...message, date: 0 },
  { ...message, from: null },
  { ...message, chat: null },
  null
])("refuses unsafe ingress %j", async (m) => {
  const { sync, calls } = fixture([])
  expect(await sync.ingest({ ...events()[0]!, payload: m as any })).toBe("ignored")
  expect(calls).toHaveLength(0)
})
it("requires delivery identity, event kind, allowed users and valid configuration", async () => {
  const { sync } = fixture([])
  for (
    const e of [{ ...events()[0]!, eventName: "callback" }, { ...events()[0]!, dedupeKey: "foreign" }, {
      ...events()[0]!,
      dedupeKey: "update:6:source:bad"
    }]
  ) expect(await sync.ingest(e)).toBe("ignored")
  expect(await fixture([], executor(), { allowedUserIds: ["99"] }).sync.ingest(events()[0]!)).toBe("ignored")
  expect(
    await fixture([], executor(), { allowedUserIds: ["42"], request: async () => Response.json({}) }).sync.ingest(
      events()[0]!
    )
  ).toBe("applied")
  expect(() => fixture([], executor(), { botId: "bad" })).toThrow("bot id")
  expect(() => fixture([], executor(), { allowedChatIds: [] })).toThrow("allowed chats")
})
it.each(["comment.created", "comment.edited", "comment.deleted"])(
  "delivers %s through durable executor",
  async (event) => {
    const captured: any[] = []
    const capture = async (p: any) => {
      captured.push(p)
      return { messageIds: [10, 11] }
    }
    const { sync, receipts } = fixture([row({ event })], executor({ post: capture, update: capture, delete: capture }))
    expect(await sync.drain()).toBe(1)
    expect(captured[0]).toMatchObject({
      connectionId: "bot",
      chatId: "-100",
      text: "Builder\nhello",
      messageIds: [10, 11]
    })
    expect(captured[0]).not.toHaveProperty("messageThreadId")
    expect(receipts[0]).toMatchObject({ state: "sent", message_id: "10,11" })
  }
)
it("supports topics, absent persona/body and unsupported reactions", async () => {
  const calls: any[] = []
  const { sync, receipts } = fixture(
    [
      row({ message_id: "", payload: { comment: { id: 7 } }, mapping: { ...row().mapping, thread_id: "3" } }),
      row({ id: 2, event: "comment.reaction" })
    ],
    executor({
      post: async (p) => {
        calls.push(p)
        return { messageIds: [10] }
      }
    })
  )
  expect(await sync.drain()).toBe(2)
  expect(calls[0]).toMatchObject({ messageThreadId: 3, messageIds: [], text: "" })
  expect(receipts[1].state).toBe("unsupported")
})
it.each([row({ event: "comment.edited", message_id: "" }), row({ event: "unknown" })])(
  "keeps unexecutable delivery unknown",
  async (d) => {
    const { sync, receipts } = fixture([d])
    expect(await sync.drain()).toBe(0)
    expect(receipts[0].state).toBe("outcome_unknown")
  }
)
it("refuses foreign routes and never reposts a partial or unknown send", async () => {
  for (
    const mapping of [{ ...row().mapping, provider: "slack" }, { ...row().mapping, connection_id: "other" }, {
      ...row().mapping,
      scope_id: "999"
    }, { ...row().mapping, conversation_id: "other" }]
  ) expect(await fixture([row({ mapping })]).sync.drain()).toBe(0)
  let state = "pending", posts = 0
  const receipts: any[] = []
  const request = async (path: string, init?: RequestInit) => {
    if (path.endsWith("/deliveries")) return Response.json([row({ state })])
    if (init?.method === "POST") {
      state = "dispatching"
      return Response.json({ state, token: "claim" })
    }
    const r = JSON.parse(String(init?.body))
    receipts.push(r)
    state = r.state
    return Response.json({})
  }
  const make = () =>
    Sync.make({
      ...options,
      request,
      execute: executor({
        post: async () => {
          posts++
          throw new IntegrationFailure({
            reason: "permission-denied",
            message: "second chunk refused",
            retryable: false,
            deliveredMessageIds: [10]
          })
        }
      })
    })
  await make().drain()
  await make().drain()
  expect(posts).toBe(1)
  expect(state).toBe("outcome_unknown")
  expect(receipts[0].message_id).toBe("10")
})
it("awaits backend commit before acknowledging Source", async () => {
  let committed = false
  const { sync } = fixture([], executor(), {
    request: async () => {
      committed = true
      return Response.json({ issue_id: 42 })
    },
    onMessage: async () => {
      expect(committed).toBe(true)
    }
  })
  await Effect.runPromise(sync.run({ run: (handle: any) => handle(events()) } as any) as any)
})
const runAction = async (
  kind: "post" | "update" | "delete",
  payload: any,
  client: Client.TelegramClient,
  resolveError = false
) => {
  const flow = kind === "post" ? Sync.Post : kind === "update" ? Sync.Update : Sync.Delete
  const layers = Layer.mergeAll(
    Actions.layerIssueSync(() =>
      resolveError
        ? Effect.fail(new IntegrationError("permission-denied", "connection denied"))
        : Effect.succeed(client)
    ),
    Interpreter.layer(flow)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer))
  )
  return Effect.runPromise(
    (flow.execute(payload, { executionId: `test-${kind}-${crypto.randomUUID()}` }) as Effect.Effect<any, any, any>)
      .pipe(Effect.provide(layers), Effect.scoped) as any
  ) as Promise<any>
}
const payload = { connectionId: "bot", chatId: "-100", text: "hello", messageIds: [] }
it("executes chunked post/edit/delete through real HTTP and durable flows", async () => {
  let id = 10
  const server = await startFixture((_req, res) => json(res, 200, { ok: true, result: { message_id: id++ } }))
  try {
    const client = Client.make({ botToken: "fixture", apiBaseUrl: server.origin }, {})
    const sent = await runAction("post", { ...payload, text: "x".repeat(5000), messageThreadId: 3 }, client)
    expect(sent.messageIds).toEqual([10, 11])
    const grown = await runAction("update", {
      ...payload,
      text: "x".repeat(9000),
      messageIds: [10, 11],
      messageThreadId: 3
    }, client)
    expect(grown.messageIds).toEqual([10, 11, 14])
    const shrunk = await runAction("update", { ...payload, messageIds: grown.messageIds }, client)
    expect(shrunk.messageIds).toEqual([10])
    await runAction("delete", { ...payload, messageIds: [10] }, client)
    expect(server.requests.map((r) => r.url)).toEqual([
      "/botfixture/sendMessage",
      "/botfixture/sendMessage",
      "/botfixture/editMessageText",
      "/botfixture/editMessageText",
      "/botfixture/sendMessage",
      "/botfixture/editMessageText",
      "/botfixture/deleteMessage",
      "/botfixture/deleteMessage",
      "/botfixture/deleteMessage"
    ])
    expect(JSON.parse(server.requests[0]!.body)).toMatchObject({ message_thread_id: 3 })
  } finally {
    await server.close()
  }
})
it("journals partial mutations as unknown and distinguishes known refusal", async () => {
  let calls = 0
  const server = await startFixture((_req, res) => {
    calls++
    if (calls === 1) json(res, 200, { ok: true, result: true })
    else json(res, 403, { ok: false, error_code: 403, description: "Forbidden" })
  })
  try {
    const client = Client.make({ botToken: "fixture", apiBaseUrl: server.origin }, {})
    const failure: any = await runAction("delete", { ...payload, messageIds: [10, 11] }, client).catch((e) => e)
    expect(failure.cause?.error ?? failure.error ?? failure).toMatchObject({ outcomeUnknown: true })
    const refused: any = await runAction("delete", { ...payload, messageIds: [10] }, client).catch((e) => e)
    expect(refused.cause?.error ?? refused.error ?? refused).toMatchObject({ outcomeUnknown: false })
    await expect(runAction("post", payload, client, true)).rejects.toBeDefined()
  } finally {
    await server.close()
  }
})
it("supports plain chat sends and growth without a topic", async () => {
  const server = await startFixture((_req, res) => json(res, 200, { ok: true, result: { message_id: 10 } }))
  try {
    const client = Client.make({ botToken: "fixture", apiBaseUrl: server.origin }, {})
    await runAction("post", payload, client)
    await runAction("update", { ...payload, messageIds: [] }, client)
  } finally {
    await server.close()
  }
})

it("retains new chunk receipts when a growing edit partially fails", async () => {
  let calls = 0
  const server = await startFixture((_req, res) => {
    calls++
    if (calls === 1) json(res, 200, { ok: true, result: { message_id: 10 } })
    else json(res, 403, { ok: false, error_code: 403, description: "Forbidden" })
  })
  try {
    const failure: any = await runAction(
      "update",
      { ...payload, text: "x".repeat(5000) },
      Client.make({ botToken: "fixture", apiBaseUrl: server.origin }, {})
    ).catch((e) => e)
    expect(failure.cause?.error ?? failure.error ?? failure).toMatchObject({
      outcomeUnknown: true,
      deliveredMessageIds: [10]
    })
  } finally {
    await server.close()
  }
})
it.each([null, {}, "not json", { ok: true, result: {} }])(
  "keeps malformed successful writes unknown (%j)",
  async (answer) => {
    const server = await startFixture((_req, res) => json(res, 200, answer))
    try {
      const failure: any = await runAction(
        "post",
        payload,
        Client.make({ botToken: "fixture", apiBaseUrl: server.origin }, {})
      ).catch((e) => e)
      expect(failure.cause?.error ?? failure.error ?? failure).toMatchObject({ outcomeUnknown: true })
    } finally {
      await server.close()
    }
  }
)
const durable = (server: { origin: string }) => {
  const client = Client.make({ botToken: "fixture", apiBaseUrl: server.origin }, {})
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Actions.layerIssueSync(() => Effect.succeed(client)),
      Interpreter.layer(Sync.Post),
      Interpreter.layer(Sync.Update),
      Interpreter.layer(Sync.Delete)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer))
    ) as Layer.Layer<any, any, never>
  )
  const run = (flow: any) => (payload: any, executionId: string) =>
    runtime.runPromise((flow.execute(payload, { executionId }) as Effect.Effect<any, any, any>).pipe(Effect.scoped))
  return {
    runtime,
    execute: { post: run(Sync.Post), update: run(Sync.Update), delete: run(Sync.Delete) } as Sync.Executor
  }
}
it.each(["comment.created", "comment.edited", "comment.deleted"])(
  "recovers a completed %s whose receipt was lost, without resending",
  async (event) => {
    const server = await startFixture((_req, res) => json(res, 200, { ok: true, result: { message_id: 20 } }))
    const { runtime, execute } = durable(server)
    try {
      let state = "pending", token = "", lost = true
      const receipts: any[] = []
      const request = async (path: string, init?: RequestInit) => {
        if (path.endsWith("/deliveries")) {
          return Response.json([row({ event, state, message_id: "10", claim_token: token })])
        }
        if (init?.method === "POST") {
          state = "dispatching"
          token = "claim"
          return Response.json({ state, token })
        }
        if (lost) throw new Error("host died before the receipt committed")
        const r = JSON.parse(String(init?.body))
        receipts.push(r)
        state = r.state
        return Response.json({})
      }
      await Sync.make({ ...options, request, execute }).drain().catch(() => undefined)
      expect(state).toBe("dispatching")
      const sends = server.requests.length
      lost = false
      expect(await Sync.make({ ...options, request, execute }).drain()).toBe(1)
      expect(server.requests.length).toBe(sends)
      expect(receipts).toEqual([expect.objectContaining({ state: "sent", token: "claim" })])
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }
)
it("acknowledges a refused event without waking the host", async () => {
  const wakes: string[] = []
  const { sync } = fixture([], executor(), {
    request: async () => Response.json({ ignored: "sync conversation not mapped" }),
    onMessage: async (r: any) => {
      wakes.push(r.event.dedupeKey)
    }
  })
  expect(await sync.ingest(events()[0]!)).toBe("ignored")
  expect(wakes).toEqual([])
})
