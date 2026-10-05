import { renderToStaticMarkup } from "react-dom/server"
import { ControllerTestProvider } from "../ControllerContext"
import { commandsCardFamily } from "./CommandsContainer"
import type { CardActions } from "./CardFamily"
import { expect, test } from "bun:test"
import { act } from "react"
import type { DebugApiViewProps } from "@smthrs/rpc/DebugApiCard"
import { createRoot } from "./views/testDom"
import { DebugApiCard } from "./DebugApiCard"
import { scopedControllers } from "../state/ControllerTestScope"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, silentAgent } from "../state/TestFixtures"
import { apiFixture, expectedOperations } from "../state/seams/DebugApiFixtures.test-support"

const createController = scopedControllers()
const settle = async (predicate: () => boolean) => { for (let n = 0; n < 60 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 0)); expect(predicate()).toBe(true) }
const setup = async (respond: (init?: RequestInit) => Promise<Response> = async () => new Response('{"items":[]}')) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() }), calls: { url: string; init?: RequestInit }[] = []
  const gates = { view: true, catalog: true, authorizer: true }
  const controller = createController(store, silentAgent, { openApi: async () => apiFixture, debugApiOrigin: "http://mini.local", debugApiGates: () => gates, toastDebounceMs: 0, toastAutoDismissMs: 60_000,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return respond(init) } })
  return { controller, store, gates, calls }
}
test("slash opens without fetching; production Send and confirmation preserve retry identity", async () => {
  let attempts = 0
  const { controller, store, calls } = await setup(async () => new Response("{}", { status: ++attempts === 1 ? 503 : 200 }))
  expect((await controller.runCommandForResult("debug-api", "putSecrets")).status).toBe("executed")
  await settle(() => store.collections.cards.has("debug-api"))
  expect(calls).toEqual([])
  expect(store.session().surface).toBe("chat")
  let props!: DebugApiViewProps
  const root = createRoot(document.createElement("div"))
  await act(async () => root.render(<DebugApiCard View={value => { props = value; return null }} seam={controller.debugApi}
    dispatch={(tag, input) => controller.commands.submit({ name: tag, payload: input ?? {}, actor: "user" })} />))
  expect(props.model.operations).toEqual(expectedOperations)
  expect(props.actions[0]!.label).toBe("Send")
  await act(async () => { props.onAction(props.actions[0]!.tag, { body: '{"name":"CI","value":"private"}' }); await settle(() => !!controller.debugApi.get().model.pending) })
  expect(calls).toHaveLength(0)
  expect(props.model.pending).toEqual({ method: "PUT", path: "/api/secrets" })
  expect(props.actions[0]!.label).toBe("Confirm PUT /api/secrets")
  await act(async () => { props.onAction(props.actions[0]!.tag, { body: '{"name":"changed"}' }); await settle(() => !controller.debugApi.get().model.pending) })
  expect(calls).toHaveLength(0)
  await act(async () => { props.onAction(props.actions[0]!.tag, { body: '{"name":"CI","value":"private"}' }); await settle(() => !!controller.debugApi.get().model.pending) })
  await act(async () => { props.onAction(props.actions[0]!.tag, { body: '{"name":"CI","value":"private"}' }); await settle(() => calls.length === 1 && !controller.debugApi.get().busy) })
  expect(calls).toHaveLength(1)
  const key = new Headers(calls[0]!.init?.headers).get("Idempotency-Key")
  const input = { operationId: "putSecrets", intent: "send", values: { body: '{"name":"CI","value":"private"}' } }
  await act(async () => {
    await controller.runCommandForResult("debug.api", JSON.stringify(input))
    await controller.runCommandForResult("debug.api", JSON.stringify({ ...input, intent: "confirm", confirmation: controller.debugApi.get().confirmation }))
    await settle(() => !controller.debugApi.get().busy)
  })
  expect(new Headers(calls[1]!.init?.headers).get("Idempotency-Key")).toBe(key)
  expect(controller.debugApi.get().model.exchange?.response?.status).toBe(200)
  expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain("private")
  await act(async () => root.unmount())
})
for (const dependency of ["view", "catalog", "authorizer"] as const) test(`production ${dependency} gate refuses with no API or card effects`, async () => {
  const { controller, gates, calls, store } = await setup()
  gates[dependency] = false
  expect((await controller.runCommandForResult("debug-api")).status).toBe("failed")
  expect((await controller.runCommandForResult("debug.api", '{"operationId":"getStack","intent":"send"}')).status).toBe("failed")
  expect(calls).toEqual([]); expect(store.collections.cards.has("debug-api")).toBe(false)
})
test("agent door refuses raw API; a running fetch never blocks Chat or duplicate Send", async () => {
  let finish!: (response: Response) => void
  const { controller, store, calls } = await setup(() => new Promise(resolve => { finish = resolve }))
  expect((await controller.commands.runForAgent("debug.api", "getStack")).status).toBe("failed")
  expect(calls).toEqual([])
  await controller.runCommandForResult("debug-api", "getStack")
  await settle(() => store.collections.cards.has("debug-api"))
  expect((await controller.runCommandForResult("debug.api", '{"operationId":"getStack","intent":"send"}')).status).toBe("executed")
  expect(controller.debugApi.get().busy).toBe(true)
  await settle(() => store.collections.toasts.has("toast-debug.api.send"))
  const runningToast = store.collections.toasts.get("toast-debug.api.send")!
  expect(runningToast.status).toBe("running")
  expect((await controller.runCommandForResult("chat")).status).toBe("executed")
  await controller.runCommandForResult("debug.api", '{"operationId":"getStack","intent":"send"}')
  expect(calls).toHaveLength(1)
  expect(store.collections.toasts.get("toast-debug.api.send")!.status).toBe("running")
  finish(new Response('{"code":"signed_out","class":"permission","message":"Sign in"}', { status: 401 }))
  await settle(() => !controller.debugApi.get().busy)
  await settle(() => store.collections.toasts.get("toast-debug.api.send")?.status === "failed")
  expect(controller.debugApi.get().model.exchange?.failure).toEqual({ class: "permission", message: "Sign in", status: 401 })
})

test("the production help projection keeps unavailable docs and Debug API dark", async () => {
  const { controller, gates } = await setup()
  const render = () => renderToStaticMarkup(<ControllerTestProvider controller={controller}>{commandsCardFamily.commands.render(
    { id: "help", kind: "commands", title: "Commands", status: "active", createdAt: 0, ordinal: 0, payload: {} },
    { presentation: "embedded" } as CardActions
  )}</ControllerTestProvider>)
  gates.catalog = false
  const dark = render()
  expect(dark).not.toContain("/docs")
  expect(dark).not.toContain("/debug-api")
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const closed = createController(store, silentAgent, { fetchImpl: async () => new Response("{}") })
  const hidden = renderToStaticMarkup(<ControllerTestProvider controller={closed}>{commandsCardFamily.commands.render(
    { id: "help", kind: "commands", title: "Commands", status: "active", createdAt: 0, ordinal: 0, payload: {} },
    { presentation: "embedded" } as CardActions
  )}</ControllerTestProvider>)
  expect(hidden).not.toContain("/debug-api")
  expect(hidden).not.toContain("/docs")
})

test("a debug-api failure journals only generic status copy; response text stays in the seam", async () => {
  const { controller, store } = await setup(async () => Response.json({ class: "infra", message: "leaked response words" }, { status: 500 }))
  await controller.runCommandForResult("debug-api", "getStack")
  await settle(() => store.collections.cards.has("debug-api"))
  expect((await controller.runCommandForResult("debug.api", '{"operationId":"getStack","intent":"send"}')).status).toBe("executed")
  await settle(() => store.collections.toasts.get("toast-debug.api.send")?.status === "failed")
  expect(controller.debugApi.get().model.exchange?.failure?.message).toBe("leaked response words")
  expect(store.collections.toasts.get("toast-debug.api.send")?.detail).toBe("The API answered HTTP 500 (infra).")
  expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain("leaked response words")
  expect(JSON.stringify([...store.collections.toasts.values()])).not.toContain("leaked response words")
})

test("an account change during a production Send publishes nothing and clears pending state", async () => {
  let finish!: (response: Response) => void
  const { controller, store, calls } = await setup(() => new Promise(resolve => { finish = resolve }))
  await controller.runCommandForResult("debug-api", "getStack")
  await settle(() => store.collections.cards.has("debug-api"))
  expect((await controller.runCommandForResult("debug.api", '{"operationId":"getStack","intent":"send"}')).status).toBe("executed")
  await settle(() => calls.length === 1)
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", admin: false, scopesPlain: null }).isPersisted.promise
  expect(calls[0]!.init?.signal?.aborted).toBe(true)
  finish(new Response('{"items":["old account"]}'))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(controller.debugApi.get().busy).toBeFalsy()
  expect(controller.debugApi.get().model.exchange).toBeUndefined()
  expect(JSON.stringify(controller.debugApi.get())).not.toContain("old account")
  expect(store.collections.toasts.get("toast-debug.api.send")?.status).not.toBe("ok")
})

test("automatic (system) and agent calls of either debug API flow refuse before the handler runs", async () => {
  const { controller, store, calls } = await setup()
  for (const name of ["debug.api", "debug-api"]) {
    expect((await controller.commands.run(name, '{"operationId":"getStack","intent":"open"}', "automatic")).status).toBe("failed")
    expect((await controller.commands.run(name, '{"operationId":"getStack","intent":"send"}', "automatic")).status).toBe("failed")
    expect((await controller.commands.runForAgent(name, "getStack")).status).toBe("failed")
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(calls).toEqual([])
  expect(store.collections.cards.has("debug-api")).toBe(false)
  expect((await controller.commands.run("debug-api", '{"operationId":"getStack","intent":"open"}')).status).toBe("executed")
})
