import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll,afterEach,describe,expect,test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { CONNECTOR_FAILURE, ConnectorsSurface } from "./ConnectorsSurface"
import { ControllerTestProvider } from "./ControllerContext"

import type { AgentPort } from "./runtime/AgentPort"
import type { AppController as AppControllerType } from "./state/AppController"
import { createAppController } from "./state/AppController"
import type { AppStore } from "./state/AppStore"
import { createAppStore } from "./state/AppStore"

/*
 * §11.6 — zero connectors names the next step.
 *
 * The zero case rendered one line, "No repositories connected", with no
 * description and no affordance, while every sibling surface in the same file
 * states a move. It matters most here: on the web the only way to add a
 * repository is the import row, and connector.add answers "native app only",
 * so a reader who is not pointed at import has nowhere obvious to look.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}


const silentAgent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const mount = (controller: AppControllerType): HTMLElement => {

  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <ConnectorsSurface />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return host
}

const openConnectors = async (
  signedIn: boolean
): Promise<{ readonly host: HTMLElement; readonly store: AppStore }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  if (signedIn) {
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "codeplanesmithers",
      admin: false,
      scopesPlain: null
    })
  }
  const controller = createAppController(store, silentAgent, {
    fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" } })
  })
  const host = mount(controller)
  flushSync(() => controller.showConnectors())
  return { host, store }
}

describe("the connectors surface with nothing connected", () => {
  test("signed in, it offers import without explanatory copy", async () => {
    const { host } = await openConnectors(true)
    const empty = host.querySelector(".connector-empty")
    expect(empty).not.toBeNull()
    const text = empty?.textContent ?? ""
    expect(text).toContain("No repositories connected")
    expect(text).not.toContain("Import a GitHub repository")
    expect(host.textContent).not.toContain("hosted workspace storage")
    expect(host.textContent).not.toContain("What Smithers can see and change")
    const action = empty?.querySelector("[data-flow=\"repos.import\"]")
    expect(action).not.toBeNull()
    expect(action?.textContent).toContain("Import a repository")
  })

  test("signed out, the GitHub row remains the sign-in action", async () => {
    const { host } = await openConnectors(false)
    const empty = host.querySelector(".connector-empty")
    const text = empty?.textContent ?? ""
    expect(text).toContain("No repositories connected")
    expect(text).not.toContain("Connecting GitHub above is the first step")
    expect(host.querySelector('button[data-flow="auth.sign-in"]')).not.toBeNull()
    // §1.1: signed out there is exactly one way in, and it is the GitHub row.
    expect(empty?.querySelector("[data-flow=\"repos.import\"]")).toBeNull()
  })
})

describe("the connectors surface with repositories", () => {
  test("it lists the signed-in inventory and drops the empty state", async () => {
    const { host, store } = await openConnectors(true)
    flushSync(() =>
      store.dispatch({
        type: "repositories.loaded",
        actor: "system",
        repositories: [
          { id: "will/smithers", org: "will", ownerKind: "user", name: "smithers", head: null },
          { id: "acme/force", org: "acme", ownerKind: "org", name: "force", head: null },
          { id: "public/catalog", org: "public", ownerKind: "org", name: "catalog", head: null, catalog: true }
        ]
      })
    )
    const section = host.querySelector(".connected-repositories")
    expect(section?.querySelector(".connector-empty")).toBeNull()
    expect(section?.textContent).not.toContain("No repositories connected")
    const listed = Array.from(section?.querySelectorAll("[role=\"listitem\"]") ?? []).map((row) => row.textContent)
    // A public catalog row is readable by anyone; it is not a connected repository.
    expect(listed).toEqual(["acme/force", "will/smithers"])
  })
})

describe("a failed local connect", () => {
  test("is one sentence with the reducer's message only behind Details", async () => {
    const { host, store } = await openConnectors(true)
    const raw = "NotAllowedError: showDirectoryPicker aborted (EACCES /Users/x/repo)"
    flushSync(() => store.dispatch({ type: "connector.local.failed", actor: "system", message: raw }))
    const notice = host.querySelector<HTMLElement>('[data-testid="connector-failure"]')!
    expect(notice.getAttribute("role")).toBe("alert")
    expect(notice.dataset.failure).toBe("ConnectorFailed")
    expect(notice.dataset.fault).toBe(CONNECTOR_FAILURE.fault)
    const sentence = notice.querySelector(":scope > p")?.textContent ?? ""
    expect(sentence).toBe(CONNECTOR_FAILURE.sentence)
    expect(sentence).not.toContain("EACCES")
    expect(notice.querySelector("details")?.open).toBe(false)
    expect(notice.querySelector("details pre")?.textContent).toBe(raw)
  })
})
