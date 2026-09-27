import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { afterAll,afterEach,describe,expect,test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { openRequestedRepo,requestedRepo } from "../RepoLink"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { selectFirstRunRepository } from "./FirstRunRepository"
import { backend, json, memoryStorage, settled, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * One page: the chat. Auth is a conversation state, never a view — these pin
 * that a definitive signed-out or non-allowlisted answer renders THE CHAT
 * (transcript + composer) carrying the one available action, that there is no
 * second surface anywhere, and that the composer's attempted send resolves to
 * the calm one-line reply.
 *
 * Since the signup (apps/app/AGENTS.md, Will 2026-09-20) the landing entry's
 * one action is the signup's GitHub door; a repository URL keeps the opening
 * message and its CTA, and is built here the way the one composition root
 * builds it (ControllerBoot.client.ts: `repositoryApp` is the requested repo).
 */

GlobalRegistrator.register({ url: "https://smithers.sh/" })

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
  window.history.replaceState(null, "", "/")
})

const mount = (controller: AppControllerType, _guide = false): { host: HTMLElement; markup: () => string } => {
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
  return { host, markup: () => host.innerHTML }
}

/** What the Worker emits (docs/web-mode/PLAN.md §1): host `cloud`, built from the same table the server calls. */
const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }),
  authFlow: "redirect",
  sandbox: null
}

const WEB_OPENING = "This is the Smithers web app. Sign in with GitHub to open one of your repositories and read its files here."

describe("auth is a conversation state — the chat is the only page", () => {
  test("signed-out: the chat stays available and sign-in has an explicit embedded door", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, {
          scopes: [{ scope: "read:user", plain: "See your GitHub profile.", why: "Sign-in." }]
        })
      })
    })
    await controller.loadSession()
    await settled()

    await controller.commands.runForAgent("auth.prompt")
    await settled()
    const { host, markup } = mount(controller)
    const html = markup()
    // The chat surface — transcript AND composer — not a landing takeover.
    expect(host.querySelector(".smithers-transcript")).not.toBeNull()
    expect(host.querySelector(".smithers-composer")).not.toBeNull()
    expect(host.querySelector(".landing-surface")).toBeNull()
    // Sign-in is the explicit auth.prompt action; the composer remains available.
    expect(html).not.toContain("sign in with GitHub to continue")
    const signIn = host.querySelector<HTMLButtonElement>("[data-flow=\"auth.sign-in\"]")
    expect(signIn).not.toBeNull()
    expect(signIn?.dataset.flow).toBe("auth.sign-in")
    expect(controller.commands.find("auth.sign-in")).toBeDefined()
    expect(host.querySelector("textarea")?.placeholder).toBe("Ask Smithers to work on something…")
  })

  test("an adopted signed-out session (the server-rendered web boot) still names the scopes", async () => {
    /*
     * Live on canary: the Start build resolves the session on the server and
     * the client adopts it, so the scopes read the client-probe path makes
     * never ran — every signed-out web visitor read "The identity service
     * isn't configured on this deployment" on a deployment where it is.
     */
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/auth/scopes": json(200, {
          scopes: [{ scope: "read:user", plain: "See your GitHub profile.", why: "Sign-in." }]
        })
      })
    })
    await controller.adoptSession({ state: "signed-out", login: null, allowlisted: false, admin: false })
    await settled()

    await controller.commands.runForAgent("auth.prompt")
    await settled()
    const { host, markup } = mount(controller)
    const html = markup()
    expect(html).not.toContain("sign in with GitHub to continue")
    expect(html).not.toContain("The identity service isn't configured")
    expect(host.querySelector("[data-flow=\"auth.sign-in\"]")).not.toBeNull()
    expect(store.collections.identitySessions.get("identity")?.scopesPlain).toContain("See your GitHub profile.")
  })

  test("signed-out: a send reaches the agent; the chat is not gated on identity", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      features: { suggestionPills: true },
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    const { markup } = mount(controller)
    controller.send("is anyone there?")
    await settled()
    flushSync(() => {})
    expect(markup()).not.toContain("Sign in with GitHub first")
    expect(markup()).toContain("is anyone there?")
  })

  test("signed-out shows an empty transcript: no auth message, no welcome, no pills", async () => {
    /*
     * Live earlier today: under the sign-in message the chat still rendered
     * the seeded "Hey — I'm Smithers. Tell me what you're working on" — an
     * invitation to a conversation this session cannot have. §2a″ says a
     * state shows only itself.
     */
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    const html = markup()
    expect(html).not.toContain("sign in with GitHub to continue")
    expect(html).not.toContain("Tell me what you’re working on")
    expect(html).not.toContain("Tell me what you're working on")
    expect(host.querySelector(".smithers-chat-message")).toBeNull()
    const pills = [...host.querySelectorAll(".smithers-suggestion")].map((pill) => pill.textContent)
    expect(pills).toEqual([])
  })

  test("signed-out on the web (host cloud): the landing transcript is the signup, whose GitHub door is auth.sign-in", async () => {
    /*
     * The signup (apps/app/AGENTS.md, Will 2026-09-20) took docs/web-mode/
     * PLAN.md §3's place on the landing entry: a visitor with no account reads
     * the hero and the doors, and the GitHub door is still auth.sign-in. The
     * transcript holds nothing else — no opening read, no checklist, no pills.
     */
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: WEB,
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    expect(host.querySelector('[data-testid="transcript"]')?.hasAttribute("data-repository-missing")).toBe(false)
    expect(host.querySelector('[data-testid="signup"]')?.getAttribute("data-stage")).toBe("sign-in")
    expect(host.querySelector(".signup h1")?.textContent).toBe("Automate your codebase today")
    const door = host.querySelector<HTMLButtonElement>('.signup-door[data-flow="auth.sign-in"]')
    expect(door?.dataset.testid).toBe("signup-github")
    expect(door?.textContent).toBe("Continue with GitHub")
    expect(controller.commands.find("auth.sign-in")).toBeDefined()
    expect([...host.querySelectorAll(".smithers-chat-message")]).toEqual([])
    expect(markup()).not.toContain(WEB_OPENING)
    expect(host.querySelector('[data-testid="setup-checklist"]')).toBeNull()
    expect(host.querySelector('[data-testid="first-run-actions"]')).toBeNull()
    expect(markup()).not.toContain("Smithers initialized")
    expect([...host.querySelectorAll(".smithers-suggestion")]).toEqual([])
    // The chat is still the only page: transcript and composer, no takeover.
    expect(host.querySelector(".smithers-composer")).not.toBeNull()
    expect(host.querySelector(".landing-surface")).toBeNull()
  })

  /*
   * Both halves of the first-run contract, together, because either one alone
   * can be bought with the other: binding the practice repository from the
   * identity seam hides this opening message (App.tsx reads isPracticeRepo),
   * and never binding it resumes a command parked on the choice into a
   * repository form. The choice is boot's (ControllerBoot.client.ts); the seam
   * settles the latch, and makes the choice only for the park that waits on it.
   */
  test("signed-out on the web: the identity seam settles the first-run latch without binding a repository, and a command parked through a raced read still offers sign-in", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: WEB,
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    await settled()
    const { host } = mount(controller)
    expect(host.querySelector<HTMLButtonElement>('.signup-door[data-flow="auth.sign-in"]')?.textContent).toBe("Continue with GitHub")
    expect(store.session().activeRepoKey ?? null).toBeNull()

    const parked = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const waiting = createAppController(parked, silentAgent, {
      bootstrap: WEB,
      // The deadline must not be what settles this: the seam has to announce.
      firstRunSettleMs: 60_000,
      fetchImpl: async (input: unknown): Promise<Response> => {
        const path = new URL(String(input), "https://smithers.sh").pathname
        if (path === "/api/auth/session") {
          await held
          return json(401, { status: "error" })
        }
        if (path === "/api/auth/scopes") return json(200, { scopes: [] })
        return json(404, { status: "error" })
      }
    })
    expect(await waiting.commands.run("issues.list")).toEqual({ status: "executed", value: "Requested" })
    // ControllerBoot.client.ts's non-blocking branch, raced by the focus re-read
    // watchIdentityAcrossTabs makes: the boot closure returns at the epoch guard
    // with nothing to settle, so only the read that writes the row can announce.
    const settle = () => selectFirstRunRepository(parked, waiting.settleFirstRunTarget)
    void waiting.loadSession().then(settle, settle)
    void waiting.loadSession()
    release()

    await waitFor(() => parked.session().pendingCommand?.requirement === "repo-source")
    expect([...parked.collections.cards.values()].filter((card) => card.kind === "flow-form")).toEqual([])
    expect(parked.session().pendingCommand).toMatchObject({ name: "issues.list", requirement: "repo-source" })
  })

  for (const repo of ["nope/nope", "smithersai/smithres", "Some-Owner/repo_name", "cached/selection"]) {
    test(`signed out at /${repo}/ names the requested path and links the available roster`, async () => {
      window.history.replaceState(null, "", `/${repo}/`)
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      const http = backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] }),
        "/api/public/repos": json(200, { repos: [{ name: "smithersai/smithers" }] })
      })
      // ControllerBoot.client.ts passes the requested repository; that is what
      // tells the transcript this page is about a repository, not the signup.
      const controller = createAppController(store, silentAgent, {
        bootstrap: WEB,
        repositoryApp: requestedRepo(window.location) ?? undefined,
        ...http
      })
      await controller.loadSession()
      await openRequestedRepo(controller, http.fetchImpl, repo)
      if (repo === "cached/selection") {
        store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{
          id: "smithersai/smithers", org: "smithersai", ownerKind: "user", name: "smithers", head: null, catalog: true
        }] })
        store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" })
      }
      await settled()
      const { host } = mount(controller)
      const message = host.querySelector(".smithers-chat-message")
      expect(host.querySelector('[data-testid="transcript"]')?.hasAttribute("data-repository-missing")).toBe(true)
      expect(message?.textContent).toContain(`${repo} isn't on Smithers yet. Sign in with GitHub to open your own repositories, or pick one below.`)
      expect(message?.querySelector('a[href="/smithersai/smithers/"]')?.textContent).toBe("smithersai/smithers")
      expect(message?.querySelector<HTMLButtonElement>(".message-cta")?.dataset.flow).toBe("auth.sign-in")
      if (repo !== "cached/selection") expect(controller.commands.state().publicRepo).toBe(false)
    })
  }

  test("a URL projects pending, unavailable and runtime-public catalog receipts without a false sign-in notice", async () => {
    window.history.replaceState(null, "", "/alpha/one/")
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: WEB,
      repositoryApp: requestedRepo(window.location) ?? undefined,
      ...backend({ "/api/auth/session": json(401, {}), "/api/auth/scopes": json(200, { scopes: [] }) })
    })
    await controller.loadSession()
    store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "catalog", repo: "alpha/one", phase: "pending" } })
    await settled()
    const { host } = mount(controller)
    expect(host.querySelector(".smithers-chat-message")).toBeNull()
    store.dispatch({ type: "repository.entry.changed", actor: "system", entry: {
      requestId: "catalog", repo: "alpha/one", phase: "failed", failureKind: "unavailable", error: "The public repository catalog answered HTTP 503."
    } })
    await settled()
    expect(host.querySelector(".smithers-chat-message")?.textContent).toContain("The public repository catalog answered HTTP 503.")
    expect(host.querySelector(".smithers-chat-message .message-cta")).toBeNull()
    expect(host.textContent).not.toContain("isn't on Smithers yet")
    store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "retry", repo: "alpha/one", phase: "pending" } })
    await settled()
    expect(host.querySelector(".smithers-chat-message")).toBeNull()
    store.dispatch({ type: "repository.upserted", actor: "system", repository: {
      id: "alpha/one", org: "alpha", name: "one", ownerKind: "user", head: null, catalog: true
    } })
    store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "retry", repo: "alpha/one", phase: "ready" } })
    await settled()
    expect(host.querySelector(".smithers-chat-message")).toBeNull()
    expect(host.querySelector('[data-repository-missing]')).toBeNull()
  })

  for (const savedSignIn of [false, true]) {
    test(`an unknown repository boot shows its notice after a persisted repository selection (saved sign-in: ${savedSignIn})`, async () => {
      const storage = memoryStorage()
      const http = backend({
        "/api/auth/session": json(401, {}),
        "/api/auth/scopes": json(200, { scopes: [] }),
        "/api/public/repos": json(200, { repos: [{ name: "smithersai/smithers" }] }),
        "/api/repos/smithersai/smithers": json(200, { default_bookmark: "main" }),
      })
      const boot = async () => {
        const store = await createAppStore({ kind: "localStorage", storage })
        const requested = requestedRepo(window.location)!
        const controller = createAppController(store, silentAgent, {
          bootstrap: WEB, repositoryApp: requested, ...http
        })
        await controller.loadSession()
        const refusal = await openRequestedRepo(controller, http.fetchImpl, requested)
        await settled()
        return { store, controller, refusal }
      }

      window.history.replaceState(null, "", "/smithersai/smithers/")
      const first = await boot()
      expect(first.refusal).toBeUndefined()
      if (savedSignIn) await first.controller.commands.run("auth.prompt")
      await first.store.settled?.()
      mounted.pop()?.()
      await first.controller.dispose()

      window.history.replaceState(null, "", "/nope/nope/")
      const reloaded = await boot()
      expect(reloaded.refusal).toBe("nope/nope is not in the public repository catalog.")
      expect(reloaded.store.session().activeRepoKey).toBeNull()
      expect(reloaded.store.session().repositoryEntry).toMatchObject({ repo: "nope/nope", phase: "failed" })
      const { host } = mount(reloaded.controller)
      const notice = host.querySelector('[data-repository-missing] .smithers-chat-message')
      expect(notice).not.toBeNull()
      expect(notice?.textContent).toContain("nope/nope isn't on Smithers yet.")
      expect(notice?.querySelector('[data-flow="auth.sign-in"]')).not.toBeNull()
      expect(window.location.pathname).toBe("/nope/nope/")
    })
  }

  test("signed-out on the web with a catalog repository selected: reads and chat remain available", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: WEB,
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{
        id: "smithersai/smithers",
        org: "smithersai",
        ownerKind: "user",
        name: "smithers",
        head: null,
        catalog: true,
        summary: "Smithers is a durable framework that lets agents plan, run, and review changes to a code repository through flows."
      }]
    })
    store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" })
    await controller.loadSession()
    await settled()

    await settled()

    const { host, markup } = mount(controller)
    expect(markup()).not.toContain(WEB_OPENING)
    expect(markup()).not.toContain("You are exploring")
    expect(host.querySelector(".smithers-chat-message .message-cta")).toBeNull()
    // Repository reads are open to the visitor; a write still waits on sign-in.
    expect(controller.commands.state().publicRepo).toBe(true)
    expect(host.querySelector(".smithers-composer")).not.toBeNull()
  })

  test("signed-out at the landing entry with a repository the catalog did not supply: the signup opens and the write gate stands", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: WEB,
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "acme/private", org: "acme", ownerKind: "org", name: "private", head: null }]
    })
    store.dispatch({ type: "repo.selected", actor: "user", id: "acme/private" })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    // The landing entry belongs to the signup; a remembered selection the
    // catalog never supplied does not open that repository to this visitor.
    expect(host.querySelector('[data-testid="transcript"]')?.hasAttribute("data-repository-missing")).toBe(false)
    expect(host.querySelector('[data-testid="signup"]')?.getAttribute("data-stage")).toBe("sign-in")
    expect(host.querySelector('.signup-door[data-flow="auth.sign-in"]')).not.toBeNull()
    expect([...host.querySelectorAll(".smithers-chat-message")]).toEqual([])
    expect(markup()).not.toContain(WEB_OPENING)
    expect(markup()).not.toContain("You are exploring")
    expect(controller.commands.state().publicRepo).toBe(false)
  })

  test("signed-out in the desktop shell (native.shell) never reads the web opening message", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: { ...WEB, host: "local", capabilities: [...WEB.capabilities, "native.shell"], authFlow: "native-handoff", sandbox: { platform: "darwin", mode: "enforced" } },
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    expect(markup()).not.toContain(WEB_OPENING)
    expect(host.querySelector(".smithers-chat-message .message-cta")).toBeNull()
  })

  test("signed-in but not allowlisted: the same chat carries the request-access message", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/auth/session": json(200, { login: "newcomer", allowlisted: false, admin: false })
      })
    })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    expect(host.querySelector(".smithers-transcript")).not.toBeNull()
    expect(host.querySelector(".smithers-composer")).not.toBeNull()
    expect(host.querySelector(".landing-surface")).toBeNull()
    expect(markup()).toContain("design partners only right now")
    const request = host.querySelector<HTMLButtonElement>("[data-flow=\"auth.request-access\"]")
    expect(request?.textContent).toContain("Request access")
    expect(host.querySelector("textarea")?.placeholder).toBe("Ask Smithers to work on something…")
  })

  test("a definitive $0 keeps the composer live, and a healthy composer renders NO status text (§2g)", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false }),
        "/api/billing/balance": json(200, {
          user: "will",
          balance: { totalUsd: "0", totalNanos: 0, lifetimeChargedUsd: "500", chargeCount: 3 },
          state: "empty",
          allowedToStartWork: false,
          credits: []
        })
      })
    })
    await controller.loadSession()
    await settled()
    await settled()

    const { host, markup } = mount(controller)
    // No balance chrome on the main page (the balance is one act away:
    // /balance); the composer is NOT paused.
    expect(host.querySelector(".corner-balance-chip")).toBeNull()
    expect(markup()).not.toContain("Balance unavailable")
    expect(markup()).not.toContain("$0")
    expect(controller.commands.find("billing.balance")).toBeDefined()
    expect(host.querySelector("textarea")?.placeholder).toBe("Ask Smithers to work on something…")
    // Calm is the budget (§2g): the persistent status line is gone — no
    // "live" chrome when healthy, no standing free-chat sentence.
    expect(markup()).not.toContain("Smithers Cloud · live")
    expect(markup()).not.toContain("chat is on us during the alpha")
    expect(markup()).not.toContain("paused at a $0 balance")
  })

  test("a slow background flow renders on the shared toast stack", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
      toastDebounceMs: 0
    })
    mount(controller)
    const pending = controller.refreshBalance()
    await settled()
    flushSync(() => {})
    const stack = document.querySelector(".toast-stack")
    expect(stack).not.toBeNull()
    expect(stack?.textContent).toContain("Refreshing your balance…")
    release(json(503, { status: "error" }))
    await pending
    await settled()
    flushSync(() => {})
    expect(document.querySelector(".toast-stack")?.textContent).toContain(
      "Your balance couldn't be refreshed right now."
    )
  })
})


test("an unknown repository's explicit sign-in prompt replaces the web opening card", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { bootstrap: WEB,
    ...backend({ "/api/auth/session": json(401, {}), "/api/auth/scopes": json(200, { scopes: [] }) }) })
  await controller.loadSession()
  await controller.commands.run("auth.prompt")
  await settled()
  const { host } = mount(controller)
  expect(host.querySelectorAll('.smithers-chat-message [data-flow="auth.sign-in"]')).toHaveLength(1)
  expect(host.textContent).toContain("Sign in with GitHub to continue.")
})

test("the web wiki empty state offers Create Wiki through the registered flow", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { bootstrap: WEB,
    ...backend({ "/api/auth/session": json(401, {}), "/api/auth/scopes": json(200, { scopes: [] }) }) })
  // Select the repository before opening its Wiki: changing scope replaces the transcript.
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repository.upserted", actor: "system", repository: { id: "smithersai/smithers", org: "smithersai", name: "smithers", ownerKind: "org", head: null, catalog: true } }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" }).isPersisted.promise
  await controller.commands.run("wiki")
  await settled()
  const { host } = mount(controller)
  expect(host.querySelector(".world-card-empty")?.textContent).toContain("No Wiki yet")
  const door = host.querySelector<HTMLButtonElement>('.world-card-empty [data-flow="wiki.create"]')
  expect(door?.textContent).toBe("Create Wiki")
  expect(controller.commands.find("wiki.create")).toBeDefined()
  expect(door?.isConnected).toBe(true)
  door!.click()
  await settled()
  expect(store.session().pendingCommand).toMatchObject({ name: "wiki.create", args: "smithersai/smithers" })
})

test("the expanded empty wiki carries the current repository through Create Wiki", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { bootstrap: WEB })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repository.upserted", actor: "system", repository: { id: "smithersai/smithers", org: "smithersai", name: "smithers", ownerKind: "org", head: null, catalog: true } }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" }).isPersisted.promise
  await store.dispatch({ type: "surface.changed", actor: "user", surface: "world" }).isPersisted.promise
  const { host } = mount(controller)
  expect(host.querySelector(".world-surface")?.textContent).toContain("No Wiki yet")
  host.querySelector<HTMLButtonElement>('.world-surface [data-flow="wiki.create"]')?.click()
  await settled()
  expect(store.session().pendingCommand).toMatchObject({ name: "wiki.create", args: "smithersai/smithers" })
})


test("the signup's sign-in door closes when its identity requirement is met", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { bootstrap: WEB,
    fetchImpl: async () => Response.json({}, { status: 404 }) })
  await controller.adoptSession({ state: "signed-out", login: null, allowlisted: false, admin: false })
  const { host } = mount(controller)
  expect(host.querySelector('.signup-door[data-flow="auth.sign-in"]')).not.toBeNull()
  await controller.adoptSession({ state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: false })
  await settled()
  flushSync(() => {})
  expect(host.querySelectorAll('.signup-door[data-flow="auth.sign-in"]').length).toBe(0)
  expect(host.querySelectorAll('.message-cta[data-flow="auth.sign-in"]').length).toBe(0)
  // The door closes onto the next stage, carrying the login (state/Signup.ts).
  expect(host.querySelector('[data-testid="signup"]')?.getAttribute("data-stage")).toBe("account")
  expect(host.querySelector<HTMLInputElement>('[data-testid="signup-account"]')?.value).toBe("codeplanesmithers")
  // This opening is a live projection, never an appended transcript row.
  expect(store.collections.messages.get("auth-state")).toBeUndefined()
})
