import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { localCapabilities } from "@smthrs/rpc/HostCapabilities"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { identityMessage, INIT_GREETING, INIT_TITLE, initMessage, SMITHERS_HELPERS } from "../Onboarding"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"
import { backend, json, memoryStorage, settled, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * Onboarding — the opening entry of a fresh session.
 *
 * A native session's first message says "Smithers initialized successfully" and reads back
 * what the host registered (bootstrap, capabilities, flows, harnesses,
 * repositories). It asks for nothing: the folder picker retired with the
 * local backend (docs/LOCAL-BACKEND-RETIREMENT.md), so no host can open a
 * repository from this machine and the opening entry carries no next step.
 * Cloud repository pages open with useful Welcome actions and omit the
 * redundant successful host initialization entry.
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

const mount = (controller: AppControllerType): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <App />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return host
}

/** The Bun host under the desktop shell: `native.shell` is the row the ungated opening reads. */
const localBootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "1.0.0",
  buildSha: "abcdef1234567890",
  capabilities: localCapabilities({ agent: true, identity: true, cloud: true, nativeShell: true }),
  authFlow: "none",
  sandbox: null
}

const SMITHERS_MESSAGES = "[data-slot=\"chat-message\"][data-role=\"assistant\"]"

const text = (node: Element | null): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim()

describe("onboarding — the opening entry", () => {
  test("local host, fresh session: the init read is the whole opening — no repo step, no picker", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: localBootstrap,
      features: { suggestionPills: true },
      ...backend({})
    })
    await settled()

    const host = mount(controller)
    const messages = [...host.querySelectorAll(SMITHERS_MESSAGES)].map(text)
    expect(messages).toHaveLength(1)
    const opening = messages[0] ?? ""
    // The agent names itself before it reports anything: the greeting leads, the title follows.
    expect(opening.startsWith("Smithers here.")).toBe(true)
    expect(opening).toContain("Smithers initialized successfully")
    const init = host.querySelector<HTMLElement>("[data-testid=\"init-message\"]")
    expect(init?.querySelector(".message-init-check")).not.toBeNull()
    expect(text(init?.querySelector(".message-init-greeting") ?? null)).toBe("Smithers here.")
    const title = init?.querySelector(".message-init-title") ?? null
    const details = init?.querySelector<HTMLDetailsElement>("details.message-init-details") ?? null
    const summary = details?.querySelector("summary") ?? null
    const detailContent = details?.querySelector(".message-init-details-content") ?? null

    // Native details owns disclosure state: closed by default, with the title outside it.
    expect(details?.open).toBe(false)
    expect(details?.hasAttribute("open")).toBe(false)
    expect(text(summary)).toBe("Details")
    expect(text(title)).toBe("Smithers initialized successfully")
    expect(details?.contains(title)).toBe(false)

    summary?.click()
    expect(details?.open).toBe(true)
    expect(details?.hasAttribute("open")).toBe(true)
    expect(text(detailContent)).toContain("Host: local (1.0.0 abcdef1)")
    // The surviving vocabulary: the rows this host and the Worker both emit.
    expect(text(detailContent)).toContain("Capabilities: agent, model.turn, identity, cloud, cloud.terminal, cloud.pat, native.shell")
    expect(text(detailContent)).toContain(`Flows registered: ${controller.commands.all().length}`)
    expect(text(detailContent)).toContain("Repositories: none open")

    /*
     * Nothing is asked of the reader. The folder picker retired with the local
     * backend, so `repo.open` is registered nowhere and the opening entry
     * carries neither the prompt, the message action, nor the pill.
     */
    expect(controller.commands.find("repo.open")).toBeUndefined()
    expect(host.querySelector(".message-cta")).toBeNull()
    expect(host.querySelectorAll(".smithers-suggestion")).toHaveLength(0)
    expect(text(host)).not.toContain("Select a repo to get started.")
  })

  test("cloud host, signed in: with no local picker there is no repo step and no pill", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      features: { suggestionPills: true },
      ...backend({
        "/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false })
      })
    })
    await controller.loadSession()
    await settled()

    const host = mount(controller)
    expect(text(host.querySelector(SMITHERS_MESSAGES))).toContain("Smithers initialized successfully")
    const pills = [...host.querySelectorAll<HTMLElement>(".smithers-suggestion")]
    expect(pills.map((pill) => text(pill))).not.toContain("Select a repo")
    expect(host.querySelector(".message-cta")).toBeNull()
  })

  test("a selected cloud repository opens without startup chatter and retains failures", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: { ...localBootstrap, host: "cloud", capabilities: ["identity"], authFlow: "redirect", sandbox: null },
      ...backend({})
    })
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
      { id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }
    ] }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "user", id: "will/flows" }).isPersisted.promise
    const host = mount(controller)
    expect(host.querySelector('[data-testid="init-message"]')).toBeNull()
    await store.dispatch({ type: "message.appended", actor: "system", text: "Repository initialization failed. Retry opening the repository." }).isPersisted.promise
    await settled()
    flushSync(() => {})
    expect(host.querySelector('[data-testid="init-message"]')).toBeNull()
    expect(text(host)).not.toContain(INIT_GREETING)
    expect(text(host)).not.toContain(INIT_TITLE)
    expect(text(host)).toContain("Repository initialization failed. Retry opening the repository.")
  })

  test("local host, signed out: sign-in is an option, so the init read still opens the session", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: { ...localBootstrap, authFlow: "both" },
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] }),
        "/api/repos": json(200, { repos: [] })
      })
    })
    await controller.loadSession()
    await settled()

    const host = mount(controller)
    const messages = [...host.querySelectorAll(SMITHERS_MESSAGES)].map(text)
    expect(messages).toHaveLength(1)
    expect((messages[0] ?? "").startsWith("Smithers here.")).toBe(true)
    expect(messages[0] ?? "").toContain("Smithers initialized successfully")
    // Signed out changes what the entry reads, not what it asks: still nothing.
    expect(host.querySelector(".message-cta")).toBeNull()
    expect(host.querySelector("[data-flow=\"repo.open\"]")).toBeNull()
  })

  test("cloud: signed out, the auth state still shows only itself — no init read, no pill", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    await settled()

    const host = mount(controller)
    expect(host.querySelectorAll(SMITHERS_MESSAGES)).toHaveLength(0)
    expect(host.querySelectorAll(".smithers-suggestion")).toHaveLength(0)
  })
})

describe("onboarding — the pill feature flag", () => {
  test("off by default: no pill row in the DOM, and the entry names no step either", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: localBootstrap,
      ...backend({ "/api/repos": json(200, { repos: [] }) })
    })
    expect(controller.features.suggestionPills).toBe(false)
    const host = mount(controller)
    expect(host.querySelector(".smithers-suggestions")).toBeNull()
    expect(host.querySelectorAll(".smithers-suggestion")).toHaveLength(0)
    expect(host.querySelector(".message-cta")).toBeNull()
    expect(host.querySelector("[data-flow=\"repo.open\"]")).toBeNull()
  })
})

describe("onboarding — the pure rules", () => {
  test("an open repository and a connector both read back by name", () => {
    const message = initMessage({
      bootstrap: undefined,
      flowCount: 0,
      connectors: [{ name: "flows", branch: "main" }],
      repositories: [{ id: "smithers" }],
    })
    expect(message.text).toContain("Host: unknown")
    expect(message.text).toContain("Repositories: smithers, flows @ main")
  })

  test("the opening text names Smithers on its first line and keeps the title as the second", () => {
    const lines = initMessage({ bootstrap: undefined, flowCount: 0, connectors: [], repositories: [] }).text.split("\n")
    expect(INIT_GREETING).toBe("Smithers here.")
    expect(lines[0]).toBe(`**${INIT_GREETING}**`)
    expect(lines[1]).toBe(`**${INIT_TITLE}**`)
  })

  test("the identity line is a constant over live facts: honest about an empty host, names only registered helpers", () => {
    const none = identityMessage({
      bootstrap: undefined,
      connectors: [],
      repositories: [],
      activeRepository: null,
      registered: () => false
    })
    expect(none.startsWith("I am Smithers, the concierge of an unknown host; no repository is open yet.")).toBe(true)
    expect(none).not.toContain("Librarian")
    expect(none).not.toContain("Flows agent")
    // One word, never a first name.
    expect(none).not.toMatch(/\bSmith Smithers\b/)

    const full = identityMessage({
      bootstrap: {
        apiVersion: 1,
        host: "cloud",
        version: "test",
        buildSha: "cloud",
        capabilities: [],
        authFlow: "redirect",
        sandbox: null
      },
      connectors: [{ name: "flows", branch: "main" }],
      repositories: [{ id: "smithers" }],
      activeRepository: null,
      registered: (flow) => SMITHERS_HELPERS.some((helper) => helper.flow === flow)
    })
    expect(full).toContain("I am Smithers, the concierge for smithers, flows in the Smithers web app.")
    for (const helper of SMITHERS_HELPERS) expect(full).toContain(helper.line)
  })

  test("the identity line leads with the selected repository and names it once", () => {
    const facts = {
      bootstrap: undefined,
      connectors: [],
      registered: () => false
    }
    const selected = identityMessage({ ...facts, repositories: [], activeRepository: "smithersai/smithers" })
    expect(selected.startsWith("I am Smithers, the concierge for smithersai/smithers in an unknown host.")).toBe(true)
    expect(selected).not.toContain("no repository is open yet")
    const beside = identityMessage({ ...facts, repositories: [{ id: "smithersai/smithers" }, { id: "flows" }], activeRepository: "smithersai/smithers" })
    expect(beside).toContain("the concierge for smithersai/smithers, flows in an unknown host.")
  })
})
