import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import { BrowserCardBody } from "./ConversationCards"

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
