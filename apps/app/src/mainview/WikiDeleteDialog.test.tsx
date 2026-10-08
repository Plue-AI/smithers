import { expect, test } from "bun:test"
import { createAppStore } from "./state/AppStore"
import { scopedControllers } from "./state/ControllerTestScope"
import { addWorldNote, memoryStorage, silentAgent } from "./state/TestFixtures"
import { pendingWikiDeleteDocument } from "./WikiDeleteDialog"

const createAppController = scopedControllers()

test("the delete question keeps its exact target through cancel and confirm", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent)
  await addWorldNote(store)
  const note = store.collections.worldDocuments.get("world-home")!
  await controller.commands.run("wiki.delete", note.id)
  expect(pendingWikiDeleteDocument(store.session(), [...store.collections.worldDocuments.values()])?.id).toBe(note.id)
  await controller.commands.run("wiki.delete.cancel")
  expect(store.session().pendingWorldDeleteId).toBeNull()
  expect(store.collections.worldDocuments.get(note.id)).toBeDefined()

  // 3a82c7ada7: the agent requests the shared confirmation before the handler runs.
  expect(await controller.commands.runForAgent("wiki.delete", note.id)).toMatchObject({
    status: "executed", value: expect.stringContaining(`confirm "/wiki.delete ${note.id}"`)
  })
  expect(store.session().pendingWorldDeleteId).toBeNull()
  expect(store.collections.worldDocuments.get(note.id)).toBeDefined()
  const ask = [...store.collections.messages.values()].find(message => message.action?.flow === "wiki.delete")!
  expect(ask.action).toMatchObject({ flow: "wiki.delete", args: note.id })
  for (const answer of ["wiki.delete.confirm", "wiki.delete.cancel"]) {
    expect((await controller.commands.runForAgent(answer)).status).toBe("failed")
  }
  expect(store.collections.worldDocuments.get(note.id)).toBeDefined()
  await controller.commands.run(ask.action!.flow, ask.action!.args)
  expect(store.session().pendingWorldDeleteId).toBe(note.id)
  await controller.commands.run("wiki.delete.cancel")

  await controller.commands.run("wiki.delete", note.id)
  await controller.commands.run("wiki.delete.confirm")
  expect(store.session().pendingWorldDeleteId).toBeNull()
  expect(store.collections.worldDocuments.get(note.id)).toBeUndefined()
})
