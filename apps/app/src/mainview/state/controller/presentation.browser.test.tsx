import { Window } from "happy-dom"
import { afterAll, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CardSchema } from "@smthrs/rpc/Cards"
import { WORKER_REFUSAL_COPY } from "@smthrs/rpc/RefusalCopy"
import { handleBrowserFetch } from "../../../bun/BrowserFetch"
import { BrowserCardBody, BROWSER_READ_FAILURE } from "../../cards/ConversationCards"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import { memoryStorage, silentAgent } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createPresentationController } from "./presentation"

// Keep Bun's real HTTP/AbortSignal implementation; only rendering needs a DOM.
const window = new Window({ url: "http://app.test/owner/repo" })
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
Object.defineProperty(globalThis, "window", { value: window, configurable: true })
Object.defineProperty(globalThis, "document", { value: window.document, configurable: true })
afterAll(async () => {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
  else Reflect.deleteProperty(globalThis, "window")
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
  else Reflect.deleteProperty(globalThis, "document")
  await window.happyDOM.close()
})

const url = "https://127.0.0.1/private"
const harness = async () => {
  let reply: (() => Response) | undefined
  let requests = 0, resolutions = 0, reads = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/api/tools/browser-fetch") return new Response(null, { status: 404 })
    requests++
    if (reply !== undefined) return reply()
    return handleBrowserFetch(request, {
      // Observation hooks: a literal private destination must be refused before
      // either dependency can run. The request and production guard are real.
      resolveHost: async () => { resolutions++; throw new Error("Unexpected resolution") },
      fetchImpl: async () => { reads++; throw new Error("Unexpected destination read") }
    })
  } })
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const ctx = createControllerContext(store, silentAgent, { baseUrl: server.url.toString().replace(/\/$/, ""), fetchImpl: Bun.fetch })
  ctx.onDispose(store.dispose!)
  const failures = createFailureController(ctx)
  ctx.withToast = failures.withToast
  ctx.resolveToast = failures.resolveToast
  const presentation = createPresentationController(ctx, async () => undefined)
  const card = () => {
    const value = store.collections.cards.get(`browser-${url}`)
    if (value?.kind !== "browser") throw new Error("Missing Browser card")
    const decoded = CardSchema.parse(value)
    if (decoded.kind !== "browser") throw new Error("Invalid Browser card")
    return decoded
  }
  return { store, storage, ctx, presentation, card,
    reply(next: () => Response) { reply = next },
    counts: () => ({ requests, resolutions, reads }),
    async close() { await ctx.dispose(); await server.stop(true) },
    async disconnect() { await server.stop(true) }
  }
}

const notice = (card: Extract<Card, { kind: "browser" }>) => {
  const host = document.createElement("div")
  host.innerHTML = renderToStaticMarkup(<BrowserCardBody card={card} />)
  const failure = host.querySelector<HTMLElement>('[data-testid="browser-card-failure"]')
  if (failure === null) throw new Error("Missing Browser refusal")
  return { host, failure }
}

const assertUser = (card: Extract<Card, { kind: "browser" }>) => {
  const { host, failure } = notice(card)
  expect(failure.dataset.fault).toBe("user")
  expect(failure.querySelector(":scope > p")?.textContent).toBe(WORKER_REFUSAL_COPY.request_invalid.lead)
  expect(host.querySelectorAll("details,button,iframe")).toHaveLength(0)
  expect(host.textContent).not.toContain("Not your fault")
}

test("real HTTP invalid-address refusal preserves typed user metadata through serialization and reload without reading the destination", async () => {
  const t = await harness()
  try {
    await t.presentation.openBrowser(url)
    expect(t.counts()).toEqual({ requests: 1, resolutions: 0, reads: 0 })
    expect(t.card()).toMatchObject({ status: "error", payload: { frameable: false, refusal: { code: "request_invalid", status: 400, fault: "user", origin: "local" } } })
    assertUser(t.card())
    const serialized = CardSchema.parse(JSON.parse(JSON.stringify(t.card())))
    expect(serialized).toEqual(t.card())
    const id = t.card().id
    await t.ctx.dispose()
    const reopened = await createAppStore({ kind: "localStorage", storage: t.storage })
    try {
      const restored = reopened.collections.cards.get(id)
      expect(CardSchema.parse(restored)).toEqual(serialized)
      if (restored?.kind !== "browser") throw new Error("Missing reloaded Browser card")
      assertUser(restored)
    } finally { await reopened.dispose?.() }
  } finally { await t.close() }
})

test("typed user refusal uses canonical copy and hides arbitrary backend words", async () => {
  const t = await harness()
  try {
    t.reply(() => Response.json({ status: "error", code: "request_invalid", message: "private diagnostic sentinel", origin: "local" }, { status: 400 }))
    await t.presentation.openBrowser(url)
    assertUser(t.card())
    expect(notice(t.card()).host.textContent).not.toContain("private diagnostic sentinel")
  } finally { await t.close() }
})

for (const [name, status, body] of [
  ["unknown code", 400, { status: "error", code: "future_code", fault: "user", message: "request_invalid" }],
  ["missing envelope", 400, { code: "request_invalid", message: "no status" }],
  ["wrong HTTP status", 503, { status: "error", code: "request_invalid", message: "wrong status" }],
  ["non-string code", 400, { status: "error", code: 12, message: "request_invalid" }],
  ["missing message", 400, { status: "error", code: "request_invalid" }],
  ["conflicting fault", 400, { status: "error", code: "request_invalid", fault: "infra", message: "conflict" }],
  ["known infrastructure", 502, { status: "error", code: "upstream_timeout", message: "private sentinel" }]
] as const) {
  test(`${name} remains a safe infrastructure Browser failure`, async () => {
    const t = await harness()
    try {
      t.reply(() => Response.json(body, { status }))
      await t.presentation.openBrowser(url)
      const { host, failure } = notice(t.card())
      expect(failure.dataset.fault).toBe("infra")
      expect(failure.querySelector(":scope > p")?.textContent).toBe(BROWSER_READ_FAILURE.sentence)
      expect(host.querySelectorAll("button,iframe")).toHaveLength(0)
      expect(host.querySelector("details")).not.toBeNull()
    } finally { await t.close() }
  })
}

test("malformed HTTP error and a real connection failure retain infrastructure handling", async () => {
  const t = await harness()
  try {
    t.reply(() => new Response("<h1>request_invalid</h1>", { status: 400, headers: { "content-type": "text/html" } }))
    await t.presentation.openBrowser(url)
    expect(notice(t.card()).failure.dataset.fault).toBe("infra")
    await t.disconnect()
    await t.presentation.openBrowser(url)
    expect(notice(t.card()).failure.dataset.fault).toBe("infra")
    expect(t.card().payload.error).toContain("didn't answer")
  } finally { await t.close() }
})

test("a successful retry replaces the refusal and reloads as an ordinary Browser card", async () => {
  const t = await harness()
  try {
    await t.presentation.openBrowser(url)
    assertUser(t.card())
    const original = t.card()
    t.reply(() => Response.json({ status: 200, finalUrl: "https://example.com/", frameable: true, text: "Read page" }))
    await t.presentation.openBrowser(url)
    expect(t.card()).toMatchObject({ id: original.id, ordinal: original.ordinal, createdAt: original.createdAt, status: "active" })
    expect(t.card().payload).not.toHaveProperty("error")
    expect(t.card().payload).not.toHaveProperty("refusal")
    const html = renderToStaticMarkup(<BrowserCardBody card={t.card()} />)
    expect(html).toContain("<iframe")
    expect(html).not.toContain("browser-card-failure")
    const saved = t.card()
    await t.ctx.dispose()
    const reopened = await createAppStore({ kind: "localStorage", storage: t.storage })
    try { expect(CardSchema.parse(reopened.collections.cards.get(saved.id))).toEqual(saved) }
    finally { await reopened.dispose?.() }
  } finally { await t.close() }
})
