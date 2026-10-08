import { expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"

test("the webpage reader embeds its served page without a model runtime", async () => {
  const values = new Map<string, string>()
  const storage: StorageApi = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
  const store = await createAppStore({ kind: "localStorage", storage })
  const reads: unknown[] = []
  const controller = createAppController(store, { available: false, startTurn: async () => { throw new Error("No model runtime") }, cancelTurn: async () => {}, subscribe: () => () => {} }, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["browser.read"], authFlow: "none", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname
      if (path !== "/api/tools/browser-fetch") return Response.json({}, { status: 404 })
      reads.push(JSON.parse(String(init?.body)))
      return Response.json({ status: 200, finalUrl: "https://embedded.example/", contentType: "text/html", text: "Served page", frameable: true, blockReason: null })
    }
  })
  try {
    expect((await controller.commands.run("browser.open", "https://embedded.example/")).status).toBe("executed")
    expect(reads).toEqual([{ url: "https://embedded.example/" }])
    const card = [...store.collections.cards.values()].find(card => card.kind === "browser")
    expect(card).toMatchObject({ kind: "browser", payload: { url: "https://embedded.example/", finalUrl: "https://embedded.example/", frameable: true, status: 200 } })
    expect(store.session().maximizedCardId).toBeNull()
  } finally { await controller.dispose() }
})
