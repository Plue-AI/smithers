import { describe, expect, test } from "bun:test"

import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * `/wiki.new-note` typed from the chat used to create a note in a pane
 * that stayed closed: the act "executed" and nothing on screen changed. The
 * user's and agent's acts both embed the new note and leave the composer visible.
 */


describe("wiki.new-note from the chat", () => {
  test("the user's act embeds the new Wiki note", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.worldDocuments.size
    expect(store.session().surface).toBe("chat")
    expect((await controller.commands.run("wiki.new-note")).status).toBe("executed")
    expect(store.collections.worldDocuments.size).toBe(before + 1)
    expect(store.session().surface).toBe("chat")
    const selected = store.session().selectedWorldDocumentId
    const created = [...store.collections.worldDocuments.values()].find((document) => document.id === selected)
    expect(created?.title).toMatch(/^Untitled/)
    expect(store.collections.cards.get(`wiki-open-${selected}`)?.kind).toBe("world")
    controller.dispose()
  })

  test("the agent's act creates the note and leaves the surface where it was", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.worldDocuments.size
    expect((await controller.commands.runForAgent("wiki.new-note")).status).toBe("executed")
    expect(store.collections.worldDocuments.size).toBe(before + 1)
    expect(store.session().surface).toBe("chat")
  })
})
