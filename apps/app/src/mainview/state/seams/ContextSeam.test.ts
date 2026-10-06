import { expect, test } from "bun:test"
import { createContextSeam, StoredAnswerSchema } from "./ContextSeam"

const answer = { id: "answer-9", context: [
  { kind: "file", label: "retry.ts", ref: "src/retry.ts", revision: "sha-1", reason: "Retries" },
  { kind: "page", label: "Retries", ref: "retry", revision: "page-2", reason: "Policy" },
  { kind: "todo", label: "T9", ref: "T9", reason: "Related change" },
  { kind: "run", label: "Run 9", ref: "run-9", reason: "Evidence" }
] }
test("old answers decode; missing labels or reasons refuse", () => {
  expect(StoredAnswerSchema.parse({ id: "old" })).toEqual({ id: "old" })
  for (const field of ["label", "reason"]) {
    const item = { ...answer.context[0] } as Record<string, unknown>
    delete item[field]
    expect(StoredAnswerSchema.safeParse({ id: "bad", context: [item] }).success).toBe(false)
  }
})
test("dark provider never reads or presents", async () => {
  const seam = createContextSeam(async () => { throw new Error("must not read") }, "")
  expect(seam.contextAvailable()).toBe(false)
  expect(await seam.inspectContext("main", "answer-9")).toBe("Context is unavailable")
})
test("fake transport reads only the stored answer through the authenticated conversation route", async () => {
  const requests: unknown[] = [], presented: unknown[] = []
  const seam = createContextSeam(async (url, init) => {
    requests.push([url, init?.method])
    return Response.json({ entries: [{ id: "other" }, answer] })
  }, "https://install", { available: () => true, present: async (value, branch) => { presented.push([value, branch]) } })
  expect(await seam.inspectContext("branch/a", "answer-9")).toEqual({ value: JSON.stringify(answer) })
  expect(requests).toEqual([["https://install/api/conversations/branch%2Fa", "GET"]])
  expect(presented).toEqual([[answer, "branch/a"]])
})
test("malformed, absent and old answers expose no Inspect payload", async () => {
  for (const body of [{}, { entries: [] }, { entries: [{ id: "answer-9" }] },
    { entries: [{ ...answer, context: [{}] }] }]) {
    let count = 0
    const seam = createContextSeam(async () => Response.json(body), "", { available: () => true, present: async () => { count++ } })
    expect(typeof await seam.inspectContext("main", "answer-9")).toBe("string")
    expect(count).toBe(0)
  }
})
test("permission, transport failure and provider removal fail closed", async () => {
  let available = true, count = 0
  for (const http of [async () => Response.json({ error: { message: "Denied" } }, { status: 403 }),
    async () => { throw new Error("offline") }, async () => { available = false; return Response.json({ entries: [answer] }) }]) {
    const seam = createContextSeam(http, "", { available: () => available, present: async () => { count++ } })
    expect(typeof await seam.inspectContext("main", "answer-9")).toBe("string")
  }
  expect(count).toBe(0)
})
test("an answer arriving after the account generation changed never presents", async () => {
  let current = true, count = 0
  const seam = createContextSeam(async () => { current = false; return Response.json({ entries: [answer] }) }, "",
    { available: () => true, present: async () => { count++ } }, () => () => current)
  expect(await seam.inspectContext("main", "answer-9")).toBe("Context is unavailable")
  expect(count).toBe(0)
})
