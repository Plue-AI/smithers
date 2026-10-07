import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ControllerTestProvider } from "../ControllerContext"
import { renderCardBody } from "../cards/CardRenderers"
import { viewerAdmitted, type CatalogItem } from "./registry"
import { createDebugApiSeam } from "../state/seams/DebugApiSeam"
/*
 * Commands.ts at the host boundary (docs/web-mode/PLAN.md §1, §3).
 *
 * The web app (bootstrap host "cloud") registers no flow that needs a native
 * door — a local repository, a local terminal, a build target, a host-held
 * Smithers Cloud PAT. Asking for one must be answered HONESTLY and identically by every
 * trigger: a typed slash, a button, and the agent's tool call all get the same
 * `unavailable` outcome and the same download card. Sign-in stays a
 * prerequisite (the requirement axis), never a mode refusal; a name that exists
 * nowhere stays `unknown-command`.
 */
import { createCommandRegistry } from "./Commands"
import { lostActRefusal } from "../state/BrowserWriteFailure"
import type { CommandActions } from "./Flows"
import { Effect } from "effect"
import { Authorize } from "@smthrs/chain"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, spyOn, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppServices } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { flow, NoPayload } from "./entries/Declare"
import { settle } from "../state/TestFixtures"
import { invokeStartupRecovery } from "./StorageRecoveryFlow"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


/** The Worker's bootstrap, built by the function the Worker calls. */
const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: false }),
  authFlow: "redirect",
  sandbox: null
}

const freshController = async (bootstrap?: AppBootstrap, services: Omit<AppServices, "bootstrap"> = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    controller: createAppController(store, unavailableAgent, {
      ...services,
      bootstrap
    })
  }
}

describe("commands from a maximized card", () => {
  for (const origin of ["self", "other", "chat"] as const) {
    test(`${origin} origin decides presentation independently of the flow name`, async () => {
      const { store, controller } = await freshController()
      try {
        await controller.commands.run("agents")
        const card = [...store.collections.cards.values()].find(card => card.kind === "agents")!
        await controller.commands.run("card.maximize", card.id)
        const outcome = await controller.commands.run("agents", "", undefined,
          origin === "self" ? card.id : origin === "other" ? "other-card" : undefined)
        expect(outcome.status).toBe("executed")
        expect(store.session().maximizedCardId).toBe(origin === "self" ? card.id : null)
      } finally { await controller.dispose() }
    })
  }

  test("a structured submission preserves only its originating maximized card", async () => {
    const { store, controller } = await freshController()
    try {
      await controller.commands.run("agents")
      const card = [...store.collections.cards.values()].find(card => card.kind === "agents")!
      await controller.commands.run("card.maximize", card.id)
      expect((await controller.commands.submit({ name: "agents", payload: {}, actor: "user", originCardId: card.id })).status).toBe("executed")
      expect(store.session().maximizedCardId).toBe(card.id)
      expect((await controller.commands.submit({ name: "agents", payload: {}, actor: "user" })).status).toBe("executed")
      expect(store.session().maximizedCardId).toBeNull()
    } finally { await controller.dispose() }
  })
})

describe("Chat slash presentation transport (#3348)", () => {
  const settledCommand = async (store: Awaited<ReturnType<typeof freshController>>["store"], name: string, after = 0) => {
    const deadline = Date.now() + 3000
    while ([...store.collections.commandIntents.values()].filter(row => row.name === name && row.status === "settled").length <= after) {
      if (Date.now() >= deadline) throw new Error(`/${name} did not settle`)
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  }
  const maximized = async () => {
    const fixture = await freshController()
    await fixture.controller.commands.run("agents")
    const card = [...fixture.store.collections.cards.values()].find(card => card.kind === "agents")!
    await fixture.controller.commands.run("card.maximize", card.id)
    return { ...fixture, card }
  }

  for (const door of ["direct", "composer", "structured", "nested"] as const) {
    test(`${door} retained input-mode command keeps the maximized card`, async () => {
      const { store, controller, card } = await maximized()
      try {
        const outcome = door === "direct" ? await controller.commands.run("input.mode", "vim")
          : door === "structured" ? await controller.commands.submit({ name: "chat.send", payload: { text: " /input.mode vim " }, actor: "user" })
          : await controller.commands.run("chat.send", door === "nested" ? "/chat.send /input.mode vim" : " /input.mode vim ")
        expect(outcome.status).toBe("executed")
        await settledCommand(store, "input.mode")
        expect(store.session().inputMode).toBe("vim")
        expect(store.session().maximizedCardId).toBe(card.id)
        expect([...store.collections.messages.values()].filter(row => row.role === "user")).toHaveLength(0)
      } finally { await controller.dispose() }
    })
  }

  for (const initial of ["light", "dark"] as const) for (const door of ["direct", "composer"] as const) {
    test(`${door} original dark-mode toggle preserves a maximized card from ${initial}`, async () => {
      const { store, controller, card } = await maximized()
      try {
        await controller.commands.run("theme", initial)
        const before = [...store.collections.commandIntents.values()].filter(row => row.name === "theme" && row.status === "settled").length
        const outcome = door === "direct" ? await controller.commands.run("theme")
          : await controller.commands.run("chat.send", "/theme")
        expect(outcome.status).toBe("executed")
        await settledCommand(store, "theme", before)
        expect(store.session().theme).toBe(initial === "light" ? "dark" : "light")
        expect(store.session().maximizedCardId).toBe(card.id)
      } finally { await controller.dispose() }
    })
  }

  for (const line of ["/agents", "a plain prompt", "/missing-command", "/INPUT.mode vim", "/input.mode"]) {
    test(`Chat retains existing transcript behavior for ${line}`, async () => {
      const { store, controller } = await maximized()
      try {
        expect((await controller.commands.run("chat.send", line)).status).toBe("executed")
        if (line === "/agents") await settledCommand(store, "agents", 1)
        if (line === "/input.mode") await settledCommand(store, "input.mode")
        expect(store.session().maximizedCardId).toBeNull()
        if (line === "/input.mode") {
          expect([...store.collections.cards.values()].some(card => card.kind === "flow-form" && card.payload.flow === "input.mode")).toBe(true)
        }
        if (line === "/missing-command") expect([...store.collections.commandIntents.values()].some(row => row.name === "missing-command")).toBe(true)
      } finally { await controller.dispose() }
    })
  }
})

const APP_BUG =
  "Smithers hit a bug of its own, so that didn't finish. Not your fault, and nothing about what you did would have avoided it. Reload the page to see where it got to, then make the change again."
const SESSION_REFUSAL =
  "/cloud.sign-in is not in the web app — on the web your GitHub sign-in is your Smithers Cloud sign-in."
const ORIGIN_REFUSAL = "/box.terminal is not available on this origin yet."

/*
 * A thrown host error publishes nothing OF ITS OWN — not its message, not the
 * headers it was carrying. What it publishes instead is this app's sentence
 * for the class of failure it is, chosen from a closed table by the error's
 * TYPE. Publishing nothing at all was the silence: the caller rendered it as
 * "/test failed", the flow's own name with no cause and no next act, which is
 * what a person got when a press's durable write was refused.
 */
test("app flows publish returned refusals, and a thrown host error's class but never its words", async () => {
  const make = (handler: () => string) => flow({ name: "test", input: NoPayload, summary: "Test", handler })
  const refusal = await invokeStartupRecovery(make(() => "Choose an available command."))
  expect(refusal.message).toBe("Flow test failed: Choose an available command.")
  for (const cause of [
    "SYNTHETIC_HOST_SECRET",
    new Error("SYNTHETIC_HOST_SECRET"),
    { headers: { Authorization: "SYNTHETIC_HOST_SECRET" } }
  ]) {
    const failed = await invokeStartupRecovery(make(() => { throw cause }))
    expect(failed.message).toBe(`Flow test failed: ${APP_BUG}`)
    expect(JSON.stringify(failed)).not.toContain("SYNTHETIC_HOST_SECRET")
  }
  // A recognized storage fault keeps its own words, because a person can act on them.
  const full = await invokeStartupRecovery(make(() => { throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" }) }))
  expect(full.message).toBe(`Flow test failed: ${lostActRefusal(Object.assign(new Error("x"), { name: "QuotaExceededError" }))}`)
  expect(JSON.stringify(full)).not.toContain("quota")
})

test("app flows retain thrown causes for host error inspection", async () => {
  const cause = new Error("SYNTHETIC_HOST_SECRET")
  let observed: unknown
  const original = FlowBinding.make
  const make = spyOn(FlowBinding, "make").mockImplementation((options) => original({
    ...options,
    handler: (input, call) => options.handler(input, call).pipe(
      Effect.tapError((error) => Effect.sync(() => { observed = error }))
    )
  }))
  try {
    const entry = flow({ name: "test", input: NoPayload, summary: "Test", handler: () => { throw cause } })
    const result = await invokeStartupRecovery(entry)
    expect(observed).toEqual({ cause })
    expect((observed as { cause: unknown }).cause).toBe(cause)
    // The cause still rides to the host's error tap; only its words stop here.
    expect(result.message).toBe(`Flow test failed: ${APP_BUG}`)
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_HOST_SECRET")
  } finally {
    make.mockRestore()
  }
})

describe("nativeOnly — the flows the web host can never have", () => {
})

describe("explainAbsent — an exact miss classified against the unfiltered catalog, by the door this host lacks", () => {
  test("on the web anything present or nowhere gets nothing", async () => {
    const { controller } = await freshController(WEB)
    // Present flows explain nothing, even ones with an unmet prerequisite.
    expect(controller.commands.explainAbsent("issues.list")).toBeUndefined()
    expect(controller.commands.explainAbsent("sign-out")).toBeUndefined()
    // A name no host has is not a mode problem.
    expect(controller.commands.explainAbsent("does-not-exist")).toBeUndefined()
    expect(controller.commands.explainAbsent("admin.health")).toBeUndefined()
  })

  test("the cloud.pat door is the native app's Smithers Cloud session; the session flows themselves are answered by the GitHub sign-in", async () => {
    const { controller } = await freshController(WEB)
    expect(controller.commands.explainAbsent("cloud.sign-in")).toEqual({ door: "cloud.session", reason: SESSION_REFUSAL })
    expect(controller.commands.explainAbsent("cloud.sign-out")?.door).toBe("cloud.session")
  })

  test("a door this origin could grow is 'not available on this origin yet', never the native app and never 'no such flow'", async () => {
    const { controller } = await freshController(WEB)
    // The W4 relay is off: cloud.terminal is absent, and the native app is not the answer.
    expect(controller.commands.explainAbsent("box.terminal")).toEqual({ door: "origin", reason: ORIGIN_REFUSAL })
    // A Worker without the Smithers Cloud upstream lacks every Smithers Cloud flow the same way.
    const offline = await freshController({
      ...WEB,
      capabilities: cloudCapabilities({ identity: true, cloud: false, agent: true, checkout: false, terminal: false })
    })
    // issues.list also answers from the bundled practice repository (state/practice), so it is never absent; a write is.
    expect(offline.controller.commands.explainAbsent("issues.create")).toEqual({
      door: "origin",
      reason: "/issues.create is not available on this origin yet."
    })
  })
})

describe("the unavailable outcome — one answer for slash, button and agent", () => {

})


describe("trace argument redaction", () => {
  for (const invoker of ["run", "runAsAgent"] as const) {
    for (const [name, args, expected] of [
      ["env.set", "VALUE=ordinary words = more owner/repo", "VALUE=[REDACTED] owner/repo"],
      ["env.set", "malformed-sensitive-input", "[REDACTED]"],
      ["form.set", "form-env.set assignment VALUE=ordinary words", "form-env.set assignment [REDACTED]"],
      ["form.set", "arbitrary-card arbitrary-field ordinary words", "arbitrary-card arbitrary-field [REDACTED]"],
      ["form.submit", "form-env.set", "form-env.set"]
    ]) {
      test(`${invoker} redacts ${name} diagnostics and preserves invocation policy: ${args}`, async () => {
        const records: Parameters<CommandActions["traceFlow"]>[0][] = []
        const received: unknown[][] = []
        const cards: string[] = []
        const actions = {
          docsAvailable: () => false,
          debugApi: createDebugApiSeam({ document: async () => ({ paths: {} }), gates: () => ({ view: false, catalog: false, authorizer: false }), origin: "http://localhost", fetch: async () => { throw Error("dark") } }),
          repositoryFlows: () => undefined,
          knownRepositories: () => new Set(["owner/repo"]),
          snapshot: () => ({ surface: "chat", typing: false, hasConnectors: true, admin: false, signedOut: false }),
          noteCommandRun: () => {},
          traceFlow: (record) => { records.push(record) },
          presentCard: async (kind) => { cards.push(kind); return "Settings" },
          setEnvironmentVar: async (...input) => { received.push(input); return `Invalid ${args}` },
          setFormField: async (...input) => { received.push(input); return `Invalid ${args}` },
          submitForm: async (...input) => { received.push(input); return { value: "Saved VALUE=ordinary words" } }
        } satisfies Partial<CommandActions>
        const commands = createCommandRegistry(actions as unknown as CommandActions)
        const outcome = await commands[invoker](name!, args)
        const refused = name === "env.set" && invoker === "runAsAgent"
        expect(received).toHaveLength(refused ? 0 : 1)
        expect(cards).toEqual(name === "env.set" && !refused ? ["settings"] : [])
        if (refused) expect(outcome.status).toBe("failed")
        expect(records).toHaveLength(1)
        expect(records[0]?.args).toBe(expected!)
        expect(records[0]?.detail).toBe("[REDACTED]")
        if (name === "env.set" && !refused) expect(received[0]?.[0]).toBe(args!.replace(/ owner\/repo$/, ""))
        if (name === "form.set") expect(received[0]?.[2]).toBe(args!.split(/\s+/).slice(2).join(" "))
      })
    }
  }
})

/*
 * A requirement with no fulfilling flow is a pure wait: the app is already
 * settling it, so the command parks and answers now. No form, no prompt.
 */
describe("fulfill-less requirement", () => {
  test("a bare repository command parks, traces the wait, and renders no form", async () => {
    const records: Parameters<CommandActions["traceFlow"]>[0][] = []
    const deferred: Array<[string, string | null, string]> = []
    const forms: unknown[] = []
    const actions = {
      docsAvailable: () => false,
      debugApi: createDebugApiSeam({ document: async () => ({ paths: {} }), gates: () => ({ view: false, catalog: false, authorizer: false }), origin: "http://localhost", fetch: async () => { throw Error("dark") } }),
      repositoryFlows: () => undefined,
      knownRepositories: () => new Set<string>(),
      snapshot: () => ({
        surface: "chat", typing: false, hasConnectors: false, admin: false, signedOut: false,
        firstRunTargetPending: true
      }),
      noteCommandRun: () => {},
      traceFlow: (record) => { records.push(record) },
      deferCommand: (name: string, args: string | null, requirement: string) => { deferred.push([name, args, requirement]) },
      renderFlowForm: (request: unknown) => { forms.push(request); return undefined }
    } satisfies Partial<CommandActions>
    const commands = createCommandRegistry(actions as unknown as CommandActions)
    expect(await commands.run("issues.list")).toEqual({ status: "executed", value: "Requested" })
    expect(deferred).toEqual([["issues.list", null, "first-run-target"]])
    // The park is its own trace; the acknowledgment the door returns is the next one.
    expect(records.map((record) => [record.outcome, record.detail])).toEqual([
      ["deferred", "waits on first-run-target"],
      ["executed", "Requested"]
    ])
    expect(forms).toEqual([])
  })
})


describe("notifications.allow stays dark until its providers are mounted", () => {
  test("person, agent, automatic and preload paths never request browser permission", async () => {
    const { store, controller } = await freshController()
    const original = Object.getOwnPropertyDescriptor(globalThis, "Notification")
    let calls = 0
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: {
      permission: "default", requestPermission: () => { calls++; return Promise.resolve("granted") }
    } })
    try {
      expect(controller.commands.find("notifications.allow")?.binding.descriptor.modelInvocable).toBe(false)
      expect(JSON.stringify(controller.commands.toolSpecs())).not.toContain('"notifications.allow"')
      expect((await controller.commands.run("notifications.allow")).status).toBe("failed")
      expect((await controller.commands.runAsAgent("notifications.allow")).status).toBe("failed")
      expect((await controller.commands.run("notifications.allow", undefined, "automatic")).status).toBe("failed")
      await controller.commands.preload?.("notifications.allow")
      expect(calls).toBe(0)
      store.dispatch({ type: "toast.shown", actor: "system", key: "ordinary", title: "Working" })
      expect(store.collections.toasts.get("toast-ordinary")?.title).toBe("Working")
    } finally {
      if (original) Object.defineProperty(globalThis, "Notification", original)
      else Reflect.deleteProperty(globalThis, "Notification")
      await controller.dispose()
    }
  })
})


describe("Commands catalog through the production dispatcher (T-UI-14)", () => {
  const input: ReadonlyArray<CatalogItem> = [
    { name: "todo.amend", summary: "Change a TODO", args: "Tn", group: "todo", visibility: "core", actors: ["person"], minimumRole: "member", agent: "confirm" },
    { name: "members", summary: "Manage people", group: "chat", visibility: "core", actors: ["person"], minimumRole: "maintainer", agent: "never" },
    { name: "release-notes", summary: "Write release notes", group: "flow", visibility: "core", actors: ["person"], minimumRole: "member", agent: "run" },
    { name: "monitor", summary: "Watch runs", group: "runs", visibility: "advanced", actors: ["person"], minimumRole: "member", agent: "run" },
    { name: "secret", summary: "Hidden", group: "chat", visibility: "hidden", actors: ["person"], minimumRole: "member", agent: "run" },
    { name: "todo.preapprove", summary: "In card", group: "todo", visibility: "in-card", actors: ["person"], minimumRole: "member", agent: "never" },
    { name: "no-policy", summary: "Missing policy", group: "chat", visibility: "core", actors: ["person"], minimumRole: "member" },
    { name: "no-role", summary: "Missing role", group: "chat", visibility: "core", actors: ["person"], agent: "run" },
    { name: "no-actors", summary: "Missing actors", group: "chat", visibility: "core", minimumRole: "member", agent: "run" },
    { name: "unknown", summary: "Missing visibility" }
  ]
  const handlers: Parameters<typeof renderCardBody>[1] = {
    presentation: "embedded", onDecideApproval: () => {}, onConnectGitHub: () => {},
    onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [],
    onChangeWorldDocument: () => {}, onRunCommand: () => { throw new Error("listing executed a command") }
  }
  const invoke = async (fixture: Awaited<ReturnType<typeof freshController>>, slash: boolean) => {
    const { controller, store } = fixture
    const before = [...store.collections.commandIntents.values()].filter(row => row.name === "help" && row.status === "settled").length
    const outcome = await controller.commands.submit({ name: slash ? "chat.send" : "help", payload: slash ? { text: "/help" } : {}, actor: "user" })
    if (slash) {
      const deadline = Date.now() + 3000
      while ([...store.collections.commandIntents.values()].filter(row => row.name === "help" && row.status === "settled").length <= before) {
        if (Date.now() > deadline) throw new Error("/help did not settle")
        await new Promise(resolve => setTimeout(resolve, 1))
      }
    }
    return outcome
  }
  const mountedCard = (fixture: Awaited<ReturnType<typeof freshController>>) => {
    const cards = [...fixture.store.collections.cards.values()].filter(card => card.kind === "commands")
    expect(cards).toHaveLength(1)
    return renderToStaticMarkup(createElement(ControllerTestProvider, { controller: fixture.controller,
      children: renderCardBody(cards[0]!, handlers) }))
  }
  for (const role of ["member", "maintainer"] as const) for (const slash of [false, true]) {
    test(`${role} ${slash ? "chat.send /help" : "help"} mounts one live card without a Markdown catalog`, async () => {
      const fixture = await freshController()
      const provider = spyOn(fixture.controller.commands, "viewerCatalog").mockImplementation(() => viewerAdmitted({ ...fixture.controller.commands.state(), viewerRole: role }, input))
      try {
        expect((await invoke(fixture, slash)).status).toBe("executed")
        const html = mountedCard(fixture)
        expect(html).toContain("/todo.amend Tn")
        expect(html).toContain("Asks first")
        expect(html).toContain("/release-notes")
        expect(html).toContain("Write release notes")
        expect((html.match(/command-policy/g) ?? []).length).toBe(role === "member" ? 1 : 2)
        expect(html.includes("Only you")).toBe(role === "maintainer")
        expect(html.includes("/members")).toBe(role === "maintainer")
        expect(html).toContain('<summary>Advanced</summary>')
        for (const excluded of ["/secret", "/todo.preapprove", "/unknown", "/no-policy", "/no-role", "/no-actors"]) expect(html).not.toContain(excluded)
        expect([...fixture.store.collections.messages.values()].filter(row => row.role === "smithers")).toHaveLength(0)
        await invoke(fixture, slash)
        mountedCard(fixture)
      } finally { provider.mockRestore(); await fixture.controller.dispose() }
    })
  }
  test("unavailable projection refuses without output and recovers on the next invocation", async () => {
    const fixture = await freshController()
    const provider = spyOn(fixture.controller.commands, "viewerCatalog").mockReturnValue(undefined)
    try {
      expect(await invoke(fixture, false)).toMatchObject({ status: "failed", error: "Commands unavailable" })
      await invoke(fixture, true)
      expect([...fixture.store.collections.cards.values()].filter(card => card.kind === "commands")).toHaveLength(0)
      expect([...fixture.store.collections.messages.values()].filter(row => row.role === "smithers")).toHaveLength(0)
      provider.mockImplementation(() => viewerAdmitted({ ...fixture.controller.commands.state(), viewerRole: "member" }, input))
      await invoke(fixture, true)
      expect(mountedCard(fixture)).not.toContain("/members")
    } finally { provider.mockRestore(); await fixture.controller.dispose() }
  })
  test("install /help reads real membership and never uses the disabled design seed", async () => {
    let unavailable = false, suspended = false, reads = 0
    const fixture = await freshController({ ...WEB, capabilities: ["install"], authFlow: "none" }, {
      fetchImpl: async request => {
        if (!String(request).endsWith("/api/members")) return new Response("", { status: 404 })
        reads++
        return unavailable ? new Response("", { status: 503 }) : Response.json({ members: [
          { login: "will", name: "Will", avatar_url: "https://avatars.githubusercontent.com/u/1", color_index: 0,
            role: "owner", needs_access: false, suspended, actions: [] }
        ], access_url: "https://github.com/smithersai/smithers/settings/access" })
      }
    })
    try {
      await fixture.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
      expect(fixture.controller.commands.viewerCatalog()).toBeUndefined()
      expect((await fixture.controller.commands.run("help")).status).toBe("executed")
      expect(reads).toBeGreaterThan(0)
      expect(mountedCard(fixture)).toContain("/help")
      expect(fixture.controller.commands.state().viewerRole).toBe("owner")
      suspended = true
      expect(await fixture.controller.commands.run("help")).toMatchObject({ status: "failed", error: "Commands unavailable" })
      expect(fixture.controller.commands.viewerCatalog()).toBeUndefined()
      unavailable = true
      expect(await fixture.controller.commands.run("help")).toMatchObject({ status: "failed", error: "Commands unavailable" })
      suspended = false; unavailable = false
      expect((await fixture.controller.commands.run("help")).status).toBe("executed")
      expect(mountedCard(fixture)).toContain("/help")
    } finally { await fixture.controller.dispose() }
  })
  test("the real repository projection supplies live inert /help rows without invoking a flow", async () => {
    const fixture = await freshController(WEB, { fetchImpl: async () => new Response("", { status: 404 }) })
    try {
      await fixture.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
      await fixture.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "o/r", org: "o", name: "r", ownerKind: "user", head: null }] }).isPersisted.promise
      await fixture.store.dispatch({ type: "repo.selected", actor: "user", id: "o/r" }).isPersisted.promise
      await settle()
      await fixture.store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: "o/r", flows: [
        { id: "release-notes", description: "Write release notes", summary: "Live repository summary", featured: false, model: null, modelInvocable: true },
        { id: "private-tool", description: "<img src=x onerror=alert(1)>", summary: null, featured: false, model: null, modelInvocable: false }
      ] }).isPersisted.promise
      await invoke(fixture, true)
      const html = mountedCard(fixture)
      expect(html).toContain("/release-notes [owner/repo] [JSON object]")
      expect(html).toContain("Live repository summary")
      expect(html).toContain("/private-tool")
      expect(html).toContain("Only you")
      expect(html).not.toContain("<img")
      expect(fixture.controller.commands.slashItems("release-notes").map(item => item.flow.name)).toEqual(["release-notes"])
      expect([...fixture.store.collections.cards.values()].filter(card => card.kind === "run")).toHaveLength(0)
      expect([...fixture.store.collections.commandIntents.values()].map(row => row.name)).not.toContain("release-notes")
    } finally { await fixture.controller.dispose() }
  })
  test("the real registry supplies /help and rejects its replaced name", async () => {
    const fixture = await freshController()
    try {
      expect((await fixture.controller.commands.run("help")).status).toBe("executed")
      expect(mountedCard(fixture)).toContain("/help")
      expect((await fixture.controller.commands.run("chat.commands")).status).toBe("unknown-command")
    } finally { await fixture.controller.dispose() }
  })
})

// Test-only host contract until T-CAT-01 supplies live scope/role decisions.
describe("debug.api delegated authority precedence", () => {
  for (const message of ["Token scope does not allow this operation", "Member role required", undefined]) {
    test(message ?? "eligible authority reaches the person-only refusal", async () => {
      let transport = 0, decisions = 0
      const fixture = await freshController(undefined, {
        debugApiGates: () => ({ catalog: true, authorizer: true, view: true }),
        fetchImpl: async () => { transport++; throw new Error("unexpected API effect") }
      })
      const refusal = message === undefined ? undefined : new Authorize.AuthorizeError({ code: "denied", message })
      const refused: unknown[] = []
      try {
        for (const args of ["get_api_todos", '{"intent":"send","operationId":"get_api_todos"}', undefined]) {
          const invocation = {
            slot: { chain: "debug-api-contract", link: 0, ordinal: decisions },
            authorize: Authorize.make({ authorize: (request: Authorize.Request) => {
              decisions++
              expect(request.name).toBe("debug.api")
              return refusal === undefined ? Effect.void : Effect.fail(refusal)
            } }),
            refused: (error: Authorize.AuthorizeError) => { refused.push(error) }
          }
          const result = args === undefined
            ? await fixture.controller.commands.submit({ name: "debug.api", actor: "agent", payload: { intent: "send", operationId: "get_api_todos" }, invocation })
            : await fixture.controller.commands.runForAgent("debug.api", args, invocation)
          expect(result.status).toBe("failed")
          if (result.status === "failed") expect(result.error).toContain(message === undefined
            ? "raw API bypasses flow typing and approvals; agents use flows" : "Smithers isn't allowed to run /debug.api here.")
        }
        expect(decisions).toBe(3)
        expect(refused).toEqual(refusal === undefined ? [] : [refusal, refusal, refusal])
        expect(fixture.store.collections.cards.has("debug-api")).toBe(false)
        expect(transport).toBe(0)
      } finally { await fixture.controller.dispose() }
    })
  }
})
