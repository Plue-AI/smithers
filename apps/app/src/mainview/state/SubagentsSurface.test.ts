import { describe, expect, test } from "bun:test"

import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { MAIN_TAB_ID } from "./AppState"
import { memoryStorage, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * ctrl+s is the `subagents` surface switch (#2190): the overview is a pane of
 * the main conversation, so opening it from another tab brings the
 * conversation forward, and only a shown overview closes.
 */
const setup = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { fetchImpl: async () => new Response("{}", { status: 200 }) })
  return { store, controller }
}

describe("subagents", () => {
  test("toggles the overview beside the conversation", async () => {
    const { store, controller } = await setup()
    expect((await controller.commands.run("subagents")).status).toBe("executed")
    expect(store.session().surface).toBe("subagents")
    expect((await controller.commands.run("subagents")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
  })

  test("from another tab it shows the conversation with the overview open, rather than closing a hidden one", async () => {
    const { store, controller } = await setup()
    await controller.commands.run("subagents")
    await store.dispatch({
      type: "tab.opened",
      actor: "user",
      tab: { id: "card-balance", kind: "card", title: "Balance", cardId: "balance" }
    }).isPersisted.promise
    await store.dispatch({ type: "tab.selected", actor: "user", id: "card-balance" }).isPersisted.promise
    expect(store.session().activeTabId).toBe("card-balance")
    await controller.commands.run("subagents")
    expect(store.session().activeTabId).toBe(MAIN_TAB_ID)
    expect(store.session().surface).toBe("subagents")
  })

  test("the model cannot open it: every subagent is already in the conversation", async () => {
    const { store, controller } = await setup()
    expect((await controller.commands.runForAgent("subagents")).status).not.toBe("executed")
    expect(store.session().surface).toBe("chat")
  })
})
