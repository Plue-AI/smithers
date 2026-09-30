import { MODEL_CATALOG_PATH,MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { expect,test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()
const model = { id: "lab", protocol: "openai-chat", baseUrl: "http://127.0.0.1:9", modelId: "lab", credential: "LAB" } as const
const catalog = { models: [], seats: ["explainer"], credentials: [{ name: "LAB", present: true, origins: [model.baseUrl] }] }
const passed = { ok: true, latencyMs: 12, sample: "ok" } as const

test("boot resumes a persisted model test after loading identity and keeps its delayed result", async () => {
  const storage = memoryStorage()
  const before = await createAppStore({ kind: "localStorage", storage })
  const first = createAppController(before, silentAgent, {
    fetchImpl: async () => new Promise<Response>(() => {}), toastDebounceMs: 0
  })
  await before.dispatch({ type: "model.saved", actor: "user", model }).isPersisted.promise
  await first.commands.run("model.list")
  await first.commands.run("model.test", "lab")
  await before.settled?.()
  await first.dispose()

  let releaseTest!: (response: Response) => void
  let releaseIdentity!: (response: Response) => void
  let calls = 0
  const store = await createAppStore({ kind: "localStorage", storage })
  const controller = createAppController(store, silentAgent, {
    toastDebounceMs: 0, toastAutoDismissMs: 60_000,
    fetchImpl: async (input) => {
      const path = new URL(String(input), "http://app.test").pathname
      if (path === MODEL_TEST_PATH) { calls += 1; return new Promise<Response>((resolve) => { releaseTest = resolve }) }
      if (path.endsWith("/api/user")) return new Promise<Response>((resolve) => { releaseIdentity = resolve })
      if (path === MODEL_CATALOG_PATH) return Response.json(catalog)
      return Response.json({ scopes: [] })
    }
  })
  expect(calls).toBe(0)
  const loading = controller.loadSession()
  await controller.observeModels()
  expect(calls).toBe(0)
  releaseIdentity(new Response(null, { status: 401 }))
  await loading
  await controller.observeModels()
  await controller.observeModels()
  await waitFor(() => store.collections.toasts.get("toast-model.test:lab")?.status === "running")
  expect(calls).toBe(1)
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "still usable" }).isPersisted.promise
  expect(store.session().draft).toBe("still usable")
  releaseTest(Response.json(passed))
  await waitFor(() => store.collections.cards.get("models")?.kind === "models" &&
    store.collections.toasts.get("toast-model.test:lab")?.status !== "running")
  expect(store.collections.models.get("lab")?.lastTest?.result).toEqual(passed)
  const card = store.collections.cards.get("models")
  expect(card?.kind === "models" && card.payload.testing).toEqual([])
  expect(store.collections.toasts.get("toast-model.test:lab")?.status).toBe("ok")
})

test("the agent acknowledges model.list while its catalog is unresolved and duplicate doors share the refresh", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let release!: (response: Response) => void
  let calls = 0
  const controller = createAppController(store, silentAgent, {
    toastAutoDismissMs: 60_000,
    fetchImpl: async (input) => {
      if (String(input) === MODEL_CATALOG_PATH) { calls += 1; return new Promise<Response>((resolve) => { release = resolve }) }
      return Response.json({ status: "signed-out", scopes: [] })
    }
  })
  const listing = controller.commands.runAsAgent("model.list")
  try {
    const outcome = await Promise.race([listing, new Promise((resolve) => setTimeout(() => resolve("blocked"), 100))])
    expect(outcome).toEqual({ status: "executed", value: "Requested" })
    expect(store.collections.toasts.get("toast-model.list")).toBeUndefined()
    expect(await controller.commands.run("model.list")).toEqual({ status: "executed", value: "Requested" })
    await waitFor(() => store.collections.toasts.get("toast-model.list")?.status === "running")
    expect(calls).toBe(1)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "still typing" }).isPersisted.promise
    expect(store.session().draft).toBe("still typing")
    const card = store.collections.cards.get("models")
    expect(card?.kind === "models" && card.payload).toMatchObject({ refresh: { state: "requested" } })
  } finally {
    release(Response.json(catalog))
    await listing
  }
  await waitFor(() => store.collections.toasts.get("toast-model.list")?.status === "ok")
  const card = store.collections.cards.get("models")
  expect(card?.kind === "models" && card.payload).toMatchObject({ host: "observed", credentials: catalog.credentials })
})

test("boot reconnects a persisted catalog refresh once after identity adoption", async () => {
  const storage = memoryStorage()
  const before = await createAppStore({ kind: "localStorage", storage })
  const first = createAppController(before, silentAgent, {
    fetchImpl: async () => new Promise<Response>(() => {})
  })
  await first.commands.runAsAgent("model.list")
  await before.settled?.()
  await first.dispose()
  const store = await createAppStore({ kind: "localStorage", storage })
  let calls = 0
  let release!: (response: Response) => void
  const controller = createAppController(store, silentAgent, {
    toastDebounceMs: 0,
    fetchImpl: async () => { calls += 1; return new Promise<Response>((resolve) => { release = resolve }) }
  })
  expect(calls).toBe(0)
  await controller.adoptSession({ state: "unavailable", login: null, admin: false })
  await controller.commands.run("model.list")
  await waitFor(() => store.collections.toasts.get("toast-model.list")?.status === "running")
  expect(calls).toBe(1)
  release(Response.json(catalog))
  await waitFor(() => store.collections.toasts.get("toast-model.list")?.status === "ok")
  const card = store.collections.cards.get("models")
  expect(card?.kind === "models" && card.payload.refresh).toBeUndefined()
  expect(card?.kind === "models" && card.payload.host).toBe("observed")
})

test("a same-owner focus re-read while a model test is out sends no second provider call", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let releaseTest!: (response: Response) => void
  let calls = 0
  const controller = createAppController(store, silentAgent, {
    toastDebounceMs: 0, toastAutoDismissMs: 60_000,
    fetchImpl: async (input) => {
      const path = new URL(String(input), "http://app.test").pathname
      if (path === MODEL_TEST_PATH) { calls += 1; return new Promise<Response>((resolve) => { releaseTest = resolve }) }
      if (path.endsWith("/api/user")) return Response.json({ id: 1, username: "will", is_admin: false })
      if (path === MODEL_CATALOG_PATH) return Response.json(catalog)
      return new Promise<Response>(() => {})
    }
  })
  await controller.loadSession()
  await store.dispatch({ type: "model.saved", actor: "user", model }).isPersisted.promise
  await controller.commands.run("model.test", "lab")
  await waitFor(() => calls === 1 && store.collections.toasts.get("toast-model.test:lab")?.status === "running")
  await controller.loadSession()
  await controller.loadSession()
  await controller.observeModels()
  expect(calls).toBe(1)
  releaseTest(Response.json(passed))
  await waitFor(() => store.collections.toasts.get("toast-model.test:lab")?.status === "ok")
  expect(store.collections.models.get("lab")?.lastTest?.result).toEqual(passed)
  expect(calls).toBe(1)
})
