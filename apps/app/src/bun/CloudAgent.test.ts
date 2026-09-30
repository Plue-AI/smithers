import { describe, expect, test } from "bun:test"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import type { Card } from "@smthrs/rpc/Cards"
import type { AgentToolSpec, AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { createHash } from "node:crypto"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import { CLOUD_CHAT_SIGN_IN, createCloudAgent } from "./CloudAgent"

const API = "https://backend.test"
const HASH = "0".repeat(64)

const request: StartAgentTurnRequest = {
  runId: "run-1",
  messages: [{ role: "user", content: "Hello who are you" }],
  instructions: "Be brief."
}

interface Sent {
  readonly url: string
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

const sentOf = (input: Parameters<FetchLike>[0], init: Parameters<FetchLike>[1]): Sent => ({
  url: String(input),
  headers: new Headers(init?.headers),
  body: JSON.parse(String(init?.body)) as Record<string, unknown>
})

/** The backend's journal delivery stream for the leg the agent sent: accepted, one batch per frame, then `tail`. */
const deliveries = (sent: Sent, frames: ReadonlyArray<Record<string, unknown>>, tail: ReadonlyArray<unknown> = [],
  stream?: { readonly open: boolean }): Response => {
  const runId = String(sent.body.runId)
  const legId = String((sent.body.journal as { legId: string }).legId)
  const cursor = (batch: number) => ({ version: 1, runId, legId, batch, position: batch, hash: HASH })
  const lines: Array<unknown> = [{ type: "accepted", cursor: cursor(0) }, ...frames.map((frame, index) => ({
    type: "batch",
    batch: { version: 1, runId, legId, batch: index + 1, from: index + 1, previousHash: HASH, frames: [{ ...frame, runId }], hash: HASH },
    cursor: cursor(index + 1)
  })), ...tail]
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const line of lines) controller.enqueue(encoder.encode(`${typeof line === "string" ? line : JSON.stringify(line)}\n`))
      if (stream?.open !== true) controller.close()
    }
  }), { status: 200, headers: { "content-type": "application/x-ndjson", "x-smithers-turn-journal": "1" } })
}

const backend = (frames: ReadonlyArray<Record<string, unknown>>, tail?: ReadonlyArray<unknown>) => {
  const sent: Array<Sent> = []
  const fetchImpl: FetchLike = async (input, init) => {
    const one = sentOf(input, init)
    sent.push(one)
    return one.url.endsWith("/api/agent/turn") ? deliveries(one, frames, tail) : Response.json({ status: "ok" })
  }
  return { sent, fetchImpl }
}

const signedIn = { api: API, token: () => "cloud-token" }

/** The erase body for a leg: its identity and the hash of its replay capability. */
const legErasure = (leg: { runId: string; journal: { legId: string; token: string } }) => ({
  runId: leg.runId, legId: leg.journal.legId,
  retirementProof: createHash("sha256").update(agentTurnJournalDigestInput("access", leg.journal.token)).digest("hex")
})

/*
 * Turn streaming settles on the event loop, not on a wall clock: pump
 * macrotask turns until the predicate holds. The mocked streams enqueue
 * synchronously and every Effect step is promise-driven, so a settled turn is
 * observable within a bounded number of turns — a fixed setTimeout raced a
 * loaded machine instead.
 */
const until = async (predicate: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`the turn never settled: ${what}`)
}

/** A bounded number of event-loop turns, for assertions that something does NOT happen. */
const drain = async (turns = 50): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const toolSpec: AgentToolSpec = {
  type: "function",
  name: "commands",
  description: "Run an app command.",
  parameters: { type: "object", properties: {}, additionalProperties: false }
}

const context: AgentRuntimeContext = {
  version: 1,
  product: "smithers",
  capturedAt: 1786223000000,
  revision: 3,
  surface: "world",
  theme: "light",
  selectedWorldDocument: "Notes.md",
  connectors: [],
  github: { connected: false, login: null, repositories: null },
  worldState: { documentCount: 1, documents: [{ path: "Notes.md", title: "Notes", confidence: 1 }] },
  capabilities: ["Hold a streaming conversation in this chat and read its visible transcript."],
  limitations: ["Cannot see or control the host environment beyond what this context block states."]
}

describe("createCloudAgent on the backend turn contract", () => {
  test("sends the turn to the backend's /api/agent/turn as the signed-in Cloud user, on a fresh leg", async () => {
    const { sent, fetchImpl } = backend([{ type: "done" }])
    const frames: Array<AgentTurnFrame> = []
    const agent = createCloudAgent((frame) => frames.push(frame), { api: `${API}/ignored/path`, token: () => "cloud-token", fetchImpl })
    const full: StartAgentTurnRequest = {
      ...request,
      journal: { version: 1, legId: "renderer-leg", token: "renderer_private_capability_12345678901234" },
      context,
      tools: [toolSpec],
      tier: "cheap",
      purpose: "recommend",
      role: "explainer"
    }
    expect(agent.start(full)).toEqual({ status: "started" })
    await until(() => frames.length === 1, "the first turn")
    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => frames.length === 2, "the second turn")

    const turns = sent.filter((one) => one.url === `${API}/api/agent/turn`)
    expect(turns).toHaveLength(2)
    expect(turns.map((one) => one.headers.get("authorization"))).toEqual(["Bearer cloud-token", "Bearer cloud-token"])
    const [first, second] = turns.map((one) => one.body)
    // The backend composes the runtime context server-side; the turn rides as sent.
    expect(first).toMatchObject({ messages: full.messages, instructions: "Be brief.", context, tools: [toolSpec], tier: "cheap", purpose: "recommend", role: "explainer" })
    expect(second && ["context", "tools", "tier", "purpose", "role"].some((key) => key in second)).toBe(false)
    // Each leg is its own backend run and journal, never the caller's (a continuation re-POSTs its run id).
    for (const body of [first, second]) {
      expect(body?.runId).not.toBe(request.runId)
      const journal = body?.journal as { version: number; legId: string; token: string }
      expect(journal.version).toBe(1)
      expect(journal.legId).not.toBe("renderer-leg")
      expect(journal.token).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
    }
    expect(first?.runId).not.toBe(second?.runId)
    expect((first?.journal as { legId: string }).legId).not.toBe((second?.journal as { legId: string }).legId)
    expect(frames).toEqual([{ runId: "run-1", type: "done" }, { runId: "run-1", type: "done" }])
  })

  test("publishes each committed batch's frames on the caller's run, cards included", async () => {
    const planCard: Card = {
      id: "card-plan", kind: "plan", title: "Ship the MVP", status: "active", createdAt: 1, ordinal: 1,
      payload: { items: [{ id: "item-1", title: "Wave 1", status: "active" }] }
    }
    const sent: Array<Sent> = []
    const frames: Array<AgentTurnFrame> = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      ...signedIn,
      fetchImpl: async (input, init) => {
        const one = sentOf(input, init)
        sent.push(one)
        return deliveries(one, [
          { type: "delta", kind: "reasoning", text: "hmm" },
          { type: "delta", kind: "text", text: "Hello!" },
          { type: "card", card: planCard },
          { type: "card", card: { id: "card-approve", kind: "approval", title: "Approve", status: "active", createdAt: 1, ordinal: 2,
            payload: { runId: one.body.runId, capability: "read" } } },
          { type: "card.update", id: "card-plan", patch: { kind: "plan", status: "acted" } },
          { type: "tool_call", call_id: "call-1", name: "commands", arguments: "{\"command\":\"world.new-note\"}" },
          { type: "done", reason: "tool_call" }
        ])
      }
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => frames.some((frame) => frame.type === "done"), "the done frame")
    expect(frames.every((frame) => frame.runId === "run-1")).toBe(true)
    expect(frames.map((frame) => frame.type)).toEqual(["delta", "delta", "card", "card", "card.update", "tool_call", "done"])
    expect(frames[2]).toEqual({ runId: "run-1", type: "card", card: planCard })
    // An approval names the run the transcript knows, never the backend leg's.
    expect(frames[3]?.type === "card" && frames[3].card.kind === "approval" ? frames[3].card.payload.runId : undefined).toBe("run-1")
    expect(frames[5]).toEqual({ runId: "run-1", type: "tool_call", call_id: "call-1", name: "commands", arguments: "{\"command\":\"world.new-note\"}" })
    expect(frames[6]).toEqual({ runId: "run-1", type: "done", reason: "tool_call" })
  })

  test("a terminal catch-up without a done frame settles the turn once", async () => {
    const frames: Array<AgentTurnFrame> = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      ...signedIn,
      fetchImpl: async (input, init) => {
        const one = sentOf(input, init)
        const cursor = { version: 1, runId: one.body.runId, legId: (one.body.journal as { legId: string }).legId, batch: 1, position: 1, hash: HASH }
        return deliveries(one, [{ type: "delta", kind: "text", text: "hi" }], [
          { type: "caught-up", cursor: { ...cursor, runId: "another-run" }, terminal: true },
          { type: "caught-up", cursor, terminal: false },
          { type: "caught-up", cursor, terminal: true },
          { type: "caught-up", cursor, terminal: true }
        ])
      }
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => frames.some((frame) => frame.type === "done"), "the terminal catch-up")
    await drain()
    expect(frames).toEqual([{ runId: "run-1", type: "delta", kind: "text", text: "hi" }, { runId: "run-1", type: "done" }])
  })

  test("drops malformed lines, foreign runs and invalid frames; a stream that ends without a terminal is a failure", async () => {
    const frames: Array<AgentTurnFrame> = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      ...signedIn,
      fetchImpl: async (input, init) => {
        const one = sentOf(input, init)
        const foreign = { ...one, body: { ...one.body, runId: "another-run" } }
        const text = await deliveries(foreign, [{ type: "delta", kind: "text", text: "not mine" }]).text()
        return deliveries(one, [{ type: "delta", kind: "text", text: "mine" }, { type: "done", reason: "made-up" }], ["{not json", "", ...text.trim().split("\n")])
      }
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => frames.some((frame) => frame.type === "done"), "the failure")
    expect(frames).toEqual([
      { runId: "run-1", type: "delta", kind: "text", text: "mine" },
      { runId: "run-1", type: "done", error: "The response stream ended before Smithers finished the turn." }
    ])
  })

  test("an HTTP refusal is the turn's error, with the backend's own detail", async () => {
    const frames: Array<AgentTurnFrame> = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      ...signedIn,
      fetchImpl: async () => Response.json({ status: "error", code: "forbidden" }, { status: 403 })
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => frames.some((frame) => frame.type === "done"), "the error frame")
    expect(frames).toEqual([{ runId: "run-1", type: "done", error: "Smithers Cloud chat failed (HTTP 403): {\"status\":\"error\",\"code\":\"forbidden\"}" }])
  })

  test("a 200 that is not a turn stream (an existing leg's JSON) is refused, not read", async () => {
    const frames: Array<AgentTurnFrame> = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      ...signedIn,
      fetchImpl: async () => Response.json({ status: "existing" })
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => frames.some((frame) => frame.type === "done"), "the error frame")
    expect(frames).toEqual([{ runId: "run-1", type: "done", error: "Smithers Cloud returned no response stream." }])
  })

  test("a transport failure is the turn's error", async () => {
    const frames: Array<AgentTurnFrame> = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      ...signedIn,
      fetchImpl: async () => { throw new Error("connect ECONNREFUSED") }
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => frames.some((frame) => frame.type === "done"), "the error frame")
    expect(frames).toEqual([{ runId: "run-1", type: "done", error: "connect ECONNREFUSED" }])
  })

  test("signed out, a turn is refused by code before any request leaves the host", () => {
    let calls = 0
    const agent = createCloudAgent(() => {}, { api: API, token: () => undefined, fetchImpl: async () => { calls += 1; return new Response(null) } })
    const started = agent.start(request)
    expect(started).toEqual({ status: "error", message: CLOUD_CHAT_SIGN_IN, refusal: { code: "sign_in_required", message: CLOUD_CHAT_SIGN_IN, retryAt: null } })
    expect(calls).toBe(0)
    // Nothing was registered: the run is free for the turn after sign-in.
    expect(agent.cancel("run-1")).toEqual({ status: "not-found" })
  })

  test("rejects a duplicate runId while a turn is active", () => {
    const agent = createCloudAgent(() => {}, {
      ...signedIn,
      fetchImpl: async (input, init) => deliveries(sentOf(input, init), [], [], { open: true })
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    expect(agent.start(request).status).toBe("error")
  })

  test("cancel interrupts the turn locally, cancels and erases the backend leg, and reports not-found otherwise", async () => {
    const sent: Array<Sent> = []
    const frames: Array<AgentTurnFrame> = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      api: API,
      token: () => "cloud-token",
      fetchImpl: async (input, init) => {
        const one = sentOf(input, init)
        sent.push(one)
        return one.url.endsWith("/api/agent/turn") ? deliveries(one, [], [], { open: true }) : Response.json({ status: "ok" })
      }
    })
    expect(agent.cancel("run-1")).toEqual({ status: "not-found" })
    expect(sent).toHaveLength(0)
    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => sent.length === 1, "the turn request")
    expect(agent.cancel("run-1")).toEqual({ status: "cancelled" })
    await until(() => sent.length === 3, "the backend cancel and erase")
    const leg = sent[0]!.body as { runId: string; journal: { legId: string; token: string } }
    expect(sent[1]).toMatchObject({ url: `${API}/api/agent/turn/cancel`, body: { runId: leg.runId } })
    expect(sent[1]?.headers.get("authorization")).toBe("Bearer cloud-token")
    expect(sent[2]).toMatchObject({ url: `${API}/api/agent/turn/erase`, body: legErasure(leg) })
    // Erasure is authorized by the proof alone, never the session.
    expect(sent[2]?.headers.get("authorization")).toBeNull()
    await drain()
    expect(frames.some((frame) => frame.type === "done" && frame.error !== undefined)).toBe(false)
  })

  test("a finished leg is erased without a cancel; a stream cut short is cancelled then erased; a refused leg is left alone", async () => {
    for (const [name, respond, expected] of [
      ["finished", (one: Sent) => deliveries(one, [{ type: "done" }]), ["erase"]],
      ["cut short", (one: Sent) => deliveries(one, [{ type: "delta", kind: "text", text: "partial" }]), ["cancel", "erase"]],
      ["refused", () => Response.json({ status: "error", code: "forbidden" }, { status: 403 }), []]
    ] as const) {
      const sent: Array<Sent> = []
      const frames: Array<AgentTurnFrame> = []
      const agent = createCloudAgent((frame) => frames.push(frame), {
        ...signedIn,
        fetchImpl: async (input, init) => {
          const one = sentOf(input, init)
          sent.push(one)
          return one.url.endsWith("/api/agent/turn") ? respond(one) : Response.json({ status: "ok" })
        }
      })
      expect(agent.start(request)).toEqual({ status: "started" })
      await until(() => frames.some((frame) => frame.type === "done"), name)
      await until(() => sent.length === 1 + expected.length, `${name}: the release`)
      await drain()
      expect(sent.slice(1).map((one) => one.url.split("/").at(-1))).toEqual([...expected])
      const leg = sent[0]!.body as { runId: string; journal: { legId: string; token: string } }
      if (expected.length > 0) expect(sent.at(-1)?.body).toEqual(legErasure(leg))
    }
  })

  test("a failed backend cancel or erase is not the caller's failure", async () => {
    const agent = createCloudAgent(() => {}, {
      ...signedIn,
      fetchImpl: async (input, init) => {
        const one = sentOf(input, init)
        if (!one.url.endsWith("/api/agent/turn")) throw new Error("offline")
        return deliveries(one, [], [], { open: true })
      }
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    await drain()
    expect(agent.cancel("run-1")).toEqual({ status: "cancelled" })
    await drain()
  })

  test("cancel releases the turn's response stream (scoped transport)", async () => {
    let streamCancelled = false
    let readerActive = false
    const agent = createCloudAgent(() => {}, {
      ...signedIn,
      fetchImpl: async (input) => !String(input).endsWith("/api/agent/turn") ? Response.json({}) : new Response(
        new ReadableStream<Uint8Array>({
          start: () => {},
          /* pull() fires only once the turn has acquired its reader. */
          pull: () => { readerActive = true },
          cancel: () => { streamCancelled = true }
        }),
        { status: 200, headers: { "content-type": "application/x-ndjson" } }
      )
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => readerActive, "the turn to acquire its reader")
    expect(agent.cancel("run-1")).toEqual({ status: "cancelled" })
    await until(() => streamCancelled, "the stream's own cancel")
  })

  test("a cancelled turn's teardown does not deregister the turn that replaced it", async () => {
    /*
     * The teardown runs after `cancel` already dropped the entry, so by then
     * the same run id can hold a replacement turn. Deleting by run id evicted
     * that live turn: it answered `not-found` to cancel and a second `start`
     * for it was permitted, leaving two fibers streaming one run.
     */
    const agent = createCloudAgent(() => {}, {
      ...signedIn,
      fetchImpl: async (input, init) => !String(input).endsWith("/api/agent/turn") ? Response.json({}) : deliveries(sentOf(input, init), [], [], { open: true })
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    await drain()
    expect(agent.cancel("run-1")).toEqual({ status: "cancelled" })
    expect(agent.start(request)).toEqual({ status: "started" })
    await drain()
    expect(agent.cancel("run-1")).toEqual({ status: "cancelled" })
  })
})
