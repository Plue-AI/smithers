import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerContext } from "./ControllerContext"
import type { AppController } from "./state/AppController"
import { createAppStore } from "./state/AppStore"
import { addWorldNote, memoryStorage } from "./state/TestFixtures"
import { WorldSurface } from "./WorldSurface"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const tick = () => new Promise(resolve => setTimeout(resolve, 25))

/*
 * The pane's editor must sit in the same registry the cards' editors do:
 * that registry is the only thing that pushes an accepted remote revision
 * (or an agent `remember`) into an open editor. A pane left out of it keeps
 * stale text, and the next keystroke writes that stale text over the peer's.
 */
test("the Wiki pane registers its editor for store pushes, not only for heading scrolls", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await addWorldNote(store)
  await store.dispatch({ type: "input.mode.changed", actor: "user", mode: "vim" }).isPersisted.promise
  const documents = [...store.collections.worldDocuments.values()]
  const attached: Array<[id: string, slot: string, editor: unknown]> = []
  let scrollHandle: unknown = undefined
  const controller = {
    store,
    runCommand: () => {},
    changeWorldDocument: () => {},
    attachWikiEditor: (handle: unknown) => { scrollHandle = handle },
    attachWorldEditor: (id: string, slot: string, editor: unknown) => { attached.push([id, slot, editor]) }
  } as unknown as AppController
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ControllerContext value={controller}><WorldSurface documents={documents} /></ControllerContext>))
  for (let attempt = 0; attempt < 40 && host.querySelector("textarea") === null; attempt++) await tick()
  expect(host.querySelector("textarea")).not.toBeNull()
  expect(scrollHandle).toBeDefined()
  expect(attached.filter(([, , editor]) => editor !== null)).toEqual([[documents[0]!.id, "pane", scrollHandle]])
  flushSync(() => root.unmount())
  host.remove()
  await store.dispose?.()
})
