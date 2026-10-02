import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import { BROWSER_READ_FAILURE, BrowserCardBody } from "./ConversationCards"
import { WORKER_REFUSAL_COPY } from "@smthrs/rpc/RefusalCopy"

GlobalRegistrator.register({ url: "http://127.0.0.1:4920/owner/repo" })
afterAll(async () => { await GlobalRegistrator.unregister() })

const browserCard = (url: string, finalUrl: string | null = null): Extract<Card, { kind: "browser" }> => ({
  id: `browser-${url}`, kind: "browser", title: "page", status: "active", createdAt: 0, ordinal: 0,
  payload: { url, finalUrl, status: 200, frameable: true, blockReason: null }
})

test("a browser card embeds a foreign http(s) page", () => {
  const html = renderToStaticMarkup(<BrowserCardBody card={browserCard("https://example.com/page")} />)
  expect(html).toContain('<iframe class="browser-card-frame" src="https://example.com/page"')
})

test("an upstream browser card cannot frame the app's own origin with scripts and same-origin", () => {
  for (const card of [
    browserCard("http://127.0.0.1:4920/api/local-session"),
    browserCard("https://example.com/", "http://127.0.0.1:4920/"),
    browserCard("/api/local-session")
  ]) {
    const html = renderToStaticMarkup(<BrowserCardBody card={card} />)
    expect(html).not.toContain("<iframe")
    expect(html).not.toContain('href="http://127.0.0.1:4920')
    expect(html).toContain("This site can&#x27;t be embedded here.")
  }
})

// Retained behavior: retiring adjacent provider controls must not lose browser
// refusal coverage or turn an infrastructure refusal into the person's fault.
test("a browser refusal keeps raw details out of its sentence and offers no invented action", () => {
  const raw = "HTTP 502 upstream_timeout: fetch https://example.com/ failed"
  const card: Extract<Card, { kind: "browser" }> = {
    ...browserCard("https://example.com/"), status: "error",
    payload: { url: "https://example.com/", finalUrl: null, status: 0, frameable: false, blockReason: null, error: raw }
  }
  const host = document.createElement("div")
  host.innerHTML = renderToStaticMarkup(<BrowserCardBody card={card} />)
  const notice = host.querySelector<HTMLElement>('[data-testid="browser-card-failure"]')!
  expect(notice.dataset.failure).toBe("BrowserReadFailed")
  expect(notice.dataset.fault).toBe("infra")
  expect(notice.querySelector(":scope > p")?.textContent).toBe(BROWSER_READ_FAILURE.sentence)
  expect(notice.querySelector(":scope > p")?.textContent).not.toContain("502")
  expect(notice.querySelector("details pre")?.textContent).toBe(raw)
  expect(notice.querySelectorAll("button")).toHaveLength(0)
})

test("a typed invalid-input Browser refusal shows canonical user copy without diagnostics or controls", () => {
  for (const fault of [undefined, "user"] as const) {
    const card: Extract<Card, { kind: "browser" }> = {
      ...browserCard("https://example.com/"), status: "error",
      payload: { url: "https://example.com/", finalUrl: null, status: null, frameable: false, blockReason: null,
        error: "raw diagnostic", refusal: { status: 400, code: "request_invalid", message: "raw diagnostic", ...(fault === undefined ? {} : { fault }) } }
    }
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(<BrowserCardBody card={card} />)
    const notice = host.querySelector<HTMLElement>('[data-testid="browser-card-failure"]')!
    expect(notice.dataset.fault).toBe("user")
    expect(notice.dataset.failure).toBe("request_invalid")
    expect(notice.textContent).toBe(WORKER_REFUSAL_COPY.request_invalid.lead)
    expect(host.querySelectorAll("details,button,iframe")).toHaveLength(0)
  }
})

test("unknown or contradictory persisted Browser metadata cannot turn an infrastructure error into user fault", () => {
  for (const refusal of [
    { status: 400, code: "future_code", fault: "user" },
    { status: 503, code: "request_invalid", fault: "user" },
    { status: 400, code: "request_invalid", fault: "infra" }
  ] as const) {
    const card: Extract<Card, { kind: "browser" }> = {
      ...browserCard("https://example.com/"), status: "error",
      payload: { url: "https://example.com/", finalUrl: null, status: null, frameable: false, blockReason: null,
        error: "request_invalid raw diagnostic", refusal: { ...refusal, message: "raw diagnostic" } }
    }
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(<BrowserCardBody card={card} />)
    const notice = host.querySelector<HTMLElement>('[data-testid="browser-card-failure"]')!
    expect(notice.dataset.fault).toBe("infra")
    expect(notice.querySelector(":scope > p")?.textContent).toBe(BROWSER_READ_FAILURE.sentence)
    expect(notice.querySelector("details")).not.toBeNull()
  }
})
