import { afterEach, describe, expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import type { Repo } from "@smthrs/rpc/LocalApp"
import { fileArgs } from "../flows/FileArgs"
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
const repo = (id: string, path: string): Repo => ({
  id, path, name: "acme/project", git: { branch: id, remote: "https://github.com/acme/project.git" }, warnings: [],
  smithers: { detected: true, workspaceFile: null, declarationFiles: [], reason: "", workspaces: [] }
})

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
    await controller.commands.run("world")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.has("world-embedded")).toBe(true)
    expect([...store.collections.transitions.values()].some((row) => row.type === "card.upsert" && row.actor === "user")).toBe(true)
    gate.resolve()
    expect((await read).status).toBe("executed")
    expect([...store.collections.transitions.values()].some((row) => row.type === "card.upsert" && row.actor === "smithers")).toBe(true)
    await controller.commands.runForAgent("world")
    expect(store.collections.cards.has("world-embedded")).toBe(true)
    expect(store.session().surface).toBe("chat")
  })

  test("same-remote copies have separate file cards and a spaced path round-trips through commands and forms", async () => {
    const bodies: Array<{ repoId: string; path: string }> = []
    const { store, controller } = await boot(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { repoId: string; path: string }
      bodies.push(body)
      return json({ kind: "file", path: body.path, size: 10, content: body.repoId, truncated: false, binary: false })
    })
    const first = repo("repo-a", "/work/a"), second = repo("repo-b", "/work/b")
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [first, second] })
    const path = "docs/Meeting Notes.md"
    expect((await controller.commands.run("files.read", fileArgs(path, second.id))).status).toBe("executed")
    expect(bodies.at(-1)).toEqual({ repoId: second.id, path })
    await controller.commands.run("files.read", fileArgs(path, first.id))
    expect(store.collections.cards.get(`file-${first.id}-${path}`)?.payload).toMatchObject({ localRepoId: first.id, content: first.id })
    expect(store.collections.cards.get(`file-${second.id}-${path}`)?.payload).toMatchObject({ localRepoId: second.id, content: second.id })
    expect(await controller.commands.run("files.read", fileArgs(path, first.name))).toMatchObject({ status: "failed", error: expect.stringContaining("several open working copies") })
    controller.renderFlowForm({ name: "files.read", args: fileArgs(path, second.id), via: "user" })
    await controller.commands.run("form.submit", "form-files.read")
    expect(bodies.at(-1)).toEqual({ repoId: second.id, path })
  })
})
