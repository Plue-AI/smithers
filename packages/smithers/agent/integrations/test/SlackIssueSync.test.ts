import { describe, expect, it } from "vitest"
import * as IssueSync from "../src/slack/IssueSync.ts"

const policy = {
  allowedTeamIds: ["T001"],
  allowedChannelIds: ["C001"],
  allowedUserIds: ["U001"],
  selfUserIds: ["UBOT"]
}
const callback = (event: object, id = "E001") => ({ type: "event_callback", team_id: "T001", event_id: id, event })
const executor = (overrides: Partial<IssueSync.Executor> = {}): IssueSync.Executor => ({
  post: async (p) => ({ connectionId: p.connectionId, channel: p.channel, ts: "100.000001", key: p.key }),
  update: async (p) => ({ connectionId: p.connectionId, channel: p.channel, ts: p.ts }),
  delete: async (p) => ({ connectionId: p.connectionId, channel: p.channel, ts: p.ts }),
  react: async () => ({ status: "applied" }),
  reconcile: async (p) => ({
    connectionId: p.connectionId,
    channel: p.channel,
    key: p.key,
    status: "found",
    ts: "100.000001",
    pagesSearched: 1
  }),
  ...overrides
})
const options = { connectionId: "slack", policy, owner: "owner", repo: "repo" }

describe("issue sync", () => {
  it("refuses bot echo after restart and normalizes human messages, edits, deletes and reactions", async () => {
    const bodies: any[] = []
    const request = async (_: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ issue_id: 42 })
    }
    const make = () => IssueSync.make({ ...options, request, execute: executor() })
    expect(
      await make().ingest(callback({ type: "message", channel: "C001", ts: "100.000001", user: "UBOT", text: "echo" }))
    ).toBe("ignored")
    expect(
      await make().ingest(
        callback({ type: "message", channel: "C001", ts: "100.000001", user: "U001", bot_id: "B001", text: "echo" })
      )
    ).toBe("ignored")
    expect(bodies).toEqual([])
    const subject = { type: "message", ts: "101.000001", thread_ts: "100.000001", user: "U001", text: "human" }
    await make().ingest(callback({ ...subject, channel: "C001" }))
    await make().ingest(
      callback({
        type: "message",
        subtype: "message_changed",
        channel: "C001",
        ts: "102.000001",
        message: { ...subject, text: "edited", edited: { ts: "102.000001" } }
      }, "E002")
    )
    await make().ingest(
      callback({
        type: "message",
        subtype: "message_deleted",
        channel: "C001",
        ts: "103.000001",
        deleted_ts: subject.ts,
        previous_message: subject
      }, "E003")
    )
    await make().ingest(
      callback({
        type: "reaction_added",
        user: "U001",
        event_ts: "104.000001",
        reaction: "eyes",
        item: { type: "message", channel: "C001", ts: subject.ts }
      }, "E004")
    )
    expect(bodies.map((b) => b.kind)).toEqual(["message", "edit", "delete", "reaction_add"])
    expect(bodies[0]).toMatchObject({
      thread_id: "100.000001",
      message_id: "101.000001",
      delivery_key: "slack:T001:E001"
    })
    expect(bodies[1]).toMatchObject({ body: "edited", version: "102.000001" })
    expect(bodies[2]).toMatchObject({ body: "", version: "103.000001" })
  })

  it("reconciles a lost post after restart without posting twice", async () => {
    let state = "pending"
    let posts = 0
    const receipts: any[] = []
    const delivery = () => ({
      id: 1,
      key: "unique-key",
      issue_id: 42,
      state,
      event: "comment.created",
      payload: { comment: { id: 7, body: "hello" } },
      message_id: "",
      mapping: { connection_id: "slack", provider: "slack", scope_id: "T001", conversation_id: "C001", thread_id: "" }
    })
    const request = async (path: string, init?: RequestInit) => {
      if (path.endsWith("/deliveries")) return Response.json(state === "sent" ? [] : [delivery()])
      if (init?.method === "POST") {
        state = "dispatching"
        return Response.json({ state, token: "claim" })
      }
      const body = JSON.parse(String(init?.body))
      receipts.push(body)
      state = body.state
      return Response.json(body)
    }
    const execute = executor({
      post: async () => {
        posts++
        throw new Error("Slack accepted; response lost")
      }
    })
    await IssueSync.make({ ...options, request, execute }).drain()
    expect(state).toBe("outcome_unknown")
    await IssueSync.make({ ...options, request, execute }).drain()
    await IssueSync.make({ ...options, request, execute }).drain()
    expect(state).toBe("sent")
    expect(posts).toBe(1)
    expect(receipts.at(-1)).toMatchObject({ state: "sent", message_id: "100.000001" })
  })

  it.each(["absent", "inconclusive"] as const)(
    "keeps a crashed claim unknown when reconciliation is %s",
    async (status) => {
      let posts = 0
      const request = async () =>
        Response.json([{
          id: 1,
          key: "unique-key",
          issue_id: 42,
          state: "dispatching",
          event: "comment.created",
          payload: { comment: { id: 7, body: "hello" } },
          message_id: "",
          mapping: {
            connection_id: "slack",
            provider: "slack",
            scope_id: "T001",
            conversation_id: "C001",
            thread_id: ""
          }
        }])
      const execute = executor({
        post: async (p) => {
          posts++
          return { ...p, ts: "100.000001" }
        },
        reconcile: async (p) => ({ ...p, status, ts: null, pagesSearched: 1 })
      })
      expect(await IssueSync.make({ ...options, request, execute }).drain()).toBe(0)
      expect(posts).toBe(0)
    }
  )

  it("hands committed ingress to durable host dispatch with the same key on replay", async () => {
    const received: string[] = []
    const bridge = IssueSync.make({
      ...options,
      request: async () => Response.json({ issue_id: 42 }),
      execute: executor(),
      onMessage: async ({ issueId, event }) => {
        expect(issueId).toBe(42)
        received.push(event.dedupeKey)
      }
    })
    const event = callback({ type: "message", channel: "C001", ts: "100.000001", user: "U001", text: "human" })
    await bridge.ingest(event)
    await bridge.ingest(event)
    expect(received).toEqual(["slack:T001:E001", "slack:T001:E001"])
  })
})

const row = (patch: any = {}) => ({
  id: 1,
  key: "key-1",
  issue_id: 42,
  state: "pending",
  event: "comment.created",
  payload: { comment: { id: 7, body: "hello", persona: { username: "Builder" } } },
  message_id: "100.000001",
  mapping: {
    connection_id: "slack",
    provider: "slack",
    scope_id: "T001",
    conversation_id: "C001",
    thread_id: "100.000001"
  },
  ...patch
})
const drainFixture = (
  rows: any[],
  execute = executor(),
  extra: Partial<IssueSync.Options> = {},
  claim: unknown = { state: "dispatching", token: "token" }
) => {
  const receipts: any[] = []
  const requests: string[] = []
  const sync = IssueSync.make({
    ...options,
    execute,
    request: async (path, init) => {
      requests.push(`${init?.method} ${path}`)
      if (path.endsWith("/deliveries")) return Response.json(rows)
      if (init?.method === "POST") return Response.json(claim)
      receipts.push(JSON.parse(String(init?.body)))
      return Response.json({})
    },
    ...extra
  })
  return { sync, receipts, requests }
}
it.each(["comment.created", "comment.edited", "comment.deleted", "comment.reaction"])(
  "delivers %s using the current mapping",
  async (event) => {
    const calls: any[] = []
    const capture = async (p: any) => {
      calls.push(p)
      return { ...p, ts: "100.000001", status: "applied" as const }
    }
    const { sync, receipts } = drainFixture([
      row({
        event,
        payload: { comment: { id: 7, persona: { username: "Builder" } }, reaction: { name: "eyes", active: false } }
      })
    ], executor({ post: capture, update: capture, delete: capture, react: capture }))
    expect(await sync.drain()).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ connectionId: "slack", channel: "C001" })
    if (event === "comment.created") {
      expect(calls[0]).toMatchObject({
        threadTs: "100.000001",
        persona: { username: "Builder" },
        text: ""
      })
    }
    expect(receipts).toEqual([{ state: "sent", token: "token", message_id: "100.000001" }])
  }
)
it("persists missing reaction scope and keeps later deliveries moving", async () => {
  const { sync, receipts } = drainFixture([
    row({ event: "comment.reaction", payload: { comment: { id: 7 }, reaction: { name: "eyes", active: true } } }),
    row({ id: 2 })
  ], executor({ react: async () => ({ status: "unsupported" }) }))
  expect(await sync.drain()).toBe(2)
  expect(receipts[0]).toMatchObject({ state: "unsupported", error: "Slack reactions:write scope missing" })
})
it.each(["comment.edited", "unknown", "comment.reaction"])(
  "retains unresolved %s instead of guessing a successful delivery",
  async (event) => {
    const { sync, receipts } = drainFixture([
      row({ event, ...(event === "comment.edited" ? { message_id: "" } : {}) })
    ])
    expect(await sync.drain()).toBe(0)
    expect(receipts[0].state).toBe("outcome_unknown")
  }
)
it.each([undefined, false, true])(
  "distinguishes known refusal from unknown provider failure (%s)",
  async (outcomeUnknown) => {
    const { IntegrationFailure } = await import("../src/core/ActionFailure.ts")
    const failure = new IntegrationFailure({
      reason: "permission-denied",
      message: "scope missing",
      retryable: false,
      ...(outcomeUnknown === undefined ? {} : { outcomeUnknown })
    })
    const { sync, receipts } = drainFixture(
      [row()],
      executor({
        post: async () => {
          throw { cause: { error: failure } }
        }
      })
    )
    await sync.drain()
    expect(receipts[0]).toMatchObject({
      state: outcomeUnknown === true ? "outcome_unknown" : "failed",
      error: "scope missing"
    })
  }
)
it("handles cyclic foreign errors without leaking their content", async () => {
  const error: any = {}
  error.cause = error
  const { sync, receipts } = drainFixture(
    [row()],
    executor({
      post: async () => {
        throw error
      }
    })
  )
  await sync.drain()
  expect(receipts[0]).toMatchObject({
    state: "outcome_unknown",
    error: "Delivery did not settle; reconcile before retrying"
  })
})
it("ignores foreign connections, teams, and channels and does not replay unknown edits", async () => {
  const base = row()
  const { sync, requests } = drainFixture([
    row({ mapping: { ...base.mapping, connection_id: "other" } }),
    row({ id: 2, mapping: { ...base.mapping, scope_id: "OTHER" } }),
    row({ id: 3, mapping: { ...base.mapping, conversation_id: "C999" } }),
    row({ id: 4, state: "outcome_unknown", event: "comment.edited" })
  ])
  expect(await sync.drain()).toBe(0)
  expect(requests.every((r) => r.startsWith("GET"))).toBe(true)
})
it.each([null, { state: "pending" }, { state: "dispatching", token: 1 }])("refuses a lost claim %s", async (claim) => {
  const { sync, receipts } = drainFixture([row()], executor(), {}, claim)
  expect(await sync.drain()).toBe(0)
  expect(receipts).toEqual([])
})
it("skips a delivery completed by another worker", async () => {
  let reads = 0
  const { sync } = drainFixture([], executor(), { request: async () => Response.json(++reads === 1 ? [row()] : []) })
  expect(await sync.drain()).toBe(0)
})
it("admits user DMs without assigning a Slack thread timestamp", async () => {
  const calls: any[] = []
  const { sync } = drainFixture(
    [row({ mapping: { ...row().mapping, conversation_id: "D001", thread_id: "dm:U001" } })],
    executor({
      post: async (p) => {
        calls.push(p)
        return { ...p, ts: "100.000001" }
      }
    }),
    { policy: { allowedTeamIds: ["T001"], allowedUserIds: ["U001"] } }
  )
  expect(await sync.drain()).toBe(1)
  expect(calls[0]).not.toHaveProperty("threadTs")
})
it("does not admit arbitrary DMs under channel-only policy", async () => {
  const { sync } = drainFixture([row({ mapping: { ...row().mapping, conversation_id: "D001" } })], executor(), {
    policy: { allowedTeamIds: ["T001"], allowedChannelIds: ["C001"] }
  })
  expect(await sync.drain()).toBe(0)
})
it("reconciles a thread and rejects HTTP failures", async () => {
  const { sync, receipts } = drainFixture([row({ state: "dispatching" })])
  expect(await sync.drain()).toBe(1)
  expect(receipts[0]).toMatchObject({ state: "sent", token: "" })
  const { sync: broken } = drainFixture([], executor(), { request: async () => new Response(null, { status: 403 }) })
  await expect(broken.drain()).rejects.toThrow("HTTP 403")
})
it("normalizes mentions, removed reactions and ignores non-message events", async () => {
  const bodies: any[] = []
  const bridge = IssueSync.make({
    ...options,
    execute: executor(),
    request: async (_, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({})
    }
  })
  expect(
    await bridge.ingest(callback({ type: "app_mention", channel: "C001", user: "U001", ts: "100.000001", text: "hi" }))
  ).toBe("applied")
  expect(
    await bridge.ingest(
      callback({
        type: "reaction_removed",
        user: "U001",
        event_ts: "101.000001",
        reaction: "eyes",
        item: { type: "message", channel: "C001", ts: "100.000001" }
      })
    )
  ).toBe("applied")
  expect(
    await bridge.ingest(callback({ type: "reaction_added", channel: "C001", user: "U001", item: { type: "file" } }))
  ).toBe("ignored")
  expect(await bridge.ingest(callback({ type: "reaction_added", channel: "C001", user: "U001" }))).toBe("ignored")
  expect(await bridge.ingest(callback({ type: "typing", channel: "C001", user: "U001" }))).toBe("ignored")
  expect(
    await bridge.ingest(
      callback({ type: "message", subtype: "message_changed", channel: "C001", user: "U001", ts: "100.000001" })
    )
  ).toBe("ignored")
  expect(
    await bridge.ingest({
      type: "block_actions",
      team: { id: "T001" },
      user: { id: "U001" },
      channel: { id: "C001" },
      trigger_id: "trigger",
      actions: []
    })
  ).toBe("ignored")
  expect(bodies.map((b) => b.kind)).toEqual(["message", "reaction_remove"])
})
it("uses SocketSource's existing acknowledged batch runner", async () => {
  const { Effect } = await import("effect")
  const bodies: unknown[] = []
  const sync = IssueSync.make({
    ...options,
    execute: executor(),
    request: async (_, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ issue_id: 42 })
    }
  })
  const source = {
    run: (handle: any) =>
      handle([{ payload: callback({ type: "message", channel: "C001", user: "U001", ts: "100.000001", text: "hi" }) }])
  }
  await Effect.runPromise(sync.run(source as any))
  expect(bodies).toHaveLength(1)
})
it.each([null, { issue_id: "42" }])("does not wake the host for an invalid commit receipt %s", async (receipt) => {
  let wakes = 0
  const bridge = IssueSync.make({
    ...options,
    execute: executor(),
    request: async () => Response.json(receipt),
    onMessage: async () => {
      wakes++
    }
  })
  await bridge.ingest(callback({ type: "message", channel: "C001", user: "U001", ts: "100.000001", text: "hi" }))
  expect(wakes).toBe(0)
})
it("refuses a deletion without its author-bearing previous message", async () => {
  const { sync, requests } = drainFixture([])
  expect(
    await sync.ingest(
      callback({
        type: "message",
        subtype: "message_deleted",
        channel: "C001",
        user: "U001",
        ts: "102.000001",
        deleted_ts: "100.000001"
      })
    )
  ).toBe("ignored")
  expect(requests).toEqual([])
})
it("drains later pages even when an earlier page belongs to another connection", async () => {
  const blocked = Array.from(
    { length: 100 },
    (_, n) => row({ id: n + 1, mapping: { ...row().mapping, connection_id: "other" } })
  )
  let posted = 0
  const sync = IssueSync.make({
    ...options,
    execute: executor({
      post: async (p) => {
        posted++
        return { ...p, ts: "100.000001" }
      }
    }),
    request: async (path, init) => {
      if (path.endsWith("/deliveries")) return Response.json(blocked)
      if (path.endsWith("?after_id=100")) return Response.json([row({ id: 101 })])
      return Response.json(init?.method === "POST" ? { state: "dispatching", token: "claim" } : {})
    }
  })
  expect(await sync.drain()).toBe(1)
  expect(posted).toBe(1)
})
it("rejects a backend cursor that does not advance", async () => {
  const { sync } = drainFixture([], executor(), {
    request: async () => Response.json(Array.from({ length: 100 }, () => row()))
  })
  await expect(sync.drain()).rejects.toThrow("cursor did not advance")
})
