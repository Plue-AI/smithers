import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent } from "./TestFixtures"

const controllerFor = scopedControllers()

test("run detail selection persists through the flow, reopening and storage reload", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const controller = controllerFor(store, silentAgent)
  await controller.presentRun("recorded-run", "Recorded run", false)
  const result = await controller.commands.submit({ name: "run.view", actor: "user",
    payload: { cardId: "run:recorded-run", selected: "step:attempt:checks", tab: "journal", at: 3 } })
  expect(result.status).toBe("executed")
  await controller.presentRun("recorded-run", "Recorded run", false)
  const card = store.collections.cards.get("run:recorded-run")
  expect(card?.kind === "run" && card.payload.memberViews?.[controller.design.viewer()]).toEqual({ selected: "step:attempt:checks", tab: "journal", at: 3 })
  await controller.commands.submit({ name: "run.view", actor: "user", payload: { cardId: "run:recorded-run", selected: "cell-2" } })
  await controller.dispose()
  const restored = await createAppStore({ kind: "localStorage", storage })
  const saved = restored.collections.cards.get("run:recorded-run")
  expect(saved?.kind === "run" && saved.payload.memberViews?.[controller.design.viewer()]).toEqual({ selected: "cell-2", tab: "journal", at: 3 })
  expect([...restored.collections.transitions.values()].some(row => row.type === "card.updated" && row.actor === "user")).toBe(true)
})

test("run view refuses a missing card and invalid scrubber input", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = controllerFor(store, silentAgent)
  const missing = await controller.commands.submit({ name: "run.view", actor: "user", payload: { cardId: "missing", selected: "cell" } })
  expect(missing.status).toBe("failed")
  for (const at of [-1, 1.5]) {
    const invalid = await controller.commands.submit({ name: "run.view", actor: "user", payload: { cardId: "missing", at } })
    expect(invalid.status).toBe("failed")
  }
  expect(store.collections.cards.size).toBe(0)
})

test("install /monitor returns before its list read and presents every served run without the seed", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let resolveList!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { resolveList = resolve })
  const requests: string[] = []
  const controller = controllerFor(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    live: { subscribe: () => () => {}, getSnapshot: () => undefined },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "https://app.test").pathname
      requests.push(`${init?.method ?? "GET"} ${path}`)
      return path === "/api/runs" ? pending : Response.json({}, { status: 404 })
    }
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "member", admin: false, scopesPlain: null }).isPersisted.promise
  const result = await controller.commands.submit({ name: "monitor", actor: "user", payload: {} })
  expect(result).toMatchObject({ status: "executed", value: "Requested" })
  expect(await controller.commands.submit({ name: "monitor", actor: "user", payload: {} })).toMatchObject({ status: "executed", value: "Requested" })
  expect([...store.collections.cards.values()].filter(card => card.kind === "run")).toEqual([])
  await controller.presentRun("unrelated", "Unrelated", false)
  resolveList(Response.json([{ id: "background-native", title: "Background native", flow: "flow-load", version: "digest", state: "interrupted",
    attempts: [], waits: [], tokens: 0, time_s: 0, cost_usd: 0, engine: [] }]))
  for (let count = 0; count < 100 && !store.collections.cards.has("run:background-native"); count++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(store.collections.cards.get("run:background-native")?.title).toBe("Background native")
  expect(requests.filter(path => path.endsWith(" /api/runs"))).toEqual(["GET /api/runs"])
})

test("the agent Inspect door stays embedded and records the agent as actor", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = controllerFor(store, silentAgent)
  const result = await controller.commands.submit({ name: "run.inspect", actor: "agent", payload: { id: "run-retry" } })
  expect(result.status).toBe("executed")
  expect(store.collections.cards.get("run:run-retry")?.kind).toBe("run")
  expect(store.session().maximizedCardId).toBeNull()
  expect([...store.collections.transitions.values()].some(row => row.type === "card.upsert" && row.actor === "smithers")).toBe(true)
})

test("members retain separate selections on the same install run", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = controllerFor(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    fetchImpl: async () => Response.json({}, { status: 404 })
  })
  let shared: import("@smthrs/rpc/Cards").Card | undefined
  for (const login of ["alice", "bob"]) {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, admin: false, scopesPlain: null }).isPersisted.promise
    // Shared conversation delivery restores the same card after account-local
    // projections are cleared on sign-in; each member selects independently.
    if (shared) await store.dispatch({ type: "card.upsert", actor: "system", card: shared }).isPersisted.promise
    await controller.presentRun("shared", "Shared", false)
    const result = await controller.commands.submit({ name: "run.view", actor: "user", payload: { cardId: "run:shared", selected: `${login}-cell` } })
    expect(result).toMatchObject({ status: "executed" })
    shared = store.collections.cards.get("run:shared")
  }
  await controller.presentRun("shared", "Shared", false)
  const card = store.collections.cards.get("run:shared")
  expect(card?.kind === "run" && card.payload.memberViews).toEqual({ alice: { selected: "alice-cell" }, bob: { selected: "bob-cell" } })
  expect(card?.kind === "run" && card.payload.view).toBeUndefined()
})
