import { describe, expect, test } from "bun:test"
import type { AgentChatMessage, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import {
  boundToolResult,
  boundTurnRequest,
  droppedHistoryNotice,
  MAX_TURN_REQUEST_BYTES,
  turnRequestBytes,
  utf8Bytes
} from "./AgentTurnPolicy"

/** `AgentChatMessage` is a union: a chat turn, or a tool call/result item. */
const textOf = (message: AgentChatMessage | undefined): string =>
  message !== undefined && "content" in message ? message.content : ""

describe("agent turn production policy", () => {
  test("measures the exact UTF-8 request body rather than JS code units", () => {
    const request = { runId: "r", messages: [{ role: "user" as const, content: "🙂" }], instructions: "" }
    expect(turnRequestBytes(request)).toBe(utf8Bytes(JSON.stringify(request)))
    expect(utf8Bytes("🙂")).toBe(4)
  })

  test("tool outputs pass through losslessly under both limits", () => {
    expect(boundToolResult("ok\nvalue", 100, 10)).toEqual({
      modelOutput: "ok\nvalue",
      truncated: false,
      totalBytes: 8,
      totalLines: 2
    })
  })

  test("tool outputs truncate by line count with an explicit evidence marker", () => {
    const bounded = boundToolResult("one\ntwo\nthree", 200, 2)
    expect(bounded.truncated).toBe(true)
    expect(bounded.modelOutput).toStartWith("one\ntwo")
    expect(bounded.modelOutput).not.toContain("three")
    expect(bounded.modelOutput).toContain("13 bytes, 3 lines total")
  })

  test("tool outputs truncate on UTF-8 byte boundaries without replacement characters", () => {
    const bounded = boundToolResult("🙂".repeat(100), 100, 1_000)
    expect(bounded.truncated).toBe(true)
    expect(utf8Bytes(bounded.modelOutput)).toBeLessThanOrEqual(100)
    expect(bounded.modelOutput).not.toContain("�")
    expect(bounded.modelOutput).toContain("400 bytes")
  })

  test("zero and marker-only budgets remain deterministic", () => {
    const bounded = boundToolResult("large", 0, 0)
    expect(bounded.truncated).toBe(true)
    expect(bounded.modelOutput).toContain("Tool result truncated")
  })
})

/*
 * §4.13 — a long conversation must not wedge the seam permanently.
 *
 * Measured on canary: seven long answers pushed POST /api/agent/turn past the
 * upstream body limit, and from that point every turn failed the same way —
 * including `say ok`, and including `/clear`, which runs a model turn of its
 * own into the same wall. The only escape was clearing the origin's storage
 * from outside the app.
 */
describe("one turn request is bounded to the boundary's body limit", () => {
  const turn = (messages: ReadonlyArray<AgentChatMessage>): StartAgentTurnRequest => ({
    runId: "turn-1",
    messages,
    instructions: "be snappy"
  })

  test("a request that already fits is passed through untouched", () => {
    const request = turn([{ role: "user", content: "hello" }])
    const bounded = boundTurnRequest(request)
    expect(bounded.dropped).toBe(0)
    expect(bounded.request).toBe(request)
  })

  test("the limit is the backend turn route's 1 MiB body less the envelope headroom", () => {
    expect(MAX_TURN_REQUEST_BYTES).toBe(1024 * 1024 - 4 * 1024)
  })

  /* A message a third of the limit: five of them overflow it, two fit. */
  const third = Math.ceil(MAX_TURN_REQUEST_BYTES / 3)

  test("the oldest messages are dropped until the turn fits, and the newest survives", () => {
    const long = "x".repeat(third)
    const request = turn([
      { role: "user", content: long },
      { role: "assistant", content: long },
      { role: "user", content: long },
      { role: "assistant", content: long },
      { role: "user", content: "and now say ok" }
    ])
    expect(turnRequestBytes(request)).toBeGreaterThan(MAX_TURN_REQUEST_BYTES)
    const bounded = boundTurnRequest(request)
    expect(bounded.dropped).toBeGreaterThan(0)
    expect(turnRequestBytes(bounded.request)).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    expect(textOf(bounded.request.messages.at(-1))).toBe("and now say ok")
  })

  test("what was dropped is stated, never silently missing", () => {
    const long = "y".repeat(2 * third)
    const bounded = boundTurnRequest(
      turn([
        { role: "user", content: long },
        { role: "assistant", content: long },
        { role: "user", content: "still here?" }
      ])
    )
    expect(textOf(bounded.request.messages[0])).toContain("dropped to fit this turn's size limit")
    expect(textOf(bounded.request.messages[0])).toContain("say you may no longer have it")
  })

  test("a tool leg's call and output are never split by the bound", () => {
    const long = "z".repeat(third)
    // Keep the actual wire call/result pair intact.
    const bounded = boundTurnRequest(
      turn([
        { role: "user", content: long },
        { role: "assistant", content: long },
        { role: "user", content: long },
        { type: "function_call", call_id: "call-1", name: "issues.list", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "two issues" }
      ]),
      2
    )
    expect(turnRequestBytes(bounded.request)).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    expect(bounded.request.messages.slice(-2)).toEqual([
      { type: "function_call", call_id: "call-1", name: "issues.list", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "two issues" }
    ])
  })

  test("a single message over the limit is still sent, so the seam refuses it honestly", () => {
    // Dropping the user's own words to hide the refusal would be the worse
    // answer: the boundary's message already names what happened.
    const bounded = boundTurnRequest(turn([{ role: "user", content: "q".repeat(MAX_TURN_REQUEST_BYTES + 1) }]))
    expect(turnRequestBytes(bounded.request)).toBeGreaterThan(MAX_TURN_REQUEST_BYTES)
    expect(bounded.dropped).toBe(0)
    expect(bounded.request.messages).toHaveLength(1)
  })

  /*
   * The reference the linear bound must match byte for byte: drop one oldest
   * message at a time and re-measure the whole request. It is quadratic, which
   * is why it lives here and not in the module.
   */
  const referenceBound = (
    request: ReturnType<typeof turn>,
    keepTail: number,
    maxBytes: number
  ): { dropped: number; bytes: number } => {
    if (turnRequestBytes(request) <= maxBytes) return { dropped: 0, bytes: turnRequestBytes(request) }
    const messages = [...request.messages]
    const floor = Math.min(Math.max(keepTail, 1), messages.length)
    let dropped = 0
    let bytes = turnRequestBytes(request)
    while (messages.length > floor) {
      messages.shift()
      dropped += 1
      bytes = turnRequestBytes({
        ...request,
        messages: [{ role: "user", content: droppedHistoryNotice(dropped) }, ...messages]
      })
      if (bytes <= maxBytes) return { dropped, bytes }
    }
    return { dropped, bytes }
  }

  test("the bound drops exactly as many messages as re-measuring the whole request would, across a size sweep", () => {
    // Mixed sizes and multi-byte text, so a per-message measure that forgot
    // the JSON framing, the commas or the notice's own width would show.
    const contents = ["🙂", "", "x".repeat(3), "é".repeat(700), "y".repeat(2_000), "\"quoted\"\n", "z".repeat(9_000)]
    const messages = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${index} ${contents[index % contents.length] ?? ""}`
    }))
    for (const maxBytes of [200, 1_000, 4_096, 10_000, 30_000, 60 * 1024, 200_000]) {
      for (const keepTail of [1, 2, 5]) {
        const request = turn(messages)
        const expected = referenceBound(request, keepTail, maxBytes)
        const bounded = boundTurnRequest(request, keepTail, maxBytes)
        expect({ maxBytes, keepTail, dropped: bounded.dropped, bytes: turnRequestBytes(bounded.request) }).toEqual({
          maxBytes,
          keepTail,
          dropped: expected.dropped,
          bytes: expected.bytes
        })
        if (bounded.dropped > 0) {
          expect(textOf(bounded.request.messages[0])).toBe(droppedHistoryNotice(bounded.dropped))
          expect(bounded.request.messages.slice(1)).toEqual(messages.slice(bounded.dropped))
        }
      }
    }
  })

  test("serialization work stays linear across growing histories", () => {
    // Count serialized characters instead of elapsed time so machine load
    // cannot hide repeated serialization of the remaining history.
    for (const length of [250, 500, 1_000]) {
      const request = turn(
        Array.from({ length }, (_, index) => ({
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          content: `${index} ${"x".repeat(8_000)}`
        }))
      )
      expect(turnRequestBytes(request)).toBeGreaterThan(MAX_TURN_REQUEST_BYTES)
      const original = JSON.stringify
      let serialized = 0
      JSON.stringify = ((value: unknown, ...rest: Array<never>) => {
        const text = (original as (v: unknown, ...r: Array<never>) => string)(value, ...rest)
        serialized += text.length
        return text
      }) as typeof JSON.stringify
      let dropped = 0
      try {
        dropped = boundTurnRequest(request).dropped
      } finally {
        JSON.stringify = original
      }
      expect(serialized).toBeLessThanOrEqual(4 * turnRequestBytes(request))
      // Minimal: the kept history fits, and keeping one more message would not.
      const keeping = (count: number): StartAgentTurnRequest => ({
        ...request,
        messages: [{ role: "user", content: droppedHistoryNotice(count) }, ...request.messages.slice(count)]
      })
      expect(dropped).toBeGreaterThan(0)
      expect(turnRequestBytes(keeping(dropped))).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
      expect(turnRequestBytes(keeping(dropped - 1))).toBeGreaterThan(MAX_TURN_REQUEST_BYTES)
    }
  })

  test("exact-fit boundaries include the envelope, tool items and notice digit changes", () => {
    const request: StartAgentTurnRequest = {
      ...turn([
        ...Array.from({ length: 105 }, () => ({ role: "user" as const, content: "é\n\"".repeat(100) })),
        { type: "function_call", call_id: "c", name: "read", arguments: '{"path":"🙂"}' },
        { type: "function_call_output", call_id: "c", output: "🙂\nresult" }
      ]),
      tools: [{ type: "function", name: "read", description: "Read a file", parameters: { type: "object" } }],
      tier: "cheap",
      purpose: "conversation"
    }
    for (const dropped of [1, 9, 10, 99, 100]) {
      const expected = {
        ...request,
        messages: [{ role: "user" as const, content: droppedHistoryNotice(dropped) }, ...request.messages.slice(dropped)]
      }
      const maxBytes = turnRequestBytes(expected)
      expect(boundTurnRequest(request, 2, maxBytes)).toEqual({ request: expected, dropped })
      expect(boundTurnRequest(request, 2, maxBytes - 1).dropped).toBe(dropped + 1)
    }
  })
})
