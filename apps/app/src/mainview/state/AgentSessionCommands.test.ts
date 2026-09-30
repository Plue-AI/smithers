import { expect, test } from "bun:test"
import { flowArgs } from "../flows/FlowArgs"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage } from "./TestFixtures"
import { AGENT_SESSION_WIRE } from "./seams/fixtures/AgentSessionWire"

const createAppController = scopedControllers()
const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}
const session = AGENT_SESSION_WIRE.session({ status: "completed" })
const repo = "will/other"
const target = `/api/repos/${repo}/agent/sessions/${session.id}`

test.each(["slash", "button", "form", "agent"] as const)("session view reaches its explicit repository without inventory through %s", async (door) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const reads: string[] = []
  const mutations: string[] = []
  const controller = createAppController(store, unavailableAgent, {
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const path = new URL(url, "https://app.test").pathname
      const method = init?.method ?? "GET"
      if (method !== "GET") mutations.push(`${method} ${path}`)
      else reads.push(path)
      const body = path === target ? session : path === `${target}/messages` ? [] : { message: "Unavailable" }
      return Response.json(body, { status: path === target || path === `${target}/messages` ? 200 : 503 })
    }
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null })
  await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null })
  expect(store.collections.repositories.size).toBe(0)
  const args = `${session.id} ${repo}`
  if (door === "form") {
    await controller.commands.run("agent.session.view", "")
    await controller.commands.run("form.set", `form-agent.session.view sessionId ${session.id}`)
    await controller.commands.run("form.set", `form-agent.session.view repo ${repo}`)
    await controller.commands.run("form.submit", "form-agent.session.view")
  } else if (door === "agent") {
    await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "agent.session.view", args }) })
  } else {
    await controller.commands.run("agent.session.view", door === "button" ? flowArgs("agent.session.view", { sessionId: session.id, repo }) : args)
  }
  expect(reads).toContain(target)
  expect(reads).toContain(`${target}/messages`)
  expect(store.collections.cards.get(`agent-session-${session.id}`)).toMatchObject({ kind: "agent", payload: { cloud: true, sessionId: session.id, repo, state: "completed" } })
  const form = store.collections.cards.get("form-agent.session.view")
  expect(form === undefined || form.status === "acted").toBe(true)
  expect(mutations).toEqual([])
})
