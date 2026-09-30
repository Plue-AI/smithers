import { expect, test } from "bun:test"
import * as Y from "yjs"
import { flowArgs } from "../flows/FlowArgs"
import { encodeWikiState, wikiDocumentId } from "../wiki/CloudWiki"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, unavailableAgent } from "./TestFixtures"

const createAppController = scopedControllers()
const repo = "owner/other", slug = "home", id = wikiDocumentId(repo, 42)
const target = `/api/repos/${repo}/wiki/${slug}`

test.each(["slash", "button", "form", "agent"] as const)("Wiki Open reaches its explicit repository without inventory through %s", async (door) => {
  const doc = new Y.Doc()
  doc.getText("markdown").insert(0, "# Page\n\nSaved body")
  const document = { page: { id: 42, slug, title: "Page", body: doc.getText("markdown").toString(), revision: 1,
    author: { id: 1, login: "owner" }, created_at: "2026-09-08T00:00:00Z", updated_at: "2026-09-08T00:00:00Z" },
    state: encodeWikiState(Y.encodeStateAsUpdate(doc)), state_vector: encodeWikiState(Y.encodeStateVector(doc)) }
  doc.destroy()
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const reads: string[] = [], mutations: string[] = []
  const controller = createAppController(store, unavailableAgent, { fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url, "https://app.test").pathname, method = init?.method ?? "GET"
    if (method !== "GET") mutations.push(`${method} ${path}`)
    else reads.push(path)
    if (path === `${target}/stream`) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
    return Response.json(path === `${target}/document` ? document : { message: "Inventory unavailable" }, { status: path === `${target}/document` ? 200 : 503 })
  } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", admin: false, scopesPlain: null })
  expect(store.collections.repositories.size).toBe(0)
  const args = `${slug} ${repo}`
  if (door === "form") {
    await controller.commands.run("wiki.cloud.open", "")
    await controller.commands.run("form.set", `form-wiki.cloud.open slug ${slug}`)
    await controller.commands.run("form.set", `form-wiki.cloud.open repo ${repo}`)
    await controller.commands.run("form.submit", "form-wiki.cloud.open")
  } else if (door === "agent") {
    await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "wiki.cloud.open", args }) })
  } else {
    await controller.commands.run("wiki.cloud.open", door === "button" ? flowArgs("wiki.cloud.open", { slug, repo }) : args)
  }
  expect(reads).toContain(`${target}/document`)
  expect(store.collections.worldDocuments.get(id)).toMatchObject({ body: document.page.body, cloud: { repo, slug, remoteRevision: 1 } })
  expect(store.collections.cards.get(`wiki-open-${id}`)).toMatchObject({ kind: "world" })
  const form = store.collections.cards.get("form-wiki.cloud.open")
  expect(form === undefined || form.status === "acted").toBe(true)
  expect(mutations).toEqual([])
})
