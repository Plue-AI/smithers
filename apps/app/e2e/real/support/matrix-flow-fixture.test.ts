import { expect, test } from "bun:test"
import { matrixFlowCell } from "./matrix-flow-fixture"

const marker = "cd4ca9ea-084e-4555-8bc0-f7fe39b9a6b9"
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
for (const approved of [true, false]) test(`approval fixture waits and records ${approved ? "approval" : "denial"}`, async () => {
  let decide!: (value: { approved: boolean }) => void
  const answer = new Promise<{ approved: boolean }>(resolve => { decide = resolve })
  const files = new Map<string, string>()
  const cell = matrixFlowCell(`Approval marker: ${marker}`)!
  const source = /^```cell\n([\s\S]*)\n```$/.exec(cell)![1]
  let done = false
  const running = new AsyncFunction("ctx", source)({
    call: async (name: string, input: { path: string; content: string; question: string }) => {
      if (name === "ask") {
        expect(input.question).toContain(marker)
        return answer
      }
      expect(name).toBe("write")
      files.set(input.path, input.content)
    }, done: () => { done = true }
  })
  await Promise.resolve()
  expect(files.size).toBe(0)
  expect(done).toBe(false)
  decide({ approved })
  await running
  expect(done).toBe(true)
  expect(JSON.parse(files.get("approval-result.json")!)).toEqual({ marker, decision: approved ? "approved" : "denied" })
  expect(files.has("approval-effect.txt")).toBe(approved)
  if (approved) expect(files.get("approval-effect.txt")).toBe(marker)
})
test("ordinary prompts do not select matrix effects", () => {
  expect(matrixFlowCell("hello")).toBeUndefined()
})
test("proof fixture writes the exact marker line", async () => {
  const cell = matrixFlowCell(`Matrix proof marker: ${marker}`)!
  const source = /^```cell\n([\s\S]*)\n```$/.exec(cell)![1]
  const calls: unknown[] = []
  let done: unknown
  await new AsyncFunction("ctx", source)({
    call: async (name: string, input: unknown) => { calls.push([name, input]) },
    done: (value: unknown) => { done = value }
  })
  expect(calls).toEqual([["write", { path: "flow-proof.txt", content: marker + "\n" }]])
  expect(done).toBe("written")
})
