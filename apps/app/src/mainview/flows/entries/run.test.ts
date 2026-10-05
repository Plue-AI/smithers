import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { flowCardFamily } from "../../cards/FlowCard"
import type { CardActions } from "../../cards/CardFamily"
import { ControllerContext } from "../../ControllerContext"
import type { FlowCard } from "@smthrs/rpc/FlowCard"
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
    expect(await h.controller.runCommandForResult("flow.source", "merge")).toMatchObject({ status: "failed", error: expect.stringContaining("Merge flow is built in") })
    expect(await h.controller.runCommandForResult("flow.edit", "merge Add a step")).toMatchObject({ status: "failed", error: expect.stringContaining("Merge flow is built in") })
    expect(await h.controller.runCommandForResult("flow.edit", "todo Add review")).toMatchObject({ status: "executed" })
    const draft = cards(h).find(row => row.kind === "draft")
    expect(draft?.payload).toMatchObject({ prompt: flowEditPrompt("todo", "Add review"), title: "Change the TODO flow: Add review" })
    expect(flowEditPrompt("todo", "Add review")).toBe("Change flows/todo/flow.ts: Add review; start from the built-in composition when no override exists")
  } finally { h.controller.dispose() }
})

/*
 * On an install the flow doors and the Flow card read GET /api/flows: the
 * built-in TODO flow is overridable (system false), so /flow.edit drafts its
 * TODO and the card shows Edit; the seed is not consulted.
 */
const SERVED_TODO = { name: "todo", source: { builtin: true }, system: false, versions: [{ id: "d".repeat(64), state: "active", steps: [
  { id: "plan", label: "Plan" }, { id: "implement", label: "Implement" }, { id: "verify", label: "Verify" },
  { id: "review", label: "Review" }, { id: "propose", label: "Propose" },
  { id: "merge", wait: true, signals: [{ on: "rebase", to: "Verify" }, { on: "steer", to: "Implement" }] }] }] } satisfies FlowCard
const bootInstall = async (flows: () => Response) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const reads: string[] = []
  const controller = createAppController(store, unavailable, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    fetchImpl: async (input) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://install.test").pathname
      reads.push(path)
      if (path === "/api/flows") return flows()
      if (path === "/api/todos") return Response.json([])
      return Response.json({ code: "unknown", class: "infra", message: "Not available" }, { status: 404 })
    }
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  return { store, controller, reads }
}

test("on an install, flow doors read GET /api/flows: the built-in TODO flow is edited, never refused", async () => {
  const h = await bootInstall(() => Response.json([SERVED_TODO]))
  try {
    expect(await h.controller.runCommandForResult("flow", "todo")).toMatchObject({ status: "executed", value: "Opened TODO flow" })
    expect(h.reads.filter(path => path === "/api/flows").length).toBeGreaterThan(0)
    expect(h.controller.flowCatalog?.get().flows).toEqual([SERVED_TODO])
    // The card renders the served model: built in, its five steps and the wait, and Edit as its one press.
    const card = cards(h).find(row => row.kind === "flow")!
    const html = renderToStaticMarkup(createElement(ControllerContext.Provider, { value: h.controller },
      flowCardFamily.flow.render(card as Parameters<typeof flowCardFamily.flow.render>[0], { presentation: "embedded" } as CardActions)))
    expect(html).toContain("Built-in")
    for (const label of ["Plan", "Implement", "Verify", "Review", "Propose", "Wait for merge"]) expect(html).toContain(label)
    expect([...html.matchAll(/data-flow="([^"]+)"/g)].map(match => match[1])).toEqual(["flow.edit"])
    expect(await h.controller.runCommandForResult("flows")).toMatchObject({ status: "executed", value: "1 flows" })
    expect(await h.controller.runCommandForResult("flow", "merge")).toMatchObject({ status: "failed", error: expect.stringContaining("No flow merge") })
    expect(await h.controller.runCommandForResult("flow.edit", "todo Add review")).toMatchObject({ status: "executed" })
    expect(cards(h).find(row => row.kind === "draft")?.payload).toMatchObject({ prompt: flowEditPrompt("todo", "Add review"), title: "Change the TODO flow: Add review" })
  } finally { h.controller.dispose() }
})

test("on an install, a catalog the install does not serve refuses the flow doors instead of reading the seed", async () => {
  const h = await bootInstall(() => Response.json({ code: "unknown", class: "infra", message: "Not available" }, { status: 404 }))
  try {
    for (const [name, args] of [["flow", "todo"], ["flow.edit", "todo Add review"], ["flows", undefined]] as const) {
      expect(await h.controller.runCommandForResult(name, args)).toMatchObject({ status: "failed", error: expect.stringContaining("Flows unavailable") })
    }
    expect(cards(h).filter(row => row.kind === "flow" || row.kind === "draft")).toEqual([])
    expect(h.controller.flowCatalog?.get()).toEqual({ error: "Flows unavailable" })
  } finally { h.controller.dispose() }
})
