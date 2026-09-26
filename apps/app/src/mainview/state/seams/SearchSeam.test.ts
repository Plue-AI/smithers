/*
 * The search seam (Search and Command Palette Spec 2026-09-07 §4, §5, §6)
 * against fixture seams: the palette's rows come from what the store holds,
 * the flow doors answer items as data and embed the search-results card for
 * a human, the signed-out scope hides and defers, and a mode with no index
 * refuses with its reason.
 */
import type { Card } from "@smthrs/rpc/Cards"
import type { StorageApi } from "@tanstack/db"
import { describe,expect,test } from "bun:test"
import { runSearchRef } from "@smthrs/ui/run-command"

import type { AgentPort } from "../../runtime/AgentPort"
import type { AppServices } from "../AppController"
import { createAppController } from "../AppController"
import type { AppStore } from "../AppStore"
import { createAppStore } from "../AppStore"
import { ASK_PROPOSED,NO_FOCUSED_FILE } from "./SearchSeam"

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

const backend = (routes: Record<string, Response>, seen: Array<string> = []): AppServices => ({
  fetchImpl: async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    seen.push(path)
    for (const [route, answer] of Object.entries(routes)) {
      if (path === route || path.startsWith(`${route}?`)) return answer.clone()
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const identity = async (store: AppStore, state: "signed-in" | "signed-out"): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state,
    login: state === "signed-in" ? "will" : null,
    allowlisted: state === "signed-in",
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const REPO = "will/flows"

const ready = async (services: AppServices = backend({}), state: "signed-in" | "signed-out" = "signed-out") => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, services)
  await identity(store, state)
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: REPO, org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await settled()
  return { store, controller }
}

let ordinal = 100
const card = (store: AppStore, value: Omit<Card, "createdAt" | "ordinal" | "status">): void => {
  ordinal += 1
  store.dispatch({ type: "card.upsert", actor: "system", card: { ...value, status: "active", createdAt: ordinal, ordinal } as Card })
}

/** The fixture seams: what each seam had already written to the store. */
const seed = async (store: AppStore): Promise<void> => {
  card(store, {
    id: "files-x",
    kind: "file-list",
    title: "files",
    payload: {
      repo: "smithers",
      localRepoId: "r1",
      path: "packages/journal",
      entries: [{ name: "Redaction.ts", kind: "file" }, { name: "Redaction.test.ts", kind: "file" }, { name: "src", kind: "dir" }]
    }
  })
  card(store, {
    id: `history-${REPO}`,
    kind: "history",
    title: "history",
    payload: {
      repo: REPO,
      defaultBookmark: "main",
      mainCommits: null,
      mythical: {
        state: "present",
        head: "h",
        mainHead: null,
        treeEqual: "unsupported",
        commitCount: 2,
        notes: "read",
        epics: [{
          sha: "abc1234",
          title: "Redact secrets before they reach the journal",
          merge: true,
          note: { tried: "regex rescan per write, lost on latency", evidence: null, folded: null, superseded: null },
          commits: [{ sha: "def5678", title: "Add the redaction seam", note: null }]
        }]
      }
    }
  })
  card(store, {
    id: "runs-x",
    kind: "run-list",
    title: "runs",
    payload: {
      repo: REPO,
      runs: [
        { runId: "run-9", flowId: "review", status: "running", createdAt: 1, turns: 1, calls: 1 },
        { runId: "run-7", flowId: "implement", status: "completed", createdAt: 1, turns: 1, calls: 1 }
      ]
    }
  })
  card(store, {
    id: "issues-x",
    kind: "issue-list",
    title: "issues",
    payload: {
      repo: REPO,
      filter: "all",
      issues: [
        { number: 412, title: "Harden redaction on the journal path", state: "open", author: null, comments: 0, updatedAt: null },
        { number: 7, title: "Old bug", state: "closed", author: null, comments: 0, updatedAt: null }
      ]
    }
  })
  card(store, {
    id: "targets-r1",
    kind: "targets",
    title: "targets",
    payload: {
      repoId: "r1",
      repoName: "flows",
      status: "done",
      warnings: [],
      targets: [{ id: "t1", label: "//apps/app:test", target: "Shell.Test", kinds: ["test"], package: "//apps/app", name: "test", workspace: "." }]
    }
  })
  card(store, {
    id: `secrets-${REPO}`,
    kind: "secrets",
    title: "secrets",
    payload: { repo: REPO, scope: "repository", secrets: [{ name: "NPM_TOKEN", hosts: ["registry.npmjs.org"], matchHeaders: [], updatedAt: null }] }
  })
  store.dispatch({
    type: "change.loaded",
    actor: "system",
    change: { id: `${REPO}#c1`, repoId: REPO, changeId: "c1", commitId: "0123456789ab", description: "Redact the journal\n\nbody", authorName: null, timestamp: null, hasConflict: false, parentChangeIds: [], currentSeq: null, revisionCount: null }
  })
  await settled()
}

const refs = (groups: ReadonlyArray<{ label: string; items: ReadonlyArray<{ item: { ref: string } }> }>, label: string): Array<string> =>
  groups.find((group) => group.label === label)?.items.map((row) => row.item.ref) ?? []

const resultsCard = (store: AppStore, flow: string) => {
  const found = store.collections.cards.get(`search-${flow}`)
  if (found === undefined || found.kind !== "search-results") throw new Error(`no search-results card for ${flow}`)
  return found
}

describe("the palette's rows (the button door) come from what the store holds", () => {
  test("a bare query groups files, history, runs, issues and changes by kind, files first for a file name", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const answer = controller.searchPalette("redact")
    expect(answer.parsed.mode).toBe("all")
    expect(answer.refusal).toBeUndefined()
    expect(answer.groups.map((group) => group.label)).toEqual(["Files", "History", "Changes", "Issues"])
    expect(refs(answer.groups, "Files")).toEqual(["local:r1/packages/journal/Redaction.ts", "local:r1/packages/journal/Redaction.test.ts"])
    // The epic (a prefix match), its commit (contains), then its tried note (its subtitle names the epic).
    expect(refs(answer.groups, "History")).toEqual(["abc1234", "def5678", "abc1234#tried"])
    expect(refs(answer.groups, "Issues")).toEqual(["412"])
    // A directory is never a file result, and every row names its open flow.
    expect(answer.groups.flatMap((group) => group.items).every((row) => row.item.actions.some((action) => action.role === "open"))).toBe(true)
  })

  test("a path query reads only the file index, fuzzy per segment", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const answer = controller.searchPalette("journal/Redaction.test")
    expect(answer.parsed.mode).toBe("path")
    expect(answer.groups.map((group) => group.label)).toEqual(["Files"])
    expect(refs(answer.groups, "Files")[0]).toBe("local:r1/packages/journal/Redaction.test.ts")
  })

  test("history: with section:tried lists the tried notes only; run: with status: filters", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const tried = controller.searchPalette("history: section:tried")
    expect(tried.groups.flatMap((group) => group.items.map((row) => row.item.title))).toEqual(["tried: regex rescan per write, lost on latency"])
    const running = controller.searchPalette("run: status:running")
    expect(running.groups.flatMap((group) => group.items.map((row) => row.item.ref))).toEqual([runSearchRef("run-9", "runs-x")])
    expect(controller.searchPalette("#412").groups.flatMap((group) => group.items.map((row) => row.item.title))).toEqual(["#412 Harden redaction on the journal path"])
  })

  test("wiki: lists the Wiki pane's notes; / hands over to the slash tree; ? lists every prefix", async () => {
    const { controller } = await ready()
    const wiki = controller.searchPalette("wiki:")
    expect(wiki.groups.map((group) => group.label)).toEqual(["Notes"])
    expect(wiki.groups[0]?.items[0]?.item.actions[0]).toMatchObject({ flow: "wiki.select", role: "open" })
    expect(controller.searchPalette("/app")).toMatchObject({ groups: [], flow: "search.flows" })
    const help = controller.searchPalette("?")
    expect(help.help?.map((row) => row.label)).toContain("secret:")
    expect(help.help?.find((row) => row.mode === "boxes")?.available).toBe(false)
  })

  test("an empty query is the pills and the recents, nothing more; a recent item leads on the next query", async () => {
    const { store, controller } = await ready()
    await seed(store)
    expect(controller.searchPalette("").groups.map((group) => group.label)).toEqual(["Recommended"])
    controller.notePaletteItemOpened({ kind: "file", ref: "local:r1/packages/journal/Redaction.test.ts" })
    await settled()
    expect(controller.searchPalette("").groups.map((group) => group.label)).toEqual(["Recommended", "Recent"])
    expect(refs(controller.searchPalette("redact").groups, "Files")[0]).toBe("local:r1/packages/journal/Redaction.test.ts")
  })

  test(":120 jumps into the newest file card; without one it says so", async () => {
    const { store, controller } = await ready()
    expect(controller.searchPalette(":120").refusal).toBe(NO_FOCUSED_FILE)
    card(store, { id: "file-1", kind: "file", title: "f", payload: { repo: "smithers", path: "src/index.ts", content: "x", truncated: false } })
    await settled()
    const answer = controller.searchPalette(":120:8")
    expect(answer.groups[0]?.items[0]?.item.actions[0]).toEqual({ flow: "files.read", args: "src/index.ts:120:8 smithers", label: "Read a file from a repository", role: "open" })
  })

  test("unindexed prefixes remain ordinary queries", async () => {
    const { controller } = await ready()
    for (const query of ["@redact", "@@redact", "text:useEffect", "user:will"]) {
      expect(controller.searchPalette(query)).toMatchObject({ parsed: { mode: "all" }, groups: [] })
      expect(controller.searchPalette(query).refusal).toBeUndefined()
    }
    expect(controller.searchPalette("ask:where")).toMatchObject({ groups: [], refusal: ASK_PROPOSED })
  })
})

describe("§4 signed-out scope", () => {
  test("box: and secret: are hidden signed out (no rows, no refusal, no badge), and a bare query never leaks them", async () => {
    const { store, controller } = await ready()
    await seed(store)
    expect(controller.searchPalette("box:main")).toMatchObject({ groups: [] })
    expect(controller.searchPalette("box:main").refusal).toBeUndefined()
    expect(controller.searchPalette("secret:NPM")).toMatchObject({ groups: [] })
    expect(refs(controller.searchPalette("NPM").groups, "Secrets")).toEqual([])
  })

  test("signed out, the flows a bare query lists are only the ones that work signed out", async () => {
    const { controller } = await ready()
    // Signed out, auth.sign-in is the exclusive recommendation, so it leads in Recommended rather than Flows.
    const answer = controller.searchPalette("sign")
    const names = answer.groups.flatMap((group) => group.items.map((row) => row.item.ref))
    expect(answer.groups[0]?.label).toBe("Recommended")
    expect(names).toContain("auth.sign-in")
    expect(names).not.toContain("auth.sign-out")
  })

  test("Enter on a signed-in-only search defers through sign-in: the flow parks on the requirement", async () => {
    const { store, controller } = await ready()
    // The outcome is the fulfilling flow's (auth.sign-in ran in its place); the search itself parks on the session row.
    await controller.commands.run("search.boxes", "main")
    expect(store.session().pendingCommand).toMatchObject({ name: "search.boxes", args: "main", requirement: "signed-in" })
  })

  test("signed in, secret: lists names and hosts and never a value", async () => {
    const { store, controller } = await ready(backend({}), "signed-in")
    await seed(store)
    const answer = controller.searchPalette("secret:NPM")
    expect(answer.groups[0]?.items.map((row) => row.item)).toEqual([
      expect.objectContaining({ kind: "secret-name", ref: "NPM_TOKEN", title: "NPM_TOKEN", subtitle: `${REPO} · registry.npmjs.org` })
    ])
    // A secret row carries exactly the item fields; no value field exists on the wire or the row.
    expect(Object.keys(answer.groups[0]?.items[0]?.item ?? {}).sort()).toEqual(["actions", "kind", "ref", "subtitle", "title"])
  })
})

describe("§6 the flow doors", () => {
  test("a human's search.files embeds the search-results card and answers the items as data", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const outcome = await controller.commands.run("search.files", "Redaction")
    expect(outcome.status).toBe("executed")
    if (outcome.status !== "executed") return
    const value = JSON.parse(outcome.value ?? "{}") as { flow: string; count: number; items: Array<{ kind: string; ref: string }> }
    expect(value.flow).toBe("search.files")
    expect(value.count).toBe(2)
    expect(value.items.map((item) => item.ref)).toEqual(["local:r1/packages/journal/Redaction.ts", "local:r1/packages/journal/Redaction.test.ts"])
    const results = resultsCard(store, "search.files")
    expect(results.payload).toMatchObject({ query: "Redaction", flow: "search.files", args: "Redaction" })
    expect(results.payload.items.map((item) => item.ref)).toEqual(value.items.map((item) => item.ref))
  })

  test("the agent's search.files gets the same items as data and no card", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const outcome = await controller.commands.runForAgent("search.files", "Redaction")
    expect(outcome.status).toBe("executed")
    if (outcome.status !== "executed") return
    expect((JSON.parse(outcome.value ?? "{}") as { count: number }).count).toBe(2)
    expect(store.collections.cards.get("search-search.files")).toBeUndefined()
  })

  test("search.open without a query answers the pills and recents; --kinds narrows", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const all = await controller.commands.run("search.open", "redact")
    expect(all.status).toBe("executed")
    const narrowed = await controller.commands.run("search.open", "redact --kinds issue")
    expect(narrowed.status).toBe("executed")
    if (narrowed.status !== "executed") return
    const value = JSON.parse(narrowed.value ?? "{}") as { items: Array<{ kind: string }> }
    expect(value.items.map((item) => item.kind)).toEqual(["issue"])
    expect(resultsCard(store, "search.open").payload.items.map((item) => item.kind)).toEqual(["issue"])
  })

  test("search.history reads the section qualifier in its own grammar; search.runs, search.changes and search.issues read their seams' rows", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const history = await controller.commands.run("search.history", "regex section:tried")
    expect(history.status).toBe("executed")
    expect(resultsCard(store, "search.history").payload.items.map((item) => item.title)).toEqual(["tried: regex rescan per write, lost on latency"])
    await controller.commands.run("search.runs", "run status:completed")
    expect(resultsCard(store, "search.runs").payload.items.map((item) => item.ref)).toEqual([runSearchRef("run-7", "runs-x")])
    await controller.commands.run("search.changes", "journal")
    expect(resultsCard(store, "search.changes").payload.items[0]).toMatchObject({ kind: "change", ref: "c1", title: "Redact the journal" })
    await controller.commands.run("search.issues", "bug is:closed")
    expect(resultsCard(store, "search.issues").payload.items.map((item) => item.ref)).toEqual(["7"])
    const labeled = await controller.commands.run("search.issues", "bug label:bug")
    expect(labeled).toMatchObject({ status: "failed", error: expect.stringContaining("no labels") })
  })

  test("search.targets lists the target graph's labels and the factory projection's flows, each with its run door", async () => {
    const seen: Array<string> = []
    const projection = {
      on: [],
      flows: [{ id: "review", description: "Reviews the change.", summary: "Review the change.", featured: true, kind: "mdx", path: "flows/review/flow.mdx", capabilities: [], model: null, modelInvocable: true }]
    }
    const { store, controller } = await ready(backend({ [`/api/repos/will/flows/contents/.smithers/factory.json`]: json(200, { path: ".smithers/factory.json", content: JSON.stringify(projection) }) }, seen))
    await seed(store)
    const outcome = await controller.commands.run("search.targets", "e")
    expect(outcome.status).toBe("executed")
    const items = resultsCard(store, "search.targets").payload.items
    expect(items.find((item) => item.kind === "target")).toMatchObject({ ref: "r1 //apps/app:test", title: "//apps/app:test" })
    expect(items.find((item) => item.kind === "flow")).toMatchObject({ ref: "review", actions: [{ flow: "flow.run", args: "review", role: "open", label: "Run a flow on your workspace" }] })
    expect(seen).toContain("/api/repos/will/flows/contents/.smithers/factory.json")
  })

  test("search.secrets signed in reads the environment document and lists names only", async () => {
    const { store, controller } = await ready(
      backend({
        "/api/repos/will/flows/agent-environment": json(200, {
          setup_script: "",
          env: [],
          secrets: [{ name: "NPM_TOKEN", hosts: ["registry.npmjs.org"], match_headers: ["authorization"], updated_at: null }]
        })
      }),
      "signed-in"
    )
    const outcome = await controller.commands.run("search.secrets", "npm")
    expect(outcome.status).toBe("executed")
    const items = resultsCard(store, "search.secrets").payload.items
    expect(items).toEqual([expect.objectContaining({ kind: "secret-name", ref: "NPM_TOKEN", subtitle: `${REPO} · registry.npmjs.org` })])
    expect(JSON.stringify(items)).not.toContain("authorization")
    // A search embeds ONE card (§6): the secrets card is secrets.list's, and the search never wrote it.
    expect(store.collections.cards.get(`secrets-${REPO}`)).toBeUndefined()
    expect([...store.collections.cards.values()].map((row) => row.kind)).toEqual(["search-results"])
  })

  test("search.history with no history card reads the mirror itself, indexes the read, and writes no history card", async () => {
    const seen: Array<string> = []
    const change = (changeId: string, commitId: string, description: string, parents: ReadonlyArray<string>) => ({
      change_id: changeId,
      commit_id: commitId,
      description,
      author_name: "will",
      author_email: "will@example.test",
      timestamp: "2026-09-07T00:00:00Z",
      has_conflict: false,
      is_empty: false,
      parent_change_ids: parents
    })
    const ref = (name: string, sha: string) => ({ ref: name, object: { sha, type: "commit" } })
    const E1 = "e100000000000000000000000000000000000001"
    const A1 = "a100000000000000000000000000000000000001"
    const R = "0000000000000000000000000000000000000000"
    const { store, controller } = await ready(
      backend({
        "/api/repos/will/flows": json(200, { default_bookmark: "main" }),
        "/api/repos/will/flows/git/refs": json(200, [ref("refs/heads/main", E1), ref("refs/heads/mythical", E1)]),
        "/api/repos/will/flows/changes": json(200, {
          items: [
            change("c-e1", E1, "01 · The workspace declares its toolchain", ["c-r", "c-a1"]),
            change("c-a1", A1, "feat(workspace): WORKSPACE.ts", ["c-r"]),
            change("c-r", R, "root", [])
          ],
          next_cursor: ""
        })
      }, seen)
    )
    const outcome = await controller.commands.run("search.history", "workspace")
    expect(outcome.status).toBe("executed")
    expect(seen).toContain("/api/repos/will/flows/git/refs")
    const items = resultsCard(store, "search.history").payload.items
    expect(items.map((item) => [item.ref, item.title])).toEqual([
      [E1, "01 · The workspace declares its toolchain"],
      [A1, "feat(workspace): WORKSPACE.ts"]
    ])
    // The read is the index, never a second card: history.show owns `history-<repo>`.
    expect(store.collections.cards.get(`history-${REPO}`)).toBeUndefined()
    expect([...store.collections.cards.values()].map((row) => row.kind)).toEqual(["search-results"])
    // A history card already held is the index and the mirror is not walked again.
    await seed(store)
    const reads = seen.length
    await controller.commands.run("search.history", "redaction")
    expect(seen.length).toBe(reads)
    expect(resultsCard(store, "search.history").payload.items.map((item) => item.ref)).toEqual(["def5678"])
  })

  test("unindexed search flows are absent from the real registry", async () => {
    const { controller } = await ready(backend({}), "signed-in")
    for (const name of ["search.symbols", "search.text", "search.people"]) {
      expect(controller.commands.find(name)).toBeUndefined()
    }
  })

  test("a search flow without its query renders the form (THE FORM LAW), and palette.open refuses the agent by naming search.*", async () => {
    const { controller } = await ready()
    const outcome = await controller.commands.run("search.wiki")
    expect(outcome).toMatchObject({ status: "form", flow: "search.wiki", fields: ["query"] })
    const refused = await controller.commands.runForAgent("palette.open")
    expect(refused).toMatchObject({ status: "failed", error: expect.stringContaining("search.*") })
  })

  test("palette.recent answers the ledger as data, most recent first, and the ledger counts repeats", async () => {
    const { controller } = await ready()
    controller.notePaletteItemOpened({ kind: "file", ref: "a.ts" })
    controller.notePaletteItemOpened({ kind: "run", ref: "run-1" })
    controller.notePaletteItemOpened({ kind: "file", ref: "a.ts" })
    await settled()
    const outcome = await controller.commands.runForAgent("palette.recent")
    expect(outcome.status).toBe("executed")
    if (outcome.status !== "executed") return
    const value = JSON.parse(outcome.value ?? "{}") as { items: Array<{ ref: string; count: number }> }
    expect(value.items.map((item) => [item.ref, item.count])).toEqual([["a.ts", 2], ["run-1", 1]])
  })
})

const publicRepos = ["alpha/one", "beta/two"]
const repositoryRows = publicRepos.map(id => ({ id, org: id.split("/")[0]!, ownerKind: "user" as const, name: id.split("/")[1]!, head: null, catalog: true }))
const addTree = (store: AppStore, repo: string) => store.dispatch({ type: "repo-tree.loaded", actor: "system", copyId: `shared:${repo}`, path: "", entries: [{ name: "README.md", kind: "file" }], truncated: false })
const files = (controller: ReturnType<typeof createAppController>) => controller.searchPalette("README.md").groups.flatMap(group => group.items.map(row => row.item))

test("same file path in two repositories remains two explicitly targeted results", async () => {
  const {store,controller}=await ready()
  try {
    await store.dispatch({type:"repositories.loaded",actor:"system",repositories:repositoryRows}).isPersisted.promise
    await store.dispatch({type:"repo.selected",actor:"user",id:"alpha/one"}).isPersisted.promise
    addTree(store,"alpha/one");addTree(store,"beta/two");await settled()
    const items=files(controller);
    expect(items).toHaveLength(2)
    for (const repo of publicRepos) expect(items.some(item=>item.actions.some(action=>action.role==="open"&&action.args?.includes(repo)))).toBe(true)
  } finally {await controller.dispose?.();await store.dispose?.()}
})

test("tree and listing for the same repository file share one search identity", async () => {
  const {store,controller}=await ready()
  try {
    await store.dispatch({type:"repositories.loaded",actor:"system",repositories:repositoryRows}).isPersisted.promise
    await store.dispatch({type:"repo.selected",actor:"user",id:"alpha/one"}).isPersisted.promise
    addTree(store,"alpha/one")
    card(store,{id:"files-alpha",kind:"file-list",title:"Files",payload:{repo:"alpha/one",path:"",address:"/alpha/one/",entries:[{name:"README.md",kind:"file"}]}})
    await settled();const items=files(controller);
    expect(items).toHaveLength(1)
    expect(items[0]?.actions.find(action=>action.role==="open")?.args).toContain("alpha/one")
  } finally {await controller.dispose?.();await store.dispose?.()}
})

test("an existing file result stays bound to its repository after selection changes", async () => {
  const seen: string[]=[]
  const {store,controller}=await ready(backend({
    "/api/repos/alpha/one/contents/README.md":json(200,{type:"file",path:"README.md",content:"ALPHA",encoding:"utf-8"}),
    "/api/repos/beta/two/contents/README.md":json(200,{type:"file",path:"README.md",content:"BETA",encoding:"utf-8"})
  },seen))
  try {
    await store.dispatch({type:"repositories.loaded",actor:"system",repositories:repositoryRows}).isPersisted.promise
    await store.dispatch({type:"repo.selected",actor:"user",id:"alpha/one"}).isPersisted.promise
    addTree(store,"alpha/one");await settled()
    const item=files(controller).find(item=>item.kind==="file")!
    const open=item.actions.find(action=>action.role==="open")!
    await store.dispatch({type:"repo.selected",actor:"user",id:"beta/two"}).isPersisted.promise
    const outcome=await controller.commands.run(open.flow,open.args)
    expect(outcome).toMatchObject({status:"executed",value:expect.stringContaining("ALPHA")})
    expect(seen.filter(path=>path.endsWith("/contents/README.md"))).toEqual(["/api/repos/alpha/one/contents/README.md"])
  } finally {await controller.dispose?.();await store.dispose?.()}
})


test("local tree and card observations deduplicate without merging other checkouts", async () => {
  const {store,controller}=await ready()
  try {
    const repos=["a","b"].map(id=>({id,path:`/canary/${id}`,name:`alpha/${id}`,git:{branch:"main",remote:`git@github.com:alpha/${id}.git`},warnings:[],smithers:{detected:false,workspaceFile:null,declarationFiles:[],reason:"none",workspaces:[]}}))
    await store.dispatch({type:"repos.loaded",actor:"system",repos}).isPersisted.promise
    for(const repo of repos) await store.dispatch({type:"repo-tree.loaded",actor:"system",copyId:`local:${repo.path}`,path:"",entries:[{name:"README notes.md",kind:"file"}],truncated:false}).isPersisted.promise
    card(store,{id:"local-a-file",kind:"file",title:"File",payload:{repo:"alpha/a",localRepoId:"a",path:"README notes.md",content:"A",truncated:false}})
    await settled()
    const items=controller.searchPalette("README").groups.flatMap(group=>group.items.map(row=>row.item)).filter(item=>item.kind==="file")
    expect(items.map(item=>item.ref).sort()).toEqual(["local:a/README notes.md","local:b/README notes.md"])
    expect(items.map(item=>item.actions[0]?.args).sort()).toEqual(['"README notes.md" a','"README notes.md" b'])
    expect(items.every(item=>item.actions.length===1&&item.actions[0]?.flow==="files.read")).toBe(true)
  } finally {await controller.dispose?.();await store.dispose?.()}
})

test("workspace files retain distinct explicit targets and orphan tree rows are not guessed", async () => {
  const {store,controller}=await ready()
  try {
    await store.dispatch({type:"workingcopies.workspaces.loaded",actor:"system",copies:["ws-a","ws-b"].map(id=>({id,repoId:"alpha/one",kind:"workspace",label:id,workspaceId:id,state:"running"}))}).isPersisted.promise
    for(const copyId of ["ws-a","ws-b","missing-copy"]) await store.dispatch({type:"repo-tree.loaded",actor:"system",copyId,path:"",entries:[{name:"README.md",kind:"file"}],truncated:false}).isPersisted.promise
    const items=files(controller)
    expect(items.map(item=>item.ref).sort()).toEqual(["workspace:ws-a/README.md","workspace:ws-b/README.md"])
    expect(items.map(item=>item.actions[0])).toEqual([
      expect.objectContaining({flow:"workspace.file",args:"README.md ws-a",role:"open"}),
      expect.objectContaining({flow:"workspace.file",args:"README.md ws-b",role:"open"})
    ])
  } finally {await controller.dispose?.();await store.dispose?.()}
})

for (const mode of ["secrets", "targets"] as const) {
  test(`a retired account's ${mode} search cannot return or persist its private results`, async () => {
    const reply = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>()
    const suffix = mode === "secrets" ? "/agent-environment" : "/contents/.smithers/factory.json"
    const { store, controller } = await ready({ fetchImpl: async input => {
      if (String(input).endsWith(`/api/repos/search/private${suffix}`)) { entered.resolve(); return reply.promise }
      return json(404, {})
    } }, "signed-in")
    try {
      const pending = controller.search(`search.${mode}`, mode, { query: "private", repo: "search/private" })
      await entered.promise
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "second", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      const payload = mode === "secrets"
        ? { setup_script: "", env: [], secrets: [{ name: "PRIVATE_TOKEN", hosts: ["private.example.test"], match_headers: [], updated_at: null }] }
        : { content: JSON.stringify({ on: [], flows: [{ id: "private-flow", description: "Private work", summary: "Private work", featured: true, kind: "mdx", path: "flows/private/flow.mdx", capabilities: [], model: null, modelInvocable: true }] }) }
      reply.resolve(json(200, payload))
      const result = await pending
      expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN")
      expect(JSON.stringify(result)).not.toContain("private-flow")
      expect(store.collections.cards.get(`search-search.${mode}`)).toBeUndefined()
    } finally { reply.resolve(json(404, {})); await controller.dispose(); await store.dispose?.() }
  })
}

for (const mode of ["secrets", "targets", "history", "boxes"] as const) {
  for (const actor of ["user", "smithers"] as const) {
    test.each(["account", "provider", "sign-out-return", "cloud", "dispose", "refresh"] as Array<"account" | "provider" | "sign-out-return" | "cloud" | "dispose" | "refresh">)(`${actor} ${mode} search keeps its owner through %s`, async change => {
      const { createSearchSeam } = await import("./SearchSeam")
      const { SIGN_OUT_REFUSAL } = await import("./CloudSignIn")
      const { store, controller } = await ready(backend({}), "signed-in")
      const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
      let disposed = false, reads = 0
      const sha = "e100000000000000000000000000000000000001"
      const answer = () => mode === "secrets"
        ? { setup_script: "", env: [], secrets: [{ name: "PRIVATE_TOKEN", hosts: ["private.example.test"], match_headers: [], updated_at: null }] }
        : mode === "targets"
          ? { content: JSON.stringify({ on: [], flows: [{ id: "private-flow", description: "Private work", summary: "Private work", featured: true, kind: "mdx", path: "flows/private/flow.mdx", capabilities: [], model: null, modelInvocable: true }] }) }
          : { items: [{ change_id: "private-change", commit_id: sha, description: "Private commit", author_name: "will", author_email: "will@example.test", timestamp: "2026-09-07T00:00:00Z", has_conflict: false, is_empty: false, parent_change_ids: [] }], next_cursor: "" }
      const wait = async () => { reads++; entered.resolve(); await gate.promise }
      try {
        await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
        await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
        const seam = createSearchSeam({ store, baseUrl: "", dispatch: store.dispatch, actor: () => actor, nextOrdinal: store.nextOrdinal, isDisposed: () => disposed,
          http: async input => {
            if (mode === "history") {
              if (String(input).endsWith("/git/refs")) return json(200, [{ ref: "refs/heads/main", object: { sha } }, { ref: "refs/heads/mythical", object: { sha } }])
              if (String(input).endsWith("/api/repos/search/private")) return json(200, { default_bookmark: "main" })
              if (!String(input).includes("/changes?")) return json(404, {})
            }
            await wait(); return json(200, answer())
          }
        }, { registry: () => controller.commands, refreshWorkspaces: wait })
        const pending = seam.search(`search.${mode}`, mode, { query: "private", repo: "search/private" })
        await entered.promise
        const loaded = (login: string | null, provider: "github" | "local" = "github") => store.dispatch({ type: "identity.session.loaded", actor: "system",
          state: login === null ? "signed-out" : "signed-in", login, provider, allowlisted: login !== null, admin: false, scopesPlain: null }).isPersisted.promise
        if (change === "account") await loaded("second")
        if (change === "provider") await loaded("will", "local")
        if (change === "sign-out-return") { await loaded(null); await loaded("will") }
        if (change === "cloud") await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "second", expiresAt: null, scopes: null }).isPersisted.promise
        if (change === "dispose") disposed = true
        if (change === "refresh") {
          await loaded("will")
          await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: "2099-01-01T00:00:00Z", scopes: null }).isPersisted.promise
        }
        const before = await store.eventHistory()
        gate.resolve()
        const result = await pending
        if (change === "refresh") {
          expect(typeof result).toBe("object")
          if (mode !== "boxes") expect(JSON.stringify(result).toLowerCase()).toContain(mode === "secrets" ? "private_token" : mode === "targets" ? "private-flow" : "private commit")
          expect(store.collections.cards.has(`search-search.${mode}`)).toBe(actor === "user")
        } else {
          expect(result).toBe(SIGN_OUT_REFUSAL)
          expect((await store.eventHistory()).head).toEqual(before.head)
          if (change !== "dispose") {
            const fresh = await seam.search(`search.${mode}`, mode, { query: "private", repo: "search/private" })
            expect(typeof fresh).toBe("object")
          }
        }
        expect(reads).toBe(change === "refresh" || change === "dispose" ? 1 : 2)
      } finally { gate.resolve(); await controller.dispose(); await store.dispose?.() }
    })
  }
}

for (const mode of ["secrets", "targets"] as const) {
  test(`a retired ${mode} search cannot return an old refusal`, async () => {
    const { SIGN_OUT_REFUSAL } = await import("./CloudSignIn")
    const reply = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>()
    const { store, controller } = await ready({ fetchImpl: async input => {
      if (String(input).includes("/api/repos/search/private/")) { entered.resolve(); return reply.promise }
      return json(404, {})
    } }, "signed-in")
    try {
      const pending = controller.search(`search.${mode}`, mode, { query: "private", repo: "search/private" })
      await entered.promise
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "second", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      reply.resolve(json(503, { message: "Private account failure" }))
      expect(await pending).toBe(SIGN_OUT_REFUSAL)
      expect(store.collections.cards.has(`search-search.${mode}`)).toBe(false)
    } finally { reply.resolve(json(404, {})); await controller.dispose(); await store.dispose?.() }
  })
}

test("retirement between search stages starts no factory read, and disposal starts no read", async () => {
  const { createSearchSeam } = await import("./SearchSeam")
  const { SIGN_OUT_REFUSAL } = await import("./CloudSignIn")
  const { store, controller } = await ready(backend({}), "signed-in")
  let reads = 0, disposed = false
  const seam = createSearchSeam({ store, baseUrl: "", actor: () => "user", dispatch: store.dispatch, nextOrdinal: store.nextOrdinal,
    isDisposed: () => disposed, http: async () => { reads++; return json(404, {}) }
  }, { registry: () => controller.commands })
  try {
    const pending = seam.search("search.targets", "targets", { query: "private", repo: "search/private" })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "second", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    expect(await pending).toBe(SIGN_OUT_REFUSAL)
    disposed = true
    expect(await seam.search("search.secrets", "secrets", { query: "private", repo: "search/private" })).toBe(SIGN_OUT_REFUSAL)
    expect(reads).toBe(0)
  } finally { await controller.dispose(); await store.dispose?.() }
})

for (const mode of ["secrets", "targets"] as const) {
  test(`a slow ${mode} query cannot replace a newer search card`, async () => {
    const reply = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>()
    let reads = 0
    const payload = mode === "secrets"
      ? { setup_script: "", env: [], secrets: [{ name: "PRIVATE_TOKEN", hosts: ["private.example.test"], match_headers: [], updated_at: null }] }
      : { content: JSON.stringify({ on: [], flows: [{ id: "private-flow", description: "Private work", summary: "Private work", featured: true, kind: "mdx", path: "flows/private/flow.mdx", capabilities: [], model: null, modelInvocable: true }] }) }
    const { store, controller } = await ready({ fetchImpl: async input => {
      if (!String(input).includes("/api/repos/search/private/")) return json(404, {})
      if (++reads === 1) { entered.resolve(); return reply.promise }
      return json(200, payload)
    } }, "signed-in")
    try {
      const old = controller.search(`search.${mode}`, mode, { query: "private", repo: "search/private" })
      await entered.promise
      const query = mode === "secrets" ? "token" : "flow"
      await controller.search(`search.${mode}`, mode, { query, repo: "search/private" })
      const before = await store.eventHistory()
      reply.resolve(json(200, payload))
      expect(typeof await old).toBe("object")
      const result = store.collections.cards.get(`search-search.${mode}`)
      expect(result?.kind).toBe("search-results")
      if (result?.kind === "search-results") expect(result.payload.query).toBe(query)
      expect((await store.eventHistory()).head).toEqual(before.head)
    } finally { reply.resolve(json(404, {})); await controller.dispose(); await store.dispose?.() }
  })
}

for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
  test(`three search reads settling ${order.join(",")} publish only the latest request`, async () => {
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<Response>())
    const entered = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
    let reads = 0
    const { store, controller } = await ready({ fetchImpl: async input => {
      if (!String(input).endsWith("/api/repos/search/private/agent-environment")) return json(404, {})
      const index = reads++; entered[index]!.resolve(); return gates[index]!.promise
    } }, "signed-in")
    try {
      const pending = []
      for (let i = 0; i < 3; i++) {
        pending.push(controller.search("search.secrets", "secrets", { query: String(i), repo: "search/private" }))
        await entered[i]!.promise
      }
      const before = await store.eventHistory()
      for (const index of order) {
        gates[index]!.resolve(json(200, { setup_script: "", env: [], secrets: [] }))
        expect(typeof await pending[index]).toBe("object")
        const card = store.collections.cards.get("search-search.secrets")
        if (card?.kind === "search-results") expect(card.payload.query).toBe("2")
        else expect(order.indexOf(index)).toBeLessThan(order.indexOf(2))
      }
      expect((await store.eventHistory()).head.sequence).toBe(before.head.sequence + 1)
    } finally { for (const gate of gates) gate.resolve(json(404, {})); await controller.dispose(); await store.dispose?.() }
  })
}

test("a failed newer query does not let an older read publish, and another mode stays independent", async () => {
  const reply = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>()
  let reads = 0
  const { store, controller } = await ready({ fetchImpl: async input => {
    if (!String(input).endsWith("/api/repos/search/private/agent-environment")) return json(404, {})
    if (++reads === 1) { entered.resolve(); return reply.promise }
    return json(503, { message: "Unavailable" })
  } }, "signed-in")
  try {
    const pending = controller.search("search.secrets", "secrets", { query: "old", repo: "search/private" })
    await entered.promise
    expect(typeof await controller.search("search.secrets", "secrets", { query: "new", repo: "search/private" })).toBe("string")
    await controller.search("search.flows", "flows", { query: "workspace" })
    const before = await store.eventHistory()
    reply.resolve(json(200, { setup_script: "", env: [], secrets: [] }))
    await pending
    expect(store.collections.cards.has("search-search.secrets")).toBe(false)
    expect(store.collections.cards.has("search-search.flows")).toBe(true)
    expect((await store.eventHistory()).head).toEqual(before.head)
  } finally { reply.resolve(json(404, {})); await controller.dispose(); await store.dispose?.() }
})

for (const actors of [["user", "smithers"], ["smithers", "user"], ["smithers", "smithers"]] as const) {
  test(`${actors.join(" then ")} searches retain independent answers and the human card`, async () => {
    const { createSearchSeam } = await import("./SearchSeam")
    const { createActorBindings } = await import("../ActorBindings")
    const { store, controller } = await ready(backend({}), "signed-in")
    const reply = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>()
    const payload = { setup_script: "", env: [], secrets: [{ name: "PRIVATE_TOKEN", hosts: [], match_headers: [], updated_at: null }] }
    let reads = 0
    const bindings = createActorBindings(() => {})
    const seam = bindings.pair({ store, baseUrl: "", actor: () => "user" as const, dispatch: store.dispatch, nextOrdinal: store.nextOrdinal,
      http: async () => { if (++reads === 1) { entered.resolve(); return reply.promise }; return json(200, payload) }
    }, ctx => createSearchSeam(ctx, { registry: () => controller.commands }))
    const search = (actor: "user" | "smithers", query: string) => (actor === "user" ? seam.search : bindings.select(seam.search))("search.secrets", "secrets", { query, repo: "search/private" })
    try {
      const old = search(actors[0], "private")
      await entered.promise
      const newer = await search(actors[1], "token")
      reply.resolve(json(200, payload))
      const older = await old
      for (const result of [older, newer]) expect(JSON.stringify(result)).toContain("PRIVATE_TOKEN")
      const card = store.collections.cards.get("search-search.secrets")
      if (actors[0] === "smithers" && actors[1] === "smithers") expect(card).toBeUndefined()
      else {
        expect(card?.kind).toBe("search-results")
        if (card?.kind === "search-results") expect(card.payload.query).toBe(actors[0] === "user" ? "private" : "token")
      }
    } finally { reply.resolve(json(404, {})); await controller.dispose(); await store.dispose?.() }
  })
}

test("searching another mode does not retire a pending results card", async () => {
  const reply = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>()
  const { store, controller } = await ready({ fetchImpl: async input => {
    if (!String(input).endsWith("/api/repos/search/private/agent-environment")) return json(404, {})
    entered.resolve(); return reply.promise
  } }, "signed-in")
  try {
    const pending = controller.search("search.secrets", "secrets", { query: "token", repo: "search/private" })
    await entered.promise
    await controller.search("search.flows", "flows", { query: "workspace" })
    reply.resolve(json(200, { setup_script: "", env: [], secrets: [] }))
    await pending
    expect(store.collections.cards.has("search-search.secrets")).toBe(true)
    expect(store.collections.cards.has("search-search.flows")).toBe(true)
  } finally { reply.resolve(json(404, {})); await controller.dispose(); await store.dispose?.() }
})
