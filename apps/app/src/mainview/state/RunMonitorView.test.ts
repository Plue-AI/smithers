import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent } from "./TestFixtures"

const controllerFor = scopedControllers()

test("run detail selection persists through the flow, reopening and storage reload", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const controller = controllerFor(store, silentAgent)
  await controller.presentRun("recorded-run", "Recorded run", false)
  const result = await controller.commands.submit({ name: "run.view", actor: "user",
    payload: { cardId: "run:recorded-run", selected: "step:attempt:checks", tab: "journal", at: 3 } })
  expect(result.status).toBe("executed")
  await controller.presentRun("recorded-run", "Recorded run", false)
  const card = store.collections.cards.get("run:recorded-run")
  expect(card?.kind === "run" && card.payload.view).toEqual({ selected: "step:attempt:checks", tab: "journal", at: 3 })
  await controller.commands.submit({ name: "run.view", actor: "user", payload: { cardId: "run:recorded-run", selected: "cell-2" } })
  await controller.dispose()
  const restored = await createAppStore({ kind: "localStorage", storage })
  const saved = restored.collections.cards.get("run:recorded-run")
  expect(saved?.kind === "run" && saved.payload.view).toEqual({ selected: "cell-2", tab: "journal", at: 3 })
  expect([...restored.collections.transitions.values()].some(row => row.type === "card.updated" && row.actor === "user")).toBe(true)
})

test("run view refuses a missing card and invalid scrubber input", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = controllerFor(store, silentAgent)
  const missing = await controller.commands.submit({ name: "run.view", actor: "user", payload: { cardId: "missing", selected: "cell" } })
  expect(missing.status).toBe("failed")
  for (const at of [-1, 1.5]) {
    const invalid = await controller.commands.submit({ name: "run.view", actor: "user", payload: { cardId: "missing", at } })
    expect(invalid.status).toBe("failed")
  }
  expect(store.collections.cards.size).toBe(0)
})
