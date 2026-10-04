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

  test("leaves a renderer's own tool calls to the renderer: text, tool, and terminal frames", async () => {
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
        Model.make({ stream: () => Stream.fromIterable(events) }),
        rendererTools,
        { modelId: "m" },
        "http://host.test",
        fetchImpl
      )
    )
    expect(order).toEqual(["started", "delta", "tool_call", "done"])
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
