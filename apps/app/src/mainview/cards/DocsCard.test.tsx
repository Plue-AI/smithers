import { expect, test } from "bun:test"
import { act } from "react"
import type { DocsViewProps } from "@smthrs/rpc/DocsCard"
import { createRoot } from "./views/testDom"
import { DocsCard } from "./DocsCard"
import { loadDocs } from "../../docs/Docs"
import { diskPageFiles } from "../../docs/DiskPages"
import { DocsView } from "./views/DocsView"
import { scopedControllers } from "../state/ControllerTestScope"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, silentAgent } from "../state/TestFixtures"

const createAppController = scopedControllers()

test("Docs rendered links dispatch the bundled page and anchor through the real flow seam", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, {
    fetchImpl: async () => new Response("{}", { status: 200 }),
    docsCatalogAvailable: () => true,
    docs: () => loadDocs(diskPageFiles())
  })
  expect((await controller.commands.run("docs")).status).toBe("executed")
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  let pending: Promise<unknown> | undefined
  const render = async (id: string) => {
    const card = store.collections.cards.get(id)!
    if (card.kind !== "docs") throw new Error("Expected a Docs card")
    await act(async () => root.render(<DocsCard card={card} View={DocsView}
      available={controller.docsAvailable()} dispatch={(name, payload) => {
        pending = controller.commands.submit({ name, payload: payload ?? {}, actor: "user" })
        return pending
      }} />))
  }
  try {
    await render("docs-quickstart")
    expect(host.querySelector("h2")?.textContent).toBe("Quickstart")
    const link = [...host.querySelectorAll<HTMLAnchorElement>(".sui-md a")]
      .find(node => node.textContent === "Flows reference")!
    expect(link.dataset.flow).toBe("docs")
    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    await act(async () => { link.dispatchEvent(event); await pending })
    expect(event.defaultPrevented).toBe(true)
    expect(store.collections.cards.get("docs-flows")?.payload).toMatchObject({
      page: "flows", anchor: "change-a-flow"
    })
    await render("docs-flows")
    expect(host.querySelector("h2")?.textContent).toBe("Flows reference")
    expect(host.querySelector("#find-a-command")?.textContent).toBe("Find a command")
    const quickstart = [...host.querySelectorAll<HTMLAnchorElement>("nav a")]
      .find(node => node.textContent === "Quickstart")!
    await act(async () => { quickstart.click(); await pending })
    const reopened = store.collections.cards.get("docs-quickstart")!
    if (reopened.kind !== "docs") throw new Error("Expected a Docs card")
    expect(reopened.payload.anchor).toBeUndefined()
    expect([...store.collections.cards.values()].filter(card => card.kind === "docs")).toHaveLength(2)
    expect(store.session().surface).toBe("chat")
  } finally { await act(async () => root.unmount()); host.remove() }
})

for (const page of loadDocs(diskPageFiles()).pages) test(`Docs projects ${page.slug} verbatim and binds its open gesture`, async () => {
  let props!: DocsViewProps
  const sent: unknown[] = []
  const host = document.createElement("div"), root = createRoot(host)
  const card = { id: "docs", kind: "docs" as const, title: page.title, status: "active" as const, ordinal: 1, createdAt: 0,
    payload: { page: page.slug, markdown: page.markdown, summary: page.summary, anchor: "heading", not_found: "missing" } }
  await act(async () => root.render(<DocsCard card={card} available View={value => { props = value; return null }} dispatch={(tag, input) => { sent.push({ tag, input }) }} />))
  expect(props.model.page).toEqual(page)
  expect(props.model).toMatchObject({ anchor: "heading", not_found: "missing" })
  props.onAction(props.gestures.open!.tag, { page: "quickstart#open-the-command-list" })
  expect(sent).toEqual([{ tag: "docs", input: { page: "quickstart#open-the-command-list" } }])
  await act(async () => root.render(<DocsCard card={card} available={false} View={value => { props = value; return null }} dispatch={() => { throw Error("unavailable dispatch") }} />))
  expect(props.gestures).toEqual({})
  props.onAction("docs", { page: "flows" })
  await act(async () => root.unmount())
})
