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
    allowlisted: true,
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
          arguments: JSON.stringify({ action: "execute", name: "world" })
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
    expect(texts).toContain("Smithers ran /world")
  })

  test("the agent's connect invocation renders the embedded connect card, not the pane", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent)
    await signIn(store)
    const result = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "connect" })
    })
    expect(result).toBe("executed /connect")
    expect(store.session().surface).toBe("chat")
    const card = store.collections.cards.get("connect-embedded")
    expect(card?.kind).toBe("connect")
    if (card?.kind === "connect") {
      // Sign-in IS the connector (§2a′): the signed-in session reads Connected.
      expect(card.payload.github).toEqual({ connected: true, login: "will" })
    }
  })
})

test("the human connect door embeds the same repository controls without opening a pane", async () => {
  const store = await webStore()
  const controller = createAppController(store, silentAgent)
  await signIn(store)
  expect((await controller.commands.run("connect")).status).toBe("executed")
  expect(store.session().surface).toBe("chat")
  expect(store.collections.cards.get("connect-embedded")?.kind).toBe("connect")
  await controller.dispose()
  await store.dispose?.()
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

describe("/chat.clear — optional summaries and atomic local archives", () => {
  test("an explicit summary commits new world notes and the archive together", async () => {
    const store = await webStore()
    const calls: Array<{ path: string; method: string; body: unknown }> = []
    const controller = createAppController(store, silentAgent, {
      ...backend(
        {
          "/api/model/stream": () =>
            new Response(
              `${
                JSON.stringify({
                  runId: "sweep",
                  type: "delta",
                  kind: "text",
                  text:
                    "{\"notes\":[{\"title\":\"Prefers dark mode\",\"body\":\"The user keeps the app in dark mode.\",\"confidence\":0.9}]}"
                })
              }\n${JSON.stringify({ runId: "sweep", type: "done", reason: "stop" })}\n`,
              { status: 200, headers: { "content-type": "application/x-ndjson" } }
            )
        },
        calls
      )
    })
    await signIn(store)
    controller.send("remember that I prefer dark mode")
    await settled()
    // There is a real transcript to sweep. Wave 14 §1 removed the seeded
    // welcome, so this is the user's own turn and nothing else.
    const beforeClear = [...store.collections.messages.values()]
    expect(beforeClear.length).toBeGreaterThan(0)
    expect(beforeClear.some((message) => message.text === "remember that I prefer dark mode")).toBe(true)

    const outcome = await controller.commands.run("chat.clear", "--summarize")
    expect(outcome.status).toBe("executed")
    await settled()

    // The sweep is a model call, so it rode the one metered model route.
    expect(calls.some((call) => call.path === "/api/model/stream" && call.method === "POST")).toBe(true)
    // Notes and clear share one commit, with distinct model provenance.
    const notes = [...store.collections.worldDocuments.values()].filter((document) =>
      document.sources.includes("chat-sweep")
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]?.title).toBe("Prefers dark mode")
    expect(notes[0]?.updatedBy).toBe("smithers")
    expect(notes[0]?.confidence).toBe(0.9)
    const journal = [...store.collections.transitions.values()].sort((a, b) => a.revision - b.revision)
    const clearedRevision = journal.find((record) => record.type === "conversation.cleared")?.revision ?? 0
    expect(notes[0]?.revision).toBe(clearedRevision)
    // The chat is cleared and the one line states what was kept.
    const messages = [...store.collections.messages.values()]
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toContain("Saved 1 new note to Wiki")
    expect(messages[0]?.text).toContain("Open the archived conversation")
  })

  test("a failed sweep leaves the chat UNcleared with an honest line", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/model/stream": json(500, { status: "error", message: "chat upstream down" })
      })
    })
    await signIn(store)
    controller.send("some conversation worth keeping")
    await settled()
    const before = [...store.collections.messages.values()].length

    const outcome = await controller.commands.run("chat.clear", "--summarize")
    await settled()

    const messages = [...store.collections.messages.values()]
    expect(messages.length).toBe(before)
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringContaining("nothing was cleared or saved") })
    expect([...store.collections.transitions.values()].some((record) => record.type === "conversation.cleared")).toBe(
      false
    )
  })

  test("a transcript with nothing worth keeping clears with the zero-kept line", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/model/stream": () =>
          new Response(
            `${JSON.stringify({ runId: "sweep", type: "delta", kind: "text", text: "{\"notes\":[]}" })}\n${
              JSON.stringify({ runId: "sweep", type: "done", reason: "stop" })
            }\n`,
            { status: 200, headers: { "content-type": "application/x-ndjson" } }
          )
      })
    })
    await signIn(store)
    controller.send("hi")
    await settled()
    await controller.commands.run("chat.clear", "--summarize")
    const messages = [...store.collections.messages.values()]
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toContain("Started a new conversation.")
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
      allowlisted: true,
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
