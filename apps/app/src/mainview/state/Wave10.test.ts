import { describe, expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { addWorldNote, json, memoryStorage, settled, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * Wave 10 — the embed law's in-app half, transcript hygiene, /clear's sweep,
 * and the sign-in-is-the-connector truth (§2a′). Controller-level, against
 * honest fetch doubles. (The wave's repo-chooser onboarding was retired with
 * the watch subsystem — lane piper.)
 */

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const backend = (
  routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>,
  calls: Array<{ path: string; method: string; body: unknown }> = []
): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    })
    for (const [route, answer] of Object.entries(routes)) {
      if (path === route || path.startsWith(`${route}?`)) {
        return typeof answer === "function"
          ? answer(new Request(absolute.toString(), init))
          : answer.clone()
      }
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

const signIn = async (store: Awaited<ReturnType<typeof webStore>>): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    admin: false,
    scopesPlain: null
  })
  await settled()
}

/** A scripted tool-loop agent (the ToolLoop.test.ts pattern). */
describe("wave 10 — the embed law's in-app half (§2c″)", () => {
  test("the person opens Wiki embedded while browser agent execution refuses", async () => {
    const store = await webStore()
    await addWorldNote(store)
    const controller = createAppController(store, silentAgent)
    const result = await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "wiki" }) })
    expect(result).toBe("failed: this command runs on the conversation host")
    expect((await controller.commands.run("wiki")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect([...store.collections.cards.values()].some(card => card.kind === "world")).toBe(true)
  })
})

describe("wave 10 — transcript hygiene (§2b)", () => {
  test("catalog discovery returns data without a browser turn or raw transcript payload", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent)
    const before = [...store.collections.messages.values()].map(row => row.text)
    const result = await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "list" }) })
    expect(JSON.parse(result).commands.length).toBeGreaterThan(0)
    expect([...store.collections.messages.values()].map(row => row.text)).toEqual(before)
  })
})

describe("wave 10 — the browser tool (§2d)", () => {
  test("the agent's browser call returns the extracted text and renders the embedded card", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/tools/browser-fetch": json(200, {
          status: 200,
          finalUrl: "https://example.com/",
          contentType: "text/html",
          text: "Example Domain — for use in examples.",
          frameable: true,
          blockReason: null
        })
      })
    })
    await signIn(store)
    const result = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "browser.open", args: "https://example.com/" })
    })
    expect(result).toContain("Example Domain")
    const card = store.collections.cards.get("browser-https://example.com/")
    expect(card?.kind).toBe("browser")
    if (card?.kind === "browser") {
      expect(card.payload.frameable).toBe(true)
      expect(card.payload.status).toBe(200)
    }
  })

  test("a site that refuses framing lands the honest blocked state on the card", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/tools/browser-fetch": json(200, {
          status: 200,
          finalUrl: "https://x.com/",
          contentType: "text/html",
          text: "",
          frameable: false,
          blockReason: "The site refuses embedding (X-Frame-Options: DENY)."
        })
      })
    })
    await signIn(store)
    await controller.commands.run("browser.open", "https://x.com/")
    const card = store.collections.cards.get("browser-https://x.com/")
    expect(card?.kind).toBe("browser")
    if (card?.kind === "browser") {
      expect(card.payload.frameable).toBe(false)
      expect(card.payload.blockReason).toContain("X-Frame-Options")
    }
  })

  test("a browser read requested by a model refuses before any browser network act", async () => {
    const store = await webStore()
    const calls: Array<{ path: string; method: string; body: unknown }> = []
    const controller = createAppController(store, silentAgent, backend({}, calls))
    const before = calls.length
    const result = await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "browser", args: "https://example.com/private" }) })
    expect(result).toStartWith("unknown-command: browser")
    expect(calls).toHaveLength(before)
    expect([...store.collections.messages.values()].some(row => row.text.includes("https://example.com/private"))).toBe(false)
  })
})

describe("wave 10 — sign-in IS the GitHub connector (§2a′)", () => {
  test("a signed-in session means connected: the snapshot and the agent context derive it", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent)
    expect(controller.commands.state().hasConnectors).toBe(false)
    await signIn(store)
    expect(controller.commands.state().hasConnectors).toBe(true)
  })

  test("retired debug names cannot start browser tools", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent)
    await signIn(store)
    for (const name of ["debug.snapshot", "debug.events"]) {
      expect(await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name }) })).toStartWith("unknown-command:")
    }
  })
})
