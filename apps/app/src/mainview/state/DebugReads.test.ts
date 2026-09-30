import { describe, expect, test } from "bun:test"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { memoryStorage, settled } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The §26 debug reads answer the human who typed them.
 *
 * `{ value }` is the agent boundary's channel and never renders on its own, so
 * a read whose only answer is a value was a silent no-op in the transcript —
 * the flow ran, the payload was correct, and the admin saw nothing.
 */

const debugAgent = (): AgentPort => ({
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

/** The only session the debug plugin registers for. */
const adminStore = async (): Promise<AppStore> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    admin: true,
    scopesPlain: null
  })
  return store
}

const bodies = (store: AppStore): string[] => [...store.collections.messages.values()].map((message) => message.text)

describe("the debug reads render for the human", () => {
  test("/debug.backend answers the human", async () => {
    const store = await adminStore()
    const controller = createAppController(store, debugAgent(), {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.messages.size
    controller.send("/debug.backend")
    await settled()
    await settled()
    expect(store.collections.messages.size).toBe(before + 1)
    expect(bodies(store).at(-1)).toContain("agent backend: http")
  })

  test.each([
    ["debug.snapshot", "App state snapshot"],
    ["debug.events", "Transition journal tail"],
    ["debug.net", "Network tap"]
  ])("/%s appends its payload to the transcript", async (flow, title) => {
    const store = await adminStore()
    const controller = createAppController(store, debugAgent(), {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.messages.size
    controller.send(`/${flow}`)
    await settled()
    await settled()
    expect(store.collections.messages.size).toBe(before + 1)
    const rendered = bodies(store).at(-1) ?? ""
    expect(rendered).toContain(title)
    expect(rendered).toContain("```json")
  })

  test("the agent's own invocation renders nothing and still reads the value", async () => {
    const store = await adminStore()
    const controller = createAppController(store, debugAgent(), {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.messages.size
    const outcome = await controller.commands.runForAgent("debug.snapshot")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toContain("surface")
    expect(store.collections.messages.size).toBe(before)
  })

  test("the dev-tools panel's read never dispatches", async () => {
    const store = await adminStore()
    const controller = createAppController(store, debugAgent(), {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.messages.size
    JSON.parse(controller.netTap())
    JSON.parse(controller.netTap())
    // The panel reads rows, not the serialized form; both stay silent.
    controller.netTapEntries()
    controller.netTapEntries()
    expect(store.collections.messages.size).toBe(before)
    expect(controller.netTapEntries()).toEqual(JSON.parse(controller.netTap()))
  })
})
