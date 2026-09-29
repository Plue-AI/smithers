import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerContext } from "./ControllerContext"
import { WorldSurface } from "./WorldSurface"
import { scopedControllers } from "./state/ControllerTestScope"
import { createAppStore } from "./state/AppStore"
import { createCloudWikiController } from "./state/controller/cloud-wiki"
import { createControllerContext } from "./state/controller/context"
import { memoryStorage, silentAgent, waitFor } from "./state/TestFixtures"

GlobalRegistrator.register()
afterAll(async () => { await GlobalRegistrator.unregister() })
const createController = scopedControllers()
const repo = "org/repo"
const privatePage = {
  id: 7, slug: "incident", title: "ALICE PRIVATE INCIDENT", path: "Private/Incident.md",
  revision: 1, author: { id: 1, login: "alice" }, created_at: "2026-09-29T00:00:00Z",
  updated_at: "2026-09-29T00:00:00Z", metadata: {
    frontmatter: null, aliases: [], tags: ["ALICE-SECRET-TAG"], headings: [], links: []
  }, backlinks: []
}
const index = { pages: [privatePage], folders: ["Private"], tags: ["ALICE-SECRET-TAG"] }
const signedIn = (login: string) => ({ state: "signed-in" as const, login, allowlisted: true, admin: false })

const fixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let answer: () => Promise<Response> = async () => Response.json(index)
  const requests: string[] = []
  const controller = createController(store, silentAgent, { fetchImpl: async input => {
    const path = new URL(String(input), "https://app.test").pathname
    requests.push(path)
    if (path.endsWith("/wiki/navigation/index")) return answer()
    if (path === "/api/auth/logout") return new Response(null, { status: 204 })
    if (path === "/api/auth/session") return Response.json(signedIn("alice"))
    return Response.json({})
  } })
  await controller.adoptSession(signedIn("alice"))
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
    { id: repo, org: "org", ownerKind: "user", name: "repo", head: null }
  ] }).isPersisted.promise
  await store.dispatch({ type: "wiki.space.changed", actor: "user", space: "private" }).isPersisted.promise
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = () => flushSync(() => root.render(
    <ControllerContext value={controller}><WorldSurface documents={[]} /></ControllerContext>
  ))
  render()
  return { store, controller, host, requests, render, answer: (next: () => Promise<Response>) => { answer = next },
    close: async () => {
      const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
      const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
      try { await act(async () => { root.unmount(); await controller.dispose(); await store.dispose?.() }) }
      finally { actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous; host.remove() }
    } }
}

for (const nextLogin of ["bob", "alice"] as const) test(`sign-out and a refused read for ${nextLogin} remove private Wiki navigation from the mounted pane`, async () => {
  const f = await fixture()
  try {
    expect(await f.controller.loadWikiIndex(repo, "private")).toEqual({ value: expect.stringContaining("1 private") })
    await waitFor(() => f.host.textContent?.includes("ALICE PRIVATE INCIDENT") === true)
    expect(f.host.textContent).toContain("ALICE-SECRET-TAG")

    expect(await f.controller.signOut()).toBeUndefined()
    await waitFor(() => f.host.textContent?.includes("ALICE PRIVATE INCIDENT") === false)
    expect(f.controller.wikiIndexes.get(repo, "private")?.pages ?? []).toEqual([])
    expect(f.host.textContent).not.toContain("ALICE PRIVATE INCIDENT")
    expect(f.host.textContent).not.toContain("ALICE-SECRET-TAG")

    await f.controller.adoptSession(signedIn(nextLogin))
    await f.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
      { id: repo, org: "org", ownerKind: "user", name: "repo", head: null }
    ] }).isPersisted.promise
    await f.store.dispatch({ type: "wiki.space.changed", actor: "user", space: "private" }).isPersisted.promise
    f.answer(async () => Response.json({ message: "Forbidden" }, { status: 403 }))
    expect(await f.controller.loadWikiIndex(repo, "private")).toContain("Forbidden")
    await waitFor(() => f.host.textContent?.includes("Forbidden") === true)
    expect(f.host.textContent).toContain("Forbidden")
    expect(f.host.textContent).not.toContain("ALICE PRIVATE INCIDENT")
    expect(f.host.textContent).not.toContain("ALICE-SECRET-TAG")
    expect(f.requests.filter(path => path.endsWith("/wiki/navigation/index"))).toHaveLength(2)
  } finally { await f.close() }
})

test("adopting Bob directly clears Alice's private navigation and notifies the mounted pane", async () => {
  const f = await fixture()
  try {
    await f.controller.loadWikiIndex(repo, "private")
    await waitFor(() => f.host.textContent?.includes("ALICE PRIVATE INCIDENT") === true)
    let notifications = 0
    const unsubscribe = f.controller.wikiIndexes.subscribe(() => { notifications++ })
    try {
      await f.controller.adoptSession(signedIn("bob"))
      await waitFor(() => f.host.textContent?.includes("ALICE PRIVATE INCIDENT") === false)
      expect(notifications).toBeGreaterThan(0)
      const row = f.controller.wikiIndexes.get(repo, "private")
      expect(row?.pages ?? []).toEqual([])
      expect(row?.folders ?? []).toEqual([])
      expect(row?.tags ?? []).toEqual([])
      expect(f.host.textContent).not.toContain("ALICE-SECRET-TAG")
    } finally { unsubscribe() }
  } finally { await f.close() }
})

for (const nextLogin of ["bob", "alice"] as const) test(`a private index response held across retirement cannot repopulate ${nextLogin}'s pane`, async () => {
  const f = await fixture()
  const held = Promise.withResolvers<Response>()
  try {
    f.answer(() => held.promise)
    const oldRead = f.controller.loadWikiIndex(repo, "private")
    await waitFor(() => f.requests.some(path => path.endsWith("/wiki/navigation/index")))
    expect(await f.controller.signOut()).toBeUndefined()
    held.resolve(Response.json(index))
    expect(await oldRead).toBe("The account or conversation changed while the Wiki was loading.")
    expect(f.store.collections.toasts.get("toast-wiki.index.org/repo.private")).toBeUndefined()
    expect([...f.store.collections.toasts.values()].some(toast => toast.key === "wiki.index.org/repo.private")).toBe(false)
    await f.controller.adoptSession(signedIn(nextLogin))
    await f.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
      { id: repo, org: "org", ownerKind: "user", name: "repo", head: null }
    ] }).isPersisted.promise
    await f.store.dispatch({ type: "wiki.space.changed", actor: "user", space: "private" }).isPersisted.promise
    expect(f.controller.wikiIndexes.get(repo, "private")?.pages ?? []).toEqual([])
    expect(f.host.textContent).not.toContain("ALICE PRIVATE INCIDENT")
    expect(f.host.textContent).not.toContain("ALICE-SECRET-TAG")
    f.answer(async () => Response.json({ message: "Forbidden" }, { status: 403 }))
    expect(await f.controller.loadWikiIndex(repo, "private")).toContain("Forbidden")
    await waitFor(() => f.host.textContent?.includes("Forbidden") === true)
    expect(f.controller.wikiIndexes.get(repo, "private")?.pages ?? []).toEqual([])
    expect(f.host.textContent).not.toContain("ALICE PRIVATE INCIDENT")
  } finally { held.resolve(Response.json(index)); await f.close() }
})

test("disposing a controller clears its index and refuses a held response", async () => {
  const f = await fixture()
  const held = Promise.withResolvers<Response>()
  try {
    await f.controller.loadWikiIndex(repo, "private")
    await waitFor(() => f.host.textContent?.includes("ALICE PRIVATE INCIDENT") === true)
    f.answer(() => held.promise)
    const oldRead = f.controller.loadWikiIndex(repo, "private")
    await waitFor(() => f.requests.filter(path => path.endsWith("/wiki/navigation/index")).length === 2)
    await f.controller.dispose()
    held.resolve(Response.json(index))
    expect(await oldRead).toBe("The app closed while the Wiki was loading.")
    expect(f.controller.wikiIndexes.get(repo, "private")?.pages ?? []).toEqual([])
  } finally { held.resolve(Response.json(index)); await f.close() }
})

for (const status of [401, 403, 404, 410, 451] as const) test(`a denied private read (${status}) clears old metadata and a retry replaces it`, async () => {
  const f = await fixture()
  try {
    await f.controller.loadWikiIndex(repo, "private")
    await waitFor(() => f.host.textContent?.includes("ALICE PRIVATE INCIDENT") === true)
    f.answer(async () => Response.json({ message: "Access unavailable" }, { status }))
    expect(await f.controller.loadWikiIndex(repo, "private")).toContain("Access unavailable")
    await waitFor(() => f.host.textContent?.includes("Access unavailable") === true)
    expect(f.controller.wikiIndexes.get(repo, "private")?.pages ?? []).toEqual([])
    expect(f.host.textContent).not.toContain("ALICE PRIVATE INCIDENT")
    expect(f.host.textContent).not.toContain("ALICE-SECRET-TAG")

    f.answer(async () => Response.json({ pages: [], folders: [], tags: [] }))
    expect(await f.controller.loadWikiIndex(repo, "private")).toEqual({ value: expect.stringContaining("0 private") })
    await waitFor(() => f.host.textContent?.includes("Access unavailable") === false)
    expect(f.controller.wikiIndexes.get(repo, "private")?.error).toBeUndefined()
  } finally { await f.close() }
})


test("ending an account clears the loaded index synchronously before its identity row changes", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
    allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, silentAgent, { fetchImpl: async () => Response.json(index) })
  ctx.withToast = async (_key, _title, _doneTitle, work) => work()
  const wiki = createCloudWikiController(ctx, store.nextOrdinal)
  try {
    await wiki.loadWikiIndex(repo, "private")
    expect(wiki.wikiIndexes.get(repo, "private")?.pages).toHaveLength(1)
    const unsubscribeThrowing = wiki.wikiIndexes.subscribe(() => { throw new Error("broken Wiki subscriber") })
    let notifications = 0
    const unsubscribe = wiki.wikiIndexes.subscribe(() => { notifications++ })
    try {
      const epoch = ctx.accountEpoch
      ctx.endAccount()
      expect(ctx.accountEpoch).toBe(epoch + 1)
      expect(store.collections.identitySessions.get("identity")?.login).toBe("alice")
      expect(wiki.wikiIndexes.get(repo, "private")?.pages ?? []).toEqual([])
      expect(notifications).toBeGreaterThan(0)
    } finally { unsubscribe(); unsubscribeThrowing() }
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test("switching conversation branches retains the loaded private index for the same account", async () => {
  const f = await fixture()
  try {
    await f.controller.loadWikiIndex(repo, "private")
    await waitFor(() => f.host.textContent?.includes("ALICE PRIVATE INCIDENT") === true)
    const original = f.store.session().activeBranchId
    const card = { id: "wiki-branch-card", kind: "status" as const, title: "Wiki", status: "active" as const,
      createdAt: 1, ordinal: 0, payload: { progress: 0.5 } }
    await f.store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    f.controller.maximizeCard(card.id)
    await waitFor(() => f.store.session().maximizedCardId === card.id)
    expect(await f.controller.forkFrame()).toBeUndefined()
    await waitFor(() => f.store.session().activeBranchId !== original)
    expect(f.controller.wikiIndexes.get(repo, "private")?.pages.map(page => page.title)).toEqual(["ALICE PRIVATE INCIDENT"])
    expect(f.host.textContent).toContain("ALICE PRIVATE INCIDENT")
  } finally { await f.close() }
})

test("a transient 500 preserves the same owner's index, while a 403 clears its metadata", async () => {
  const f = await fixture()
  try {
    await f.controller.loadWikiIndex(repo, "private")
    await waitFor(() => f.host.textContent?.includes("ALICE PRIVATE INCIDENT") === true)
    f.answer(async () => Response.json({ message: "Temporary failure" }, { status: 500 }))
    expect(await f.controller.loadWikiIndex(repo, "private")).toContain("Temporary failure")
    expect(f.controller.wikiIndexes.get(repo, "private")?.pages.map(page => page.title)).toEqual(["ALICE PRIVATE INCIDENT"])
    expect(f.controller.wikiIndexes.get(repo, "private")?.folders).toEqual(["Private"])
    expect(f.controller.wikiIndexes.get(repo, "private")?.tags).toEqual(["ALICE-SECRET-TAG"])
    expect(f.host.textContent).toContain("ALICE PRIVATE INCIDENT")
    f.answer(async () => Response.json({ message: "Forbidden" }, { status: 403 }))
    expect(await f.controller.loadWikiIndex(repo, "private")).toContain("Forbidden")
    await waitFor(() => f.host.textContent?.includes("ALICE PRIVATE INCIDENT") === false)
    expect(f.controller.wikiIndexes.get(repo, "private")?.pages ?? []).toEqual([])
    expect(f.controller.wikiIndexes.get(repo, "private")?.folders ?? []).toEqual([])
    expect(f.controller.wikiIndexes.get(repo, "private")?.tags ?? []).toEqual([])
  } finally { await f.close() }
})


test("a response held across a branch fork cannot write an index into the new branch", async () => {
  const f = await fixture()
  const held = Promise.withResolvers<Response>()
  try {
    f.answer(() => held.promise)
    const oldRead = f.controller.loadWikiIndex(repo, "private")
    await waitFor(() => f.requests.some(path => path.endsWith("/wiki/navigation/index")))
    const original = f.store.session().activeBranchId
    const card = { id: "wiki-held-branch-card", kind: "status" as const, title: "Wiki", status: "active" as const,
      createdAt: 1, ordinal: 0, payload: { progress: 0.5 } }
    await f.store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    f.controller.maximizeCard(card.id)
    await waitFor(() => f.store.session().maximizedCardId === card.id)
    expect(await f.controller.forkFrame()).toBeUndefined()
    await waitFor(() => f.store.session().activeBranchId !== original)
    held.resolve(Response.json(index))
    expect(await oldRead).toBe("The account or conversation changed while the Wiki was loading.")
    expect(f.controller.wikiIndexes.get(repo, "private")?.pages ?? []).toEqual([])
    expect(f.host.textContent).not.toContain("ALICE PRIVATE INCIDENT")
  } finally { held.resolve(Response.json(index)); await f.close() }
})
