import { expect, test } from "bun:test"
import { digest } from "@smthrs/core/Digest"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnJournalDelivery } from "@smthrs/rpc/AgentTurnJournal"
import { TURN_PATH, TURN_REPLAY_PATH, TURN_RETIRE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { createWebAgent } from "./WebAgent"
import { AgentJournalIntegrityError } from "../runtime/AgentPort"

const cursor = { version: 1 as const, runId: "turn", legId: "leg", batch: 0, position: 0, hash: "0".repeat(64) }
const request = { runId: "turn", messages: [{ role: "user" as const, content: "Hello" }], instructions: "", journal: { version: 1 as const, legId: "leg", token: "a".repeat(64) } }
const body = { version: 1 as const, runId: "turn", legId: "leg", batch: 1, from: 1, previousHash: cursor.hash,
  frames: [{ type: "delta" as const, runId: "turn", kind: "text" as const, text: "Hello" }] }
const batch = { ...body, hash: digest(agentTurnJournalDigestInput("batch", body)) }
const next = { ...cursor, batch: 1, position: 1, hash: batch.hash }
const until = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); expect(predicate()).toBe(true) }

test("journal delivery waits for its commit subscriber and a disconnected socket produces no synthetic done fact", async () => {
  const calls: unknown[] = [], delivered: AgentTurnJournalDelivery[] = [], frames: unknown[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const agent = createWebAgent({ fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) })
    return new Response([
      JSON.stringify({ type: "accepted", cursor }), JSON.stringify({ type: "batch", batch, cursor: next })
    ].join("\n"), { headers: { "content-type": "application/x-ndjson", "x-smithers-turn-journal": "1" } })
  } })
  agent.subscribe(frame => { frames.push(frame) })
  agent.journal!.subscribe(async delivery => { delivered.push(delivery); if (delivery.type === "accepted") await held })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await until(() => delivered.length === 1)
  expect(delivered[0]?.type).toBe("accepted")
  release(); await until(() => delivered.length === 2)
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(frames).toEqual([])
  expect(calls).toEqual([{ url: TURN_PATH, body: request }])
})

test.each(["batch", "caught-up"] as const)("terminal %s ends journal delivery independent of HTTP chunking", async terminalType => {
  const terminalBody = { ...body, frames: [{ type: "done" as const, runId: "turn" }] }
  const terminalBatch = { ...terminalBody, hash: digest(agentTurnJournalDigestInput("batch", terminalBody)) }
  const terminalCursor = { ...next, hash: terminalBatch.hash }
  const terminal = terminalType === "batch"
    ? { type: "batch", batch: terminalBatch, cursor: terminalCursor }
    : { type: "caught-up", cursor, terminal: true }
  const lines = [{ type: "accepted", cursor }, terminal, { type: "accepted", cursor }]
  for (const coalesced of [true, false]) {
    const delivered: AgentTurnJournalDelivery[] = []
    let cancelled!: () => void
    const cancellation = new Promise<void>(resolve => { cancelled = resolve })
    const agent = createWebAgent({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        const chunks = coalesced ? [lines.map(line => JSON.stringify(line)).join("\n") + "\n"] : lines.map(line => JSON.stringify(line) + "\n")
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      },
      cancel() { cancelled() }
    }), { headers: { "x-smithers-turn-journal": "1" } }) })
    agent.journal!.subscribe(async delivery => { delivered.push(delivery) })
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await cancellation
    expect(delivered).toEqual(lines.slice(0, 2))
  }
})

test("an existing server head is never advertised as applied; replay and retirement keep capability out of URLs", async () => {
  const calls: Array<{ url: string; body: unknown }> = [], delivered: unknown[] = []
  const agent = createWebAgent({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return Response.json(String(url) === TURN_PATH ? { status: "existing", cursor: next, terminal: false }
      : String(url) === TURN_RETIRE_PATH ? { status: "retired" }
      : { status: "ok", after: cursor, next, head: next, terminal: false, more: false, batches: [batch] })
  } })
  agent.journal!.subscribe(async delivery => { delivered.push(delivery) })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  expect(delivered).toEqual([])
  expect((await agent.journal!.read({ runId: "turn", journal: request.journal, after: cursor })).status).toBe("ok")
  await agent.journal!.retire({ runId: "turn", journal: request.journal })
  expect(calls.map(call => call.url)).toEqual([TURN_PATH, TURN_REPLAY_PATH, TURN_RETIRE_PATH])
  expect(calls[1]?.body).toEqual({ runId: "turn", journal: request.journal, after: cursor })
  expect(calls[2]?.body).toEqual({ runId: "turn", journal: request.journal })
})

test("a delivery cursor which disagrees with its batch is rejected before subscribers receive any batch", async () => {
  const delivered: AgentTurnJournalDelivery[] = []
  const agent = createWebAgent({ fetchImpl: async () => new Response(JSON.stringify({ type: "batch", batch, cursor: { ...next, position: 5 } }), {
    headers: { "x-smithers-turn-journal": "1" }
  }) })
  agent.journal!.subscribe(async delivery => { delivered.push(delivery) })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(delivered).toEqual([])
})

test("a host without journal delivery cannot silently downgrade a durable turn to legacy transient frames", async () => {
  const frames: unknown[] = []
  const agent = createWebAgent({ fetchImpl: async () => new Response(JSON.stringify({ type: "done", runId: "turn" })) })
  agent.subscribe(frame => { frames.push(frame) })
  expect((await agent.startTurn(request)).status).toBe("error")
  expect(frames).toEqual([])
})

test("malformed JSON journal admission releases the handle for a same-run retry", async () => {
  const calls: string[] = []
  const agent = createWebAgent({ fetchImpl: async url => {
    calls.push(String(url))
    return calls.length === 1
      ? new Response("{not-json", { headers: { "content-type": "application/json" } })
      : Response.json({ status: "existing", cursor, terminal: false })
  } })
  const first = await agent.startTurn(request).then(result => result.status, () => "rejected")
  expect(["error", "rejected"]).toContain(first)
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  expect(calls).toEqual([TURN_PATH, TURN_PATH])
})

test.each([[410, "retired"], [409, "cursor"], [400, "request_invalid"], [404, "not-found"], [403, "forbidden"]] as const)(
  "public replay refusal HTTP %s preserves the permanent journal meaning %s", async (status, code) => {
    const agent = createWebAgent({ fetchImpl: async () => Response.json({ status: "error", code: "request_invalid", message: "The recorded turn is unavailable." }, { status }) })
    expect(await agent.journal!.read({ runId: "turn", journal: request.journal })).toEqual({ status: "error", code })
  }
)

test("malformed replay success is an integrity refusal while unavailable transport remains retryable", async () => {
  const malformed = createWebAgent({ fetchImpl: async () => Response.json({ unknown: true }) })
  await expect(malformed.journal!.read({ runId: "turn", journal: request.journal })).rejects.toBeInstanceOf(AgentJournalIntegrityError)
  const unavailable = createWebAgent({ fetchImpl: async () => Response.json({ message: "Unavailable" }, { status: 503 }) })
  try { await unavailable.journal!.read({ runId: "turn", journal: request.journal }); throw new Error("Expected transport refusal") }
  catch (error) { expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(AgentJournalIntegrityError) }
})

test.each([
  [500, "<html><body>Internal Server Error</body></html>", "text/html"],
  [500, "Internal Server Error", "text/plain"],
  [502, "Bad Gateway", "text/plain"],
  [507, "", "text/plain"]
] as const)("an unparsed HTTP %s replay answer is retryable transport, never an integrity refusal", async (status, text, type) => {
  const agent = createWebAgent({ fetchImpl: async () => new Response(text, { status, headers: { "content-type": type } }) })
  const error = await agent.journal!.read({ runId: "turn", journal: request.journal }).then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(AgentJournalIntegrityError)
})

test("a 5xx carrying a non-error journal reply stays an integrity refusal", async () => {
  const agent = createWebAgent({ fetchImpl: async () => Response.json({ status: "retired" }, { status: 500 }) })
  await expect(agent.journal!.read({ runId: "turn", journal: request.journal })).rejects.toBeInstanceOf(AgentJournalIntegrityError)
})

test.each([401, 503])("retirement refuses HTTP %s despite a retired receipt, then accepts a later success", async status => {
  let calls = 0
  const agent = createWebAgent({ fetchImpl: async (url, init) => {
    expect(String(url)).toBe(TURN_RETIRE_PATH)
    expect(JSON.parse(String(init?.body))).toEqual({ runId: request.runId, journal: request.journal })
    return Response.json({ status: "retired" }, { status: ++calls === 1 ? status : 200 })
  } })
  const access = { runId: request.runId, journal: request.journal }
  await expect(agent.journal!.retire(access)).rejects.toThrow()
  await expect(agent.journal!.retire(access)).resolves.toBeUndefined()
  expect(calls).toBe(2)
})
