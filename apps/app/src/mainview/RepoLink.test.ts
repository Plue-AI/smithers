import { describe,expect,test } from "bun:test"
import {
beginRepositoryEntry,
catalogRepositories,
catalogRepository,
openRequestedRepo,
paramRepo,
pathRepo,
requestedRepo,
signInReturnTo,
withoutRepoParam
} from "./RepoLink"
import { createAppStore } from "./state/AppStore"
import { resolveTargetRepo } from "./state/RepoContext"
import type { ControllerContext } from "./state/controller/context"
import { createTabsController } from "./state/controller/tabs"

/*
 * A repository's app lives at `/owner/name`; the landing page's older "Open in
 * Smithers" link lands on `/?repo=owner/name`. The visitor should arrive with
 * that repository already selected, and only when the public catalog carries
 * it: the URL is anyone's to type.
 */

const SUMMARY = "Smithers is a durable framework that lets agents plan, run, and review changes to a code repository through flows."

const catalog = {
  repos: [
    { name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers", summary: SUMMARY, stats: null }
  ]
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const fixture = async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({
    kind: "localStorage",
    storage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key)
    }
  })
  const tabs = createTabsController({
    store,
    services: {},
    commandActor: "user",
    repositories: { available: false }
  } as unknown as ControllerContext)
  const ran: Array<string> = []
  return {
    store,
    ran,
    controller: {
      store,
      selectRepo: tabs.selectRepo,
      loadRepositories: async (): Promise<string | void> => {},
      runCommand: (name: string, args?: string) => {
        ran.push(args === undefined ? name : `${name} ${args}`)
        return true
      }
    }
  }
}

describe("public catalog suggestions", () => {
  test("publishes valid identities in catalog order, preserving spelling and deduplicating case", () => {
    expect(catalogRepositories({ repos: [
      null, { name: 123 }, { name: "../secret" }, { name: "owner/." },
      { name: "owner/repo/extra" }, { name: "owner/<script>" },
      { name: "Live/Mirror", summary: "  A public mirror.  " },
      { name: "live/mirror", summary: "duplicate" },
      { name: "other/repo", summary: " " }
    ] })).toEqual([
      { id: "Live/Mirror", org: "Live", name: "Mirror", summary: "A public mirror." },
      { id: "other/repo", org: "other", name: "repo" }
    ])
    for (const value of [undefined, null, [], {}, { repos: null }, { repos: "unavailable" }]) {
      expect(catalogRepositories(value)).toEqual([])
    }
  })

  test("a missing route retains only the current catalog's valid alternatives without selecting one", async () => {
    const { store, controller } = await fixture()
    try {
      expect(await openRequestedRepo(controller, async () => jsonResponse({ repos: [
        { name: "Live/Mirror" }, { name: "live/mirror" }, { name: "../secret" }
      ] }), "smithersai/smithers")).toBe("smithersai/smithers is not in the public repository catalog.")
      expect(store.session().repositoryEntry).toMatchObject({
        repo: "smithersai/smithers", phase: "failed", failureKind: "not-public", publicRepositories: ["Live/Mirror"]
      })
      expect(store.session().activeRepoKey ?? null).toBeNull()
      expect(store.collections.repositories.size).toBe(0)

      await openRequestedRepo(controller, async () => jsonResponse({ repos: [] }), "smithersai/smithers")
      expect(store.session().repositoryEntry?.publicRepositories).toEqual([])
      await openRequestedRepo(controller, async () => jsonResponse({}, 503), "smithersai/smithers")
      expect(store.session().repositoryEntry?.publicRepositories).toBeUndefined()
    } finally { await store.dispose?.() }
  })

  test("an older catalog cannot replace the suggestions of a newer repository entry", async () => {
    const { store, controller } = await fixture()
    const oldCatalog = Promise.withResolvers<Response>()
    const earlier = openRequestedRepo(controller, async () => oldCatalog.promise, "missing/old")
    try {
      await openRequestedRepo(controller, async () => jsonResponse({ repos: [{ name: "current/mirror" }] }), "missing/current")
      const current = structuredClone(store.session().repositoryEntry)
      oldCatalog.resolve(jsonResponse({ repos: [{ name: "retired/mirror" }] }))
      await earlier
      expect(store.session().repositoryEntry).toEqual(current)
      expect(store.session().repositoryEntry?.publicRepositories).toEqual(["current/mirror"])
    } finally {
      oldCatalog.resolve(jsonResponse({ repos: [] }))
      await earlier
      await store.dispose?.()
    }
  })
})

describe("paramRepo", () => {
  test("reads an owner/name from the repo parameter", () => {
    expect(paramRepo("?repo=smithersai/smithers")).toBe("smithersai/smithers")
    expect(paramRepo("?auth=failed&repo=smithersai/smithers")).toBe("smithersai/smithers")
  })

  test("ignores an absent, empty, or malformed value", () => {
    expect(paramRepo("")).toBeNull()
    expect(paramRepo("?repo=")).toBeNull()
    expect(paramRepo("?repo=smithers")).toBeNull()
    expect(paramRepo("?repo=../../etc")).toBeNull()
    expect(paramRepo("?repo=https://github.com/smithersai/smithers")).toBeNull()
  })
})

describe("pathRepo", () => {
  test("reads an owner/name from a two-segment path", () => {
    expect(pathRepo("/smithersai/smithers")).toBe("smithersai/smithers")
    expect(pathRepo("/SmithersAI/smithers.js")).toBe("SmithersAI/smithers.js")
  })

  test("a trailing slash names the same repository", () => {
    // A prerendered /owner/name/index.html is served at /owner/name/ too.
    expect(pathRepo("/smithersai/smithers/")).toBe("smithersai/smithers")
    expect(requestedRepo({ pathname: "/smithersai/smithers/", search: "" })).toBe("smithersai/smithers")
  })

  test("answers null for the root, one segment, an empty segment, or deeper paths", () => {
    expect(pathRepo("/")).toBeNull()
    expect(pathRepo("")).toBeNull()
    expect(pathRepo("/smithersai")).toBeNull()
    expect(pathRepo("/smithersai/")).toBeNull()
    expect(pathRepo("/smithersai//")).toBeNull()
    expect(pathRepo("/smithersai/smithers//")).toBeNull()
    expect(pathRepo("/smithersai/smithers/issues")).toBeNull()
    expect(pathRepo("/w/ws-1/b/main/f/frame-1")).toBeNull()
    expect(pathRepo("/a%20b/c")).toBeNull()
  })
})

describe("requestedRepo", () => {
  test("the path names the repository", () => {
    expect(requestedRepo({ pathname: "/smithersai/smithers", search: "" })).toBe("smithersai/smithers")
  })

  test("the path wins over the repo parameter", () => {
    expect(requestedRepo({ pathname: "/smithersai/smithers", search: "?repo=someone/else" })).toBe("smithersai/smithers")
  })

  test("the repo parameter is read at the root only", () => {
    expect(requestedRepo({ pathname: "/", search: "?repo=smithersai/smithers" })).toBe("smithersai/smithers")
    expect(requestedRepo({ pathname: "/w/ws-1/b/main/f/frame-1", search: "?repo=smithersai/smithers" })).toBeNull()
    expect(requestedRepo({ pathname: "/smithersai", search: "?repo=smithersai/smithers" })).toBeNull()
  })

  test("nothing is requested at the root without the parameter", () => {
    expect(requestedRepo({ pathname: "/", search: "" })).toBeNull()
    expect(requestedRepo({ pathname: "/", search: "?auth=failed" })).toBeNull()
  })
})

describe("catalogRepository", () => {
  test("matches the catalog spelling case-insensitively", () => {
    expect(catalogRepository(catalog, "SmithersAI/Smithers")).toEqual({
      id: "smithersai/smithers",
      org: "smithersai",
      name: "smithers",
      summary: SUMMARY
    })
  })

  test("a catalog without the curated sentence yields a row without one, never a made-up sentence", () => {
    const bare = { repos: [{ name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers", stats: null }] }
    expect(catalogRepository(bare, "smithersai/smithers")).toEqual({ id: "smithersai/smithers", org: "smithersai", name: "smithers" })
    const blank = { repos: [{ ...catalog.repos[0], summary: "   " }] }
    expect(catalogRepository(blank, "smithersai/smithers")?.summary).toBeUndefined()
  })

  test("answers null for a name outside the catalog or a malformed catalog", () => {
    expect(catalogRepository(catalog, "someone/else")).toBeNull()
    expect(catalogRepository({ repos: "nope" }, "smithersai/smithers")).toBeNull()
    expect(catalogRepository(null, "smithersai/smithers")).toBeNull()
  })
})

describe("withoutRepoParam", () => {
  test("drops only the repo parameter and keeps the rest of the location", () => {
    expect(withoutRepoParam({ pathname: "/", search: "?repo=smithersai/smithers", hash: "" })).toBe("/")
    expect(withoutRepoParam({ pathname: "/app", search: "?tab=main&repo=a/b", hash: "#top" })).toBe("/app?tab=main#top")
  })

  test("keeps the repository path in the address bar", () => {
    expect(withoutRepoParam({ pathname: "/smithersai/smithers", search: "", hash: "" })).toBe("/smithersai/smithers")
    expect(withoutRepoParam({ pathname: "/smithersai/smithers", search: "?repo=someone/else", hash: "" })).toBe(
      "/smithersai/smithers"
    )
  })
})

/*
 * A sign-in that starts on a repository page comes back to it: the page is
 * the return path the start route carries. The landing page needs none (the
 * callback lands there on its own), and a spent auth marker never replays.
 */
describe("signInReturnTo", () => {
  test("a repository page returns to itself, query included", () => {
    expect(signInReturnTo({ pathname: "/smithersai/smithers", search: "" })).toBe("/smithersai/smithers")
    expect(signInReturnTo({ pathname: "/smithersai/smithers/", search: "?tab=issues" })).toBe(
      "/smithersai/smithers/?tab=issues"
    )
  })

  test("spent auth markers never replay", () => {
    expect(signInReturnTo({ pathname: "/smithersai/smithers", search: "?signed-in=github" })).toBe("/smithersai/smithers")
    expect(signInReturnTo({ pathname: "/smithersai/smithers", search: "?auth=failed&tab=issues" })).toBe(
      "/smithersai/smithers?tab=issues"
    )
  })

  test("the landing page and non-repository paths carry no return path", () => {
    expect(signInReturnTo({ pathname: "/", search: "" })).toBeNull()
    expect(signInReturnTo({ pathname: "/", search: "?repo=smithersai/smithers" })).toBeNull()
    expect(signInReturnTo({ pathname: "/smithersai", search: "" })).toBeNull()
    expect(signInReturnTo({ pathname: "/a/b/c", search: "" })).toBeNull()
  })

  test("a query the server would drop is left behind rather than losing the page", () => {
    expect(signInReturnTo({ pathname: "/smithersai/smithers", search: `?q=${"x".repeat(600)}` })).toBe(
      "/smithersai/smithers"
    )
  })
})

describe("openRequestedRepo", () => {
  test("a superseded bookmark read cannot win over the current repository entry", async () => {
    const { store, controller } = await fixture()
    const old = Promise.withResolvers<Response>(), fresh = Promise.withResolvers<Response>()
    const oldStarted = Promise.withResolvers<void>(), freshStarted = Promise.withResolvers<void>()
    const http = (reply: typeof old, started: typeof oldStarted) => async (input: RequestInfo | URL) => {
      if (String(input) === "/api/public/repos") return jsonResponse(catalog)
      started.resolve()
      return reply.promise
    }
    const earlier = openRequestedRepo(controller, http(old, oldStarted), "smithersai/smithers")
    await oldStarted.promise
    const current = openRequestedRepo(controller, http(fresh, freshStarted), "smithersai/smithers")
    await freshStarted.promise
    try {
      const before = await store.eventHistory()
      old.resolve(jsonResponse({ default_bookmark: "retired" }))
      await earlier
      expect((await store.eventHistory()).head).toEqual(before.head)
      expect(store.collections.repositories.get("smithersai/smithers")?.head).toBeNull()
      fresh.resolve(jsonResponse({ default_bookmark: "current" }))
      await current
      expect(store.collections.repositories.get("smithersai/smithers")?.head?.bookmark).toBe("current")
      expect(store.collections.workingCopies.get("shared:smithersai/smithers")?.bookmark).toBe("current")
    } finally {
      old.resolve(jsonResponse({})); fresh.resolve(jsonResponse({}))
      await Promise.allSettled([earlier, current])
      await store.dispose?.()
    }
  })

  test("a bookmark response respects a retired caller after its repository entry is ready", async () => {
    const { store, controller } = await fixture()
    let owned = true
    const reply = Promise.withResolvers<Response>(), started = Promise.withResolvers<void>()
    const opening = openRequestedRepo(controller, async input => {
      if (String(input) === "/api/public/repos") return jsonResponse(catalog)
      started.resolve()
      return reply.promise
    }, "smithersai/smithers", undefined, 320, { isCurrent: () => owned })
    try {
      await started.promise
      expect(store.session().repositoryEntry?.phase).toBe("ready")
      owned = false
      const before = await store.eventHistory()
      reply.resolve(jsonResponse({ default_bookmark: "retired" }))
      await opening
      expect((await store.eventHistory()).head).toEqual(before.head)
      expect(store.collections.repositories.get("smithersai/smithers")?.head).toBeNull()
      expect(store.collections.workingCopies.get("shared:smithersai/smithers")?.bookmark).toBeUndefined()
    } finally { reply.resolve(jsonResponse({})); await opening; await store.dispose?.() }
  })

  test("an unresolved URL blocks the saved selection and lone-repository fallback without blocking explicit targets", async () => {
    const { store, controller } = await fixture()
    await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers")
    let answer!: (response: Response) => void
    const catalogRead = new Promise<Response>(resolve => { answer = resolve })
    const opening = openRequestedRepo(controller, () => catalogRead, "missing/repository")
    expect(store.session().activeRepoKey).toBeNull()
    expect(store.collections.repositories.size).toBe(1)
    expect(resolveTargetRepo(store, undefined)).toEqual({ error: "Opening missing/repository. Try again when it is ready." })
    expect(resolveTargetRepo(store, "smithersai/smithers")).toEqual({ repo: "smithersai/smithers" })
    answer(jsonResponse(catalog))
    const refusal = await opening
    expect(refusal).toBe("missing/repository is not in the public repository catalog.")
    expect(resolveTargetRepo(store, undefined)).toEqual({ error: "missing/repository is not in the public repository catalog." })
    expect(resolveTargetRepo(store, "smithersai/smithers")).toEqual({ repo: "smithersai/smithers" })
  })

  test("a failed catalog read cannot revive a previous selection, and a root entry clears the URL constraint", async () => {
    const { store, controller } = await fixture()
    await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers")
    await openRequestedRepo(controller, async () => jsonResponse({}, 503), "missing/repository")
    expect(resolveTargetRepo(store, undefined)).toEqual({ error: "The public repository catalog answered HTTP 503." })
    beginRepositoryEntry(store, null)
    expect(store.session().repositoryEntry).toBeNull()
    expect(resolveTargetRepo(store, undefined)).toEqual({ repo: "smithersai/smithers" })
  })

  test("a thrown catalog read answers a product sentence, never the thrown text", async () => {
    const { store, controller } = await fixture()
    const refusal = await openRequestedRepo(controller, async () => { throw new TypeError("ECONNRESET secret-socket-detail") }, "smithersai/smithers")
    expect(refusal).toBe("The public repository catalog could not be read.")
    expect(JSON.stringify(store.session().repositoryEntry)).not.toContain("secret-socket-detail")
  })

  test("a late catalog response cannot select an earlier URL or overwrite the newer refusal", async () => {
    const { store, controller, ran } = await fixture()
    let answer!: (response: Response) => void
    const catalogRead = new Promise<Response>(resolve => { answer = resolve })
    const earlier = openRequestedRepo(controller, () => catalogRead, "smithersai/smithers")
    await openRequestedRepo(controller, async () => jsonResponse(catalog), "missing/repository")
    answer(jsonResponse(catalog))
    await earlier
    expect(store.session().activeRepoKey).toBeNull()
    expect(store.session().repositoryEntry).toMatchObject({ repo: "missing/repository", phase: "failed" })
    expect(store.collections.repositories.size).toBe(0)
    expect(ran).toEqual([])
  })

  test("boot records the entry before starting catalog I/O and reuses that request", async () => {
    const { store, controller } = await fixture()
    store.dispatch({ type: "repo.selected", actor: "user", id: "practice:smithersai/hello-server" })
    const requestId = beginRepositoryEntry(store, "smithersai/smithers")
    expect(store.session().activeRepoKey).toBeNull()
    expect(resolveTargetRepo(store, undefined)).toHaveProperty("error")
    await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers", requestId)
    expect(store.session().repositoryEntry).toMatchObject({ requestId, phase: "ready" })
    expect(resolveTargetRepo(store, undefined)).toEqual({ repo: "smithersai/smithers" })
  })

  test("reopening the repository URL keeps its selected cloud computer", async () => {
    const { store, controller } = await fixture()
    await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers")
    await store.dispatch({ type: "workspace.updated", actor: "system", workspace: {
      id: "coding", repoId: "smithersai/smithers", name: "Coding", status: "running", targetBookmark: "main",
      provisioningStage: null, suspendedAt: null, createdAt: null, head: null
    } }).isPersisted.promise
    await controller.selectRepo("smithersai/smithers#workspace:coding")
    await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers")
    expect(store.session().activeRepoKey).toBe("smithersai/smithers#workspace:coding")
  })

  test("a catalog repository becomes the active selection, and its shared tree opens", async () => {
    const { store, controller, ran } = await fixture()
    const requests: Array<string> = []
    const http = async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return jsonResponse(catalog)
    }
    expect(await openRequestedRepo(controller, http, "SmithersAI/Smithers")).toBeUndefined()
    // The catalog, then the mirror's repository document for the shared copy's bookmark.
    expect(requests).toEqual(["/api/public/repos", "/api/repos/smithersai/smithers"])
    expect(store.session().activeRepoKey).toBe("smithersai/smithers")
    expect(store.collections.repositories.get("smithersai/smithers")).toMatchObject({
      org: "smithersai",
      name: "smithers",
      head: null,
      // Provenance: the row is readable signed out, and the chat opens on it.
      catalog: true,
      // The catalog retains its curated summary.
      summary: SUMMARY
    })
    // The shared read-only copy's root opens (the caret's own act), once per launch.
    expect(ran).toEqual(["repo.tree shared:smithersai/smithers"])
  })

  /*
   * The shared read-only copy (WorkspaceViews.ts) is the signed-out visitor's
   * one tab: its root opens on the first paint, and its bookmark is the
   * mirror's default bookmark (`GET /api/repos/{o}/{r}`, a public read the
   * Worker forwards signed out), never a name the catalog did not carry.
   */
  test("the shared copy opens its root once and names the mirror's default bookmark; a reload with the tree already open runs nothing twice", async () => {
    const { store, controller, ran } = await fixture()
    const requests: Array<string> = []
    const http = async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return String(input) === "/api/repos/smithersai/smithers" ? jsonResponse({ default_bookmark: "main" }) : jsonResponse(catalog)
    }
    expect(await openRequestedRepo(controller, http, "smithersai/smithers")).toBeUndefined()
    expect(requests).toEqual(["/api/public/repos", "/api/repos/smithersai/smithers"])
    expect(store.collections.repositories.get("smithersai/smithers")?.head).toEqual({ bookmark: "main", changeId: null, commitId: null })
    expect(store.collections.workingCopies.get("shared:smithersai/smithers")).toMatchObject({ kind: "shared", access: "read", bookmark: "main" })
    expect(ran).toEqual(["repo.tree shared:smithersai/smithers"])
    // The tree row stands for this launch: the reload leaves the caret's state alone.
    store.dispatch({ type: "repo-tree.loaded", actor: "system", copyId: "shared:smithersai/smithers", path: "", entries: [], truncated: false })
    expect(await openRequestedRepo(controller, http, "smithersai/smithers")).toBeUndefined()
    expect(ran.filter((name) => name.startsWith("repo.tree"))).toEqual(["repo.tree shared:smithersai/smithers"])
  })

  test("a mirror that answers no bookmark leaves the row's head alone: nothing invented", async () => {
    const { store, controller } = await fixture()
    const http = async (input: RequestInfo | URL) =>
      String(input) === "/api/repos/smithersai/smithers" ? jsonResponse({ message: "unavailable" }, 502) : jsonResponse(catalog)
    expect(await openRequestedRepo(controller, http, "smithersai/smithers")).toBeUndefined()
    expect(store.collections.repositories.get("smithersai/smithers")?.head).toBeNull()
    expect(store.collections.workingCopies.get("shared:smithersai/smithers")?.bookmark).toBeUndefined()
  })

  test("a name outside the catalog is refused and selects nothing", async () => {
    const { store, controller, ran } = await fixture()
    const refusal = await openRequestedRepo(controller, async () => jsonResponse(catalog), "someone/else")
    expect(refusal).toBe("someone/else is not in the public repository catalog.")
    expect(store.session().activeRepoKey ?? null).toBeNull()
    expect(store.collections.repositories.size).toBe(0)
    expect(ran).toEqual([]) // The route shell owns the single prompt naming the requested path.
  })

  test("an unreachable catalog is a refusal, not a selection", async () => {
    const { store, controller } = await fixture()
    expect(await openRequestedRepo(controller, async () => jsonResponse({}, 503), "smithersai/smithers")).toMatch(/HTTP 503/)
    expect(await openRequestedRepo(controller, async () => { throw new Error("offline") }, "smithersai/smithers")).toBe("The public repository catalog could not be read.")
    expect(store.session().activeRepoKey ?? null).toBeNull()
  })

  /*
   * Opening one repository is a fact about that one row. The cloud inventory
   * beside it is left exactly as it was: a whole-list replace would rewrite
   * every row (and silently drop any field the caller's projection forgot).
   */
  test("the catalog row is upserted alone: every inventory row beside it is untouched", async () => {
    const { store, controller } = await fixture()
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        {
          id: "acme/widgets",
          org: "acme",
          ownerKind: "org",
          name: "widgets",
          head: { bookmark: "trunk", changeId: "zzz", commitId: "abc" },
          summary: "The widgets."
        }
      ]
    })
    const before = structuredClone(store.collections.repositories.get("acme/widgets"))
    const http = async (input: RequestInfo | URL) =>
      String(input) === "/api/repos/smithersai/smithers" ? jsonResponse({ default_bookmark: "main" }) : jsonResponse(catalog)
    expect(await openRequestedRepo(controller, http, "smithersai/smithers")).toBeUndefined()
    // Neither the catalog row's insert nor the mirror bookmark's landing touches it.
    expect(structuredClone(store.collections.repositories.get("acme/widgets"))).toEqual(before)
    expect(store.collections.repositories.get("smithersai/smithers")).toMatchObject({
      org: "smithersai",
      name: "smithers",
      catalog: true,
      summary: SUMMARY,
      head: { bookmark: "main", changeId: null, commitId: null }
    })
  })

  test("the cloud inventory already loaded stays beside the catalog row", async () => {
    const { store, controller } = await fixture()
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "acme/widgets", org: "acme", ownerKind: "org", name: "widgets", head: null }]
    })
    await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers")
    expect([...store.collections.repositories.keys()].sort()).toEqual(["acme/widgets", "smithersai/smithers"])
    expect(store.collections.repositories.get("acme/widgets")?.ownerKind).toBe("org")
    expect(store.session().activeRepoKey).toBe("smithersai/smithers")
  })
})


test("a signed-in repository URL waits for the user's inventory and selects its row without publishing it", async () => {
  const { store, controller, ran } = await fixture()
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: false, scopesPlain: null })
  let loaded = false
  controller.loadRepositories = async () => {
    await Promise.resolve()
    loaded = true
    store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "codeplanesmithers/canary-sandbox", org: "codeplanesmithers", name: "canary-sandbox", ownerKind: "user", head: null }] })
  }
  expect(await openRequestedRepo(controller, async () => jsonResponse(catalog), "CodePlaneSmithers/Canary-Sandbox")).toBeUndefined()
  expect(loaded).toBe(true)
  expect(store.session().activeRepoKey).toBe("codeplanesmithers/canary-sandbox")
  expect(store.collections.repositories.get("codeplanesmithers/canary-sandbox")?.catalog).not.toBe(true)
  expect(ran).toEqual([])
})

test("a signed-in catalog visitor keeps the shared tree without waiting on private inventory", async () => {
  const { store, controller, ran } = await fixture()
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: false, scopesPlain: null })
  controller.loadRepositories = async () => { throw new Error("private inventory unavailable") }
  expect(await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers")).toBeUndefined()
  expect(store.session().activeRepoKey).toBe("smithersai/smithers")
  expect(ran).toEqual(["repo.tree shared:smithersai/smithers"])
})


test("a late private inventory refresh retains the URL's public repository and shared tree", async () => {
  const { store, controller } = await fixture()
  await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers")
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
    { id: "codeplanesmithers/canary-sandbox", org: "codeplanesmithers", name: "canary-sandbox", ownerKind: "user", head: null }
  ] }).isPersisted.promise
  expect(store.session().activeRepoKey).toBe("smithersai/smithers")
  expect(store.collections.repositories.get("smithersai/smithers")?.catalog).toBe(true)
  expect(store.collections.workingCopies.get("shared:smithersai/smithers")?.repoId).toBe("smithersai/smithers")
})

test("opening a public URL records catalog provenance even when private inventory loaded it first", async () => {
  const { store, controller } = await fixture()
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
    { id: "smithersai/smithers", org: "smithersai", name: "smithers", ownerKind: "org", head: null }
  ] }).isPersisted.promise
  await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers")
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [] }).isPersisted.promise
  expect(store.collections.repositories.get("smithersai/smithers")).toMatchObject({ catalog: true, ownerKind: "org" })
})

for (const search of ["?tutorial", "?tutorial=", "?repo=a/b&tutorial&tab=issues"]) {
  test(`legacy tutorial flag stays inert while cleaning ${search}`, () => {
    const cleaned = withoutRepoParam({ pathname: "/smithersai/smithers/", search, hash: "#top" })
    expect(cleaned).toContain("tutorial")
    expect(cleaned).toEndWith("#top")
  })
}

test("mobile repository entry selects the requested repo without opening an obstructing tree drawer", async () => {
  const { controller, store, ran } = await fixture()
  try {
    const refusal = await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers", undefined, 320)
    expect(refusal).toBeUndefined()
    expect(store.session().activeRepoKey).toBe("smithersai/smithers")
    expect(store.session().repositoryEntry?.phase).toBe("ready")
    expect(ran).toEqual([])
  } finally { await store.dispose?.() }
})
