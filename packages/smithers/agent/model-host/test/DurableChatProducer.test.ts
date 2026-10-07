import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnBatch, AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { Effect, Stream } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, test } from "vitest"
import { DurableChatProducer, runDurableChatTurn } from "../src/DurableChatProducer.ts"

const request: StartAgentTurnRequest = {
  runId: "run",
  instructions: "answer",
  messages: [{ role: "user", content: "hi" }]
}
const cursor: AgentTurnCursor = { version: 1, runId: "run", legId: "leg", batch: 0, position: 0, hash: "a".repeat(64) }
const grant = {
  turnId: "turn",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 3,
  token: "capability_capability_capability_1234",
  cursor,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request,
  producerBaseUrl: "http://host.test/"
}
const digest = (kind: "batch", value: unknown): string =>
  createHash("sha256").update(agentTurnJournalDigestInput(kind, value)).digest("hex")
const reply = (expected: AgentTurnCursor, frame: AgentTurnFrame) => {
  const unsigned = {
    version: 1 as const,
    runId: "run",
    legId: "leg",
    batch: expected.batch + 1,
    from: expected.position + 1,
    previousHash: expected.hash,
    frames: [frame]
  }
  const batch: AgentTurnBatch = { ...unsigned, hash: digest("batch", unsigned) }
  return {
    status: "committed" as const,
    batch,
    cursor: {
      version: 1 as const,
      runId: "run",
      legId: "leg",
      batch: batch.batch,
      position: batch.from,
      hash: batch.hash
    }
  }
}

describe("DurableChatProducer", () => {
  test("retries a lost receipt with the identical expected cursor and body", async () => {
    const calls: Array<string> = []
    let attempt = 0
    const frame = { runId: "run", type: "delta" as const, kind: "text" as const, text: "a" }
    const fetchImpl: FetchLike = async (_input, init) => {
      calls.push(typeof init?.body === "string" ? init.body : "")
      if (++attempt === 1) throw new Error("response lost")
      return Response.json(reply(cursor, frame))
    }
    const producer = new DurableChatProducer("http://host.test", grant, fetchImpl)
    await Effect.runPromise(producer.write(frame))
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe(calls[1])
    expect(JSON.parse(calls[0] ?? "{}").expected).toEqual(cursor)
  })

  test("refuses a receipt whose batch seal does not match the exact frame", async () => {
    const frame = { runId: "run", type: "delta" as const, kind: "text" as const, text: "a" }
    const forged = reply(cursor, frame)
    forged.batch.hash = "f".repeat(64)
    forged.cursor.hash = forged.batch.hash
    const producer = new DurableChatProducer("http://host.test", grant, async () => Response.json(forged))
    await expect(Effect.runPromise(producer.write(frame))).rejects.toThrow("did not extend")
  })

  test("ignores client tools and keeps tool execution on the host", async () => {
    const order: Array<string> = []
    let expected = cursor
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input)
      if (url.includes("provider-started")) {
        order.push("started")
        return new Response(null, { status: 204 })
      }
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      order.push(body.frames[0].type)
      const answer = reply(expected, body.frames[0])
      expected = answer.cursor
      return Response.json(answer)
    }
    const events: ReadonlyArray<ModelEvent.ModelEvent> = [
      { type: "text-delta", id: "t", text: "hi" },
      { type: "tool-call-start", id: "call", name: "inspect" },
      { type: "tool-call-end", id: "call", arguments: "{}" },
      { type: "settle", stopReason: "tool-calls" }
    ]
    const rendererTools = {
      ...grant,
      request: {
        ...request,
        tools: [{ type: "function" as const, name: "inspect", description: "inspect", parameters: {} }]
      }
    }
    await Effect.runPromise(
      runDurableChatTurn(
        Model.make({
          stream: (request) =>
            Stream.fromIterable(
              request.messages.some((message) => message.role === "tool")
                ? [{ type: "settle", stopReason: "stop" } as const]
                : events
            )
        }),
        rendererTools,
        { modelId: "m" },
        "http://host.test",
        fetchImpl
      )
    )
    expect(order).toEqual(["started", "delta", "done"])
  })
})

const frame: AgentTurnFrame = { runId: "run", type: "delta", kind: "text", text: "a" }

test.each(
  [
    [() => new Response(null, { status: 409 }), "commit refused (409)"],
    [() => Response.json({}), "invalid receipt"],
    [() => Response.json({ status: "retired" }), "invalid receipt"],
    [() => {
      throw "transport rejection"
    }, "chat producer request failed"]
  ] as const
)("retries refused or malformed commits without changing their cursor", async (response, message) => {
  const bodies: unknown[] = []
  const producer = new DurableChatProducer("http://host.test", grant, async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return response()
  })
  await expect(Effect.runPromise(producer.write(frame))).rejects.toThrow(message)
  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toEqual(bodies[1])
  expect(bodies[0]).toMatchObject({ expected: cursor })
})

test.each([
  (value: ReturnType<typeof reply>) => {
    value.batch.runId = "other"
  },
  (value: ReturnType<typeof reply>) => {
    value.batch.legId = "other"
  },
  (value: ReturnType<typeof reply>) => {
    value.batch.batch += 1
  },
  (value: ReturnType<typeof reply>) => {
    value.batch.from += 1
  },
  (value: ReturnType<typeof reply>) => {
    value.batch.previousHash = "b".repeat(64)
  },
  (value: ReturnType<typeof reply>) => {
    value.cursor.hash = "b".repeat(64)
  },
  (value: ReturnType<typeof reply>) => {
    value.cursor.batch += 1
  },
  (value: ReturnType<typeof reply>) => {
    value.cursor.position += 1
  }
])("refuses a receipt that cannot extend the committed cursor", async (forge) => {
  const value = reply(cursor, frame)
  forge(value)
  const producer = new DurableChatProducer("http://host.test", grant, async () => Response.json(value))
  await expect(Effect.runPromise(producer.write(frame))).rejects.toThrow("did not extend")
})

test("accepts a duplicate receipt, then advances the next batch from that cursor", async () => {
  let expected = cursor
  const producer = new DurableChatProducer("http://host.test", grant, async (_input, init) => {
    expect(JSON.parse(String(init?.body)).expected).toEqual(expected)
    const value = reply(expected, frame)
    expected = value.cursor
    return Response.json({ ...value, status: "duplicate" })
  })
  await Effect.runPromise(producer.write(frame))
  await Effect.runPromise(producer.write(frame))
  expect(expected.batch).toBe(2)
})

test("does not call the model after a refused provider-start acknowledgment", async () => {
  let streamed = false
  const model = Model.make({
    stream: () => {
      streamed = true
      return Stream.empty
    }
  })
  await expect(
    Effect.runPromise(
      runDurableChatTurn(model, grant, { modelId: "m" }, undefined, async () => new Response(null, { status: 403 }))
    )
  ).rejects.toThrow("chat provider start refused (403)")
  expect(streamed).toBe(false)
})

test("wiki-only preflight journals and supplies only the chosen pinned page", async () => {
  const frames: AgentTurnFrame[] = [], requests: unknown[] = []
  let expected = cursor
  const wiki = {
    item: { kind: "page" as const, label: "Retries", ref: "retries", revision: "4" },
    text: "Retry three times"
  }
  const model = Model.make({
    stream: () =>
      Stream.fromIterable([
        { type: "text-delta" as const, id: "s", text: "[{\"index\":0,\"reason\":\"Policy\"}]" },
        { type: "settle" as const, stopReason: "stop" as const }
      ])
  })
  const answer = Model.make({
    stream: (request) => {
      requests.push(request)
      return Stream.fromIterable([
        { type: "text-delta" as const, id: "a", text: "Three times." },
        { type: "settle" as const, stopReason: "stop" as const }
      ])
    }
  })
  const fetchImpl: FetchLike = async (url, init) => {
    if (String(url).includes("provider-started")) return new Response(null, { status: 204 })
    const body = JSON.parse(String(init?.body))
    frames.push(...body.frames)
    const response = reply(expected, body.frames[0])
    expected = response.cursor
    return Response.json(response)
  }
  await Effect.runPromise(runDurableChatTurn(answer, grant, { modelId: "coding" }, grant.producerBaseUrl, fetchImpl, {
    model,
    options: { modelId: "fast" },
    input: {
      prompt: "Retry?",
      author: "ben",
      branch: "main",
      state: "synced",
      recent: [],
      tokenBudget: 24000,
      wikiOnly: true,
      candidates: [
        { item: { kind: "file", label: "Excluded", ref: "retry.ts", revision: "abc" }, text: "unselected-file-canary" },
        wiki
      ]
    }
  }))
  expect(frames[0]).toMatchObject({
    type: "context.preflight",
    phase: "started",
    result: { candidates: [wiki.item], context: [] }
  })
  expect(frames[1]).toMatchObject({
    type: "context.preflight",
    phase: "completed",
    result: { candidates: [wiki.item], context: [{ ...wiki.item, reason: "Policy" }] }
  })
  const timing = frames.filter((frame) => frame.type === "context.preflight")
  expect(timing).toHaveLength(2)
  expect(timing[0]!.at).toBeGreaterThanOrEqual(0)
  expect(timing[1]!.at).toBeGreaterThanOrEqual(timing[0]!.at!)
  expect(timing[0]!.clock).toMatch(/^host monotonic:.+$/)
  expect(timing[1]!.clock).toBe(timing[0]!.clock)
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests)).toContain("Retry three times")
  expect(JSON.stringify(requests)).not.toContain("unselected-file-canary")
})

test("pages large candidate and choice lists into bounded hash-checked journal writes", async () => {
  const { projectContextPreflight } = await import("@smthrs/rpc/ContextPreflight")
  const candidates = Array.from(
    { length: 2500 },
    (_, i) => ({
      kind: "file" as const,
      label: `${i} <☃>`,
      ref: `src/${i}-${"x".repeat(60)}.ts`,
      revision: "a".repeat(40)
    })
  )
  const result = {
    candidates,
    context: candidates.map((item) => ({ ...item, reason: "Chosen" })),
    model: "fast",
    durationMs: 42
  }
  const frames: AgentTurnFrame[] = []
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const response = reply(body.expected, body.frames[0])
    expect(new TextEncoder().encode(agentTurnJournalDigestInput("batch", response.batch)).byteLength)
      .toBeLessThanOrEqual(96 * 1024)
    frames.push(body.frames[0])
    return Response.json(response)
  }
  const producer = new DurableChatProducer(grant.producerBaseUrl, grant, fetchImpl)
  for (const phase of ["started", "completed"] as const) {
    const value = phase === "started" ? { ...result, context: [], durationMs: 0 } : result
    await Effect.runPromise(producer.writePreflight(phase, value))
    const pages = frames.filter((frame) => frame.type === "context.preflight" && frame.phase === phase)
    expect(pages.length).toBeGreaterThan(1)
    let state = {}
    for (const frame of pages) {
      if (frame.type !== "context.preflight") throw new Error("unexpected frame")
      state = projectContextPreflight(state, frame)
    }
    expect(state).toEqual({ preflight: value, preflightPhase: phase, preflightPage: undefined })
  }
})

test.each(["first-item", "later-item", "metadata"])(
  "refuses unpageable %s before writing a partial step",
  async (mode) => {
    let writes = 0
    const producer = new DurableChatProducer(grant.producerBaseUrl, grant, async () => {
      writes++
      throw new Error("unexpected")
    })
    const huge = { kind: "todo" as const, label: "x".repeat(100000), ref: "T1" }
    const small = { kind: "todo" as const, label: "small", ref: "T2" }
    await expect(Effect.runPromise(producer.writePreflight("started", {
      model: mode === "metadata" ? "m".repeat(100000) : "fast",
      durationMs: 0,
      context: [],
      candidates: mode === "metadata" ? [] : mode === "first-item" ? [huge] : [small, huge]
    }))).rejects.toThrow("journal limit")
    expect(writes).toBe(0)
  }
)

test.each(["started", "completed"] as const)("refused later %s page stops subsequent model work", async (phase) => {
  let selectorCalls = 0, answerCalls = 0, starts = 0
  const selector = Model.make({
    stream: () => {
      selectorCalls++
      return Stream.fromIterable([
        { type: "text-delta" as const, id: "s", text: "[]" },
        { type: "settle" as const, stopReason: "stop" as const }
      ])
    }
  })
  const answer = Model.make({
    stream: () => {
      answerCalls++
      return Stream.empty
    }
  })
  const refused: Array<string> = []
  const accepted: Array<AgentTurnFrame> = []
  const fetchImpl: FetchLike = async (url, init) => {
    if (String(url).includes("provider-started")) {
      starts++
      return new Response(null, { status: 204 })
    }
    const body = JSON.parse(String(init?.body))
    const frame = body.frames[0]
    if (frame.type === "context.preflight" && frame.phase === phase && frame.page.index === 1) {
      refused.push(String(init?.body))
      return new Response(null, { status: 403 })
    }
    accepted.push(frame)
    return Response.json(reply(body.expected, frame))
  }
  await expect(
    Effect.runPromise(runDurableChatTurn(answer, grant, { modelId: "coding" }, grant.producerBaseUrl, fetchImpl, {
      model: selector,
      options: { modelId: "fast" },
      input: {
        prompt: "Find context",
        author: "ben",
        branch: "main",
        state: "synced",
        recent: [],
        tokenBudget: 24000,
        wikiOnly: false,
        candidates: Array.from({ length: 1000 }, (_, i) => ({
          item: {
            kind: "file" as const,
            label: `File ${i}`,
            ref: `src/${i}-${"x".repeat(100)}.ts`,
            revision: "a".repeat(40)
          },
          text: "fixture"
        }))
      }
    }))
  ).rejects.toThrow("403")
  expect(refused).toHaveLength(2)
  expect(refused[0]).toBe(refused[1])
  expect(accepted.filter((frame) => frame.type === "context.preflight" && frame.phase === phase)).toHaveLength(1)
  expect(selectorCalls).toBe(phase === "started" ? 0 : 1)
  expect(starts).toBe(phase === "started" ? 0 : 1)
  expect(answerCalls).toBe(0)
})
