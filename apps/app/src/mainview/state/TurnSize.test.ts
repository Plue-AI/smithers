import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent, settled } from "./TestFixtures"
const createAppController = scopedControllers()

for (const size of [1, 4096, 2_000_000]) test(`a ${size}-character legacy prompt never becomes a browser model request`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let starts = 0
  const controller = createAppController(store, { ...silentAgent, available: true,
    startTurn: async () => { starts++; return { status: "started" } }
  })
  await controller.send("x".repeat(size))
  await settled()
  expect(starts).toBe(0)
  expect(store.collections.toolCalls.size).toBe(0)
})
