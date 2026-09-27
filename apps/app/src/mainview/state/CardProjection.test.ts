import { afterEach, expect, test } from "bun:test"
import { createAppStore, type AppStore } from "./AppStore"
import { projectTargetStars } from "./CardProjection"
import type { Card } from "./AppState"

const stores: AppStore[] = []
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.dispose?.())) })

test("current and historical target cards join one star projection without copying star changes", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const store = await createAppStore({ kind: "localStorage", storage }); stores.push(store)
  const card: Extract<Card, { kind: "targets" }> = {
    id: "targets-a", kind: "targets", title: "Targets", createdAt: 1, ordinal: 0, status: "active",
    payload: { repoId: "old-host-id", repoKey: "local:/repo", repoName: "repo", status: "done", targets: [], warnings: [], starred: ["//:stale-copy"] }
  }
  for (const id of ["targets-a", "targets-b"]) await store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, id } }).isPersisted.promise
  const before = structuredClone([...store.collections.cards.values()])
  await store.dispatch({ type: "target.starred", actor: "user", repoId: "new-host-id", star: {
    id: "local:/repo:://:test", repoKey: "local:/repo", label: "//:test", starredAt: 2
  } }).isPersisted.promise
  expect([...store.collections.cards.values()]).toEqual(before)
  const project = (value: typeof card) => projectTargetStars(value, [...store.collections.starredTargets.values()])
  expect(project(card).payload.starred).toEqual(["//:test"])
  for (const row of store.collections.cards.values()) if (row.kind === "targets") expect(project(row).payload.starred).toEqual(["//:test"])
  await store.dispatch({ type: "target.unstarred", actor: "user", repoId: "new-host-id", id: "local:/repo:://:test" }).isPersisted.promise
  expect(project(card).payload.starred).toEqual([])
  expect([...store.collections.cards.values()]).toEqual(before)
  expect((await store.verifyState()).valid).toBe(true)
  await store.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage }); stores.push(reopened)
  const restored = reopened.collections.cards.get(card.id) as typeof card
  expect(projectTargetStars(restored, [...reopened.collections.starredTargets.values()]).payload.starred).toEqual([])
})
