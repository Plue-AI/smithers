import { expect, test } from "bun:test"
import { act } from "react"
import type { CardProps } from "@smthrs/rpc/CardAction"
import type { SettingsCard } from "@smthrs/rpc/SettingsCard"
import { createRoot } from "./views/testDom"
import { SettingsContainer } from "./SettingsContainer"
import { installFixture } from "../state/seams/InstallFixtures.test-support"

import { SettingsView } from "./views/SettingsView"
import { DocsCard } from "./DocsCard"
import { DocsView } from "./views/DocsView"
import { loadDocs } from "../../docs/Docs"
import { diskPageFiles } from "../../docs/DiskPages"
import { scopedControllers } from "../state/ControllerTestScope"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, silentAgent } from "../state/TestFixtures"
const createAppController = scopedControllers()

const PAGE = "quickstart#put-https-in-front"
for (const origin of ["http://mini.local:4000", "https://mini.local", "http://localhost", "http://127.0.0.1", "http://[::1]"]) {
  for (const available of [false, true]) test(`Settings docs at ${origin}, available=${available}`, async () => {
    let props!: CardProps<SettingsCard>, ready = available
    const calls: unknown[] = [], root = createRoot(document.createElement("div"))
    const snapshot = { model: installFixture() }
    await act(async () => root.render(<SettingsContainer View={value => { props = value; return null }}
      owner install={{ get: () => snapshot, subscribe: () => () => {} }} origin={origin}
      docsAvailable={() => ready} dispatch={(tag, input) => { calls.push({ tag, input }) }} view={{ maximized: false }} onView={() => {}} />))
    const action = props.actions.find(row => row.tag === "docs")
    const expected = available && origin === "http://mini.local:4000"
    expect(!!action).toBe(expected)
    if (action) {
      expect(action).toMatchObject({ label: "Notifications need HTTPS ↗", args: { page: PAGE } })
      props.onAction(action.tag, action.args)
      expect(calls).toEqual([{ tag: "docs", input: { page: PAGE } }])
      ready = false
      props.onAction(action.tag, action.args)
      expect(calls).toHaveLength(1)
    } else {
      props.onAction("docs", { page: PAGE })
      expect(calls).toEqual([])
    }
    await act(async () => root.unmount())
  })
}
test("Settings remains owner-only with docs available", async () => {
  let rendered = false
  const root = createRoot(document.createElement("div")), snapshot = { model: installFixture() }
  await act(async () => root.render(<SettingsContainer View={() => { rendered = true; return null }}
    owner={false} install={{ get: () => snapshot, subscribe: () => () => {} }} origin="http://mini.local"
    docsAvailable={() => true} dispatch={() => { throw Error("non-owner") }} view={{ maximized: false }} onView={() => {}} />))
  expect(rendered).toBe(false)
  await act(async () => root.unmount())
})

for (const dependency of ["ready", "catalog", "anchor", "settings"] as const) test(`Settings hint through the real docs dispatcher: ${dependency}`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const docs = loadDocs(diskPageFiles())
  const controller = createAppController(store, silentAgent, {
    docs: () => dependency === "anchor" ? { ...docs, pages: docs.pages.map(page => ({ ...page, markdown: "## Setup" })) } : docs,
    docsCatalogAvailable: () => dependency !== "catalog"
  })
  const host = document.createElement("div"), root = createRoot(host)
  let pending: Promise<unknown> | undefined
  const calls: unknown[] = []
  const snapshot = dependency === "settings" ? {} : { model: installFixture() }
  await act(async () => root.render(<SettingsContainer View={SettingsView} owner origin="http://mini.local:4000"
    install={{ get: () => snapshot, subscribe: () => () => {} }}
    docsAvailable={() => controller.docsTargetAvailable("quickstart#put-https-in-front")}
    dispatch={(name, payload) => {
      calls.push({ name, payload })
      pending = controller.commands.submit({ name, payload: payload ?? {}, actor: "user" })
      return pending
    }} view={{ maximized: false }} onView={() => {}} />))
  try {
    const hint = [...host.querySelectorAll("button")].find(button => button.textContent === "Notifications need HTTPS ↗")
    expect(!!hint).toBe(dependency === "ready")
    if (hint) {
      await act(async () => { hint.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await pending })
      expect(calls).toEqual([{ name: "docs", payload: { page: "quickstart#put-https-in-front" } }])
      const card = store.collections.cards.get("docs-quickstart")!
      if (card.kind !== "docs") throw Error("Expected Docs")
      expect(card.payload).toMatchObject({ page: "quickstart", anchor: "put-https-in-front" })
      await act(async () => root.render(<DocsCard card={card} View={DocsView} available dispatch={() => {}} />))
      expect(host.querySelector("#put-https-in-front")?.textContent).toBe("Put HTTPS in front")
    } else {
      expect(calls).toEqual([])
      expect(store.collections.cards.size).toBe(0)
      if (dependency !== "settings") expect(host.textContent).toContain("Notifications need HTTPS ↗")
    }
    expect(store.session().surface).toBe("chat")
  } finally { await act(async () => root.unmount()) }
})
