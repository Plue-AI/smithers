import { createRoot } from "./views/testDom"
import { act } from "react"
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import type { DraftCard } from "@smthrs/rpc/DraftCard"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Draft"
import { DraftContainer, draftCardFamily, type DraftViewProps } from "./DraftCard"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppController, type AppController } from "../state/AppController"
import type { AgentPort } from "../runtime/AgentPort"
import { DraftView } from "./views/DraftView"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, signupProfileFetch, waitFor } from "../state/TestFixtures"
import { BEN, MAYA, createDesignWorld } from "../state/seams/DesignWorld"
import { designAudience } from "../state/seams/DesignWorld/todo"
import type { DraftEntry } from "../state/seams/TodoSeam"

const mount = (model: DraftCard, request?: DraftEntry["payload"]["request"], memberId = "ben") => {
  let props: DraftViewProps | undefined
  const dispatches: { tag: CatalogTag; input: unknown }[] = []
  const patches: unknown[] = []
  const card: DraftEntry = { id: "draft:1", kind: "draft", title: model.title, status: "active", createdAt: 1, ordinal: 1,
    audience_member_id: model.private ? "ben" : null, payload: { ...model, idempotencyKey: "commit-1", request } }
  const View = (value: DraftViewProps) => { props = value; return null }
  renderToStaticMarkup(<DraftContainer card={card} memberId={memberId} View={View} view={{ maximized: false }}
    onView={patch => patches.push(patch)} dispatch={(tag, input) => { dispatches.push({ tag, input }) }} />)
  return { props, dispatches, patches }
}
test("Draft maps all story models and their unmerged placement options", () => {
  for (const fixture of Object.values(fixtures).map(story => story.model)) {
    const h = mount(fixture)
    expect(h.props?.model.place.options).toEqual(fixture.place.options)
    expect(h.props?.model.issue).toEqual(fixture.issue)
    expect(h.props?.model.seed).toEqual(fixture.seed)
    h.props?.onView({ maximized: true })
    expect(h.patches).toEqual([{ maximized: true }])
  }
})
test("Commit has one stable key and placement, field edits go through form.set", () => {
  const h = mount(fixtures.before.model)
  h.props!.onAction("todo.new")
  h.props!.onAction("todo.new")
  expect(h.dispatches).toEqual(Array(2).fill({ tag: "todo.new", input: { cardId: "draft:1", idempotencyKey: "commit-1",
    text: fixtures.before.model.prompt, title: fixtures.before.model.title, acceptance: fixtures.before.model.acceptance, before: 8 } }))
  expect(h.props!.gestures.set?.tag).toBe("form.set")
  h.props!.onAction("form.set", { cardId: "other", field: "prompt", value: "New\nprompt" })
  expect(h.dispatches[2]).toEqual({ tag: "form.set", input: { cardId: "draft:1", field: "prompt", value: "New\nprompt" } })
  h.props!.onAction("draft.discard")
  expect(h.dispatches[3]).toEqual({ tag: "draft.discard", input: { draft: "draft:1" } })
  /* An appended draft sends no `before` key at all: the flow input decodes absent keys, not `undefined`. */
  const append = mount(fixtures.append.model)
  append.props!.onAction("todo.new")
  expect(Object.keys(append.dispatches[0]!.input as object).sort()).toEqual(["acceptance", "cardId", "idempotencyKey", "text", "title"])
  /* A Commit rendered before the Title's save landed sends no empty title: the seam reads the saved Draft. */
  const untitled = mount({ ...fixtures.append.model, title: "" })
  untitled.props!.onAction("todo.new")
  expect(Object.keys(untitled.dispatches[0]!.input as object).sort()).toEqual(["acceptance", "cardId", "idempotencyKey", "text"])
})
test("pending Commit disables repeat submission, Discard and editing; failure permits retry", () => {
  const request = { key: "commit-1", owner: "ben", operation: "create" as const, body: {}, state: "accepted" as const }
  const h = mount(fixtures.append.model, request)
  h.props!.onAction("todo.new")
  h.props!.onAction("draft.discard")
  h.props!.onAction("form.set", { field: "title", value: "Can't edit" })
  expect(h.dispatches).toEqual([])
  expect(h.props!.actions.find(action => action.tag === "todo.new")?.disabled?.reason).toBe("Commit pending")
  const failed = mount(fixtures.append.model, { ...request, state: "failed", error: "Connection lost" })
  expect(failed.props!.failure).toBe("Connection lost")
  failed.props!.onAction("todo.new")
  expect(failed.dispatches).toHaveLength(1)
})
test("amend commits its placed TODO; committed draft offers only its TODO link", () => {
  const amend = mount(fixtures.amend.model)
  amend.props!.onAction("todo.amend")
  expect(amend.dispatches).toEqual([{ tag: "todo.amend", input: { n: 9, text: fixtures.amend.model.prompt, cardId: "draft:1", idempotencyKey: "commit-1" } }])
  const committed = mount(fixtures.committed.model, undefined, "maya")
  expect(committed.props!.actions.map(action => action.tag)).toEqual(["todo"])
  expect(committed.props!.gestures.set).toBeUndefined()
  committed.props!.onAction("todo")
  expect(committed.dispatches).toEqual([{ tag: "todo", input: { n: 12 } }])
})
test("private drafts do not project to other members; incomplete placement disables Commit", () => {
  expect(mount(fixtures.append.model, undefined, "maya").props).toBeUndefined()
  const h = mount({ ...fixtures.before.model, place: { mode: "before", options: fixtures.before.model.place.options, n: 99 } })
  h.props!.onAction("todo.new")
  expect(h.dispatches).toEqual([])
})

test("the Draft card shows a seeded Draft to its design viewer and a provider Draft to its signed-in author only", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const design = createDesignWorld({ timers: { set: () => 0, clear: () => {} }, viewer: MAYA })
  const controller = { store, design, commands: { submit: () => Promise.resolve({ status: "executed" }) } } as unknown as AppController
  const render = (audience: string | null) => renderToStaticMarkup(<ControllerTestProvider controller={controller}>{draftCardFamily.draft.render(
    { id: "draft:1", kind: "draft", title: "Add a health endpoint", status: "active", createdAt: 1, ordinal: 1, audience_member_id: audience,
      payload: { ...fixtures.append.model, title: "Add a health endpoint", idempotencyKey: "commit-1" } }, { presentation: "embedded" } as never)}</ControllerTestProvider>)
  expect(render(designAudience(MAYA))).toContain("Add a health endpoint")
  expect(render(designAudience(BEN))).toBe("")
  expect(render("ben")).toBe("")
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  expect(render("ben")).toContain("Add a health endpoint")
  expect(render(designAudience(MAYA))).toContain("Add a health endpoint")
})

// User boundary proof: rendered Draft -> typed flow dispatcher -> provider seam -> HTTP.
// The HTTP transport is a fake install; the card, registry, persistence and seam are real.
test("on an install, rendered Draft edits and Commit reach the provider once; Discard never drops a TODO", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const posts: { path: string; body: unknown; key: string | null }[] = []
  const profile = signupProfileFetch(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://install.test").pathname
    if (path.startsWith("/api/todos") && init?.method && init.method !== "GET") {
      posts.push({ path, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("Idempotency-Key") })
    }
    if (path === "/api/todos" && init?.method === "POST") return Response.json({ state: "accepted", n: 1 }, { status: 202 })
    if (path === "/api/todos") return Response.json([])
    return new Response("{}", { status: 404 })
  })
  const unavailable: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
  const controller = createAppController(store, unavailable, { fetchImpl: profile.fetchImpl,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const pending: Promise<unknown>[] = []
  const mountCard = (card: DraftEntry) => act(() => root.render(<DraftContainer card={card} memberId="ben" View={DraftView}
    view={{ maximized: false }} onView={() => {}} dispatch={(tag, input) => {
      const result = controller.commands.submit({ name: tag, payload: input as Record<string, unknown>, actor: "user", originCardId: card.id })
      pending.push(result)
      return result
    }} />))
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    await controller.submitCommand({ name: "todo.new", payload: { text: "Add a greeting", title: "Greeting" }, actor: "user" })
    const draft = [...store.collections.cards.values()].find(card => card.kind === "draft") as DraftEntry
    mountCard(draft)
    expect(host.querySelector(".draft-private")?.textContent).toBe("Only you")
    expect(posts).toEqual([])
    const prompt = host.querySelector("textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Keep greeting edits")
      prompt.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => prompt.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    await Promise.all(pending.splice(0))
    expect((store.collections.cards.get(draft.id) as DraftEntry).payload.prompt).toBe("Keep greeting edits")
    mountCard(store.collections.cards.get(draft.id) as DraftEntry)
    act(() => { host.querySelector<HTMLButtonElement>('[data-flow="todo.new"]')!.click(); host.querySelector<HTMLButtonElement>('[data-flow="todo.new"]')!.click() })
    await Promise.all(pending.splice(0))
    await waitFor(() => posts.length === 1)
    expect(posts).toEqual([{ path: "/api/todos", body: { title: "Greeting", prompt: "Keep greeting edits", acceptance: [], place: { mode: "append" } }, key: draft.payload.idempotencyKey }])
    expect(posts[0]!.key).toBeTruthy()
    await controller.submitCommand({ name: "todo.new", payload: { text: "Discard me", title: "Discard" }, actor: "user" })
    const discard = [...store.collections.cards.values()].find(card => card.kind === "draft" && card.id !== draft.id) as DraftEntry
    mountCard(discard)
    act(() => host.querySelector<HTMLButtonElement>('[data-flow="draft.discard"]')!.click())
    await Promise.all(pending.splice(0))
    expect(store.collections.cards.has(discard.id)).toBe(false)
    expect(posts).toHaveLength(1)
  } finally { act(() => root.unmount()); host.remove(); await controller.dispose() }
})
