import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import { renderAgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import type { AgentTurnFrame,StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { describe,expect,test } from "bun:test"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, recordingAgent, settled } from "./TestFixtures"

const createAppController = scopedControllers()

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

/** An agent double that records every turn request and ends the turn fast. */
describe("per-turn runtime context", () => {
  test("every turn carries a freshly derived context identifying the Smithers product", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, recordingAgent(requests))

    controller.send("hey smithers what app am I in")
    await settled()

    expect(requests).toHaveLength(1)
    const context = requests[0]?.context
    expect(context?.version).toBe(1)
    expect(context?.product).toBe("smithers")
    expect(context?.surface).toBe("chat")
    expect(context?.connectors).toEqual([])
    expect(context?.limitations.some((line) => line.includes("Cannot see"))).toBe(true)
  })

  test("the hidden context never enters the persisted visible transcript", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, recordingAgent(requests))

    controller.send("what app am I in")
    await settled()

    expect(requests[0]?.context).toBeDefined()
    for (const message of store.collections.messages.values()) {
      expect(message.text).not.toContain("Runtime context")
      expect(message.text).not.toContain("running INSIDE the Smithers product")
      expect(message.reasoning ?? "").not.toContain("Runtime context")
    }
  })

  test("a tool-loop continuation leg rebuilds the context, it does not replay the first leg's", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const listeners = new Set<(frame: AgentTurnFrame) => void>()
    // Leg 1 asks for a command that mutates world state; leg 2 must SEE it.
    const agent: AgentPort = {
      available: true,
      startTurn: async (request) => {
        const leg = requests.length
        requests.push(request)
        queueMicrotask(() => {
          const frames: ReadonlyArray<AgentTurnFrame> = leg === 0
            ? [
              {
                runId: request.runId,
                type: "tool_call",
                call_id: "call_1",
                name: "commands",
                arguments: JSON.stringify({ action: "execute", name: "world.new-note" })
              },
              { runId: request.runId, type: "done", reason: "tool_call" }
            ]
            : [
              { runId: request.runId, type: "delta", kind: "text", text: "Noted." },
              { runId: request.runId, type: "done", reason: "stop" }
            ]
          for (const frame of frames) for (const listener of listeners) listener(frame)
        })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    const controller = createAppController(store, agent)

    controller.send("make me a note")
    await settled()
    await settled()

    expect(requests).toHaveLength(2)
    const before = requests[0]?.context
    const after = requests[1]?.context
    expect(before?.worldState.documentCount ?? -1).toBeGreaterThanOrEqual(0)
    expect(after?.worldState.documentCount ?? 0).toBe((before?.worldState.documentCount ?? 0) + 1)
    expect(after?.revision ?? 0).toBeGreaterThan(before?.revision ?? 0)
  })

  test("runtime context does not promise a retired repository picker", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, recordingAgent(requests))

    controller.send("connect my repo")
    await settled()

    const limitations = requests[0]?.context?.limitations ?? []
    expect(limitations.some((line) => line.includes("This host cannot connect local repositories."))).toBe(true)
  })

  test("the selected repository rides the context, so a plain first message can be about it", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, recordingAgent(requests))

    controller.send("what is this?")
    await settled()
    expect(requests[0]?.context?.activeRepository).toBeNull()
    expect(renderAgentRuntimeContext(requests[0]?.context as AgentRuntimeContext)).toContain("- Active repository: none selected.")

    // The landing page's `?repo=` boot path: the catalog row joins the inventory, then repo.select names it.
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "user", name: "smithers", head: null,
        summary: "A durable framework for agents to plan, run, and review code changes." }]
    })
    expect(await controller.selectRepo("smithersai/smithers")).toBeUndefined()
    controller.send("what does this repo do?")
    await settled()

    expect(requests[1]?.context?.activeRepository).toBe("smithersai/smithers")
    expect(requests[1]?.context?.activeRepositorySummary).toBe("A durable framework for agents to plan, run, and review code changes.")
    expect(renderAgentRuntimeContext(requests[1]?.context as AgentRuntimeContext)).toContain("- Active repository: smithersai/smithers.")
    expect(renderAgentRuntimeContext(requests[1]?.context as AgentRuntimeContext)).toContain("Selected repository description (public catalog):\n    | A durable framework")
  })

  test("Smithers is the first tab and sees every other one: the context lists the card tabs", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "local",
        version: "test",
        buildSha: "test",
        capabilities: [],
        authFlow: "none",
        sandbox: { platform: "darwin", mode: "enforced" }
      }
    })
    await store.dispatch({
      type: "tab.opened",
      actor: "user",
      tab: { id: "card-balance", kind: "card", title: "Balance", cardId: "balance" }
    }).isPersisted.promise
    await store.dispatch({ type: "tab.selected", actor: "user", id: "main" }).isPersisted.promise

    controller.send("what is pinned beside us")
    await settled()
    expect(requests[0]?.context?.tabs).toEqual([
      { id: "main", kind: "main", title: "Smithers", active: true },
      { id: "card-balance", kind: "card", title: "Balance", active: false }
    ])
    // No tab has a process behind it: nothing offers to read one.
    expect(requests[0]?.context?.capabilities.some((line) => line.includes("tab.read"))).toBe(false)
  })

  /*
   * agent-parity.md: the agent tried /box.terminal, failed on the
   * missing cloud session, and ran /auth.prompt — GitHub, already connected —
   * because the context stated GitHub and never the Smithers Cloud session.
   */
  test("the native app's context states the Smithers Cloud session and names cloud.prompt when it is signed out", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "local",
        version: "test",
        buildSha: "test",
        capabilities: ["agent", "identity", "cloud", "cloud.pat", "cloud.terminal"],
        authFlow: "both",
        sandbox: { platform: "darwin", mode: "enforced" }
      }
    })
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null }).isPersisted.promise
    controller.send("launch a terminal")
    await settled()
    expect(requests[0]?.context?.cloud).toEqual({ state: "signed-out", username: null })
    const signedOut = renderAgentRuntimeContext(requests[0]?.context as AgentRuntimeContext)
    expect(signedOut).toContain("- Smithers Cloud: signed out (workspaces, changes and sync need it; cloud.prompt renders the sign-in button).")

    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
    controller.send("and now?")
    await settled()
    expect(requests[1]?.context?.cloud).toEqual({ state: "signed-in", username: "will" })
    expect(renderAgentRuntimeContext(requests[1]?.context as AgentRuntimeContext)).toContain("- Smithers Cloud: signed in as will.")

    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: "degraded" }).isPersisted.promise
    controller.send("workspaces?")
    await settled()
    expect(requests[2]?.context?.cloud).toEqual({ state: "degraded", username: "will" })
  })

  test("public catalog turns on the web report cloud context from the GitHub identity", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "cloud",
        version: "test",
        buildSha: "cloud",
        capabilities: ["agent", "identity", "cloud"],
        authFlow: "redirect",
        sandbox: null
      }
    })
    // Anonymous web turns are supported for public catalog exploration. An
    // ordinary signed-out turn is gated before a request/context is sent.
    await store.dispatch({ type: "repository.upserted", actor: "system", repository: {
      id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: null, catalog: true
    } }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" }).isPersisted.promise
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
    controller.send("hi")
    await settled()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.context?.activeRepository).toBe("smithersai/smithers")
    expect(requests[0]?.context?.cloud).toEqual({ state: "signed-out", username: null })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    controller.send("again")
    await settled()
    expect(requests).toHaveLength(2)
    expect(requests[1]?.context?.cloud).toEqual({ state: "signed-in", username: "will" })
  })

  test("a host with no cloud door states the session unavailable", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "local",
        version: "test",
        buildSha: "test",
        capabilities: [],
        authFlow: "none",
        sandbox: { platform: "darwin", mode: "enforced" }
      }
    })
    controller.send("hi")
    await settled()
    expect(requests[0]?.context?.cloud).toEqual({ state: "unavailable", username: null })
    expect(renderAgentRuntimeContext(requests[0]?.context as AgentRuntimeContext)).toContain("- Smithers Cloud: unavailable on this host.")
  })

  test("alone, the context says so and offers no tab.read", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, recordingAgent(requests))
    controller.send("hi")
    await settled()
    expect(requests[0]?.context?.tabs).toEqual([{ id: "main", kind: "main", title: "Smithers", active: true }])
    expect(requests[0]?.context?.capabilities.some((line) => line.includes("tab.read"))).toBe(false)
  })
})


test("plain repository chat carries no practice priming or hidden tutorial observations", async () => {
  const store = await webStore()
  const requests: StartAgentTurnRequest[] = []
  const controller = createAppController(store, recordingAgent(requests), { repositoryApp: "smithersai/smithers" })
  await settled()
  controller.send("What does this repository do?")
  await settled()
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("The repository on screen is practice:")
  expect((JSON.stringify(requests[0]?.context?.repositoryUpdate) ?? "")).not.toContain("practice:")
  expect(requests[0]?.context?.onboarding).toBeUndefined()
})

test("browser chat sees a desktop opened outside chat and refreshes its stream state without credentials", async () => {
  const { holdDesktopStream, dropDesktopStream } = await import('./seams/DesktopStream')
  const { AgentRuntimeContextSchema } = await import('@smthrs/rpc/AgentContext')
  const store = await webStore()
  const requests: StartAgentTurnRequest[] = []
  const controller = createAppController(store, recordingAgent(requests), {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id: "desktop-context", kind: "workspace", title: "My desktop", status: "active", ordinal: 1, createdAt: 1,
    payload: { workspaceId: "ws-context", repo: "acme/api", name: "My desktop", targetBookmark: "main", status: "running",
      provisioningStage: null, suspendedAt: null, bookmarkHead: null, sessions: [], workspaceKind: "desktop", facet: "desktop" },
  } }).isPersisted.promise
  holdDesktopStream({ workspaceId: "ws-context", url: "https://desktop.invalid/?token=secret-fixture", sessionId: "private-session", expiresAt: null })
  try {
    controller.send("What did I just open?")
    await settled()
    const context = AgentRuntimeContextSchema.parse(requests[0]?.context)
    expect(context.recentCards).toContainEqual({ id: "desktop-context", kind: "workspace", title: "My desktop", status: "active", maximized: false,
      workspace: { id: "ws-context", repo: "acme/api", kind: "desktop", status: "running", facet: "desktop", streaming: true } })
    expect(context.capabilities.join(' ')).toContain('box.desktop.open')
    expect(context.capabilities.join(' ')).toContain('does not require the native app')
    const rendered = renderAgentRuntimeContext(context)
    expect(rendered).toContain('desktop stream=attached')
    expect(rendered).toContain('embedded in chat')
    expect(JSON.stringify(requests[0])).not.toContain('secret-fixture')
    expect(JSON.stringify(requests[0])).not.toContain('private-session')
    dropDesktopStream()
    controller.send("Is it still connected?")
    await settled()
    expect(requests[1]?.context?.recentCards?.find(card => card.id === 'desktop-context')?.workspace?.streaming).toBe(false)
    expect(requests[1]?.messages.some(message => 'content' in message && message.content === 'What did I just open?')).toBe(true)
  } finally { dropDesktopStream() }
})
