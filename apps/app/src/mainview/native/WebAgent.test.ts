import { expect, test } from "bun:test"
import { createWebAgent } from "./WebAgent"

test("private history adapter has no model admission, cancellation or tool transport", async () => {
  const requests: string[] = []
  const agent = createWebAgent({ fetchImpl: async input => { requests.push(String(input)); throw new Error("unexpected write") } })
  expect(agent.available).toBe(false)
  expect(agent.history).toBeDefined()
  expect(agent.journal).toBeUndefined()
  expect(await agent.startTurn({ runId: "old-tab", messages: [], instructions: "never" })).toMatchObject({ status: "error" })
  await agent.cancelTurn("old-tab")
  agent.subscribe(() => { throw new Error("unexpected frame") })()
  expect(requests).toEqual([])
})
