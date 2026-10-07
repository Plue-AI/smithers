import { afterAll, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
beforeAll(() => GlobalRegistrator.register())
afterAll(() => GlobalRegistrator.unregister())
import { renderToStaticMarkup } from "react-dom/server"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import type { ProposalViewProps } from "@smthrs/rpc/ProposalCard"
import { renderProposalCard as ProposalContainer } from "./CardRenderers"
import { LiveProposalContainer } from "./ProposalContainer"
const model = { id: "check:lint@review", title: "Run lint", evidence: ["3 of the last 5"], refs: [], state: "open" as const }
const mount = (source: unknown = model, tags: CatalogTag[] = ["learning.accept", "learning.dismiss", "todo"]) => {
  let props!: ProposalViewProps
  const calls: unknown[] = []
  renderToStaticMarkup(<ProposalContainer model={source} allowed={new Set(tags)} dispatch={(tag, input) => { calls.push({ tag, input }) }}
    View={value => { props = value; return null }} view={{ maximized: false }} onView={() => {}} />)
  return { props, calls }
}
test("renderer binds Make TODO and Dismiss to catalog dispatch with exact note identity", () => {
  const { props, calls } = mount()
  expect(props.actions.map(action => action.label)).toEqual(["Make TODO", "Dismiss"])
  for (const action of props.actions) props.onAction(action.tag, action.args)
  expect(calls).toEqual([{ tag: "learning.accept", input: { id: "check:lint@review" } }, { tag: "learning.dismiss", input: { id: "check:lint@review" } }])
})
test("closed proposals never offer mutation; accepted proposal navigates to its TODO", () => {
  const h = mount({ ...model, state: "accepted", todo: { n: 12, title: "Run lint" } })
  expect(h.props.actions).toEqual([])
  h.props.onAction("todo", h.props.gestures.todo?.args)
  expect(h.calls).toEqual([{ tag: "todo", input: { n: 12 } }])
  expect(mount({ ...model, state: "dismissed" }).props.actions).toEqual([])
})
test("missing descriptors and unavailable projections expose no actions or fabricated data", () => {
  const h = mount(model, [])
  expect(h.props.actions).toEqual([])
  h.props.onAction("learning.accept")
  h.props.onAction("learning.dismiss")
  expect(h.calls).toEqual([])
  expect(mount(null).props).toBeUndefined()
  expect(() => mount({})).toThrow()
})
test("the live seam retains the seeded fallback until it actually serves a proposal", () => {
  expect(renderToStaticMarkup(<LiveProposalContainer id="check:lint@review" fallback={<span>Seeded proposal</span>}
    allowed={new Set()} dispatch={() => {}} view={{ maximized: false }} onView={() => {}} />)).toBe("<span>Seeded proposal</span>")
})

test("a proposals topic replaces only the matching seed and its buttons dispatch; invalid data restores the seed", async () => {
  const { createRoot } = await import("react-dom/client")
  const { act } = await import("react")
  const { LiveChannel } = await import("../runtime/LiveChannel")
  const socket = { readyState: 1, onopen: null as (() => void) | null, onclose: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null, send() {}, close() {} }
  const channel = new LiveChannel({ socket: () => socket })
  const host = document.createElement("div")
  const root = createRoot(host)
  const calls: unknown[] = []
  try {
    await act(async () => root.render(<LiveProposalContainer id="check:lint@review" fallback={<span>Seeded proposal</span>} channel={channel}
      allowed={new Set(["learning.accept", "learning.dismiss"])} dispatch={(tag, input) => { calls.push({ tag, input }) }}
      view={{ maximized: false }} onView={() => {}} />))
    expect(host.textContent).toBe("Seeded proposal")
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 1, cursor: 1, data: [{ ...model, id: "other" }] }) }))
    expect(host.textContent).toBe("Seeded proposal")
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 1, cursor: 2, data: [model] }) }))
    expect(host.textContent).toContain("3 of the last 5")
    const buttons = host.querySelectorAll<HTMLButtonElement>("button[data-flow]")
    await act(async () => { for (const button of buttons) button.click() })
    expect(calls).toEqual([{ tag: "learning.accept", input: { id: "check:lint@review" } }, { tag: "learning.dismiss", input: { id: "check:lint@review" } }])
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 1, cursor: 3, data: [{ id: model.id }] }) }))
    expect(host.textContent).toBe("Seeded proposal")
  } finally {
    await act(async () => root.unmount())
    channel.dispose()
  }
})

test("the registered proposal family dispatches the person press through the app flow and real HTTP seam", async () => {
  const { createRoot } = await import("react-dom/client")
  const { act } = await import("react")
  const { LiveChannel } = await import("../runtime/LiveChannel")
  const { renderCardBody } = await import("./CardRenderers")
  const { ControllerTestProvider } = await import("../ControllerContext")
  const { createAppStore } = await import("../state/AppStore")
  const { memoryStorage, waitFor } = await import("../state/TestFixtures")
  const { createAppController } = await import("../state/AppController")
  const { RuntimeCapabilitySchema } = await import("@smthrs/rpc/AppBootstrap")
  const socket = { readyState: 1, onopen: null as (() => void) | null, onclose: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null, send() {}, close() {} }
  const channel = new LiveChannel({ socket: () => socket })
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const calls: { path: string; method: string }[] = []
  let resolve!: (response: Response) => void
  const pending = new Promise<Response>(done => { resolve = done })
  const controller = createAppController(store, { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }),
    cancelTurn: async () => {}, subscribe: () => () => {} }, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: [...RuntimeCapabilitySchema.options], authFlow: "both", sandbox: null },
    live: channel,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "http://local.test").pathname
      if (path === "/api/proposals/check%3Alint%40review/accept") { calls.push({ path, method: init?.method ?? "GET" }); return pending }
      return new Response(JSON.stringify({ error: { code: "not_found", message: "Not found" } }), { status: 404 })
    }
  })
  const host = document.createElement("div"), root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    await controller.presentSubject({ id: "proposal:check:lint@review", kind: "proposal", title: "Run lint", payload: { id: model.id, model } })
    const delegated = await controller.commands.submit({ name: "learning.accept", payload: { id: model.id }, actor: "agent" })
    expect(delegated.status).toBe("failed")
    expect(delegated).toMatchObject({ error: "Confirmation execution unavailable." })
    expect(calls).toEqual([])
    const card = store.collections.cards.get("proposal:check:lint@review")!
    const actions = { onDecideApproval() {}, onConnectGitHub() {}, onRunWorkflow() {}, onStopRun() {}, onRetryRun() {}, onChooseWorkflowRepo() {},
      worldDocuments: [], onChangeWorldDocument() {}, onRunCommand() {} }
    await act(async () => root.render(<ControllerTestProvider controller={controller}>{renderCardBody(card, actions)}</ControllerTestProvider>))
    const button = host.querySelector<HTMLButtonElement>('button[data-flow="learning.accept"]')!
    expect(button).not.toBeNull()
    await act(async () => button.click())
    await waitFor(() => calls.length === 1)
    expect(calls).toEqual([{ path: "/api/proposals/check%3Alint%40review/accept", method: "POST" }])
    expect(store.collections.cards.get(card.id)).toMatchObject({ payload: { model: { state: "open" }, request: { state: "pending" } } })
    await new Promise(done => setTimeout(done, 350))
    expect([...store.collections.toasts.values()].some(row => row.key === `proposal.${model.id}` && row.status === "running")).toBe(true)
    await controller.presentSubject({ id: "proposal:unrelated", kind: "proposal", title: "Unrelated", payload: { id: "unrelated" } })
    expect(store.collections.cards.has("proposal:unrelated")).toBe(true)
    resolve(new Response(JSON.stringify({ ...model, state: "accepted", todo: { n: 12, title: "Run lint" } }), { status: 202 }))
    await waitFor(() => {
      const row = store.collections.cards.get(card.id)
      return row?.kind === "proposal" && row.payload.model?.state === "accepted"
    })
    expect(store.collections.cards.get(card.id)).toMatchObject({ payload: { model: { state: "accepted", todo: { n: 12 } } } })
  } finally {
    await act(async () => root.unmount())
    controller.dispose()
    channel.dispose()
  }
})

test("dismissing the seeded fallback retains its evidence and Dismissed card", async () => {
  const { createAppStore } = await import("../state/AppStore")
  const { memoryStorage, unavailableAgent } = await import("../state/TestFixtures")
  const { createAppController } = await import("../state/AppController")
  const { ControllerTestProvider } = await import("../ControllerContext")
  const { renderCardBody } = await import("./CardRenderers")
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: async () => new Response("{}", { status: 404 }) })
  try {
    await controller.presentSubject({ id: "proposal:r-learn", kind: "proposal", title: "Use the shared backoff() for every retry", payload: { id: "r-learn" } })
    const result = await controller.commands.submit({ name: "learning.dismiss", payload: { id: "r-learn" }, actor: "user" })
    expect(result.status).toBe("executed")
    const row = store.collections.cards.get("proposal:r-learn")!
    expect(row).toMatchObject({ payload: { model: { state: "dismissed", evidence: ["Three TODOs this month hand-wrote retry delays. lib/backoff.ts already caps them."] } } })
    const actions = { onDecideApproval() {}, onConnectGitHub() {}, onRunWorkflow() {}, onStopRun() {}, onRetryRun() {}, onChooseWorkflowRepo() {},
      worldDocuments: [], onChangeWorldDocument() {}, onRunCommand() {} }
    expect(renderToStaticMarkup(<ControllerTestProvider controller={controller}>{renderCardBody(row, actions)}</ControllerTestProvider>)).toContain("Dismissed")
  } finally { controller.dispose() }
})
