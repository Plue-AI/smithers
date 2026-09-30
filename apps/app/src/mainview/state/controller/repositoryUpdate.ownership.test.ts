import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { memoryStorage, waitFor } from "../TestFixtures"
import type { SeamContext } from "../seams/SeamContext"
import { createRepositoryUpdate } from "./repositoryUpdate"

const repo = "alice/private"
const identity = (store: AppStore, login: string | null, provider: "github" | "local" = "github") => store.dispatch({
  type: "identity.session.loaded", actor: "system", state: login === null ? "signed-out" : "signed-in",
  login, provider, admin: false, scopesPlain: null
}).isPersisted.promise
const issue = (title = "PRIVATE_ISSUE") => Response.json([{ number: 1, title, state: "open", updated_at: "2026-09-27T00:00:00Z" }])
type Phase = "network" | "repo.update.observed" | "repo.update.published"

const harness = async (phase: Phase, actor: "user" | "smithers" = "user") => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await identity(store, "alice")
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let held = false
  const ctx: SeamContext = {
    store, baseUrl: "https://app.test", actor: () => actor, nextOrdinal: store.nextOrdinal,
    http: async url => {
      if (!url.includes("/issues?state=open")) return Response.json([])
      if (phase === "network") { entered.resolve(); await release.promise }
      return issue()
    },
    dispatch: transition => {
      const transaction = store.dispatch(transition)
      if (transition.type !== phase || held) return transaction
      held = true
      return new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
        ? { ...target.isPersisted, promise: target.isPersisted.promise.then(async value => { entered.resolve(); await release.promise; return value }) }
        : Reflect.get(target, key, receiver) })
    }
  }
  return { store, storage, entered, release, actions: createRepositoryUpdate(ctx), ctx }
}

for (const actor of ["user", "smithers"] as const) {
  for (const change of ["returning-owner", "provider"] as const) {
    test(`${actor} repository activity discards a delayed read after ${change}`, async () => {
      const t = await harness("network", actor)
      try {
        const pending = actor === "user" ? t.actions.showRepoOverview(repo) : t.actions.updateRepo(repo)
        await t.entered.promise
        if (change === "returning-owner") { await identity(t.store, null); await identity(t.store, "alice") }
        else await identity(t.store, "alice", "local")
        const before = await t.store.eventHistory()
        t.release.resolve()
        expect(await pending).toBe("The repository or account changed while its update was loading.")
        expect((await t.store.eventHistory()).head).toEqual(before.head)
        expect(t.store.collections.repositoryContexts.size).toBe(0)
        expect(t.store.collections.repositoryNotifications.size).toBe(0)
        expect(t.store.collections.cards.size).toBe(0)
      } finally { t.release.resolve(); await t.store.dispose?.() }
    })
  }
}

for (const phase of ["repo.update.observed", "repo.update.published"] as const) {
  for (const change of ["account", "repository"] as const) {
    test(`repository activity stays scoped while the ${phase} receipt is pending (${change})`, async () => {
      const t = await harness(phase)
      try {
        if (change === "repository") await t.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
          { id: "alice/other", org: "alice", name: "other", ownerKind: "user", head: null }
        ] }).isPersisted.promise
        const pending = t.actions.showRepoOverview(repo)
        await t.entered.promise
        if (change === "account") await identity(t.store, "bob")
        else {
          await t.store.dispatch({ type: "repo.selected", actor: "user", id: "alice/other" }).isPersisted.promise
          expect(t.store.session().activeRepoKey).toBe("alice/other")
        }
        const before = await t.store.eventHistory()
        t.release.resolve()
        expect(await pending).toBe("The repository or account changed while its update was loading.")
        expect((await t.store.eventHistory()).head).toEqual(before.head)
        if (change === "account") {
          expect(t.store.collections.repositoryContexts.size).toBe(0)
          expect(t.store.collections.repositoryNotifications.size).toBe(0)
          expect(t.store.collections.cards.size).toBe(0)
          await t.store.dispose?.()
          const reopened = await createAppStore({ kind: "localStorage", storage: t.storage })
          try { expect(reopened.collections.cards.size).toBe(0) }
          finally { await reopened.dispose?.() }
        }
      } finally { t.release.resolve(); await t.store.dispose?.() }
    })
  }
}

test("returning to an account starts fresh activity work and old completion cannot remove its deduplication", async () => {
  const t = await harness("network")
  const replies: Array<ReturnType<typeof Promise.withResolvers<Response>>> = []
  const work: Array<Promise<unknown>> = []
  const actions = createRepositoryUpdate({ ...t.ctx, http: async url => {
    if (!url.includes("/issues?state=open")) return Response.json([])
    const reply = Promise.withResolvers<Response>()
    replies.push(reply)
    return reply.promise
  } })
  try {
    const old = actions.updateRepo(repo)
    work.push(old)
    await waitFor(() => replies.length === 1)
    await identity(t.store, null)
    await identity(t.store, "alice")
    const fresh = actions.updateRepo(repo)
    work.push(fresh)
    await waitFor(() => replies.length === 2)
    replies[0]!.resolve(issue("Retired issue"))
    expect(await old).toBe("The repository or account changed while its update was loading.")
    const duplicate = actions.updateRepo(repo)
    work.push(duplicate)
    replies[1]!.resolve(issue("Current issue"))
    expect(await fresh).toEqual({ value: expect.stringContaining("Current issue") })
    expect(await duplicate).toEqual(await fresh)
    expect(replies).toHaveLength(2)
  } finally {
    for (const reply of replies) reply.resolve(Response.json([]))
    await Promise.allSettled(work)
    await t.store.dispose?.()
  }
})

test("a same-owner identity refresh shares the pending activity read", async () => {
  const t = await harness("network")
  try {
    const first = t.actions.updateRepo(repo)
    await t.entered.promise
    await identity(t.store, "alice")
    const duplicate = t.actions.updateRepo(repo)
    t.release.resolve()
    const result = await first
    expect(result).toEqual({ value: expect.stringContaining("PRIVATE_ISSUE") })
    expect(await duplicate).toEqual(result)
    expect(t.store.collections.repositoryContexts.size).toBe(1)
  } finally { t.release.resolve(); await t.store.dispose?.() }
})
