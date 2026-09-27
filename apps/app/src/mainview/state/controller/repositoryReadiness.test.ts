import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { expect, test, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import { beginRepositoryEntry, openRequestedRepo } from "../../RepoLink"
import { openSqliteRowStorage } from "../../chain/SqliteRowStorage"
import { APP_SCHEMA_VERSION } from "../../chain/SchemaVersion"
import { createAppController } from "../AppController"
import { createAppStore, PERSISTED_COLLECTION_SPECS, type PersistenceBackend } from "../AppStore"
import { json, memoryStorage, silentAgent } from "../TestFixtures"

const repo = "alpha/one"
const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const until = async (check: () => boolean) => { for (let i = 0; i < 150 && !check(); i++) await pause(10); expect(check()).toBe(true) }
const setup = async (storage = memoryStorage(), fetchImpl: FetchLike = async () => json(404, {}), backend?: PersistenceBackend) => {
  const store = await createAppStore(backend ?? { kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: crypto.randomUUID(), repo, phase: "pending" } }).isPersisted.promise
  const controller = createAppController(store, silentAgent, { fetchImpl: (input, init) => String(input).includes("/contents/.smithers/factory.json") || /\/api\/repos\/[^/]+\/[^/]+\/home$/.test(String(input)) ? Promise.resolve(json(404, {})) : fetchImpl(input, init), toastDebounceMs: 10 })
  const ready = async () => {
    await store.dispatch({ type: "repository.upserted", actor: "system", repository: { id: repo, org: "alpha", name: "one", ownerKind: "user", head: null, catalog: true } }).isPersisted.promise
    await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { ...store.session().repositoryEntry!, phase: "ready" } }).isPersisted.promise
  }
  const close = async () => { await controller.dispose?.(); await store.dispose?.() }
  return { store, controller, ready, close }
}

for (const name of ["repo.overview", "repo.update"] as const) {
  for (const explicit of [false, true]) test(`${name} acknowledges a pending ${explicit ? "explicit" : "URL"} target before reading activity`, async () => {
    let reads = 0
    const activity = Promise.withResolvers<Response>()
    const h = await setup(undefined, async input => {
      if (String(input).includes("/issues?state=open")) { reads++; return activity.promise }
      return json(200, [])
    })
    try {
      const requested = h.controller.commands.run(name, explicit ? repo : undefined)
      const outcome = await Promise.race([requested, pause(100).then(() => "still waiting")])
      expect(outcome).toEqual({ status: "executed", value: "Requested" })
      expect(reads).toBe(0)
      expect(h.store.session().pendingCommand?.requirement).toBe("repository-ready")
      expect(await h.controller.commands.run(name, explicit ? repo : undefined)).toEqual({ status: "executed", value: "Requested" })
      h.controller.changeDraft("Chat stays usable")
      expect(h.store.session().draft).toBe("Chat stays usable")
      await h.ready()
      await until(() => reads === 1)
      await until(() => h.store.collections.toasts.get("toast-repository.ready")?.status === "running")
      activity.resolve(json(200, [{ number: 1, title: "Bound activity", state: "open" }]))
      await until(() => h.store.collections.toasts.get("toast-repository.ready")?.status === "ok")
      expect(h.store.collections.repositoryContexts.size).toBe(1)
      const cards = [...h.store.collections.cards.values()].filter(card => card.kind === "repo-update")
      expect(cards).toHaveLength(name === "repo.overview" ? 1 : 0)
      if (name === "repo.overview") expect(cards[0]?.payload.items[0]?.title).toBe("Bound activity")
      expect(reads).toBe(1)
    } finally { activity.resolve(json(503, {})); await h.close() }
  })
}

test("a cold explicit public target from home persists and acknowledges before its catalog or file read finishes", async () => {
  let resolveCatalog!: (response: Response) => void, resolveFile!: (response: Response) => void
  const catalog = new Promise<Response>(resolve => { resolveCatalog = resolve })
  const file = new Promise<Response>(resolve => { resolveFile = resolve })
  let catalogs = 0, reads = 0
  const h = await setup(undefined, async input => {
    const url = String(input)
    if (url === "/api/public/repos") { catalogs++; return catalog }
    if (url.endsWith(`/api/repos/${repo}/contents/README.md`)) { reads++; return file }
    return json(404, {})
  })
  try {
    await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: null }).isPersisted.promise
    expect(await h.controller.commands.run("files.read", `README.md ${repo}`)).toEqual({ status: "executed", value: "Requested" })
    expect(h.store.session().pendingCommand?.requirement).toBe("repository-ready")
    expect(JSON.parse(h.store.session().pendingCommand!.args!)).toEqual({ path: "README.md", repo })
    expect(h.store.session().repositoryEntry).toBeNull()
    expect(await h.controller.commands.run("files.read", `README.md ${repo}`)).toEqual({ status: "executed", value: "Requested" })
    await until(() => catalogs === 1)
    expect(reads).toBe(0)
    expect([...h.store.collections.messages.values()].some(message => message.action?.flow === "auth.sign-in")).toBe(false)
    h.controller.changeDraft("Chat remains available")
    expect(h.store.session().draft).toBe("Chat remains available")
    await until(() => h.store.collections.toasts.get("toast-repository.ready")?.status === "running")
    resolveCatalog(json(200, { repos: [{ name: repo }] }))
    await until(() => reads === 1)
    expect(h.store.collections.toasts.get("toast-repository.ready")?.status).toBe("running")
    resolveFile(json(200, { path: "README.md", content: "COLD PUBLIC TARGET", encoding: "utf-8", type: "file" }))
    await until(() => h.store.collections.cards.get(`file-${repo}-README.md`)?.status === "active")
    await until(() => h.store.collections.toasts.get("toast-repository.ready")?.status === "ok")
    expect(catalogs).toBe(1)
    expect(reads).toBe(1)
    expect(h.store.session().repositoryEntry).toBeNull()
  } finally { resolveCatalog(json(503, {})); resolveFile(json(503, {})); await h.close() }
})

for (const phase of ["pending", "ready"] as const) test(`root reload waits for the real boot identity answer before reconnecting its ${phase} command target`, async () => {
  const storage = memoryStorage()
  let release!: (response: Response) => void
  const oldCatalog = new Promise<Response>(resolve => { release = resolve })
  const first = await setup(storage, async () => oldCatalog)
  await first.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: null }).isPersisted.promise
  await first.controller.commands.run("files.list", `docs ${repo}`)
  const requestId = first.store.session().repositoryCommandEntry!.requestId
  await first.close()
  if (phase === "ready") {
    const admitted = await createAppStore({ kind: "localStorage", storage })
    await admitted.dispatch({ type: "repository.upserted", actor: "system", repository: { id: repo, org: "alpha", name: "one", ownerKind: "user", head: null, catalog: true } }).isPersisted.promise
    await admitted.dispatch({ type: "repository.command.changed", actor: "system", entry: { ...admitted.session().repositoryCommandEntry!, phase: "ready" } }).isPersisted.promise
    await admitted.dispose?.()
  }
  const store = await createAppStore({ kind: "localStorage", storage })
  beginRepositoryEntry(store, null)
  const hits: string[] = []
  let releaseScopes!: () => void
  const scopes = new Promise<void>(resolve => { releaseScopes = resolve })
  const controller = createAppController(store, silentAgent, { toastDebounceMs: 10, fetchImpl: async input => {
    const url = String(input); hits.push(url)
    if (url.endsWith("/api/auth/scopes")) { await scopes; return json(200, { scopes: [] }) }
    return url === "/api/public/repos" ? json(200, { repos: [{ name: repo }] }) : json(200, [])
  } })
  try {
    controller.changeDraft("Chat is available before identity finishes")
    await pause(15)
    const adopting = controller.adoptSession({ state: "signed-out", login: null, allowlisted: false, admin: false })
    await pause(25)
    expect(hits.filter(path => path === "/api/public/repos")).toEqual([])
    expect(hits.filter(path => path.includes("/contents/docs"))).toEqual([])
    expect(store.session().pendingCommand?.requirement).toBe("repository-ready")
    releaseScopes()
    await adopting
    await until(() => store.collections.cards.get(`files-${repo}-docs`)?.status === "active")
    expect(store.session().repositoryEntry).toBeNull()
    expect(store.session().repositoryCommandEntry?.requestId).toBe(requestId)
    expect(hits.filter(path => path === "/api/public/repos")).toHaveLength(phase === "pending" ? 1 : 0)
    expect(hits.filter(path => path.includes("/contents/docs"))).toEqual([`/api/repos/${repo}/contents/docs`])
    release(json(200, { repos: [{ name: "old/stale" }] }))
    await pause(20)
    expect(store.collections.repositories.has("old/stale")).toBe(false)
  } finally { releaseScopes(); release(json(503, {})); await controller.dispose(); await store.dispose?.() }
})

test("an explicit cold target leaves a different URL admission and selection intact", async () => {
  const hits: string[] = []
  const h = await setup(undefined, async input => { const url = String(input); hits.push(url); return url === "/api/public/repos" ? json(200, { repos: [{ name: "beta/two" }] }) : json(200, []) })
  try {
    await h.ready()
    await h.store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
    const entry = { ...h.store.session().repositoryEntry! }
    await h.controller.commands.run("files.list", "docs beta/two")
    await until(() => h.store.collections.cards.get("files-beta/two-docs")?.status === "active")
    expect(h.store.session().repositoryEntry).toEqual(entry)
    expect(h.store.session().activeRepoKey).toBe(repo)
    expect(hits).toEqual(["/api/public/repos", "/api/repos/beta/two/contents/docs"])
  } finally { await h.close() }
})

test("an unavailable cold catalog is retryable and a not-public answer never loops or reads contents", async () => {
  let catalogs = 0
  const hits: string[] = []
  const h = await setup(undefined, async input => {
    const url = String(input); hits.push(url)
    if (url === "/api/public/repos") return ++catalogs === 1 ? json(503, {}) : json(200, { repos: [] })
    return json(404, {})
  })
  try {
    await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: null }).isPersisted.promise
    await h.controller.commands.run("files.list", `docs ${repo}`)
    await until(() => [...h.store.collections.toasts.values()].some(toast => toast.status === "failed"))
    expect(h.store.session().repositoryCommandEntry?.failureKind).toBe("unavailable")
    expect([...h.store.collections.messages.values()].some(message => message.action?.flow === "auth.sign-in")).toBe(false)
    const oldId = h.store.session().repositoryCommandEntry!.requestId
    await h.controller.commands.run("files.list", `docs ${repo}`)
    await until(() => h.store.session().pendingCommand?.requirement === "repo-source")
    expect(h.store.session().repositoryCommandEntry?.failureKind).toBe("not-public")
    expect(h.store.session().repositoryCommandEntry?.requestId).not.toBe(oldId)
    await h.controller.commands.run("files.list", `docs ${repo}`)
    await pause(20)
    expect(catalogs).toBe(2)
    expect(hits).toEqual(["/api/public/repos", "/api/public/repos"])
    expect([...h.store.collections.messages.values()].some(message => message.action?.flow === "auth.sign-in")).toBe(true)
    expect(h.store.collections.toasts.get("toast-repository.ready")?.status).not.toBe("ok")
  } finally { await h.close() }
})

for (const change of ["account", "dispose", "target"] as const) {
  test(`a cold catalog response cannot cross ${change} ownership`, async () => {
    let release!: (response: Response) => void
    const gate = new Promise<Response>(resolve => { release = resolve })
    let catalogs = 0
    const reads: string[] = []
    const h = await setup(undefined, async input => {
      const url = String(input)
      if (url === "/api/public/repos") return ++catalogs === 1 ? gate : json(200, { repos: [{ name: "beta/two" }] })
      reads.push(url); return json(200, [])
    })
    try {
      await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: null }).isPersisted.promise
      await h.controller.commands.run("files.list", `docs ${repo}`)
      await until(() => catalogs === 1)
      if (change === "account") await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      if (change === "dispose") await h.controller.dispose()
      if (change === "target") {
        await h.controller.commands.run("files.list", "other beta/two")
        await until(() => h.store.collections.cards.get("files-beta/two-other")?.status === "active")
      }
      release(json(200, { repos: [{ name: repo }] }))
      await pause(35)
      expect(h.store.collections.repositories.has(repo)).toBe(false)
      expect(reads.filter(path => path.includes(`/api/repos/${repo}/`))).toEqual([])
      if (change === "account") expect(h.store.session().repositoryCommandEntry).toBeUndefined()
    } finally { release(json(503, {})); await h.close() }
  })
}

// Focus, a sibling tab and a 401 re-read the session: the same answer again is not an account change.
test("a cold catalog response still serves its command through a same-owner identity answer", async () => {
  let release!: (response: Response) => void
  const gate = new Promise<Response>(resolve => { release = resolve })
  let catalogs = 0
  const reads: string[] = []
  const h = await setup(undefined, async input => {
    const url = String(input)
    if (url === "/api/public/repos") return ++catalogs === 1 ? gate : json(200, { repos: [{ name: "beta/two" }] })
    reads.push(url); return json(200, [])
  })
  try {
    await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: null }).isPersisted.promise
    await h.controller.commands.run("files.list", `docs ${repo}`)
    await until(() => catalogs === 1)
    await h.controller.adoptSession({ state: "signed-out", login: null, allowlisted: false, admin: false })
    release(json(200, { repos: [{ name: repo }] }))
    await until(() => h.store.collections.repositories.has(repo))
  } finally { release(json(503, {})); await h.close() }
})

test("new arguments share a cold catalog request while keeping the latest exact target independent of selection", async () => {
  let release!: (response: Response) => void
  const gate = new Promise<Response>(resolve => { release = resolve })
  let catalogs = 0
  const reads: string[] = []
  const h = await setup(undefined, async input => {
    const url = String(input)
    if (url === "/api/public/repos") { catalogs++; return gate }
    reads.push(url); return json(200, [])
  })
  try {
    await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: null }).isPersisted.promise
    await h.controller.commands.run("files.list", `old ${repo}`)
    const requestId = h.store.session().repositoryCommandEntry!.requestId
    await h.controller.commands.run("files.list", `new ${repo}`)
    await h.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "selected/repo", org: "selected", name: "repo", ownerKind: "user", head: null }] }).isPersisted.promise
    await h.store.dispatch({ type: "repo.selected", actor: "user", id: "selected/repo" }).isPersisted.promise
    expect(h.store.session().repositoryCommandEntry?.requestId).toBe(requestId)
    release(json(200, { repos: [{ name: repo }] }))
    await until(() => h.store.collections.cards.get(`files-${repo}-new`)?.status === "active")
    expect(catalogs).toBe(1)
    expect(reads).toEqual([`/api/repos/${repo}/contents/new`])
    expect(h.store.session().activeRepoKey).toBe("selected/repo")
  } finally { release(json(503, {})); await h.close() }
})

test("cold admission and duplicate acknowledgments wait for persistence before any catalog request", async () => {
  let catalogs = 0
  const h = await setup(undefined, async input => { if (String(input) === "/api/public/repos") catalogs++; return json(200, { repos: [] }) })
  await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: null }).isPersisted.promise
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const dispatch = h.store.dispatch.bind(h.store)
  const spy = spyOn(h.store, "dispatch").mockImplementation(transition => {
    const result = dispatch(transition)
    if (transition.type !== "command.deferred" || !transition.repositoryRequest) return result
    const persisted = { ...result.isPersisted, promise: gate.then(() => result.isPersisted.promise) }
    return new Proxy(result, { get: (target, key, receiver) => key === "isPersisted" ? persisted : Reflect.get(target, key, receiver) })
  })
  try {
    let acknowledged = 0
    const first = h.controller.commands.run("files.list", `docs ${repo}`).then(result => { acknowledged++; return result })
    await until(() => h.store.session().repositoryCommandEntry?.phase === "pending")
    const duplicate = h.controller.commands.run("files.list", `docs ${repo}`).then(result => { acknowledged++; return result })
    await pause(25)
    expect(catalogs).toBe(0)
    expect(acknowledged).toBe(0)
    release()
    expect(await first).toEqual({ status: "executed", value: "Requested" })
    expect(await duplicate).toEqual({ status: "executed", value: "Requested" })
    await until(() => catalogs === 1)
  } finally { release(); spy.mockRestore(); await h.close() }
})

test("an earlier admission commit cannot launch a newer uncommitted target", async () => {
  const hits: string[] = []
  const h = await setup(undefined, async input => {
    const url = String(input); hits.push(url)
    return url === "/api/public/repos" ? json(200, { repos: [{ name: repo }, { name: "beta/two" }] }) : json(200, [])
  })
  await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: null }).isPersisted.promise
  const releases: Array<() => void> = []
  const dispatch = h.store.dispatch.bind(h.store)
  const spy = spyOn(h.store, "dispatch").mockImplementation(transition => {
    const result = dispatch(transition)
    if (transition.type !== "command.deferred" || !transition.repositoryRequest) return result
    const gate = new Promise<void>(resolve => { releases.push(resolve) })
    const persisted = { ...result.isPersisted, promise: gate.then(() => result.isPersisted.promise) }
    return new Proxy(result, { get: (target, key, receiver) => key === "isPersisted" ? persisted : Reflect.get(target, key, receiver) })
  })
  try {
    const first = h.controller.commands.run("files.list", `old ${repo}`)
    await until(() => releases.length === 1)
    const second = h.controller.commands.run("files.list", "new beta/two")
    await until(() => releases.length === 2)
    releases[0]!()
    expect(await first).toEqual({ status: "executed", value: "Requested" })
    await pause(25)
    expect(hits).toEqual([])
    releases[1]!()
    expect(await second).toEqual({ status: "executed", value: "Requested" })
    await until(() => h.store.collections.cards.get("files-beta/two-new")?.status === "active")
    expect(hits).toEqual(["/api/public/repos", "/api/repos/beta/two/contents/new"])
  } finally { releases.forEach(release => release()); spy.mockRestore(); await h.close() }
})

test("a cold target's progress reports the actual content failure after successful admission", async () => {
  let release!: (response: Response) => void
  const gate = new Promise<Response>(resolve => { release = resolve })
  const h = await setup(undefined, async input => String(input) === "/api/public/repos" ? gate : json(502, { message: "upstream unavailable" }))
  try {
    await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: null }).isPersisted.promise
    await h.controller.commands.run("files.list", `docs ${repo}`)
    await until(() => h.store.collections.toasts.get("toast-repository.ready")?.status === "running")
    release(json(200, { repos: [{ name: repo }] }))
    await until(() => h.store.collections.toasts.get("toast-repository.ready")?.status === "failed")
    expect(h.store.collections.cards.get(`files-${repo}-docs`)?.status).toBe("error")
    expect(h.store.session().repositoryCommandEntry?.phase).toBe("ready")
  } finally { release(json(503, {})); await h.close() }
})

test("catalog wait acknowledges, coalesces and keeps progress through the actual read", async () => {
  let complete!: (value: Response) => void
  const response = new Promise<Response>(resolve => complete = resolve)
  const hits: string[] = []
  const h = await setup(undefined, async input => { const path = String(input); if (path.includes("/contents/README.md")) { hits.push(path); return response }; return json(404, {}) })
  try {
    expect(await h.controller.commands.run("files.read", `README.md ${repo}`)).toMatchObject({ status: "executed", value: "Requested" })
    await h.controller.commands.run("files.read", `README.md ${repo}`)
    expect(hits).toHaveLength(0)
    expect([...h.store.collections.messages.values()].some(m => m.action?.flow === "auth.sign-in")).toBe(false)
    h.controller.changeDraft("Chat stays usable")
    expect(h.store.session().draft).toBe("Chat stays usable")
    await until(() => h.store.collections.toasts.get("toast-repository.ready")?.status === "running")
    await h.ready()
    await until(() => hits.length === 1)
    expect(h.store.collections.toasts.get("toast-repository.ready")?.status).toBe("running")
    complete(json(200, { path: "README.md", content: "ALPHA", encoding: "utf-8", type: "file" }))
    await until(() => h.store.collections.cards.get("file-alpha/one-README.md")?.status === "active")
    await until(() => h.store.collections.toasts.get("toast-repository.ready")?.status === "ok")
    expect(hits).toHaveLength(1)
  } finally { complete?.(json(200, {})); await h.close() }
})

test("a persisted request reconnects after reload and retains its explicit target", async () => {
  const storage = memoryStorage()
  const first = await setup(storage)
  await first.controller.commands.run("files.read", `README.md ${repo}`)
  await first.close()
  const hits: string[] = []
  const second = await setup(storage, async input => { hits.push(String(input)); return json(200, { path: "README.md", type: "file", content: "RESTORED", encoding: "utf-8" }) })
  try {
    await second.controller.adoptSession({ state: "signed-out", login: null, allowlisted: false, admin: false })
    await second.ready()
    await until(() => second.store.collections.cards.get("file-alpha/one-README.md")?.status === "active")
    expect(hits.filter(path => path.includes("/contents/README.md"))).toEqual([expect.stringContaining("/alpha/one/contents/README.md")])
  } finally { await second.close() }
})

test("catalog failure stays visible and a fresh request can retry", async () => {
  const hits: string[] = []
  const h = await setup(undefined, async input => { hits.push(String(input)); return json(200, { path: "README.md", type: "file", content: "RETRY", encoding: "utf-8" }) })
  try {
    await h.controller.commands.run("files.read", `README.md ${repo}`)
    await pause(20)
    await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { ...h.store.session().repositoryEntry!, phase: "failed", error: "Catalog unavailable" } }).isPersisted.promise
    await until(() => h.store.collections.toasts.get("toast-repository.ready")?.status === "failed")
    expect(hits).toHaveLength(0)
    await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "retry", repo, phase: "pending" } }).isPersisted.promise
    await h.controller.commands.run("files.read", `README.md ${repo}`)
    await h.ready()
    await until(() => h.store.collections.cards.get("file-alpha/one-README.md")?.status === "active")
  } finally { await h.close() }
})

test("private targets keep their sign-in gate and agent calls never queue", async () => {
  const h = await setup(undefined, async input => String(input) === "/api/public/repos" ? json(200, { repos: [] }) : json(404, {}))
  try {
    expect(await h.controller.commands.runForAgent("files.read", `README.md ${repo}`)).toMatchObject({ status: "failed", error: expect.stringContaining("loading") })
    expect(h.store.session().pendingCommand).toBeFalsy()
    await h.controller.commands.run("files.read", "README.md private/secret")
    await until(() => h.store.session().pendingCommand?.requirement === "repo-source")
    expect([...h.store.collections.messages.values()].some(m => m.action?.flow === "auth.sign-in")).toBe(true)
    expect(h.store.session().pendingCommand?.requirement).toBe("repo-source")
  } finally { await h.close() }
})

for (const [args, expected] of [[`/${repo}/docs`, "docs"], [`/${repo}`, ""], ["docs", "docs"]] as const) {
  test(`a cold address ${args} retains its repository-relative target`, async () => {
    const hits: string[] = []
    const h = await setup(undefined, async input => { hits.push(String(input)); return json(200, []) })
    try {
      await h.controller.commands.run("files.list", args)
      expect(JSON.parse(h.store.session().pendingCommand!.args!)).toEqual({ path: expected, repo })
      await h.ready()
      await until(() => hits.length > 0)
      expect(hits).toEqual([`/api/repos/${repo}/contents${expected ? `/${expected}` : ""}`])
    } finally { await h.close() }
  })
}

test("a known global repository does not bind to an unrelated pending URL", async () => {
  const hits: string[] = []
  const h = await setup(undefined, async input => { hits.push(String(input)); return json(200, []) })
  try {
    await h.store.dispatch({ type: "repository.upserted", actor: "system", repository: { id: "beta/two", org: "beta", name: "two", ownerKind: "user", head: null, catalog: true } }).isPersisted.promise
    await h.controller.commands.run("files.list", "/beta/two/docs")
    expect(h.store.session().pendingCommand).toBeFalsy()
    expect(hits).toEqual(["/api/repos/beta/two/contents/docs"])
  } finally { await h.close() }
})

test("an unrelated local checkout cannot satisfy an explicit private cloud target", async () => {
  const hits: string[] = []
  const h = await setup(undefined, async input => { hits.push(String(input)); return String(input) === "/api/public/repos" ? json(200, { repos: [] }) : json(404, {}) })
  try {
    await h.store.dispatch({ type: "repos.loaded", actor: "system", repos: [{ id: "local", name: "local/checkout", path: "/home/local", warnings: [], git: { branch: "main", remote: "git@github.com:local/checkout.git" }, smithers: { detected: false, workspaceFile: null, declarationFiles: [], workspaces: [], reason: "none" } }] }).isPersisted.promise
    await h.controller.commands.run("files.read", "README.md private/secret")
    await until(() => h.store.session().pendingCommand?.requirement === "repo-source")
    expect(hits.filter(path => path.includes("contents/README"))).toEqual([])
    expect(h.store.session().pendingCommand).toMatchObject({ requirement: "repo-source", args: "README.md private/secret" })
  } finally { await h.close() }
})

for (const answer of ["private", "invalid", "offline"] as const) {
  test(`catalog ${answer} is distinct from unresolved authorization`, async () => {
    const h = await setup()
    try {
      await h.controller.commands.run("files.read", `README.md ${repo}`)
      const http: FetchLike = async () => { if (answer === "offline") throw new Error("offline"); return json(200, answer === "private" ? { repos: [] } : { wrong: [] }) }
      await openRequestedRepo(h.controller, http, repo, h.store.session().repositoryEntry!.requestId, 320)
      await until(() => h.store.session().pendingCommand?.requirement !== "repository-ready")
      if (answer === "private") {
        await until(() => h.store.session().pendingCommand?.requirement === "repo-source")
        expect(h.store.session().pendingCommand).toMatchObject({ args: `README.md ${repo}` })
        expect([...h.store.collections.messages.values()].some(m => m.action?.flow === "auth.sign-in")).toBe(true)
        expect(h.store.collections.toasts.get("toast-repository.ready")?.status).not.toBe("ok")
      } else {
        expect([...h.store.collections.messages.values()].some(m => m.action?.flow === "auth.sign-in")).toBe(false)
        await until(() => [...h.store.collections.toasts.values()].some(t => t.status === "failed"))
        expect(h.store.session().repositoryEntry?.failureKind).toBe("unavailable")
      }
    } finally { await h.close() }
  })
}

for (const change of ["selection", "request", "account-owner", "dispose"] as const) {
  test(`${change} while deferral clear persists prevents stale submission`, async () => {
    const hits: string[] = []
    const h = await setup(undefined, async input => { hits.push(String(input)); return json(200, []) })
    let release!: () => void
    const gate = new Promise<void>(resolve => release = resolve)
    let clearing = false
    const dispatch = h.store.dispatch.bind(h.store)
    const spy = spyOn(h.store, "dispatch").mockImplementation(transition => {
      const result = dispatch(transition)
      if (transition.type !== "command.deferral.cleared") return result
      clearing = true
      const persisted = { ...result.isPersisted, promise: gate.then(() => result.isPersisted.promise) }
      return new Proxy(result, { get: (target, key, receiver) => key === "isPersisted" ? persisted : Reflect.get(target, key, receiver) })
    })
    try {
      await h.controller.commands.run("files.list", `docs ${repo}`)
      await h.ready()
      await until(() => clearing)
      if (change === "selection") {
        await h.store.dispatch({ type: "repository.upserted", actor: "system", repository: { id: "beta/two", org: "beta", name: "two", ownerKind: "user", head: null, catalog: true } }).isPersisted.promise
        await h.store.dispatch({ type: "repo.selected", actor: "user", id: "beta/two" }).isPersisted.promise
        expect(h.store.session().activeRepoKey).toBe("beta/two")
      }
      if (change === "request") beginRepositoryEntry(h.store, "beta/two")
      if (change === "account-owner") await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      if (change === "dispose") await h.controller.dispose()
      release()
      await pause(30)
      expect(hits.filter(path => path.includes("contents/docs"))).toEqual([])
    } finally { release(); spy.mockRestore(); await h.close() }
  })
}

test("a same-owner identity answer while deferral clear persists still submits the command", async () => {
  const hits: string[] = []
  const h = await setup(undefined, async input => { hits.push(String(input)); return json(200, []) })
  let release!: () => void
  const gate = new Promise<void>(resolve => release = resolve)
  let clearing = false
  const dispatch = h.store.dispatch.bind(h.store)
  const spy = spyOn(h.store, "dispatch").mockImplementation(transition => {
    const result = dispatch(transition)
    if (transition.type !== "command.deferral.cleared") return result
    clearing = true
    const persisted = { ...result.isPersisted, promise: gate.then(() => result.isPersisted.promise) }
    return new Proxy(result, { get: (target, key, receiver) => key === "isPersisted" ? persisted : Reflect.get(target, key, receiver) })
  })
  try {
    await h.controller.commands.run("files.list", `docs ${repo}`)
    await h.ready()
    await until(() => clearing)
    await h.controller.adoptSession({ state: "signed-out", login: null, allowlisted: false, admin: false })
    release()
    await until(() => hits.some(path => path.includes("contents/docs")))
  } finally { release(); spy.mockRestore(); await h.close() }
})

test("catalog subscription resumes through the real SQLite projection boundary", async () => {
  const database = new Database(":memory:")
  const adapter = await openSqliteRowStorage({
    execute: async <T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> => {
      const query = database.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return query.all(...params as []) as ReadonlyArray<T>
      query.run(...params as [])
      return []
    }, close: () => database.close()
  }, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
  const hits: string[] = []
  const h = await setup(undefined, async input => { hits.push(String(input)); return json(200, []) }, {
    kind: "opfs", ...adapter, storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} }
  })
  try {
    await h.controller.commands.run("files.list", `docs ${repo}`)
    await h.ready()
    await until(() => hits.length === 1)
    expect(hits).toEqual([`/api/repos/${repo}/contents/docs`])
    await until(() => h.store.collections.cards.get(`files-${repo}-docs`)?.status === "active")
  } finally { await h.close() }
})

test("a missing-path form waits for catalog and does not report a completed read", async () => {
  const h = await setup()
  try {
    expect(await h.controller.commands.run("files.read")).toMatchObject({ status: "executed", value: "Requested" })
    await pause(20)
    await h.ready()
    await until(() => h.store.collections.cards.get("form-files.read")?.kind === "flow-form")
    const form = h.store.collections.cards.get("form-files.read")
    expect(form?.kind === "flow-form" && form.payload.given.repo).toBe(repo)
    expect(h.store.collections.toasts.get("toast-repository.ready")?.status).not.toBe("ok")
    expect([...h.store.collections.messages.values()].some(m => m.action?.flow === "auth.sign-in")).toBe(false)
  } finally { await h.close() }
})

test("duplicate acknowledgment waits for the shared durable request commit", async () => {
  const h = await setup()
  let release!: () => void
  const gate = new Promise<void>(resolve => release = resolve)
  const dispatch = h.store.dispatch.bind(h.store)
  const spy = spyOn(h.store, "dispatch").mockImplementation(transition => {
    const result = dispatch(transition)
    if (transition.type !== "command.deferred") return result
    const persisted = { ...result.isPersisted, promise: gate.then(() => result.isPersisted.promise) }
    return new Proxy(result, { get: (target, key, receiver) => key === "isPersisted" ? persisted : Reflect.get(target, key, receiver) })
  })
  let settled = 0
  try {
    const first = h.controller.commands.run("files.list", `docs ${repo}`).then(result => { settled++; return result })
    await until(() => h.store.session().pendingCommand?.requirement === "repository-ready")
    const second = h.controller.commands.run("files.list", `docs ${repo}`).then(result => { settled++; return result })
    await pause(20)
    expect(settled).toBe(0)
    release()
    expect(await first).toMatchObject({ status: "executed", value: "Requested" })
    expect(await second).toMatchObject({ status: "executed", value: "Requested" })
  } finally { release(); spy.mockRestore(); await h.close() }
})

const catalogFailed = async (store: Awaited<ReturnType<typeof setup>>["store"]) => {
  await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { ...store.session().repositoryEntry!, phase: "failed", failureKind: "unavailable", error: "Catalog unavailable" } }).isPersisted.promise
}

test("a fresh command refreshes a failed catalog once without changing selection", async () => {
  let release!: (response: Response) => void
  const catalog = new Promise<Response>(resolve => release = resolve)
  let refreshes = 0
  const reads: string[] = []
  const h = await setup(undefined, async input => {
    if (String(input) === "/api/public/repos") { refreshes++; return catalog }
    reads.push(String(input)); return json(200, [])
  })
  try {
    await catalogFailed(h.store)
    await h.store.dispatch({ type: "repository.upserted", actor: "system", repository: { id: "beta/two", org: "beta", name: "two", ownerKind: "user", head: null, catalog: true } }).isPersisted.promise
    await h.store.dispatch({ type: "repo.selected", actor: "user", id: "beta/two" }).isPersisted.promise
    expect(await h.controller.commands.run("files.list", `/${repo}/docs`)).toMatchObject({ status: "executed", value: "Requested" })
    await h.controller.commands.run("files.list", `/${repo}/docs`)
    expect(refreshes).toBe(1)
    expect(reads).toEqual([])
    expect(h.store.session().repositoryEntry?.phase).toBe("pending")
    expect([...h.store.collections.messages.values()].some(m => m.action?.flow === "auth.sign-in")).toBe(false)
    h.controller.changeDraft("usable during refresh")
    expect(h.store.session().draft).toBe("usable during refresh")
    release(json(200, { repos: [{ name: repo }] }))
    await until(() => h.store.collections.cards.get(`files-${repo}-docs`)?.status === "active")
    expect(reads).toEqual([`/api/repos/${repo}/contents/docs`])
    expect(h.store.session().activeRepoKey).toBe("beta/two")
  } finally { release(json(200, { repos: [] })); await h.close() }
})

test("a failed refresh stays honest and the next user retry can succeed without reload", async () => {
  let refreshes = 0
  const h = await setup(undefined, async input => String(input) === "/api/public/repos"
    ? ++refreshes === 1 ? json(503, {}) : json(200, { repos: [{ name: repo }] })
    : json(200, []))
  try {
    await catalogFailed(h.store)
    await h.controller.commands.run("files.list", `docs ${repo}`)
    await until(() => h.store.session().repositoryEntry?.phase === "failed" && h.store.session().pendingCommand == null)
    expect(h.store.session().repositoryEntry?.error).toContain("HTTP 503")
    expect([...h.store.collections.messages.values()].some(m => m.action?.flow === "auth.sign-in")).toBe(false)
    await h.controller.commands.run("files.list", `docs ${repo}`)
    await until(() => h.store.collections.cards.get(`files-${repo}-docs`)?.status === "active")
    expect(refreshes).toBe(2)
  } finally { await h.close() }
})

test("a retry resolving to not-public renders the sign-in gate and never loops the catalog", async () => {
  let refreshes = 0
  const h = await setup(undefined, async input => { if (String(input) === "/api/public/repos") refreshes++; return json(200, { repos: [] }) })
  try {
    await h.ready()
    await catalogFailed(h.store)
    await h.controller.commands.run("files.list", `docs ${repo}`)
    await until(() => h.store.session().pendingCommand?.requirement === "repo-source")
    expect(h.store.session().repositoryEntry?.failureKind).toBe("not-public")
    await h.controller.commands.run("files.list", `docs ${repo}`)
    expect(refreshes).toBe(1)
    expect([...h.store.collections.messages.values()].some(m => m.action?.flow === "auth.sign-in")).toBe(true)
  } finally { await h.close() }
})

for (const scope of ["account", "selection", "entry"] as const) {
  test(`a stale refreshed catalog cannot cross ${scope} ownership`, async () => {
    let release!: (response: Response) => void
    const catalog = new Promise<Response>(resolve => release = resolve)
    const reads: string[] = []
    const h = await setup(undefined, async input => { if (String(input) === "/api/public/repos") return catalog; reads.push(String(input)); return json(200, []) })
    try {
      await catalogFailed(h.store)
      await h.controller.commands.run("files.list", `docs ${repo}`)
      if (scope === "account") await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      if (scope === "selection") {
        await h.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "selected/repo", org: "selected", name: "repo", ownerKind: "user", head: null }] }).isPersisted.promise
        await h.store.dispatch({ type: "repo.selected", actor: "user", id: "selected/repo" }).isPersisted.promise
      }
      if (scope === "entry") beginRepositoryEntry(h.store, "beta/two")
      release(json(200, { repos: [{ name: repo }] }))
      await pause(50)
      expect(reads.filter(path => path.includes("contents/docs"))).toEqual([])
      expect(h.store.collections.repositories.get(repo)).toBeUndefined()
      if (scope === "selection") expect(h.store.session().activeRepoKey).toBe("selected/repo")
      if (scope === "entry") expect(h.store.session().repositoryEntry?.repo).toBe("beta/two")
    } finally { release(json(200, { repos: [] })); await h.close() }
  })
}

test("refresh launch waits for the atomic retry admission commit", async () => {
  let requests = 0
  const h = await setup(undefined, async () => { requests++; return json(200, { repos: [] }) })
  let release!: () => void
  const gate = new Promise<void>(resolve => release = resolve)
  await catalogFailed(h.store)
  const dispatch = h.store.dispatch.bind(h.store)
  const spy = spyOn(h.store, "dispatch").mockImplementation(transition => {
    const result = dispatch(transition)
    if (transition.type !== "command.deferred" || transition.repositoryRetry === undefined) return result
    const persisted = { ...result.isPersisted, promise: gate.then(() => result.isPersisted.promise) }
    return new Proxy(result, { get: (target, key, receiver) => key === "isPersisted" ? persisted : Reflect.get(target, key, receiver) })
  })
  try {
    const command = h.controller.commands.run("files.list", `docs ${repo}`)
    await until(() => h.store.session().repositoryEntry?.phase === "pending")
    await pause(20)
    expect(requests).toBe(0)
    expect(h.store.session().pendingCommand?.requirement).toBe("repository-ready")
    release()
    expect(await command).toMatchObject({ status: "executed", value: "Requested" })
    await until(() => requests === 1)
  } finally { release(); spy.mockRestore(); await h.close() }
})

/*
 * One persisted park, two consumers: the readiness controller owns only
 * "repository-ready", so a first-run wait is invisible to it — proof there is
 * no second mechanism competing for session.pendingCommand.
 */
test("a first-run-target park is inert to the readiness controller", async () => {
  const h = await setup()
  try {
    await h.store.dispatch({ type: "command.deferred", actor: "user", name: "issues.list", args: null, requirement: "first-run-target" }).isPersisted.promise
    await h.ready()
    await pause(30)
    expect(h.store.session().pendingCommand).toMatchObject({ name: "issues.list", requirement: "first-run-target" })
    expect(h.store.collections.toasts.get("toast-repository.ready")).toBeUndefined()
    expect([...h.store.collections.cards.values()]).toEqual([])
  } finally { await h.close() }
})
