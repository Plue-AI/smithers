import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import type { FlowRuntime } from "@smthrs/flow"
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
/** Execute registered flows using the supplied durable run identity.
 * @category models
 * @since 1.0.0
 */
interface Executor {
  post(
    payload: typeof Actions.IssueMessagePayload.Type,
    executionId: string
  ): Promise<typeof Actions.IssueMessageResult.Type>
  update(
    payload: typeof Actions.IssueMessagePayload.Type,
    executionId: string
  ): Promise<typeof Actions.IssueMessageResult.Type>
  delete(
    payload: typeof Actions.IssueMessagePayload.Type,
    executionId: string
  ): Promise<typeof Actions.IssueMessageResult.Type>
  react(
    payload: typeof Actions.IssueReactionPayload.Type,
    executionId: string
  ): Promise<typeof Actions.SetIssueReaction.successSchema.Type>
}
const options = { connectionId: "bot", botId: "123", allowedChatIds: ["-100"], owner: "owner", repo: "repo" }
const executor = (patch: Partial<Executor> = {}): Executor => ({
  post: async () => ({ messageIds: [10, 11] }),
  update: async (p) => ({ messageIds: p.messageIds }),
  delete: async (p) => ({ messageIds: p.messageIds }),
  react: async () => ({ status: "applied" }),
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
  const sync = makeSync({
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
    makeSync({
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
it("supports topics and absent persona/body", async () => {
  const calls: any[] = []
  const { sync, receipts } = fixture(
    [row({ message_id: "", payload: { comment: { id: 7 } }, mapping: { ...row().mapping, thread_id: "3" } })],
    executor({
      post: async (p) => {
        calls.push(p)
        return { messageIds: [10] }
      }
    })
  )
  expect(await sync.drain()).toBe(1)
  expect(calls[0]).toMatchObject({ messageThreadId: 3, messageIds: [], text: "" })
  expect(receipts[0].state).toBe("sent")
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
    makeSync({
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
  kind: "post" | "update" | "delete" | "react",
  payload: any,
  client: Client.TelegramClient,
  resolveError = false
) => {
  const flow: any = kind === "post"
    ? Sync.Post
    : kind === "update"
    ? Sync.Update
    : kind === "react"
    ? Sync.React
    : Sync.Delete
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
const memoryReplay = (server: { origin: string }) => {
  const client = Client.make({ botToken: "fixture", apiBaseUrl: server.origin }, {})
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Actions.layerIssueSync(() => Effect.succeed(client)),
      Interpreter.layer(Sync.Post),
      Interpreter.layer(Sync.Update),
      Interpreter.layer(Sync.Delete),
      Interpreter.layer(Sync.React)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer))
    ) as Layer.Layer<any, any, never>
  )
  const run = (flow: any) => (payload: any, executionId: string) =>
    runtime.runPromise((flow.execute(payload, { executionId }) as Effect.Effect<any, any, any>).pipe(Effect.scoped))
  return {
    runtime,
    execute: {
      post: run(Sync.Post),
      update: run(Sync.Update),
      delete: run(Sync.Delete),
      react: run(Sync.React)
    } as Executor
  }
}
it.each(["comment.created", "comment.edited", "comment.deleted"])(
  "recovers a completed %s whose receipt was lost, without resending",
  async (event) => {
    const server = await startFixture((_req, res) => json(res, 200, { ok: true, result: { message_id: 20 } }))
    const { runtime, execute } = memoryReplay(server)
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
      await makeSync({ ...options, request, execute }).drain().catch(() => undefined)
      expect(state).toBe("dispatching")
      const sends = server.requests.length
      lost = false
      expect(await makeSync({ ...options, request, execute }).drain()).toBe(1)
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
it("lets a stale worker finish quietly after a lapsed claim was replayed and settled", async () => {
  const server = await startFixture((_req, res) => json(res, 200, { ok: true, result: { message_id: 20 } }))
  const { runtime, execute } = memoryReplay(server)
  try {
    let state = "pending", lapsed = false
    const receipts: any[] = []
    const request = async (path: string, init?: RequestInit) => {
      if (path.endsWith("/deliveries")) {
        return Response.json(state === "sent" ? [] : [row({ state, claim_token: lapsed ? "claim" : "" })])
      }
      if (init?.method === "POST") {
        state = "dispatching"
        return Response.json({ state, token: "claim" })
      }
      if (state === "sent") return new Response(null, { status: 409 })
      const r = JSON.parse(String(init?.body))
      receipts.push(r)
      state = r.state
      return Response.json({})
    }
    let resume!: () => void
    const paused = new Promise<void>((resolve) => (resume = resolve))
    const hung = makeSync({
      ...options,
      request,
      execute: { ...execute, post: async (p, id) => (await paused, execute.post(p, id)) }
    }).drain()
    await new Promise((resolve) => setTimeout(resolve, 10))
    lapsed = true
    expect(await makeSync({ ...options, request, execute }).drain()).toBe(1)
    resume()
    expect(await hung).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(receipts).toEqual([expect.objectContaining({ state: "sent", token: "claim" })])
  } finally {
    await runtime.dispose()
    await server.close()
  }
})

const reactionUpdate = (patch: any = {}, id = 5) =>
  Source.updateToEvents("source", {
    update_id: id,
    message_reaction: {
      chat: { id: -100 },
      message_id: 11,
      user: { id: 42, is_bot: false },
      date: 200,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
      ...patch
    }
  }, 0)[0]!
const reactionIntake = (extra: any = {}) => {
  const bodies: any[] = []
  const wakes: any[] = []
  const sync = makeSync({
    ...options,
    execute: executor(),
    request: async (_path, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ issue_id: 42 })
    },
    onMessage: async (r) => {
      wakes.push(r)
    },
    ...extra
  })
  return { sync, bodies, wakes }
}
it("maps issue reaction names to Telegram reactions and back", () => {
  expect(Actions.toReaction("+1")).toEqual({ type: "emoji", emoji: "👍" })
  expect(Actions.toReaction("thumbsup")).toEqual({ type: "emoji", emoji: "👍" })
  expect(Actions.toReaction("telegram_custom_5368324170671202286")).toEqual({
    type: "custom_emoji",
    custom_emoji_id: "5368324170671202286"
  })
  for (const name of ["rocket", "telegram_custom_", "telegram_custom_x1", ""]) {
    expect(Actions.toReaction(name)).toBeUndefined()
  }
  expect(Actions.fromReaction({ type: "emoji", emoji: "👍" })).toBe("+1")
  expect(Actions.fromReaction({ type: "emoji", emoji: "\u2764\uFE0F" })).toBe("heart")
  expect(Actions.fromReaction({ type: "custom_emoji", custom_emoji_id: "77" })).toBe("telegram_custom_77")
  for (
    const r of [
      { type: "paid" },
      { type: "emoji", emoji: "🚀" },
      { type: "emoji", emoji: 1 },
      { type: "custom_emoji", custom_emoji_id: "x" },
      { type: "custom_emoji" },
      null,
      "👍"
    ]
  ) expect(Actions.fromReaction(r)).toBeUndefined()
})
it("ingests each added and removed reaction with actor attribution and durable identity", async () => {
  const { sync, bodies, wakes } = reactionIntake()
  const update = reactionUpdate({
    old_reaction: [{ type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🚀" }],
    new_reaction: [{ type: "emoji", emoji: "🔥" }, { type: "custom_emoji", custom_emoji_id: "77" }, { type: "paid" }]
  })
  expect(await sync.ingest(update)).toBe("applied")
  // A duplicate update replays the same identities, which the backend dedupes.
  expect(await sync.ingest(update)).toBe("applied")
  const common = {
    provider: "telegram",
    connection_id: "bot",
    scope_id: "123",
    conversation_id: "-100",
    thread_id: "",
    message_id: "11",
    version: "200.0000000005",
    user_id: "42"
  }
  expect(bodies.slice(0, 3)).toEqual([
    { ...common, kind: "reaction_remove", reaction: "+1", delivery_key: "telegram:123:5:reaction_remove:+1" },
    { ...common, kind: "reaction_add", reaction: "fire", delivery_key: "telegram:123:5:reaction_add:fire" },
    {
      ...common,
      kind: "reaction_add",
      reaction: "telegram_custom_77",
      delivery_key: "telegram:123:5:reaction_add:telegram_custom_77"
    }
  ])
  expect(bodies.slice(3)).toEqual(bodies.slice(0, 3))
  expect(wakes).toEqual([])
})
it("acknowledges a reaction the backend refuses", async () => {
  const { sync } = reactionIntake({ request: async () => Response.json({ ignored: "external message not mapped" }) })
  expect(await sync.ingest(reactionUpdate())).toBe("ignored")
})
it.each([
  { user: { id: 123, is_bot: false } },
  { user: { id: 42, is_bot: true } },
  { user: { id: 42 } },
  { user: undefined, actor_chat: { id: -100 } },
  { chat: { id: -999 } },
  { chat: null },
  { message_id: 0 },
  { date: 0 },
  { old_reaction: undefined },
  { new_reaction: null },
  { new_reaction: [{ type: "paid" }] },
  { new_reaction: [{ type: "emoji", emoji: "🚀" }] },
  { old_reaction: [{ type: "emoji", emoji: "👍" }] }
])("refuses unattributed, disallowed or unmapped reactions %j", async (patch) => {
  const { sync, bodies } = reactionIntake()
  const event = reactionUpdate()
  expect(await sync.ingest({ ...event, payload: { ...(event.payload as object), ...patch } as any })).toBe("ignored")
  expect(bodies).toHaveLength(0)
})
it("refuses reactions from users outside the allowlist and foreign identities", async () => {
  expect(await reactionIntake({ allowedUserIds: ["99"] }).sync.ingest(reactionUpdate())).toBe("ignored")
  const { sync, bodies } = reactionIntake()
  expect(await sync.ingest({ ...reactionUpdate(), dedupeKey: "foreign" })).toBe("ignored")
  expect(await sync.ingest({ ...reactionUpdate(), payload: null as any })).toBe("ignored")
  expect(bodies).toHaveLength(0)
})
it("retries a reaction that beats its outbound receipt, then fails without acknowledging", async () => {
  let calls = 0
  const { sync } = reactionIntake({
    request: async () => {
      calls++
      return calls < 3 ? new Response(null, { status: 409 }) : Response.json({ issue_id: 42 })
    }
  })
  expect(await sync.ingest(reactionUpdate())).toBe("applied")
  expect(calls).toBe(3)
})
it.each([
  { reaction: { name: "+1", active: true }, sent: { type: "emoji", emoji: "👍" } },
  { reaction: { name: "telegram_custom_77", active: false }, sent: { type: "custom_emoji", custom_emoji_id: "77" } }
])("delivers reaction $reaction.name on the first chunk", async ({ reaction, sent }) => {
  const captured: any[] = []
  const { sync, receipts } = fixture(
    [row({ event: "comment.reaction", payload: { comment: { id: 7 }, reaction } })],
    executor({
      react: async (p) => {
        captured.push(p)
        return { status: "applied" }
      }
    })
  )
  expect(await sync.drain()).toBe(1)
  expect(captured).toEqual([{
    connectionId: "bot",
    chatId: "-100",
    messageId: 10,
    reaction: sent,
    active: reaction.active
  }])
  expect(receipts[0]).toMatchObject({ state: "sent", message_id: "10,11" })
})
it("settles unsupported reactions explicitly without calling Telegram", async () => {
  let reacted = 0
  const react = async () => {
    reacted++
    return { status: "unsupported" as const }
  }
  const { sync, receipts } = fixture([
    row({ event: "comment.reaction", payload: { comment: { id: 7 }, reaction: { name: "rocket", active: true } } }),
    row({ id: 2, event: "comment.reaction", payload: { comment: { id: 7 }, reaction: { name: "+1", active: true } } })
  ], executor({ react }))
  expect(await sync.drain()).toBe(2)
  expect(reacted).toBe(1)
  expect(receipts).toEqual([
    expect.objectContaining({ state: "unsupported", error: "Telegram has no rocket reaction", message_id: "10,11" }),
    expect.objectContaining({ state: "unsupported", error: "Telegram chat refuses the +1 reaction" })
  ])
})
it.each([
  row({
    event: "comment.reaction",
    message_id: "",
    payload: { comment: { id: 7 }, reaction: { name: "+1", active: true } }
  }),
  row({ event: "comment.reaction", payload: { comment: { id: 7 } } })
])("keeps a reaction without identity or name unknown", async (d) => {
  const { sync, receipts } = fixture([d])
  expect(await sync.drain()).toBe(0)
  expect(receipts[0].state).toBe("outcome_unknown")
})
const reactPayload = {
  connectionId: "bot",
  chatId: "-100",
  messageId: 10,
  reaction: { type: "emoji", emoji: "👍" },
  active: true
}
it("sets and clears the bot reaction through the real Bot API", async () => {
  const server = await startFixture((_req, res) => json(res, 200, { ok: true, result: true }))
  try {
    const client = Client.make({ botToken: "fixture", apiBaseUrl: server.origin }, {})
    expect(await runAction("react", reactPayload, client)).toEqual({ status: "applied" })
    expect(await runAction("react", { ...reactPayload, active: false }, client)).toEqual({ status: "applied" })
    expect(server.requests.map((r) => [r.url, JSON.parse(r.body)])).toEqual([
      ["/botfixture/setMessageReaction", {
        chat_id: "-100",
        message_id: 10,
        reaction: [{ type: "emoji", emoji: "👍" }]
      }],
      ["/botfixture/setMessageReaction", { chat_id: "-100", message_id: 10, reaction: [] }]
    ])
  } finally {
    await server.close()
  }
})
it.each(["Bad Request: REACTION_INVALID", "Bad Request: REACTIONS_TOO_MANY"])(
  "reports a chat that refuses the reaction (%s) as unsupported",
  async (description) => {
    const server = await startFixture((_req, res) => json(res, 400, { ok: false, error_code: 400, description }))
    try {
      const client = Client.make({ botToken: "fixture", apiBaseUrl: server.origin }, {})
      expect(await runAction("react", reactPayload, client)).toEqual({ status: "unsupported" })
    } finally {
      await server.close()
    }
  }
)
it("fails a permission refusal as known and a lost response as unknown", async () => {
  let calls = 0
  const server = await startFixture((req, res) => {
    calls++
    if (calls === 1) json(res, 403, { ok: false, error_code: 403, description: "Forbidden: not enough rights" })
    else if (calls === 2) json(res, 400, { ok: false, error_code: 400, description: "Bad Request: message not found" })
    else res.destroy()
  })
  try {
    const client = Client.make({ botToken: "fixture", apiBaseUrl: server.origin }, {})
    const denied: any = await runAction("react", reactPayload, client).catch((e) => e)
    expect(denied.cause?.error ?? denied.error ?? denied).toMatchObject({ reason: "permission-denied" })
    expect((denied.cause?.error ?? denied.error ?? denied).outcomeUnknown).not.toBe(true)
    const missing: any = await runAction("react", reactPayload, client).catch((e) => e)
    expect(missing.cause?.error ?? missing.error ?? missing).toMatchObject({ reason: "decode-failed" })
    expect((missing.cause?.error ?? missing.error ?? missing).outcomeUnknown).not.toBe(true)
    const lost: any = await runAction("react", reactPayload, client).catch((e) => e)
    expect(lost.cause?.error ?? lost.error ?? lost).toMatchObject({ outcomeUnknown: true })
    await expect(runAction("react", reactPayload, client, true)).rejects.toBeDefined()
  } finally {
    await server.close()
  }
})
it("recovers a reaction whose receipt was lost, without setting it again", async () => {
  const server = await startFixture((_req, res) => json(res, 200, { ok: true, result: true }))
  const { runtime, execute } = memoryReplay(server)
  try {
    let state = "pending", token = "", lost = true
    const receipts: any[] = []
    const reaction = { name: "+1", active: true }
    const request = async (path: string, init?: RequestInit) => {
      if (path.endsWith("/deliveries")) {
        return Response.json([
          row({ event: "comment.reaction", payload: { comment: { id: 7 }, reaction }, state, claim_token: token })
        ])
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
    await makeSync({ ...options, request, execute }).drain().catch(() => undefined)
    expect(server.requests).toHaveLength(1)
    lost = false
    expect(await makeSync({ ...options, request, execute }).drain()).toBe(1)
    expect(server.requests).toHaveLength(1)
    expect(receipts).toEqual([expect.objectContaining({ state: "sent", token: "claim", message_id: "10,11" })])
  } finally {
    await runtime.dispose()
    await server.close()
  }
})

// Transport unit tests substitute the runtime, never a production host executor.
const makeSync = (options: Omit<Sync.Options, "runtime"> & { execute: Executor }) =>
  Sync.make({
    ...options,
    runtime: {
      durability: "durable",
      execute: (flow: { _tag: string }, input: { payload: any; executionId: string }) =>
        Effect.tryPromise(() => {
          const method = flow._tag.split("issue-")[1] as keyof Executor
          return (options.execute[method] as (p: any, id: string) => Promise<any>)(input.payload, input.executionId)
        })
    } as unknown as FlowRuntime.FlowRuntime["Service"]
  })
