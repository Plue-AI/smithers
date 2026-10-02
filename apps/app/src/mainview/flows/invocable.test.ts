/*
 * Will's rule, pinned: "Every workflow in the / command menu is meant to be
 * available as a tool call to the agent." A flow listed to the human and
 * refused to the model is the dark-mode bug of 2026-08-31 — the agent said
 * "I don't have a command to toggle the theme" while /appearance.dark-mode
 * sat in the menu. The ONLY listed flows allowed to stay user-only are the
 * enumerated USER_ONLY_VISIBLE set, each with a structural reason.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { USER_ONLY_VISIBLE } from "./Flows"
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

const exceptionNames = USER_ONLY_VISIBLE.map((entry) => entry.name)

describe("every listed flow is a tool call", () => {
  test("visible ⊆ model-invocable, USER_ONLY_VISIBLE excepted", async () => {
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
    // These register only in the admin plugin; their reasons stay listed below.
    const adminRegistered = ["admin.reset", "admin.devtools", "debug.backend", "billing.upgrade", "billing.portal"]
    for (const { name } of USER_ONLY_VISIBLE.filter((e) => !adminRegistered.includes(e.name))) {
      const entry = entries.find((candidate) => candidate.binding.descriptor.name === name)
      expect(`${name} registered`).toBe(`${name} ${entry === undefined ? "missing" : "registered"}`)
      expect(`${name} user-only: ${entry === undefined ? "?" : !modelInvocable(entry)}`).toBe(`${name} user-only: true`)
      expect(`${name} visible: ${visibleNames.has(name)}`).toBe(`${name} visible: true`)
    }
    // Admin-plugin entries register only for admin sessions; their reasons stay listed.
    expect(exceptionNames.filter((name) => adminRegistered.includes(name)).sort()).toEqual([...adminRegistered].sort())
  })

  test("the model toggles dark mode — the reported bug", async () => {
    const { controller, store } = await freshController(EVERYTHING)
    const before = store.session().theme
    const outcome = await controller.commands.runForAgent("appearance.dark-mode")
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
        expect((await controller.commands.runForAgent("appearance.dark-mode", mode)).status).toBe("executed")
        expect(`${from} -> ${mode}: ${store.session().theme}`).toBe(`${from} -> ${mode}: ${mode}`)
      }
      start(from)
      expect((await controller.commands.runForAgent("appearance.dark-mode")).status).toBe("executed")
      expect(store.session().theme).toBe(from === "light" ? "dark" : "light")
    }
    // The grammar is case-insensitive; anything but a mode asks for the mode (THE FORM LAW) and changes nothing.
    start("light")
    expect((await controller.commands.runForAgent("appearance.dark-mode", " DARK ")).status).toBe("executed")
    expect(store.session().theme).toBe("dark")
    const refused = await controller.commands.runForAgent("appearance.dark-mode", "dim")
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
    const outcome = await controller.commands.runForAgent("change.revert", "42")
    // The model's tool result is honest: asked, not done.
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" && outcome.value).toContain("confirm")
    const messages = [...store.collections.messages.values()]
    const confirmation = messages.find((message) => message.action?.flow === "change.revert")
    expect(confirmation?.action?.args).toBe("42")
    // Nothing was reverted: no message reports a revert, only the ask.
    expect(messages.some((message) => message.text.toLowerCase().includes("reverted"))).toBe(false)
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
