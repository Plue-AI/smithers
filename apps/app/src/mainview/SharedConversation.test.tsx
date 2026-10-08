import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { MessageScrollerProvider } from "@smthrs/ui"
import { renderToStaticMarkup } from "react-dom/server"
import { ControllerContext } from "./ControllerContext"
import { SharedConversation } from "./SharedConversation"
import type { AppController } from "./state/AppController"
import type { Card } from "./state/AppState"
import { createAppStore } from "./state/AppStore"
import { memoryStorage } from "./state/TestFixtures"
import { SharedConversationSchema, type SharedConversationSeam } from "./state/seams/SharedConversationSeam"

GlobalRegistrator.register()
afterAll(async () => { await GlobalRegistrator.unregister() })
const card = (id: string, title: string): Card => ({ id, kind: "browser", title, status: "active", createdAt: 0, ordinal: 0,
  payload: { url: "https://example.com/", finalUrl: null, status: 200, frameable: true, blockReason: null } })

test("shared cards retain their first position, latest record, and one owner across local and shared rows", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = { store, runCommand: () => {}, runCommandForResult: async () => undefined } as unknown as AppController
  const conversation = SharedConversationSchema.parse({ id: "main", entries: [
    { id: "first", author: 1, authorLogin: "maya", runId: "run-1", prompt: "first", state: "completed", frames: [
      { type: "card", runId: "run-1", card: card("page", "Before") },
      { type: "card", runId: "foreign-run", card: card("foreign", "Foreign") }
    ] },
    { id: "second", author: 1, authorLogin: "maya", runId: "run-2", prompt: "second", state: "completed", frames: [
      { type: "card", runId: "run-2", card: card("page", "After") },
      { type: "card", runId: "run-2", card: card("other", "Other page") }
    ] }
  ] })
  const source = { get: () => ({ conversation }), subscribe: () => () => {} } as unknown as SharedConversationSeam
  try {
    const render = (localCardIds?: ReadonlySet<string>) => renderToStaticMarkup(<ControllerContext value={controller}><MessageScrollerProvider><SharedConversation source={source} localCardIds={localCardIds} /></MessageScrollerProvider></ControllerContext>)
    const html = render()
    expect(html.match(/data-testid="card-page"/g)).toHaveLength(1)
    expect(html).toContain("After")
    expect(html).not.toContain("Before")
    expect(html).not.toContain("Foreign")
    expect(html.indexOf('data-testid="card-page"')).toBeLessThan(html.indexOf('data-testid="card-other"'))
    const local = render(new Set(["page"]))
    expect(local).not.toContain('data-testid="card-page"')
    expect(local).toContain('data-testid="card-other"')
  } finally { await store.dispose?.() }
})
