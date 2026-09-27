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
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { CallResult } from "@smthrs/harness/Cell"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, spyOn, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { DOWNLOAD_URL } from "@smthrs/rpc/AppLinks"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import { NOT_DOWNLOADABLE_TEXT } from "../state/controller/app"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppServices } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { executeAgentToolCall } from "./agentTools"
import { flow, NoPayload } from "./entries/Declare"
import { invokeStartupRecovery } from "./StorageRecoveryFlow"
import { modelInvocable, nativeOnly } from "./registry"

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

/** The Bun server's bootstrap, built by the function the Bun server calls. */
const NATIVE: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "local",
  capabilities: localCapabilities({ agent: true, identity: true, cloud: true }),
  authFlow: "native-handoff",
  sandbox: { platform: "darwin", mode: "enforced" }
}

/**
 * The release a future apps-v* tag publishes, as the tests that exercise the
 * download door see it. The product's own constant is null until such a
 * release carries an asset (AppLinks.ts), and the null state is tested below.
 */
const RELEASE_URL = "https://example.test/download"

const freshController = async (bootstrap?: AppBootstrap, services: Omit<AppServices, "bootstrap"> = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    controller: createAppController(store, unavailableAgent, {
      downloadUrl: RELEASE_URL,
      ...services,
      bootstrap
    })
  }
}

const settle = async (ticks = 6): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

describe("commands from a maximized card", () => {
  for (const origin of ["self", "other", "chat"] as const) {
    test(`${origin} origin decides presentation independently of the flow name`, async () => {
      const { store, controller } = await freshController()
      try {
        await controller.commands.run("appearance.theme")
        const card = [...store.collections.cards.values()].find(card => card.kind === "theme-picker")!
        await controller.commands.run("card.maximize", card.id)
        const outcome = await controller.commands.run("appearance.theme", "paper", undefined,
          origin === "self" ? card.id : origin === "other" ? "other-card" : undefined)
        expect(outcome.status).toBe("executed")
        expect(store.session().palette).toBe("paper")
        expect(store.session().maximizedCardId).toBe(origin === "self" ? card.id : null)
      } finally { await controller.dispose() }
    })
  }

  test("a structured submission preserves only its originating maximized card", async () => {
    const { store, controller } = await freshController()
    try {
      await controller.commands.run("appearance.theme")
      const card = [...store.collections.cards.values()].find(card => card.kind === "theme-picker")!
      await controller.commands.run("card.maximize", card.id)
      expect((await controller.commands.submit({ name: "appearance.theme", payload: { palette: "paper" }, actor: "user", originCardId: card.id })).status).toBe("executed")
      expect(store.session().maximizedCardId).toBe(card.id)
      expect((await controller.commands.submit({ name: "appearance.theme", payload: { palette: "github" }, actor: "user" })).status).toBe("executed")
      expect(store.session().maximizedCardId).toBeNull()
    } finally { await controller.dispose() }
  })
})

const signIn = (store: AppStore): void => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "codeplanesmithers",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
}

const signOut = (store: AppStore): void => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
}

const messages = (store: AppStore) =>
  [...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal)

const APP_BUG =
  "Smithers hit a bug of its own, so that didn't finish. Not your fault, and nothing about what you did would have avoided it. Reload the page to see where it got to, then make the change again."

const CARD_TEXT =
  "That is not in the web app. Local repositories, terminals, build targets and local agents need the native app."
const CARD_ACTION = { flow: "app.download", label: "Download the app" }
const SESSION_REFUSAL =
  "/cloud.sign-in is not in the web app — on the web your GitHub sign-in is your Smithers Cloud sign-in."
const ORIGIN_REFUSAL = "/box.terminal is not available on this origin yet."

/** The one download card the refusal renders, or a failure naming what rendered instead. */
const downloadCards = (store: AppStore) =>
  messages(store).filter((message) => message.action?.flow === "app.download")

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

test("opaque flow failures use the human command name", async () => {
  const { store, controller } = await freshController(WEB)
  try {
    const entry = controller.commands.find("app.download")!
    spyOn(entry.binding, "run").mockImplementation(() => Effect.succeed(new CallResult({
      outcome: "failure", value: null, code: "flow_failed", message: "Flow app.download failed."
    })))
    expect(await controller.commands.run("app.download")).toEqual({ status: "failed", error: "/app.download failed" })
  } finally {
    await controller.dispose()
    await store.dispose?.()
  }
})

describe("nativeOnly — the flows the web host can never have", () => {
  test("a cloud.pat requirement is native-only; a cloud door alone is not", () => {
    expect(nativeOnly({ summary: "", runtime: ["cloud.pat"] })).toBe(true)
    expect(nativeOnly({ summary: "", runtime: ["cloud", "cloud.pat"] })).toBe(true)
    expect(nativeOnly({ summary: "", runtime: ["cloud"] })).toBe(false)
    expect(nativeOnly({ summary: "", runtime: ["cloud", "cloud.terminal"] })).toBe(false)
    expect(nativeOnly({ summary: "", runtime: ["identity"] })).toBe(false)
    expect(nativeOnly({ summary: "" })).toBe(false)
  })

  test("an either/or flow is native-only only when EVERY alternative is a native door", () => {
    // An either/or flow with a cloud door is reachable on the web.
    expect(nativeOnly({ summary: "", runtimeAny: ["cloud", "cloud.pat"] })).toBe(false)
    expect(nativeOnly({ summary: "", runtimeAny: ["cloud.pat"] })).toBe(true)
    // A native `runtime` beside a cloud `runtimeAny` still needs the native door.
    expect(nativeOnly({ summary: "", runtime: ["cloud.pat"], runtimeAny: ["cloud"] })).toBe(
      true
    )
  })

  test("a flow that names its hosts without the cloud is native-only", () => {
    expect(nativeOnly({ summary: "", hosts: ["local"] })).toBe(true)
    expect(nativeOnly({ summary: "", hosts: ["cloud"] })).toBe(false)
    expect(nativeOnly({ summary: "", hosts: ["cloud", "local"] })).toBe(false)
  })
})

describe("hosts — the download flows exist only on the web", () => {
  test("app.download and app.download.prompt register on the cloud host and nowhere else", async () => {
    const web = await freshController(WEB)
    const webNames = web.controller.commands.all().map((command) => command.name)
    expect(webNames).toContain("app.download")
    expect(webNames).toContain("app.download.prompt")

    const native = await freshController(NATIVE)
    const nativeNames = native.controller.commands.all().map((command) => command.name)
    expect(nativeNames).not.toContain("app.download")
    expect(nativeNames).not.toContain("app.download.prompt")

    // No bootstrap names no host: a host-scoped flow has nowhere to be.
    const unknown = await freshController()
    const unknownNames = unknown.controller.commands.all().map((command) => command.name)
    expect(unknownNames).not.toContain("app.download")
    expect(unknownNames).not.toContain("app.download.prompt")
  })

  test("the button flow is the human's; the prompt flow is the agent's door", async () => {
    const { controller } = await freshController(WEB)
    const download = controller.commands.find("app.download")
    const prompt = controller.commands.find("app.download.prompt")
    expect(download).toBeDefined()
    expect(prompt).toBeDefined()
    if (download === undefined || prompt === undefined) return
    // Chrome button + card action: not listed, not the model's to click.
    expect(download.metadata.hidden).toBe(true)
    expect(modelInvocable(download)).toBe(false)
    // The card renderer: listed under /app. and callable by the model.
    expect(prompt.metadata.hidden).not.toBe(true)
    expect(modelInvocable(prompt)).toBe(true)
    expect(controller.commands.disclosed().map((descriptor) => descriptor.name)).toContain("app.download.prompt")
    expect(controller.slashTree("app.").map((row) => (row.kind === "flow" ? row.flow.name : row.kind === "namespace" ? row.namespace.id : row.text))).toEqual([
      "app.download.prompt"
    ])
  })
})

describe("explainAbsent — an exact miss classified against the unfiltered catalog, by the door this host lacks", () => {
  test("on the web anything present or nowhere gets nothing", async () => {
    const { controller } = await freshController(WEB)
    // Present flows explain nothing, even ones with an unmet prerequisite.
    expect(controller.commands.explainAbsent("issues.list")).toBeUndefined()
    expect(controller.commands.explainAbsent("auth.sign-out")).toBeUndefined()
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

  test("on the native host nothing is native-only-absent; a missing upstream is still an origin miss", async () => {
    const { controller } = await freshController(NATIVE)
    expect(controller.commands.explainAbsent("does-not-exist")).toBeUndefined()
    // The web-only flows are about the other host, not a door this one lacks.
    expect(controller.commands.explainAbsent("app.download")).toBeUndefined()
    const offline = await freshController({
      ...NATIVE,
      capabilities: localCapabilities({ agent: true, identity: false, cloud: false })
    })
    expect(offline.controller.commands.explainAbsent("box.terminal")).toEqual({ door: "origin", reason: ORIGIN_REFUSAL })
  })
})

describe("the unavailable outcome — one answer for slash, button and agent", () => {
  test("the cloud session flows are answered by the GitHub sign-in: no card, no download, one honest line", async () => {
    const { store, controller } = await freshController(WEB)
    signIn(store)
    const outcome = await controller.commands.run("cloud.sign-in")
    expect(outcome).toEqual({ status: "unavailable", door: "cloud.session", reason: SESSION_REFUSAL, action: null })
    expect(downloadCards(store)).toHaveLength(0)
    // The composer path says the same thing as a refusal, never "There is no /cloud.sign-in flow".
    controller.send("/cloud.sign-in")
    await settle()
    const toasts = [...store.collections.toasts.values()]
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.detail).toBe(SESSION_REFUSAL)
    expect(downloadCards(store)).toHaveLength(0)
    // The agent gets the sentence and no pointer at a card that was not rendered.
    const agent = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "cloud.sign-in" })
    })
    expect(agent).toBe(`failed: ${SESSION_REFUSAL}`)
    expect(downloadCards(store)).toHaveLength(0)
  })

  test("a door this origin could grow is refused as such by every trigger, with no card and no 'no such flow'", async () => {
    const { store, controller } = await freshController(WEB)
    signIn(store)
    expect(await controller.commands.run("box.terminal")).toEqual({
      status: "unavailable",
      door: "origin",
      reason: ORIGIN_REFUSAL,
      action: null
    })
    expect(downloadCards(store)).toHaveLength(0)
    controller.send("/box.terminal")
    await settle()
    const toasts = [...store.collections.toasts.values()]
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.title).toBe("This action didn't run")
    expect(toasts[0]?.detail).toBe(ORIGIN_REFUSAL)
    const agent = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "box.terminal" })
    })
    expect(agent).toBe(`failed: ${ORIGIN_REFUSAL}`)
    expect(downloadCards(store)).toHaveLength(0)
  })

  test("a name no host has stays unknown-command, and renders nothing", async () => {
    const { store, controller } = await freshController(WEB)
    expect((await controller.commands.run("does-not-exist")).status).toBe("unknown-command")
    expect(downloadCards(store)).toHaveLength(0)
    controller.send("/does-not-exist")
    await settle()
    expect([...store.collections.toasts.values()].map((toast) => toast.detail)).toEqual([
      "There is no /does-not-exist flow. Type / to see everything Smithers can do."
    ])
    const agent = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "does-not-exist" })
    })
    expect(agent).toStartWith("unknown-command: does-not-exist")
  })

  test("sign-in stays a prerequisite, never a mode refusal", async () => {
    const { store, controller } = await freshController(WEB)
    signOut(store)
    // Present on the web, gated by the requirement axis: the flow DEFERS and sign-in runs.
    const outcome = await controller.commands.run("issues.view", "1")
    expect(outcome.status).not.toBe("unavailable")
    expect(store.session().pendingCommand?.name).toBe("issues.view")
    expect(downloadCards(store)).toHaveLength(0)
    // The agent gets the honest prerequisite, not the download card.
    const agent = await controller.commands.runForAgent("issues.view", "1")
    expect(agent.status).toBe("failed")
    expect(downloadCards(store)).toHaveLength(0)
  })

})

describe("app.download and app.download.prompt", () => {
  test("app.download opens DOWNLOAD_URL in a new tab on the browser shell", async () => {
    const { controller } = await freshController(WEB)
    const opened: Array<ReadonlyArray<unknown>> = []
    const globals = globalThis as { window?: unknown }
    const previous = globals.window
    const popup = { opener: {} as unknown, closed: false, location: { href: "about:blank" }, close: () => { popup.closed = true } }
    globals.window = { open: (...args: ReadonlyArray<unknown>) => { opened.push(args); return popup } }
    try {
      const outcome = await controller.commands.run("app.download")
      expect(outcome.status).toBe("executed")
    } finally {
      if (previous === undefined) delete globals.window
      else globals.window = previous
    }
    expect(opened).toEqual([["about:blank", "_blank"]])
    expect(popup.opener).toBeNull()
    expect(popup.location.href).toBe(RELEASE_URL)
    expect(popup.closed).toBe(false)
  })

  test("there is no download link until a native release carries an asset: no door opens, and the card says so", async () => {
    // 2026-09-02: `gh release view -R smithersai/smithers --json tagName,assets` → v0.35.0, assets: []; no apps-v* release.
    expect(DOWNLOAD_URL).toBeNull()
    const { store, controller } = await freshController(WEB, { downloadUrl: null })
    expect(controller.downloadUrl).toBeNull()
    const opened: Array<unknown> = []
    const globals = globalThis as { window?: unknown }
    const previous = globals.window
    const popup = { opener: {} as unknown, closed: false, location: { href: "about:blank" }, close: () => { popup.closed = true } }
    globals.window = { open: (...args: ReadonlyArray<unknown>) => { opened.push(args); return popup } }
    try {
      expect(await controller.commands.run("app.download")).toEqual({ status: "failed", error: NOT_DOWNLOADABLE_TEXT })
    } finally {
      if (previous === undefined) delete globals.window
      else globals.window = previous
    }
    expect(opened).toEqual([])
    // The offer is still rendered — honestly, without a button the world cannot honour.
    signIn(store)
    expect((await controller.commands.runForAgent("app.download.prompt")).status).toBe("executed")
    const refusals = messages(store).filter((message) => message.text.startsWith("That is not in the web app"))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.text).toBe(`${CARD_TEXT} ${NOT_DOWNLOADABLE_TEXT}`)
    expect(refusals[0]?.action).toBeUndefined()
    expect(downloadCards(store)).toHaveLength(0)
  })

  test("app.download uses the native shell's openExternal door when the page has one", async () => {
    const urls: Array<string> = []
    const { controller } = await freshController(WEB, {
      openExternal: async (url) => {
        urls.push(url)
        return true
      }
    })
    expect((await controller.commands.run("app.download")).status).toBe("executed")
    expect(urls).toEqual([RELEASE_URL])
  })

  test("app.download is user-only: the model is pointed at the prompt flow", async () => {
    const { controller } = await freshController(WEB)
    const result = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "app.download" })
    })
    expect(result).toStartWith("failed: /app.download is user-only")
    expect(result).toContain("app.download.prompt")
  })

  test("app.download.prompt renders the generic card; a name no host has claims nothing about the catalog", async () => {
    const { store, controller } = await freshController(WEB)
    expect((await controller.commands.runForAgent("app.download.prompt")).status).toBe("executed")
    expect((await controller.commands.runForAgent("app.download.prompt", "does-not-exist")).status).toBe("executed")
    const cards = downloadCards(store)
    expect(cards.map((card) => card.text)).toEqual([CARD_TEXT, CARD_TEXT])
    for (const card of cards) expect(card.action).toEqual(CARD_ACTION)
  })

  test("app.download.prompt never stamps 'not in the web app' on a flow that is, or on one the native app does not answer", async () => {
    const { store, controller } = await freshController(WEB)
    signIn(store)
    // Present on the web: the model is told to run it; nothing is rendered.
    expect(await controller.commands.runForAgent("app.download.prompt", "issues.list")).toEqual({
      status: "failed",
      error: "/issues.list is in the web app — run it."
    })
    expect(await controller.commands.runForAgent("app.download.prompt", "/files.read")).toEqual({
      status: "failed",
      error: "/files.read is in the web app — run it."
    })
    // A door this origin could grow: the sentence, no download claim.
    expect(await controller.commands.runForAgent("app.download.prompt", "box.terminal")).toEqual({
      status: "failed",
      error: ORIGIN_REFUSAL
    })
    // The session flows: the GitHub sign-in already is the Cloud sign-in.
    expect(await controller.commands.runForAgent("app.download.prompt", "cloud.sign-in")).toEqual({
      status: "failed",
      error: SESSION_REFUSAL
    })
    expect(downloadCards(store)).toHaveLength(0)
    // Prose is not a flow name: the generic card, claiming nothing about the catalog.
    expect((await controller.commands.runForAgent("app.download.prompt", "open a terminal please")).status).toBe("executed")
    const cards = downloadCards(store)
    expect(cards.map((card) => card.text)).toEqual([
      "That is not in the web app. Local repositories, terminals, build targets and local agents need the native app."
    ])
  })
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
      test(`${invoker} redacts ${name} diagnostics without changing handler input: ${args}`, async () => {
        const records: Parameters<CommandActions["traceFlow"]>[0][] = []
        const received: unknown[][] = []
        const actions = {
          repositoryFlows: () => undefined,
          knownRepositories: () => new Set(["owner/repo"]),
          snapshot: () => ({ surface: "chat", typing: false, hasConnectors: true, admin: false, signedOut: false }),
          noteCommandRun: () => {},
          traceFlow: (record) => { records.push(record) },
          setEnvironmentVar: async (...input) => { received.push(input); return `Invalid ${args}` },
          setFormField: async (...input) => { received.push(input); return `Invalid ${args}` },
          submitForm: async (...input) => { received.push(input); return { value: "Saved VALUE=ordinary words" } }
        } satisfies Partial<CommandActions>
        const commands = createCommandRegistry(actions as unknown as CommandActions)
        await commands[invoker](name!, args)
        expect(received).toHaveLength(1)
        expect(records).toHaveLength(1)
        expect(records[0]?.args).toBe(expected!)
        expect(records[0]?.detail).toBe("[REDACTED]")
        if (name === "env.set") expect(received[0]?.[0]).toBe(args!.replace(/ owner\/repo$/, ""))
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
