import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { localCapabilities } from "@smthrs/rpc/HostCapabilities"
import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import App from "../App"
import { FIRST_RUN_JOBS } from "../cards/SetupChecklist"
import { ControllerTestProvider } from "../ControllerContext"
import { identityMessage, INIT_GREETING, INIT_TITLE, initMessage, SMITHERS_HELPERS } from "../Onboarding"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController as AppControllerType } from "./AppController"
import type { RepositoryJobObservation } from "./AppState"
import { createAppStore } from "./AppStore"
import { repositoryJobObservationId } from "./RepositoryJobs"
import { backend, json, memoryStorage, settle, settled, silentAgent } from "./TestFixtures"

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

  test("cloud host, signed in: no host diagnostic, no repo step and no pill", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      features: { suggestionPills: true },
      bootstrap: { ...localBootstrap, host: "cloud", capabilities: ["identity"], authFlow: "redirect", sandbox: null },
      ...backend({
        "/api/user": json(200, { id: 1, username: "will", is_admin: false })
      })
    })
    await controller.loadSession()
    await settled()
    // Past the signup, so only the cloud rule can hide the host read.
    await controller.commands.run("signup.finish")
    await settled()
    expect(store.session().signup?.stage).toBe("done")

    const host = mount(controller)
    expect(host.querySelector('[data-testid="init-message"]')).toBeNull()
    expect(text(host)).not.toContain(INIT_TITLE)
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

  test("local host, signed out: the signup owns the transcript and the host read waits for it", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: { ...localBootstrap, authFlow: "both" },
      ...backend({
        "/api/user": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] }),
        "/api/repos": json(200, { repos: [] })
      })
    })
    await controller.loadSession()
    await settled()

    const host = mount(controller)
    expect(host.querySelector('[data-testid="signup"]')).not.toBeNull()
    expect([...host.querySelectorAll(SMITHERS_MESSAGES)]).toHaveLength(0)
    expect(text(host)).not.toContain(INIT_TITLE)
    // Signed out changes what the transcript shows, not what it asks: still nothing.
    expect(host.querySelector(".message-cta")).toBeNull()
    expect(host.querySelector("[data-flow=\"repo.open\"]")).toBeNull()
  })

  test("cloud: signed out, the auth state still shows only itself — no init read, no pill", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/user": json(401, { status: "error" }),
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

/*
 * The first app screen (Will, 2026-10-01): the first-run card alone sits at
 * the top, and on the cloud web app Chat arrives with the first registered
 * job, the card's dismissal or the person's first message.
 */
describe("onboarding — the first app screen", () => {
  const cloudBootstrap: AppBootstrap = { ...localBootstrap, host: "cloud", capabilities: ["identity"], authFlow: "redirect", sandbox: null }
  const REPO = "will/demo"

  /** Signed in as will and past the signup, so only the first-run rules decide. */
  const pastSignup = async (bootstrap: AppBootstrap = cloudBootstrap) => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap, ...backend({ "/api/user": json(200, { id: 1, username: "will", is_admin: false }) })
    })
    await controller.loadSession()
    await settled()
    await controller.commands.run("signup.finish")
    await settled()
    expect(store.session().signup?.stage).toBe("done")
    return { store, controller }
  }
  const view = async (host: HTMLElement) => { await settle(); flushSync(() => {}); return host }
  const transcript = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-testid="transcript"]')!
  const footer = (host: HTMLElement) => host.querySelector<HTMLElement>("footer.app-chat-controls")
  const chatDoor = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.app-chat-controls [data-flow="chat.open"]')
  const chatShown = (host: HTMLElement) => footer(host)?.hidden === false && chatDoor(host) !== null
  const keyDown = (host: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
    host.querySelector(".app-shell")?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }))
  const selectRepository = async (store: Awaited<ReturnType<typeof pastSignup>>["store"]) => {
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: REPO, org: "will", ownerKind: "user", name: "demo", head: null }] }).isPersisted.promise
    await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: REPO, phase: "pending" } }).isPersisted.promise
    await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: REPO, phase: "ready" } }).isPersisted.promise
  }
  /** The host's answer for the issues job: registered (paused or not), or known to have none. */
  const observed = (registered: boolean): RepositoryJobObservation => {
    const setup = initialSetup(REPO, "issues", "will")
    return { id: repositoryJobObservationId("will", REPO, null, "issues"), owner: "will", repo: REPO, job: "issues", selectedWorkspaceId: null, state: "completed",
      registration: { state: "known", ...(registered ? { active: { revision: setup.revision, digest: setupCandidate(setup), registrationId: "reg",
        sourceRevision: "source", enabled: true, owned: true, workspaceId: "de29f26b-e593-4ec2-99fc-583d4711f20a", draft: setup.draft } } : {}) } }
  }

  test("the first-run card alone sits at the top; the first conversation entry restores bottom anchoring", async () => {
    const { store, controller } = await pastSignup()
    const host = await view(mount(controller))
    expect(host.querySelector('[data-testid="setup-checklist"]')).not.toBeNull()
    expect(transcript(host).dataset.firstRun).toBe("true")
    expect(transcript(host).hasAttribute("data-signup")).toBe(false)
    await store.dispatch({ type: "message.appended", actor: "system", text: "Repository initialization failed." }).isPersisted.promise
    await view(host)
    expect(host.querySelector('[data-testid="setup-checklist"]')).not.toBeNull()
    expect(transcript(host).hasAttribute("data-first-run")).toBe(false)
  })

  test("the signup and a host's opening read are not the first-run card alone", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const signingUp = createAppController(store, silentAgent, {
      bootstrap: cloudBootstrap, ...backend({ "/api/user": json(200, { id: 1, username: "will", is_admin: false }) })
    })
    await signingUp.loadSession()
    const signup = await view(mount(signingUp))
    expect(signup.querySelector('[data-testid="signup"]')).not.toBeNull()
    expect(transcript(signup).dataset.signup).toBe("true")
    expect(transcript(signup).hasAttribute("data-first-run")).toBe(false)

    const local = await pastSignup(localBootstrap)
    const opening = await view(mount(local.controller))
    expect(opening.querySelector('[data-testid="init-message"]')).not.toBeNull()
    expect(transcript(opening).hasAttribute("data-first-run")).toBe(false)
  })

  test("on the cloud web app Chat waits for the first registered job, then rises in; ⌘K opens it meanwhile", async () => {
    const { store, controller } = await pastSignup()
    await selectRepository(store)
    await store.dispatch({ type: "repository-job.observed", actor: "system", observation: observed(false) }).isPersisted.promise
    const host = await view(mount(controller))
    expect(host.querySelector('[data-testid="setup-checklist"] .setup-checklist-count')?.textContent).toBe("1 of 2")
    expect(footer(host)?.hidden).toBe(true)
    expect(chatDoor(host)).toBeNull()

    // The keyboard door does not depend on the footer.
    keyDown(host, "k", { metaKey: true })
    await view(host)
    expect(store.session().paletteOpen).toBe(true)
    expect(host.querySelector<HTMLElement>('[data-testid="composer-overlay"]')?.hidden).toBe(false)
    expect(host.querySelector('[data-testid="composer-input"]')).not.toBeNull()
    expect(footer(host)?.hidden).toBe(true)
    keyDown(host, "Escape")
    await view(host)
    expect(store.session().paletteOpen).toBe(false)
    keyDown(host, "k", { ctrlKey: true })
    await view(host)
    expect(store.session().paletteOpen).toBe(true)
    keyDown(host, "Escape")
    await view(host)

    await store.dispatch({ type: "repository-job.observed", actor: "system", observation: observed(true) }).isPersisted.promise
    await view(host)
    expect(chatShown(host)).toBe(true)
    expect(footer(host)?.dataset.arriving).toBe("true")
    // Opening Chat with ⌘K above already taught it: the first-sight bubble stays dismissed.
    expect(store.session().hintsSeen).toContain("chat")
  })

  test("dismissing the card or sending a message brings Chat with the same arrival", async () => {
    const dismissed = await pastSignup()
    const first = await view(mount(dismissed.controller))
    expect(chatDoor(first)).toBeNull()
    await dismissed.store.dispatch({ type: "first-run.dismissed", actor: "user" }).isPersisted.promise
    await view(first)
    expect(chatShown(first)).toBe(true)
    expect(footer(first)?.dataset.arriving).toBe("true")
    // Chat never opened: its first-sight ⌘K bubble follows the arrival.
    await view(first)
    expect(first.querySelector('[data-first-sight-hint="chat"] .help-bubble')).not.toBeNull()

    const spoke = await pastSignup()
    const second = await view(mount(spoke.controller))
    expect(chatDoor(second)).toBeNull()
    await spoke.store.dispatch({ type: "message.submitted", actor: "user", turnId: "first-turn", text: "What can you do?" }).isPersisted.promise
    await view(second)
    expect(chatShown(second)).toBe(true)
    expect(footer(second)?.dataset.arriving).toBe("true")
  })

  test("Chat present from load, or revealed by the host's late answer, does not animate", async () => {
    const registered = await pastSignup()
    await selectRepository(registered.store)
    await registered.store.dispatch({ type: "repository-job.observed", actor: "system", observation: observed(true) }).isPersisted.promise
    const loaded = await view(mount(registered.controller))
    expect(chatShown(loaded)).toBe(true)
    expect(footer(loaded)?.hasAttribute("data-arriving")).toBe(false)

    // A reload: the registration is unknown until the host answers, so Chat waits without a withheld arrival.
    const reloaded = await pastSignup()
    await selectRepository(reloaded.store)
    const late = await view(mount(reloaded.controller))
    expect(chatDoor(late)).toBeNull()
    await reloaded.store.dispatch({ type: "repository-job.observed", actor: "system", observation: observed(true) }).isPersisted.promise
    await view(late)
    expect(chatShown(late)).toBe(true)
    expect(footer(late)?.hasAttribute("data-arriving")).toBe(false)
  })

  test("local, desktop and cloud desktop-shell hosts never withhold Chat", async () => {
    for (const bootstrap of [
      localBootstrap,
      { ...cloudBootstrap, host: "local" as const },
      { ...cloudBootstrap, capabilities: ["identity" as const, "native.shell" as const] },
    ]) {
      const { controller } = await pastSignup(bootstrap)
      const host = await view(mount(controller))
      expect(host.querySelector('[data-testid="setup-checklist"]')).not.toBeNull()
      expect(chatShown(host)).toBe(true)
      expect(footer(host)?.hasAttribute("data-arriving")).toBe(false)
    }
  })

  test("a signed-out visitor on a repository page is not past the signup: Chat stays", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: cloudBootstrap, repositoryApp: REPO,
      ...backend({ "/api/user": json(401, { status: "error" }), "/api/auth/scopes": json(200, { scopes: [] }) })
    })
    await controller.loadSession()
    await settled()
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
    const host = await view(mount(controller))
    expect(host.querySelector('[data-testid="signup"]')).toBeNull()
    expect(host.querySelector('section[aria-label="Repository jobs"]')).not.toBeNull()
    expect(chatShown(host)).toBe(true)
  })

  test("with no job tile on offer the cloud web app never withholds Chat", async () => {
    const { controller } = await pastSignup()
    const jobless: AppControllerType = { ...controller, commands: { ...controller.commands,
      all: () => controller.commands.all().filter(command => !(FIRST_RUN_JOBS as readonly string[]).includes(command.name)) } }
    const host = await view(mount(jobless))
    expect(host.querySelector('section[aria-label="Repository jobs"]')).toBeNull()
    expect(chatShown(host)).toBe(true)
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
