import { describe, expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { credentialReceipt, installFixture } from "../../state/seams/InstallFixtures.test-support"
import { modelInvocable, nameOf } from "../registry"
import { cardActions } from "../cardActions"
import { installKeyAction, type InstallCardDispatch } from "../cardActions"

const memoryStorage = (): StorageApi => {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}
const agent: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(done => setTimeout(done, 0)) }
const harness = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<{ path: string; method: string; body?: string | null }> = []
  const cards: string[] = []
  const controller = createAppController(store, agent, {
    presentInstallCard: kind => { cards.push(kind) },
    fetchImpl: async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost:4000").pathname
      requests.push({ path, method: init?.method ?? "GET", body: init?.body?.toString() })
      return path === "/api/install" ? Response.json(installFixture())
        : path === "/api/model/credential" ? Response.json(credentialReceipt(JSON.parse(init!.body!.toString()).name))
        : Response.json({ code: "unknown", class: "infra", message: "Not available" }, { status: 404 })
    }
  })
  return { store, controller, requests, cards }
}
describe("T-APP-03 settings command doors", () => {
  test("settings opens an embedded card through the slash, button and agent doors", async () => {
    const h = await harness()
    try {
      expect((await h.controller.commands.run("settings")).status).toBe("executed"); await tick()
      expect(h.cards).toEqual(["settings"])
      expect((await h.controller.commands.submit({ name: "settings", payload: {}, actor: "user" })).status).toBe("executed"); await tick()
      expect(await h.controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "settings" }) })).toContain("Requested"); await tick()
      expect(h.cards).toEqual(["settings", "settings", "settings"])
      expect(h.store.session().maximizedCardId).toBeNull()
    } finally { await h.controller.dispose() }
  })
  test("hidden controls are agent-invocable and absent from slash suggestions", async () => {
    const h = await harness()
    try {
      for (const name of ["settings.address", "settings.capacity", "settings.parallel", "settings.model-key", "settings.setup"]) {
        const entry = h.controller.commands.find(name)!
        expect(nameOf(entry)).toBe(name); expect(entry.metadata.hidden).toBe(true); expect(modelInvocable(entry)).toBe(true)
      }
      expect(h.controller.slashItems("settings").some(row => row.flow.name.startsWith("settings."))).toBe(false)
    } finally { await h.controller.dispose() }
  })
  test.each(["slash", "button", "agent"] as const)("capacity writes share the same flow from %s", async door => {
    const h = await harness()
    try {
      await h.controller.commands.run("settings"); await tick()
      const result = door === "slash" ? await h.controller.commands.run("settings.capacity", "3")
        : door === "button" ? await h.controller.commands.submit({ name: "settings.capacity", payload: { capacity: 3 }, actor: "user" })
        : await h.controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "settings.capacity", args: "3" }) })
      if (typeof result === "string") expect(result).toContain("Requested")
      else expect(result.status).toBe("executed")
      await tick()
      expect(h.requests.filter(request => request.method === "PUT")).toEqual([{ path: "/api/install", method: "PUT", body: '{"capacity":3}' }])
    } finally { await h.controller.dispose() }
  })
  test("missing model key inputs render the shared write-only form without keeping values", async () => {
    const h = await harness()
    try {
      await h.controller.commands.run("settings"); await tick()
      await h.controller.commands.run("settings.model-key", '{"role":"jev","provider":"AI Gateway","value":"private-key"}')
      const form = [...h.store.collections.cards.values()].find(card => card.kind === "flow-form")
      expect(form?.kind).toBe("flow-form")
      expect(JSON.stringify(form)).not.toContain("private-key")
      expect(h.requests.some(request => request.path === "/api/model/credential")).toBe(false)
    } finally { await h.controller.dispose() }
  })
  test("a card key field reaches the same command once without entering durable card state", async () => {
    const h = await harness()
    try {
      await h.controller.commands.run("settings"); await tick()
      const dispatch: InstallCardDispatch = (tag, input, gesture) =>
        h.controller.commands.submit({ name: tag, payload: input ?? {}, actor: "user", gesture })
      const key = installKeyAction(dispatch, installFixture())
      const bindings = cardActions(key.dispatch, [key.definition])
      bindings.onAction("settings.model-key", { role: "jev", provider: "AI Gateway", value: "private-key" })
      await tick()
      const writes = h.requests.filter(request => request.path === "/api/model/credential")
      expect(writes).toHaveLength(1)
      expect(JSON.parse(writes[0]!.body!)).toEqual({ action: "rotate", name: "AI_GATEWAY_API_KEY", requestId: expect.any(String), value: "private-key" })
      expect(JSON.stringify([...h.store.collections.cards.values()])).not.toContain("private-key")
      expect(JSON.stringify([...h.store.collections.commandIntents.values()])).not.toContain("private-key")
      expect(JSON.stringify(h.controller.installSnapshots.get())).not.toContain("private-key")
    } finally { await h.controller.dispose() }
  })
})
