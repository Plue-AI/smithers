import { afterEach, describe, expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController, AppServices } from "./AppController"
import { createAppStore } from "./AppStore"

const createAppController = scopedControllers()

const controllers: AppController[] = []
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const until = async (ready: () => boolean) => {
  for (let tick = 0; tick < 200 && !ready(); tick += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(ready()).toBe(true)
}
const boot = async (fetchImpl?: AppServices["fetchImpl"]) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store,
    { available: false, startTurn: async () => ({ status: "error", message: "unused" }), cancelTurn: async () => {}, subscribe: () => () => {} },
    {
      bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: [...RuntimeCapabilitySchema.options], authFlow: "none", sandbox: { platform: "darwin", mode: "enforced" } },
      fetchImpl: async (input, init) => (fetchImpl === undefined ? json({}, 404) : fetchImpl(input, init))
    })
  controllers.push(controller)
  return { store, controller }
}

describe("review regressions: concurrent commands and working-copy identity", () => {
  test("a form claims its submission before the first await and releases it on failure", async () => {
    const gate = deferred()
    let reads = 0
    const { store, controller } = await boot(async (_input, init) => {
      if (init?.method === "POST") {
        reads += 1
        await gate.promise
        return reads === 1 ? json({ status: 200, text: "read" }) : json({ message: "That page couldn't be read." }, 500)
      }
      return json({}, 404)
    })
    expect((await controller.commands.run("browser.open")).status).toBe("form")
    await controller.commands.run("form.set", "form-browser.open url https://example.test/one")
    const first = controller.commands.run("form.submit", "form-browser.open")
    await until(() => reads === 1)
    const card = store.collections.cards.get("form-browser.open")
    expect(card?.kind === "flow-form" && card.payload.submitting).toBe(true)
    expect(await controller.commands.run("form.submit", "form-browser.open")).toMatchObject({ status: "failed", error: expect.stringContaining("being submitted") })
    expect(await controller.commands.run("form.set", "form-browser.open url https://example.test/two")).toMatchObject({ status: "failed" })
    gate.resolve()
    expect((await first).status).toBe("executed")
    expect(reads).toBe(1)
    expect(store.collections.cards.get("form-browser.open")?.status).toBe("acted")

    controller.renderFlowForm({ name: "browser.open", args: "https://example.test/refused", via: "user" })
    await controller.commands.run("form.submit", "form-browser.open")
    const failed = store.collections.cards.get("form-browser.open")
    expect(failed?.kind === "flow-form" && failed.payload.submitting).toBe(false)
    expect(failed?.status).toBe("error")
  })

  test("human presentation remains human while an agent read awaits, and its eventual card remains attributed to the agent", async () => {
    const gate = deferred()
    let reading = false
    const { store, controller } = await boot(async (_input, init) => {
      if (init?.method === "POST") { reading = true; await gate.promise; return json({ status: 200, text: "read" }) }
      return json({}, 404)
    })
    const read = controller.commands.runForAgent("browser.open", "https://example.test")
    await until(() => reading)
    await controller.commands.run("wiki")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.has("world-embedded")).toBe(true)
    expect([...store.collections.transitions.values()].some((row) => row.type === "card.upsert" && row.actor === "user")).toBe(true)
    gate.resolve()
    expect((await read).status).toBe("executed")
    expect([...store.collections.transitions.values()].some((row) => row.type === "card.upsert" && row.actor === "smithers")).toBe(true)
    await controller.commands.runForAgent("wiki")
    expect(store.collections.cards.has("world-embedded")).toBe(true)
    expect(store.session().surface).toBe("chat")
  })


})
