import { Window } from "happy-dom"
import { afterAll, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { CardSchema } from "@smthrs/rpc/Cards"
import type { MythicalStack } from "@smthrs/rpc/Mythical"
import { FlowFormCardBody } from "../../cards/FlowFormCards"
import { WorldCardBody } from "../../cards/ConversationCards"
import { ControllerContext } from "../../ControllerContext"
import { createApplicationClient } from "../../runtime/ApplicationClient"
import { createAppController } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import { memoryStorage, unavailableAgent, waitFor } from "../TestFixtures"

// Only rendering needs a DOM. Retain native HTTP, streams and cancellation.
const window = new Window({ url: "http://app.test/alice/project" })
const originals = new Map(["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.defineProperty(globalThis, "window", { value: window, configurable: true })
Object.defineProperty(globalThis, "document", { value: window.document, configurable: true })
afterAll(async () => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  await window.happyDOM.close()
})

const repo = "alice/project", path = "/api/repos/alice/project/mythical"
const stack: MythicalStack = {
  repository: repo, state: "active", generation: 1, mainBehind: false, changes: [], items: [],
  lanes: [], limits: { maxParallel: 1 },
  wiki: { state: "current", commit: "c1", publishedCommit: "c1", pages: 1, edited: 0, attempt: 1 }
}
const harness = async (initialSignedIn = false) => {
  let signedIn = initialSignedIn
  const requests: Array<{ method: string; path: string }> = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    requests.push({ method: request.method, path: url.pathname })
    if (url.pathname === "/api/user") return signedIn
      ? Response.json({ username: "alice", is_admin: false })
      : Response.json({ code: "unauthorized", message: "Sign in required" }, { status: 401 })
    if (url.pathname === path || url.pathname === `${path}/wiki`) return Response.json(stack)
    if (url.pathname === `${path}/events`) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")) }
    }), { headers: { "content-type": "text/event-stream" } })
    return Response.json([], { status: 404 })
  } })
  const origin = server.url.toString().replace(/\/$/, "")
  const target = resolveApplicationTarget({ apiVersion: 1, mode: "web-selfhost", apiOrigin: "", auth: { kind: "session" }, cors: "same-origin", developerExternal: false }, origin)
  const application = createApplicationClient(target, { fetchImpl: (input, init) => Bun.fetch(input instanceof Request ? input : new URL(String(input), origin), init), pageOrigin: origin })
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const controller = createAppController(store, unavailableAgent, {
    baseUrl: origin, fetchImpl: Bun.fetch, applicationTarget: target, applicationIdentity: application.identity,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "credentials", sandbox: null }
  })
  await controller.loadSession()
  return { store, storage, controller, requests,
    async signIn() { signedIn = true; await controller.loadSession() },
    async signOut() { signedIn = false; await controller.loadSession() },
    async close() { await controller.dispose(); await server.stop(true) }
  }
}

const form = (t: Awaited<ReturnType<typeof harness>>) => {
  const card = t.store.collections.cards.get("form-wiki.create")
  if (card?.kind !== "flow-form") throw new Error("Missing Wiki form")
  const decoded = CardSchema.parse(card)
  if (decoded.kind !== "flow-form") throw new Error("Invalid Wiki form")
  return decoded
}
const renderForm = (t: Awaited<ReturnType<typeof harness>>, card = form(t)) => {
  const host = document.createElement("div")
  host.innerHTML = renderToStaticMarkup(<ControllerContext.Provider value={t.controller}>
    <FlowFormCardBody card={card} onRunCommand={() => {}} />
  </ControllerContext.Provider>)
  return host
}
const fill = async (t: Awaited<ReturnType<typeof harness>>) => {
  expect(await t.controller.commands.run("form.set", `${form(t).id} repo ${repo}`)).toMatchObject({ status: "executed" })
}

test("a signed-out Wiki slash door asks for sign-in after real HTTP401 and mutates nothing", async () => {
  const t = await harness()
  try {
    expect(t.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
    expect(t.requests.some(request => request.path === "/api/user")).toBe(true)
    expect(await t.controller.commands.run("wiki.create", repo)).toMatchObject({ status: "executed" })
    expect(t.store.collections.cards.get("form-wiki.create")).toBeUndefined()
    expect([...t.store.collections.messages.values()].some(message => message.action?.flow === "sign-in" && message.text === "Sign in to continue.")).toBe(true)
    expect(t.requests.filter(request => !["GET", "HEAD"].includes(request.method))).toEqual([])
    expect(t.store.collections.worldDocuments.size).toBe(0)
    expect(t.store.session().wikiRequests ?? []).toEqual([])
  } finally { await t.close() }
})

test("the existing signed-out Create Wiki button retains the sign-in prerequisite", async () => {
  const t = await harness()
  try {
    const world: Extract<Card, { kind: "world" }> = { id: "world", kind: "world", title: "Wiki", status: "active", createdAt: 0, ordinal: 0, payload: { documents: [] } }
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(<WorldCardBody card={world} worldDocuments={[]} onChangeWorldDocument={() => {}} onRunCommand={() => {}} />)
    const button = host.querySelector<HTMLButtonElement>('button[data-flow="wiki.create"]')
    expect(button?.textContent).toBe("Create Wiki")
    expect(await t.controller.commands.run(button!.dataset.flow!, button!.dataset.flowArgs)).toMatchObject({ status: "executed" })
    expect(t.store.collections.cards.get("form-wiki.create")).toBeUndefined()
    expect([...t.store.collections.messages.values()].some(message => message.action?.flow === "sign-in" && message.text === "Sign in to continue.")).toBe(true)
    expect(t.requests.filter(request => !["GET", "HEAD"].includes(request.method))).toEqual([])
  } finally { await t.close() }
})

test("a real HTTP401 after opening a signed-in Wiki form removes it before stale Submit can mutate", async () => {
  const t = await harness(true)
  try {
    expect(await t.controller.commands.run("wiki.create")).toMatchObject({ status: "form", cardId: "form-wiki.create" })
    await fill(t)
    const card = form(t)
    const host = renderForm(t)
    expect(host.querySelector<HTMLButtonElement>('[data-testid="flow-form-submit"]')?.disabled).toBe(false)
    expect(host.querySelector('[data-testid="flow-form-submit"]')?.getAttribute("data-flow")).toBe("form.submit")
    expect(CardSchema.parse(JSON.parse(JSON.stringify(card)))).toEqual(card)
    await t.signOut()
    expect(t.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
    expect(t.store.collections.cards.get(card.id)).toBeUndefined()
    expect(await t.controller.commands.run("form.submit", card.id)).toMatchObject({ status: "failed" })
    expect(t.requests.filter(request => !["GET", "HEAD"].includes(request.method))).toEqual([])
    expect(t.store.session().wikiRequests ?? []).toEqual([])
    expect([...t.store.collections.cards.values()].some(card => card.kind === "flow-form" && card.payload.errorKind === "run")).toBe(false)
  } finally { await t.close() }
})

test("a signed-in Wiki form reaches one real HTTP mutation and settles", async () => {
  const t = await harness(true)
  try {
    expect(t.store.collections.identitySessions.get("identity")?.state).toBe("signed-in")
    expect(await t.controller.commands.run("wiki.create")).toMatchObject({ status: "form" })
    await fill(t)
    expect(await t.controller.commands.run("form.submit", form(t).id)).toMatchObject({ status: "executed" })
    await waitFor(() => t.requests.some(request => request.method === "POST" && request.path === `${path}/wiki`))
    await waitFor(() => (t.store.session().wikiRequests ?? []).length === 0 && t.controller.stackSnapshots.get(repo)?.stack?.wiki?.state === "current")
    expect(t.requests.filter(request => request.method === "POST" && request.path === `${path}/wiki`)).toHaveLength(1)
    expect(form(t)).toMatchObject({ status: "acted" })
    expect(form(t).payload).not.toHaveProperty("error")
    expect(renderForm(t).querySelector('[data-testid="flow-form-failure"]')).toBeNull()
  } finally { await t.close() }
})
