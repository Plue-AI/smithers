import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createActorBindings } from "../ActorBindings"
import type { AppStore } from "../AppStore"
import type { CloudWorkspaceInput } from "../AppState"
import { dropDesktopStream, readDesktopStream } from "./DesktopStream"
import { createWorkspaceSeam as makeWorkspaceSeam, DEGRADED_WORKSPACE_REFUSAL, desktopBoxWait, desktopSessionRetry, terminalSessionRetry } from "./WorkspaceSeam"
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

/*
 * Lane L3b — a desktop workspace (plue's NixOS compute path). `kind` is
 * `desktop`, the environment carries the registry `image` the VM booted, and
 * the DTO's own `desktop` object holds the RELATIVE stream path and the
 * session that was last minted (null before the first mint). Nothing here is
 * a credential: the token only exists in the session POST's answer.
 */
const WS_DESKTOP = {
  ...WS_RUNNING,
  kind: "desktop",
  environment: {
    source: ".smithers/environment.nix",
    revision: "b3f21c9d4e5a6b7c",
    closure_hash: "9f2b1c0d4e5a6b7c8d9e0f1a",
    image: "registry.smithers-cloud.test/environments/smithersai/smithers:nixos-2405-9f2b1c0d"
  },
  /* plue#496: `ready` is true only once the guest verified noVNC. */
  desktop: { ready: true, stream_url: "/api/workspaces/ws-1/desktop/stream", session: null }
}

/*
 * The 201 of POST …/workspaces/{id}/desktop/session. The `token`, the
 * `vnc_password`, and the ABSOLUTE `stream_url` that embeds both are the only
 * credentials in this suite; every test below asserts they never leave the
 * ephemeral holder.
 */
const DESKTOP_TOKEN = "dtok-8f3a2b1c"
const DESKTOP_VNC_PASSWORD = "vncpw-51ce9d0a"
const DESKTOP_STREAM_URL =
  `https://api.smithers-cloud.test/api/workspaces/ws-1/desktop/${DESKTOP_TOKEN}/vnc.html?autoconnect=1&password=${DESKTOP_VNC_PASSWORD}`
const DESKTOP_MINT = {
  workspace_id: "ws-1",
  stream_url: DESKTOP_STREAM_URL,
  session: { id: "dsess-1", expires_at: "2026-09-03T09:12:00Z" },
  token: DESKTOP_TOKEN,
  vnc_password: DESKTOP_VNC_PASSWORD
}

/** plue's UserWorkspaceRow (GET /api/user/workspaces — services/workspace.go): a switcher row, not the DTO; recorded once for every seam that reads the route. */
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
    openTerminal: (...args) => observe(seam.openTerminal(...args)),
    suspendWorkspace: (...args) => observe(seam.suspendWorkspace(...args)),
    resumeWorkspace: (...args) => observe(seam.resumeWorkspace(...args)),
    listSessions: (...args) => observe(seam.listSessions(...args)),
    destroySession: (...args) => observe(seam.destroySession(...args)),
    deleteWorkspace: (...args) => observe(seam.deleteWorkspace(...args)),
    listFiles: (...args) => observe(seam.listFiles(...args)),
    readFile: (...args) => observe(seam.readFile(...args)),
    listServices: (...args) => observe(seam.listServices(...args)),
    listEgress: (...args) => observe(seam.listEgress(...args)),
    openDesktop: (...args) => observe(seam.openDesktop(...args)),
    rotateDesktop: (...args) => observe(seam.rotateDesktop(...args)),
    openDesktopBox: (...args) => observe(seam.openDesktopBox(...args)),
    stopDesktopWait: (...args) => observe(seam.stopDesktopWait(...args)),
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
  dropDesktopStream()
  if (unexpectedRequests.length > 0) errors.push(new Error(`Unexpected Workspace HTTP: ${unexpectedRequests.join(", ")}`))
  unexpectedRequests.length = 0
  if (errors.length > 0) throw new AggregateError(errors, "Workspace fixture cleanup failed")
})

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean; readonly degraded?: boolean; readonly desktopWaitMs?: number } = {}
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
  const dispatched: Array<{ readonly type: string; readonly tabs: Array<string>; readonly attached: string | undefined; toast?: unknown }> = []
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
      dispatched.push({ type: transition.type, tabs: tabsOf(store), attached: payloadOf(store)?.terminalSessionId, toast: structuredClone(store.collections.toasts.get("toast-box.desktop.open:ws-1")) })
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
        head: { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" }
      }
    ]
  }).isPersisted.promise
  return {
    ctx,
    store,
    seam: createWorkspaceSeam(ctx, { pollMs: 1, desktopWaitMs: options.desktopWaitMs ?? 0 }),
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

const seedCard = async (store: AppStore, terminalSessionId?: string): Promise<void> => {
  await store.dispatch({
    type: "card.upsert",
    actor: "user",
    card: {
      id: "workspace-ws-1",
      kind: "workspace",
      title: "review · will/smithers",
      status: "active",
      createdAt: 1,
      ordinal: 0,
      payload: {
        workspaceId: "ws-1",
        repo: "will/smithers",
        name: "review",
        targetBookmark: "main",
        status: "running",
        provisioningStage: null,
        bookmarkHead: null,

        sessions: [],
        ...(terminalSessionId === undefined ? {} : { terminalSessionId })
      }
    }
  }).isPersisted.promise
}

const cardOf = (store: AppStore, workspaceId = "ws-1") => store.collections.cards.get(`workspace-${workspaceId}`)

/** The workspace card's payload, narrowed; undefined when the card is absent. */
const payloadOf = (store: AppStore, workspaceId = "ws-1") => {
  const card = cardOf(store, workspaceId)
  return card?.kind === "workspace" ? card.payload : undefined
}

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
    expect(await seam.openTerminal("ws-1")).toBe("Sign in to Smithers Cloud to continue.")
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

  test("a vm and a desktop on ONE bookmark are two rows, and the list carries both (plue#495)", async () => {
    /*
     * plue#495 keys workspace reuse on the KIND: a create for a kind that has
     * no active row makes a second computer on the same bookmark rather than
     * handing back the first. The list is what shows it, so both rows and
     * both tree copies must survive the same-bookmark collision.
     */
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces": json(200, [
        { ...WS_RUNNING, id: "ws-vm", kind: "vm", name: "landing vm", target_bookmark: "landing/main" },
        { ...WS_RUNNING, id: "ws-desk", kind: "desktop", name: "landing desktop", target_bookmark: "landing/main" }
      ])
    })

    await seam.listWorkspaces("will/smithers")

    expect(workspacesOf(store).map((row) => [row.id, row.kind, row.targetBookmark])).toEqual([
      ["ws-vm", "vm", "landing/main"],
      ["ws-desk", "desktop", "landing/main"]
    ])
    expect(copiesOf(store).map((copy) => copy.id).sort()).toEqual(["workspace:ws-desk", "workspace:ws-vm"])
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
  test("open creates with the repository's head bookmark, renders the card, and watches until settled", async () => {
    let polls = 0
    const { store, seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, { ...WS_RUNNING, status: "pending", provisioning_stage: "allocating" }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [{ name: "main", target_change_id: "qupxosqw", target_commit_id: "c0ffee1" }], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, [{ id: "snap-1", name: "golden", created_at: "2026-08-01T00:00:00Z" }]),
      "api/repos/will/smithers/workspace/sessions": json(200, []),
      "api/repos/will/smithers/workspaces/ws-1": () => {
        polls += 1
        return json(200, polls < 2 ? { ...WS_RUNNING, status: "starting" } : WS_RUNNING)
      }
    })
    const result = await seam.openWorkspace()
    expect(typeof result).toBe("object")
    expect(store.session().activeRepoKey).toBe("will/smithers#workspace:ws-1")
    // The create carried the repository's head bookmark as the source.
    expect(requests[0]).toBe("POST api/repos/will/smithers/workspaces")
    const card = cardOf(store)
    expect(card).toEqual(
      expect.objectContaining({
        kind: "workspace",
        title: "review · will/smithers",
        payload: expect.objectContaining({
          workspaceId: "ws-1",
          repo: "will/smithers",
          name: "review",
          targetBookmark: "main",
          bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },

          sessions: []
        })
      })
    )
    // The card never lags the collection, whichever landed last — the act's answer or the watch's first poll.
    expect(payloadOf(store)?.status).toBe(workspacesOf(store)[0]?.status)
    // The watch settles the row and the card, then stops.
    await wait(30)
    expect(workspacesOf(store)[0]).toEqual(expect.objectContaining({ id: "ws-1", status: "running" }))
    expect(payloadOf(store)?.status).toBe("running")
    const getPolls = requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length
    await wait(20)
    expect(requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length).toBe(getPolls)
    // Never a kind, an uptime, or a workspace head.
    expect(JSON.stringify(cardOf(store))).not.toContain("uptime")
    expect(JSON.stringify(cardOf(store))).not.toContain("workspaceHead")
  })

  /*
   * Critique finding 6: the aux loads finished after the watch's first
   * poll had settled the row, and the final render wrote the create's
   * `pending` back over the card while the tree read `running`.
   */
  test("a poll that settles before the auxiliaries load wins: card, tree, and collection agree and no watch remains", async () => {
    const delayed = (body: unknown) => async () => {
      await wait(30)
      return json(200, body)
    }
    const { store, seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(202, { ...WS_RUNNING, status: "pending", provisioning_stage: "allocating" }),
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_RUNNING),
      "api/repos/will/smithers/bookmarks": delayed({ items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": delayed([]),
      "api/repos/will/smithers/workspace/sessions": delayed([])
    })
    const result = await seam.openWorkspace()
    expect(typeof result).toBe("object")
    expect(workspacesOf(store)[0]?.status).toBe("running")
    expect(copiesOf(store)[0]?.state).toBe("running")
    expect(payloadOf(store)?.status).toBe("running")
    expect(payloadOf(store)?.provisioningStage).toBeNull()
    const polls = requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length
    await wait(20)
    expect(requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length).toBe(polls)
  })

  test("view renders the collection's status when a poll advanced it during the auxiliaries", async () => {
    let gets = 0
    const delayed = (body: unknown) => async () => {
      await wait(30)
      return json(200, body)
    }
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": () => {
        gets += 1
        return json(200, gets === 1 ? { ...WS_RUNNING, status: "starting", provisioning_stage: "boot" } : WS_RUNNING)
      },
      "api/repos/will/smithers/bookmarks": delayed({ items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": delayed([]),
      "api/repos/will/smithers/workspace/sessions": delayed([])
    })
    await seedWorkspace(store, { ...wsRow, status: "starting", provisioningStage: "boot" })
    const result = await seam.viewWorkspace("ws-1")
    expect(typeof result).toBe("object")
    expect(payloadOf(store)?.status).toBe(workspacesOf(store)[0]?.status)
    expect(payloadOf(store)?.status).toBe("running")
  })

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
  test("suspend posts and renders the settled row; a failure rides the card", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/suspend": json(200, { ...WS_RUNNING, status: "suspended" })
    })
    await seedWorkspace(store)
    const result = await seam.suspendWorkspace("ws-1")
    expect(typeof result).toBe("object")
    expect(workspacesOf(store)[0]?.status).toBe("suspended")
    expect(copiesOf(store)[0]?.state).toBe("suspended")
    expect(payloadOf(store)?.status).toBe("suspended")
  })

  test("suspend failure keeps the refusal on the card", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/suspend": json(500, { message: "driver exploded" })
    })
    await seedWorkspace(store)
    const refusal = await seam.suspendWorkspace("ws-1")
    expect(refusal).toBe("The request to Smithers Cloud failed (500). That's a bug in Smithers, not something you did.")
    expect(refusal).not.toContain("driver exploded")
    expect(payloadOf(store)?.error).toBe("The request to Smithers Cloud failed (500). That's a bug in Smithers, not something you did.")
    expect(workspacesOf(store)[0]?.status).toBe("running")
  })

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

describe("workspace seam snapshots", () => {
})

describe("workspace seam terminal", () => {
  test("a suspended workspace refuses honestly and says how to fix it", async () => {
    const { store, seam } = await harness({})
    await seedWorkspace(store, { ...wsRow, status: "suspended" })
    const refusal = await seam.openTerminal("ws-1")
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("suspended")
    expect(refusal).toContain("/box.resume")
    expect(tabsOf(store)).toEqual([])
  })

  test("open creates a session, waits for running, and embeds it without switching away from chat", async () => {
    let polls = 0
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspace/sessions": json(201, { id: "sess-1", status: "pending", workspace_id: "ws-1", created_at: null }),
      "api/repos/will/smithers/workspace/sessions/sess-1": () => {
        polls += 1
        return json(200, { id: "sess-1", status: polls < 2 ? "pending" : "running", workspace_id: "ws-1", created_at: null })
      },
      "api/repos/will/smithers/workspace/sessions": json(200, [{ id: "sess-1", status: "running", workspace_id: "ws-1", created_at: null }])
    })
    await seedWorkspace(store)
    const result = await seam.openTerminal("ws-1")
    expect(typeof result).toBe("object")
    expect(polls).toBeGreaterThanOrEqual(2)
    expect(tabsOf(store)).toEqual([])
    expect(store.session().activeTabId).toBe("main")
    const payload = payloadOf(store)
    expect(payload?.terminalSessionId).toBe("sess-1")
    expect(payload?.facet).toBe("terminal")
    expect(payload?.sessions).toEqual([{ id: "sess-1", status: "running", createdAt: null, kind: null, language: null }])
  })

  test("a live attached session re-attaches instead of creating", async () => {
    const { store, seam, requests } = await harness({
      "api/repos/will/smithers/workspace/sessions/sess-1": json(200, { id: "sess-1", status: "running", workspace_id: "ws-1", created_at: null })
    })
    await seedWorkspace(store)
    await seedCard(store, "sess-1")
    const result = await seam.openTerminal("ws-1")
    expect(typeof result).toBe("object")
    expect(requests).not.toContain("POST api/repos/will/smithers/workspace/sessions")
    expect(store.collections.tabs.get("sess-1")).toBeUndefined()
    expect(payloadOf(store)?.terminalSessionId).toBe("sess-1")
  })

  test("a 503 guest_not_ready reads plue's own body and code, and retries the session POST on the Retry-After it named (plue#504)", async () => {
    const previous = { ...terminalSessionRetry }
    /* plue asks for 3s; the test shortens the wait rather than sleeping through it. */
    terminalSessionRetry.defaultDelayMs = 1
    try {
      let posts = 0
      const { store, seam, requests } = await harness({
        "POST api/repos/will/smithers/workspace/sessions": () => {
          posts += 1
          /*
           * plue's own 503 (routes/workspace_terminal_test.go): writeRouteError
           * sanitizes a 5xx MESSAGE to the status text but keeps `code`, and
           * `GuestNotReady` carries RetryAfter 3 onto the header.
           */
          return posts < 3
            ? json(503, { code: "guest_not_ready", message: "service unavailable" }, { "retry-after": "0" })
            : json(201, { id: "sess-1", status: "running", workspace_id: "ws-1", created_at: null })
        },
        "api/repos/will/smithers/workspace/sessions/sess-1": json(200, { id: "sess-1", status: "running", workspace_id: "ws-1", created_at: null }),
        "api/repos/will/smithers/workspace/sessions": json(200, [{ id: "sess-1", status: "running", workspace_id: "ws-1", created_at: null }])
      })
      await seedWorkspace(store)

      const result = await seam.openTerminal("ws-1")

      /* The server asked to be retried, so it was — and the third answer created the session. */
      expect(posts).toBe(3)
      expect(requests.filter((request) => request === "POST api/repos/will/smithers/workspace/sessions")).toHaveLength(3)
      expect(typeof result).toBe("object")
      expect(store.collections.tabs.get("sess-1")).toBeUndefined()
    expect(payloadOf(store)?.terminalSessionId).toBe("sess-1")
      /* A POST that finally succeeded leaves no refusal behind. */
      expect(payloadOf(store)?.terminalRefusal).toBeUndefined()
    } finally {
      Object.assign(terminalSessionRetry, previous)
    }
  })

  test("a guest_not_ready that never clears gives up at the bound, with plue's code and whose fault it is on the terminal facet", async () => {
    const previous = { ...terminalSessionRetry }
    /* The default is deliberately NOT used here: the wait must come from the header. */
    terminalSessionRetry.defaultDelayMs = 0
    terminalSessionRetry.maxAttempts = 2
    try {
      let posts = 0
      const { store, seam } = await harness({
        "POST api/repos/will/smithers/workspace/sessions": () => {
          posts += 1
          return json(503, { code: "guest_not_ready", message: "service unavailable" }, { "retry-after": "1" })
        }
      })
      await seedWorkspace(store)

      const startedAt = Date.now()
      const refusal = await seam.openTerminal("ws-1")

      expect(posts).toBe(2)
      /* One retry, and it waited the second the header asked for — not the app's own default. */
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900)
      expect(refusal).toBe("guest_not_ready — The request to Smithers Cloud failed (503). Not ready yet — nothing is wrong.")
      expect(refusal).not.toContain("service unavailable")
      expect(payloadOf(store)?.terminalRefusal).toEqual({
        status: 503,
        message: "The request to Smithers Cloud failed (503)",
        code: "guest_not_ready",
        retryAfterSeconds: 1,
        fault: "wait",
        origin: "plue"
      })
      expect(payloadOf(store)?.facet).toBe("terminal")
      expect(tabsOf(store)).toEqual([])
    } finally {
      Object.assign(terminalSessionRetry, previous)
    }
  })

  test("any other session refusal is answered once — a code the server did not ask to be retried is not retried", async () => {
    let posts = 0
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspace/sessions": () => {
        posts += 1
        return json(409, { message: "workspace is not running" })
      }
    })
    await seedWorkspace(store)

    const refusal = await seam.openTerminal("ws-1")

    expect(posts).toBe(1)
    expect(refusal).toBe("workspace is not running. Smithers can't do that as asked.")
    expect(payloadOf(store)?.terminalRefusal).toEqual({
      status: 409,
      message: "workspace is not running",
      code: null,
      retryAfterSeconds: null,
      fault: "user",
      origin: "worker"
    })
  })

  test("a second terminal open supersedes a pending guest_not_ready retry", async () => {
    const previous = { ...terminalSessionRetry }
    /* No Retry-After on the wire, so the loop parks for this long — long enough to open again mid-wait. */
    terminalSessionRetry.defaultDelayMs = 50
    try {
      let posts = 0
      const { store, seam } = await harness({
        "POST api/repos/will/smithers/workspace/sessions": () => {
          posts += 1
          return posts === 1
            ? json(503, { code: "guest_not_ready", message: "service unavailable" })
            : json(201, { id: "sess-1", status: "running", workspace_id: "ws-1", created_at: null })
        },
        "api/repos/will/smithers/workspace/sessions/sess-1": json(200, { id: "sess-1", status: "running", workspace_id: "ws-1", created_at: null }),
        "api/repos/will/smithers/workspace/sessions": json(200, [])
      })
      await seedWorkspace(store)

      const pending = seam.openTerminal("ws-1")
      await wait(5)
      await seam.openTerminal("ws-1")
      await pending

      /* The first loop stopped at the second open instead of posting again. */
      expect(posts).toBe(2)
      expect(store.collections.tabs.get("sess-1")).toBeUndefined()
    expect(payloadOf(store)?.terminalSessionId).toBe("sess-1")
    } finally {
      Object.assign(terminalSessionRetry, previous)
    }
  })

  test("destroy session detaches the card that pointed at it and closes its tab in the same transaction", async () => {
    const { store, seam, dispatched } = await harness({
      "POST api/repos/will/smithers/workspace/sessions/sess-1/destroy": json(204, null),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)
    await seedCard(store, "sess-1")
    const result = await seam.destroySession("sess-1", "ws-1")
    expect(typeof result).toBe("object")
    const payload = payloadOf(store)
    expect(payload?.terminalSessionId).toBeUndefined()
    expect(payload?.sessions).toEqual([])
    // As the transition left the store, the card no longer pointed at the session.
    const destroyed = dispatched.find((entry) => entry.type === "workspace.session.destroyed")
    expect(destroyed).toEqual({ type: "workspace.session.destroyed", tabs: [], attached: undefined })
    expect(dispatched[0]?.type).toBe("workspace.session.destroyed")
  })

  test("destroying a session reads the repository's session list once for every card it refreshes", async () => {
    const cards = 10
    let lists = 0
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspace/sessions/sess-0/destroy": json(204, null),
      "api/repos/will/smithers/workspace/sessions": () => {
        lists += 1
        return json(
          200,
          Array.from({ length: cards }, (_, index) => ({
            id: `sess-${index}`,
            status: "running",
            workspace_id: `ws-${index}`,
            created_at: null
          })).filter((session) => session.id !== "sess-0")
        )
      }
    })
    for (let index = 0; index < cards; index += 1) {
      const workspace: CloudWorkspaceInput = { ...wsRow, id: `ws-${index}`, name: `review ${index}` }
      await seedWorkspace(store, workspace)
      await store.dispatch({
        type: "card.upsert",
        actor: "user",
        card: {
          id: `workspace-${workspace.id}`,
          kind: "workspace",
          title: workspace.name,
          status: "active",
          createdAt: 1,
          ordinal: index,
          payload: {
            workspaceId: workspace.id,
            repo: workspace.repoId,
            name: workspace.name,
            targetBookmark: "main",
            status: "running",
            provisioningStage: null,
            bookmarkHead: null,

            sessions: []
          }
        }
      }).isPersisted.promise
    }

    const result = await seam.destroySession("sess-0", "ws-0")

    expect(typeof result).toBe("object")
    /* The list route is repository-wide, so one read refreshes all ten cards. */
    expect(lists).toBe(1)
    /* Each card still shows only its own workspace's sessions out of that one snapshot. */
    expect(payloadOf(store, "ws-0")?.sessions).toEqual([])
    expect(payloadOf(store, "ws-7")?.sessions.map((session) => session.id)).toEqual(["sess-7"])
    expect(payloadOf(store, "ws-9")?.sessions.map((session) => session.id)).toEqual(["sess-9"])
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

describe("workspace seam facets", () => {
})

/*
 * Lane L3: plue#446's header facts and plue#449's facet routes. The DTO
 * fixture is the live sample probed from the app on 2026-09-02; the facet
 * doubles answer the shapes `internal/services/workspace_facets.go` and
 * `internal/services/sandbox_egress_audit.go` write.
 */
describe("workspace seam header facts (plue#446)", () => {
  test("view parses the live DTO's kind, head, ahead/behind, environment, persistence and ssh host onto the row and the card", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_LIVE),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)
    await seam.viewWorkspace("ws-1")
    expect(workspacesOf(store)[0]).toEqual(
      expect.objectContaining({
        id: "ws-1",
        name: "smithers landing",
        targetBookmark: "landing/smithers/main",
        status: "suspended",
        kind: "container",
        head: { changeId: "qupxosqwmnrt", commitId: "c0ffee1234567890" },
        ahead: 0,
        behind: 0,
        startedAt: null,
        /* Lane L3b: a container names no image, and an absent image is null — never an empty reference. */
        environment: {
          source: ".smithers/environment.nix",
          revision: "b3f21c9d4e5a6b7c",
          closureHash: "sha256-abc",
          image: null
        },
        persistence: "persistent",
        sshHost: "vm-77@ssh.smithers-cloud.test"
      })
    )
    expect(payloadOf(store)).toEqual(
      expect.objectContaining({
        workspaceKind: "container",
        head: { changeId: "qupxosqwmnrt", commitId: "c0ffee1234567890" },
        ahead: 0,
        behind: 0,
        startedAt: null,
        /* Lane L3b: a container names no image, and an absent image is null — never an empty reference. */
        environment: {
          source: ".smithers/environment.nix",
          revision: "b3f21c9d4e5a6b7c",
          closureHash: "sha256-abc",
          image: null
        },
        persistence: "persistent",
        sshHost: "vm-77@ssh.smithers-cloud.test"
      })
    )
  })

  test("a DTO that answers none of them carries none of them: empty strings and an empty head are absence", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, {
        ...WS_LIVE,
        kind: "",
        environment: { source: "", revision: "", closure_hash: "" },
        head: { change_id: "", commit_id: "" },
        ahead: null,
        behind: null,
        persistence: "",
        ssh_host: ""
      }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)
    await seam.viewWorkspace("ws-1")
    expect(payloadOf(store)).toEqual(
      expect.objectContaining({
        workspaceKind: null,
        head: null,
        ahead: null,
        behind: null,
        environment: null,
        persistence: null,
        sshHost: null
      })
    )
  })

  /* Lane L6 (plue#505): the DTO's `lsp.languages`, and a session's `kind` and `language`. */
  test("the DTO's lsp.languages and a session's kind and language read onto the row and the card", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, { ...WS_LIVE, lsp: { languages: ["typescript"] } }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [
        { id: "sess-1", workspace_id: "ws-1", status: "running", kind: "terminal", created_at: "2026-09-03T08:00:00Z" },
        { id: "lsps-1", workspace_id: "ws-1", status: "running", kind: "lsp", language: "typescript", idle_timeout_secs: 600, created_at: "2026-09-03T08:01:00Z" }
      ])
    })
    await seedWorkspace(store)
    await seam.viewWorkspace("ws-1")
    expect(workspacesOf(store)[0]?.lspLanguages).toEqual(["typescript"])
    expect(payloadOf(store)?.lspLanguages).toEqual(["typescript"])
    expect(payloadOf(store)?.sessions).toEqual([
      { id: "sess-1", status: "running", createdAt: "2026-09-03T08:00:00Z", kind: "terminal", language: null },
      { id: "lsps-1", status: "running", createdAt: "2026-09-03T08:01:00Z", kind: "lsp", language: "typescript" }
    ])
  })

  test("a DTO without an lsp object carries null (unknown), one with an lsp object and no languages carries an empty list", async () => {
    const absent = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_LIVE),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(absent.store)
    await absent.seam.viewWorkspace("ws-1")
    expect(workspacesOf(absent.store)[0]?.lspLanguages).toBeNull()
    expect(payloadOf(absent.store)?.lspLanguages).toBeNull()
    const empty = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, { ...WS_LIVE, lsp: {} }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(empty.store)
    await empty.seam.viewWorkspace("ws-1")
    expect(workspacesOf(empty.store)[0]?.lspLanguages).toEqual([])
    /* The per-user row does not carry the list; what the collection knows stands. */
    const merged = await harness({
      "api/repos/will/smithers/workspaces": json(200, [{ ...WS_LIVE, status: "running", lsp: { languages: ["typescript"] } }]),
      "api/user/workspaces": json(200, [{ ...USER_ROW, workspace_title: "smithers landing", state: "running" }])
    })
    await merged.seam.listWorkspaces("will/smithers")
    await merged.seam.listWorkspaces()
    expect(workspacesOf(merged.store)[0]?.lspLanguages).toEqual(["typescript"])
  })

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
  test("the Files facet reads the workspace's own route and keeps the path it listed", async () => {
    const { store, seam, urls } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/files": json(200, [
        { name: "src", path: "src", type: "dir", size: 0 },
        { name: "latest", path: "latest", type: "symlink", size: 8 },
        { name: "README.md", path: "README.md", type: "file", size: 42 },
        { broken: true }
      ])
    })
    await seedWorkspace(store)
    const result = await seam.listFiles("/", "ws-1")
    expect(urls).toEqual(["GET api/repos/will/smithers/workspaces/ws-1/files?path="])
    expect(result).toEqual({ value: "/ in \"review\" (ws-1):\nsrc/\nlatest\nREADME.md" })
    expect(payloadOf(store)?.files).toEqual([
      { name: "src", path: "src", type: "dir", size: 0 },
      { name: "latest", path: "latest", type: "symlink", size: 8 },
      { name: "README.md", path: "README.md", type: "file", size: 42 }
    ])
    expect(payloadOf(store)?.filesPath).toBe("")
    expect(payloadOf(store)?.facet).toBe("files")
  })

  test("a subdirectory listing replaces the previous path's rows, and the facet re-reads the path the card holds", async () => {
    const { store, seam, urls } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/files": (url) =>
        json(200, url.searchParams.get("path") === "src"
          ? [{ name: "main.go", path: "src/main.go", type: "file", size: 12 }]
          : [{ name: "src", path: "src", type: "dir", size: 0 }])
    })
    await seedWorkspace(store)
    await seam.listFiles("src", "ws-1")
    expect(payloadOf(store)?.files).toEqual([{ name: "main.go", path: "src/main.go", type: "file", size: 12 }])
    expect(payloadOf(store)?.filesPath).toBe("src")
    urls.length = 0
    await seam.setFacet("ws-1", "files")
    expect(urls).toEqual(["GET api/repos/will/smithers/workspaces/ws-1/files?path=src"])
  })

  test("a refused listing shows the server's own words and never an empty directory", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/files": json(404, { message: "path not found" })
    })
    await seedWorkspace(store)
    expect(await seam.listFiles("nope", "ws-1")).toBe("path not found")
    expect(payloadOf(store)?.error).toBe("path not found")
    expect(payloadOf(store)?.files).toBeUndefined()
  })

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

  test("the Services facet lists the name, the state, and plue#483's port and url", async () => {
    const { store, seam, urls } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/services": json(200, [
        { name: "postgres", state: "running", port: 5432 },
        { name: "web", state: "failed", port: 3000, url: "https://ws-1.workspaces.smithers-cloud.test" },
        { name: "" }
      ])
    })
    await seedWorkspace(store)
    const result = await seam.listServices("ws-1")
    expect(urls).toEqual(["GET api/repos/will/smithers/workspaces/ws-1/services"])
    expect(result).toEqual({ value: "\"review\" (ws-1) services: postgres (running), web (failed)." })
    expect(payloadOf(store)?.services).toEqual([
      { name: "postgres", state: "running", port: 5432, url: null },
      { name: "web", state: "failed", port: 3000, url: "https://ws-1.workspaces.smithers-cloud.test" }
    ])
  })

  test("a service that publishes neither a port nor a url carries neither — an absent port is never a zero", async () => {
    /* plue#483 writes both `omitempty`, so a service with no published port answers without the key. */
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/services": json(200, [
        { name: "worker", state: "running" },
        { name: "idle", state: "stopped", port: 0, url: "" }
      ])
    })
    await seedWorkspace(store)
    await seam.listServices("ws-1")
    expect(payloadOf(store)?.services).toEqual([
      { name: "worker", state: "running", port: null, url: null },
      { name: "idle", state: "stopped", port: null, url: null }
    ])
  })

  test("a workspace that declares no services says so", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/services": json(200, [])
    })
    await seedWorkspace(store)
    expect(await seam.listServices("ws-1")).toEqual({ value: "\"review\" (ws-1) declares no services." })
    expect(payloadOf(store)?.services).toEqual([])
  })
})

describe("workspace seam egress audit", () => {
  const CALL = {
    occurred_at: "2026-09-02T09:15:00Z",
    host: "api.github.com",
    method: "POST",
    path: "/graphql",
    status: 200,
    allowed: true,
    swapped_secret_names: ["GITHUB_TOKEN"]
  }

  test("the Egress facet reads a page, keeps plue's cursor, and never renders a secret's value", async () => {
    const { store, seam, urls } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/egress": json(200, [CALL], {
        link: "</api/repos/will/smithers/workspaces/ws-1/egress?limit=30>; rel=\"first\", "
          + "</api/repos/will/smithers/workspaces/ws-1/egress?limit=30&cursor=eyJpZCI6MX0>; rel=\"next\""
      })
    })
    await seedWorkspace(store)
    const result = await seam.setFacet("ws-1", "egress")
    expect(result).toBeUndefined()
    expect(urls).toEqual(["GET api/repos/will/smithers/workspaces/ws-1/egress?limit=30"])
    expect(payloadOf(store)?.egress).toEqual([
      {
        occurredAt: "2026-09-02T09:15:00Z",
        host: "api.github.com",
        method: "POST",
        path: "/graphql",
        status: 200,
        allowed: true,
        swappedSecretNames: ["GITHUB_TOKEN"]
      }
    ])
    expect(payloadOf(store)?.egressCursor).toBe("eyJpZCI6MX0")
    expect(payloadOf(store)?.facet).toBe("egress")
  })

  test("a cursor loads the older page and appends it; a page with no next link exhausts the cursor", async () => {
    const older = { ...CALL, occurred_at: "2026-09-02T08:00:00Z", host: "registry.npmjs.org", method: "GET", allowed: false, status: 403, swapped_secret_names: [] }
    const { store, seam, urls } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/egress": (url) =>
        url.searchParams.get("cursor") === "eyJpZCI6MX0"
          ? json(200, [older])
          : json(200, [CALL], {
            link: "</api/repos/will/smithers/workspaces/ws-1/egress?limit=30&cursor=eyJpZCI6MX0>; rel=\"next\""
          })
    })
    await seedWorkspace(store)
    await seam.listEgress("ws-1")
    urls.length = 0
    const result = await seam.listEgress("ws-1", "eyJpZCI6MX0")
    expect(urls).toEqual(["GET api/repos/will/smithers/workspaces/ws-1/egress?limit=30&cursor=eyJpZCI6MX0"])
    expect(result).toEqual({ value: "2 recorded calls from \"review\" (ws-1) — the card lists them." })
    expect(payloadOf(store)?.egress?.map((row) => row.host)).toEqual(["api.github.com", "registry.npmjs.org"])
    expect(payloadOf(store)?.egress?.[1]?.allowed).toBe(false)
    expect(payloadOf(store)?.egressCursor).toBeNull()
  })

  test("an audit page Smithers cannot read is an error, never an empty audit", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/egress": json(200, [{ host: 12 }, { nope: true }])
    })
    await seedWorkspace(store)
    expect(await seam.listEgress("ws-1")).toBe("Smithers Cloud answered 2 egress rows in a shape Smithers can't read.")
    expect(payloadOf(store)?.egress).toBeUndefined()
    expect(payloadOf(store)?.error).toBe("Smithers Cloud answered 2 egress rows in a shape Smithers can't read.")
  })

  test("a computer that called nothing says so", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1/egress": json(200, [])
    })
    await seedWorkspace(store)
    expect(await seam.listEgress("ws-1")).toEqual({ value: "\"review\" (ws-1) made no recorded calls." })
    expect(payloadOf(store)?.egress).toEqual([])
  })
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

  test("the same refusal on an act with a card puts the code on the card, never the server's 5xx words", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": json(503, {
        code: "egress_proxy_unavailable",
        message: "service unavailable"
      })
    })
    await seedWorkspace(store, { ...wsRow, status: "suspended" })
    const refusal = await seam.resumeWorkspace("ws-1")
    expect(refusal).toContain("egress_proxy_unavailable — The request to Smithers Cloud failed (503).")
    expect(refusal).not.toContain("service unavailable")
    expect(refusal).toContain("no outbound network")
    expect(refusal).not.toContain("@fucory")
    expect(payloadOf(store)?.egressProxyUnavailable).toBe(true)
    expect(payloadOf(store)?.error).toBe("The request to Smithers Cloud failed (503). Your box would have had no outbound network, so Smithers stopped instead of running it half-connected. Not your fault; worth trying again.")
  })

  test("a refusal with any other code carries no egress facet and says whose fault it is", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/resume": json(409, { code: "operation_in_progress", message: "already resuming" })
    })
    await seedWorkspace(store, { ...wsRow, status: "suspended" })
    const refusal = await seam.resumeWorkspace("ws-1")
    expect(refusal).toBe("operation_in_progress — The request to Smithers Cloud failed (409). Not ready yet — nothing is wrong.")
    /* A `wait` refusal is not one the person acts on, so plue's words stay hidden. */
    expect(refusal).not.toContain("already resuming")
    expect(payloadOf(store)?.egressProxyUnavailable).toBeUndefined()
  })
})

/*
 * Lane L3b — the NixOS compute path. `kind` on create, the environment's
 * registry `image`, the DTO's `desktop` object, and the session mint whose
 * answer is a live VM's password: the whole point of the block below is that
 * the credential reaches the iframe and nothing else.
 */
describe("workspace seam desktop kinds and provenance", () => {
  test("the create carries the kind the caller chose", async () => {
    const { seam, bodies } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, WS_DESKTOP),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seam.openWorkspace("main", "will/smithers", "desktop")
    expect(bodies[0]).toEqual({
      key: "POST api/repos/will/smithers/workspaces",
      body: { source_bookmark: "main", kind: "desktop" }
    })
  })

  test("a create that named no kind names none on the wire — plue's own default stands", async () => {
    const { seam, bodies } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, WS_RUNNING),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seam.openWorkspace("main", "will/smithers")
    expect(bodies[0]?.body).toEqual({ source_bookmark: "main" })
  })

  test("the DTO's desktop kind, its environment image and its relative stream path read onto the row and the card", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)
    await seam.viewWorkspace("ws-1")
    expect(workspacesOf(store)[0]).toEqual(
      expect.objectContaining({
        kind: "desktop",
        environment: {
          source: ".smithers/environment.nix",
          revision: "b3f21c9d4e5a6b7c",
          closureHash: "9f2b1c0d4e5a6b7c8d9e0f1a",
          image: "registry.smithers-cloud.test/environments/smithersai/smithers:nixos-2405-9f2b1c0d"
        },
        desktop: { ready: true, streamUrl: "/api/workspaces/ws-1/desktop/stream", session: null }
      })
    )
    expect(payloadOf(store)?.workspaceKind).toBe("desktop")
    expect(payloadOf(store)?.desktop?.streamUrl).toBe("/api/workspaces/ws-1/desktop/stream")
    expect(payloadOf(store)?.desktop?.ready).toBe(true)
  })

  test("a container workspace carries no image and no desktop object — absence, never an empty one", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_RUNNING),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)
    await seam.viewWorkspace("ws-1")
    expect(workspacesOf(store)[0]?.desktop ?? null).toBeNull()
    expect(workspacesOf(store)[0]?.environment ?? null).toBeNull()
    expect(payloadOf(store)?.desktop ?? null).toBeNull()
  })

  test("a desktop object plue answered with a session names the session it minted, and no credential", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, {
        ...WS_DESKTOP,
        desktop: {
          stream_url: "/api/workspaces/ws-1/desktop/stream",
          session: { id: "dsess-9", expires_at: "2026-09-03T09:12:00Z" }
        }
      }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)
    await seam.viewWorkspace("ws-1")
    expect(payloadOf(store)?.desktop?.session).toEqual({ id: "dsess-9", expiresAt: "2026-09-03T09:12:00Z" })
  })
})

describe("workspace seam desktop session", () => {
  test("the mint holds the credentialed stream for the facet and opens the facet on the card", async () => {
    dropDesktopStream()
    const { store, seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(201, DESKTOP_MINT),
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP)
    })
    await seedWorkspace(store, { ...wsRow, kind: "desktop" })
    const answer = await seam.openDesktop("ws-1")
    expect(requests).toContain("POST api/repos/will/smithers/workspaces/ws-1/desktop/session")
    expect(readDesktopStream("ws-1")).toEqual({
      workspaceId: "ws-1",
      url: DESKTOP_STREAM_URL,
      sessionId: "dsess-1",
      expiresAt: "2026-09-03T09:12:00Z"
    })
    expect(payloadOf(store)?.facet).toBe("desktop")
    // The transcript line names the workspace and when the session lapses — never the URL that carries the password.
    expect(JSON.stringify(answer)).not.toContain(DESKTOP_TOKEN)
    expect(JSON.stringify(answer)).not.toContain(DESKTOP_VNC_PASSWORD)
    dropDesktopStream()
  })

  test("the session answer never reaches a collection, a transcript row, or the persisted bytes", async () => {
    dropDesktopStream()
    const { store, seam, storage } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(201, DESKTOP_MINT),
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP)
    })
    await seedWorkspace(store, { ...wsRow, kind: "desktop" })
    await seam.openDesktop("ws-1")
    /*
     * The whole store — every collection, the cards, the transcript — and the
     * bytes the persistence backend actually wrote. A desktop session is a
     * live machine's password; a single one of these containing it is the
     * defect this test exists to catch.
     */
    const inMemory = JSON.stringify(
      Object.fromEntries(
        Object.entries(store.collections).map(([name, collection]) => [name, [...collection.values()]])
      )
    )
    for (const secret of [DESKTOP_TOKEN, DESKTOP_VNC_PASSWORD, DESKTOP_STREAM_URL, "vnc.html"]) {
      expect(inMemory).not.toContain(secret)
      expect(storage.written()).not.toContain(secret)
      expect(messagesOf(store).join("\n")).not.toContain(secret)
    }
    // …and it really was minted: the holder has it, so the assertions above are not vacuous.
    expect(readDesktopStream("ws-1")?.url).toBe(DESKTOP_STREAM_URL)
    dropDesktopStream()
  })

  test("a 409 reads the server's own words and marks the workspace as not running", async () => {
    dropDesktopStream()
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(409, {
        message: "workspace is suspended; resume it before opening the desktop"
      }),
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP)
    })
    await seedWorkspace(store, { ...wsRow, kind: "desktop", status: "suspended" })
    const refusal = await seam.openDesktop("ws-1")
    expect(refusal).toBe("workspace is suspended; resume it before opening the desktop. Smithers can't do that as asked.")
    expect(payloadOf(store)?.desktopRefusal).toEqual({
      status: 409,
      message: "workspace is suspended; resume it before opening the desktop",
      code: null,
      retryAfterSeconds: null,
      fault: "user",
      origin: "worker"
    })
    expect(readDesktopStream("ws-1")).toBeNull()
  })

  test("a 400 reads the server's own words and offers no resume", async () => {
    dropDesktopStream()
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(400, {
        message: "workspace kind container has no desktop"
      }),
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_RUNNING)
    })
    await seedWorkspace(store)
    const refusal = await seam.openDesktop("ws-1")
    expect(refusal).toBe("workspace kind container has no desktop. Smithers can't do that as asked.")
    expect(payloadOf(store)?.desktopRefusal).toEqual({
      status: 400,
      message: "workspace kind container has no desktop",
      code: null,
      retryAfterSeconds: null,
      fault: "user",
      origin: "worker"
    })
  })

  test("a 503 desktop_not_ready reads plue's own body and code, and retries on the Retry-After it named (plue#496)", async () => {
    dropDesktopStream()
    const previous = { ...desktopSessionRetry }
    /* plue asks for 2s; the test shortens the wait rather than sleeping through it. */
    desktopSessionRetry.defaultDelayMs = 1
    try {
      let mints = 0
      const { store, seam, requests } = await harness({
        "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": () => {
          mints += 1
          /*
           * plue's own 503, verbatim (routes/workspace_desktop_test.go):
           * writeRouteError sanitizes a 5xx MESSAGE to the status text but
           * keeps `code`, and #496 sets Retry-After on any retryable error.
           */
          return mints < 3
            ? json(503, { code: "desktop_not_ready", message: "service unavailable" }, { "retry-after": "0" })
            : json(201, DESKTOP_MINT)
        },
        "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP)
      })
      await seedWorkspace(store, { ...wsRow, kind: "desktop" })

      const result = await seam.openDesktop("ws-1")

      /* The server asked to be retried, so it was — and the third answer minted. */
      expect(mints).toBe(3)
      expect((result as { value: string }).value).toContain("is streaming on the card")
      expect(requests.filter((request) => request.endsWith("/desktop/session"))).toHaveLength(3)
      expect(readDesktopStream("ws-1")?.url).toBe(DESKTOP_STREAM_URL)
      /* A mint that finally succeeded leaves no refusal behind. */
      expect(payloadOf(store)?.desktopRefusal).toBeUndefined()
    } finally {
      Object.assign(desktopSessionRetry, previous)
    }
  })

  test("a desktop_not_ready that never clears gives up at the bound, with plue's code and whose fault it is on the card", async () => {
    dropDesktopStream()
    const previous = { ...desktopSessionRetry }
    /* The default is deliberately NOT used here: the wait must come from the header. */
    desktopSessionRetry.defaultDelayMs = 0
    desktopSessionRetry.maxAttempts = 2
    try {
      let mints = 0
      const { store, seam } = await harness({
        "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": () => {
          mints += 1
          return json(503, { code: "desktop_not_ready", message: "service unavailable" }, { "retry-after": "1" })
        },
        "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP)
      })
      await seedWorkspace(store, { ...wsRow, kind: "desktop" })

      const startedAt = Date.now()
      const refusal = await seam.openDesktop("ws-1")

      expect(mints).toBe(2)
      /* One retry, and it waited the second the header asked for — not the app's own default. */
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900)
      expect(refusal).toBe("desktop_not_ready — The desktop session on ws-1 was refused (503). Not ready yet — nothing is wrong.")
      expect(refusal).not.toContain("service unavailable")
      expect(payloadOf(store)?.desktopRefusal).toEqual({
        status: 503,
        message: "The desktop session on ws-1 was refused (503).",
        code: "desktop_not_ready",
        retryAfterSeconds: 1,
        fault: "wait",
        origin: "plue"
      })
      expect(payloadOf(store)?.facet).toBe("desktop")
      expect(readDesktopStream("ws-1")).toBeNull()
    } finally {
      Object.assign(desktopSessionRetry, previous)
    }
  })

  /*
   * The auto-retry gate is the FAULT, not the presence of a number. no_capacity
   * states `retry_after: 30` in plue's own registry and sends it on the wire,
   * so a rule keyed on "did the server state a pacing" would loop on a full
   * fleet — thirty times, for two and a half minutes, hiding the one fact the
   * user needs, which is that somebody has to buy more infra.
   */
  test("a full fleet is answered ONCE, even though it states a retry_after, and says whose fault it is", async () => {
    dropDesktopStream()
    let mints = 0
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": () => {
        mints += 1
        return json(503, { code: "no_capacity", fault: "infra", message: "no sandbox slots are free", retry_after: 30 }, {
          "retry-after": "30"
        })
      },
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP)
    })
    await seedWorkspace(store, { ...wsRow, kind: "desktop" })

    const refusal = await seam.openDesktop("ws-1")

    expect(mints).toBe(1)
    expect(refusal).toBe(`no_capacity — The desktop session on ws-1 was refused (503). ${INFRA_NOT_YOUR_FAULT}`)
    expect(refusal).not.toContain("no sandbox slots are free")
    expect(payloadOf(store)?.desktopRefusal).toEqual({
      status: 503,
      message: "The desktop session on ws-1 was refused (503).",
      code: "no_capacity",
      retryAfterSeconds: 30,
      fault: "infra",
      origin: "plue"
    })
    expect(readDesktopStream("ws-1")).toBeNull()
  })

  test("an account at its own cap is answered once and never gets the infra line", async () => {
    dropDesktopStream()
    let mints = 0
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": () => {
        mints += 1
        return json(429, { code: "quota_exceeded", fault: "user", message: "you already have 5 boxes running" })
      },
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP)
    })
    await seedWorkspace(store, { ...wsRow, kind: "desktop" })

    const refusal = await seam.openDesktop("ws-1")

    expect(mints).toBe(1)
    expect(refusal).not.toContain("@fucory")
    expect(refusal).toContain("Your account is at its cap")
    expect(payloadOf(store)?.desktopRefusal).toMatchObject({ code: "quota_exceeded", fault: "user" })
  })

  test("any other 5xx is answered once — a code the server did not ask to be retried is not retried", async () => {
    dropDesktopStream()
    let mints = 0
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": () => {
        mints += 1
        return json(500, { message: "internal server error" })
      },
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP)
    })
    await seedWorkspace(store, { ...wsRow, kind: "desktop" })

    const refusal = await seam.openDesktop("ws-1")

    expect(mints).toBe(1)
    expect(refusal).toBe("The desktop session on ws-1 was refused (500). That's a bug in Smithers, not something you did.")
    expect(refusal).not.toContain("internal server error")
    expect(payloadOf(store)?.desktopRefusal).toEqual({
      status: 500,
      message: "The desktop session on ws-1 was refused (500).",
      code: null,
      retryAfterSeconds: null,
      fault: "bug",
      origin: "worker"
    })
  })

  test("leaving the Desktop facet supersedes a pending desktop_not_ready retry", async () => {
    dropDesktopStream()
    const previous = { ...desktopSessionRetry }
    /* No Retry-After on the wire, so the loop parks for this long — long enough to leave the facet mid-wait. */
    desktopSessionRetry.defaultDelayMs = 50
    try {
      let mints = 0
      const { store, seam } = await harness({
        "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": () => {
          mints += 1
          return json(503, { code: "desktop_not_ready", message: "service unavailable" })
        },
        "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP),
        "api/repos/will/smithers/workspaces/ws-1/services": json(200, [])
      })
      await seedWorkspace(store, { ...wsRow, kind: "desktop" })

      const pending = seam.openDesktop("ws-1")
      await seam.setFacet("ws-1", "services")
      await pending

      /* The loop stopped at the facet change instead of running to its bound. */
      expect(mints).toBe(1)
      expect(payloadOf(store)?.facet).toBe("services")
    } finally {
      Object.assign(desktopSessionRetry, previous)
    }
  })

  test("a human facet change cancels a desktop mint started by the agent", async () => {
    dropDesktopStream()
    let release!: () => void
    const pendingMint = new Promise<void>((resolve) => { release = resolve; heldReleases.add(() => resolve()) })
    let started!: () => void
    const mintStarted = new Promise<void>((resolve) => { started = resolve })
    const { ctx, store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": async () => {
        started(); await pendingMint; return json(201, DESKTOP_MINT)
      },
      "api/repos/will/smithers/workspaces/ws-1/services": json(200, [])
    })
    const disposers: Array<() => void> = []
    const actors = createActorBindings((dispose) => disposers.push(dispose))
    const user = actors.pair(ctx, (context) => createWorkspaceSeam(context))
    const agent = actors.select(user)
    try {
      await seedWorkspace(store, { ...wsRow, kind: "desktop" })
      const mint = agent.openDesktop("ws-1")
      await mintStarted
      await user.setFacet("ws-1", "services")
      release(); await mint
      expect(payloadOf(store)?.facet).toBe("services")
      expect(readDesktopStream("ws-1")).toBeNull()
    } finally {
      release()
      for (const dispose of disposers) dispose()
      user.dispose(); seam.dispose()
    }
  })

  test("human and agent views share one settling workspace poll", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve; heldReleases.add(() => resolve()) })
    let reads = 0
    const { ctx, store, seam } = await harness({
      // This scenario deliberately has no readable auxiliary metadata.
      "GET api/repos/will/smithers/bookmarks": json(404, { message: "bookmarks unavailable" }),
      "GET api/repos/will/smithers/workspace/sessions": json(404, { message: "sessions unavailable" }),
      "api/repos/will/smithers/workspaces/ws-1": async () => {
        reads += 1
        // The first view starts a held poll; the second view only rereads its DTO.
        if (reads === 2 || reads >= 4) await gate
        return json(200, { ...WS_RUNNING, status: reads === 2 ? "running" : "starting" })
      }
    })
    const disposers: Array<() => void> = []
    const actors = createActorBindings((dispose) => disposers.push(dispose))
    const user = actors.pair(ctx, (context) => createWorkspaceSeam(context, { pollMs: 60_000 }))
    try {
      await seedWorkspace(store)
      await user.viewWorkspace("ws-1")
      await actors.select(user).viewWorkspace("ws-1")
      expect(reads).toBe(3)
      release()
      await checkpoint()
    } finally {
      release()
      for (const dispose of disposers) dispose()
      user.dispose(); seam.dispose()
    }
  })

  test("rotating mints again and swaps the held stream; the old one is gone", async () => {
    dropDesktopStream()
    let mints = 0
    const rotated = DESKTOP_STREAM_URL.replace(DESKTOP_TOKEN, "dtok-rotated")
    const { store, seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": () => {
        mints += 1
        return mints === 1 ? json(201, DESKTOP_MINT) : json(201, {
          ...DESKTOP_MINT,
          stream_url: rotated,
          session: { id: "dsess-2", expires_at: "2026-09-03T21:12:00Z" },
          token: "dtok-rotated"
        })
      },
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP)
    })
    await seedWorkspace(store, { ...wsRow, kind: "desktop" })
    await seam.openDesktop("ws-1")
    await seam.rotateDesktop("ws-1")
    expect(requests.filter((key) => key.endsWith("/desktop/session")).length).toBe(2)
    expect(readDesktopStream("ws-1")?.url).toBe(rotated)
    expect(readDesktopStream("ws-1")?.sessionId).toBe("dsess-2")
    dropDesktopStream()
  })

  test("leaving the Desktop facet drops the credential — nothing survives the unmounted facet", async () => {
    dropDesktopStream()
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(201, DESKTOP_MINT),
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store, { ...wsRow, kind: "desktop" })
    await seam.openDesktop("ws-1")
    expect(readDesktopStream("ws-1")).not.toBeNull()
    await seam.setFacet("ws-1", "terminal")
    expect(readDesktopStream("ws-1")).toBeNull()
  })

  test("deleting the workspace drops the credential too", async () => {
    dropDesktopStream()
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(201, DESKTOP_MINT),
      "DELETE api/repos/will/smithers/workspaces/ws-1": json(200, {}),
      "api/repos/will/smithers/workspaces": json(200, [])
    })
    await seedWorkspace(store, { ...wsRow, kind: "desktop" })
    await seam.openDesktop("ws-1")
    await seam.deleteWorkspace("ws-1", "review")
    expect(readDesktopStream("ws-1")).toBeNull()
  })

  test("a signed-out session mints nothing, and a degraded one refuses with the enable wording", async () => {
    dropDesktopStream()
    const signedOut = await harness({}, { signedIn: false })
    expect(await signedOut.seam.openDesktop("ws-1")).toBe("Sign in to Smithers Cloud to continue.")
    expect(await signedOut.seam.rotateDesktop("ws-1")).toBe("Sign in to Smithers Cloud to continue.")
    const degraded = await harness({}, { degraded: true })
    await seedWorkspace(degraded.store, { ...wsRow, kind: "desktop" })
    expect(await degraded.seam.openDesktop("ws-1")).toBe(DEGRADED_WORKSPACE_REFUSAL)
    expect(await degraded.seam.rotateDesktop("ws-1")).toBe(DEGRADED_WORKSPACE_REFUSAL)
    expect(readDesktopStream("ws-1")).toBeNull()
  })

  test("a mint whose answer names no stream is malformed, not an empty desktop", async () => {
    dropDesktopStream()
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(201, { workspace_id: "ws-1", token: "t" })
    })
    await seedWorkspace(store, { ...wsRow, kind: "desktop" })
    const refusal = await seam.openDesktop("ws-1")
    expect(refusal).toContain("malformed")
    expect(readDesktopStream("ws-1")).toBeNull()
  })

  /*
   * The minted `stream_url` becomes an iframe `src` verbatim, and the facet's
   * sandbox carries allow-scripts + allow-same-origin: a `javascript:` URL
   * inherits this origin and runs with the app's credentials. A mint whose
   * stream is not an absolute http(s) URL is malformed, never a stream.
   */
  test("a mint whose stream is not an absolute http(s) URL is refused, never held", async () => {
    for (const stream_url of [
      "javascript:alert(document.domain)",
      "data:text/html,<script>alert(document.domain)</script>",
      "//evil.example/vnc.html",
      "/api/workspaces/ws-1/desktop/stream",
      "file:///etc/passwd"
    ]) {
      dropDesktopStream()
      const { store, seam } = await harness({
        "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(201, { ...DESKTOP_MINT, stream_url })
      })
      await seedWorkspace(store, { ...wsRow, kind: "desktop" })
      const refusal = await seam.openDesktop("ws-1")
      expect(typeof refusal).toBe("string")
      expect(String(refusal)).toContain("malformed")
      expect(readDesktopStream("ws-1")).toBeNull()
    }
    dropDesktopStream()
  })
})

describe("workspace seam environment images", () => {
  test("the listing names each image's kind, closure and status, and the cold-pull note when nothing is baked", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/environment-images": json(200, [
        {
          id: 4,
          repository_id: 7,
          kind: "desktop",
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
        kind: "desktop",
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
 * and the status stream now carries the workspace's head as the guest reports
 * it.
 */
describe("workspace seam agent workspaces", () => {
  const WS_AGENT = {
    ...WS_RUNNING,
    kind: "agent",
    agent_session_id: "asess-7f3c",
    head: { change_id: "qupxosqwmnrt", commit_id: "c0ffee1234567890" },
    ahead: 3,
    behind: 0
  }

  test("an agent workspace reads its kind and the session that drove it", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_AGENT),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)
    await seam.viewWorkspace("ws-1")
    expect(workspacesOf(store)[0]).toEqual(
      expect.objectContaining({ kind: "agent", agentSessionId: "asess-7f3c" })
    )
    expect(payloadOf(store)?.workspaceKind).toBe("agent")
    expect(payloadOf(store)?.agentSessionId).toBe("asess-7f3c")
  })

  test("a workspace no agent drove names no session", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_RUNNING),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)
    await seam.viewWorkspace("ws-1")
    expect(workspacesOf(store)[0]?.agentSessionId ?? null).toBeNull()
    expect(payloadOf(store)?.agentSessionId ?? null).toBeNull()
  })

  test("a stream event carrying a new head applies it to the row and the card", async () => {
    const { store, seam } = await harness({})
    await seedWorkspace(store, { ...wsRow, head: { changeId: "old", commitId: "old" }, ahead: 0, behind: 5 })
    await seedCard(store)
    seam.applyStatusEvent("ws-1", {
      status: "running",
      head: { change_id: "qupxosqwmnrt", commit_id: "c0ffee1234567890" },
      ahead: 3,
      behind: 0
    })
    expect(workspacesOf(store)[0]).toEqual(
      expect.objectContaining({
        status: "running",
        head: { changeId: "qupxosqwmnrt", commitId: "c0ffee1234567890" },
        ahead: 3,
        behind: 0
      })
    )
    expect(payloadOf(store)?.head).toEqual({ changeId: "qupxosqwmnrt", commitId: "c0ffee1234567890" })
    expect(payloadOf(store)?.ahead).toBe(3)
  })

  test("a status-only event moves the status and leaves the head exactly as it was", async () => {
    const { store, seam } = await harness({})
    await seedWorkspace(store, { ...wsRow, head: { changeId: "keepme", commitId: "keepme2" }, ahead: 4, behind: 1 })
    seam.applyStatusEvent("ws-1", { status: "suspended" })
    expect(workspacesOf(store)[0]).toEqual(
      expect.objectContaining({
        status: "suspended",
        head: { changeId: "keepme", commitId: "keepme2" },
        ahead: 4,
        behind: 1
      })
    )
  })

  test("a failed DTO carries plue's failure code and message onto the row and the card (plue#482)", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, {
        ...WS_RUNNING,
        status: "failed",
        failure_code: "image_pull_failed",
        failure_message: "pulling nixos-2405-9f2b1c0d timed out after 300s"
      }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)

    await seam.viewWorkspace("ws-1")

    expect(workspacesOf(store)[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        failureCode: "image_pull_failed",
        failureMessage: "pulling nixos-2405-9f2b1c0d timed out after 300s"
      })
    )
    expect(payloadOf(store)?.failureCode).toBe("image_pull_failed")
    expect(payloadOf(store)?.failureMessage).toBe("pulling nixos-2405-9f2b1c0d timed out after 300s")
  })

  test("a workspace that failed with no recorded reason states none — a blank is never filled in", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": json(200, { ...WS_RUNNING, status: "failed" }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)

    await seam.viewWorkspace("ws-1")

    expect(payloadOf(store)?.status).toBe("failed")
    expect(payloadOf(store)?.failureCode).toBeNull()
    expect(payloadOf(store)?.failureMessage).toBeNull()
  })

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

  test("a failed status EVENT carries its reason; a later event that names none leaves the reason standing (plue#482)", async () => {
    const { store, seam } = await harness({})
    await seedWorkspace(store)
    await seedCard(store)

    seam.applyStatusEvent("ws-1", {
      status: "failed",
      failure_code: "image_pull_failed",
      failure_message: "pulling nixos-2405 timed out"
    })
    expect(workspacesOf(store)[0]).toEqual(
      expect.objectContaining({ status: "failed", failureCode: "image_pull_failed" })
    )
    expect(payloadOf(store)?.failureMessage).toBe("pulling nixos-2405 timed out")

    /* A status-only event has said nothing about the reason, so it does not erase it. */
    seam.applyStatusEvent("ws-1", { status: "failed" })
    expect(workspacesOf(store)[0]?.failureCode).toBe("image_pull_failed")
  })

  test("an event for a workspace nobody loaded, or one that names no status Smithers knows, changes nothing", async () => {
    const { store, seam } = await harness({})
    await seedWorkspace(store, { ...wsRow, ahead: 4 })
    seam.applyStatusEvent("ws-missing", { status: "running" })
    seam.applyStatusEvent("ws-1", { status: "teleporting" })
    seam.applyStatusEvent("ws-1", "not an event")
    expect(workspacesOf(store)).toHaveLength(1)
    expect(workspacesOf(store)[0]).toEqual(expect.objectContaining({ status: "running", ahead: 4 }))
  })
})

describe("workspace seam create refusals", () => {
  /*
   * The desktop base image was still registering when this landed, so plue
   * answers a kind=desktop create with a 409 naming exactly that. It is the
   * honest state of the system, so it reads verbatim — on the card whose
   * create affordance was pressed, not only in the answer.
   */
  test("a refused create reads the server's own words, verbatim, on the card that offered the kinds", async () => {
    const message = "no NixOS environment image is registered for kind desktop"
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces": json(409, { message })
    })
    await seedWorkspace(store, { ...wsRow, status: "failed" })
    await seedCard(store)
    /* The card keeps plue's words verbatim; the answer adds the one line that says whose fault it was. */
    expect(await seam.openWorkspace("main", "will/smithers", "desktop")).toBe(`${message}. Smithers can't do that as asked.`)
    expect(payloadOf(store)?.error).toBe(message)
  })

  test("a refused create touches no card of a workspace that did not offer one", async () => {
    const message = "no NixOS environment image is registered for kind desktop"
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces": json(409, { message })
    })
    await seedWorkspace(store)
    await seedCard(store)
    /* The card keeps plue's words verbatim; the answer adds the one line that says whose fault it was. */
    expect(await seam.openWorkspace("main", "will/smithers", "desktop")).toBe(`${message}. Smithers can't do that as asked.`)
    expect(payloadOf(store)?.error).toBeUndefined()
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

  for (const operation of ["terminal retry", "desktop retry", "terminal settle", "both retries"] as const) {
    for (const cancellation of ["dispose", "delete"] as const) {
      test(`${cancellation} settles a pending ${operation} sleep`, async () => {
        const entered = deferred<void>(undefined)
        const { ctx, store, seam: unused, dispatched } = await harness({
          "POST api/repos/will/smithers/workspace/sessions": () => {
            entered.resolve()
            return operation === "terminal settle"
              ? json(201, { id: "sess-old", status: "pending", workspace_id: "ws-1" })
              : json(503, { code: "guest_not_ready" }, { "retry-after": "60" })
          },
          "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": () => {
            entered.resolve()
            return json(503, { code: "desktop_not_ready" }, { "retry-after": "60" })
          },
          "DELETE api/repos/will/smithers/workspaces/ws-1": json(204, null),
          "api/repos/will/smithers/workspaces": json(200, [])
        })
        const seam = createWorkspaceSeam(ctx, { pollMs: 60_000 })
        await seedWorkspace(store)
        const pending = operation === "both retries"
          ? Promise.all([seam.openDesktop("ws-1"), seam.openTerminal("ws-1")])
          : operation === "desktop retry" ? seam.openDesktop("ws-1") : seam.openTerminal("ws-1")
        try {
          await entered.promise
          await checkpoint()
          if (cancellation === "dispose") seam.dispose()
          else await seam.deleteWorkspace("ws-1", "review")
          const count = dispatched.length
          await bounded<unknown>(pending)
          expect(dispatched.length).toBe(count)
        } finally {
          seam.dispose()
          unused.dispose()
        }
      })
    }
  }

  for (const boundary of ["settling GET", "attached GET", "session list"] as const) {
    for (const cancellation of ["delete", "second open", "sign-out", "sign-in again", "dispose"] as const) {
      test(`${cancellation} fences a terminal awaiting its ${boundary}`, async () => {
        const entered = deferred<void>(undefined)
        const release = deferred<Response>(json(503, { message: "fixture retired" }))
        let posts = boundary === "attached GET" ? 1 : 0
        let gets = 0
        let lists = 0
        const { store, seam, dispatched } = await harness({
          "POST api/repos/will/smithers/workspace/sessions": () => json(201, {
            id: ++posts === 1 ? "sess-old" : "sess-new", status: posts === 1 && boundary === "settling GET" ? "pending" : "running", workspace_id: "ws-1"
          }),
          "api/repos/will/smithers/workspace/sessions/sess-old": () => {
            if (++gets > 1) return json(200, { id: "sess-old", status: "stopped", workspace_id: "ws-1" })
            entered.resolve()
            return release.promise
          },
          "api/repos/will/smithers/workspace/sessions": () => {
            if (++lists > 1 || boundary !== "session list") return json(200, [])
            entered.resolve()
            return release.promise
          },
          "DELETE api/repos/will/smithers/workspaces/ws-1": json(204, null),
          "api/repos/will/smithers/workspaces": json(200, [])
        })
        await seedWorkspace(store)
        if (boundary === "attached GET") await seedCard(store, "sess-old")
        const pending = seam.openTerminal("ws-1")
        try {
          await entered.promise
          if (cancellation === "delete") await seam.deleteWorkspace("ws-1", "review")
          if (cancellation === "second open") await seam.openTerminal("ws-1")
          if (cancellation === "sign-out" || cancellation === "sign-in again") await store.dispatch({
            type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null
          }).isPersisted.promise
          if (cancellation === "sign-in again") await store.dispatch({
            type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null
          }).isPersisted.promise
          if (cancellation === "dispose") seam.dispose()
          const count = dispatched.length
          release.resolve(json(200, { id: "sess-old", status: "running", workspace_id: "ws-1" }))
          await pending
          expect(dispatched.length).toBe(count)
          expect(store.collections.tabs.get("sess-old")).toBeUndefined()
          if (cancellation === "second open") {
            expect(store.collections.tabs.get("sess-new")).toBeUndefined()
            expect(store.session().activeTabId).toBe("main")
            expect(payloadOf(store)?.terminalSessionId).toBe("sess-new")
          } else if (cancellation === "delete" || boundary !== "attached GET") {
            expect(cardOf(store)).toBeUndefined()
          }
          if (cancellation === "delete") expect(workspacesOf(store)).toEqual([])
        } finally {
          release.resolve(json(200, { id: "sess-old", status: "running", workspace_id: "ws-1" }))
          seam.dispose()
        }
      })
    }
  }
})

/*
 * `/desktop` — the one-command open (create-or-reuse, wait, mint) under the
 * ONE confirmation the flow asked for.
 *
 * Every route double below is plue as it answered prod on 2026-09-13: the
 * create is find-or-create per (repository, user, kind) — the uniqueness
 * `uq_workspaces_active` enforces — so REUSE is asserted as "plue answered
 * the existing box and the app did not create a second one", not as a local
 * scan of the collection. The wait ends on the DTO's own `desktop.ready`,
 * the refusals read in plue's words, and the mint's credential is asserted
 * against the BYTES the persistence backend wrote.
 */
describe("the one-command desktop open", () => {
  /** A desktop box in one status, with `desktop.ready` as the DTO states it. */
  const desktopBox = (
    status: string,
    ready: boolean | null = null,
    extra: Record<string, unknown> = {}
  ) => ({
    ...WS_DESKTOP,
    status,
    desktop: { ready, stream_url: "/api/workspaces/ws-1/desktop/stream", session: null },
    ...extra
  })

  test("a RUNNING desktop box is reused: plue's create answers it, the app creates no second box, and the stream is minted", async () => {
    const { seam, store, requests, bodies, storage } = await harness({
      "POST api/repos/will/smithers/workspaces": json(200, desktopBox("running", true)),
      "GET api/repos/will/smithers/bookmarks": json(200, { bookmarks: [{ name: "main", change_id: "qupxosqw", commit_id: "c0ffee1" }] }),
      "GET api/repos/will/smithers/workspace/sessions": json(200, { sessions: [] }),
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(201, DESKTOP_MINT)
    })
    try {
      const result = await seam.openDesktopBox()
      expect(result).toEqual({ value: `The desktop of "review" (ws-1) is streaming on the card until 2026-09-03T09:12:00Z.` })
      /* The create asked for the kind and the repository's head bookmark, and ran exactly once. */
      expect(bodies.filter((row) => row.key === "POST api/repos/will/smithers/workspaces").map((row) => row.body))
        .toEqual([{ source_bookmark: "main", kind: "desktop" }])
      expect(requests.filter((key) => key === "POST api/repos/will/smithers/workspaces")).toHaveLength(1)
      /* A box already running needs no readiness poll: the DTO said ready. */
      expect(requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1")).toEqual([])
      expect(requests.filter((key) => key === "POST api/repos/will/smithers/workspaces/ws-1/resume")).toEqual([])
      /* The stream is held in module memory, and the facet is the desktop. */
      expect(readDesktopStream("ws-1")?.url).toBe(DESKTOP_STREAM_URL)
      expect(payloadOf(store)?.facet).toBe("desktop")
      /* THE CREDENTIAL RULE: nothing the mint answered reached the card, or the disk behind it. */
      const payload = JSON.stringify(payloadOf(store))
      const written = storage.written()
      for (const secret of [DESKTOP_TOKEN, DESKTOP_VNC_PASSWORD, DESKTOP_STREAM_URL, "dsess-1"]) {
        expect(payload).not.toContain(secret)
        expect(written).not.toContain(secret)
        expect(JSON.stringify([...store.collections.toasts.values()])).not.toContain(secret)
      }
    } finally {
      dropDesktopStream()
      seam.dispose()
    }
  })

  test("a SUSPENDED desktop box is resumed, then waited for, then streamed", async () => {
    let reads = 0
    const { seam, store, requests, dispatched } = await harness({
      "POST api/repos/will/smithers/workspaces": json(200, desktopBox("suspended")),
      "POST api/repos/will/smithers/workspaces/ws-1/resume": json(200, desktopBox("starting")),
      "GET api/repos/will/smithers/workspaces/ws-1": () => {
        reads += 1
        return json(200, reads < 2 ? desktopBox("running", false) : desktopBox("running", true))
      },
      "GET api/repos/will/smithers/bookmarks": json(200, { bookmarks: [] }),
      "GET api/repos/will/smithers/workspace/sessions": json(200, { sessions: [] }),
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(201, DESKTOP_MINT)
    })
    try {
      const result = await seam.openDesktopBox("main")
      expect(result).toEqual({ value: `The desktop of "review" (ws-1) is streaming on the card until 2026-09-03T09:12:00Z.` })
      expect(requests.filter((key) => key === "POST api/repos/will/smithers/workspaces/ws-1/resume")).toHaveLength(1)
      /* `running` alone did not end the wait: the DTO's `ready: false` did the honest thing. */
      expect(requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1")).toHaveLength(2)
      expect(readDesktopStream("ws-1")?.url).toBe(DESKTOP_STREAM_URL)
      expect(store.collections.cloudWorkspaces.get("ws-1")?.status).toBe("running")
      const shown = dispatched.filter(row => row.type === "toast.shown")
      expect(shown).toHaveLength(1)
      expect(shown[0]!.toast).toMatchObject({ status: "running", action: { flow: "box.view", args: "ws-1", label: "Open details" } })
      const progress = dispatched.filter(row => row.type === "toast.progressed").map(row => row.toast as { detail: string })
      for (const stage of ["Creating the box", "Resuming the box", "Booting the box", "desktop is still activating", "Starting the stream"]) {
        expect(progress.some(row => row.detail.includes(stage))).toBe(true)
      }
      for (const row of progress) expect(row.detail).toMatch(/\d+s elapsed · usually (about 20s|under 60s)/)
      expect(store.collections.toasts.get("toast-box.desktop.open:ws-1")).toMatchObject({ status: "ok", detail: "Desktop ready" })
    } finally {
      dropDesktopStream()
      seam.dispose()
    }
  })

  test("a FAILED box is replaced by plue's create, and the replacement is the one waited for", async () => {
    /* The failed box is loaded locally; `uq_workspaces_active` excludes it, so plue builds a new one. */
    const { seam, store, requests, bodies } = await harness({
      "POST api/repos/will/smithers/workspaces": json(202, { ...desktopBox("starting"), id: "ws-2" }),
      "GET api/repos/will/smithers/workspaces/ws-2": json(200, { ...desktopBox("running", true), id: "ws-2" }),
      "GET api/repos/will/smithers/bookmarks": json(200, { bookmarks: [] }),
      "GET api/repos/will/smithers/workspace/sessions": json(200, { sessions: [] }),
      "POST api/repos/will/smithers/workspaces/ws-2/desktop/session": json(201, { ...DESKTOP_MINT, workspace_id: "ws-2" })
    })
    try {
      await seedWorkspace(store, { ...wsRow, status: "failed", kind: "desktop", failureCode: "provisioning_failed", failureMessage: "old one died" })
      const result = await seam.openDesktopBox()
      expect(result).toEqual({ value: `The desktop of "review" (ws-2) is streaming on the card until 2026-09-03T09:12:00Z.` })
      /* One create, and the wait followed the id plue answered — never the failed row still in the collection. */
      expect(bodies.filter((row) => row.key === "POST api/repos/will/smithers/workspaces")).toHaveLength(1)
      expect(requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1")).toEqual([])
      expect(readDesktopStream("ws-2")?.url).toBe(DESKTOP_STREAM_URL)
    } finally {
      dropDesktopStream()
      seam.dispose()
    }
  })

  test("a box that FAILS mid-wait ends it with plue's own failure_message and code, and nothing is minted", async () => {
    const { seam, store, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(202, desktopBox("starting")),
      "GET api/repos/will/smithers/workspaces/ws-1": json(200, desktopBox("failed", null, {
        failure_code: "provisioning_failed",
        failure_message: "bookmark \"main\" not found on will/smithers"
      })),
      "GET api/repos/will/smithers/bookmarks": json(200, { bookmarks: [] }),
      "GET api/repos/will/smithers/workspace/sessions": json(200, { sessions: [] })
    })
    try {
      /* plue's words, verbatim, code first — a repository whose head is `master`, not `main`, reads exactly this. */
      expect(await seam.openDesktopBox("main")).toBe(`provisioning_failed — bookmark "main" not found on will/smithers`)
      expect(requests.filter((key) => key.endsWith("/desktop/session"))).toEqual([])
      /* The card carries plue's reason, and the wait's stage line is gone. */
      expect(payloadOf(store)?.failureMessage).toBe(`bookmark "main" not found on will/smithers`)
      expect(store.collections.toasts.get("toast-box.desktop.open:ws-1")).toMatchObject({ status: "failed", detail: `provisioning_failed — bookmark "main" not found on will/smithers`, action: { flow: "box.desktop.open", args: JSON.stringify({ bookmark: "main", repo: "will/smithers" }) } })
      expect(payloadOf(store)?.desktopStage).toBeUndefined()
      expect(readDesktopStream("ws-1")).toBeNull()
    } finally {
      seam.dispose()
    }
  })

  test("the wait is BOUNDED: a box that never leaves starting gives up at desktopBoxWait.maxAttempts and says so", async () => {
    const { seam, store, requests, dispatched } = await harness({
      "POST api/repos/will/smithers/workspaces": json(202, desktopBox("starting")),
      "GET api/repos/will/smithers/workspaces/ws-1": json(200, desktopBox("starting")),
      "GET api/repos/will/smithers/bookmarks": json(200, { bookmarks: [] }),
      "GET api/repos/will/smithers/workspace/sessions": json(200, { sessions: [] })
    })
    try {
      const result = await seam.openDesktopBox()
      expect(result).toBe(
        "The desktop box ws-1 on will/smithers is still starting after 120s — /box.view ws-1 reads its state, /desktop tries again."
      )
      expect(store.collections.toasts.get("toast-box.desktop.open:ws-1")).toMatchObject({ status: "failed", detail: result })
      /* One read per attempt, and not one more: the loop stops, it does not slow down. */
      expect(requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1")).toHaveLength(desktopBoxWait.maxAttempts)
      expect(requests.filter((key) => key.endsWith("/desktop/session"))).toEqual([])
      /* Progress records actual elapsed changes, not one identical line per read. */
      const booting = dispatched.filter(row => row.type === "toast.progressed" && (row.toast as { detail: string }).detail.startsWith("Booting the box"))
        .map(row => (row.toast as { detail: string }).detail)
      expect(booting.length).toBeGreaterThan(0)
      expect(new Set(booting).size).toBe(booting.length)
      expect(payloadOf(store)?.desktopStage).toBeUndefined()
    } finally {
      seam.dispose()
    }
  // All 60 reads must finish before checking the attempt bound.
  // This runner budget does not change the production wait or its assertions.
  }, 30_000)

  test("the card names the stage while it waits, and Stop ends the wait without touching the box", async () => {
    const { seam, store, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(202, desktopBox("starting")),
      "GET api/repos/will/smithers/workspaces/ws-1": async () => {
        /* The card said where it had got to before this read was answered. */
        expect(payloadOf(store)?.desktopStage).toBe("starting")
        await seam.stopDesktopWait("ws-1")
        return json(200, desktopBox("starting"))
      },
      "GET api/repos/will/smithers/bookmarks": json(200, { bookmarks: [] }),
      "GET api/repos/will/smithers/workspace/sessions": json(200, { sessions: [] })
    }, { desktopWaitMs: 50 })
    try {
      /* A superseded wait answers nothing: the human stopped it, so there is no line to read. */
      expect(await seam.openDesktopBox()).toBeUndefined()
      expect(store.collections.toasts.get("toast-box.desktop.open:ws-1")).toMatchObject({ status: "ok", detail: "Stopped waiting" })
      expect(payloadOf(store)?.desktopStage).toBeUndefined()
      expect(requests.filter((key) => key.endsWith("/desktop/session"))).toEqual([])
      /* Stop touched the box not at all — no suspend, no delete, no second create. */
      expect(requests.filter((key) => key.startsWith("POST"))).toEqual(["POST api/repos/will/smithers/workspaces"])
    } finally {
      seam.dispose()
    }
  })

  test("a 503 desktop_not_ready at the end of the wait reads plue's code and Retry-After on the card", async () => {
    let mints = 0
    const { seam, store } = await harness({
      "POST api/repos/will/smithers/workspaces": json(200, desktopBox("running", true)),
      "GET api/repos/will/smithers/bookmarks": json(200, { bookmarks: [] }),
      "GET api/repos/will/smithers/workspace/sessions": json(200, { sessions: [] }),
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": () => {
        mints += 1
        if (mints === 2) {
          expect(payloadOf(store)?.desktopStage).toBe("activating")
          expect(payloadOf(store)?.desktopRefusal?.code).toBe("desktop_not_ready")
          expect(store.collections.toasts.get("toast-box.desktop.open:ws-1")).toMatchObject({ status: "running" })
        }
        return mints === 1
          ? json(503, { code: "desktop_not_ready", message: "service unavailable" }, { "retry-after": "0" })
          : json(201, DESKTOP_MINT)
      }
    })
    try {
      const result = await seam.openDesktopBox()
      expect(result).toEqual({ value: `The desktop of "review" (ws-1) is streaming on the card until 2026-09-03T09:12:00Z.` })
      /* plue asked to be retried, so it was — on its own clock, and the refusal read in its own words while it waited. */
      expect(mints).toBe(2)
      expect(payloadOf(store)?.desktopRefusal).toBeUndefined()
    } finally {
      dropDesktopStream()
      seam.dispose()
    }
  })

  test("a pending mint keeps the toast running; Stop prevents its late answer from settling it", async () => {
    let release!: (response: Response) => void
    let entered!: () => void
    const pending = new Promise<Response>(resolve => { release = resolve; heldReleases.add(() => resolve(json(503, { message: "fixture retired" }))) })
    const mintEntered = new Promise<void>(resolve => { entered = resolve })
    const { seam, store, dispatched } = await harness({
      // This scenario deliberately has no readable auxiliary metadata.
      "GET api/repos/will/smithers/bookmarks": json(404, { message: "bookmarks unavailable" }),
      "GET api/repos/will/smithers/workspace/sessions": json(404, { message: "sessions unavailable" }),
      "POST api/repos/will/smithers/workspaces": json(200, desktopBox("running", true)),
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": () => { entered(); return pending }
    })
    try {
      const opening = seam.openDesktopBox()
      await mintEntered
      const before = dispatched.filter(row => row.type === "toast.progressed").length
      await new Promise(resolve => setTimeout(resolve, 2_100))
      expect(dispatched.filter(row => row.type === "toast.progressed").length).toBeGreaterThan(before)
      expect(payloadOf(store)?.desktopProgress).toMatch(/[2-9]s elapsed/)
      expect(store.collections.toasts.get("toast-box.desktop.open:ws-1")).toMatchObject({ status: "running" })
      expect(payloadOf(store)?.desktopProgress).toMatch(/Starting the stream · \d+s elapsed/)
      await seam.stopDesktopWait("ws-1")
      const count = dispatched.filter(row => row.type.startsWith("toast.")).length
      release(json(201, DESKTOP_MINT))
      expect(await opening).toBeUndefined()
      expect(dispatched.filter(row => row.type.startsWith("toast."))).toHaveLength(count)
      expect(store.collections.toasts.get("toast-box.desktop.open:ws-1")).toMatchObject({ status: "ok", detail: "Stopped waiting" })
      expect(readDesktopStream("ws-1")).toBeNull()
    } finally { dropDesktopStream(); seam.dispose() }
  })

  test("a later open owns the one toast and a superseded poll cannot change it", async () => {
    let release!: (response: Response) => void
    let entered!: () => void
    const pending = new Promise<Response>(resolve => { release = resolve; heldReleases.add(() => resolve(json(503, { message: "fixture retired" }))) })
    const pollEntered = new Promise<void>(resolve => { entered = resolve })
    let creates = 0
    const { seam, store, dispatched } = await harness({
      // This scenario deliberately has no readable auxiliary metadata.
      "GET api/repos/will/smithers/bookmarks": json(404, { message: "bookmarks unavailable" }),
      "GET api/repos/will/smithers/workspace/sessions": json(404, { message: "sessions unavailable" }),
      "POST api/repos/will/smithers/workspaces": () => json(200, desktopBox(++creates === 1 ? "starting" : "running", true)),
      "GET api/repos/will/smithers/workspaces/ws-1": () => { entered(); return pending },
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(201, DESKTOP_MINT)
    })
    try {
      const first = seam.openDesktopBox()
      await pollEntered
      await seam.openDesktopBox()
      expect([...store.collections.toasts.values()]).toHaveLength(1)
      const count = dispatched.filter(row => row.type.startsWith("toast.")).length
      release(json(200, desktopBox("failed", null, { failure_message: "old refusal" })))
      expect(await first).toBeUndefined()
      expect(dispatched.filter(row => row.type.startsWith("toast."))).toHaveLength(count)
      expect(store.collections.toasts.get("toast-box.desktop.open:ws-1")).toMatchObject({ status: "ok", detail: "Desktop ready" })
    } finally { dropDesktopStream(); seam.dispose() }
  })

  test("a terminal mint refusal fails the toast with a retry door and clears progress", async () => {
    const { seam, store } = await harness({
      // This scenario deliberately has no readable auxiliary metadata.
      "GET api/repos/will/smithers/bookmarks": json(404, { message: "bookmarks unavailable" }),
      "GET api/repos/will/smithers/workspace/sessions": json(404, { message: "sessions unavailable" }),
      "POST api/repos/will/smithers/workspaces": json(200, desktopBox("running", true)),
      "POST api/repos/will/smithers/workspaces/ws-1/desktop/session": json(409, { message: "The box has stopped." })
    })
    try {
      const result = await seam.openDesktopBox("main", "will/smithers")
      expect(store.collections.toasts.get("toast-box.desktop.open:ws-1")).toMatchObject({ status: "failed", detail: result,
        action: { flow: "box.desktop.open", args: JSON.stringify({ bookmark: "main", repo: "will/smithers" }), label: "Try again" } })
      expect(payloadOf(store)?.desktopStage).toBeUndefined()
    } finally { seam.dispose() }
  })

  test("a create plue refuses returns its own words, and nothing is waited for", async () => {
    const { seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(409, { message: "no NixOS environment image is registered for kind desktop" })
    })
    try {
      expect(await seam.openDesktopBox()).toBe("no NixOS environment image is registered for kind desktop. Smithers can't do that as asked.")
      expect(requests).toEqual(["POST api/repos/will/smithers/workspaces"])
    } finally {
      seam.dispose()
    }
  })

  test("signed out, the one-command open refuses before it reaches plue", async () => {
    const { seam, requests } = await harness({}, { signedIn: false })
    try {
      expect(await seam.openDesktopBox()).toBe("Sign in to Smithers Cloud to continue.")
      expect(requests).toEqual([])
    } finally {
      seam.dispose()
    }
  })
})

describe("plan sandbox limits embed an upgrade refusal", () => {
  const limit = () => json(402, { code: "plan_limit_exceeded", fault: "user", message: "Suspend one sandbox or upgrade.", plan_key: "free", limit_kind: "concurrent_sandboxes", upgrade_plan_key: "pro" })
  const paths = [
    ["open", "POST api/repos/will/smithers/workspaces"],
    ["resume", "POST api/repos/will/smithers/workspaces/ws-1/resume"],
    ["desktop-box", "POST api/repos/will/smithers/workspaces"],
    ["desktop", "POST api/repos/will/smithers/workspaces/ws-1/desktop/session"]
  ] as const
  for (const [act, path] of paths) test(`${act} preserves the refusal and upgrade target in the transcript card`, async () => {
    dropDesktopStream()
    const { store, seam, requests } = await harness({ [path]: limit, "api/repos/will/smithers/workspaces/ws-1": json(200, WS_DESKTOP) })
    await seedWorkspace(store, { ...wsRow, kind: "desktop" })
    const answer = act === "open" ? await seam.openWorkspace(undefined, "will/smithers")
      : act === "resume" ? await seam.resumeWorkspace("ws-1")
      : act === "desktop-box" ? await seam.openDesktopBox(undefined, "will/smithers")
      : await seam.openDesktop("ws-1")
    expect(answer).toContain("Your plan is at its sandbox limit.")
    const card = store.collections.cards.get("billing-plan-limit")
    expect(card?.kind).toBe("billing-plans")
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
    const identity = { type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null } as const
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
        seam.resumeWorkspace("ws-1"), seam.listSessions("ws-1"), seam.destroySession("session-1", "ws-1"),
        seam.deleteWorkspace("ws-1", "review"), seam.listFiles("src", "ws-1"), seam.readFile("README.md", "ws-1"),
        seam.listServices("ws-1"), seam.listEgress("ws-1"), seam.listEnvironmentImages("will/smithers"),
        seam.openDesktopBox(), seam.stopDesktopWait("ws-1")
      ])
      expect([...outcomes]).toEqual(Array.from({ length: 13 }, () => refusal))
      expect(requests).toEqual([])
      expect({
        workspaces: [...store.collections.cloudWorkspaces.values()],
        cards: [...store.collections.cards.values()],
        messages: [...store.collections.messages.values()]
      }).toEqual(before)
    })
  }

  for (const verb of ["suspend", "resume"] as const) {
    for (const receipt of ["readable", "refused", "malformed"] as const) {
      test(`${verb} without an updated DTO uses the real ${receipt} reread receipt`, async () => {
        const { seam, store, requests } = await harness({
          [`POST api/repos/will/smithers/workspaces/ws-1/${verb}`]: json(200, {}),
          "GET api/repos/will/smithers/workspaces/ws-1": receipt === "readable"
            ? json(200, { ...WS_RUNNING, status: "suspended", name: "observed state" })
            : receipt === "refused" ? json(503, { message: "temporarily unavailable" }) : json(200, { status: "suspended" }),
          "GET api/repos/will/smithers/workspaces": json(200, [WS_RUNNING])
        })
        await seedWorkspace(store)
        await seedCard(store)
        const result = verb === "suspend" ? await seam.suspendWorkspace("ws-1") : await seam.resumeWorkspace("ws-1")
        if (receipt === "readable") {
          // A resume acknowledgment does not invent 'running': the reread says suspended.
          expect(result).toEqual({ value: 'Box "observed state" (ws-1) is suspended.' })
          expect(requests).toEqual([
            `POST api/repos/will/smithers/workspaces/ws-1/${verb}`, "GET api/repos/will/smithers/workspaces/ws-1"
          ])
          expect(workspacesOf(store)[0]?.status).toBe("suspended")
          expect(payloadOf(store)?.status).toBe("suspended")
          expect(payloadOf(store)?.name).toBe("observed state")
        } else {
          expect(result).toBe(receipt === "refused"
            ? `Box "review" (ws-1) ${verb}ed, but its new state could not be read — the list was refreshed.`
            : `Box "review" (ws-1) ${verb}ed, but its answer was malformed — the list was refreshed.`)
          expect(requests).toEqual([
            `POST api/repos/will/smithers/workspaces/ws-1/${verb}`, "GET api/repos/will/smithers/workspaces/ws-1",
            "GET api/repos/will/smithers/workspaces"
          ])
          expect(workspacesOf(store)[0]?.status).toBe("running")
          expect(payloadOf(store)?.status).toBe("running")
          expect(payloadOf(store)?.name).toBe("review")
        }
      })
    }
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

  test("workspace and directory names remain separate encoded route parameters", async () => {
    const { seam, store, urls } = await harness({
      "GET api/repos/team%20name/repo%23x/workspaces/box%2F%CE%B1/files": json(200, [{ name: "hi.txt", path: "src & notes/hi.txt", type: "file", size: 2 }])
    })
    await seedWorkspace(store, { ...wsRow, id: "box/α", repoId: "team name/repo#x", name: "encoded box" })
    expect(await seam.listFiles("src & notes", "box/α")).toEqual({ value: 'src & notes in "encoded box" (box/α):\nhi.txt' })
    expect(urls).toEqual(["GET api/repos/team%20name/repo%23x/workspaces/box%2F%CE%B1/files?path=src%20%26%20notes"])
    expect(payloadOf(store, "box/α")?.filesPath).toBe("src & notes")
    expect(payloadOf(store, "box/α")?.files).toEqual([{ name: "hi.txt", path: "src & notes/hi.txt", type: "file", size: 2 }])
  })
})
