import { expect, test } from "bun:test"
import * as Y from "yjs"
import { encodeWikiState, wikiDocumentId } from "../../wiki/CloudWiki"
import type { CloudWikiIndex, WikiSpace } from "../../wiki/CloudWiki"
import { createAppStore } from "../AppStore"
import { createAppController } from "../AppController"
import { memoryStorage, settle, silentAgent, waitFor } from "../TestFixtures"
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

/** The production actor pair, with an index held before automatic page selection. */
const actorHarness = async (seedPages = true) => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const documentEntered = Promise.withResolvers<void>(), documentRelease = Promise.withResolvers<void>()
  let holdHome = false, homeHeld = false
  const requests: string[] = []
  const home = document(1, "home", "public"), start = document(2, "start", "public")
  const attachmentId = wikiDocumentId(repo, 3)
  let first: "home" | "attachment" | undefined
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    requests.push(url.pathname + url.search)
    if (url.pathname.endsWith("/navigation/index")) {
      const held = first
      if (held !== undefined) { entered.resolve(); await release.promise }
      const pages: CloudWikiIndex["pages"] = [home.page, start.page].map(page => ({ ...page,
        metadata: { tags: [], aliases: [], headings: [], links: [] }, backlinks: [] }))
      if (held === "attachment") pages.unshift({ ...home.page, id: 3, slug: "logo", title: "logo.png", path: "assets/logo.png",
        content_digest: "a".repeat(64), attachment: { digest: "a".repeat(64), media_type: "image/png", size: 3 },
        metadata: { tags: [], aliases: [], headings: [], links: [] }, backlinks: [] })
      return Response.json({ pages, folders: ["Guides", "assets"], tags: held === undefined ? [] : ["held-index"] })
    }
    if (url.pathname.endsWith("/stream")) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")) }
    }), { headers: { "content-type": "text/event-stream" } })
    const page = [home, start].find(row => url.pathname.endsWith(`/wiki/${row.page.slug}/document`))
    if (page === home && holdHome && !homeHeld) { homeHeld = true; documentEntered.resolve(); await documentRelease.promise }
    return page === undefined ? Response.json({ message: "No page" }, { status: 404 }) : Response.json(page)
  } })
  let controller: ReturnType<typeof createAppController> | undefined
  let ownedStore: Awaited<ReturnType<typeof createAppStore>> | undefined
  try {
    const store = ownedStore = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "alice", name: "project", ownerKind: "user", head: null }] }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
    await store.dispatch({ type: "surface.changed", actor: "user", surface: "world" }).isPersisted.promise
    controller = createAppController(store, silentAgent, { baseUrl: server.url.toString().replace(/\/$/, ""), fetchImpl: Bun.fetch })
    if (seedPages) {
      await controller.openCloudWiki(repo, "home", 1)
      await controller.openCloudWiki(repo, "start", 2)
    }
    const app = controller
    return { store, controller: app, requests, entered, release, documentEntered, documentRelease, attachmentId,
      holdHome() { holdHome = true },
      hold(kind: "home" | "attachment") { first = kind },
      async indexPublished() { await waitFor(() => app.wikiIndexes.get(repo, "public")?.tags.includes("held-index") === true) },
      async close() { release.resolve(); documentRelease.resolve(); try { await app.dispose() } finally { await server.stop(true) } }
    }
  } catch (error) {
    release.resolve(); documentRelease.resolve()
    try { if (controller === undefined) await ownedStore?.dispose?.(); else await controller.dispose() }
    finally { await server.stop(true) }
    throw error
  }
}

test("a user selection during a held real HTTP index prevents the stale automatic Home request", async () => {
  const t = await actorHarness()
  try {
    t.controller.selectWorldDocument(homeId)
    const homeReads = t.requests.filter(path => path.includes("/wiki/home/document?")).length
    t.hold("home")
    await t.controller.setWikiSpace("public")
    await t.entered.promise
    expect(t.controller.selectWorldDocument(startId)).toBeUndefined()
    t.release.resolve()
    await t.indexPublished()
    await settle()
    expect(t.store.session().selectedWorldDocumentId).toBe(startId)
    expect(t.requests.filter(path => path.includes("/wiki/home/document?")).length).toBe(homeReads)
  } finally { await t.close() }
})

for (const selection of ["different-page", "same-page"] as const) {
  test(`a paired agent's held real HTTP index cannot replace the user's ${selection} selection`, async () => {
    const t = await actorHarness()
    try {
      if (selection === "different-page") t.controller.selectWorldDocument(homeId)
      t.hold("attachment")
      await t.controller.commands.runForAgent("wiki.space", "public")
      await t.entered.promise
      expect(t.controller.selectWorldDocument(startId)).toBeUndefined()
      expect(t.store.session().selectedWorldDocumentId).toBe(startId)
      t.release.resolve()
      await t.indexPublished()
      await settle()
      expect(t.controller.wikiIndexes.get(repo, "public")?.pages[0]?.id).toBe(3)
      expect(t.store.session().selectedWorldDocumentId).toBe(startId)
    } finally { await t.close() }
  })
}

for (const otherStoreSelection of [false, true]) {
  test(`a paired agent still automatically selects its attachment with ${otherStoreSelection ? "a selection in an independent store" : "no newer user selection"}`, async () => {
    const t = await actorHarness()
    let other: Awaited<ReturnType<typeof actorHarness>> | undefined
    try {
      t.hold("attachment")
      await t.controller.commands.runForAgent("wiki.space", "public")
      await t.entered.promise
      if (otherStoreSelection) {
        other = await actorHarness()
        expect(other.controller.selectWorldDocument(startId)).toBeUndefined()
      }
      t.release.resolve()
      await t.indexPublished()
      await waitFor(() => t.store.session().selectedWorldDocumentId === t.attachmentId)
      expect(t.store.session().selectedWorldDocumentId).toBe(t.attachmentId)
      expect(t.requests.filter(path => path.includes("/wiki/logo/document?")).length).toBe(0)
      if (other !== undefined) expect(other.store.session().selectedWorldDocumentId).toBe(startId)
    } finally { try { await other?.close() } finally { await t.close() } }
  })
}


test("a same-space paired agent automatic Markdown read populates the pane while the older user read is held", async () => {
  const t = await actorHarness(false)
  try {
    t.holdHome()
    await t.controller.setWikiSpace("public")
    await t.documentEntered.promise
    expect(t.store.session().selectedWorldDocumentId).toBeNull()
    await t.controller.commands.runForAgent("wiki.space", "public")
    await waitFor(() => t.store.session().selectedWorldDocumentId === homeId ||
      t.store.collections.cards.get(`wiki-open-${homeId}`)?.kind === "world")
    expect(t.store.collections.worldDocuments.get(homeId)?.cloud?.phase).toBe("live")
    expect(t.store.session().selectedWorldDocumentId).toBe(homeId)
    expect(t.store.collections.cards.get(`wiki-open-${homeId}`)).toBeUndefined()
    t.documentRelease.resolve()
    await settle()
    expect(t.store.session().selectedWorldDocumentId).toBe(homeId)
  } finally { await t.close() }
})

test("an explicit paired agent Wiki open embeds without retiring the held automatic user pane read", async () => {
  const t = await actorHarness(false)
  try {
    t.holdHome()
    await t.controller.setWikiSpace("public")
    await t.documentEntered.promise
    expect(t.store.session().selectedWorldDocumentId).toBeNull()
    await t.controller.commands.runForAgent("wiki.cloud.open", `start ${repo}`)
    expect(t.store.collections.cards.get(`wiki-open-${startId}`)?.kind).toBe("world")
    expect(t.store.session().selectedWorldDocumentId).toBeNull()
    t.documentRelease.resolve()
    await waitFor(() => t.store.session().selectedWorldDocumentId === homeId)
    expect(t.store.session().selectedWorldDocumentId).toBe(homeId)
  } finally { await t.close() }
})
