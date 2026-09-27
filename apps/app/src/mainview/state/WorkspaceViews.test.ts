import { memoryStorage } from "./TestFixtures"
import { describe, expect, test } from "bun:test"
import { cardFrameId, rootFrameId, sharedCopyIdOf } from "./AppState"
import type { Card, CloudWorkspaceInput } from "./AppState"
import { createAppStore } from "./AppStore"
import { isReadOnlyCopy, workingCopyLabel, workspaceCardFacts } from "./WorkspaceViews"

const workspace: CloudWorkspaceInput = {
  id: "computer",
  repoId: "org/repo",
  name: "Computer",
  status: "running",
  targetBookmark: "main",
  provisioningStage: null,
  suspendedAt: null,
  createdAt: null,
  head: { changeId: "change", commitId: "commit" }
}
const card: Card = {
  id: "workspace-computer",
  kind: "workspace",
  title: "Computer",
  status: "active",
  createdAt: 1,
  ordinal: 1,
  payload: {
    ...workspaceCardFacts(workspace),
    bookmarkHead: null,
    sessions: [],
    files: [],
    facet: "files"
  }
}

test("one workspace update drives both live views while frame captures remain fixed, including after restore and restart", async () => {
  const data = new Map<string, string>()
  const backend = {
    kind: "localStorage" as const,
    storage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value)
      },
      removeItem: (key: string) => {
        data.delete(key)
      }
    }
  }
  const store = await createAppStore(backend)
  const apply = async (transition: Parameters<typeof store.dispatch>[0]) =>
    store.dispatch(transition).isPersisted.promise
  await apply({ type: "workspace.updated", actor: "system", workspace })
  await apply({ type: "card.upsert", actor: "system", card })
  await apply({ type: "card.maximized", actor: "user", id: card.id })
  const { activeBranchId: branchId, activeWorkspaceId: workspaceId } = store.session()
  const captured = store.collections.frames.get(cardFrameId(branchId!, card.id))!.snapshot!
  await apply({
    type: "workspace.updated",
    actor: "system",
    workspace: {
      ...workspace,
      name: "Renamed",
      status: "failed",
      failureMessage: "Stopped by the provider",
      head: null
    }
  })
  expect(store.collections.workingCopies.get("workspace:computer")).toMatchObject({ label: "Renamed", state: "failed" })
  expect(store.collections.cards.get(card.id)).toMatchObject({
    title: "Renamed · org/repo",
    payload: {
      name: "Renamed",
      status: "failed",
      head: null,
      failureMessage: "Stopped by the provider",
      files: [],
      facet: "files"
    }
  })
  expect(captured.cards[0]).toMatchObject({ payload: { name: "Computer", status: "running", snapshot: true } })

  // Archive the current facts, then change the live row while that branch is absent.
  await apply({ type: "conversation.cleared", actor: "user", branchId: "next-conversation", notes: [] })
  await apply({ type: "workspace.updated", actor: "system", workspace })
  await apply({
    type: "frame.navigated",
    actor: "user",
    workspaceId: workspaceId!,
    branchId: branchId!,
    frameId: rootFrameId(branchId!)
  })
  expect(store.collections.cards.get(card.id)).toMatchObject({ payload: { status: "failed", snapshot: true } })
  expect(store.collections.workingCopies.get("workspace:computer")).toMatchObject({ state: "running" })
  await store.dispose?.()

  const reopened = await createAppStore(backend)
  expect(reopened.collections.cards.get(card.id)).toMatchObject({ payload: { status: "failed", snapshot: true } })
  expect(reopened.collections.workingCopies.get("workspace:computer")).toMatchObject({ state: "running" })
  await reopened.dispose?.()
})

test("full rows supersede legacy inventory; leaving the scope captures the last live card facts", async () => {
  const store = await createAppStore({
    kind: "localStorage",
    storage: memoryStorage()
  })
  await store.dispatch({
    type: "workingcopies.workspaces.loaded",
    actor: "system",
    copies: [{
      id: "workspace:computer",
      workspaceId: "computer",
      repoId: "org/repo",
      kind: "workspace",
      label: "Old name"
    }]
  }).isPersisted.promise
  expect(store.collections.workingCopies.get("workspace:computer")?.label).toBe("Old name")
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  await store.dispatch({
    type: "workspace.updated",
    actor: "system",
    workspace: { ...workspace, name: "Renamed", status: "suspended" }
  }).isPersisted.promise
  expect([...store.collections.workingCopies.values()]).toMatchObject([{ label: "Renamed", state: "suspended" }])
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [], repoId: "org/repo" }).isPersisted
    .promise
  expect(store.collections.workingCopies.size).toBe(0)
  expect(store.collections.cards.get(card.id)).toMatchObject({
    payload: { name: "Renamed", status: "suspended" }
  })
  await store.dispatch({ type: "workspace.updated", actor: "system", workspace }).isPersisted.promise
  expect(store.collections.cards.get(card.id)).toMatchObject({ payload: { name: "Computer", status: "running" } })
  await store.dispose?.()
})

/*
 * The shared copy (design session ruling, lane plan B2): the one read-only virtual box every
 * reader of a public catalog repository shares over the mirror. It is a
 * materialized view over the repositories collection, never a stored row:
 * present while the catalog row stands and no box of the visitor's own
 * stands on that repository, gone the moment either changes.
 */
describe("the shared read-only copy of a catalog repository", () => {
  const memory = () => {
    const data = new Map<string, string>()
    return {
      data,
      backend: {
        kind: "localStorage" as const,
        storage: {
          getItem: (key: string) => data.get(key) ?? null,
          setItem: (key: string, value: string) => void data.set(key, value),
          removeItem: (key: string) => void data.delete(key)
        }
      }
    }
  }
  const catalogRow = (head: { bookmark: string; changeId: string | null; commitId: string | null } | null) => ({
    id: "smithersai/smithers",
    org: "smithersai",
    ownerKind: "org" as const,
    name: "smithers",
    head,
    catalog: true as const,
    summary: "Smithers is a durable framework."
  })

  test("a catalog row derives one shared copy: kind shared, access read, the row's head bookmark, labelled `<bookmark> · shared · read-only`", async () => {
    const { data, backend } = memory()
    const store = await createAppStore(backend)
    await store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        catalogRow({ bookmark: "main", changeId: null, commitId: null }),
        // The signed-in inventory's row is not a catalog row: no shared copy.
        { id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: { bookmark: "main", changeId: "q", commitId: "c" } }
      ]
    }).isPersisted.promise
    const shared = store.collections.workingCopies.get(sharedCopyIdOf("smithersai/smithers"))
    expect(shared).toMatchObject({
      id: "shared:smithersai/smithers",
      repoId: "smithersai/smithers",
      kind: "shared",
      access: "read",
      bookmark: "main",
      label: "shared"
    })
    expect(shared?.workspaceId).toBeUndefined()
    expect(workingCopyLabel(shared!)).toBe("main · shared · read-only")
    expect(isReadOnlyCopy(shared!)).toBe(true)
    expect(store.collections.workingCopies.get(sharedCopyIdOf("will/flows"))).toBeUndefined()
    expect(store.collections.workingCopies.size).toBe(1)
    // Derived, never persisted: nothing under the shared id reaches the storage.
    expect([...data.values()].some((value) => value.includes("shared:smithersai/smithers"))).toBe(false)
    await store.dispose?.()
  })

  test("a catalog row without a head (the public catalog carries none) labels the copy without a bookmark: nothing invented", async () => {
    const store = await createAppStore(memory().backend)
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [catalogRow(null)] }).isPersisted.promise
    const shared = store.collections.workingCopies.get("shared:smithersai/smithers")
    expect(shared?.bookmark).toBeUndefined()
    expect(workingCopyLabel(shared!)).toBe("shared · read-only")
    // The head arriving later (a mirror read) puts the bookmark on the same copy.
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [catalogRow({ bookmark: "main", changeId: null, commitId: null })] }).isPersisted.promise
    expect(workingCopyLabel(store.collections.workingCopies.get("shared:smithersai/smithers")!)).toBe("main · shared · read-only")
    await store.dispose?.()
  })

  test("a box of the visitor's own on that repository replaces the shared copy, from either box source, and its removal restores it", async () => {
    const store = await createAppStore(memory().backend)
    const catalog = catalogRow({ bookmark: "main", changeId: null, commitId: null })
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [catalog] }).isPersisted.promise
    expect(store.collections.workingCopies.get("shared:smithersai/smithers")).toBeDefined()
    // The inventory's workspace copy (RepositoriesSeam, GET /api/user/workspaces).
    await store.dispatch({
      type: "workingcopies.workspaces.loaded",
      actor: "system",
      copies: [{ id: "workspace:box-1", workspaceId: "box-1", repoId: "smithersai/smithers", kind: "workspace", label: "main" }]
    }).isPersisted.promise
    expect(store.collections.workingCopies.get("shared:smithersai/smithers")).toBeUndefined()
    expect([...store.collections.workingCopies.keys()]).toEqual(["workspace:box-1"])
    await store.dispatch({ type: "workingcopies.workspaces.loaded", actor: "system", copies: [] }).isPersisted.promise
    expect(store.collections.workingCopies.get("shared:smithersai/smithers")).toBeDefined()
    // The full workspace row (workspace.updated / workspaces.loaded) is the other source of a box.
    await store.dispatch({ type: "workspace.updated", actor: "system", workspace: { ...workspace, id: "box-2", repoId: "smithersai/smithers", name: "main" } }).isPersisted.promise
    expect(store.collections.workingCopies.get("shared:smithersai/smithers")).toBeUndefined()
    expect(store.collections.workingCopies.get("workspace:box-2")).toMatchObject({ kind: "workspace", label: "main" })
    await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [], repoId: "smithersai/smithers" }).isPersisted.promise
    expect(store.collections.workingCopies.get("shared:smithersai/smithers")).toMatchObject({ kind: "shared", access: "read" })
    // A box on another repository leaves this repository's shared copy alone.
    await store.dispatch({ type: "workspace.updated", actor: "system", workspace }).isPersisted.promise
    expect(store.collections.workingCopies.get("shared:smithersai/smithers")).toBeDefined()
    // A private inventory refresh does not revoke an independently loaded public catalog row.
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [] }).isPersisted.promise
    expect(store.collections.workingCopies.get("shared:smithersai/smithers")).toBeDefined()
    await store.dispose?.()
  })

  test("the label of a box says its state: one rule for every copy row", () => {
    expect(workingCopyLabel({ kind: "workspace", label: "fix-landings", state: "running" })).toBe("fix-landings · running")
    expect(workingCopyLabel({ kind: "workspace", label: "fix-landings" })).toBe("fix-landings")
    expect(isReadOnlyCopy({ kind: "workspace", label: "fix-landings" } as never)).toBe(false)
  })
})
