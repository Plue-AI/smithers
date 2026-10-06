import { expect, test } from "bun:test"
import * as Y from "yjs"
import { scopedControllers } from "../../state/ControllerTestScope"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, silentAgent } from "../../state/TestFixtures"
import { encodeWikiState } from "../../wiki/CloudWiki"

const createAppController = scopedControllers()
test("install wiki doors load repository pages into embedded cards through the production dispatcher", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "owner/repo" }).isPersisted.promise
  const doc = new Y.Doc()
  doc.getText("markdown").insert(0, "# Install decision\n\nKeep every edit.")
  let page = { id: 42, slug: "retries", path: "decisions/retries.md", title: "Install decision", body: doc.getText("markdown").toString(), revision: 3,
    author: { id: 1, login: "will" }, created_at: "2026-10-05", updated_at: "2026-10-05" }
  const requests: string[] = []
  let refuseIndex = false
  let creates = 0
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["install", "identity", "cloud"], authFlow: "credentials", sandbox: null },
    fetchImpl: async (input, init) => {
      const url = String(input); requests.push(url)
      if (url.includes("/navigation/index?")) return refuseIndex
        ? Response.json({ message: "Forbidden" }, { status: 403 })
        : Response.json({ pages: [{ ...page, metadata: {} }] })
      if (url.includes("/wiki?visibility=") && init?.method === "POST") {
        creates++
        const input = JSON.parse(String(init.body))
        doc.getText("markdown").delete(0, doc.getText("markdown").length)
        doc.getText("markdown").insert(0, input.body)
        page = { ...page, id: 43, title: input.title, slug: "new-decision", path: "new-decision.md", body: input.body, revision: 1 }
        return Response.json(page)
      }
      if (url.includes("/document?")) return Response.json({ page, state: encodeWikiState(Y.encodeStateAsUpdate(doc)), state_vector: encodeWikiState(Y.encodeStateVector(doc)) })
      if (url.includes("/stream?")) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": connected\n\n")) } }), { headers: { "content-type": "text/event-stream" } })
      if (url.includes("/wiki?page=")) return Response.json([page])
      return Response.json({}, { status: 404 })
    }
  })
  try {
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "owner/repo", org: "owner", ownerKind: "user", name: "repo", head: null }] }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "user", id: "owner/repo" }).isPersisted.promise
    expect(await controller.runCommandForResult("wiki")).toMatchObject({ status: "executed" })
    const index = store.collections.cards.get("wiki-index-owner/repo-public")
    expect(index?.kind).toBe("world")
    expect(index?.payload).toMatchObject({ documents: [{ title: "Install decision" }] })
    expect(await controller.runCommandForResult("wiki.page", "decisions/retries")).toMatchObject({ status: "executed" })
    const pages = [...store.collections.worldDocuments.values()].filter(row => row.cloud?.pageId === 42)
    expect(pages).toHaveLength(1)
    expect(pages[0]?.body).toBe("# Install decision\n\nKeep every edit.")
    expect([...store.collections.cards.values()].some(card => card.id.startsWith("wiki-open-") && card.kind === "world")).toBe(true)
    expect(requests.some(url => url.includes("/wiki/retries/document?"))).toBe(true)
    expect(await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "wiki.page", args: "Install decision" }) })).toBe("failed: this command runs on the conversation host")
    expect([...store.collections.cards.keys()].some(id => id.startsWith("design:wiki:"))).toBe(false)
    expect(await controller.runCommandForResult("wiki.page", "New decision")).toMatchObject({ status: "executed" })
    expect(creates).toBe(1)
    expect([...store.collections.worldDocuments.values()].find(row => row.cloud?.pageId === 43)?.body).toBe("# New decision\n\n")
    refuseIndex = true
    expect(await controller.runCommandForResult("wiki.page", "Forbidden decision")).toMatchObject({ status: "failed" })
    expect(creates).toBe(1)
  } finally { controller.dispose(); doc.destroy() }
}, 120_000)
