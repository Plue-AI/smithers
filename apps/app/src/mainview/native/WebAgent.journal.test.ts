import { afterEach, expect, test } from "bun:test"
import { digest } from "@smthrs/core/Digest"
import { AgentTurnJournalReplySchema, agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
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
const releases = new Set<() => void>()
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  releases.add(resolve)
  return { promise, resolve }
}
const journalStream = (lines: ReadonlyArray<unknown>, mode: "whole" | "separate" = "whole") => {
  const cancellation = deferred()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  const close = () => { if (!closed) { closed = true; controller.close() } }
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      const wire = lines.map(line => JSON.stringify(line) + "\n")
      if (mode === "whole") controller.enqueue(new TextEncoder().encode(wire.join("")))
      else for (const line of wire) controller.enqueue(new TextEncoder().encode(line))
    },
    cancel() { closed = true; cancellation.resolve() }
  })
  releases.add(close)
  return { response: new Response(stream, { headers: { "content-type": "application/x-ndjson", "x-smithers-turn-journal": "1" } }), cancelled: cancellation.promise, close }
}
afterEach(async () => { for (const release of releases) release(); releases.clear(); await checkpoint() })

test("journal delivery waits for its commit subscriber and a disconnected socket produces no synthetic done fact", async () => {
  const calls: unknown[] = [], delivered: AgentTurnJournalDelivery[] = [], frames: unknown[] = []
  const held = deferred(), accepted = deferred(), applied = deferred()
  const stream = journalStream([{ type: "accepted", cursor }, { type: "batch", batch, cursor: next }])
  const agent = createWebAgent({ fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) })
    return stream.response
  } })
  agent.subscribe(frame => { frames.push(frame) })
  agent.journal!.subscribe(async delivery => {
    delivered.push(delivery)
    if (delivery.type === "accepted") { accepted.resolve(); await held.promise }
    else applied.resolve()
  })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await accepted.promise
  await checkpoint()
  expect(delivered).toEqual([{ type: "accepted", cursor }])
  held.resolve()
  await applied.promise
  stream.close()
  await checkpoint()
  expect(delivered).toEqual([{ type: "accepted", cursor }, { type: "batch", batch, cursor: next }])
  expect(frames).toEqual([])
  expect(calls).toEqual([{ url: TURN_PATH, body: request }])
})

test.each(["batch", "caught-up"] as const)("terminal %s ends journal delivery independent of HTTP chunking", async terminalType => {
  const terminalBody = { ...body, frames: [{ type: "done" as const, runId: "turn" }] }
  const terminalBatch = { ...terminalBody, hash: digest(agentTurnJournalDigestInput("batch", terminalBody)) }
  const terminalCursor = { ...next, hash: terminalBatch.hash }
  const terminal: AgentTurnJournalDelivery = terminalType === "batch"
    ? { type: "batch", batch: terminalBatch, cursor: terminalCursor }
    : { type: "caught-up", cursor, terminal: true }
  const lines: AgentTurnJournalDelivery[] = [{ type: "accepted", cursor }, terminal, { type: "accepted", cursor }]
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
  const stream = journalStream([{ type: "batch", batch, cursor: { ...next, position: 5 } }])
  const agent = createWebAgent({ fetchImpl: async () => stream.response })
  agent.journal!.subscribe(async delivery => { delivered.push(delivery) })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await stream.cancelled
  await checkpoint()
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

const invalidDeliveries = [
  { label: "foreign run", delivery: { type: "accepted", cursor: { ...cursor, runId: "foreign" } } },
  { label: "foreign leg", delivery: { type: "accepted", cursor: { ...cursor, legId: "foreign" } } },
  { label: "wrong batch", delivery: { type: "batch", batch, cursor: { ...next, batch: 2 } } },
  { label: "wrong hash", delivery: { type: "batch", batch, cursor: { ...next, hash: "f".repeat(64) } } }
] as const

test.each([...invalidDeliveries])("$label journal delivery cancels its reader before any commit", async ({ delivery }) => {
  const stream = journalStream([delivery])
  const agent = createWebAgent({ fetchImpl: async () => stream.response })
  const delivered: AgentTurnJournalDelivery[] = []
  agent.journal!.subscribe(async value => { delivered.push(value) })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await stream.cancelled
  await checkpoint()
  expect(delivered).toEqual([])
})

test("journal commits are serial across subscribers and terminal catch-up cancels the reader", async () => {
  const accepted = deferred(), held = deferred()
  const stream = journalStream([{ type: "accepted", cursor }, { type: "caught-up", cursor: next, terminal: true }])
  const agent = createWebAgent({ fetchImpl: async () => stream.response })
  const order: string[] = []
  agent.journal!.subscribe(async delivery => { order.push(`A:${delivery.type}`); if (delivery.type === "accepted") { accepted.resolve(); await held.promise } })
  agent.journal!.subscribe(async delivery => { order.push(`B:${delivery.type}`) })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await accepted.promise
  await checkpoint()
  expect(order).toEqual(["A:accepted"])
  held.resolve()
  await stream.cancelled
  expect(order).toEqual(["A:accepted", "B:accepted", "A:caught-up", "B:caught-up"])
})

test("a rejected commit stops later subscribers and delivery rather than inventing a model terminal", async () => {
  const stream = journalStream([{ type: "accepted", cursor }, { type: "batch", batch, cursor: next }])
  const agent = createWebAgent({ fetchImpl: async () => stream.response })
  const order: string[] = [], transient: unknown[] = []
  agent.subscribe(frame => { transient.push(frame) })
  agent.journal!.subscribe(async delivery => { order.push(`A:${delivery.type}`); throw new Error("Owned commit rejected") })
  agent.journal!.subscribe(async delivery => { order.push(`B:${delivery.type}`) })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await stream.cancelled
  await checkpoint()
  expect(order).toEqual(["A:accepted"])
  expect(transient).toEqual([])
})


const terminalBody = { ...body, frames: [{ type: "done" as const, runId: "turn" }] }
const terminalBatch = { ...terminalBody, hash: digest(agentTurnJournalDigestInput("batch", terminalBody)) }
const terminalCursor = { ...next, hash: terminalBatch.hash }
const journalTerminals = [
  { label: "terminal batch", delivery: { type: "batch", batch: terminalBatch, cursor: terminalCursor } },
  { label: "terminal catch-up", delivery: { type: "caught-up", cursor: next, terminal: true } }
] as const

for (const mode of ["whole", "separate"] as const) test.each([...journalTerminals])(`$label ends its ${mode} chunk before any later commit and releases a continuation`, async ({ delivery }) => {
  const stream = journalStream([{ type: "accepted", cursor }, delivery, { type: "accepted", cursor }], mode)
  const delivered: AgentTurnJournalDelivery[] = []
  const nextRequest = { ...request, journal: { ...request.journal, legId: "next-leg" } }
  let posts = 0
  let continuation: Awaited<ReturnType<ReturnType<typeof createWebAgent>["startTurn"]>> | undefined
  const agent = createWebAgent({ fetchImpl: async () => {
    if (++posts === 1) return stream.response
    return Response.json({ status: "existing", cursor: { ...next, legId: "next-leg" }, terminal: false })
  } })
  agent.journal!.subscribe(async value => {
    delivered.push(value)
    if ((value.type === "batch" && value.batch.frames.at(-1)?.type === "done") || (value.type === "caught-up" && value.terminal)) continuation = await agent.startTurn(nextRequest)
  })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await stream.cancelled
  await checkpoint()
  expect(continuation).toEqual({ status: "started" })
  expect(posts).toBe(2)
  expect(delivered).toEqual([{ type: "accepted", cursor }, delivery])
})

test.each(["retry", "cancel-then-retry"] as const)("malformed JSON journal admission fails without stranding %s", async action => {
  const calls: string[] = []
  let posts = 0
  const agent = createWebAgent({ fetchImpl: async url => {
    calls.push(String(url))
    if (String(url).endsWith("/cancel")) return Response.json({})
    if (++posts === 1) return new Response("{not-json", { headers: { "content-type": "application/json" } })
    return Response.json({ status: "existing", cursor: next, terminal: false })
  } })
  try {
    // The public retry invariant does not require inventing a particular parse-error return shape.
    const failed = await agent.startTurn(request).catch(() => ({ status: "error" as const }))
    expect(failed.status).toBe("error")
    if (action === "cancel-then-retry") await agent.cancelTurn(request.runId)
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    expect(calls).toEqual(action === "retry" ? [TURN_PATH, TURN_PATH] : [TURN_PATH, "/api/agent/turn/cancel", TURN_PATH])
  } finally { agent.journal!.disconnect(request.runId) }
})

test("journal unsubscribe before admission is idempotent and leaves the other commit owner", async () => {
  const stream = journalStream([{ type: "accepted", cursor }, { type: "caught-up", cursor: next, terminal: true }])
  const agent = createWebAgent({ fetchImpl: async () => stream.response })
  const order: string[] = []
  const removeA = agent.journal!.subscribe(async value => { order.push(`A:${value.type}`) })
  agent.journal!.subscribe(async value => { order.push(`B:${value.type}`) })
  removeA()
  removeA()
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await stream.cancelled
  expect(order).toEqual(["B:accepted", "B:caught-up"])
})

test("unsubscribing a held commit owner waits for its existing commit but removes future callbacks", async () => {
  const held = deferred(), entered = deferred()
  const stream = journalStream([{ type: "accepted", cursor }, { type: "caught-up", cursor: next, terminal: true }])
  const agent = createWebAgent({ fetchImpl: async () => stream.response })
  const order: string[] = []
  const removeA = agent.journal!.subscribe(async value => { order.push(`A:${value.type}`); entered.resolve(); await held.promise })
  agent.journal!.subscribe(async value => { order.push(`B:${value.type}`) })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await entered.promise
  removeA()
  removeA()
  await checkpoint()
  expect(order).toEqual(["A:accepted"])
  held.resolve()
  await stream.cancelled
  expect(order).toEqual(["A:accepted", "B:accepted", "B:caught-up"])
})

test("journal delivery without a commit owner cancels locally and releases admission for recovery", async () => {
  const stream = journalStream([{ type: "accepted", cursor }])
  const transient: unknown[] = [], urls: string[] = []
  const agent = createWebAgent({ fetchImpl: async url => {
    urls.push(String(url))
    return urls.length === 1 ? stream.response : Response.json({ status: "existing", cursor: next, terminal: false })
  } })
  agent.subscribe(frame => { transient.push(frame) })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await stream.cancelled
  await checkpoint()
  expect(transient).toEqual([])
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  expect(urls).toEqual([TURN_PATH, TURN_PATH])
})

const unicodeBody = { ...body, frames: [{ type: "delta" as const, runId: "turn", kind: "text" as const, text: "😀 é 世界" }] }
const unicodeBatch = { ...unicodeBody, hash: digest(agentTurnJournalDigestInput("batch", unicodeBody)) }
const unicodeCursor = { ...next, hash: unicodeBatch.hash }

for (const finalLF of [true, false]) test.each(["whole", "byte-split"] as const)(`journal %s UTF8 preserves exact commits with final LF=${finalLF}`, async mode => {
  const deliveries = [{ type: "accepted", cursor }, { type: "batch", batch: unicodeBatch, cursor: unicodeCursor }, { type: "caught-up", cursor: unicodeCursor, terminal: true }] satisfies ReadonlyArray<AgentTurnJournalDelivery>
  const bytes = new TextEncoder().encode("\r\n" + deliveries.map(value => JSON.stringify(value)).join("\r\n") + (finalLF ? "\r\n" : ""))
  const applied = deferred(), actual: AgentTurnJournalDelivery[] = [], transient: unknown[] = []
  const agent = createWebAgent({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    if (mode === "whole") controller.enqueue(bytes)
    else for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } }), { headers: { "x-smithers-turn-journal": "1" } }) })
  agent.subscribe(frame => { transient.push(frame) })
  agent.journal!.subscribe(async value => { actual.push(value); if (value.type === "caught-up") applied.resolve() })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await applied.promise
  await checkpoint()
  expect(actual).toEqual(deliveries)
  expect(actual[1]?.type === "batch" ? actual[1].batch.frames : []).toEqual([{ type: "delta", runId: "turn", kind: "text", text: "😀 é 世界" }])
  expect(transient).toEqual([])
})

test("raw malformed journal JSON stops later valid commits and cancels without a synthetic model terminal", async () => {
  const cancelled = deferred(), delivered: AgentTurnJournalDelivery[] = [], transient: unknown[] = []
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    releases.add(() => { try { controller.close() } catch {} })
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "accepted", cursor }) + "\nnot-json\n" + JSON.stringify({ type: "batch", batch, cursor: next }) + "\n"))
  }, cancel() { cancelled.resolve() } })
  const agent = createWebAgent({ fetchImpl: async () => new Response(stream, { headers: { "x-smithers-turn-journal": "1" } }) })
  agent.subscribe(frame => { transient.push(frame) })
  agent.journal!.subscribe(async value => { delivered.push(value) })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await cancelled.promise
  await checkpoint()
  expect(delivered).toEqual([{ type: "accepted", cursor }])
  expect(transient).toEqual([])
})

const nonAdmissionReplies = [
  { label: "new acceptance", value: { status: "accepted", cursor, terminal: false }, valid: true },
  { label: "committed batch", value: { status: "committed", batch, cursor: next }, valid: true },
  { label: "retirement", value: { status: "retired" }, valid: true },
  { label: "typed refusal", value: { status: "error", code: "conflict" }, valid: true },
  { label: "replay page", value: { status: "ok", after: cursor, next, head: next, terminal: false, more: false, batches: [batch] }, valid: true },
  { label: "null", value: null, valid: false },
  { label: "missing cursor", value: { status: "existing", terminal: false }, valid: false },
  { label: "invalid cursor", value: { status: "existing", cursor: { ...cursor, hash: "not-a-hash" }, terminal: false }, valid: false }
]

test.each(nonAdmissionReplies)("JSON $label cannot acknowledge resumed admission and does not strand retry", async ({ value, valid }) => {
  expect(AgentTurnJournalReplySchema.safeParse(value).success).toBe(valid)
  const calls: Array<{ url: string; body: unknown }> = [], delivered: unknown[] = [], transient: unknown[] = []
  const agent = createWebAgent({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return calls.length === 1 ? Response.json(value) : Response.json({ status: "existing", cursor: next, terminal: false })
  } })
  const removeFrame = agent.subscribe(frame => { transient.push(frame) })
  const removeJournal = agent.journal!.subscribe(async delivery => { delivered.push(delivery) })
  try {
    expect(await agent.startTurn(request)).toEqual({ status: "error", message: "The accepted turn could not be resumed." })
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    expect(delivered).toEqual([])
    expect(transient).toEqual([])
    expect(calls).toEqual([{ url: "/api/agent/turn", body: request }, { url: "/api/agent/turn", body: request }])
  } finally { removeFrame(); removeJournal(); agent.journal!.disconnect(request.runId) }
})

const nonRetiredReplies = [
  { label: "acceptance", value: { status: "accepted", cursor, terminal: false } },
  { label: "existing head", value: { status: "existing", cursor, terminal: false } },
  { label: "committed batch", value: { status: "committed", batch, cursor: next } },
  { label: "duplicate batch", value: { status: "duplicate", batch, cursor: next } },
  { label: "replay page", value: { status: "ok", after: cursor, next, head: next, terminal: false, more: false, batches: [batch] } },
  { label: "typed refusal", value: { status: "error", code: "storage_failed" } }
]

test.each(nonRetiredReplies)("retirement rejects a valid $label reply and permits a committed retry", async ({ value }) => {
  expect(AgentTurnJournalReplySchema.safeParse(value).success).toBe(true)
  const calls: Array<{ url: string; method: string | undefined; headers: [string, string][]; body: unknown }> = []
  const agent = createWebAgent({ baseUrl: "https://boundary.test", fetchImpl: async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: [...new Headers(init?.headers)], body: JSON.parse(String(init?.body)) })
    return Response.json(calls.length === 1 ? value : { status: "retired" })
  } })
  const access = { runId: request.runId, journal: request.journal, after: cursor }
  await expect(agent.journal!.retire(access)).rejects.toThrow("HTTP journal retirement was not committed")
  await expect(agent.journal!.retire(access)).resolves.toBeUndefined()
  expect(calls).toEqual([
    { url: "https://boundary.test/api/agent/turn/retire", method: "POST", headers: [["content-type", "application/json"]], body: { runId: "turn", journal: request.journal } },
    { url: "https://boundary.test/api/agent/turn/retire", method: "POST", headers: [["content-type", "application/json"]], body: { runId: "turn", journal: request.journal } }
  ])
})

test.each([
  { label: "malformed JSON", wire: "{not-json" },
  { label: "schema-invalid JSON", wire: '{"status":"retired","extra":true}' }
])("retirement rejects $label instead of acknowledging completion", async ({ wire }) => {
  let calls = 0
  const agent = createWebAgent({ fetchImpl: async () => ++calls === 1 ? new Response(wire, { headers: { "content-type": "application/json" } }) : Response.json({ status: "retired" }) })
  const access = { runId: request.runId, journal: request.journal }
  await expect(agent.journal!.retire(access)).rejects.toBeInstanceOf(Error)
  await expect(agent.journal!.retire(access)).resolves.toBeUndefined()
  expect(calls).toBe(2)
})

// DurableTurn.accessDurableTurn emits non-error receipts only with HTTP200;
// NativeTurnJournal also conditions completed retirement on response.ok.
test.each([
  { status: 200, outcome: "completed" },
  { status: 401, outcome: "failed" },
  { status: 503, outcome: "failed" }
])("HTTP$status retired JSON acknowledges completion only with HTTP success", async ({ status, outcome }) => {
  const calls: Array<{ url: string; body: unknown }> = []
  const agent = createWebAgent({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return Response.json({ status: "retired" }, { status: calls.length === 1 ? status : 200 })
  } })
  const access = { runId: request.runId, journal: request.journal, after: cursor }
  const first = await agent.journal!.retire(access).then(() => "completed", () => "failed")
  await expect(agent.journal!.retire(access)).resolves.toBeUndefined()
  expect(calls).toEqual([
    { url: "/api/agent/turn/retire", body: { runId: "turn", journal: request.journal } },
    { url: "/api/agent/turn/retire", body: { runId: "turn", journal: request.journal } }
  ])
  expect(first).toBe(outcome)
})

for (const point of ["terminal", "commit failure"] as const) test.each(["Error", "non-Error"] as const)(`journal %s cancellation rejection after ${point} preserves facts and permits retry`, async kind => {
  const entered = deferred(), cleanup = Promise.withResolvers<void>()
  releases.add(() => { cleanup.resolve() })
  const delivery: AgentTurnJournalDelivery = point === "terminal" ? { type: "caught-up", cursor: next, terminal: true } : { type: "accepted", cursor }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(delivery) + "\n")) },
    cancel() { entered.resolve(); return cleanup.promise }
  })
  let posts = 0
  const transient: unknown[] = [], delivered: AgentTurnJournalDelivery[] = []
  const agent = createWebAgent({ fetchImpl: async () => ++posts === 1 ? new Response(stream, { headers: { "x-smithers-turn-journal": "1" } }) : Response.json({ status: "existing", cursor: next, terminal: false }) })
  const removeFrame = agent.subscribe(frame => { transient.push(frame) })
  const removeJournal = agent.journal!.subscribe(async value => { delivered.push(value); if (point === "commit failure") throw new Error("owned commit rejected") })
  try {
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await entered.promise
    cleanup.reject(kind === "Error" ? new Error("owned cancel rejected") : "owned cancel rejected")
    await checkpoint()
    expect(delivered).toEqual([delivery])
    expect(transient).toEqual([])
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    expect(posts).toBe(2)
  } finally {
    cleanup.resolve()
    await cleanup.promise.catch(() => {})
    removeFrame(); removeJournal(); agent.journal!.disconnect(request.runId)
    await checkpoint()
  }
})

test.each(["Error", "non-Error"] as const)("unsupported journal downgrade ignores %s cleanup rejection and releases admission", async kind => {
  const frames: unknown[] = [], delivered: unknown[] = []
  let calls = 0, cancellations = 0
  const stream = new ReadableStream<Uint8Array>({
    cancel() { cancellations++; return Promise.reject(kind === "Error" ? new Error("owned cancel rejected") : "owned cancel rejected") }
  })
  const agent = createWebAgent({ fetchImpl: async () => ++calls === 1 ? new Response(stream) : Response.json({ status: "existing", cursor: next, terminal: false }) })
  const removeFrame = agent.subscribe(frame => { frames.push(frame) })
  const removeJournal = agent.journal!.subscribe(async value => { delivered.push(value) })
  try {
    expect(await agent.startTurn(request)).toEqual({ status: "error", message: "This host did not provide a recoverable turn stream." })
    expect(cancellations).toBe(1)
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    expect(calls).toBe(2)
    expect(frames).toEqual([])
    expect(delivered).toEqual([])
  } finally { removeFrame(); removeJournal(); agent.journal!.disconnect(request.runId) }
})
