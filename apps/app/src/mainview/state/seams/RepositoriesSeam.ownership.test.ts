import { expect, test } from "bun:test"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { memoryStorage, settled, silentAgent } from "../TestFixtures"

type Phase = "inventory" | "heads" | "workspaces"
type Change = "disposal" | "sign-out" | "replacement" | "returning-owner"

const identity = (store: AppStore, login: string | null) => store.dispatch({
  type: "identity.session.loaded", actor: "system", state: login === null ? "signed-out" : "signed-in",
  login, provider: "github", admin: false, scopesPlain: null
}).isPersisted.promise

const cloud = (store: AppStore, username: string | null) => store.dispatch({
  type: "cloud.session.loaded", actor: "system", state: username === null ? "signed-out" : "signed-in",
  username, expiresAt: null, scopes: null
}).isPersisted.promise

const harness = async (phase: Phase, repoStatus = 200, signal?: AbortSignal) => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const requests: string[] = []
  const heldPath = phase === "inventory" ? "/api/user/repos"
    : phase === "heads" ? "/api/repos/alice/private/bookmarks" : "/api/user/workspaces"
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (["/api/user/repos", "/api/user/orgs", "/api/user/workspaces", "/api/repos/alice/private/bookmarks"].includes(path)) requests.push(path)
    if (path === heldPath) { entered.resolve(); await release.promise }
    if (path === "/api/user/repos") return Response.json([
      { owner: "alice", name: "private", full_name: "alice/private", default_bookmark: "main" }
    ], { status: repoStatus })
    if (path === "/api/user/orgs") return Response.json([{ name: "alice" }])
    if (path === "/api/repos/alice/private/bookmarks") return Response.json({ items: [
      { name: "main", target_change_id: "read-change", target_commit_id: "read-commit" }
    ], next_cursor: null })
    if (path === "/api/user/workspaces") return Response.json([
      { workspace_id: "private-workspace", repository_owner: "alice", repository_name: "private", workspace_title: "Review", state: "running" }
    ])
    return Response.json([])
  } })
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await identity(store, "alice")
  await cloud(store, "alice")
  const controller = createAppController(store, silentAgent, {
    baseUrl: server.url.toString().replace(/\/$/, ""),
    fetchImpl: signal === undefined ? Bun.fetch : (input, init) => Bun.fetch(input, {
      ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal
    }),
    applicationIdentity: undefined, features: { suggestionPills: false }, seamTimeoutMs: 10_000
  })
  return { store, controller, entered, release, requests, async close() {
    release.resolve()
    await controller.dispose()
    await server.stop(true)
  } }
}

const projection = (store: AppStore) => ({
  repositories: [...store.collections.repositories.values()], copies: [...store.collections.workingCopies.values()]
})

for (const phase of ["inventory", "heads", "workspaces"] as const) {
  for (const change of ["disposal", "sign-out", "replacement", "returning-owner"] as const satisfies readonly Change[]) {
    test(`repository read retires after ${change} while actual HTTP ${phase} is held`, async () => {
      const t = await harness(phase)
      const pending = t.controller.loadRepositories().then(value => ({ value }), error => ({ error }))
      try {
        await t.entered.promise
        if (change === "disposal") await t.controller.dispose()
        else {
          await identity(t.store, null)
          await cloud(t.store, null)
          if (change !== "sign-out") {
            const owner = change === "replacement" ? "bob" : "alice"
            await identity(t.store, owner)
            await cloud(t.store, owner)
          }
        }
        await settled()
        const before = projection(t.store)
        const beforeRequests = [...t.requests]
        t.release.resolve()
        expect(await pending).toEqual({ value: undefined })
        expect(projection(t.store)).toEqual(before)
        expect(t.requests).toEqual(beforeRequests)
      } finally {
        t.release.resolve()
        await pending
        await t.close()
      }
    })
  }
}

for (const principal of ["identity", "cloud"] as const) {
  test(`a repository read cannot publish after only the ${principal} account changes`, async () => {
    const t = await harness("inventory")
    const pending = t.controller.loadRepositories()
    try {
      await t.entered.promise
      if (principal === "identity") await identity(t.store, "bob")
      else await cloud(t.store, "bob")
      await settled()
      const before = projection(t.store)
      t.release.resolve()
      expect(await pending).toBeUndefined()
      expect(projection(t.store)).toEqual(before)
      expect(t.requests).not.toContain("/api/user/workspaces")
      expect(t.requests).not.toContain("/api/repos/alice/private/bookmarks")
    } finally { t.release.resolve(); await pending.catch(() => {}); await t.close() }
  })
}

test("same-owner refresh preserves normal repository and workspace read completion", async () => {
  const t = await harness("workspaces")
  const pending = t.controller.loadRepositories()
  try {
    await t.entered.promise
    await identity(t.store, "alice")
    await cloud(t.store, "alice")
    t.release.resolve()
    expect(await pending).toBeUndefined()
    expect(projection(t.store)).toEqual({
      repositories: [expect.objectContaining({ id: "alice/private", ownerKind: "org", head: {
        bookmark: "main", changeId: "read-change", commitId: "read-commit"
      } })],
      copies: [expect.objectContaining({ id: "workspace:private-workspace", repoId: "alice/private", state: "running" })]
    })
  } finally { t.release.resolve(); await pending.catch(() => {}); await t.close() }
})

test("a disposed controller starts no new inventory request", async () => {
  const t = await harness("inventory")
  try {
    await t.controller.dispose()
    t.release.resolve()
    expect(await t.controller.loadRepositories()).toBeUndefined()
    expect(t.requests).toEqual([])
  } finally { await t.close() }
})

test("live repository HTTP failures remain refusals without publishing an inventory", async () => {
  const t = await harness("inventory", 503)
  try {
    t.release.resolve()
    expect(await t.controller.loadRepositories()).toContain("Reading from Smithers Cloud failed (503)")
    expect(projection(t.store)).toEqual({ repositories: [], copies: [] })
    expect(t.requests).not.toContain("/api/user/workspaces")
  } finally { await t.close() }
})

test("a live cancelled HTTP inventory read remains a refusal and publishes nothing", async () => {
  const cancellation = new AbortController()
  const t = await harness("inventory", 200, cancellation.signal)
  const pending = t.controller.loadRepositories()
  try {
    await t.entered.promise
    cancellation.abort()
    expect(await pending).toContain("Could not reach Smithers Cloud.")
    expect(projection(t.store)).toEqual({ repositories: [], copies: [] })
    expect(t.requests).not.toContain("/api/user/workspaces")
  } finally { t.release.resolve(); await pending.catch(() => {}); await t.close() }
})
