/*
 * The search seam (Search and Command Palette Spec 2026-09-07 §4, §5, §6)
 * against fixture seams: the palette's rows come from what the store holds,
 * the flow doors answer items as data and embed the search-results card for
 * a human, the signed-out scope hides and defers, and a mode with no index
 * refuses with its reason.
 */
import { CardSchema } from "@smthrs/rpc/Cards"
import type { MythicalStack } from "@smthrs/rpc/Mythical"
import type { StorageApi } from "@tanstack/db"
import { describe,expect,test } from "bun:test"
import { runSearchRef } from "@smthrs/ui/run-command"

import type { AgentPort } from "../../runtime/AgentPort"
import type { AppServices } from "../AppController"
import { createAppController } from "../AppController"
import type { AppStore } from "../AppStore"
import { createAppStore } from "../AppStore"
import { ASK_PROPOSED,NO_FOCUSED_FILE } from "./SearchSeam"
import { addWorldNote } from "../TestFixtures"

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
const card = (store: AppStore, value: { readonly id: string; readonly kind: string; readonly title: string; readonly payload: unknown }): void => {
  ordinal += 1
  store.dispatch({ type: "card.upsert", actor: "system", card: CardSchema.parse({ ...value, status: "active", createdAt: ordinal, ordinal }) })
}

/** The fixture seams: what each seam had already written to the store. */
const seed = async (store: AppStore): Promise<void> => {
  card(store, {
    id: "files-x",
    kind: "file-list",
    title: "files",
    payload: {
      repo: REPO,
      path: "packages/journal",
      entries: [{ name: "Redaction.ts", kind: "file" }, { name: "Redaction.test.ts", kind: "file" }, { name: "src", kind: "dir" }]
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
    payload: { repo: REPO, scope: "repository", secrets: [{ name: "NPM_TOKEN", mainOnly: false, hosts: ["registry.npmjs.org"], matchHeaders: [], updatedAt: null }] }
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
  test("a bare query groups files, runs, issues and changes by kind, files first for a file name", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const answer = controller.searchPalette("redact")
    expect(answer.parsed.mode).toBe("all")
    expect(answer.refusal).toBeUndefined()
    expect(answer.groups.map((group) => group.label)).toEqual(["Files", "Changes", "Issues"])
    expect(refs(answer.groups, "Files")).toEqual(["/will/flows/packages/journal/Redaction.ts", "/will/flows/packages/journal/Redaction.test.ts"])
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
    expect(refs(answer.groups, "Files")[0]).toBe("/will/flows/packages/journal/Redaction.test.ts")
  })

  test("run: with status: filters", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const running = controller.searchPalette("run: status:running")
    expect(running.groups.flatMap((group) => group.items.map((row) => row.item.ref))).toEqual([runSearchRef("run-9", "runs-x")])
    expect(controller.searchPalette("#412").groups.flatMap((group) => group.items.map((row) => row.item.title))).toEqual(["#412 Harden redaction on the journal path"])
  })

  test("wiki: lists the Wiki pane's notes; / hands over to the slash tree; ? lists every prefix", async () => {
    const { store, controller } = await ready()
    await addWorldNote(store)
    const wiki = controller.searchPalette("wiki:")
    expect(wiki.groups.map((group) => group.label)).toEqual(["Notes"])
    expect(wiki.groups[0]?.items[0]?.item.actions[0]).toMatchObject({ flow: "wiki.select", role: "open" })
    expect(controller.searchPalette("/app")).toMatchObject({ groups: [], flow: "search.flows" })
    const help = controller.searchPalette("?")
    expect(help.help?.map((row) => row.label)).toContain("secret:")
    expect(help.help?.map(row => row.label)).not.toContain("box:")
    expect(help.help?.map(row => row.label)).not.toContain("//")
  })

  test("an empty query is the pills and the recents, nothing more; a recent item leads on the next query", async () => {
    const { store, controller } = await ready()
    await seed(store)
    expect(controller.searchPalette("").groups.map((group) => group.label)).toEqual(["Recommended"])
    controller.notePaletteItemOpened({ kind: "file", ref: "/will/flows/packages/journal/Redaction.test.ts" })
    await settled()
    expect(controller.searchPalette("").groups.map((group) => group.label)).toEqual(["Recommended", "Recent"])
    expect(refs(controller.searchPalette("redact").groups, "Files")[0]).toBe("/will/flows/packages/journal/Redaction.test.ts")
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
  test("secret: is hidden signed out and a bare query never leaks secret names", async () => {
    const { store, controller } = await ready()
    await seed(store)
    expect(controller.searchPalette("secret:NPM")).toMatchObject({ groups: [] })
    expect(refs(controller.searchPalette("NPM").groups, "Secrets")).toEqual([])
  })

  test("signed out, the flows a bare query lists are only the ones that work signed out", async () => {
    const { controller } = await ready()
    // Signed out, sign-in is the exclusive recommendation, so it leads in Recommended rather than Flows.
    const answer = controller.searchPalette("sign")
    const names = answer.groups.flatMap((group) => group.items.map((row) => row.item.ref))
    expect(answer.groups[0]?.label).toBe("Recommended")
    expect(names).toContain("sign-in")
    expect(names).not.toContain("sign-out")
  })

  test("Enter on a signed-in-only search defers through sign-in: the flow parks on the requirement", async () => {
    const { store, controller } = await ready()
    // The outcome is the fulfilling flow's (sign-in ran in its place); the search itself parks on the session row.
    await controller.commands.run("search.secrets", "main")
    expect(store.session().pendingCommand).toMatchObject({ name: "search.secrets", args: "main", requirement: "signed-in" })
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
    expect(value.items.map((item) => item.ref)).toEqual(["/will/flows/packages/journal/Redaction.ts", "/will/flows/packages/journal/Redaction.test.ts"])
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

  test("search without a query answers the pills and recents; --kinds narrows", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const all = await controller.commands.run("search", "redact")
    expect(all.status).toBe("executed")
    const narrowed = await controller.commands.run("search", "redact --kinds issue")
    expect(narrowed.status).toBe("executed")
    if (narrowed.status !== "executed") return
    const value = JSON.parse(narrowed.value ?? "{}") as { items: Array<{ kind: string }> }
    expect(value.items.map((item) => item.kind)).toEqual(["issue"])
    expect(resultsCard(store, "search").payload.items.map((item) => item.kind)).toEqual(["issue"])
  })

  test("search.runs, search.changes and search.issues read their seams' rows", async () => {
    const { store, controller } = await ready()
    await seed(store)
    await controller.commands.run("search.runs", "run status:completed")
    expect(resultsCard(store, "search.runs").payload.items.map((item) => item.ref)).toEqual([runSearchRef("run-7", "runs-x")])
    await controller.commands.run("search.changes", "journal")
    expect(resultsCard(store, "search.changes").payload.items[0]).toMatchObject({ kind: "change", ref: "c1", title: "Redact the journal" })
    await controller.commands.run("search.issues", "bug is:closed")
    expect(resultsCard(store, "search.issues").payload.items.map((item) => item.ref)).toEqual(["7"])
    const labeled = await controller.commands.run("search.issues", "bug label:bug")
    expect(labeled).toMatchObject({ status: "failed", error: expect.stringContaining("no labels") })
  })

  test("search.secrets signed in reads the CI secrets list and lists names only", async () => {
    const { store, controller } = await ready(
      backend({
        "/api/repos/will/flows/secrets": json(200, [{ name: "NPM_TOKEN", hosts: ["registry.npmjs.org"], match_headers: ["authorization"], updated_at: null }])
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

  test("unindexed search flows are absent from the real registry", async () => {
    const { controller } = await ready(backend({}), "signed-in")
    for (const name of ["search.symbols", "search.text", "search.people", "search.targets", "search.boxes"]) {
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


test("saved local file cards cannot advertise a retired file route", async () => {
  const {store,controller}=await ready()
  try {
    card(store,{id:"local-a-file",kind:"file",title:"File",payload:{repo:"alpha/a",localRepoId:"a",path:"README notes.md",content:"A",truncated:false}})
    await settled()
    const items=controller.searchPalette("README").groups.flatMap(group=>group.items.map(row=>row.item)).filter(item=>item.kind==="file")
    expect(items).toEqual([])
    expect(controller.searchPalette(":120").groups).toEqual([])
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
      expect.objectContaining({flow:"box.file",args:"README.md ws-a",role:"open"}),
      expect.objectContaining({flow:"box.file",args:"README.md ws-b",role:"open"})
    ])
  } finally {await controller.dispose?.();await store.dispose?.()}
})

for (const mode of ["secrets"] as const) {
  test(`a retired account's ${mode} search cannot return or persist its private results`, async () => {
    const reply = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>()
    const suffix = "/secrets"
    const { store, controller } = await ready({ fetchImpl: async input => {
      if (String(input).endsWith(`/api/repos/search/private${suffix}`)) { entered.resolve(); return reply.promise }
      return json(404, {})
    } }, "signed-in")
    try {
      const pending = controller.search(`search.${mode}`, mode, { query: "private", repo: "search/private" })
      await entered.promise
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "second", admin: false, scopesPlain: null }).isPersisted.promise
      const payload = [{ name: "PRIVATE_TOKEN", hosts: ["private.example.test"], match_headers: [], updated_at: null }]
      reply.resolve(json(200, payload))
      const result = await pending
      expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN")
      expect(store.collections.cards.get(`search-search.${mode}`)).toBeUndefined()
    } finally { reply.resolve(json(404, {})); await controller.dispose(); await store.dispose?.() }
  })
}

for (const mode of ["secrets", "history"] as const) {
  for (const actor of ["user", "smithers"] as const) {
    test.each(["account", "provider", "sign-out-return", "cloud", "dispose", "refresh"] as Array<"account" | "provider" | "sign-out-return" | "cloud" | "dispose" | "refresh">)(`${actor} ${mode} search keeps its owner through %s`, async change => {
      const { createSearchSeam } = await import("./SearchSeam")
      const { SIGN_OUT_REFUSAL } = await import("./CloudSignIn")
      // These explicit-repository searches need no ambient repository whose
      // homepage would independently refresh on account changes.
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      const controller = createAppController(store, unavailableAgent, backend({}))
      const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
      let disposed = false, reads = 0
      const privateHistory: MythicalStack = { repository: "search/private", state: "active", generation: 1, mainBehind: false, items: [], lanes: [],
        limits: { maxParallel: 1 }, changes: [{ changeId: "private-change", commitId: "c1", title: "Private commit", kind: "item", state: "landed" }] }
      const answer = () => mode === "secrets"
        ? [{ name: "PRIVATE_TOKEN", hosts: ["private.example.test"], match_headers: [], updated_at: null }]
        : {}
      const wait = async () => { reads++; entered.resolve(); await gate.promise }
      try {
        await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
        await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
        const seam = createSearchSeam({ store, baseUrl: "", dispatch: store.dispatch, actor: () => actor, nextOrdinal: store.nextOrdinal, isDisposed: () => disposed,
          http: async () => {
            await wait(); return json(200, answer())
          }
        }, { registry: () => controller.commands,
          readStack: async () => { await wait(); return privateHistory } })
        const pending = seam.search(`search.${mode}`, mode, { query: "private", repo: "search/private" })
        await entered.promise
        const loaded = (login: string | null, provider: "github" | "local" = "github") => store.dispatch({ type: "identity.session.loaded", actor: "system",
          state: login === null ? "signed-out" : "signed-in", login, provider, admin: false, scopesPlain: null }).isPersisted.promise
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
          expect(JSON.stringify(result).toLowerCase()).toContain(mode === "secrets" ? "private_token" : "private commit")
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

for (const mode of ["secrets"] as const) {
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
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "second", admin: false, scopesPlain: null }).isPersisted.promise
      reply.resolve(json(503, { message: "Private account failure" }))
      expect(await pending).toBe(SIGN_OUT_REFUSAL)
      expect(store.collections.cards.has(`search-search.${mode}`)).toBe(false)
    } finally { reply.resolve(json(404, {})); await controller.dispose(); await store.dispose?.() }
  })
}

test("retirement between search stages publishes nothing, and disposal starts no read", async () => {
  const { createSearchSeam } = await import("./SearchSeam")
  const { SIGN_OUT_REFUSAL } = await import("./CloudSignIn")
  const { store, controller } = await ready(backend({}), "signed-in")
  let reads = 0, disposed = false
  const seam = createSearchSeam({ store, baseUrl: "", actor: () => "user", dispatch: store.dispatch, nextOrdinal: store.nextOrdinal,
    isDisposed: () => disposed, http: async () => { reads++; return json(404, {}) }
  }, { registry: () => controller.commands })
  try {
    const pending = seam.search("search.flows", "flows", { query: "private", repo: "search/private" })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "second", admin: false, scopesPlain: null }).isPersisted.promise
    expect(await pending).toBe(SIGN_OUT_REFUSAL)
    disposed = true
    expect(await seam.search("search.secrets", "secrets", { query: "private", repo: "search/private" })).toBe(SIGN_OUT_REFUSAL)
    expect(reads).toBe(0)
  } finally { await controller.dispose(); await store.dispose?.() }
})

for (const mode of ["secrets"] as const) {
  test(`a slow ${mode} query cannot replace a newer search card`, async () => {
    const reply = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>()
    let reads = 0
    const payload = [{ name: "PRIVATE_TOKEN", hosts: ["private.example.test"], match_headers: [], updated_at: null }]
    const { store, controller } = await ready({ fetchImpl: async input => {
      if (!String(input).includes("/api/repos/search/private/")) return json(404, {})
      if (++reads === 1) { entered.resolve(); return reply.promise }
      return json(200, payload)
    } }, "signed-in")
    try {
      const old = controller.search(`search.${mode}`, mode, { query: "private", repo: "search/private" })
      await entered.promise
      const query = "token"
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
      if (!String(input).endsWith("/api/repos/search/private/secrets")) return json(404, {})
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
        gates[index]!.resolve(json(200, []))
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
    if (!String(input).endsWith("/api/repos/search/private/secrets")) return json(404, {})
    if (++reads === 1) { entered.resolve(); return reply.promise }
    return json(503, { message: "Unavailable" })
  } }, "signed-in")
  try {
    const pending = controller.search("search.secrets", "secrets", { query: "old", repo: "search/private" })
    await entered.promise
    expect(typeof await controller.search("search.secrets", "secrets", { query: "new", repo: "search/private" })).toBe("string")
    await controller.search("search.flows", "flows", { query: "workspace" })
    const before = await store.eventHistory()
    reply.resolve(json(200, []))
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
    const payload = [{ name: "PRIVATE_TOKEN", hosts: [], match_headers: [], updated_at: null }]
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
    if (!String(input).endsWith("/api/repos/search/private/secrets")) return json(404, {})
    entered.resolve(); return reply.promise
  } }, "signed-in")
  try {
    const pending = controller.search("search.secrets", "secrets", { query: "token", repo: "search/private" })
    await entered.promise
    await controller.search("search.flows", "flows", { query: "workspace" })
    reply.resolve(json(200, []))
    await pending
    expect(store.collections.cards.has("search-search.secrets")).toBe(true)
    expect(store.collections.cards.has("search-search.flows")).toBe(true)
  } finally { reply.resolve(json(404, {})); await controller.dispose(); await store.dispose?.() }
})

test("bare search excludes Cut targets and boxes while retaining files, issues and Wiki notes", async () => {
  const { store, controller } = await ready(backend({}), "signed-in")
  try {
    card(store, { id: "cut-files", kind: "file-list", title: "Files", payload: { repo: REPO, path: "", entries: [{ name: "cut-match.ts", kind: "file" }] } })
    card(store, { id: "cut-issues", kind: "issue-list", title: "Issues", payload: { repo: REPO, filter: "all", issues: [{ number: 31, title: "cut-match issue", state: "open", author: null, comments: 0, updatedAt: null }] } })
    card(store, { id: "cut-targets", kind: "targets", title: "Targets", payload: { repoId: "r1", repoName: "flows", status: "done", warnings: [], targets: [{ id: "cut-target", label: "//cut-match:test", target: "Shell.Test", kinds: ["test"], package: "//cut-match", name: "test", workspace: "." }] } })
    await store.dispatch({ type: "world.document.upserted", actor: "user", document: { id: "cut-note", path: "cut-match.md", title: "cut-match note", body: "# cut-match note", links: [], tags: [], sources: [], confidence: 1 } }).isPersisted.promise
    await store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: REPO, workspaces: [{ id: "0b0c0d0e-0000-4000-8000-00000000000a", repoId: REPO, name: "cut-match box", targetBookmark: "main", status: "running", provisioningStage: null, suspendedAt: null, createdAt: null }] }).isPersisted.promise
    const palette = controller.searchPalette("cut-match")
    expect(palette.groups.map(group => group.label)).toEqual(expect.arrayContaining(["Files", "Issues", "Notes"]))
    expect(palette.groups.flatMap(group => group.items.map(row => row.item.kind)).filter(kind => kind === "target" || kind === "box")).toEqual([])
    expect(await controller.commands.run("search", "cut-match")).toMatchObject({ status: "executed" })
    const items = resultsCard(store, "search").payload.items
    expect(items.map(item => item.kind)).toEqual(expect.arrayContaining(["file", "issue", "note"]))
    expect(items.filter(item => item.kind === "target" || item.kind === "box")).toEqual([])
  } finally { await controller.dispose(); await store.dispose?.() }
})
