import { expect, test } from "bun:test"
import * as Y from "yjs"
import { encodeWikiState, wikiDocumentId } from "../../wiki/CloudWiki"
import type { WikiSpace } from "../../wiki/CloudWiki"
import { createAppStore } from "../AppStore"
import { memoryStorage, silentAgent, waitFor } from "../TestFixtures"
import { createCloudWikiController } from "./cloud-wiki"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createWorldController } from "./world"

const repo = "alice/project"
const homeId = wikiDocumentId(repo, 1), startId = wikiDocumentId(repo, 2), privateId = wikiDocumentId(repo, 9)

const document = (id: number, slug: string, space: WikiSpace) => {
  const doc = new Y.Doc()
  const title = slug === "home" ? "Home" : "Start"
  doc.getText("markdown").insert(0, `# ${title}\n\n${space} page`)
  try {
    return {
      page: { id, slug, title, path: slug === "home" ? "Home.md" : "Guides/Start.md", body: doc.getText("markdown").toString(),
        revision: 1, author: { id: 1, login: "alice" }, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", visibility: space },
      state: encodeWikiState(Y.encodeStateAsUpdate(doc)), state_vector: encodeWikiState(Y.encodeStateVector(doc))
    }
  } finally { doc.destroy() }
}

const harness = async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let holdHome = false
  const requests: string[] = []
  const pages = { public: [document(1, "home", "public"), document(2, "start", "public")], private: [document(9, "home", "private")] }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    requests.push(url.pathname + url.search)
    const space = url.searchParams.get("visibility")
    if (space !== "public" && space !== "private") return Response.json({ message: "Missing space" }, { status: 400 })
    if (url.pathname.endsWith("/navigation/index")) return Response.json({
      pages: pages[space].map(({ page }) => ({ ...page, metadata: { tags: [], aliases: [], headings: [], links: [] }, backlinks: [] })),
      folders: space === "public" ? ["Guides"] : [], tags: []
    })
    if (url.pathname.endsWith("/stream")) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")) }
    }), { headers: { "content-type": "text/event-stream" } })
    const page = pages[space].find(row => url.pathname.endsWith(`/wiki/${row.page.slug}/document`))
    if (page === undefined) return Response.json({ message: "No page" }, { status: 404 })
    if (holdHome && space === "public" && page.page.slug === "home") { entered.resolve(); await release.promise }
    return Response.json(page)
  } })
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "alice", name: "project", ownerKind: "user", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
  await store.dispatch({ type: "surface.changed", actor: "user", surface: "world" }).isPersisted.promise
  const ctx = createControllerContext(store, silentAgent, { baseUrl: server.url.toString().replace(/\/$/, ""), fetchImpl: Bun.fetch })
  ctx.onDispose(store.dispose!)
  const failures = createFailureController(ctx)
  ctx.withToast = failures.withToast
  ctx.resolveToast = failures.resolveToast
  const wiki = createCloudWikiController(ctx, store.nextOrdinal)
  const world = createWorldController(ctx, { nextOrdinal: store.nextOrdinal, cloudWiki: wiki })
  await wiki.openCloudWiki(repo, "home", 1)
  await wiki.openCloudWiki(repo, "start", 2)
  return { store, ctx, wiki, world, entered, release, requests,
    begin() { holdHome = true; return wiki.readWikiForPane() },
    beginExplicit() { holdHome = true; return wiki.openCloudWiki(repo, "home", 1) },
    async close() { release.resolve(); await ctx.dispose(); await server.stop(true) }
  }
}

for (const selection of ["cached", "same-page", "start-home-start", "explicit-open"] as const) {
  test(`newer ${selection} selection survives a held automatic real HTTP Home read`, async () => {
    const t = await harness()
    if (selection === "cached") t.world.selectWorldDocument(homeId)
    const pending = t.begin()
    try {
      await t.entered.promise
      if (selection === "explicit-open") expect(await t.wiki.openCloudWiki(repo, "start", 2)).toEqual({ value: expect.stringContaining("Opened") })
      else {
        if (selection === "start-home-start") t.world.selectWorldDocument(homeId)
        expect(t.world.selectWorldDocument(startId)).toBeUndefined()
      }
      expect(t.store.session().selectedWorldDocumentId).toBe(startId)
      t.release.resolve()
      await pending
      expect(t.store.session().selectedWorldDocumentId).toBe(startId)
    } finally { t.release.resolve(); await pending; await t.close() }
  })
}

for (const selection of ["manual", "explicit-open"] as const) {
  test(`newer ${selection} selection survives an older explicit real HTTP Home read`, async () => {
    const t = await harness(), pending = t.beginExplicit()
    try {
      await t.entered.promise
      if (selection === "manual") expect(t.world.selectWorldDocument(startId)).toBeUndefined()
      else expect(await t.wiki.openCloudWiki(repo, "start", 2)).toEqual({ value: expect.stringContaining("Opened") })
      t.release.resolve()
      await pending
      expect(t.store.session().selectedWorldDocumentId).toBe(startId)
    } finally { t.release.resolve(); await pending; await t.close() }
  })
}

test("ordinary automatic opening still selects Home after the real HTTP read completes", async () => {
  const t = await harness(), pending = t.begin()
  try {
    await t.entered.promise
    expect(t.store.session().selectedWorldDocumentId).toBe(startId)
    t.release.resolve()
    await pending
    expect(t.store.session().selectedWorldDocumentId).toBe(homeId)
  } finally { t.release.resolve(); await pending; await t.close() }
})

test("invalid manual selection leaves the automatic page read current", async () => {
  const t = await harness(), pending = t.begin()
  try {
    await t.entered.promise
    expect(t.world.selectWorldDocument("missing")).toContain("There is no")
    expect(await t.wiki.openCloudWiki(repo, "invalid/slug")).toContain("without spaces or slashes")
    t.release.resolve()
    await pending
    expect(t.store.session().selectedWorldDocumentId).toBe(homeId)
  } finally { t.release.resolve(); await pending; await t.close() }
})

test("changing the space retires the automatic public completion", async () => {
  const t = await harness(), pending = t.begin()
  try {
    await t.entered.promise
    await t.wiki.setWikiSpace("private")
    await waitFor(() => t.store.session().selectedWorldDocumentId === privateId)
    t.release.resolve()
    await pending
    expect(t.store.session().wikiSpace).toBe("private")
    expect(t.store.session().selectedWorldDocumentId).toBe(privateId)
  } finally { t.release.resolve(); await pending; await t.close() }
})

test("an embedded agent page read does not supersede the automatic user pane read", async () => {
  const t = await harness(), pending = t.begin()
  try {
    await t.entered.promise
    t.ctx.commandActor = "smithers"
    expect(await t.wiki.openCloudWiki(repo, "start", 2)).toEqual({ value: expect.stringContaining("Embedded") })
    expect(t.store.collections.cards.get(`wiki-open-${startId}`)?.kind).toBe("world")
    t.release.resolve()
    await pending
    expect(t.store.session().selectedWorldDocumentId).toBe(homeId)
  } finally { t.release.resolve(); await pending; await t.close() }
})
