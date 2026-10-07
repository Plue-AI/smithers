import { expect, test, vi } from "vitest"
import { readContextStream } from "../src/internal/ContextStream.ts"

const header = {
  type: "input",
  version: 1,
  value: { prompt: "Retry?", author: "ben", branch: "main", state: "asleep" }
}
const recent = { type: "recent", value: { title: "Earlier", text: "Earlier answer" } }
const candidate = {
  type: "candidate",
  value: { item: { kind: "file", label: "retry.ts", ref: "src/retry.ts", revision: "abc123" }, text: "three ☃ retries" }
}
const end = { type: "end", recent: 1, candidates: 1 }
const encode = (records: unknown[]) =>
  new TextEncoder().encode(records.map((record) => JSON.stringify(record) + "\n").join(""))
const response = (body: BodyInit | null) => new Response(body, { headers: { "content-type": "application/x-ndjson" } })

test.each([1, 7, 1048576])("preserves UTF-8 and ordered context across %i-byte chunks", async (chunkSize) => {
  const bytes = encode([header, recent, candidate, end])
  const input = await readContextStream(response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize))
        controller.close()
      }
    })
  ))
  expect(input).toEqual({
    ...header.value,
    tokenBudget: 24000,
    wikiOnly: false,
    recent: [recent.value],
    candidates: [candidate.value]
  })
})

test("protocol refusals have a stable typed tag", async () => {
  await expect(readContextStream(response(encode([header])))).rejects.toMatchObject({
    _tag: "ResolveFailed",
    message: "incomplete context stream"
  })
})

test("accepts a complete catalog above the old aggregate bound without truncation", async () => {
  const records = Array.from(
    { length: 8 },
    (_, i) => ({
      ...candidate,
      value: { item: { ...candidate.value.item, ref: `f${i}` }, text: `${i}:` + "x".repeat(400000) }
    })
  )
  const bytes = encode([header, ...records, { type: "end", recent: 0, candidates: 8 }])
  expect(bytes.length).toBeGreaterThan(2097152)
  const input = await readContextStream(response(bytes))
  expect(input.candidates).toEqual(records.map((record) => record.value))
})

test("accepts an empty catalog and an exact-bound record including newline", async () => {
  const base = { ...candidate, value: { ...candidate.value, text: "" } }
  const padding = 2097152 - encode([base]).length
  const exact = { ...base, value: { ...base.value, text: "x".repeat(padding) } }
  expect(encode([exact]).length).toBe(2097152)
  const empty = await readContextStream(response(encode([header, { type: "end", recent: 0, candidates: 0 }])))
  expect(empty.candidates).toEqual([])
  const filled = await readContextStream(response(encode([header, exact, { type: "end", recent: 0, candidates: 1 }])))
  expect(filled.candidates[0]!.text.length).toBe(padding)
})

for (
  const [i, records] of [
    [],
    [header],
    [recent, header],
    [candidate, header],
    [end],
    [header, header],
    [header, candidate, recent],
    [header, end],
    [header, recent, candidate, { ...end, recent: 0 }],
    [header, recent, candidate, { ...end, candidates: 0 }],
    [header, recent, candidate, end, end],
    [{ ...header, version: 2 }],
    [{ ...header, value: { ...header.value, private: true } }],
    [header, { ...recent, value: { ...recent.value, private: true } }],
    [header, { ...candidate, value: { item: { kind: "file", ref: "secret" }, text: "secret" } }],
    [header, { ...candidate, value: { ...candidate.value, text: 1 } }]
  ].entries()
) {
  test(`rejects incomplete, misordered or invalid records ${i}`, async () => {
    await expect(readContextStream(response(encode(records)))).rejects.toThrow()
  })
}

test.each(["not json\n", "\n", JSON.stringify(header), "{}\n", JSON.stringify(header) + "\n "])(
  "rejects malformed or unterminated data %#",
  async (body) => {
    await expect(readContextStream(response(body))).rejects.toThrow()
  }
)

test.each([null, new Uint8Array([0xff, 10])])("rejects missing body or invalid UTF-8 %#", async (body) => {
  await expect(readContextStream(response(body))).rejects.toThrow()
})

test.each([false, true])("cancels oversize records, including a failing cancellation (%s)", async (cancelFails) => {
  const cancel = vi.fn(() => cancelFails ? Promise.reject(new Error("cancel failed")) : undefined)
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2097153))
    },
    cancel
  })
  await expect(readContextStream(response(body))).rejects.toThrow("context record too large")
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(body.locked).toBe(false)
})

test("releases an errored stream reader and refuses legacy JSON content", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error("lost connection"))
    }
  })
  await expect(readContextStream(response(body))).rejects.toThrow("lost connection")
  expect(body.locked).toBe(false)
  const cancel = vi.fn()
  await expect(readContextStream(new Response(new ReadableStream({ cancel })))).rejects.toThrow(
    "context stream unavailable"
  )
  expect(cancel).toHaveBeenCalledTimes(1)
})
