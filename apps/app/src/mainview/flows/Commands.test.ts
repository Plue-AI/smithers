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
import type { StorageApi } from "@tanstack/db"
import { describe, expect, spyOn, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppServices } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { flow, NoPayload } from "./entries/Declare"
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
        await controller.commands.run("agent.list")
        const card = [...store.collections.cards.values()].find(card => card.kind === "agents")!
        await controller.commands.run("card.maximize", card.id)
        const outcome = await controller.commands.run("agent.list", "", undefined,
          origin === "self" ? card.id : origin === "other" ? "other-card" : undefined)
        expect(outcome.status).toBe("executed")
        expect(store.session().maximizedCardId).toBe(origin === "self" ? card.id : null)
      } finally { await controller.dispose() }
    })
  }

  test("a structured submission preserves only its originating maximized card", async () => {
    const { store, controller } = await freshController()
    try {
      await controller.commands.run("agent.list")
      const card = [...store.collections.cards.values()].find(card => card.kind === "agents")!
      await controller.commands.run("card.maximize", card.id)
      expect((await controller.commands.submit({ name: "agent.list", payload: {}, actor: "user", originCardId: card.id })).status).toBe("executed")
      expect(store.session().maximizedCardId).toBe(card.id)
      expect((await controller.commands.submit({ name: "agent.list", payload: {}, actor: "user" })).status).toBe("executed")
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
    await fixture.controller.commands.run("agent.list")
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

  for (const line of ["/agent.list", "a plain prompt", "/missing-command", "/INPUT.mode vim", "/input.mode"]) {
    test(`Chat retains existing transcript behavior for ${line}`, async () => {
      const { store, controller } = await maximized()
      try {
        expect((await controller.commands.run("chat.send", line)).status).toBe("executed")
        if (line === "/agent.list") await settledCommand(store, "agent.list", 1)
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
