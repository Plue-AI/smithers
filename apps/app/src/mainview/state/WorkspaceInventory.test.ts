import { describe, expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { defaultBoxBinding } from "./RepoContext"
import { json, memoryStorage, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()
const REPO = "will/flows"
const BOX_A = "0b0c0d0e-0000-4000-8000-00000000000a"
const BOX_B = "0b0c0d0e-0000-4000-8000-00000000000b"
const signedIn = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: REPO, org: "will", ownerKind: "user", name: "flows", head: null }] }).isPersisted.promise
  return store
}
const wire = (id: string) => ({ id, repository_id: 7, repo_full_name: REPO, name: id === BOX_A ? "pick-a" : "pick-b", slug: id === BOX_A ? "pick-a" : "pick-b", target_bookmark: "main", status: "suspended", provisioning_stage: null, suspended_at: "2026-09-30T00:00:00Z", created_at: "2026-09-01T00:00:00Z" })
const openForms = (store: Awaited<ReturnType<typeof signedIn>>) => [...store.collections.cards.values()].filter(card => card.kind === "flow-form" && card.payload.flow === "box.open")

describe("box inventory admission", () => {
  test("an in-progress refresh overrides an older empty observation and failed reads stay retryable", async () => {
    const store = await signedIn()
    await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [] }).isPersisted.promise
    expect(defaultBoxBinding(store, REPO)).toHaveProperty("noBox", true)
    await store.dispatch({ type: "workspaces.list.started", actor: "system", requestId: "refresh", repoId: REPO }).isPersisted.promise
    expect(defaultBoxBinding(store, REPO)).toEqual({ error: "Boxes are loading. Try again." })
    expect(defaultBoxBinding(store, "will/other")).toHaveProperty("noBox", true)
    await store.dispatch({ type: "workspaces.list.failed", actor: "system", requestId: "refresh", repoId: REPO, error: "Box inventory is unavailable" }).isPersisted.promise
    expect(defaultBoxBinding(store, REPO)).toEqual({ error: "Box inventory is unavailable" })
    await store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: REPO, workspaces: [] }).isPersisted.promise
    expect(defaultBoxBinding(store, REPO)).toHaveProperty("noBox", true)
  })

  test("another Cloud owner cannot inherit an observed empty inventory", async () => {
    const store = await signedIn()
    await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [] }).isPersisted.promise
    expect(defaultBoxBinding(store, REPO)).toHaveProperty("noBox", true)
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "other", expiresAt: null, scopes: null }).isPersisted.promise
    expect(defaultBoxBinding(store, REPO)).not.toHaveProperty("noBox")
  })

  test("an unobserved empty collection is not permission to open another box", async () => {
    const store = await signedIn()
    expect(defaultBoxBinding(store, REPO)).not.toHaveProperty("noBox")
    await store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: REPO, workspaces: [] }).isPersisted.promise
    expect(defaultBoxBinding(store, REPO)).toHaveProperty("noBox", true)
    expect(defaultBoxBinding(store, "will/other")).not.toHaveProperty("noBox")
  })

  test("a failed cached box cannot prove the rest of the inventory is empty", async () => {
    const store = await signedIn()
    await store.dispatch({ type: "workspace.updated", actor: "system", workspace: {
      id: BOX_A, repoId: REPO, name: "Failed", targetBookmark: "main", status: "failed",
      provisioningStage: null, suspendedAt: null, createdAt: null
    } }).isPersisted.promise
    expect(defaultBoxBinding(store, REPO)).toEqual({ error: "Boxes have not loaded yet. Try again." })
    await store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: REPO, workspaces: [] }).isPersisted.promise
    expect(defaultBoxBinding(store, REPO)).toHaveProperty("noBox", true)
  })

  for (const ordering of ["global-repo", "repo-global", "repo-repo"] as const) {
    for (const outcome of ["loading", "failed", "ready"] as const) {
      test(`${ordering}: an older response cannot replace the newer ${outcome} inventory`, async () => {
        const store = await signedIn()
        const held: Array<(response: Response) => void> = []
        const requests: string[] = []
        const controller = createAppController(store, silentAgent, { fetchImpl: async input => {
          const path = new URL(String(input), "https://app.test").pathname
          if (path !== "/api/user/workspaces" && path !== `/api/repos/${REPO}/workspaces`) return json(404, {})
          requests.push(path)
          return new Promise<Response>(resolve => { held.push(resolve) })
        } })
        const first = controller.listWorkspaces(ordering === "global-repo" ? undefined : REPO)
        await waitFor(() => held.length === 1)
        const second = controller.listWorkspaces(ordering === "repo-global" ? undefined : REPO)
        await waitFor(() => held.length === 2)
        if (outcome !== "loading") {
          held[1]!(outcome === "failed" ? json(503, { error: "inventory offline" }) : json(200, [wire(BOX_A), wire(BOX_B)]))
          await second
        }
        const before = defaultBoxBinding(store, REPO)
        if (outcome === "loading") expect(before).toEqual({ error: "Boxes are loading. Try again." })
        if (outcome === "failed") expect(before).toHaveProperty("error")
        held[0]!(json(200, []))
        expect(await first).toBe("A newer box list was requested. Try again.")
        expect(defaultBoxBinding(store, REPO)).toEqual(before)
        await controller.commands.run("approvals.list", REPO)
        expect(openForms(store)).toEqual([])
        if (outcome === "ready") {
          expect([...store.collections.cloudWorkspaces.keys()]).toEqual([BOX_A, BOX_B])
          const form = store.collections.cards.get("form-box.select")
          expect(form?.kind === "flow-form" && form.payload.fields[0]?.options?.map(option => option.value)).toEqual([BOX_A, BOX_B])
        } else expect(store.collections.cards.get("form-box.select")).toBeUndefined()
        expect(requests).toHaveLength(2)
        if (outcome === "loading") { held[1]!(json(200, [])); await second }
      })
    }
  }

  test("a stale request event cannot overwrite a newer list or its start ordering", async () => {
    const store = await signedIn()
    await store.dispatch({ type: "workspaces.list.started", actor: "system", requestId: "global" }).isPersisted.promise
    await store.dispatch({ type: "workspaces.list.started", actor: "system", requestId: "repo", repoId: REPO }).isPersisted.promise
    const before = store.collections.cloudSessions.get("cloud")!.workspaceLists!
    await store.dispatch({ type: "workspaces.loaded", actor: "system", requestId: "global", workspaces: [] }).isPersisted.promise
    expect(store.collections.cloudSessions.get("cloud")!.workspaceLists).toEqual(before)
    await store.dispatch({ type: "workspaces.list.failed", actor: "system", requestId: "wrong", repoId: REPO, error: "Old error" }).isPersisted.promise
    expect(defaultBoxBinding(store, REPO)).toEqual({ error: "Boxes are loading. Try again." })
    await store.dispatch({ type: "workspaces.loaded", actor: "system", requestId: "repo", repoId: REPO, workspaces: [] }).isPersisted.promise
    expect(store.collections.cloudSessions.get("cloud")!.workspaceLists!.find(row => row.scope === REPO)?.revision)
      .toBe(before.find(row => row.scope === REPO)!.revision)
  })

  for (const nextOwner of [null, "other"] as const) test(`${nextOwner ?? "sign-out"} retires a held list and cannot restore its observation or boxes`, async () => {
    const store = await signedIn()
    let release!: (response: Response) => void
    const controller = createAppController(store, silentAgent, { fetchImpl: input => {
      const path = new URL(String(input), "https://app.test").pathname
      return path === `/api/repos/${REPO}/workspaces` ? new Promise<Response>(resolve => { release = resolve }) : Promise.resolve(json(404, {}))
    } })
    const listing = controller.listWorkspaces(REPO)
    await waitFor(() => release !== undefined)
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: nextOwner === null ? "signed-out" : "signed-in", username: nextOwner, expiresAt: null, scopes: null }).isPersisted.promise
    release(json(200, [wire(BOX_A)]))
    expect(await listing).toBeString()
    expect(store.collections.cloudSessions.get("cloud")!.workspaceLists).toEqual([])
    expect([...store.collections.cloudWorkspaces.values()]).toEqual([])
  })

  test("independent repository lists do not retire one another", async () => {
    const store = await signedIn()
    const other = "will/other"
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [REPO, other].map(id => ({ id, org: "will", ownerKind: "user" as const, name: id.split("/")[1]!, head: null })) }).isPersisted.promise
    const held: Array<(response: Response) => void> = []
    const controller = createAppController(store, silentAgent, { fetchImpl: async input => {
      const path = new URL(String(input), "https://app.test").pathname
      if (!path.endsWith("/workspaces")) return json(404, {})
      return new Promise<Response>(resolve => { held.push(resolve) })
    } })
    const first = controller.listWorkspaces(REPO)
    await waitFor(() => held.length === 1)
    const second = controller.listWorkspaces(other)
    await waitFor(() => held.length === 2)
    held[1]!(json(200, []))
    expect(await second).toEqual({ value: `No boxes on ${other}.` })
    expect(defaultBoxBinding(store, REPO)).toEqual({ error: "Boxes are loading. Try again." })
    held[0]!(json(200, [wire(BOX_A)]))
    expect(await first).toHaveProperty("value")
    expect(defaultBoxBinding(store, REPO)).toHaveProperty("workspaceId", BOX_A)
    expect(defaultBoxBinding(store, other)).toHaveProperty("noBox", true)
  })

  test("reload retains a pending observation and only a new list resolves it", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
    let release!: (response: Response) => void
    const controller = createAppController(store, silentAgent, { fetchImpl: input => {
      const path = new URL(String(input), "https://app.test").pathname
      return path === `/api/repos/${REPO}/workspaces` ? new Promise<Response>(resolve => { release = resolve }) : Promise.resolve(json(404, {}))
    } })
    const old = controller.listWorkspaces(REPO)
    await waitFor(() => release !== undefined)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "Keep chat" }).isPersisted.promise
    await controller.dispose()
    await store.dispose?.()
    const restored = await createAppStore({ kind: "localStorage", storage })
    expect(defaultBoxBinding(restored, REPO)).toEqual({ error: "Boxes are loading. Try again." })
    const fresh = createAppController(restored, silentAgent, { fetchImpl: async () => json(200, []) })
    await fresh.listWorkspaces(REPO)
    release(json(200, [wire(BOX_A)]))
    expect(await old).toBeString()
    expect(defaultBoxBinding(restored, REPO)).toHaveProperty("noBox", true)
    expect([...restored.collections.cloudWorkspaces.values()]).toEqual([])
    expect(restored.session().draft).toBe("Keep chat")
  })

  test("Inbox acknowledges while the actual box-list request is held, then offers both observed boxes on retry", async () => {
    const store = await signedIn()
    let release!: (response: Response) => void
    let listing = false
    const held = new Promise<Response>(resolve => { release = resolve })
    const controller = createAppController(store, silentAgent, { toastDebounceMs: 0, fetchImpl: async input => {
      const path = new URL(String(input), "https://app.test").pathname
      if (path === `/api/repos/${REPO}/workspaces`) { listing = true; return held }
      return json(404, { status: "error" })
    } })
    const list = controller.listWorkspaces(REPO)
    await waitFor(() => listing)
    const first = await controller.commands.run("approvals.list", REPO)
    expect(first).toMatchObject({ status: "failed", error: "Boxes are loading. Try again." })
    await controller.commands.run("runs.list", REPO)
    await controller.commands.run("flow.create", `Review the repo ${REPO}`)
    expect(openForms(store)).toEqual([])
    expect(store.collections.cards.get("form-box.select")).toBeUndefined()
    expect(store.session().approvalsInboxRequests ?? []).toEqual([])
    // The act returns while the prerequisite stays unresolved; Chat remains usable.
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "Still here" }).isPersisted.promise
    expect(store.session().draft).toBe("Still here")
    release(json(200, [wire(BOX_A), wire(BOX_B)]))
    await list
    await controller.commands.run("approvals.list", REPO)
    const form = store.collections.cards.get("form-box.select")
    expect(form?.kind === "flow-form" && form.payload.fields[0]?.options?.map(option => option.value)).toEqual([BOX_A, BOX_B])
    expect(openForms(store)).toEqual([])
    expect(store.session().approvalsInboxRequests ?? []).toEqual([])
  })
})
