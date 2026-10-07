import { restoreRecordedBranch } from "../RecordedBranch.fixture"
import { scopedControllers } from "../ControllerTestScope"
import { silentAgent } from "../TestFixtures"
import type { AppServices } from "../AppController"
import { enforceSchemaVersion } from "../../chain/SchemaVersion"
import { ENVELOPE_STORAGE_KEY } from "../../chain/TransactionalStorage"
import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, test } from "bun:test"
import * as Y from "yjs"
import { editWikiState, encodeWikiState, wikiDocumentId } from "../../wiki/CloudWiki"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createCloudWikiController } from "./cloud-wiki"
import { createControllerContext } from "./context"
import { createFramesController } from "./frames"

const createAppController = scopedControllers()
const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach((close) => close())
})
const repo = "owner/repo"
const id = wikiDocumentId(repo, 42)
const memory = (): StorageApi => {
  const rows = new Map<string, string>()
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => {
      rows.set(key, value)
    },
    removeItem: (key) => {
      rows.delete(key)
    }
  }
}
const signIn = (store: AppStore, login = "will") =>
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login,
    admin: false,
    scopesPlain: null
  }).isPersisted.promise
const until = async (predicate: () => boolean) => {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Wiki state did not settle")
}

const fixture = async (storage = memory()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await signIn(store)
  const doc = new Y.Doc()
  doc.getText("markdown").insert(0, "# Page\n\nStart")
  let revision = 1
  const slug = "home"
  let pageId = 42
  const posts: string[] = []
  const patches: unknown[] = []
  const bootstrap = () => ({
    page: {
      id: pageId,
      slug,
      title: "Page",
      body: doc.getText("markdown").toString(),
      revision,
      author: { id: 1, login: "will" },
      created_at: "2026-09-08T00:00:00Z",
      updated_at: "2026-09-08T00:00:00Z"
    },
    state: encodeWikiState(Y.encodeStateAsUpdate(doc)),
    state_vector: encodeWikiState(Y.encodeStateVector(doc))
  })
  const connect = (store: AppStore) => {
    const services: AppServices = {
      fetchImpl: async (input, init) => {
        const url = String(input)
        // Every wiki request carries its space (#1922); the fixture answers by route, not by the query.
        if (!/[?&]visibility=(public|private)(&|$)/.test(url)) throw new Error(`Wiki request without a space: ${url}`)
        const path = url.split("?")[0]!
        if (/\/(updates|stream)$/.test(path)) {
          posts.push(path)
          return new Response(null, { status: 404 })
        }
        if (init?.method === "PATCH") {
          const input = JSON.parse(String(init.body))
          patches.push(input)
          if (input.expected_revision !== revision) return Response.json({ message: "Wiki page changed", code: "conflict" }, { status: 409 })
          doc.transact(() => { const text = doc.getText("markdown"); text.delete(0, text.length); text.insert(0, input.body) })
          revision++
          return Response.json(bootstrap().page)
        }
        if (path.endsWith("/document")) return Response.json(bootstrap())
        throw new Error(`Unexpected Wiki request ${url}`)
      }
    }
    const ctx = createControllerContext(store, silentAgent, services)
    // Forking announces itself through the toast law; a bare context has no failure controller.
    ctx.resolveToast = (key, outcome) => {
      store.dispatch({ type: "toast.resolved", actor: "system", key, ...outcome })
    }
    const wiki = createCloudWikiController(ctx, () => 1)
    cleanup.push(() => {
      ctx.dispose()
    })
    return { ctx, wiki, services }
  }
  const { ctx, wiki, services } = connect(store)
  cleanup.push(() => doc.destroy())
  return {
    store,
    storage,
    ctx,
    wiki,
    posts,
    patches,
    advance: () => { revision++ },
    services,
    bootstrap,
    doc,
    reopen: async () => {
      ctx.dispose()
      const reopened = await createAppStore({ kind: "localStorage", storage })
      return { store: reopened, ...connect(reopened) }
    },
    replace: () => {
      pageId = 43
    }
  }
}

const commandsFor = (f: Awaited<ReturnType<typeof fixture>>) => {
  const admissions: Array<ReturnType<typeof Promise.withResolvers<void>>> = []
  const controller = createAppController({ ...f.store, dispatch: transition => {
    const receipt = f.store.dispatch(transition)
    if (transition.type !== "command.intent.accepted" || transition.name !== "wiki.edit") return receipt
    const held = Promise.withResolvers<void>()
    admissions.push(held)
    return new Proxy(receipt, { get: (target, key, receiver) => key === "isPersisted"
    ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held.promise) }
    : Reflect.get(target, key, receiver) })
  } }, silentAgent, f.services)
  return { controller, admissions }
}

test("Save to wiki persists before launch, acknowledges a held write once and recovers a lost acknowledgement", async () => {
  const storage = memory(), store = await createAppStore({ kind: "localStorage", storage })
  await signIn(store)
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", name: "repo", ownerKind: "user", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
  const markdown = "Use `redeliver` in [retry.ts](src/webhooks/retry.ts).\n\nKeep the retry bounded."
  const held = Promise.withResolvers<Response>()
  const writes: Array<{ title: string; body: string; slug: string; path: string }> = []
  let persisted: typeof writes[number] | undefined
  const settlements: unknown[] = []
  const page = () => ({ id: 42, slug: persisted!.slug, title: "Retry", path: "Retry.md", revision: 1,
    author: { id: 1, login: "will" }, created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" })
  const services: AppServices = { fetchImpl: async (input, init) => {
    const path = new URL(String(input), "http://test").pathname
    if (init?.method === "POST" && path.endsWith("/wiki")) {
      writes.push(JSON.parse(String(init.body)))
      expect(store.session().wikiSaves?.[0]?.state).toBe("requested")
      if (writes.length === 1) return held.promise
      return Response.json({ message: "wiki page already exists" }, { status: 409 })
    }
    if (path.endsWith("/document")) {
      const doc = new Y.Doc(); doc.getText("markdown").insert(0, persisted!.body)
      return Response.json({ page: { ...page(), body: persisted!.body }, state: encodeWikiState(Y.encodeStateAsUpdate(doc)), state_vector: encodeWikiState(Y.encodeStateVector(doc)) })
    }
    if (path.endsWith("/navigation/index")) return Response.json({ pages: [], folders: [], tags: [] })
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")) } }), { headers: { "content-type": "text/event-stream" } })
  } }
  const connect = (appStore: AppStore) => {
    const ctx = createControllerContext(appStore, silentAgent, services)
    ctx.withToast = async (_key, _title, _done, work) => { const result = await work(); settlements.push(result); return result }
    ctx.resolveToast = () => {}
    cleanup.push(() => ctx.dispose())
    return { ctx, wiki: createCloudWikiController(ctx, () => 1) }
  }
  const first = connect(store)
  expect(await first.wiki.saveWikiAnswer("Retry", markdown)).toEqual({ value: "Requested" })
  expect(await first.wiki.saveWikiAnswer("Retry", markdown)).toEqual({ value: "Requested" })
  await until(() => writes.length === 1)
  expect(settlements).toEqual([])
  expect(writes[0]).toMatchObject({ title: "Retry", body: markdown, path: "Retry.md" })
  persisted = writes[0]
  // The server writes the page but this browser loses its acknowledgement.
  first.ctx.dispose()
  held.resolve(Response.json(page()))
  const reopened = await createAppStore({ kind: "localStorage", storage })
  const second = connect(reopened)
  await until(() => reopened.session().wikiSaves?.[0]?.state === "completed")
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  expect(await second.wiki.saveWikiAnswer("Retry", markdown)).toEqual({ value: "Saved" })
  expect(writes).toHaveLength(2)
  expect(reopened.collections.worldDocuments.get(id)?.body).toBe(markdown)
})

for (const staleResult of ["success", "lost acknowledgement"] as const) {
  test(`Save to wiki resumes only for its author and ignores an old ${staleResult}`, async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memory() })
    await signIn(store)
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", name: "repo", ownerKind: "user", head: null }] }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
    const held = Promise.withResolvers<Response>()
    const markdown = "Keep this answer after changing accounts."
    const writes: Array<{ title: string; body: string; slug: string; path: string }> = []
    const page = () => ({ id: 42, slug: writes[0]!.slug, title: "Recovery", path: "Recovery.md", revision: 1,
      author: { id: 1, login: "will" }, created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" })
    const ctx = createControllerContext(store, silentAgent, { fetchImpl: async (input, init) => {
      const path = new URL(String(input), "http://test").pathname
      if (init?.method === "POST" && path.endsWith("/wiki")) {
        writes.push(JSON.parse(String(init.body)))
        if (writes.length === 1) return held.promise
        return Response.json({ message: "wiki page already exists" }, { status: 409 })
      }
      if (path.endsWith("/document")) {
        const doc = new Y.Doc(); doc.getText("markdown").insert(0, markdown)
        return Response.json({ page: { ...page(), body: markdown }, state: encodeWikiState(Y.encodeStateAsUpdate(doc)), state_vector: encodeWikiState(Y.encodeStateVector(doc)) })
      }
      if (path.endsWith("/navigation/index")) return Response.json({ pages: [], folders: [], tags: [] })
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")) } }), { headers: { "content-type": "text/event-stream" } })
    } })
    // Isolate notification rendering, retaining the real store, controller,
    // account generation and HTTP transport/recovery behavior.
    ctx.withToast = async (_key, _title, _done, work) => work()
    ctx.resolveToast = () => {}
    cleanup.push(() => ctx.dispose())
    const wiki = createCloudWikiController(ctx, () => 1)
    expect(await wiki.saveWikiAnswer("Recovery", markdown)).toEqual({ value: "Requested" })
    await until(() => writes.length === 1)
    await signIn(store, "alice")
    await store.settled?.()
    expect(writes).toHaveLength(1)
    expect(store.collections.worldDocuments.get(id)).toBeUndefined()
    await signIn(store, "will")
    await store.settled?.()
    // Account cancellation releases the old attempt even if fetch ignores its
    // abort signal. Returning to the author recovers by the original page id.
    await until(() => store.session().wikiSaves?.[0]?.state === "completed")
    await until(() => store.collections.worldDocuments.get(id)?.body === markdown)
    expect(writes).toHaveLength(2)
    if (staleResult === "success") held.resolve(Response.json(page()))
    else held.reject(new Error("The server saved the page but the response was lost"))
    await new Promise(resolve => setTimeout(resolve, 0))
    await store.settled?.()
    expect(store.session().wikiSaves?.[0]?.state).toBe("completed")
    expect(store.collections.worldDocuments.get(id)?.body).toBe(markdown)
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    // Sign-in reloads repository discovery before another explicit command.
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", name: "repo", ownerKind: "user", head: null }] }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
    expect(await wiki.saveWikiAnswer("Recovery", markdown)).toEqual({ value: "Saved" })
    expect(writes).toHaveLength(2)
  })
}

describe("Wiki live transport admission", () => {
  test("the S2 edit door waits for admission and uses the displayed revision", async () => {
    const f = await fixture()
    const { controller, admissions } = commandsFor(f)
    cleanup.push(() => controller.dispose())
    await controller.openCloudWiki(repo, "home")
    const before = f.store.collections.worldDocuments.get(id)!.body
    const command = controller.commands.run("wiki.edit", `${id} ${JSON.stringify("# App decision")}`)
    await f.store.settled?.()
    expect(f.store.collections.worldDocuments.get(id)!.body).toBe(before)
    expect(f.patches).toEqual([])
    admissions[0]!.resolve()
    await command
    expect(f.patches).toEqual([{ body: "# App decision", expected_revision: 1 }])
    expect(f.store.collections.worldDocuments.get(id)!.body).toBe("# App decision")
    expect(f.store.collections.worldDocuments.get(id)!.cloud?.remoteRevision).toBe(2)
    expect(f.posts).toEqual([])
  })

  test("a stale S2 edit preserves the displayed page", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    const before = f.store.collections.worldDocuments.get(id)!.body
    f.advance()
    expect(await f.wiki.editCloudWiki(id, "# stale")).toBe("Wiki page changed")
    expect(f.store.collections.worldDocuments.get(id)!.body).toBe(before)
    expect(f.patches).toEqual([{ body: "# stale", expected_revision: 1 }])
    expect(f.posts).toEqual([])
  })

  test.each(["retained", "deleted", "account", "branch"])("S2 refuses a %s document without replacing it", async kind => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    const row = f.store.collections.worldDocuments.get(id)!
    await f.store.dispatch({ type: "world.document.upserted", actor: "system", document: { ...row, cloud: { ...row.cloud!,
      ...(kind === "retained" ? { pending: [{ updateId: "00000000-0000-4000-8000-000000000001", update: "", actor: "user" as const, admitted: false }] } : {}),
      ...(kind === "deleted" ? { phase: "deleted" as const } : {}),
      ...(kind === "account" ? { accountLogin: "other" } : {}),
      ...(kind === "branch" ? { branchId: "other" } : {})
    } } }).isPersisted.promise
    expect(await f.wiki.editCloudWiki(id, "# replacement")).toBe("Refresh this Wiki page before editing it. Its recorded text has been preserved.")
    expect(f.store.collections.worldDocuments.get(id)!.body).toBe(row.body)
    expect(f.patches).toEqual([])
  })

  test("opening and refreshing never acknowledge retained edits, including after reload", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    const row = f.store.collections.worldDocuments.get(id)!
    const edit = editWikiState(row.cloud!.state, "# Page\n\nRetained", 101)
    await f.store.dispatch({ type: "world.document.upserted", actor: "user", select: false,
      document: { ...row, body: "# Page\n\nRetained", cloud: { ...row.cloud!, state: edit.state,
        pending: [{ updateId: "00000000-0000-4000-8000-000000000001", update: edit.update, actor: "user", admitted: false }] } }
    }).isPersisted.promise
    const bytes = f.storage.getItem(ENVELOPE_STORAGE_KEY)
    expect(() => enforceSchemaVersion(f.storage, { version: 14 })).toThrow("cannot be opened")
    expect(f.storage.getItem(ENVELOPE_STORAGE_KEY)).toBe(bytes)
    await f.wiki.retryCloudWiki(id)
    expect(f.store.collections.worldDocuments.get(id)!.cloud!.pending).toHaveLength(1)
    const reopened = await f.reopen()
    await reopened.wiki.openCloudWiki(repo, "home")
    expect(reopened.store.collections.worldDocuments.get(id)!.body).toBe("# Page\n\nRetained")
    expect(reopened.store.collections.worldDocuments.get(id)!.cloud!.pending).toHaveLength(1)
    expect(f.posts).toHaveLength(0)
  })

  test("slug reuse fences the old page and retains its stored document", async () => {
    const f = await fixture()
    await f.wiki.openCloudWiki(repo, "home")
    f.replace()
    expect(await f.wiki.retryCloudWiki(id)).toContain("different page")
    expect(f.store.collections.worldDocuments.get(id)!.cloud!.phase).toBe("deleted")
    expect(f.store.collections.worldDocuments.get(wikiDocumentId(repo, 43))).toBeUndefined()
    expect(f.posts).toHaveLength(0)
  })
})

describe("wiki spaces", () => {
  const space = async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memory() })
    await signIn(store)
    const requests: Array<{ method: string; url: string; body?: string; type?: string }> = []
    const pages: Record<"public" | "private", Array<Record<string, unknown>>> = {
      public: [{ id: 1, slug: "home", title: "Home", path: "Home.md", revision: 3, updated_at: "2026-09-26T00:00:00Z", author: { id: 1, login: "will" }, created_at: "2026-09-26T00:00:00Z", visibility: "public", content_digest: "a".repeat(64), metadata: { frontmatter: null, aliases: [], tags: ["guide"], headings: ["Home"], links: [{ target: "Guides/Start", embed: false, page_id: 2 }, { target: "Nowhere", embed: false }] }, backlinks: [{ page_id: 2, path: "Guides/Start.md", embed: false }] },
        { id: 2, slug: "start", title: "Start", path: "Guides/Start.md", revision: 1, updated_at: "2026-09-26T00:00:00Z", author: { id: 1, login: "will" }, created_at: "2026-09-26T00:00:00Z", visibility: "public", content_digest: "b".repeat(64), metadata: { frontmatter: null, aliases: [], tags: [], headings: ["Start"], links: [] }, backlinks: [] },
        { id: 3, slug: "logo", title: "logo.png", path: "assets/logo.png", revision: 1, updated_at: "2026-09-26T00:00:00Z", author: { id: 1, login: "will" }, created_at: "2026-09-26T00:00:00Z", visibility: "public", content_digest: "c".repeat(64), attachment: { digest: "c".repeat(64), media_type: "image/png", size: 3 }, metadata: { frontmatter: null, aliases: [], tags: [], headings: [], links: [] }, backlinks: [] }],
      private: [{ id: 9, slug: "home", title: "Home", path: "Home.md", revision: 1, updated_at: "2026-09-26T00:00:00Z", author: { id: 1, login: "will" }, created_at: "2026-09-26T00:00:00Z", visibility: "private", content_digest: "d".repeat(64), metadata: { frontmatter: null, aliases: [], tags: ["secret"], headings: ["Home"], links: [] }, backlinks: [] }]
    }
    let renameStatus = 200
    let privateIndexRefusal: string | undefined
    const services: AppServices = {
      fetchImpl: async (input, init) => {
        const url = String(input)
        const match = /[?&]visibility=(public|private)(&|$)/.exec(url)
        if (match === null) throw new Error(`Wiki request without a space: ${url}`)
        const at = match[1] as "public" | "private"
        const path = url.split("?")[0]!
        requests.push({ method: init?.method ?? "GET", url, ...(init?.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : "<bytes>" }), ...(new Headers(init?.headers).get("content-type") === null ? {} : { type: new Headers(init?.headers).get("content-type")! }) })
        if (path.endsWith("/navigation/index") && at === "private" && privateIndexRefusal !== undefined) {
          return Response.json({ code: privateIndexRefusal, message: "the private wiki needs repository access" }, { status: 403 })
        }
        if (path.endsWith("/navigation/index")) return Response.json({ pages: pages[at], folders: [...new Set(pages[at].flatMap((page) => String(page.path).includes("/") ? [String(page.path).split("/")[0]] : []))], tags: [...new Set(pages[at].flatMap((page) => (page.metadata as { tags: string[] }).tags))] })
        if (/\/history\/\d+$/.test(path)) return Response.json([
          { page_id: 1, revision: 3, path: "Home.md", title: "Home", content_digest: "a".repeat(64), deleted: false, author: { id: 1, login: "will" }, updated_at: "2026-09-26T03:00:00Z" },
          { page_id: 1, revision: 2, path: "Old/Home.md", title: "Home", content_digest: "e".repeat(64), deleted: false, author: { id: 2, login: "ada" }, updated_at: "2026-09-26T02:00:00Z" }
        ])
        if (init?.method === "POST" && path.endsWith("/wiki")) {
          const body = JSON.parse(String(init.body)) as { title: string }
          const created = { id: 20, slug: "notes", title: body.title, path: "Notes.md", revision: 1, updated_at: "2026-09-26T00:00:00Z", created_at: "2026-09-26T00:00:00Z", author: { id: 1, login: "will" }, visibility: at, content_digest: "f".repeat(64), metadata: { frontmatter: null, aliases: [], tags: [], headings: [], links: [] }, backlinks: [] }
          pages[at].push(created)
          return Response.json(created)
        }
        if (init?.method === "PATCH") return renameStatus === 200
          ? Response.json({ id: 1, slug: "home", title: "Home", path: JSON.parse(String(init.body)).path, revision: 4, updated_at: "2026-09-26T00:00:00Z", created_at: "2026-09-26T00:00:00Z", author: { id: 1, login: "will" }, visibility: at, content_digest: "a".repeat(64) })
          : Response.json({ message: "revision 3 is not current" }, { status: 409 })
        if (init?.method === "DELETE") return new Response(null, { status: 204 })
        if (init?.method === "PUT") return Response.json({ id: 30, slug: "home-diagram-png", title: "diagram.png", path: "assets/diagram.png", revision: 1, updated_at: "2026-09-26T00:00:00Z", created_at: "2026-09-26T00:00:00Z", author: { id: 1, login: "will" }, visibility: at, content_digest: "9".repeat(64), attachment: { digest: "9".repeat(64), media_type: "image/png", size: 3 } })
        if (path.endsWith("/document")) {
          const page = pages[at].find((row) => String(path).endsWith(`/wiki/${row.slug}/document`)) ?? pages[at][0]!
          const doc = new Y.Doc(); doc.getText("markdown").insert(0, page.slug === "notes" ? "# Notes\n\n" : at === "public" ? "# Home\n\n[[Guides/Start]]" : "# Home\n\nPrivate")
          return Response.json({ page: { ...page, body: doc.getText("markdown").toString() }, state: encodeWikiState(Y.encodeStateAsUpdate(doc)), state_vector: encodeWikiState(Y.encodeStateVector(doc)) })
        }
        if (url.includes("/stream?")) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")) } }), { headers: { "content-type": "text/event-stream" } })
        throw new Error(`Unexpected Wiki request ${url}`)
      }
    }
    const ctx = createControllerContext(store, silentAgent, services)
    const toasts: Array<{ key: string; title: string; done: string; outcome: unknown }> = []
    ctx.withToast = async (key, title, done, work) => { const outcome = await work(); toasts.push({ key, title, done, outcome }); return outcome }
    ctx.resolveToast = () => {}
    const wiki = createCloudWikiController(ctx, () => 1)
    cleanup.push(() => ctx.dispose())
    return {
      store, ctx, wiki, requests, toasts,
      refuseRename: () => { renameStatus = 409 },
      refusePrivateIndex: (code: string) => { privateIndexRefusal = code }
    }
  }

  test.each(["wiki_space_unreadable", "forbidden"])("a refused private index keeps the server's %s code on its row", async (code) => {
    const f = await space()
    f.refusePrivateIndex(code)
    expect(await f.wiki.setWikiSpace("private", repo)).toBeUndefined()
    await until(() => f.wiki.wikiIndexes.get("owner/repo", "private") !== undefined)
    expect(f.wiki.wikiIndexes.get("owner/repo", "private")).toMatchObject({ pages: [], errorCode: code })
    expect(f.wiki.wikiIndexes.get("owner/repo", "private")!.error).toBeTruthy()
  })

  test("the index of each space lands in its own row, and switching the space re-reads it", async () => {
    const f = await space()
    expect(await f.wiki.loadWikiIndex(repo)).toEqual({ value: expect.stringContaining("3 public Wiki pages in owner/repo: Home.md, Guides/Start.md, assets/logo.png") })
    const publicRow = f.wiki.wikiIndexes.get("owner/repo", "public")!
    expect(publicRow.folders).toEqual(["Guides", "assets"])
    expect(publicRow.tags).toEqual(["guide"])
    expect(publicRow.pages[0]).toMatchObject({ id: 1, path: "Home.md", tags: ["guide"], backlinks: [{ pageId: 2, path: "Guides/Start.md", embed: false }], links: [{ target: "Guides/Start", pageId: 2, embed: false }, { target: "Nowhere", embed: false }] })
    expect(publicRow.pages[2]).toMatchObject({ attachment: { mediaType: "image/png", size: 3 } })
    expect(await f.wiki.setWikiSpace("private", repo)).toBeUndefined()
    expect(f.store.session().wikiSpace).toBe("private")
    await until(() => f.wiki.wikiIndexes.get("owner/repo", "private") !== undefined)
    expect(f.wiki.wikiIndexes.get("owner/repo", "private")!.pages.map((page) => page.id)).toEqual([9])
    // Same path, two spaces: two rows, never one.
    expect(f.wiki.wikiIndexes.get("owner/repo", "public")!.pages.map((page) => page.id)).toEqual([1, 2, 3])
    expect(f.requests.map((request) => request.url)).toEqual(["/api/repos/owner/repo/wiki/navigation/index?visibility=public", "/api/repos/owner/repo/wiki/navigation/index?visibility=private"])
    expect(await f.wiki.setWikiSpace("secret", repo)).toBe("A Wiki space is public or private.")
  })

  test("a page opens in the shown space and carries it; the same slug in the other space is another page", async () => {
    const f = await space()
    await f.wiki.openCloudWiki(repo, "home")
    const publicPage = f.store.collections.worldDocuments.get(wikiDocumentId(repo, 1))
    expect(publicPage?.cloud).toMatchObject({ visibility: "public", path: "Home.md", pageId: 1 })
    await f.wiki.setWikiSpace("private", repo)
    await f.wiki.openCloudWiki(repo, "home")
    const privatePage = f.store.collections.worldDocuments.get(wikiDocumentId(repo, 9))
    expect(privatePage?.cloud).toMatchObject({ visibility: "private", pageId: 9 })
    expect(privatePage?.body).toBe("# Home\n\nPrivate")
    expect(publicPage?.body).toBe("# Home\n\n[[Guides/Start]]")
    expect(f.requests.filter((request) => request.url.includes("/document")).map((request) => request.url))
      .toEqual(["/api/repos/owner/repo/wiki/home/document?visibility=public", "/api/repos/owner/repo/wiki/home/document?visibility=private"])
  })

  test("Save to wiki creates one page with the literal answer Markdown", async () => {
    const f = await space()
    const markdown = "Use `redeliver` in [retry.ts](src/webhooks/retry.ts).\n\nKeep the retry bounded."
    await f.wiki.createCloudWikiPage("Retry", repo, markdown)
    const creates = f.requests.filter(request => request.method === "POST")
    expect(creates).toHaveLength(1)
    expect(JSON.parse(creates[0]!.body!)).toEqual({ title: "Retry", body: markdown })
  })

  test("wiki.save without an answer refuses to save a tool marker", async () => {
    const f = await space()
    await f.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", name: "repo", ownerKind: "user", head: null }] }).isPersisted.promise
    await f.store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
    await f.store.dispatch({ type: "message.tool.executed", actor: "smithers", turnId: "answer-turn", text: "Smithers ran /review" }).isPersisted.promise
    expect([...f.store.collections.messages.values()].some(message => message.act === "Smithers ran /review")).toBe(true)
    expect(await f.wiki.saveWikiAnswer("Retry")).toBe("Choose an answer to save.")
    expect(f.requests.some(request => request.method === "POST")).toBe(false)
  })

  test("wiki.save selects the last visible answer by transcript order", async () => {
    const f = await space()
    await f.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", name: "repo", ownerKind: "user", head: null }] }).isPersisted.promise
    await f.store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
    for (let n = 0; n < 10; n++) {
      await f.store.dispatch({ type: "message.appended", actor: "smithers", text: `Answer ${n}` }).isPersisted.promise
    }
    await f.store.dispatch({ type: "message.appended", actor: "smithers", text: '{"action":"list"}' }).isPersisted.promise
    await f.store.dispatch({ type: "message.tool.executed", actor: "smithers", turnId: "answer-turn", text: "Smithers ran /review" }).isPersisted.promise
    expect(await f.wiki.saveWikiAnswer("Latest")).toEqual({ value: "Requested" })
    await until(() => f.requests.some(request => request.method === "POST"))
    expect(JSON.parse(f.requests.find(request => request.method === "POST")!.body!).body).toBe("Answer 9")
  })

  test("a page's history is a card of its revisions, renames included, each a link to that revision's own bytes", async () => {
    const f = await space()
    await f.wiki.loadWikiIndex(repo)
    expect(await f.wiki.showWikiHistory("home", repo)).toEqual({ value: expect.stringContaining("r3 Home.md by will; r2 Old/Home.md by ada") })
    const card = f.store.collections.cards.get("wiki-history-owner/repo-public-1")
    expect(card?.kind).toBe("wiki-history")
    if (card?.kind === "wiki-history") {
      expect(card.payload).toMatchObject({ repo, space: "public", pageId: 1, path: "Home.md", page: 1, hasNext: false })
      expect(card.payload.revisions.map((row) => [row.revision, row.path, row.author])).toEqual([[3, "Home.md", "will"], [2, "Old/Home.md", "ada"]])
    }
    expect(f.toasts.at(-1)).toMatchObject({ title: "Reading the history of Home.md…", done: "History of Home.md" })
    expect(await f.wiki.showWikiHistory("missing", repo)).toBe("There is no public Wiki page missing in owner/repo. Open the space first.")
  })

  test("create opens the new page in the shown space; rename is checked against the revision the person saw and a stale one is refused", async () => {
    const f = await space()
    await f.wiki.setWikiSpace("private", repo)
    expect(await f.wiki.createCloudWikiPage("Notes", repo)).toEqual({ value: "Created Notes.md in the private Wiki of owner/repo." })
    const created = f.requests.find((request) => request.method === "POST")!
    expect(created.url).toBe("/api/repos/owner/repo/wiki?visibility=private")
    expect(JSON.parse(created.body!)).toEqual({ title: "Notes", body: "# Notes\n\n" })
    expect(f.store.collections.worldDocuments.get(wikiDocumentId(repo, 20))?.cloud).toMatchObject({ visibility: "private", pageId: 20 })
    expect(await f.wiki.createCloudWikiPage("   ", repo)).toBe("A page needs a title.")
    await f.wiki.setWikiSpace("public", repo)
    await until(() => f.wiki.wikiIndexes.get("owner/repo", "public") !== undefined)
    expect(await f.wiki.renameCloudWikiPage("home", "Guides/Home.md", repo)).toBeUndefined()
    const patched = f.requests.find((request) => request.method === "PATCH")!
    expect(patched.url).toBe("/api/repos/owner/repo/wiki/home?visibility=public")
    expect(JSON.parse(patched.body!)).toEqual({ path: "Guides/Home.md", expected_revision: 3 })
    f.refuseRename()
    expect(await f.wiki.renameCloudWikiPage("start", "Elsewhere.md", repo)).toBe("Guides/Start.md changed since you opened it (revision 1). Refresh the page and rename it again.")
  })

  test("delete leaves the page's history and marks an open copy deleted; attach puts the human's file with its type against the current revision", async () => {
    const f = await space()
    await f.wiki.openCloudWiki(repo, "home")
    expect(await f.wiki.deleteCloudWikiPage("home", repo)).toBeUndefined()
    expect(f.requests.find((request) => request.method === "DELETE")?.url).toBe("/api/repos/owner/repo/wiki/home?visibility=public")
    expect(f.store.collections.worldDocuments.get(wikiDocumentId(repo, 1))?.cloud?.phase).toBe("deleted")
    const file = new File([new Uint8Array([1, 2, 3])], "diagram.png", { type: "image/png" })
    expect(await f.wiki.attachCloudWiki("assets/diagram.png", repo, { name: "wiki.attach", takeFile: () => file, release: () => {} }))
      .toEqual({ value: "Attached assets/diagram.png (image/png, revision 1) to the public Wiki of owner/repo." })
    const put = f.requests.find((request) => request.method === "PUT")!
    expect(put.url).toBe("/api/repos/owner/repo/wiki/attachments/assets-diagram-png-039058c6f2c0?path=assets%2Fdiagram.png&expected_revision=0&visibility=public")
    expect(put.type).toBe("image/png")
    expect(await f.wiki.attachCloudWiki("", repo)).toBe("Choose a file to attach.")
    expect(await f.wiki.attachCloudWiki("Notes.md", repo, { name: "wiki.attach", takeFile: () => file, release: () => {} })).toBe("An attachment path is a relative file path, not a Markdown page.")
  })

  test("a file at the path of an indexed attachment replaces it under its own slug at its current revision", async () => {
    const f = await space()
    await f.wiki.setWikiSpace("public", repo)
    await until(() => f.wiki.wikiIndexes.get("owner/repo", "public") !== undefined)
    const file = new File([new Uint8Array([1, 2, 3])], "Logo.png", { type: "image/png" })
    await f.wiki.attachCloudWiki("assets/LOGO.png", repo, { name: "wiki.attach", takeFile: () => file, release: () => {} })
    expect(f.requests.find((request) => request.method === "PUT")!.url)
      .toBe("/api/repos/owner/repo/wiki/attachments/logo?path=assets%2FLOGO.png&expected_revision=1&visibility=public")
  })
})

describe("attachment bytes read under one account", () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255])
  class DeferredFile extends File {
    readonly reading = Promise.withResolvers<void>()
    readonly release = Promise.withResolvers<void>()
    readonly finished = Promise.withResolvers<void>()
    override async arrayBuffer(): Promise<ArrayBuffer> {
      this.reading.resolve()
      try {
        await this.release.promise
        return await super.arrayBuffer()
      } finally {
        this.finished.resolve()
      }
    }
  }
  const afterRead = async (file: DeferredFile) => {
    await file.finished.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const setup = async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memory() })
    await signIn(store)
    const requests: Array<{ method: string; url: string; body: Uint8Array | undefined }> = []
    const doc = new Y.Doc()
    doc.getText("markdown").insert(0, "# Page")
    cleanup.push(() => doc.destroy())
    const services: AppServices = {
      fetchImpl: async (input, init) => {
        const url = String(input)
        const method = init?.method ?? "GET"
        requests.push({ method, url, body: init?.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : undefined })
        if (method === "PUT") return Response.json({ id: 30, slug: "diagram", title: "diagram.png", path: "assets/diagram.png", revision: 1, updated_at: "2026-09-26T00:00:00Z", created_at: "2026-09-26T00:00:00Z", author: { id: 1, login: "will" }, visibility: "public", content_digest: "9".repeat(64), attachment: { digest: "9".repeat(64), media_type: "image/png", size: bytes.length } })
        if (url.includes("/navigation/index?")) return Response.json({ pages: [], folders: [], tags: [] })
        if (url.endsWith("/document?visibility=public")) return Response.json({ page: { id: 42, slug: "home", title: "Page", body: "# Page", revision: 1, author: { id: 1, login: "will" }, created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z" }, state: encodeWikiState(Y.encodeStateAsUpdate(doc)), state_vector: encodeWikiState(Y.encodeStateVector(doc)) })
        if (url.includes("/stream?")) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")) } }), { headers: { "content-type": "text/event-stream" } })
        throw new Error(`Unexpected Wiki request ${method} ${url}`)
      }
    }
    const ctx = createControllerContext(store, silentAgent, services)
    ctx.withToast = async (_key, _title, _done, work) => work()
    ctx.resolveToast = () => {}
    const wiki = createCloudWikiController(ctx, () => 1)
    cleanup.push(() => ctx.dispose())
    const file = () => new DeferredFile([bytes], "diagram.png", { type: "image/png" })
    const attach = (chosen: File) => wiki.attachCloudWiki("assets/diagram.png", repo, { name: "wiki.attach", takeFile: () => chosen, release: () => {} })
    const uploads = () => requests.filter((request) => request.method === "PUT")
    return { store, ctx, wiki, requests, file, attach, uploads }
  }

  test("same-account release uploads the exact selected File bytes once", async () => {
    const f = await setup()
    const file = f.file()
    const attaching = f.attach(file)
    await file.reading.promise
    expect(f.uploads()).toHaveLength(0)
    file.release.resolve()
    expect(await attaching).toEqual({ value: "Attached assets/diagram.png (image/png, revision 1) to the public Wiki of owner/repo." })
    expect(f.uploads()).toHaveLength(1)
    expect(f.uploads()[0]!.body).toEqual(bytes)
    expect(f.uploads()[0]!.url).toBe("/api/repos/owner/repo/wiki/attachments/assets-diagram-png-0150a92bb121?path=assets%2Fdiagram.png&expected_revision=0&visibility=public")
  })

  test("a persisted account change while the real File read is pending retires the gesture before upload", async () => {
    const f = await setup()
    const file = f.file()
    const attaching = f.attach(file)
    await file.reading.promise
    await signIn(f.store, "ada")
    file.release.resolve()
    await afterRead(file)
    expect(await attaching).toBe("The Wiki request failed.")
    expect(f.uploads()).toHaveLength(0)
    expect(f.requests.filter((request) => request.url.includes("/navigation/index?"))).toHaveLength(0)
  })

  test("sign-out while the File read is pending retires the gesture", async () => {
    const f = await setup()
    const file = f.file()
    const attaching = f.attach(file)
    await file.reading.promise
    await f.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    file.release.resolve()
    await afterRead(file)
    expect(await attaching).toBe("The Wiki request failed.")
    expect(f.uploads()).toHaveLength(0)
    expect(f.requests.filter((request) => request.url.includes("/navigation/index?"))).toHaveLength(0)
  })

  test("returning to the original account cannot revive its pending File read", async () => {
    const f = await setup()
    const file = f.file()
    const attaching = f.attach(file)
    await file.reading.promise
    await signIn(f.store, "ada")
    await signIn(f.store, "will")
    file.release.resolve()
    await afterRead(file)
    expect(await attaching).toBe("The Wiki request failed.")
    expect(f.uploads()).toHaveLength(0)
    expect(f.requests.filter((request) => request.url.includes("/navigation/index?"))).toHaveLength(0)
  })

  test("forking the active conversation retires a pending File read", async () => {
    const f = await setup()
    await f.wiki.openCloudWiki(repo, "home")
    const frames = createFramesController(f.ctx, undefined)
    frames.maximizeCard(`wiki-open-${id}`)
    await until(() => f.store.session().maximizedCardId !== null)
    const originalBranch = f.store.session().activeBranchId
    const file = f.file()
    const attaching = f.attach(file)
    await file.reading.promise
    await restoreRecordedBranch(f.store)
    await until(() => f.store.session().activeBranchId !== originalBranch)
    const indexReads = f.requests.filter((request) => request.url.includes("/navigation/index?")).length
    file.release.resolve()
    await afterRead(file)
    expect(await attaching).toBe("The Wiki request failed.")
    expect(f.uploads()).toHaveLength(0)
    expect(f.requests.filter((request) => request.url.includes("/navigation/index?"))).toHaveLength(indexReads)
  })

  test("disposing the controller while a File read is pending prevents a later upload", async () => {
    const f = await setup()
    const file = f.file()
    const attaching = f.attach(file)
    await file.reading.promise
    await f.ctx.dispose()
    file.release.resolve()
    await afterRead(file)
    expect(await attaching).toBe("The Wiki request failed.")
    expect(f.uploads()).toHaveLength(0)
    expect(f.requests.filter((request) => request.url.includes("/navigation/index?"))).toHaveLength(0)
  })

  test("a failed File read returns a refusal and a fresh gesture can retry", async () => {
    const f = await setup()
    const broken = f.file()
    const failed = f.attach(broken)
    await broken.reading.promise
    broken.release.reject(new Error("disk read failed"))
    expect(await failed).toBe("The attachment could not be read. Choose the file again.")
    expect(f.uploads()).toHaveLength(0)
    const retry = f.file()
    const attaching = f.attach(retry)
    await retry.reading.promise
    retry.release.resolve()
    expect(await attaching).toEqual({ value: "Attached assets/diagram.png (image/png, revision 1) to the public Wiki of owner/repo." })
    expect(f.uploads()).toHaveLength(1)
    expect(f.uploads()[0]!.body).toEqual(bytes)
  })
})
