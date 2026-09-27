import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { scopedControllers } from "../ControllerTestScope"
import { trackDispatchCommits } from "../StoreTestScope"
import type { AppServices } from "../AppController"
import { repoTreeRowId } from "../AppState"
import { createAppStore } from "../AppStore"

const createAppController = scopedControllers()

/*
 * The sidebar's file tree seam (RepoTreeSeam.ts) through the real command
 * path: /repo.tree <copyId>[#path] reads the SAME routes the files flows
 * read — a box's `GET .../workspaces/{id}/files?path=`, the shared copy's
 * `GET .../contents[/path]` — and writes the app-repo-tree row for that
 * directory: loaded with exactly the entries the route answered, or failed
 * with the route's error text verbatim. Toggling is collection state, never
 * a second request; the rows never survive a relaunch.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/*
 * The Worker's forward of a box's files route
 * (`GET /api/repos/{o}/{r}/workspaces/{id}/files?path=`, the same route the
 * Files facet reads), keyed by the path plue is asked for. Entries are plue's
 * WorkspaceFileEntry rows (`type` is `dir` or `file`); `ws-refused` is the
 * Worker's own 401 body, `ws-broken` plue's 409 for a box that stopped
 * between the inventory read and the click.
 */
const BOX_FILES = "/api/repos/will/flows/workspaces/ws-1/files"
const boxAnswers: Record<string, () => Response> = {
  "": () =>
    json(200, {
      path: "",
      entries: [
        { name: "apps", path: "apps", type: "dir", size: 0 },
        { name: "README.md", path: "README.md", type: "file", size: 12 },
        { name: "", path: "", type: "file", size: 0 },
        { name: "link", path: "link", type: "symlink", size: 0 }
      ]
    }),
  "apps": () => json(200, { path: "apps", entries: [{ name: "ui", path: "apps/ui", type: "dir", size: 0 }] }),
  "apps/ui": () => json(200, { path: "apps/ui", entries: [] }),
  "locked": () => json(409, { status: "error", message: "workspace ws-1 is not running" })
}

/*
 * The public contents route of the mirror
 * (`GET /api/repos/{o}/{r}/contents[/path]`, the read the files flows make,
 * allowlisted signed out by apps/server publicRepositoryReads.ts): a JSON
 * array of `{ name, path, type }` rows for a directory, a record with
 * `content`/`encoding` for a file, the mirror's message on a refusal.
 */
const SHARED_CONTENTS = "/api/repos/smithersai/smithers/contents"
const PAGE_COMMIT = "a".repeat(40)
const sharedAnswers: Record<string, () => Response> = {
  /*
   * The mirror answers a git tree's own byte order: uppercase before
   * lowercase, so `CHANGELOG.md` precedes `Cargo.lock` and the directories
   * sit wherever their names fall. The row the seam writes is in the
   * sidebar's one order instead.
   */
  "": () =>
    json(200, [
      { name: "CHANGELOG.md", path: "CHANGELOG.md", type: "file", sha: "", size: 0 },
      { name: "Cargo.lock", path: "Cargo.lock", type: "file", sha: "", size: 0 },
      { name: "PACKAGE.ts", path: "PACKAGE.ts", type: "file", sha: "", size: 0 },
      { name: "README.md", path: "README.md", type: "file", sha: "", size: 0 },
      { name: "apps", path: "apps", type: "dir", sha: "", size: 0 },
      { type: "file" }
    ]),
  "apps": () => json(200, [{ name: "ui", path: "apps/ui", type: "dir", sha: "", size: 0 }]),
  "apps/ui": () => json(200, []),
  "README.md": () => json(200, { name: "README.md", path: "README.md", type: "file", encoding: "base64", content: "IyBIaQo=", size: 5 }),
  "boom": () => json(500, { message: "the mirror is resyncing smithersai/smithers" })
}

const treeBackend = () => {
  /** Every request this seam made that is neither of its two routes: the tree must make none. */
  const requests: Array<string> = []
  /** Every box listing asked for, as `<workspaces path>?<query>`. */
  const boxRequests: Array<string> = []
  /** Every mirror contents read asked for, as its path. */
  const sharedRequests: Array<string> = []
  const services: AppServices = {
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const parsed = new URL(url, "http://local.test")
      const path = parsed.pathname
      if (path === SHARED_CONTENTS || path.startsWith(`${SHARED_CONTENTS}/`)) {
        // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes; not this seam's read.
        if (!path.endsWith("/contents/.smithers/factory.json") && !/\/api\/repos\/[^/]+\/[^/]+\/home$/.test(path)) sharedRequests.push(`${path}${parsed.search}`)
        if (path === `${SHARED_CONTENTS}/paged`) {
          return parsed.searchParams.get("after") === "paged/first"
            ? new Response(JSON.stringify([{ name: "second", path: "paged/second", type: "file" }]), { headers: { "X-Contents-Commit": PAGE_COMMIT } })
            : new Response(JSON.stringify([{ name: "first", path: "paged/first", type: "file" }]), { status: 200, headers: { "X-Next-Cursor": "paged/first", "X-Contents-Commit": PAGE_COMMIT, "content-type": "application/json" } })
        }
        if (path === `${SHARED_CONTENTS}/oversized`) {
          return json(200, Array.from({ length: 10_001 }, (_, index) => ({ name: `file-${index}`, type: "file" })))
        }
        const at = decodeURIComponent(path.slice(SHARED_CONTENTS.length).replace(/^\//, ""))
        const answer = sharedAnswers[at]
        return answer === undefined ? json(404, { message: `smithersai/smithers has no ${at}` }) : answer()
      }
      // The repository-flows seam reads the homepage beside the projection; not this seam's read.
      if (/^\/api\/repos\/[^/]+\/[^/]+\/home$/.test(path)) return json(404, { status: "error", message: "no homepage" })
      if (path.startsWith("/api/repos/")) {
        boxRequests.push(`${path.slice("/api".length)}${parsed.search}`)
        if (path !== BOX_FILES) return json(401, { status: "error", message: "Sign in to run a Smithers turn." })
        const answer = boxAnswers[parsed.searchParams.get("path") ?? ""]
        return answer === undefined ? json(404, { status: "error", message: `no such path in ws-1: ${parsed.searchParams.get("path")}` }) : answer()
      }
      requests.push(path)
      return json(404, { status: "error", message: `no stub for ${url}` })
    }
  }
  return { services, requests, boxRequests, sharedRequests }
}

const treeController = async () => {
  const backend = treeBackend()
  const storage = memoryStorage()
  const { store, settle } = trackDispatchCommits(await createAppStore({ kind: "localStorage", storage }))
  const controller = createAppController(store, unavailableAgent, {
    ...backend.services,
    bootstrap: {
      apiVersion: 1,
      host: "local",
      version: "test",
      buildSha: "test",
      capabilities: ["cloud"],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    }
  })
  return { store, controller, storage, requests: backend.requests, boxRequests: backend.boxRequests, sharedRequests: backend.sharedRequests, settle }
}

/** A cloud workspace copy (a box) as the inventory view writes it; `state` is plue's status verbatim. */
const boxCopy = (id: string, state: string, repoId = "will/flows") => ({
  id,
  repoId,
  kind: "workspace" as const,
  label: "fix-landings",
  workspaceId: id,
  state
})

describe("repo tree seam — one directory per request, the route's answer verbatim", () => {
  /* An id no copy holds is a refusal from the controller, before the seam. */
  test("an unknown copy is a refusal, and nothing is asked", async () => {
    const { controller, requests, boxRequests, sharedRequests } = await treeController()
    const unknown = await controller.commands.run("repo.tree", "workspace:nowhere")
    expect(unknown.status).toBe("failed")
    expect(JSON.stringify(unknown)).toContain("There is no working copy with id workspace:nowhere.")
    expect(requests).toEqual([])
    expect(boxRequests).toEqual([])
    expect(sharedRequests).toEqual([])
    // A blank line lacks the copy id: the form asks for it (THE FORM LAW), nothing is refused.
    const blank = await controller.commands.run("repo.tree", "")
    expect(blank).toEqual({ status: "form", flow: "repo.tree", cardId: "form-repo.tree", fields: ["copy"] })
  })

  test("the rows are collection state for this launch only: a store reopened over the same storage starts collapsed", async () => {
    const { store, controller, storage, settle } = await treeController()
    await store.dispatch({ type: "workingcopies.workspaces.loaded", actor: "system", copies: [boxCopy("ws-1", "running")] }).isPersisted.promise
    expect((await controller.commands.run("repo.tree", "ws-1")).status).toBe("executed")
    expect(store.collections.repoTree.size).toBe(1)
    expect([...store.collections.repoTree.values()][0]?.expanded).toBe(true)
    await controller.dispose()
    await settle()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.collections.repoTree.size).toBe(0)
    // Nothing under the tree's id ever reached the shared storage.
    expect(storage.getItem("smithers-mvp.app-repo-tree")).toBeNull()
  })

  test("repo.tree is one flow with three doors: the caret, the slash, and the agent (the three-door law); the agent reads contents with files.list", async () => {
    const { controller } = await treeController()
    const catalog = controller.commands.all().find((command) => command.name === "repo.tree")
    expect(catalog?.hidden).toBeUndefined()
    expect(catalog?.confirm).toBeUndefined()
    expect(controller.commands.find("repo.tree")?.binding.descriptor.modelInvocable).toBe(true)
  })
})

/*
 * A cloud workspace copy (a box, docs/workbench-lanes/sidebar-tree.md) lists
 * through the route its Files facet reads, forwarded by the Worker with the
 * visitor's own session: `GET /api/repos/{o}/{r}/workspaces/{id}/files?path=`.
 * The row holds plue's entries mapped to the tree's `{ name, kind }`, or the
 * refusal verbatim. A box the inventory shows as anything but running is
 * refused in place with its state sentence and no request: nothing invented.
 */
describe("repo tree seam: a cloud workspace copy reads the box's files route", () => {
  const loadBox = async (copies: ReadonlyArray<ReturnType<typeof boxCopy>>) => {
    const scope = await treeController()
    await scope.store.dispatch({ type: "workingcopies.workspaces.loaded", actor: "system", copies: [...copies] }).isPersisted.promise
    return scope
  }

  test("/repo.tree <boxCopy> lists the box's root through GET .../workspaces/{id}/files?path= and maps plue's entries to the tree's rows", async () => {
    const { store, controller, requests, boxRequests } = await loadBox([boxCopy("ws-1", "running")])
    expect((await controller.commands.run("repo.tree", "ws-1")).status).toBe("executed")
    expect(boxRequests).toEqual(["/repos/will/flows/workspaces/ws-1/files?path="])
    // The local route is never asked for a box.
    expect(requests).toEqual([])
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", ""))).toMatchObject({
      copyId: "ws-1",
      path: "",
      expanded: true,
      state: "loaded",
      // `dir` is a directory, anything else plue names is a file; a row without a name drops.
      // The sidebar's order, not the route's: directories first, then by name.
      entries: [{ name: "apps", kind: "dir" }, { name: "link", kind: "file" }, { name: "README.md", kind: "file" }]
    })
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", ""))?.error).toBeUndefined()
    // A nested directory is one more request with its path; an empty one is a loaded row with no entries.
    expect((await controller.commands.run("repo.tree", "ws-1#apps")).status).toBe("executed")
    expect(boxRequests[1]).toBe("/repos/will/flows/workspaces/ws-1/files?path=apps")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", "apps"))?.entries).toEqual([{ name: "ui", kind: "dir" }])
    expect((await controller.commands.run("repo.tree", "ws-1#apps/ui/")).status).toBe("executed")
    expect(boxRequests[2]).toBe("/repos/will/flows/workspaces/ws-1/files?path=apps%2Fui")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", "apps/ui"))).toMatchObject({ state: "loaded", entries: [] })
    // Collapsing is collection state: no request.
    expect((await controller.commands.run("repo.tree", "ws-1#apps")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", "apps"))?.expanded).toBe(false)
    expect(boxRequests).toHaveLength(3)
  })

  test("a box that is not running fails the row with its state sentence and asks the route nothing", async () => {
    const { store, controller, boxRequests } = await loadBox([
      boxCopy("ws-1", "starting"),
      boxCopy("ws-2", "suspended"),
      boxCopy("ws-3", "pending"),
      boxCopy("ws-4", "failed")
    ])
    expect((await controller.commands.run("repo.tree", "ws-1")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", ""))).toMatchObject({
      state: "failed",
      expanded: true,
      entries: [],
      error: "fix-landings (ws-1) is starting, not running; wait for it to settle (the workspace card tracks it)."
    })
    expect((await controller.commands.run("repo.tree", "ws-2#apps")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-2", "apps"))?.error).toBe("fix-landings (ws-2) is suspended, not running; /box.resume it first.")
    expect((await controller.commands.run("repo.tree", "ws-3")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-3", ""))?.error).toBe("fix-landings (ws-3) is pending, not running; wait for it to settle (the workspace card tracks it).")
    // A failed box never settles and cannot be resumed: no invented remedy, the card carries plue's failure_message.
    expect((await controller.commands.run("repo.tree", "ws-4")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-4", ""))).toMatchObject({
      state: "failed",
      expanded: true,
      entries: [],
      error: "fix-landings (ws-4) is failed; the workspace card names why."
    })
    expect(boxRequests).toEqual([])
    // The box settles: the inventory refresh rewrites the copy, and the next toggle is the retry that lists it.
    await store.dispatch({ type: "workingcopies.workspaces.loaded", actor: "system", copies: [boxCopy("ws-1", "running")] }).isPersisted.promise
    expect((await controller.commands.run("repo.tree", "ws-1")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", ""))?.expanded).toBe(false)
    expect((await controller.commands.run("repo.tree", "ws-1")).status).toBe("executed")
    expect(boxRequests).toEqual(["/repos/will/flows/workspaces/ws-1/files?path="])
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", ""))).toMatchObject({ state: "loaded", entries: [{ name: "apps", kind: "dir" }, { name: "link", kind: "file" }, { name: "README.md", kind: "file" }] })
  })

  test("a refusal from the Worker or plue writes the failed row with the message verbatim", async () => {
    const { store, controller } = await loadBox([boxCopy("ws-1", "running"), boxCopy("ws-9", "running")])
    // plue's 409 for a box that stopped between the inventory read and the click.
    expect((await controller.commands.run("repo.tree", "ws-1#locked")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", "locked"))).toMatchObject({ state: "failed", error: "workspace ws-1 is not running" })
    expect((await controller.commands.run("repo.tree", "ws-1#missing")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-1", "missing"))?.error).toBe("no such path in ws-1: missing")
    // The Worker's own refusal (a signed-out page) reaches the row in the Worker's words.
    expect((await controller.commands.run("repo.tree", "ws-9")).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId("ws-9", ""))).toMatchObject({ state: "failed", error: "Sign in to run a Smithers turn." })
  })
})

/*
 * The shared read-only copy of a public repository (WorkspaceViews.ts): the
 * one virtual box every reader shares over the mirror. No VM and no
 * terminal, so its listing is the mirror's contents route, the same public
 * read the files flows make; the local route and the box route are never
 * asked for it.
 */
describe("repo tree seam: the shared read-only copy reads the mirror's contents route", () => {
  const SHARED = "shared:smithersai/smithers"
  const loadShared = async () => {
    const scope = await treeController()
    await scope.store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: { bookmark: "main", changeId: null, commitId: null }, catalog: true }]
    }).isPersisted.promise
    expect(scope.store.collections.workingCopies.get(SHARED)).toMatchObject({ kind: "shared", access: "read" })
    return scope
  }

  test("loads every directory page before publishing the tree row", async () => {
    const { store, controller, sharedRequests } = await loadShared()
    expect((await controller.commands.run("repo.tree", `${SHARED}#paged`)).status).toBe("executed")
    expect(sharedRequests).toEqual([
      `${SHARED_CONTENTS}/paged`,
      `${SHARED_CONTENTS}/paged?ref=${PAGE_COMMIT}&after=paged%2Ffirst`
    ])
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "paged"))?.entries).toEqual([
      { name: "first", kind: "file" },
      { name: "second", kind: "file" }
    ])
  })

  test("fails the tree row rather than presenting a capped directory as complete", async () => {
    const { store, controller } = await loadShared()
    expect((await controller.commands.run("repo.tree", `${SHARED}#oversized`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "oversized"))).toMatchObject({
      state: "failed", entries: [], error: "Directory listing exceeds 10,000 entries."
    })
  })

  test("/repo.tree <sharedCopy> lists the root through GET .../contents and maps the mirror's rows to the tree's rows, nothing filtered", async () => {
    const { store, controller, requests, boxRequests, sharedRequests } = await loadShared()
    expect((await controller.commands.run("repo.tree", SHARED)).status).toBe("executed")
    expect(sharedRequests).toEqual([SHARED_CONTENTS])
    expect(requests).toEqual([])
    expect(boxRequests).toEqual([])
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, ""))).toMatchObject({
      copyId: SHARED,
      path: "",
      expanded: true,
      state: "loaded",
      /*
       * `dir` is a directory, `file` a file; a row without a name drops. The
       * order is the sidebar's, not the mirror's: directories first, then by
       * name, so `Cargo.lock` precedes `CHANGELOG.md` here and the byte order
       * the route answered in does not reach the tree.
       */
      entries: [
        { name: "apps", kind: "dir" },
        { name: "Cargo.lock", kind: "file" },
        { name: "CHANGELOG.md", kind: "file" },
        { name: "PACKAGE.ts", kind: "file" },
        { name: "README.md", kind: "file" }
      ]
    })
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, ""))?.truncated).toBeFalsy()
    // A nested directory is one more read with its path (per-segment encoding); an empty one is a loaded row with no entries.
    expect((await controller.commands.run("repo.tree", `${SHARED}#apps`)).status).toBe("executed")
    expect(sharedRequests[1]).toBe(`${SHARED_CONTENTS}/apps`)
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "apps"))?.entries).toEqual([{ name: "ui", kind: "dir" }])
    expect((await controller.commands.run("repo.tree", `${SHARED}#apps/ui/`)).status).toBe("executed")
    expect(sharedRequests[2]).toBe(`${SHARED_CONTENTS}/apps/ui`)
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "apps/ui"))).toMatchObject({ state: "loaded", entries: [] })
    // Collapsing is collection state: no read.
    expect((await controller.commands.run("repo.tree", `${SHARED}#apps`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "apps"))?.expanded).toBe(false)
    expect(sharedRequests).toHaveLength(3)
  })

  test("a refusal writes the failed row with the mirror's message verbatim; a file path names the read that answers it", async () => {
    const { store, controller, sharedRequests } = await loadShared()
    expect((await controller.commands.run("repo.tree", `${SHARED}#boom`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "boom"))).toMatchObject({ state: "failed", expanded: true, entries: [], error: "the mirror is resyncing smithersai/smithers" })
    expect((await controller.commands.run("repo.tree", `${SHARED}#missing`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "missing"))?.error).toBe("smithersai/smithers has no missing")
    expect((await controller.commands.run("repo.tree", `${SHARED}#README.md`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "README.md"))?.error).toBe("README.md in smithersai/smithers is a file; run /files.read README.md instead")
    // A failed row collapses like any other; expanding it again is the retry, and it reads once more.
    const before = sharedRequests.length
    expect((await controller.commands.run("repo.tree", `${SHARED}#boom`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "boom"))?.expanded).toBe(false)
    expect(sharedRequests).toHaveLength(before)
    expect((await controller.commands.run("repo.tree", `${SHARED}#boom`)).status).toBe("executed")
    expect(sharedRequests).toHaveLength(before + 1)
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "boom"))).toMatchObject({ expanded: true, state: "failed", error: "the mirror is resyncing smithersai/smithers" })
  })

  /*
   * `..` never leaves the repository's namespace. `encodeRepoPath` does not
   * escape a dot and a URL parser collapses the segments before the request
   * leaves the page, so `.../contents/../../../../user/secrets` resolves to
   * `/api/user/secrets` and would be sent same-origin with the visitor's own
   * cookies, then painted as this copy's file rows. `repo.tree` is not
   * userOnly, so the agent can name that path: the seam refuses it in place,
   * before any request, and the mirror is never asked.
   */
  test("a path that leaves the repository is refused in place, and the mirror is never asked", async () => {
    const { store, controller, requests, boxRequests, sharedRequests } = await loadShared()
    expect((await controller.commands.run("repo.tree", `${SHARED}#../../../../user/secrets`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "../../../../user/secrets"))).toMatchObject({
      copyId: SHARED,
      state: "failed",
      expanded: true,
      entries: [],
      error: "File paths must stay inside the repository."
    })
    expect(sharedRequests).toEqual([])
    expect(requests).toEqual([])
    expect(boxRequests).toEqual([])
    // A percent-encoded escape is the same path, so it is the same refusal.
    expect((await controller.commands.run("repo.tree", `${SHARED}#apps/%2e%2e/%2e%2e/user/secrets`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(SHARED, "apps/%2e%2e/%2e%2e/user/secrets"))?.error).toBe("File paths must stay inside the repository.")
    expect(sharedRequests).toEqual([])
    // A path that stays inside still lists, so the guard costs the tree nothing.
    expect((await controller.commands.run("repo.tree", `${SHARED}#apps`)).status).toBe("executed")
    expect(sharedRequests).toEqual([`${SHARED_CONTENTS}/apps`])
  })

})

describe("the workspace name", () => {
  test("/workspace.rename writes the heading's name; a blank name renders the form; the pencil toggles the inline editor", async () => {
    const { store, controller } = await treeController()
    expect(store.session().workspaceName).toBeUndefined()
    expect((await controller.commands.run("workspace.rename", "  Force  ")).status).toBe("executed")
    expect(store.session().workspaceName).toBe("Force")
    expect(store.session().workspaceRenameOpen).toBe(false)
    const blank = await controller.commands.run("workspace.rename", "   ")
    expect(blank).toEqual({ status: "form", flow: "workspace.rename", cardId: "form-workspace.rename", fields: ["name"] })
    expect(store.session().workspaceName).toBe("Force")
    expect((await controller.commands.run("workspace.rename.edit")).status).toBe("executed")
    expect(store.session().workspaceRenameOpen).toBe(true)
    expect((await controller.commands.run("workspace.rename.edit")).status).toBe("executed")
    expect(store.session().workspaceRenameOpen).toBe(false)
    // A rename while the editor is open closes it.
    await controller.commands.run("workspace.rename.edit")
    expect((await controller.commands.run("workspace.rename", "Plue")).status).toBe("executed")
    expect(store.session()).toMatchObject({ workspaceName: "Plue", workspaceRenameOpen: false })
  })
})
