import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent, settled } from "./TestFixtures"
const createAppController = scopedControllers()

for (const action of ["stop", "reset", "none"] as const) test(`legacy retry after ${action} cannot re-admit a browser turn`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let starts = 0, cancels = 0
  const controller = createAppController(store, { ...silentAgent, available: true,
    startTurn: async () => { starts++; return { status: "started" } },
    cancelTurn: async () => { cancels++ }
  })
  await controller.send("Keep my question")
  if (action === "stop") controller.stop()
  if (action === "reset") controller.reset()
  const outcome = await controller.commands.run("chat.retry")
  expect(outcome.status).toBe("failed")
  await settled()
  expect(starts).toBe(0)
  expect(cancels).toBe(0)
  expect(store.collections.toolCalls.size).toBe(0)
})
