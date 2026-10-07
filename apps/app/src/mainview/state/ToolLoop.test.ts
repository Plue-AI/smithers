import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent, settled } from "./TestFixtures"
const createAppController = scopedControllers()

test("an available legacy agent cannot start a browser model or tool loop", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let starts = 0, subscriptions = 0
  const controller = createAppController(store, { ...silentAgent, available: true,
    startTurn: async () => { starts++; throw new Error("Browser inference must not run") },
    subscribe: () => { subscriptions++; return () => {} }
  })
  await controller.send("Create a note")
  await settled()
  expect(starts).toBe(0)
  expect(subscriptions).toBe(0)
  expect(store.collections.toolCalls.size).toBe(0)
  expect(store.session().phase).toBe("idle")
})
