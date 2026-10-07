/*
 * Will's rule, pinned: "Every workflow in the / command menu is meant to be
 * available as a tool call to the agent." A flow listed to the human and
 * refused to the model is the dark-mode bug of 2026-08-31 — the agent said
 * "I don't have a command to toggle the theme" while /theme
 * sat in the menu. The ONLY listed flows allowed to stay user-only are the
 * literal Appendix A person-only set, each with a structural reason.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { modelInvocable, visible } from "./registry"

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


const freshController = async (bootstrap?: AppBootstrap) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    controller: createAppController(store, unavailableAgent, { bootstrap, features: {} })
  }
}

/**
 * Every host capability at once, so the invariant covers every registerable
 * flow — read from the schema, so a capability added there (cloud.pat,
 * cloud.terminal) cannot silently drop a flow out of this gate.
 */
const EVERYTHING: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "test",
  capabilities: [...RuntimeCapabilitySchema.options],
  authFlow: "both",
  sandbox: { platform: "darwin", mode: "enforced" }
}

// T-CAT-01: only Appendix A core/advanced commands are menu rows.
const exceptionNames = ["chat.send", "stop", "debug-api", "settings", "secrets", "members", "ssh", "sign-in", "sign-out"]

describe("every listed flow is a tool call", () => {
  test("visible ⊆ model-invocable, Appendix A person-only commands excepted", async () => {
    const { controller } = await freshController(EVERYTHING)
    const entries = controller.commands.entries()
    const offenders = visible(controller.commands.all())
      .map((item) => item.name)
      .filter((name) => {
        const entry = entries.find((candidate) => candidate.binding.descriptor.name === name)
        return entry !== undefined && !modelInvocable(entry) && !exceptionNames.includes(name)
      })
    expect(offenders).toEqual([])
  })

  test("the exception list is exact: every entry is registered, visible, and user-only", async () => {
    const { controller } = await freshController(EVERYTHING)
    const entries = controller.commands.entries()
    const visibleNames = new Set(visible(controller.commands.all()).map((item) => item.name))
    expect(entries.filter(entry => visibleNames.has(entry.binding.descriptor.name) && !modelInvocable(entry))
      .map(entry => entry.binding.descriptor.name).sort()).toEqual([...exceptionNames].sort())
    for (const name of exceptionNames) {
      const entry = entries.find(candidate => candidate.binding.descriptor.name === name)!
      expect(entry.metadata.agent).toBe("never")
      expect(entry.metadata.actors).toEqual(["person"])
      expect(entry.metadata.agentReason?.length).toBeGreaterThan(0)
    }
  })

  test("the model toggles dark mode — the reported bug", async () => {
    const { controller, store } = await freshController(EVERYTHING)
    const before = store.session().theme
    const outcome = await controller.commands.runForAgent("theme")
    expect(outcome.status).toBe("executed")
    expect(store.session().theme).not.toBe(before)
    const palette = await controller.commands.runForAgent("appearance.theme", "paper")
    expect(palette.status).not.toBe("executed")
    expect(store.session().palette).toBe("paper")
  })

  test("dark-mode sets the named mode from either start, and bare toggles (#3311)", async () => {
    const { controller, store } = await freshController(EVERYTHING)
    const start = (theme: "light" | "dark") => store.dispatch({ type: "theme.changed", actor: "user", theme })
    for (const from of ["light", "dark"] as const) {
      for (const mode of ["light", "dark"] as const) {
        start(from)
        expect((await controller.commands.runForAgent("theme", mode)).status).toBe("executed")
        expect(`${from} -> ${mode}: ${store.session().theme}`).toBe(`${from} -> ${mode}: ${mode}`)
      }
      start(from)
      expect((await controller.commands.runForAgent("theme")).status).toBe("executed")
      expect(store.session().theme).toBe(from === "light" ? "dark" : "light")
    }
    // The grammar is case-insensitive; anything but a mode asks for the mode (THE FORM LAW) and changes nothing.
    start("light")
    expect((await controller.commands.runForAgent("theme", " DARK ")).status).toBe("executed")
    expect(store.session().theme).toBe("dark")
    const refused = await controller.commands.runForAgent("theme", "dim")
    expect(refused.status).toBe("form")
    expect(store.session().theme).toBe("dark")
  })

  test("a confirm flow asked for by the model posts the confirmation and performs nothing", async () => {
    const { controller, store } = await freshController(EVERYTHING)
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      admin: false,
      scopesPlain: null
    })
    const outcome = await controller.commands.runForAgent("runs.resume", "run-42")
    // The model's tool result is honest: asked, not done.
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" && outcome.value).toContain("confirm")
    const messages = [...store.collections.messages.values()]
    const confirmation = messages.find((message) => message.action?.flow === "runs.resume")
    expect(confirmation?.action?.args).toBe("run-42")
    expect([...store.collections.runtimeRuns.values()]).toEqual([])
  })
})

test("debug.reset requested by the agent asks before clearing local data", async () => {
  const { controller, store } = await freshController(EVERYTHING)
  controller.changeDraft("keep this draft")
  const outcome = await controller.commands.runForAgent("debug.reset")
  expect(outcome.status).toBe("executed")
  expect(outcome.status === "executed" && outcome.value).toContain("confirm")
  expect(store.session().draft).toBe("keep this draft")
  expect([...store.collections.messages.values()].some(message => message.action?.flow === "debug.reset")).toBe(true)
  await controller.dispose()
})
