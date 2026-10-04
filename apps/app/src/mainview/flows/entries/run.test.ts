import { expect, test } from "bun:test"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch } from "../../state/TestFixtures"
import { flowEditPrompt } from "./flow"

/*
 * The run and flow doors on the design seam: /run, /run.inspect, /runs, /flow,
 * /flows, /flow.edit and /flow.source, through the controller as a person's
 * slash line. The agent door of flow.edit is in agent-parity.test.ts.
 */
const unavailable: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const profile = signupProfileFetch(async (input) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://install.test").pathname
    if (path === "/api/todos") return new Response("[]", { headers: { "Content-Type": "application/json" } })
    return new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailable, { fetchImpl: profile.fetchImpl })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  return { store, controller }
}
const cards = (h: Awaited<ReturnType<typeof boot>>) => [...h.store.collections.cards.values()]

test("run opens the seeded run's card, run.inspect maximizes it, a TODO ref names its latest attempt, runs opens every live run", async () => {
  const h = await boot()
  try {
    expect(await h.controller.runCommandForResult("run.inspect", "run-retry")).toMatchObject({ status: "executed", value: "Inspecting Retry failed webhooks with backoff" })
    expect(cards(h).find(row => row.id === "run:run-retry")).toMatchObject({ kind: "run", payload: { id: "run-retry" } })
    expect(h.store.session().maximizedCardId).toBe("run:run-retry")
    expect(await h.controller.runCommandForResult("run", "T9")).toMatchObject({ status: "executed", value: "Opened Retry failed webhooks with backoff" })
    expect(cards(h).filter(row => row.kind === "run").map(row => row.id)).toEqual(["run:run-retry"])
    expect(await h.controller.runCommandForResult("run", "run-retry-1")).toMatchObject({ status: "executed" })
    expect(cards(h).filter(row => row.kind === "run").map(row => row.id).sort()).toEqual(["run:run-retry", "run:run-retry-1"])
    expect(await h.controller.runCommandForResult("run", "nope")).toMatchObject({ status: "failed", error: expect.stringContaining("No run nope") })
    expect(await h.controller.runCommandForResult("runs")).toMatchObject({ status: "executed", value: "1 active run" })
  } finally { h.controller.dispose() }
})

test("THE EMBED LAW: the agent's run.inspect opens the Run card embedded, never maximized", async () => {
  const h = await boot()
  try {
    expect(await h.controller.commands.runForAgent("run.inspect", "run-retry")).toMatchObject({ status: "executed", value: "Opened Retry failed webhooks with backoff" })
    expect(cards(h).find(row => row.id === "run:run-retry")).toMatchObject({ kind: "run", payload: { id: "run-retry" } })
    expect(h.store.session().maximizedCardId).toBeNull()
  } finally { h.controller.dispose() }
})

test("flows and flow open Flow cards; flow.source opens the flow's file; flow.edit drafts the spec's TODO", async () => {
  const h = await boot()
  try {
    expect(await h.controller.runCommandForResult("flows")).toMatchObject({ status: "executed", value: "2 flows" })
    expect(cards(h).filter(row => row.kind === "flow").map(row => [row.id, row.title]).sort()).toEqual([["flow:merge", "Merge flow"], ["flow:todo", "TODO flow"]])
    expect(await h.controller.runCommandForResult("flow", "todo")).toMatchObject({ status: "executed", value: "Opened TODO flow" })
    expect(cards(h).filter(row => row.kind === "flow")).toHaveLength(2)
    expect(await h.controller.runCommandForResult("flow", "nope")).toMatchObject({ status: "failed", error: expect.stringContaining("No flow nope") })
    expect(await h.controller.runCommandForResult("flow.source", "todo")).toMatchObject({ status: "executed" })
    expect(cards(h).find(row => row.kind === "file")).toMatchObject({ id: "design:file:main:flows/todo/flow.ts" })
    expect(await h.controller.runCommandForResult("flow.source", "merge")).toMatchObject({ status: "failed", error: expect.stringContaining("built in") })
    expect(await h.controller.runCommandForResult("flow.edit", "merge Add a step")).toMatchObject({ status: "failed", error: expect.stringContaining("built in") })
    expect(await h.controller.runCommandForResult("flow.edit", "todo Add review")).toMatchObject({ status: "executed" })
    const draft = cards(h).find(row => row.kind === "draft")
    expect(draft?.payload).toMatchObject({ prompt: flowEditPrompt("todo", "Add review"), title: "Change the TODO flow: Add review" })
    expect(flowEditPrompt("todo", "Add review")).toBe("Change flows/todo/flow.ts: Add review; start from the built-in composition when no override exists")
  } finally { h.controller.dispose() }
})
