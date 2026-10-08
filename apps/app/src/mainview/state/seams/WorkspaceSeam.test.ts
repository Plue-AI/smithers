import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, test } from "bun:test"
import { createAppController } from "../AppController"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { createAppStore } from "../AppStore"
import { createActorBindings } from "../ActorBindings"
import type { AppStore } from "../AppStore"
import type { CloudWorkspaceInput } from "../AppState"
import { createWorkspaceSeam as makeWorkspaceSeam, DEGRADED_WORKSPACE_REFUSAL } from "./WorkspaceSeam"
import type { WorkspaceSeam } from "./WorkspaceSeam"
import type { SeamContext } from "./SeamContext"
import { INFRA_NOT_YOUR_FAULT } from "@smthrs/rpc/RefusalCopy"
import { USER_WORKSPACE_ROW } from "./fixtures/UserWorkspaceRow"

/*
 * The workspaces seam (lane citc): the gates (signed-in, never degraded),
 * the list loads that sync the tree copies, open's create-and-watch until
 * the workspace settles, the acts riding the one card, and the terminal's
 * session create-and-settle into a workspace tab. Every route is a double
 * in plue's own wire shape (a bare array from the list routes, the
 * UserWorkspaceRow from the per-user one, the cursor envelope from
 * bookmarks). These are controlled HTTP boundary units with actual MapStorage
 * persistence, not real backend integration. An unread auxiliary is an absent field, a
 * 404 mid-watch re-reads the repository's list.
 */

/**
 * The persistence backend, with its bytes readable: lane L3b's credential
 * guarantee asserts against what was actually WRITTEN, not only against the
 * in-memory collections, because a card payload reaches disk through here.
 */
const memoryStorage = (): StorageApi & { readonly written: () => string } => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    written: () => [...data.entries()].map(([key, value]) => `${key}=${value}`).join("\n")
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

/** plue's WorkspaceResponse (the per-repo list, get, create, act answers). */
const WS_RUNNING = {
  id: "ws-1",
  repository_id: 7,
  repo_full_name: "will/smithers",
  name: "review",
  slug: "review",
  target_bookmark: "main",
  status: "running",
  provisioning_stage: null,
  suspended_at: null,
  created_at: "2026-09-01T00:00:00Z"
}

/*
 * The live sample probed from the app on 2026-09-02
 * (`GET /api/repos/smithersai/smithers/workspaces`), reshaped onto this
 * suite's repository. Every plue#446 field is here exactly as the wire spells
 * it, `started_at: null` included — a suspended computer has no uptime.
 */
const WS_LIVE = {
  id: "ws-1",
  repository_id: 7,
  user_id: 3,
  repo_full_name: "will/smithers",
  name: "smithers landing",
  target_bookmark: "landing/smithers/main",
  status: "suspended",
  kind: "container",
  environment: {
    source: ".smithers/environment.nix",
    revision: "b3f21c9d4e5a6b7c",
    closure_hash: "sha256-abc"
  },
  head: { change_id: "qupxosqwmnrt", commit_id: "c0ffee1234567890" },
  ahead: 0,
  behind: 0,
  is_fork: true,
  vm_id: "vm-77",
  persistence: "persistent",
  ssh_host: "vm-77@ssh.smithers-cloud.test",
  idle_timeout_seconds: 1800,
  last_activity_at: "2026-09-02T09:00:00Z",
  suspended_at: "2026-09-02T09:30:00Z",
  started_at: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T09:30:00Z"
}

const USER_ROW = USER_WORKSPACE_ROW

const wsRow: CloudWorkspaceInput = {
  id: "ws-1",
  repoId: "will/smithers",
  name: "review",
  targetBookmark: "main",
  status: "running",
  provisioningStage: null,
  suspendedAt: null,
  createdAt: "2026-09-01T00:00:00Z"
}

type Route = Response | ((url: URL) => Response | Promise<Response>)

const ownedStores = new Set<AppStore>()
const ownedSeams = new Set<WorkspaceSeam>()
const heldReleases = new Set<() => void>()
const pendingWork = new Set<Promise<unknown>>()
const unexpectedRequests: Array<string> = []
const observe = <T>(promise: Promise<T>): Promise<T> => {
  pendingWork.add(promise)
  void promise.then(() => pendingWork.delete(promise), () => pendingWork.delete(promise))
  return promise
}
const checkpoint = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Workspace operation did not settle")), 3_000)
    })])
  } finally { clearTimeout(timer) }
}
const drainWork = async (): Promise<void> => {
  while (pendingWork.size > 0) await Promise.allSettled([...pendingWork])
  await checkpoint()
}

// Track public operation promises as well as HTTP: disposing the seam fences
// publication synchronously, but its owned Effect runtime closes asynchronously.
const createWorkspaceSeam: typeof makeWorkspaceSeam = (...args) => {
  const seam = makeWorkspaceSeam(...args)
  ownedSeams.add(seam)
  return {
    ...seam,
    listWorkspaces: (...args) => observe(seam.listWorkspaces(...args)),
    refreshWorkspaces: (...args) => observe(seam.refreshWorkspaces(...args)),
    openWorkspace: (...args) => observe(seam.openWorkspace(...args)),
    viewWorkspace: (...args) => observe(seam.viewWorkspace(...args)),
    suspendWorkspace: (...args) => observe(seam.suspendWorkspace(...args)),
    resumeWorkspace: (...args) => observe(seam.resumeWorkspace(...args)),
    destroySession: (...args) => observe(seam.destroySession(...args)),
    deleteWorkspace: (...args) => observe(seam.deleteWorkspace(...args)),
    listFiles: (...args) => observe(seam.listFiles(...args)),
    readFile: (...args) => observe(seam.readFile(...args)),
    listServices: (...args) => observe(seam.listServices(...args)),
    listEgress: (...args) => observe(seam.listEgress(...args)),
    listEnvironmentImages: (...args) => observe(seam.listEnvironmentImages(...args)),
    setFacet: Object.assign((...args: Parameters<WorkspaceSeam["setFacet"]>) => observe(seam.setFacet(...args)), seam.setFacet)
  }
}

afterEach(async () => {
  const errors: Array<unknown> = []
  for (const seam of ownedSeams) {
    try { seam.dispose() } catch (error) { errors.push(error) }
  }
  ownedSeams.clear()
  for (const release of heldReleases) {
    try { release() } catch (error) { errors.push(error) }
  }
  heldReleases.clear()
  try { await bounded(drainWork()) } catch (error) { errors.push(error) }
  for (const store of ownedStores) {
    try {
      if (store.dispose === undefined) throw new Error("Workspace fixture requires store.dispose")
      await store.dispose()
    } catch (error) { errors.push(error) }
  }
  ownedStores.clear()
  if (unexpectedRequests.length > 0) errors.push(new Error(`Unexpected Workspace HTTP: ${unexpectedRequests.join(", ")}`))
  unexpectedRequests.length = 0
  if (errors.length > 0) throw new AggregateError(errors, "Workspace fixture cleanup failed")
})

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean; readonly degraded?: boolean; readonly desktopWaitMs?: number; readonly headless?: boolean } = {}
) => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  ownedStores.add(store)
  /** `METHOD path` per request, the query string dropped. */
  const requests: Array<string> = []
  const signals: Array<AbortSignal | null | undefined> = []
  /** The same, with the query string. */
  const urls: Array<string> = []
  /** Each request's decoded JSON body, keyed `METHOD path` — what the create actually asked plue for. */
  const bodies: Array<{ readonly key: string; readonly body: unknown }> = []
  /** The store as each of the seam's dispatches left it: what one transition did, before the next. */
  const dispatched: Array<{ readonly type: string; readonly tabs: Array<string>; toast?: unknown }> = []
  const ctx: SeamContext = {
    http: (input, init) => observe((async () => {
      const method = init?.method ?? "GET"
      const stripped = input.startsWith("/") ? input.slice(1) : input
      const url = new URL(stripped, "https://cloud.invalid/")
      const path = url.pathname.slice(1)
      const key = `${method} ${path}`
      requests.push(key)
      signals.push(init?.signal)
      urls.push(`${key}${url.search}`)
      if (typeof init?.body === "string") bodies.push({ key, body: JSON.parse(init.body) })
      const route = routes[key] ?? routes[path]
      if (route === undefined) {
        unexpectedRequests.push(key)
        throw new Error(`Unexpected Workspace HTTP: ${key}`)
      }
      return typeof route === "function" ? route(url) : route.clone()
    })()),
    baseUrl: "",
    store,
    dispatch: (transition) => {
      const transaction = store.dispatch(transition)
      dispatched.push({ type: transition.type, tabs: tabsOf(store),  toast: structuredClone(store.collections.toasts.get("toast-box.open:ws-1")) })
      return transaction
    },
    actor: () => "user",
    nextOrdinal: () => 0
  }
  if (options.signedIn !== false) {
    await store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: "signed-in",
      username: "will",
      expiresAt: null,
      scopes: options.degraded === true ? "degraded" : null
    }).isPersisted.promise
  }
  await store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [
      {
        id: "will/smithers",
        org: "will",
        ownerKind: "user",
        name: "smithers",
        head: options.headless === true ? null : { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" }
      }
    ]
  }).isPersisted.promise
  return {
    ctx,
    store,
    seam: createWorkspaceSeam(ctx, { pollMs: 1,  }),
    requests,
    urls,
    dispatched,
    storage,
    bodies,
    signals
  }
}

const seedWorkspace = async (store: AppStore, workspace: CloudWorkspaceInput = wsRow): Promise<void> => {
  await store.dispatch({ type: "workspace.updated", actor: "system", workspace }).isPersisted.promise
}

const seedCard = async (store: AppStore, _terminalSessionId?: string): Promise<void> => {
  await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id: "branch:ws-1", kind: "branch", title: "review", status: "active", createdAt: 1, ordinal: 0, payload: { id: "ws-1" }
  } }).isPersisted.promise
}
const cardOf = (store: AppStore, workspaceId = "ws-1") => store.collections.cards.get(`branch:${workspaceId}`)

const workspacesOf = (store: AppStore) => [...store.collections.cloudWorkspaces.values()]
const copiesOf = (store: AppStore) => [...store.collections.workingCopies.values()].filter((copy) => copy.kind === "workspace")
const messagesOf = (store: AppStore) => [...store.collections.messages.values()].map((message) => message.text)
const tabsOf = (store: AppStore) => [...store.collections.tabs.values()].filter((tab) => tab.kind !== "main").map((tab) => tab.id)

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("workspace seam gates", () => {
  test("a signed-out session refuses every act with the sign-in step", async () => {
    const { seam } = await harness({}, { signedIn: false })
    expect(await seam.listWorkspaces()).toBe("Sign in to Smithers Cloud to continue.")
    expect(await seam.openWorkspace("main", "will/smithers")).toBe("Sign in to Smithers Cloud to continue.")
  })
})

describe("workspace seam list", () => {
  test("unnamed running workspaces remain available in repository and user lists", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces": json(200, [{ ...WS_RUNNING, name: "", slug: "" }]),
      "api/user/workspaces": json(200, [{ ...USER_ROW, workspace_title: "" }])
    })
    await seam.listWorkspaces("will/smithers")
    expect(workspacesOf(store)).toContainEqual(expect.objectContaining({ id: "ws-1", name: "ws-1", status: "running" }))
    await seam.listWorkspaces()
    expect(copiesOf(store)).toContainEqual(expect.objectContaining({ workspaceId: "ws-1", label: "ws-1", state: "running" }))
  })

  /*
   * Critique finding 3: plue's per-user route answers UserWorkspaceRow
   * (workspace_id, repository_owner/name, workspace_title, state), which
   * the DTO parser dropped to zero rows — and then scope-replaced every
   * loaded workspace away.
   */
  test("box.list parses plue's per-user rows, asks for 100 a page, syncs the tree copies, and announces", async () => {
    const { store, seam, urls } = await harness({
      "api/user/workspaces": json(200, [
        USER_ROW,
        { ...USER_ROW, workspace_id: "ws-2", workspace_title: "bench", state: "suspended" },
        { broken: true }
      ])
    })
    const result = await seam.listWorkspaces()
    expect(typeof result).toBe("object")
    expect(urls[0]).toBe("GET api/user/workspaces?limit=100")
    expect(workspacesOf(store).map((row) => row.id).sort()).toEqual(["ws-1", "ws-2"])
    expect(copiesOf(store)).toEqual([
      expect.objectContaining({ id: "workspace:ws-1", kind: "workspace", label: "review", state: "running", workspaceId: "ws-1" }),
      expect.objectContaining({ id: "workspace:ws-2", kind: "workspace", label: "bench", state: "suspended", workspaceId: "ws-2" })
    ])
    expect(messagesOf(store).join("\n")).toContain("review (ws-1) · running · will/smithers")
  })

  test("a per-user row keeps the bookmark the collection already knows; a status that moved on drops its stage", async () => {
    const { store, seam } = await harness({
      "api/user/workspaces": json(200, [USER_ROW])
    })
    await seedWorkspace(store, { ...wsRow, status: "starting", provisioningStage: "boot" })
    await seam.listWorkspaces()
    expect(workspacesOf(store)[0]).toEqual(expect.objectContaining({ id: "ws-1", status: "running", targetBookmark: "main", provisioningStage: null }))
  })

  test("a non-empty list Smithers cannot read is an error, and the loaded rows stay", async () => {
    const { store, seam } = await harness({
      "api/user/workspaces": json(200, [{ id: 42, weird: true }, { also: "wrong" }])
    })
    await seedWorkspace(store)
    const refusal = await seam.listWorkspaces()
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("2 box rows in a shape Smithers can't read")
    expect(workspacesOf(store).map((row) => row.id)).toEqual(["ws-1"])
    expect(copiesOf(store).map((copy) => copy.id)).toEqual(["workspace:ws-1"])
  })

  test("an empty list is a fact: the scope empties", async () => {
    const { store, seam } = await harness({
      "api/user/workspaces": json(200, [])
    })
    await seedWorkspace(store)
    const result = await seam.listWorkspaces()
    expect(result).toEqual({ value: "No boxes." })
    expect(workspacesOf(store)).toEqual([])
  })

  test("a repo-scoped list replaces only that repository's rows", async () => {
    const { store, seam, urls } = await harness({
      "api/repos/will/smithers/workspaces": json(200, [WS_RUNNING])
    })
    await store.dispatch({
      type: "workspace.updated",
      actor: "system",
      workspace: { ...wsRow, id: "ws-other", repoId: "plue/plue", name: "other" }
    }).isPersisted.promise
    const result = await seam.listWorkspaces("will/smithers")
    expect(typeof result).toBe("object")
    expect(urls[0]).toBe("GET api/repos/will/smithers/workspaces?limit=100")
    expect(workspacesOf(store).map((row) => row.id).sort()).toEqual(["ws-1", "ws-other"])
  })

  test("both list routes follow the Link header's next page until it is exhausted", async () => {
    /*
     * plue writes its list links in the legacy page/per_page form; the
     * per-user route's own parser reads only cursor/limit, so the seam
     * re-issues the next page as an offset cursor — which both routes take.
     */
    const pageOf = (url: URL, rows: Array<Record<string, unknown>>, path: string): Response => {
      const offset = Number(url.searchParams.get("cursor") ?? 0)
      const limit = Number(url.searchParams.get("limit"))
      const slice = rows.slice(offset, offset + limit)
      const lastPage = Math.ceil(rows.length / limit)
      const page = offset / limit + 1
      const links = [`<${path}?page=1&per_page=${limit}>; rel="first"`, `<${path}?page=${lastPage}&per_page=${limit}>; rel="last"`]
      if (page < lastPage) links.push(`<${path}?page=${page + 1}&per_page=${limit}>; rel="next"`)
      return json(200, slice, { link: links.join(", "), "x-total-count": String(rows.length) })
    }
    const userRows = Array.from({ length: 130 }, (_, index) => ({ ...USER_ROW, workspace_id: `ws-${index}`, workspace_title: `w${index}` }))
    const repoRows = Array.from({ length: 101 }, (_, index) => ({ ...WS_RUNNING, id: `ws-${index}`, name: `w${index}` }))
    const { store, seam, urls } = await harness({
      "api/user/workspaces": (url) => pageOf(url, userRows, "/api/user/workspaces"),
      "api/repos/will/smithers/workspaces": (url) => pageOf(url, repoRows, "/api/repos/will/smithers/workspaces")
    })
    await seam.listWorkspaces()
    expect(workspacesOf(store).length).toBe(130)
    expect(urls).toEqual(["GET api/user/workspaces?limit=100", "GET api/user/workspaces?limit=100&cursor=100"])
    urls.length = 0
    await seam.listWorkspaces("will/smithers")
    expect(workspacesOf(store).length).toBe(101)
    expect(urls).toEqual(["GET api/repos/will/smithers/workspaces?limit=100", "GET api/repos/will/smithers/workspaces?limit=100&cursor=100"])
  })

  test("the per-user list follows plue#503's cursor Link header", async () => {
    /*
     * plue#503 replaced the legacy page/per_page links on both workspace list
     * routes with cursor form — `</api/user/workspaces?cursor=2&limit=2>;
     * rel="next"` beside rel="first" and rel="prev" — which is the form the
     * route's own parser reads. The seam already followed a cursor link; this
     * pins that it still does, at plue's own spelling.
     */
    const { store, seam, urls } = await harness({
      "api/user/workspaces": (url) =>
        url.searchParams.get("cursor") === "2"
          ? json(200, [{ ...USER_ROW, workspace_id: "ws-3", workspace_title: "third" }], {
            link: "</api/user/workspaces?limit=2>; rel=\"first\", </api/user/workspaces?cursor=0&limit=2>; rel=\"prev\"",
            "x-total-count": "3"
          })
          : json(200, [USER_ROW, { ...USER_ROW, workspace_id: "ws-2", workspace_title: "second" }], {
            link: "</api/user/workspaces?limit=2>; rel=\"first\", </api/user/workspaces?cursor=2&limit=2>; rel=\"next\"",
            "x-total-count": "3"
          })
    })
    await seam.listWorkspaces()
    expect(urls).toEqual(["GET api/user/workspaces?limit=100", "GET api/user/workspaces?limit=100&cursor=2"])
    expect(workspacesOf(store).map((row) => row.id).sort()).toEqual(["ws-1", "ws-2", "ws-3"])
  })

  test("a next link that leaves the route is not followed", async () => {
    const { store, seam, urls } = await harness({
      "api/user/workspaces": json(200, [USER_ROW], { link: "</api/user/repos?page=2&per_page=100>; rel=\"next\"" })
    })
    await seam.listWorkspaces()
    expect(urls).toEqual(["GET api/user/workspaces?limit=100"])
    expect(workspacesOf(store).length).toBe(1)
  })

  /*
   * Critique finding 2 (tabs): a workspace the list no longer carries takes
   * its terminal tabs with it, in the same transaction as the row.
   */
  test("a scope replace closes the terminal tabs of the workspaces it dropped", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces": json(200, [{ ...WS_RUNNING, id: "ws-2", name: "bench" }])
    })
    await seedWorkspace(store)
    await seedWorkspace(store, { ...wsRow, id: "ws-2", name: "bench" })
    await seam.listWorkspaces("will/smithers")
    expect(workspacesOf(store).map((row) => row.id)).toEqual(["ws-2"])
    expect(tabsOf(store)).toEqual([])
  })
})

describe("workspace seam open", () => {

  test("open names an explicit bookmark and an explicit repo", async () => {
    const { seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, WS_RUNNING),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    const result = await seam.openWorkspace("dev", "will/smithers")
    expect(typeof result).toBe("object")
    expect(requests[0]).toBe("POST api/repos/will/smithers/workspaces")
  })

  test("open without a target is an honest choice", async () => {
    const { store, seam } = await harness({})
    await store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        { id: "a/a", org: "a", ownerKind: "user", name: "a", head: null },
        { id: "b/b", org: "b", ownerKind: "user", name: "b", head: null }
      ]
    }).isPersisted.promise
    const refusal = await seam.openWorkspace()
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("name one as owner/repo")
  })
})

describe("workspace seam acts", () => {

  test("a bare act resolves the active workspace copy", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/suspend": json(200, { ...WS_RUNNING, status: "suspended" })
    })
    await seedWorkspace(store)
    await seedWorkspace(store, { ...wsRow, id: "ws-2", name: "bench" })
    await store.dispatch({ type: "repo.selected", actor: "user", id: "will/smithers#workspace:ws-1" }).isPersisted.promise
    const result = await seam.suspendWorkspace()
    expect(typeof result).toBe("object")
    expect(workspacesOf(store).find((row) => row.id === "ws-1")?.status).toBe("suspended")
  })

  test("a bare act with several loaded and none active is an honest choice", async () => {
    const { store, seam } = await harness({})
    await seedWorkspace(store)
    await seedWorkspace(store, { ...wsRow, id: "ws-2", name: "bench" })
    const refusal = await seam.suspendWorkspace()
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("name a box id")
  })

  /*
   * Critique finding 5: the typed-name gate lived only in the card's
   * chrome; the flow deleted on one click. The name now rides the payload
   * and the seam refuses a mismatch, whoever invoked.
   */
  test("delete refuses unless the workspace's name is typed back, and never calls plue for a mismatch", async () => {
    const { store, seam, requests } = await harness({
      "DELETE api/repos/will/smithers/workspaces/ws-1": json(204, null),
      "api/repos/will/smithers/workspaces": json(200, [])
    })
    await seedWorkspace(store)
    for (const typed of ["", "revie", "Review", "ws-1"]) {
      const refusal = await seam.deleteWorkspace("ws-1", typed)
      expect(typeof refusal).toBe("string")
      expect(refusal).toContain("needs its name typed back exactly")
      expect(refusal).toContain("/box.delete ws-1 review")
    }
    expect(requests).toEqual([])
    expect(workspacesOf(store).map((row) => row.id)).toEqual(["ws-1"])
  })

  test("delete with the name removes the card, the row, the copy, and the terminal tab together, then refreshes the list", async () => {
    const { store, seam, requests } = await harness({
      "DELETE api/repos/will/smithers/workspaces/ws-1": json(204, null),
      "api/repos/will/smithers/workspaces": json(200, [])
    })
    await seedWorkspace(store)
    await seedCard(store, "sess-1")
    const result = await seam.deleteWorkspace("ws-1", "review")
    expect(typeof result).toBe("object")
    expect(requests[0]).toBe("DELETE api/repos/will/smithers/workspaces/ws-1")
    expect(requests[1]).toBe("GET api/repos/will/smithers/workspaces")
    expect(workspacesOf(store)).toEqual([])
    expect(copiesOf(store)).toEqual([])
    expect(cardOf(store)).toBeUndefined()
    expect(tabsOf(store)).toEqual([])
    expect(store.session().activeTabId).toBe("main")
  })
})



describe("workspace seam watch", () => {
  test("a 404 mid-watch re-reads the repository's list and the row leaves", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, { ...WS_RUNNING, status: "pending" }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, []),
      "api/repos/will/smithers/workspaces/ws-1": json(404, { message: "gone" }),
      "api/repos/will/smithers/workspaces": json(200, [])
    })
    await seam.openWorkspace()
    await wait(30)
    expect(workspacesOf(store)).toEqual([])
    expect(copiesOf(store)).toEqual([])
  })

  test("the watch stops when the cloud session signs out", async () => {
    const { store, seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, { ...WS_RUNNING, status: "pending" }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, []),
      "api/repos/will/smithers/workspaces/ws-1": json(200, { ...WS_RUNNING, status: "pending" })
    })
    await seam.openWorkspace()
    await wait(10)
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null }).isPersisted.promise
    await wait(5)
    const polls = requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length
    await wait(30)
    expect(requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length).toBe(polls)
  })
})


/*
 * Lane L3: plue#446's header facts and plue#449's facet routes. The DTO
 * fixture is the live sample probed from the app on 2026-09-02; the facet
 * doubles answer the shapes `internal/services/workspace_facets.go` and
 * `internal/services/sandbox_egress_audit.go` write.
 */
describe("workspace seam header facts (plue#446)", () => {

  test("a started workspace carries its start time; the per-user row keeps the facts but drops the uptime once it stops running", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces": json(200, [{ ...WS_LIVE, status: "running", started_at: "2026-09-02T08:00:00Z" }]),
      "api/user/workspaces": json(200, [{ ...USER_ROW, workspace_title: "smithers landing", state: "suspended" }])
    })
    await seam.listWorkspaces("will/smithers")
    expect(workspacesOf(store)[0]).toEqual(expect.objectContaining({ startedAt: "2026-09-02T08:00:00Z", kind: "container" }))
    // The switcher row carries none of these; what the per-repo DTO taught stands, except an uptime that no longer applies.
    await seam.listWorkspaces()
    expect(workspacesOf(store)[0]).toEqual(
      expect.objectContaining({
        status: "suspended",
        kind: "container",
        persistence: "persistent",
        sshHost: "vm-77@ssh.smithers-cloud.test",
        head: { changeId: "qupxosqwmnrt", commitId: "c0ffee1234567890" },
        startedAt: null
      })
    )
  })
})

describe("workspace seam files and services (plue#449)", () => {

  test("box.file reads the workspace's copy into a file card; base64 is stated as binary", async () => {
    const { store, seam, urls } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/files/content": (url) =>
        json(200, url.searchParams.get("path") === "logo.png"
          ? { name: "logo.png", path: "logo.png", type: "file", encoding: "base64", content: "AAEC", size: 3 }
          : { name: "README.md", path: "README.md", type: "file", encoding: "utf-8", content: "# hi", size: 4 })
    })
    await seedWorkspace(store)
    expect(await seam.readFile("README.md", "ws-1")).toEqual({
      value: "README.md in \"review\" (ws-1):\n# hi"
    })
    expect(urls).toEqual(["GET api/repos/will/smithers/workspaces/ws-1/files/content?path=README.md"])
    const text = store.collections.cards.get("workspace-file-ws-1-README.md")
    expect(text).toEqual(
      expect.objectContaining({
        kind: "file",
        payload: expect.objectContaining({
          repo: "will/smithers",
          workspaceId: "ws-1",
          path: "README.md",
          content: "# hi",
          binary: false,
          address: "will/smithers · review · README.md"
        })
      })
    )
    await seam.readFile("logo.png", "ws-1")
    const binary = store.collections.cards.get("workspace-file-ws-1-logo.png")
    expect(binary?.kind === "file" ? binary.payload.binary : undefined).toBe(true)
  })

  test("workspace file tool results are bounded text, with binary and truncation stated", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/files/content": (url) => json(200,
        url.searchParams.get("path") === "image.png"
          ? { content: "AAEC", encoding: "base64" }
          : { content: "a".repeat(20_000), encoding: "utf-8" })
    })
    await seedWorkspace(store)
    const text = await seam.readFile("large.txt", "ws-1")
    expect(typeof text === "object" && text?.value).toContain("truncated")
    expect(typeof text === "object" && text?.value.length).toBeLessThan(17_000)
    const card = store.collections.cards.get("workspace-file-ws-1-large.txt")
    expect(card?.kind === "file" && card.payload.content.length).toBe(16 * 1024)
    expect(card?.kind === "file" && card.payload.truncated).toBe(true)
    const binary = await seam.readFile("image.png", "ws-1")
    expect(typeof binary === "object" && binary?.value).toContain("binary file")
    expect(typeof binary === "object" && binary?.value).not.toContain("AAEC")
    seam.dispose()
  })
})

describe("workspace seam egress audit", () => {
})

describe("workspace seam egress_proxy_unavailable", () => {
  test("a creation the worker refused for the missing egress proxy names plue's code exactly", async () => {
    const { seam } = await harness({
      "POST api/repos/will/smithers/workspaces": json(503, {
        code: "egress_proxy_unavailable",
        message: "service unavailable"
      })
    })
    const refusal = await seam.openWorkspace("main", "will/smithers")
    expect(refusal).toContain("egress_proxy_unavailable — The request to Smithers Cloud failed (503).")
    expect(refusal).not.toContain("service unavailable")
    /*
     * And says what actually went wrong. This is `infra`, and it used to
     * inherit the capacity line — "Smithers ran out of infra, yell at @fucory
     * to buy more" — about a proxy that was not answering. Nothing was full.
     */
    expect(refusal).toContain("no outbound network")
    expect(refusal).toContain("Not your fault")
    expect(refusal).not.toContain("@fucory")
    expect(refusal).not.toContain(INFRA_NOT_YOUR_FAULT)
  })
})

describe("workspace seam environment images", () => {
  test("the listing names each image's kind, closure and status, and the cold-pull note when nothing is baked", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/environment-images": json(200, [
        {
          id: 4,
          repository_id: 7,
          kind: "vm",
          source: ".smithers/environment.nix",
          source_revision: "b3f21c9d4e5a6b7c",
          closure_hash: "9f2b1c0d4e5a6b7c8d9e0f1a",
          image: "registry.smithers-cloud.test/environments/smithersai/smithers:nixos-2405-9f2b1c0d",
          status: "ready",
          golden_snapshot_id: "",
          created_at: "2026-09-02T00:00:00Z"
        },
        {
          id: 1,
          repository_id: 0,
          kind: "vm",
          source: "platform",
          source_revision: "",
          closure_hash: "1122334455667788",
          image: "registry.smithers-cloud.test/environments/base:nixos-2405",
          status: "ready",
          golden_snapshot_id: "snap-9",
          created_at: "2026-08-01T00:00:00Z"
        }
      ])
    })
    const answer = await seam.listEnvironmentImages("will/smithers")
    expect(typeof answer).toBe("object")
    const card = store.collections.cards.get("environment-images-will/smithers")
    expect(card?.kind).toBe("environment-images")
    const rows = card?.kind === "environment-images" ? card.payload.images : []
    expect(rows).toEqual([
      {
        id: "4",
        kind: "vm",
        source: ".smithers/environment.nix",
        sourceRevision: "b3f21c9d4e5a6b7c",
        closureHash: "9f2b1c0d4e5a6b7c8d9e0f1a",
        image: "registry.smithers-cloud.test/environments/smithersai/smithers:nixos-2405-9f2b1c0d",
        status: "ready",
        platformBase: false,
        coldPull: true
      },
      {
        id: "1",
        kind: "vm",
        source: "platform",
        sourceRevision: null,
        closureHash: "1122334455667788",
        image: "registry.smithers-cloud.test/environments/base:nixos-2405",
        status: "ready",
        platformBase: true,
        coldPull: false
      }
    ])
  })

  test("a repository with no images says so rather than rendering an empty list of nothing", async () => {
    const { store, seam } = await harness({ "api/repos/will/smithers/environment-images": json(200, []) })
    await seam.listEnvironmentImages("will/smithers")
    const card = store.collections.cards.get("environment-images-will/smithers")
    expect(card?.kind === "environment-images" ? card.payload.images : null).toEqual([])
  })

  test("a refused listing is the server's own message, never an empty catalogue", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/environment-images": json(403, { message: "environment images are not enabled for this repository" })
    })
    expect(await seam.listEnvironmentImages("will/smithers")).toBe(
      "environment images are not enabled for this repository"
    )
    expect(store.collections.cards.get("environment-images-will/smithers")).toBeUndefined()
  })
})

/*
 * Lane L3b addendum (plue main 495e7269e604, RFD-004): an agent run executes
 * in a workspace of its own — `kind: "agent"` with the session that drove it —
 * and workspace DTOs carry the guest-reported head.
 */
describe("workspace seam agent workspaces", () => {

  test("a per-user switcher row states its own failure too (plue#482)", async () => {
    const { store, seam } = await harness({
      "api/user/workspaces": json(200, [
        { ...USER_ROW, state: "failed", failure_code: "egress_proxy_unavailable", failure_message: "proxy did not start" }
      ])
    })

    await seam.listWorkspaces()

    expect(workspacesOf(store)[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        failureCode: "egress_proxy_unavailable",
        failureMessage: "proxy did not start"
      })
    )
  })

})


describe("workspace seam lifecycle cancellation", () => {
  const deferred = <T>(fallback: T) => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    heldReleases.add(() => resolve(fallback))
    return { promise, resolve }
  }

  for (const outcome of ["response", "error", "body", "list"] as const) {
    test(`dispose fences a watch awaiting its ${outcome}`, async () => {
      const entered = deferred<void>(undefined)
      const release = deferred<void>(undefined)
      const { ctx, seam, requests, dispatched, signals } = await harness({
        "POST api/repos/will/smithers/workspaces": json(201, { ...WS_RUNNING, status: "pending" }),
        "api/repos/will/smithers/bookmarks": json(200, []),
        "api/repos/will/smithers/workspace-snapshots": json(200, []),
        "api/repos/will/smithers/workspace/sessions": json(200, []),
        "api/repos/will/smithers/workspaces/ws-1": async () => {
          if (outcome === "list") return json(404, {})
          if (outcome === "body") {
            const response = json(200, {})
            response.json = () => observe((async () => {
              entered.resolve()
              await release.promise
              return { ...WS_RUNNING, status: "pending" }
            })())
            return response
          }
          entered.resolve()
          await release.promise
          if (outcome === "error") throw new Error("late transport failure")
          return json(200, { ...WS_RUNNING, status: "pending" })
        },
        "api/repos/will/smithers/workspaces": async () => {
          entered.resolve()
          await release.promise
          return json(200, [])
        }
      })
      try {
        await seam.openWorkspace()
        await entered.promise
        // Disposal through a lazily acquired actor binding owns the same lifetime.
        const actors = createActorBindings(() => {})
        const user = actors.pair(ctx, (context) => createWorkspaceSeam(context))
        actors.select(user).dispose()
        expect(signals.some((signal) => signal?.aborted)).toBe(true)
        const dispatchCount = dispatched.length
        const requestCount = requests.length
        release.resolve()
        await drainWork()
        expect(dispatched.length).toBe(dispatchCount)
        expect(requests.length).toBe(requestCount)
      } finally {
        release.resolve()
        seam.dispose()
      }
    })
  }
})

describe("Mac plan sandbox limits retain the typed failure without an upgrade door", () => {
  const limit = () => json(402, { code: "plan_limit_exceeded", fault: "user", message: "Suspend one sandbox or upgrade.", plan_key: "free", limit_kind: "concurrent_sandboxes", upgrade_plan_key: "pro" })
  const paths = [
    ["open", "POST api/repos/will/smithers/workspaces"],
    ["resume", "POST api/repos/will/smithers/workspaces/ws-1/resume"],
  ] as const
  for (const [act, path] of paths) test(`${act} states the typed refusal without a billing card`, async () => {

    const { store, seam, requests } = await harness({ [path]: limit, "api/repos/will/smithers/workspaces/ws-1": json(200, WS_RUNNING) })
    await seedWorkspace(store, { ...wsRow, kind: "vm" })
    const answer = act === "open" ? await seam.openWorkspace(undefined, "will/smithers")
      : act === "resume" ? await seam.resumeWorkspace("ws-1")
      : await seam.resumeWorkspace("ws-1")
    expect(answer).toContain("Your plan is at its sandbox limit.")
    const card = store.collections.cards.get("billing-plan-limit")
    expect(card).toBeUndefined()
    expect(requests.filter(request => request === path)).toHaveLength(1)
  })
})

describe("workspace account fences", () => {
  test("a held workspace view survives an identity and cloud refresh by the same owner", async () => {
    let release!: (response: Response) => void
    let requested!: () => void
    const started = new Promise<void>(resolve => { requested = resolve })
    const held = new Promise<Response>(resolve => { release = resolve; heldReleases.add(() => resolve(json(503, { message: "fixture retired" }))) })
    const { store, seam } = await harness({
      // This scenario deliberately has no readable auxiliary metadata.
      "GET api/repos/will/smithers/bookmarks": json(404, { message: "bookmarks unavailable" }),
      "GET api/repos/will/smithers/workspace/sessions": json(404, { message: "sessions unavailable" }),
      "GET api/repos/will/smithers/workspaces/ws-1": () => { requested(); return held }
    })
    const identity = { type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null } as const
    await store.dispatch(identity).isPersisted.promise
    await seedWorkspace(store)
    const pending = seam.viewWorkspace("ws-1")
    await started
    await store.dispatch(identity).isPersisted.promise
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
    release(json(200, { ...WS_RUNNING, name: "fresh name" }))
    await pending
    expect(store.collections.cloudWorkspaces.get("ws-1")?.name).toBe("fresh name")
    expect(cardOf(store)).toBeDefined()
    seam.dispose()
  })

  test("a held workspace view cannot restore a private row or card after sign-out", async () => {
    let release!: (response: Response) => void
    let requested!: () => void
    const started = new Promise<void>(resolve => { requested = resolve })
    const held = new Promise<Response>(resolve => { release = resolve; heldReleases.add(() => resolve(json(503, { message: "fixture retired" }))) })
    const { store, seam, storage } = await harness({
      "GET api/repos/will/smithers/workspaces/ws-1": () => { requested(); return held }
    })
    await seedWorkspace(store)
    const pending = seam.viewWorkspace("ws-1")
    await started
    await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    release(json(200, { ...WS_RUNNING, name: "private name" }))
    await pending
    expect(store.collections.cloudWorkspaces.get("ws-1")).toBeUndefined()
    expect(cardOf(store)).toBeUndefined()
    expect(storage.written()).not.toContain("private name")
  })

  test("a held workspace view stays stale across an A to B to A session cycle", async () => {
    let release!: (response: Response) => void
    let requested!: () => void
    const started = new Promise<void>(resolve => { requested = resolve })
    const held = new Promise<Response>(resolve => { release = resolve; heldReleases.add(() => resolve(json(503, { message: "fixture retired" }))) })
    const { store, seam } = await harness({
      "GET api/repos/will/smithers/workspaces/ws-1": () => { requested(); return held }
    })
    await seedWorkspace(store)
    const pending = seam.viewWorkspace("ws-1")
    await started
    for (const username of ["other", "will"]) {
      await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username, expiresAt: null, scopes: null }).isPersisted.promise
    }
    release(json(200, { ...WS_RUNNING, name: "old private name" }))
    await pending
    expect(store.collections.cloudWorkspaces.get("ws-1")?.name).toBe("review")
    expect(cardOf(store)).toBeUndefined()
  })

  test("a held auxiliary read cannot restore a workspace card after sign-out", async () => {
    let release!: (response: Response) => void
    let requested!: () => void
    const started = new Promise<void>(resolve => { requested = resolve })
    const held = new Promise<Response>(resolve => { release = resolve; heldReleases.add(() => resolve(json(503, { message: "fixture retired" }))) })
    const { store, seam } = await harness({
      "GET api/repos/will/smithers/workspaces/ws-1/files": () => { requested(); return held }
    })
    await seedWorkspace(store)
    const pending = seam.listFiles("/", "ws-1")
    await started
    await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    release(json(200, { entries: [{ name: "secret.txt", type: "file" }] }))
    await pending
    expect(cardOf(store)).toBeUndefined()
  })
})

test("disposing a workspace seam retires a held view", async () => {
  let release!: (response: Response) => void
  let requested!: () => void
  const started = new Promise<void>(resolve => { requested = resolve })
  const held = new Promise<Response>(resolve => { release = resolve; heldReleases.add(() => resolve(json(503, { message: "fixture retired" }))) })
  const { store, seam } = await harness({
    "GET api/repos/will/smithers/workspaces/ws-1": () => { requested(); return held }
  })
  await seedWorkspace(store)
  const pending = seam.viewWorkspace("ws-1")
  await started
  seam.dispose()
  release(json(200, { ...WS_RUNNING, name: "retired private name" }))
  await pending
  expect(store.collections.cloudWorkspaces.get("ws-1")?.name).toBe("review")
  expect(cardOf(store)).toBeUndefined()
})

test("a held workspace mutation cannot publish its old owner's result", async () => {
  let release!: (response: Response) => void
  let requested!: () => void
  const started = new Promise<void>(resolve => { requested = resolve })
  const held = new Promise<Response>(resolve => { release = resolve; heldReleases.add(() => resolve(json(503, { message: "fixture retired" }))) })
  const { store, seam } = await harness({
    "POST api/repos/will/smithers/workspaces/ws-1/suspend": () => { requested(); return held }
  })
  await seedWorkspace(store)
  const pending = seam.suspendWorkspace("ws-1")
  await started
  await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
  release(json(200, { ...WS_RUNNING, status: "suspended", name: "private name" }))
  await pending
  expect(store.collections.cloudWorkspaces.get("ws-1")).toBeUndefined()
  expect(cardOf(store)).toBeUndefined()
})

test("a held workspace inventory cannot restore rows after sign-out", async () => {
  let release!: (response: Response) => void
  let requested!: () => void
  const started = new Promise<void>(resolve => { requested = resolve })
  const held = new Promise<Response>(resolve => { release = resolve; heldReleases.add(() => resolve(json(503, { message: "fixture retired" }))) })
  const { store, seam } = await harness({
    "GET api/user/workspaces": () => { requested(); return held }
  })
  const pending = seam.listWorkspaces()
  await started
  await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
  release(json(200, { workspaces: [USER_ROW] }))
  await pending
  expect(store.collections.cloudWorkspaces.get("ws-1")).toBeUndefined()
  expect([...store.collections.messages.values()].some(row => row.text?.includes("will/smithers"))).toBe(false)
})

// Public operations share authorization before resolving a target or reading HTTP.
describe("workspace authorization and transition receipts", () => {
  for (const condition of ["signed-out", "degraded", "disposed"] as const) {
    test(`${condition} refuses read and mutation doors without changing loaded state`, async () => {
      const { seam, store, requests } = await harness({}, {
        signedIn: condition !== "signed-out",
        degraded: condition === "degraded"
      })
      await seedWorkspace(store)
      await seedCard(store)
      const before = {
        workspaces: [...store.collections.cloudWorkspaces.values()],
        cards: [...store.collections.cards.values()],
        messages: [...store.collections.messages.values()]
      }
      if (condition === "disposed") seam.dispose()
      const refusal = condition === "signed-out" ? "Sign in to Smithers Cloud to continue."
        : condition === "degraded" ? DEGRADED_WORKSPACE_REFUSAL : "The workspace controller is disposed."
      const outcomes = await Promise.all([
        seam.viewWorkspace("ws-1"), seam.suspendWorkspace("ws-1"),
        seam.resumeWorkspace("ws-1"), seam.destroySession("session-1", "ws-1"),
        seam.deleteWorkspace("ws-1", "review"), seam.listFiles("src", "ws-1"), seam.readFile("README.md", "ws-1"),
        seam.listServices("ws-1"), seam.listEgress("ws-1"), seam.listEnvironmentImages("will/smithers")
      ])
      expect([...outcomes]).toEqual(Array.from({ length: 10 }, () => refusal))
      expect(requests).toEqual([])
      expect({
        workspaces: [...store.collections.cloudWorkspaces.values()],
        cards: [...store.collections.cards.values()],
        messages: [...store.collections.messages.values()]
      }).toEqual(before)
    })
  }


  for (const verb of ["suspend", "resume"] as const) {
    test(`${verb} retires an unreadable acknowledgment's held reread after sign-out`, async () => {
      let resolve!: (response: Response) => void
      let entered!: () => void
      const started = new Promise<void>(done => { entered = done })
      const reread = new Promise<Response>(done => {
        resolve = done
        heldReleases.add(() => done(json(503, { message: "fixture retired" })))
      })
      const { seam, store, requests, storage } = await harness({
        [`POST api/repos/will/smithers/workspaces/ws-1/${verb}`]: json(200, {}),
        "GET api/repos/will/smithers/workspaces/ws-1": () => { entered(); return reread }
      })
      await seedWorkspace(store)
      await seedCard(store)
      const operation = verb === "suspend" ? seam.suspendWorkspace("ws-1") : seam.resumeWorkspace("ws-1")
      await bounded(started)
      await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
      const durableAtRetirement = storage.written()
      resolve(json(200, { ...WS_RUNNING, name: "old private state", status: "suspended" }))
      expect(await bounded(operation)).toBe("Sign in to Smithers Cloud to continue.")
      await drainWork()
      expect(requests).toEqual([
        `POST api/repos/will/smithers/workspaces/ws-1/${verb}`, "GET api/repos/will/smithers/workspaces/ws-1"
      ])
      expect(workspacesOf(store)).toEqual([])
      expect(cardOf(store)).toBeUndefined()
      expect(storage.written()).toBe(durableAtRetirement)
    })
  }
})

describe("missing workspace recreation", () => {
  const missing = (snapshot?: string, workspaceId = "ws-1") => json(409, {
    code: "workspace_vm_missing", fault: "infra", message: "Workspace VM no longer exists",
    details: { workspace_id: workspaceId, create_fresh: true, ...(snapshot === undefined ? {} : { snapshot_id: snapshot }) }
  })
  const until = async (predicate: () => boolean) => bounded((async () => { while (!predicate()) await checkpoint() })())
  test("persists selected snapshot, returns before launch, deduplicates, and watches real completion", async () => {
    let releaseCreate!: () => void, releaseRunning!: () => void
    const launch = new Promise<Response>(resolve => { releaseCreate = () => resolve(json(202, { ...WS_RUNNING, id: "ws-new", name: "restored", kind: "container", status: "starting", snapshot_id: "snapshot-owned" })) })
    const running = new Promise<Response>(resolve => { releaseRunning = () => resolve(json(200, { ...WS_RUNNING, id: "ws-new", name: "restored", kind: "container", snapshot_id: "snapshot-owned" })) })
    heldReleases.add(releaseCreate); heldReleases.add(releaseRunning)
    const h = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": missing("snapshot-owned"),
      "POST api/repos/will/smithers/workspaces": () => launch,
      "GET api/repos/will/smithers/workspaces/ws-new": () => running
    })
    await seedWorkspace(h.store, { ...wsRow, status: "suspended" })
    await h.seam.resumeWorkspace("ws-1")
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.snapshotId).toBe("snapshot-owned")
    expect(await bounded(h.seam.openWorkspace(undefined, "will/smithers", "container", "snapshot-owned", "ws-1"))).toEqual({ value: "Creation requested." })
    await until(() => h.bodies.length === 1)
    const request = h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request
    expect(request).toMatchObject({ actor: "user", bookmark: "main", kind: "container", snapshotId: "snapshot-owned", state: "requested" })
    expect(h.storage.written()).toContain("snapshot-owned")
    expect(h.bodies[0]?.body).toEqual({ source_bookmark: "main", kind: "container", snapshot_id: "snapshot-owned", name: request?.name })
    expect(await h.seam.openWorkspace(undefined, "will/smithers", "container", "snapshot-owned", "ws-1")).toEqual({ value: "Creation requested." })
    expect(h.bodies).toHaveLength(1)
    await h.store.dispatch({ type: "composer.changed", actor: "user", draft: "chat remains usable" }).isPersisted.promise
    expect(h.store.session().draft).toBe("chat remains usable")
    releaseCreate()
    await until(() => h.requests.includes("GET api/repos/will/smithers/workspaces/ws-new"))
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.state).toBe("running")
    releaseRunning()
    await until(() => h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.state === "completed")
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.name).toBe("review")
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.status).toBe("suspended")
    expect(h.store.collections.cloudWorkspaces.get("ws-new")?.status).toBe("running")
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request).toMatchObject({ snapshotId: "snapshot-owned", workspaceId: "ws-new", actor: "user" })
  })
  test("real controller keeps the shared toast through unresolved launch and running creation", async () => {
    let releaseCreate!: () => void, releaseRunning!: () => void
    const launch = new Promise<Response>(resolve => { releaseCreate = () => resolve(json(202, { ...WS_RUNNING, id: "toast-new", status: "starting", snapshot_id: "toast-snapshot" })) })
    const running = new Promise<Response>(resolve => { releaseRunning = () => resolve(json(200, { ...WS_RUNNING, id: "toast-new", snapshot_id: "toast-snapshot" })) })
    heldReleases.add(releaseCreate); heldReleases.add(releaseRunning)
    const h = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": missing("toast-snapshot"),
      "POST api/repos/will/smithers/workspaces": () => launch,
      "GET api/repos/will/smithers/workspaces/toast-new": () => running,
      "GET api/repos/will/smithers/contents/.smithers/factory.json": json(404, { message: "No factory" }),
      "GET api/repos/will/smithers/home": json(404, { message: "No apps" })
    })
    h.seam.dispose()
    await seedWorkspace(h.store, { ...wsRow, status: "suspended" })
    const controller = createAppController(h.store, {
      available: false, startTurn: async () => ({ status: "error", message: "unavailable" }),
      cancelTurn: async () => {}, subscribe: () => () => {}
    }, { fetchImpl: (input, init) => h.ctx.http(String(input), init), toastAutoDismissMs: 60_000,
      bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "local", authFlow: "redirect", sandbox: null,
        capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: false }) } })
    try {
      await controller.resumeWorkspace("ws-1")
      expect(await bounded(controller.openWorkspace(undefined, "will/smithers", undefined, "toast-snapshot", "ws-1"))).toEqual({ value: "Creation requested." })
      await new Promise(resolve => setTimeout(resolve, 330))
      expect(h.store.collections.toasts.get("toast-box.recreate:ws-1")?.status).toBe("running")
      await h.store.dispatch({ type: "composer.changed", actor: "user", draft: "still typing" }).isPersisted.promise
      expect(h.store.session().draft).toBe("still typing")
      releaseCreate()
      await until(() => h.requests.includes("GET api/repos/will/smithers/workspaces/toast-new"))
      expect(h.store.collections.toasts.get("toast-box.recreate:ws-1")?.status).toBe("running")
      releaseRunning()
      await until(() => h.store.collections.toasts.get("toast-box.recreate:ws-1")?.status === "ok")
      expect(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.state).toBe("completed")
    } finally { releaseCreate(); releaseRunning(); await controller.dispose() }
  })
  test("ordinary old-row refresh and reload retain original source and never replay an uncertain POST", async () => {
    let releaseCreate!: () => void
    const launch = new Promise<Response>(resolve => { releaseCreate = () => resolve(json(202, { ...WS_RUNNING, id: "late-new", status: "starting" })) })
    heldReleases.add(releaseCreate)
    const h = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": missing("snap-reload"),
      "POST api/repos/will/smithers/workspaces": () => launch
    })
    await seedWorkspace(h.store, { ...wsRow, status: "suspended" })
    await h.seam.resumeWorkspace("ws-1")
    await h.seam.openWorkspace(undefined, "will/smithers", "container", "snap-reload", "ws-1")
    await until(() => h.bodies.length === 1)
    const request = h.store.collections.cloudWorkspaces.get("ws-1")!.recovery!.request!
    h.seam.dispose()
    const reloaded = await createAppStore({ kind: "localStorage", storage: h.storage }); ownedStores.add(reloaded)
    let listed = false, posts = 0, polls = 0
    const old = { ...WS_RUNNING, status: "suspended", target_bookmark: "changed-after-request", kind: "vm" }
    const late = { ...WS_RUNNING, id: "late-new", name: request.name, snapshot_id: "snap-reload", kind: "container", status: "starting" }
    const ctx: SeamContext = { ...h.ctx, store: reloaded, dispatch: reloaded.dispatch, http: async (_url, init) => {
      if (init?.method === "POST") { posts++; throw new Error("uncertain creation must not repeat") }
      if (_url.endsWith("/workspaces/late-new")) { polls++; return json(200, { ...late, status: "running" }) }
      return json(200, listed ? [old, late] : [old])
    } }
    const seam = createWorkspaceSeam(ctx, { pollMs: 1 })
    await seam.refreshWorkspaces("will/smithers")
    expect(reloaded.collections.cloudWorkspaces.get("ws-1")?.recovery?.request).toMatchObject({ id: request.id, bookmark: "main", kind: "container", snapshotId: "snap-reload", state: "requested" })
    expect(reloaded.collections.cloudWorkspaces.get("ws-1")).toMatchObject({ targetBookmark: "changed-after-request", kind: "vm" })
    await seam.openWorkspace(undefined, "will/smithers", "vm", "snap-reload", "ws-1")
    expect(posts).toBe(0)
    listed = true
    await seam.refreshWorkspaces("will/smithers")
    await until(() => reloaded.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.state === "completed")
    expect(polls).toBe(1); expect(posts).toBe(0); expect(h.bodies).toHaveLength(1)
    expect(reloaded.collections.cloudWorkspaces.get("ws-1")?.recovery?.request).toMatchObject({ id: request.id, workspaceId: "late-new", bookmark: "main", kind: "container", snapshotId: "snap-reload" })
    releaseCreate(); await checkpoint()
    expect(h.store.collections.cloudWorkspaces.has("late-new")).toBe(false)
  })
  test.each(["matched source", "different source", "different bookmark", "different kind"])("per-user inventory verifies %s through the existing detail route before reconnecting", async mode => {
    const h = await harness({})
    const cloud = h.store.collections.cloudSessions.get("cloud")!
    const identity = h.store.collections.identitySessions.get("identity")
    const request = { id: "retained-request", name: "recovery-retained", actor: "user" as const, bookmark: "main", kind: "container" as const, state: "requested" as const, snapshotId: "retained-source" }
    await seedWorkspace(h.store, { ...wsRow, status: "suspended", recovery: {
      owner: cloud.username!, ownerRevision: cloud.ownerRevision ?? cloud.revision,
      identityOwnerRevision: identity?.ownerRevision ?? identity?.revision, snapshotId: "retained-source", createFresh: true, request
    } })
    h.seam.dispose()
    let posts = 0, reads = 0
    const seam = createWorkspaceSeam({ ...h.ctx, http: async (url, init) => {
      if (init?.method === "POST") { posts++; throw new Error("cannot repeat creation") }
      if (url.endsWith("/workspaces/candidate-new")) { reads++; return json(200, { ...WS_RUNNING, id: "candidate-new", name: request.name,
        snapshot_id: mode === "different source" ? "different-source" : request.snapshotId,
        target_bookmark: mode === "different bookmark" ? "rewritten" : request.bookmark, kind: mode === "different kind" ? "vm" : request.kind }) }
      return json(200, [USER_ROW, { ...USER_ROW, workspace_id: "candidate-new", workspace_title: request.name, state: "starting" }])
    } }, { pollMs: 1 })
    await seam.refreshWorkspaces()
    await until(() => mode === "matched source" ? h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.state === "completed"
      : h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.error !== undefined)
    expect(reads).toBe(1); expect(posts).toBe(0)
    const retained = h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request
    if (mode === "matched source") expect(retained).toMatchObject({ state: "completed", workspaceId: "candidate-new", snapshotId: "retained-source" })
    else {expect(retained?.state).toBe("requested");expect(retained?.workspaceId).toBeUndefined();expect(retained?.snapshotId).toBe("retained-source")}
  })
  test.each([
    ["snapshot", "named source"], ["bookmark", "named source"], ["kind", "named source"],
    ["snapshot", "backend default"], ["kind", "backend default"]
  ])("completion refuses a changed %s for %s without replacing original intent or resending creation", async (field, source) => {
    const changed = { ...WS_RUNNING, id: "changed-new", snapshot_id: field === "snapshot" ? "another-snapshot" : "selected-snapshot",
      target_bookmark: field === "bookmark" ? "another-bookmark" : "main", kind: field === "kind" ? "vm" : "container" }
    const h = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": missing("selected-snapshot"),
      "POST api/repos/will/smithers/workspaces": json(202, { ...WS_RUNNING, id: "changed-new", snapshot_id: "selected-snapshot", kind: "container", status: "starting" }),
      "GET api/repos/will/smithers/workspaces/changed-new": json(200, changed)
    }, { headless: source === "backend default" })
    await seedWorkspace(h.store, { ...wsRow, status: "suspended", targetBookmark: source === "backend default" ? null : "main" }); await h.seam.resumeWorkspace("ws-1")
    await h.seam.openWorkspace(undefined, "will/smithers", "container", "selected-snapshot", "ws-1")
    await until(() => h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.state !== "requested")
    await until(() => h.requests.includes("GET api/repos/will/smithers/workspaces/changed-new"))
    await until(() => h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.error !== undefined
      || h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.state === "completed")
    const request = h.store.collections.cloudWorkspaces.get("ws-1")!.recovery!.request!
    expect(request).toMatchObject({ bookmark: source === "backend default" ? null : "main", kind: "container", snapshotId: "selected-snapshot", workspaceId: "changed-new", state: "running", error: "Creation source changed." })
    await h.seam.openWorkspace(undefined, "will/smithers", "vm", undefined, "ws-1")
    expect(h.bodies).toHaveLength(1)
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.id).toBe(request.id)
  })
  test.each(["snapshot", "bookmark", "kind"])("acknowledged creation with changed %s is refused before joining its completion watch", async field => {
    const h = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": missing("ack-snapshot"),
      "POST api/repos/will/smithers/workspaces": json(202, { ...WS_RUNNING, id: "ack-mismatch", status: "starting",
        snapshot_id: field === "snapshot" ? "different-snapshot" : "ack-snapshot",
        target_bookmark: field === "bookmark" ? "different-bookmark" : "main", kind: field === "kind" ? "vm" : "container" })
    })
    await seedWorkspace(h.store, { ...wsRow, status: "suspended" }); await h.seam.resumeWorkspace("ws-1")
    await h.seam.openWorkspace(undefined, "will/smithers", "container", "ack-snapshot", "ws-1")
    await until(() => h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.error !== undefined)
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request).toMatchObject({ bookmark: "main", kind: "container",
      snapshotId: "ack-snapshot", state: "running", workspaceId: "ack-mismatch", error: "Creation source changed." })
    expect(h.requests).not.toContain("GET api/repos/will/smithers/workspaces/ack-mismatch")
    await h.seam.openWorkspace(undefined, "will/smithers", "vm", undefined, "ws-1")
    expect(h.bodies).toHaveLength(1)
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.status).toBe("suspended")
  })
  test.each(["snapshot restore", "fresh create"])("null source records backend-default intent for %s and accepts the resolved bookmark", async mode => {
    const snapshot = mode === "snapshot restore" ? "default-snapshot" : undefined
    const created = { ...WS_RUNNING, id: "default-new", target_bookmark: "backend-default", kind: "container",
      ...(snapshot === undefined ? {} : { snapshot_id: snapshot }) }
    const h = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": missing(snapshot),
      "POST api/repos/will/smithers/workspaces": json(202, { ...created, status: "starting" }),
      "GET api/repos/will/smithers/workspaces/default-new": json(200, created)
    }, { headless: true })
    expect(h.store.collections.repositories.get("will/smithers")?.head).toBeNull()
    await seedWorkspace(h.store, { ...wsRow, status: "suspended", targetBookmark: null })
    await h.seam.resumeWorkspace("ws-1")
    await h.seam.openWorkspace(undefined, "will/smithers", "container", snapshot, "ws-1")
    await until(() => h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.state === "completed"
      || h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.error !== undefined)
    const request = h.store.collections.cloudWorkspaces.get("ws-1")!.recovery!.request!
    expect(request).toMatchObject({ bookmark: null, kind: "container", state: "completed", workspaceId: "default-new" })
    expect(request.error).toBeUndefined()
    expect(h.bodies[0]?.body).toEqual({ kind: "container", name: request.name, ...(snapshot === undefined ? {} : { snapshot_id: snapshot }) })
    expect(h.bodies[0]?.body).not.toHaveProperty("source_bookmark")
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.targetBookmark).toBeNull()
    expect(h.store.collections.cloudWorkspaces.get("default-new")?.targetBookmark).toBe("backend-default")
    expect(h.bodies).toHaveLength(1)
  })
  test.each(["snapshot restore", "fresh create"])("reload reconciles retained backend-default %s through owner-scoped list and detail without POST", async mode => {
    const h = await harness({})
    const cloud = h.store.collections.cloudSessions.get("cloud")!
    const identity = h.store.collections.identitySessions.get("identity")
    const request = { id: "default-retained", name: "default-retained-name", actor: "user" as const, bookmark: null,
      kind: "container" as const, state: "requested" as const, ...(mode === "snapshot restore" ? { snapshotId: "default-retained-snapshot" } : {}) }
    await seedWorkspace(h.store, { ...wsRow, status: "suspended", targetBookmark: null, recovery: {
      owner: cloud.username!, ownerRevision: cloud.ownerRevision ?? cloud.revision,
      identityOwnerRevision: identity?.ownerRevision ?? identity?.revision, createFresh: true, request
    } })
    h.seam.dispose()
    const reloaded = await createAppStore({ kind: "localStorage", storage: h.storage }); ownedStores.add(reloaded)
    let posts = 0, reads = 0
    const seam = createWorkspaceSeam({ ...h.ctx, store: reloaded, dispatch: reloaded.dispatch, http: async (url, init) => {
      if (init?.method === "POST") { posts++; throw new Error("cannot repeat uncertain creation") }
      if (url.endsWith("/workspaces/default-known")) { reads++; return json(200, { ...WS_RUNNING, id: "default-known", name: request.name,
        target_bookmark: "backend-default", kind: "container", ...(request.snapshotId === undefined ? {} : { snapshot_id: request.snapshotId }) }) }
      return json(200, [USER_ROW, { ...USER_ROW, workspace_id: "default-known", workspace_title: request.name, state: "starting" }])
    } }, { pollMs: 1 })
    await seam.refreshWorkspaces()
    await until(() => reloaded.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.state === "completed"
      || reloaded.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.error !== undefined)
    expect(reloaded.collections.cloudWorkspaces.get("ws-1")?.recovery?.request).toMatchObject({ ...request, state: "completed", workspaceId: "default-known" })
    expect(reloaded.collections.cloudWorkspaces.get("default-known")?.targetBookmark).toBe("backend-default")
    expect(reads).toBe(1); expect(posts).toBe(0)
  })
  test.each(["no snapshot", "snapshot unavailable"])("%s offers fresh named creation and retains original intent", async mode => {
    const h = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": missing(mode === "no snapshot" ? undefined : "gone-snapshot"),
      "POST api/repos/will/smithers/workspaces": mode === "no snapshot"
        ? json(202, { ...WS_RUNNING, id: "fresh", name: "fresh", status: "starting" })
        : json(404, { code: "snapshot_not_found", message: "Snapshot unavailable; create fresh", details: { workspace_id: "new-failed", create_fresh: true } }),
      "GET api/repos/will/smithers/workspaces/fresh": json(200, { ...WS_RUNNING, id: "fresh" })
    })
    await seedWorkspace(h.store, { ...wsRow, status: "suspended" }); await h.seam.resumeWorkspace("ws-1")
    await h.seam.openWorkspace(undefined, "will/smithers", undefined, mode === "no snapshot" ? undefined : "gone-snapshot", "ws-1")
    await until(() => ["completed", "failed"].includes(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.state ?? ""))
    const facts = h.store.collections.cloudWorkspaces.get("ws-1")!.recovery!
    expect(facts.createFresh).toBe(true); expect(facts.snapshotId).toBeUndefined()
    expect(h.bodies[0]?.body).toMatchObject({ name: facts.request?.name })
    expect(facts.request?.name).not.toBe("review")
    if (mode === "no snapshot") expect(h.bodies[0]?.body).not.toHaveProperty("snapshot_id")
    else { expect(facts.request).toMatchObject({ snapshotId: "gone-snapshot", state: "failed" }); expect(facts.request?.error).toContain("Snapshot unavailable") }
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.status).toBe("suspended")
  })
  test("provider failure after acknowledgment retains the failed new row and original selected snapshot", async () => {
    const h = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": missing("provider-gone"),
      "POST api/repos/will/smithers/workspaces": json(202, { ...WS_RUNNING, id: "failed-new", status: "starting", snapshot_id: "provider-gone" }),
      "GET api/repos/will/smithers/workspaces/failed-new": json(200, { ...WS_RUNNING, id: "failed-new", status: "failed", snapshot_id: "provider-gone",
        failure_code: "snapshot_not_found", failure_message: "Snapshot unavailable; create fresh" })
    })
    await seedWorkspace(h.store, { ...wsRow, status: "suspended" }); await h.seam.resumeWorkspace("ws-1")
    await h.seam.openWorkspace(undefined, "will/smithers", undefined, "provider-gone", "ws-1")
    await until(() => h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.state === "failed")
    expect(h.store.collections.cloudWorkspaces.get("failed-new")).toMatchObject({ status: "failed", sourceSnapshotId: "provider-gone", failureCode: "snapshot_not_found" })
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery).toMatchObject({ createFresh: true,
      request: { snapshotId: "provider-gone", workspaceId: "failed-new", state: "failed", error: "Snapshot unavailable; create fresh" } })
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.snapshotId).toBeUndefined()
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.status).toBe("suspended")
  })
  test.each(["transport lost", "gateway failure", "malformed acknowledgment"])("%s remains ambiguous and never resends creation", async mode => {
    const h = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": missing("ambiguous-snapshot"),
      "POST api/repos/will/smithers/workspaces": mode === "transport lost" ? () => { throw new Error("connection lost") }
        : mode === "gateway failure" ? json(502, { message: "gateway lost reply" }) : json(202, { accepted: true })
    })
    await seedWorkspace(h.store, { ...wsRow, status: "suspended" }); await h.seam.resumeWorkspace("ws-1")
    await h.seam.openWorkspace(undefined, "will/smithers", undefined, "ambiguous-snapshot", "ws-1")
    await until(() => h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.error !== undefined)
    const facts = h.store.collections.cloudWorkspaces.get("ws-1")!.recovery!
    expect(facts.request).toMatchObject({ state: "requested", snapshotId: "ambiguous-snapshot" })
    await h.seam.openWorkspace(undefined, "will/smithers", undefined, "ambiguous-snapshot", "ws-1")
    await h.seam.openWorkspace(undefined, "will/smithers", undefined, undefined, "ws-1")
    expect(h.bodies).toHaveLength(1)
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.id).toBe(facts.request?.id)
  })
  test("a bounded watch that remains starting keeps its confirmed row and forbids a duplicate creation", async () => {
    const h = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": missing("slow-snapshot"),
      "POST api/repos/will/smithers/workspaces": json(202, { ...WS_RUNNING, id: "slow-new", status: "starting", snapshot_id: "slow-snapshot" }),
      "GET api/repos/will/smithers/workspaces/slow-new": json(200, { ...WS_RUNNING, id: "slow-new", status: "starting", snapshot_id: "slow-snapshot" })
    })
    await seedWorkspace(h.store, { ...wsRow, status: "suspended" }); await h.seam.resumeWorkspace("ws-1")
    await h.seam.openWorkspace(undefined, "will/smithers", undefined, "slow-snapshot", "ws-1")
    await until(() => h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request?.error !== undefined)
    expect(h.requests.filter(key => key === "GET api/repos/will/smithers/workspaces/slow-new")).toHaveLength(120)
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery?.request).toMatchObject({ state: "running", workspaceId: "slow-new", error: "Creation not confirmed." })
    await h.seam.openWorkspace(undefined, "will/smithers", undefined, undefined, "ws-1")
    expect(h.bodies).toHaveLength(1)
  })
  test("a changed account retires the unresolved launch without publishing its new row", async () => {
    let release!: () => void
    const launch = new Promise<Response>(resolve => { release = () => resolve(json(202, { ...WS_RUNNING, id: "stale-new", status: "starting" })) })
    heldReleases.add(release)
    const h = await harness({ "POST api/repos/will/smithers/workspaces/ws-1/resume": missing("stale-snapshot"), "POST api/repos/will/smithers/workspaces": () => launch })
    await seedWorkspace(h.store, { ...wsRow, status: "suspended" }); await h.seam.resumeWorkspace("ws-1")
    await h.seam.openWorkspace(undefined, "will/smithers", undefined, "stale-snapshot", "ws-1")
    await until(() => h.bodies.length === 1)
    await h.store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "another", scopes: null, expiresAt: null }).isPersisted.promise
    release(); await drainWork()
    expect(h.store.collections.cloudWorkspaces.has("stale-new")).toBe(false)
    expect(await h.seam.openWorkspace(undefined, "will/smithers", undefined, "stale-snapshot", "ws-1")).toContain("unavailable")
    expect(h.bodies).toHaveLength(1)
  })
  test("foreign, forged, or stale-owner recovery never launches", async () => {
    const h = await harness({ "POST api/repos/will/smithers/workspaces/ws-1/resume": missing("owned-snapshot", "foreign-box") })
    await seedWorkspace(h.store); await h.seam.resumeWorkspace("ws-1")
    expect(h.store.collections.cloudWorkspaces.get("ws-1")?.recovery).toBeUndefined()
    expect(await h.seam.openWorkspace(undefined, "will/smithers", undefined, "owned-snapshot", "ws-1")).toContain("unavailable")
    await seedWorkspace(h.store, { ...wsRow, recovery: { owner: "another", ownerRevision: 0, createFresh: true, snapshotId: "owned-snapshot" } })
    expect(await h.seam.openWorkspace(undefined, "will/smithers", undefined, "owned-snapshot", "ws-1")).toContain("unavailable")
    expect(h.requests).toHaveLength(1)
  })
})
