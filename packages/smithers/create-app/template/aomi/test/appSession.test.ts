/**
 * `AppSession` itself, over real SQLite.
 *
 * `worker.test.ts` drives the router against an in-memory double, so the
 * Durable Object's own contract, what it writes, what it reads back, and what
 * survives an eviction, is proven here and nowhere else. The object is the
 * real class from `worker/AppSession.ts`, constructed by
 * `test/support/durableObject.ts` over a `node:sqlite` database per name.
 *
 * A turn is a real run: the seat replays the committed chat fixture, cells run
 * on the Node QuickJS build, and the chain is the deterministic mock. It writes
 * the user message, the card the model painted, and the answer, and settles the
 * session's row in the registry. A flow run answers from a scripted cell,
 * because what it proves is the card and the row, not a model's plan.
 */
import * as Schema from "effect/Schema"
import { describe, expect, it, vi } from "vitest"
import {
  type AppCard,
  SessionState,
  type TurnFrame,
  TurnFrame as TurnFrameSchema,
  UNKNOWN_FAILURE_SENTENCE
} from "../src/api.ts"
import { INDEX_SESSION } from "../worker/registry.ts"
import { durableObjects } from "./support/durableObject.ts"
import { fixtures, nodeHost, recordedHost, scriptedSeat } from "./support/recordedHost.ts"

const chat = recordedHost(fixtures.chat)

/** A build run that returns a plan with two stages, one of them still running. */
const plan = nodeHost(scriptedSeat(`await ctx.done({
  name: "arb",
  summary: "An arbitrage scanner.",
  files: [{ path: "app/pages/index.tsx", purpose: "The scanner page" }],
  steps: [{ name: "describe", status: "done" }, { name: "validate", status: "running" }]
})`))

const html = (id: string, html = `<p>${id}</p>`): AppCard => ({ kind: "html", id, html })

const frames = async (response: Response): Promise<Array<TurnFrame>> => {
  const text = await response.text()
  return text.trim().split("\n").map((line) => Schema.decodeUnknownSync(TurnFrameSchema)(JSON.parse(line)))
}

describe("AppSession storage", () => {
  it("a new session is empty, decodes as a SessionState, and is not busy", () => {
    const state = durableObjects().session("s1").state("s1")
    expect(Schema.decodeUnknownSync(SessionState)(state)).toEqual({
      id: "s1",
      messages: [],
      cards: [],
      entries: [],
      busy: false
    })
  })

  it("reads back what it wrote, in write order across messages and cards", () => {
    const session = durableObjects().session("s1")
    const first = session.appendMessage("user", "hello")
    session.appendCard(html("c1"))
    const second = session.appendMessage("assistant", "hi")
    const state = session.state("s1")
    expect(state.messages).toEqual([first, second])
    expect(state.cards).toEqual([html("c1")])
    expect(state.entries).toEqual([
      { kind: "message", messageId: first.id },
      { kind: "card", cardId: "c1" },
      { kind: "message", messageId: second.id }
    ])
  })

  it("keeps every row and drops every transient field when the object is recreated", async () => {
    const app = durableObjects({}, chat)
    const before = app.session("s1")
    before.appendMessage("user", "hello")
    before.appendCard(html("c1"))
    before.writeFlow("arb", "arb scan", { "flow.ts": "export {}" })
    expect((await before.turn({ sessionId: "s1", flowId: "chat", message: "again" })).status).toBe(200)
    expect(before.state("s1").busy).toBe(true)

    const after = app.recreate("s1")
    expect(after).not.toBe(before)
    expect(after.state("s1")).toMatchObject({ ...before.state("s1"), busy: false })
    expect(after.state("s1").busy).toBe(false)
    expect(after.listFlows()).toEqual([{ id: "arb", description: "arb scan", source: "saved", chat: false }])
    expect(after.flowFiles("arb")).toEqual({ "flow.ts": "export {}" })
    // Nothing of the old instance's in-flight turn is left to cancel.
    expect(after.cancel("s1")).toEqual({ cancelled: false })
  })

  it("a card written again under its id keeps its place and takes the new content", () => {
    const session = durableObjects().session("s1")
    session.appendCard(html("c1", "<p>v1</p>"))
    const message = session.appendMessage("user", "hello")
    session.appendCard(html("c2"))
    session.appendCard(html("c1", "<p>v2</p>"))
    const state = session.state("s1")
    expect(state.cards).toEqual([html("c1", "<p>v2</p>"), html("c2")])
    expect(state.entries).toEqual([
      { kind: "card", cardId: "c1" },
      { kind: "message", messageId: message.id },
      { kind: "card", cardId: "c2" }
    ])
  })

  it("two sessions never see each other's rows", () => {
    const app = durableObjects()
    app.session("s1").appendMessage("user", "one")
    app.session("s1").writeFlow("arb", "arb scan", {})
    app.session("s2").appendCard(html("c2"))
    expect(app.session("s1").state("s1").cards).toEqual([])
    expect(app.session("s2").state("s2").messages).toEqual([])
    expect(app.session("s2").listFlows()).toEqual([])
    expect(app.session("s2").flowFiles("arb")).toBeUndefined()
  })

  it("a row that no longer decodes is dropped from the state and from the order", () => {
    const app = durableObjects()
    const session = app.session("s1")
    const message = session.appendMessage("user", "hello")
    session.appendCard(html("c1"))
    const db = app.database("s1")
    db.prepare("INSERT INTO cards (id, json, at, seq) VALUES (?, ?, ?, ?)").run("bad", "{\"kind\":\"no-such", 1, 3)
    db.prepare("INSERT INTO messages (id, role, text, at, seq) VALUES (?, ?, ?, ?, ?)").run("tool", "tool", "x", 1, 4)
    const second = session.appendMessage("assistant", "hi")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const state = Schema.decodeUnknownSync(SessionState)(session.state("s1"))
      expect(state.messages).toEqual([message, second])
      expect(state.cards).toEqual([html("c1")])
      expect(state.entries).toEqual([
        { kind: "message", messageId: message.id },
        { kind: "card", cardId: "c1" },
        { kind: "message", messageId: second.id }
      ])
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it("a write that fails leaves the earlier rows and the next write untouched", () => {
    const app = durableObjects()
    const session = app.session("s1")
    const first = session.appendMessage("user", "hello")
    app.failNext("s1", "SQLITE_FULL")
    expect(() => session.appendMessage("assistant", "hi")).toThrow("SQLITE_FULL")
    const second = session.appendMessage("assistant", "hi")
    expect(session.state("s1").messages).toEqual([first, second])
    expect(session.state("s1").entries).toEqual([
      { kind: "message", messageId: first.id },
      { kind: "message", messageId: second.id }
    ])
  })

  it("orders the rows an older build wrote by timestamp, then table position, then kind", () => {
    const app = durableObjects()
    const db = app.database("s1")
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE cards (id TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);
      INSERT INTO messages VALUES ('m2', 'assistant', 'hi', 20);
      INSERT INTO messages VALUES ('m1', 'user', 'hello', 10);
      INSERT INTO cards VALUES ('c1', '{"kind":"html","id":"c1","html":"<p>c1</p>"}', 20);
    `)
    const state = app.session("s1").state("s1")
    expect(state.entries).toEqual([
      { kind: "message", messageId: "m1" },
      { kind: "card", cardId: "c1" },
      { kind: "message", messageId: "m2" }
    ])
    // The migration runs once: a later write continues the sequence it built.
    const next = app.recreate("s1").appendMessage("user", "more")
    expect(app.session("s1").state("s1").entries?.at(-1)).toEqual({ kind: "message", messageId: next.id })
  })
})

describe("AppSession turns", () => {
  const request = { sessionId: "s1", flowId: "chat", message: "What is vitalik.eth's ETH balance on mainnet?" }

  it("persists each turn's transcript and card, and settles the registry row", async () => {
    const app = durableObjects({}, chat)
    const session = app.session("s1")
    const first = await frames(await session.turn(request))
    expect(first.at(-1)?.type).toBe("done")
    // The same question again: the fixture replays one recorded turn.
    const second = await frames(await session.turn(request))
    expect(second.at(-1)?.type).toBe("done")
    await app.settled()

    const state = Schema.decodeUnknownSync(SessionState)(app.recreate("s1").state("s1"))
    expect(state.busy).toBe(false)
    const answers = [first, second].map((turn) => {
      const done = turn.at(-1) as Extract<TurnFrame, { type: "done" }>
      return (done.output as { answer: string }).answer
    })
    expect(state.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", request.message],
      ["assistant", answers[0]],
      ["user", request.message],
      ["assistant", answers[1]]
    ])
    const painted = [...first, ...second].flatMap((frame) => (frame.type === "card" ? [frame.card] : []))
    expect(painted).toHaveLength(2)
    expect(state.cards).toEqual(painted)
    expect(state.entries?.map((entry) => entry.kind)).toEqual([
      "message", "card", "message", "message", "card", "message"
    ])
    expect(app.session(INDEX_SESSION).sessions()).toEqual([
      { id: "s1", title: request.message, status: "ready", stage: "chat", at: expect.any(Number) }
    ])
  })

  it("refuses a turn the host cannot run with a typed 503, writing nothing", async () => {
    const app = durableObjects({}, { ...chat, seats: undefined, evaluator: undefined })
    const session = app.session("s1")
    const response = await session.turn(request)
    expect(response.status).toBe(503)
    const body = await response.json() as { error: string; code: string }
    expect(body.code).toBe("host_unconfigured")
    expect(body.error).toContain("OPENAI_API_KEY")
    await app.settled()
    expect(session.state("s1")).toMatchObject({ messages: [], cards: [], busy: false })
    expect(app.session(INDEX_SESSION).sessions()).toEqual([])
    // The refusal released the session: a configured host takes the next turn.
    session.seams = chat
    expect((await frames(await session.turn(request))).at(-1)?.type).toBe("done")
  })

  it("keeps a host throw's text off the wire and off the flow card", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const broken = {
      ...chat,
      routes: async () => {
        throw new Error("postgres://admin:SYNTHETIC_SECRET@10.0.0.4/app refused the connection")
      }
    }
    const app = durableObjects({}, broken)
    const session = app.session("s1")
    const response = await session.turn(request)
    const body = await response.json() as { error: string }
    expect(body.error).toBe(UNKNOWN_FAILURE_SENTENCE)
    session.runFlow({ sessionId: "s1", flowId: "build", payload: { app: "a", prompt: "p" } })
    await app.settled()
    expect(JSON.stringify(session.state("s1"))).not.toContain("SYNTHETIC_SECRET")
    expect(logged).toHaveBeenCalled()
  })

  it("refuses a second turn while one streams, and takes one after cancel", async () => {
    const app = durableObjects({}, chat)
    const session = app.session("s1")
    const pending = session.turn(request)
    expect((await session.turn(request)).status).toBe(409)
    const streaming = await pending
    expect(streaming.status).toBe(200)
    expect(session.state("s1").busy).toBe(true)

    expect(session.cancel("s1")).toEqual({ cancelled: true })
    const output = await frames(streaming)
    expect(output.at(-1)).toEqual({ type: "error", message: "The turn was cancelled." })
    await app.settled()
    expect(session.state("s1").busy).toBe(false)
    expect(session.cancel("s1")).toEqual({ cancelled: false })
    expect(app.session(INDEX_SESSION).sessions()).toMatchObject([{ id: "s1", status: "idle" }])

    const next = await frames(await session.turn(request))
    expect(next.at(-1)?.type).toBe("done")
    await app.settled()
    expect(app.session(INDEX_SESSION).sessions()).toMatchObject([{ id: "s1", status: "ready" }])
  })

  it("a reader that hangs up frees the session for the next turn", async () => {
    const app = durableObjects({}, chat)
    const session = app.session("s1")
    const streaming = await session.turn(request)
    await streaming.body!.cancel()
    await app.settled()
    expect(session.state("s1").busy).toBe(false)
    expect(session.cancel("s1")).toEqual({ cancelled: false })
    expect((await frames(await session.turn(request))).at(-1)?.type).toBe("done")
  })

  it("a flow run writes one card, replaces it as it settles, and reports the row", async () => {
    const app = durableObjects({}, plan)
    const session = app.session("s1")
    const payload = { app: "arb", prompt: "Scan for arbitrage." }
    const response = session.runFlow({ sessionId: "s1", flowId: "build", payload })
    const executionId = (session.state("s1").cards[0] as { executionId: string }).executionId
    expect(session.state("s1").cards).toEqual([
      { kind: "flow-run", id: executionId, flowId: "build", executionId, phase: "running", steps: [] }
    ])
    await app.settled()
    const updates = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; card: { phase: string } })
    expect(updates.map(({ type, card }) => [type, card.phase])).toEqual([
      ["card.update", "running"], ["card.update", "completed"]
    ])
    const cards = app.recreate("s1").state("s1").cards
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      kind: "flow-run",
      id: executionId,
      phase: "completed",
      // Read from the plan the flow returned, including an unfinished step.
      steps: [{ name: "describe", status: "done" }, { name: "validate", status: "running" }],
      result: { name: "arb" }
    })
    expect(app.session(INDEX_SESSION).sessions()).toMatchObject([{ id: "s1", status: "ready", stage: "build" }])
  })

  it("a flow run the host cannot run settles its card failed with the refusal", async () => {
    const app = durableObjects({}, { ...plan, chain: undefined })
    const session = app.session("s1")
    session.runFlow({ sessionId: "s1", flowId: "build", payload: { app: "a", prompt: "p" } })
    const executionId = (session.state("s1").cards[0] as { executionId: string }).executionId
    await app.settled()
    expect(session.state("s1").cards).toMatchObject([{ id: executionId, phase: "failed" }])
    expect((session.state("s1").cards[0] as { error: string }).error).toContain("TEVM_FORK_RPC_URL")
    expect(app.session(INDEX_SESSION).sessions()).toMatchObject([{ id: "s1", status: "failed" }])
  })

  it("cancel reaches a flow run in flight", async () => {
    const app = durableObjects({}, plan)
    const session = app.session("s1")
    session.runFlow({ sessionId: "s1", flowId: "build", payload: { app: "a", prompt: "p" } })
    const executionId = (session.state("s1").cards[0] as { executionId: string }).executionId
    expect(session.cancel("s1")).toEqual({ cancelled: true })
    await app.settled()
    expect(session.state("s1").cards).toMatchObject([{ id: executionId, phase: "cancelled" }])
    expect(app.session(INDEX_SESSION).sessions()).toMatchObject([{ id: "s1", status: "idle" }])
  })
})

describe("AppSession as the registry", () => {
  const row = (id: string, at: number, status: "ready" | "running" | "failed" | "idle" = "ready") =>
    ({ id, title: `title ${id}`, status, stage: "chat", at }) as const

  it("lists newest first and keeps a session's first title", () => {
    const registry = durableObjects().session(INDEX_SESSION)
    registry.recordSession(row("a", 1))
    registry.recordSession(row("b", 3))
    registry.recordSession({ ...row("a", 5, "idle"), title: "renamed" })
    expect(registry.sessions()).toEqual([
      { id: "a", title: "title a", status: "idle", stage: "chat", at: 5 },
      { id: "b", title: "title b", status: "ready", stage: "chat", at: 3 }
    ])
  })

  it("an older report that arrives late does not overwrite a newer one", () => {
    const registry = durableObjects().session(INDEX_SESSION)
    registry.recordSession(row("a", 10, "ready"))
    registry.recordSession(row("a", 9, "running"))
    expect(registry.sessions()).toEqual([row("a", 10, "ready")])
    registry.recordSession(row("a", 10, "failed"))
    expect(registry.sessions()).toEqual([row("a", 10, "failed")])
  })

  it("survives recreation and keeps only the newest thousand rows, serving one page", () => {
    const app = durableObjects()
    const registry = app.session(INDEX_SESSION)
    for (let index = 1; index <= 1001; index++) registry.recordSession(row(`s${index}`, index))
    const recreated = app.recreate(INDEX_SESSION)
    const page = recreated.sessions()
    expect(page).toHaveLength(100)
    expect(page[0]).toEqual(row("s1001", 1001))
    expect(page[99]).toEqual(row("s902", 902))
    const kept = app.database(INDEX_SESSION).prepare("SELECT id FROM sessions ORDER BY at ASC").all()
    expect(kept).toHaveLength(1000)
    expect(kept[0]).toMatchObject({ id: "s2" })
  })

  it("the registry object never registers itself", async () => {
    const app = durableObjects({}, chat)
    const registry = app.session(INDEX_SESSION)
    await frames(await registry.turn({ sessionId: INDEX_SESSION, flowId: "chat", message: "hello" }))
    await app.settled()
    expect(registry.sessions()).toEqual([])
  })
})
