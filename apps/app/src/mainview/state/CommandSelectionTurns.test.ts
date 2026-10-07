import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent, settled } from "./TestFixtures"
const createAppController = scopedControllers()

test("browser prompts cannot run legacy command selection or inference", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let selected = 0, inferred = 0
  const controller = createAppController(store, { ...silentAgent, available: true,
    startTurn: async () => { inferred++; return { status: "started" } }
  }, { commandSelector: async () => { selected++; return [{ name: "theme", probability: 1 }] } })
  const before = store.session().theme
  await controller.send("Make it darker")
  await settled()
  expect(selected).toBe(0)
  expect(inferred).toBe(0)
  expect(store.session().theme).toBe(before)
  expect(store.collections.toolCalls.size).toBe(0)
})
