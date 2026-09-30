import { expect, test } from "bun:test"
import type { RepositoryHome } from "@smthrs/rpc/RepositoryHome"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createControllerContext } from "../controller/context"
import { json, memoryStorage, settled, unavailableAgent, waitFor } from "../TestFixtures"
import { createRepositoryFlowsSeam } from "./RepositoryFlowsSeam"

const repo = "alice/private"
const identity = (store: AppStore, login: string | null) => store.dispatch({
  type: "identity.session.loaded", actor: "system", state: login === null ? "signed-out" : "signed-in",
  login, admin: false, scopesPlain: null
}).isPersisted.promise
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const home = (text: string): RepositoryHome => ({ kind: "blocks", blocks: [{ type: "text", text }] })

const harness = async (login: string | null = "alice") => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await identity(store, login)
  const reads: Array<ReturnType<typeof deferred<Response>>> = []
  const context = createControllerContext(store, unavailableAgent, { fetchImpl: async input => {
    if (String(input).endsWith("/home")) {
      const response = deferred<Response>()
      reads.push(response)
      return response.promise
    }
    return json(404, {})
  } })
  const published: unknown[] = []
  const seam = createRepositoryFlowsSeam({
    store, baseUrl: "https://app.test", http: context.boundedFetch, dispatch: store.dispatch,
    actor: () => "user", nextOrdinal: store.nextOrdinal, isDisposed: () => context.disposed
  }, (_, value) => { published.push(value) })
  seam.subscribe(context.onDispose)
  return { store, storage, reads, published, seam, context, dispose: async () => {
    for (const read of reads) read.resolve(json(404, {}))
    await context.dispose()
    await settled()
    await store.dispose?.()
  } }
}

for (const change of ["sign-out", "replacement", "returning-owner"] as const) {
  test(`a pending private homepage cannot repopulate the store after ${change}`, async () => {
    const t = await harness()
    try {
      const pending = t.seam.load(repo)
      await waitFor(() => t.reads.length === 1)
      await identity(t.store, change === "replacement" ? "bob" : null)
      if (change === "returning-owner") await identity(t.store, "alice")
      t.reads[0]!.resolve(json(200, home("ALICE_PRIVATE_HOMEPAGE")))
      await pending
      expect(t.store.collections.repositoryFlows.has(repo)).toBe(false)
      expect(t.published).toEqual([])
      await t.store.dispose?.()
      const reopened = await createAppStore({ kind: "localStorage", storage: t.storage })
      try { expect(reopened.collections.repositoryFlows.has(repo)).toBe(false) }
      finally { await reopened.dispose?.() }
    } finally { await t.dispose() }
  })
}

test("a same-owner identity refresh keeps a pending homepage current", async () => {
  const t = await harness()
  try {
    const pending = t.seam.load(repo)
    await waitFor(() => t.reads.length === 1)
    await identity(t.store, "alice")
    t.reads[0]!.resolve(json(200, home("Current homepage")))
    await pending
    expect(t.store.collections.repositoryFlows.get(repo)?.home).toEqual(home("Current homepage"))
    expect(t.published).toEqual([home("Current homepage")])
  } finally { await t.dispose() }
})

test("a superseded homepage read cannot replace the newer read", async () => {
  const t = await harness()
  try {
    const older = t.seam.load(repo)
    await waitFor(() => t.reads.length === 1)
    const newer = t.seam.load(repo)
    await waitFor(() => t.reads.length === 2)
    t.reads[1]!.resolve(json(200, home("New homepage")))
    await newer
    t.reads[0]!.resolve(json(200, home("Old homepage")))
    await older
    expect(t.store.collections.repositoryFlows.get(repo)?.home).toEqual(home("New homepage"))
    expect(t.published).toEqual([home("New homepage")])
  } finally { await t.dispose() }
})

test("reading another repository does not retire the first repository's result", async () => {
  const t = await harness()
  try {
    const first = t.seam.load(repo)
    await waitFor(() => t.reads.length === 1)
    const second = t.seam.load("alice/other")
    await waitFor(() => t.reads.length === 2)
    t.reads[1]!.resolve(json(200, home("Other repository")))
    await second
    t.reads[0]!.resolve(json(200, home("First repository")))
    await first
    expect(t.store.collections.repositoryFlows.get(repo)?.home).toEqual(home("First repository"))
    expect(t.store.collections.repositoryFlows.get("alice/other")?.home).toEqual(home("Other repository"))
  } finally { await t.dispose() }
})

test("sign-in rereads a homepage that was inaccessible to the anonymous visitor", async () => {
  const t = await harness(null)
  try {
    await t.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
      { id: repo, org: "alice", name: "private", ownerKind: "user", head: null }
    ] }).isPersisted.promise
    await waitFor(() => t.reads.length === 1)
    t.reads[0]!.resolve(json(404, {}))
    await waitFor(() => t.store.collections.repositoryFlows.has(repo))
    expect(t.store.collections.repositoryFlows.get(repo)?.home).toEqual({ kind: "none" })
    await identity(t.store, "alice")
    await waitFor(() => t.reads.length === 2)
    t.reads[1]!.resolve(json(200, home("Authenticated homepage")))
    await waitFor(() => JSON.stringify(t.store.collections.repositoryFlows.get(repo)?.home)?.includes("Authenticated homepage") === true)
    await identity(t.store, "alice")
    await settled()
    expect(t.reads).toHaveLength(2)
  } finally { await t.dispose() }
})

test("disposing a controller retires its pending homepage", async () => {
  const t = await harness()
  try {
    const pending = t.seam.load(repo)
    await waitFor(() => t.reads.length === 1)
    await t.context.dispose()
    t.reads[0]!.resolve(json(200, home("Retired homepage")))
    await pending
    expect(t.store.collections.repositoryFlows.has(repo)).toBe(false)
    expect(t.published).toEqual([])
  } finally { await t.dispose() }
})
