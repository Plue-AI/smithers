import { describe, expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { credentialReceipt, installFixture } from "../../state/seams/InstallFixtures.test-support"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { modelInvocable, nameOf } from "../registry"
import { cardActions } from "../cardActions"
import { installKeyAction, type InstallCardDispatch } from "../../cards/installKeyAction"

const memoryStorage = (): StorageApi => {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}
const agent: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(done => setTimeout(done, 0)) }
const harness = async (bootstrap?: AppBootstrap, install: () => Promise<Response> | Response = () => Response.json(installFixture())) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<{ path: string; method: string; body?: string | null }> = []
  const cards: string[] = []
  const controller = createAppController(store, agent, {
    ...(bootstrap === undefined ? {} : { bootstrap }),
    presentInstallCard: kind => { cards.push(kind) },
    fetchImpl: async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost:4000").pathname
      requests.push({ path, method: init?.method ?? "GET", body: init?.body?.toString() })
      return path === "/api/install" ? install()
        : path === "/api/model/credential" ? Response.json(credentialReceipt(JSON.parse(init!.body!.toString()).name))
        : Response.json({ code: "unknown", class: "infra", message: "Not available" }, { status: 404 })
    }
  })
  return { store, controller, requests, cards }
}
describe("T-APP-03 settings command doors", () => {
  test("settings opens an embedded card through the person doors and refuses an agent", async () => {
    const h = await harness()
    try {
      expect((await h.controller.commands.run("settings")).status).toBe("executed"); await tick()
      expect([...h.store.collections.cards.keys()]).toEqual(["settings"])
      expect((await h.controller.commands.submit({ name: "settings", payload: {}, actor: "user" })).status).toBe("executed"); await tick()
      expect(await h.controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "settings" }) })).toContain("person"); await tick()
      expect([...h.store.collections.cards.keys()]).toEqual(["settings"])
      expect(h.store.session().maximizedCardId).toBeNull()
    } finally { await h.controller.dispose() }
  })
  test("hidden owner controls refuse agents and remain absent from slash suggestions", async () => {
    const h = await harness()
    try {
      for (const name of ["settings.address", "settings.capacity", "settings.parallel", "settings.model-key", "settings.setup"]) {
        const entry = h.controller.commands.find(name)!
        expect(nameOf(entry)).toBe(name); expect(entry.metadata.hidden).toBe(true); expect(modelInvocable(entry)).toBe(false)
      }
      expect(h.controller.slashItems("settings").some(row => row.flow.name.startsWith("settings."))).toBe(false)
    } finally { await h.controller.dispose() }
  })
  test("an unavailable install never presents Settings or mutates the design seed", async () => {
    const h = await harness(undefined, () => Response.json({ code: "unavailable", class: "infra", message: "Install unavailable" }, { status: 503 }))
    try {
      const capacity = h.controller.design.world().repo.capacity
      expect((await h.controller.commands.run("settings")).status).toBe("executed"); await tick()
      expect([...h.store.collections.cards.keys()]).toEqual([])
      expect(h.cards).toEqual([])
      expect(h.controller.installSnapshots.get().error?.message).toBe("Install unavailable")
      await h.controller.commands.run("settings.capacity", "1"); await tick()
      expect(h.requests.filter(request => request.method === "PUT")).toEqual([])
      expect(h.controller.design.world().repo.capacity).toBe(capacity)
    } finally { await h.controller.dispose() }
  })
  test("Settings returns before an unresolved install read and coalesces repeated opens", async () => {
    let resolve!: (response: Response) => void
    const read = new Promise<Response>(done => { resolve = done })
    const h = await harness(undefined, () => read)
    try {
      expect((await h.controller.commands.run("settings")).status).toBe("executed")
      expect((await h.controller.commands.run("settings")).status).toBe("executed"); await tick()
      expect(h.requests.filter(request => request.path === "/api/install")).toHaveLength(1)
      expect([...h.store.collections.cards.keys()]).toEqual([])
      resolve(Response.json(installFixture())); await tick()
      expect([...h.store.collections.cards.keys()]).toEqual(["settings"])
    } finally { resolve(Response.json(installFixture())); await h.controller.dispose() }
  })
  test.each(["slash", "button"] as const)("capacity writes share the same flow from %s", async door => {
    const h = await harness()
    try {
      await h.controller.commands.run("settings"); await tick()
      const result = door === "slash" ? await h.controller.commands.run("settings.capacity", "3")
        : await h.controller.commands.submit({ name: "settings.capacity", payload: { capacity: 3 }, actor: "user" })
      expect(result.status).toBe("executed")
      await tick()
      expect(h.requests.filter(request => request.path === "/api/install" && request.method === "PUT").map(request => JSON.parse(request.body!))).toEqual([{ capacity: 3 }])
    } finally { await h.controller.dispose() }
  })
  test.each([["settings.capacity", "1", "capacity"], ["settings.parallel", "1", "parallel"]] as const)("%s writes the live install, not the seed, once the card shows it", async (name, args, field) => {
    const h = await harness({ apiVersion: 1, host: "local", version: "1.0.0", buildSha: "abcdef1234567890", capabilities: ["agent"], authFlow: "none", sandbox: { platform: "darwin", mode: "enforced" } })
    try {
      await tick()
      expect(h.controller.installSnapshots.get().model).toBeDefined()
      const seeded = h.controller.design.world().repo[field]
      expect((await h.controller.commands.run(name, args)).status).toBe("executed"); await tick()
      const writes = h.requests.filter(request => request.path === "/api/install" && request.method === "PUT")
      expect(writes.map(request => JSON.parse(request.body!))).toEqual([{ [field]: 1 }])
      expect(h.controller.design.world().repo[field]).toBe(seeded)
    } finally { await h.controller.dispose() }
  })
  test.each([
    ['{"step":"address"}', ["bind", "origins"]],
    ['{"step":"address","bind":"127.0.0.1:4000"}', ["origins"]],
    ['{"step":"app_manifest"}', ["owner"]],
    ['{"step":"repository"}', ["repository"]]
  ] as const)("THE FORM LAW: /settings.setup %s renders the step's missing inputs instead of a refusal", async (args, missing) => {
    const h = await harness()
    try {
      const outcome = await h.controller.commands.run("settings.setup", args)
      expect(outcome).toMatchObject({ status: "form", flow: "settings.setup", fields: missing })
      const form = [...h.store.collections.cards.values()].find(card => card.kind === "flow-form")
      expect(form?.kind === "flow-form" ? form.payload.fields.map(field => field.name) : []).toEqual([...missing])
      expect(h.requests.some(request => request.path.startsWith("/api/install/setup"))).toBe(false)
    } finally { await h.controller.dispose() }
  })
  test("a setup step that needs no input runs without a form", async () => {
    const h = await harness()
    try {
      const outcome = await h.controller.commands.run("settings.setup", '{"step":"models"}')
      expect(outcome.status).not.toBe("form")
      expect([...h.store.collections.cards.values()].some(card => card.kind === "flow-form")).toBe(false)
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
    // The local host reads the install at start, so the key write has a model to check against.
    const h = await harness({ apiVersion: 1, host: "local", version: "1.0.0", buildSha: "abcdef1234567890", capabilities: ["agent"], authFlow: "none", sandbox: { platform: "darwin", mode: "enforced" } })
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
