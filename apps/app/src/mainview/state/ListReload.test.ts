import { describe, expect, test } from "bun:test"
import type { Repo } from "./AppState"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"

/*
 * `repos.loaded` replaces a list the server owns. A reload whose list
 * overlaps the last one must update the shared rows in place: deleting and
 * re-inserting one key inside a single transaction is refused by the
 * collection ("Unhandled mutation combination: delete-insert"), which left
 * the repo chip empty after the second open.
 */

const boot = (): Promise<AppStore> => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const persisted = async (store: AppStore, transition: Parameters<AppStore["dispatch"]>[0]): Promise<void> => {
  await store.dispatch(transition).isPersisted.promise
}

const repo = (id: string, name = id): Repo => ({
  id,
  path: `/repos/${id}`,
  name,
  git: null,
  smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts", workspaces: [] },
  warnings: []
})

describe("list reloads", () => {
  test("repos.loaded keeps overlapping rows, updates them, adds new ones, and drops the rest", async () => {
    const store = await boot()
    await persisted(store, { type: "repos.loaded", actor: "system", repos: [repo("a"), repo("b")] })
    expect([...store.collections.repos.keys()].sort()).toEqual(["a", "b"])
    await persisted(store, { type: "repos.loaded", actor: "system", repos: [repo("a", "owner/a"), repo("c")] })
    expect([...store.collections.repos.keys()].sort()).toEqual(["a", "c"])
    expect(store.collections.repos.get("a")?.name).toBe("owner/a")
    await persisted(store, { type: "repos.loaded", actor: "system", repos: [] })
    expect(store.collections.repos.size).toBe(0)
  })

})
