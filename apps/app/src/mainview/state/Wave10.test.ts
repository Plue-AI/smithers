import { describe, expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { addWorldNote, json, memoryStorage, scriptedToolAgent, settled, silentAgent } from "./TestFixtures"

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
  test("'what is in world?' through the tool double: the answer + an embedded card; the surface NEVER changes", async () => {
    const store = await webStore()
    await addWorldNote(store)
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "wiki" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "World holds 1 note: World." },
        { type: "done" as const }
      ]
    ])
    const controller = createAppController(store, agent)
    controller.send("what is in world?")
    await settled()
    await settled()

    // The surface never left the chat — a takeover is structurally unavailable to the agent.
    expect(store.session().surface).toBe("chat")
    // The embedded world card rendered in the transcript.
    const card = store.collections.cards.get("world-embedded")
    expect(card?.kind).toBe("world")
    if (card?.kind === "world") {
      expect(card.payload.documents.map((document) => document.path)).toContain("World.md")
    }
    // The answer text arrived beside it, and the act line is one compact line.
    const texts = [...store.collections.messages.values()].map((message) => message.text)
    expect(texts.some((text) => text.includes("World holds 1 note"))).toBe(true)
    expect(texts).toContain("Smithers ran /wiki")
  })
})

describe("wave 10 — transcript hygiene (§2b)", () => {
  test("a tool act is one compact line; a raw JSON payload can never reach transcript text", async () => {
    const store = await webStore()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "list" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "Here is what I can do." },
        { type: "done" as const }
      ]
    ])
    const controller = createAppController(store, agent)
    controller.send("what can you do?")
    await settled()
    await settled()

    const texts = [...store.collections.messages.values()].map((message) => message.text)
    expect(texts).toContain("Smithers checked what it can do here")
    for (const text of texts) {
      expect(text).not.toContain("{\"state\"")
      expect(text).not.toContain("\"commands\":[")
    }
    // The act line's actor is smithers, never the user.
    const act = [...store.collections.messages.values()].find((message) => message.act !== undefined)
    expect(act?.role).toBe("smithers")
    // The full-fidelity record lives in the tool-call stream for the admin panel.
    const records = [...store.collections.toolCalls.values()]
    expect(records).toHaveLength(1)
    expect(records[0]?.result).toContain("\"state\"")
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

  test("the browser act line names the host, never the payload", async () => {
    const store = await webStore()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "browser.open", args: "https://example.com/" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "The page says: Example Domain." },
        { type: "done" as const }
      ]
    ])
    const controller = createAppController(store, agent, {
      ...backend({
        "/api/tools/browser-fetch": json(200, {
          status: 200,
          finalUrl: "https://example.com/",
          contentType: "text/html",
          text: "Example Domain",
          frameable: true,
          blockReason: null
        })
      })
    })
    controller.send("read https://example.com for me")
    await settled()
    await settled()
    await settled()

    const texts = [...store.collections.messages.values()].map((message) => message.text)
    expect(texts).toContain("Smithers read example.com")
    for (const text of texts) {
      expect(text).not.toContain("Example Domain —")
    }
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

  test("the agent answering from the debug reads (admin) — snapshot/events contracts", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent)
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      admin: true,
      scopesPlain: null
    })
    await settled()
    const snapshot = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "debug.snapshot" })
    })
    const parsed = JSON.parse(snapshot) as { surface: string; identity: { login: string } }
    expect(parsed.surface).toBe("chat")
    expect(parsed.identity.login).toBe("will")
    const events = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "debug.events" })
    })
    expect(JSON.parse(events)).toBeInstanceOf(Array)
  })
})
