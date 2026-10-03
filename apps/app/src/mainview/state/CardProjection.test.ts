import { afterEach, expect, test } from "bun:test"
import { createAppStore, type AppStore } from "./AppStore"
import { CardSchema } from "@smthrs/rpc/Cards"

const stores: AppStore[] = []
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.dispose?.())) })

test("historical target tombstones remain inert across star changes and reload", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const store = await createAppStore({ kind: "localStorage", storage }); stores.push(store)
  const card = CardSchema.parse({
    id: "targets-a", kind: "targets", title: "Targets", createdAt: 1, ordinal: 0, status: "active",
    payload: { repoId: "old-host-id", repoKey: "local:/repo", repoName: "repo", status: "done", targets: [], warnings: [], starred: ["//:stale-copy"] }
  })
  for (const id of ["targets-a", "targets-b"]) await store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, id } }).isPersisted.promise
  const before = structuredClone([...store.collections.cards.values()])
  await store.dispatch({ type: "target.starred", actor: "user", repoId: "new-host-id", star: {
    id: "local:/repo:://:test", repoKey: "local:/repo", label: "//:test", starredAt: 2
  } }).isPersisted.promise
  expect([...store.collections.cards.values()]).toEqual(before)
  expect(card.kind).toBe("retired")
  expect(card.title).toBe("Targets")
  expect(card.payload).toEqual({ was: "targets" })
  expect([...store.collections.starredTargets.values()].map(({ id, repoKey, label, starredAt }) => ({ id, repoKey, label, starredAt }))).toEqual([{ id: "local:/repo:://:test", repoKey: "local:/repo", label: "//:test", starredAt: 2 }])
  await store.dispatch({ type: "target.unstarred", actor: "user", repoId: "new-host-id", id: "local:/repo:://:test" }).isPersisted.promise
  expect([...store.collections.starredTargets.values()]).toEqual([])
  expect([...store.collections.cards.values()]).toEqual(before)
  expect((await store.verifyState()).valid).toBe(true)
  await store.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage }); stores.push(reopened)
  expect(reopened.collections.cards.get(card.id)).toEqual(before.find(row => row.id === card.id))
  expect([...reopened.collections.starredTargets.values()]).toEqual([])
})
