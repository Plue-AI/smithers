import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CardView } from "../ChatCards"
import { ControllerTestProvider } from "../ControllerContext"
import { cardActions } from "../cards/CardActions"
import { agentVisibleCatalog } from "../flows/agentTools"
import { namespace as searchNamespace } from "../flows/entries/search"
import { recommendedNames } from "../flows/registry"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { smithersInstructions } from "./Instructions"
import { knowledgeCardAvailable } from "./KnowledgeFeatures"
import { parseRecommendation } from "./Recommend"
import { json, memoryStorage, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()
/* The Wiki (D-09b) and the mythical history (D-09 superseded) are core: no flag and no build variable hides them. */
const wiki = ["wiki", "wiki.create", "wiki.open", "wiki.graph", "world", "world.new-note", "search.wiki"]
const core = ["history.show", "history.bootstrap", "history.backfill", "history.parallel", "history.retry", "search.history"]

describe("the Wiki is core", () => {
  test("every Wiki door registers with no feature and no environment flag", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent)
    expect(Object.keys(controller.features)).not.toContain("wiki")
    for (const name of core) expect(controller.commands.find(name)).toBeDefined()
    const callable = controller.commands.callable().map(entry => entry.binding.descriptor.name)
    for (const name of wiki) expect(controller.commands.find(name)).toBeDefined()
    for (const name of ["wiki", "wiki.open", "search.wiki"]) expect(callable).toContain(name)
    expect(recommendedNames(controller.commands.state())).toContain("wiki")
    expect(controller.searchPalette("wiki:").flow).toBe("search.wiki")
    expect(controller.searchPalette("?").help?.map(row => row.prefix)).toContain("wiki:")
    expect((await controller.commands.run("wiki")).status).toBe("executed")
    expect(store.collections.cards.get("world-embedded")?.kind).toBe("world")
  })

  test("runtime Wiki flows reach the identity guard, and Wiki refresh asks the stack, never a workspace flow", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const calls: string[] = []
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async input => { calls.push(String(input)); return new Response("{}") }
    })
    for (const name of ["wiki", "checks/wiki"]) {
      expect(await controller.runWorkflow(name, "owner/repo")).toBe("Sign in with GitHub first: flows run on your own workspace.")
    }
    // Creating the mythical history and refreshing the Wiki ask the server for its stack (#1760).
    expect(await controller.bootstrapStack("owner/repo")).toBe("Sign in to see the history.")
    expect(await controller.refreshWiki("owner/repo")).toBe("Sign in to see the history.")
    expect(calls).toEqual([])
  })

  test("a restored Wiki card and surface open as they were", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const card = { id: "old-wiki", kind: "world" as const, title: "Wiki", status: "active" as const, createdAt: 1, ordinal: 1,
      payload: { documents: [] } }
    await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    await store.dispatch({ type: "surface.changed", actor: "user", surface: "world" }).isPersisted.promise
    await store.dispatch({ type: "card.maximized", actor: "user", id: card.id }).isPersisted.promise
    const controller = createAppController(store, silentAgent)
    expect(store.session().surface).toBe("world")
    expect(store.session().maximizedCardId).toBe(card.id)
    expect(knowledgeCardAvailable("world")).toBe(true)
    expect((await controller.commands.run("tab.card", card.id)).status).toBe("executed")
  })

  test("a journal holding a retired Librarian launch replays without changing the session", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const before = store.session()
    const launches = [{ kind: "history", repo: "owner/repo", scope: "old", phase: "started", startedAt: 1, runId: "run-1" }]
    await store.dispatch({ type: "librarian.launches.changed", actor: "system", launches }).isPersisted.promise
    createAppController(store, silentAgent)
    expect("librarianLaunches" in store.session()).toBe(false)
    expect(store.session().activeRepoKey).toBe(before.activeRepoKey)
  })
})

/*
 * .smithers/factory.json declares flows whose ids are `wiki` and `checks/wiki`
 * (both model-invocable); the built-in `wiki` surface flow keeps its name.
 */
const FACTORY_ROWS = [
  { id: "wiki", description: "Review each engineering wiki page against its code", summary: null, featured: true, model: null, modelInvocable: true },
  { id: "checks/wiki", description: "Check the wiki pages", summary: null, featured: false, model: null, modelInvocable: true },
  { id: "review", description: "Review a change", summary: null, featured: true, model: null, modelInvocable: true }
]

const repositoryDeclaringWikiFlows = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "repository.upserted", actor: "system",
    repository: { id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: null, catalog: true }
  }).isPersisted.promise
  await store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: "smithersai/smithers", flows: FACTORY_ROWS }).isPersisted.promise
  return store
}

const suggestedFlows = (controller: ReturnType<typeof createAppController>, commands: ReadonlyArray<string>) =>
  parseRecommendation({ id: "reco", commands }, controller.commands.all(), "chat")?.suggestions.map(row => row.flow) ?? []

describe("a repository that declares a knowledge flow", () => {
  test("keeps every door", async () => {
    const store = await repositoryDeclaringWikiFlows()
    const controller = createAppController(store, silentAgent)
    for (const name of ["wiki", "checks.wiki", "review"]) expect(controller.commands.find(name)).toBeDefined()
    // The declared `wiki` surface flow still takes the name from the leaf: one entry, not two.
    expect(controller.commands.all().filter(item => item.name === "wiki")).toHaveLength(1)
    expect(controller.commands.callable().map(entry => entry.binding.descriptor.name)).toContain("checks.wiki")
    expect(suggestedFlows(controller, ["checks.wiki", "review"])).toEqual(["checks.wiki", "review"])
  })
})

describe("the Plugin Library flag", () => {
  const libraryCard = { id: "old-library", kind: "plugin-library" as const, title: "Library", status: "active" as const,
    createdAt: 1, ordinal: 1, payload: { tutorial: false } }

  test("a restored Library card is reset, refused and dropped from the agent's context like a Wiki card", async () => {
    expect(knowledgeCardAvailable("plugin-library")).toBe(false)
    expect(knowledgeCardAvailable("plugin-library", { pluginLibrary: true })).toBe(true)
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "card.upsert", actor: "system", card: libraryCard }).isPersisted.promise
    await store.dispatch({ type: "card.maximized", actor: "user", id: libraryCard.id }).isPersisted.promise
    const controller = createAppController(store, silentAgent)
    expect(store.session().maximizedCardId).toBeNull()
    expect(store.collections.cards.has(libraryCard.id)).toBe(true)
    expect((await controller.commands.run("card.maximize", libraryCard.id)).status).toBe("failed")
    expect((await controller.commands.run("tab.card", libraryCard.id)).status).toBe("failed")
    expect(renderToStaticMarkup(createElement(CardView, { card: libraryCard, maximized: false, worldDocuments: [], ...cardActions(controller) }))).toBe("")
  })

  test("the Library card opens as it does today when the flag is on", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "card.upsert", actor: "system", card: libraryCard }).isPersisted.promise
    await store.dispatch({ type: "card.maximized", actor: "user", id: libraryCard.id }).isPersisted.promise
    const controller = createAppController(store, silentAgent, { features: { pluginLibrary: true } })
    expect(store.session().maximizedCardId).toBe(libraryCard.id)
    expect((await controller.commands.run("tab.card", libraryCard.id)).status).toBe("executed")
    expect(renderToStaticMarkup(createElement(ControllerTestProvider, {
      controller,
      children: createElement(CardView, { card: libraryCard, maximized: false, worldDocuments: [], ...cardActions(controller) })
    }))).not.toBe("")
  })
})

describe("the copy the slash menu and the prompt carry", () => {
  test("the search summary names only what it searches", async () => {
    expect(searchNamespace.summary).not.toMatch(/wiki|history/i)
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent)
    const open = controller.commands.all().find(item => item.name === "search.open")
    expect(open?.summary).toBeDefined()
    expect(open?.summary).not.toMatch(/wiki|history/i)
  })
})

/* `/chat.clear --summarize`: the archive is always local, the summary writes Wiki notes. */
const SWEEP_NOTE = { title: "Prefers dark mode", body: "The user keeps the app in dark mode.", confidence: 0.9 }
const sweepStream = () =>
  new Response(
    [{ type: "delta", kind: "text", text: JSON.stringify({ notes: [SWEEP_NOTE] }) }, { type: "done", reason: "stop" }]
      .map((frame) => JSON.stringify(frame)).join("\n") + "\n",
    { status: 200, headers: { "content-type": "application/x-ndjson" } }
  )

const readyToArchive = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const sweeps: string[] = []
  const controller = createAppController(store, silentAgent, {
    fetchImpl: async (input) => {
      const path = new URL(String(input), "https://app.test").pathname
      if (path !== "/api/model/stream") return json(404, { status: "error" })
      sweeps.push(path)
      return sweepStream()
    }
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "message.appended", actor: "user", text: "remember that I prefer dark mode" }).isPersisted.promise
  return { store, controller, sweeps }
}

const clearEntry = (controller: ReturnType<typeof createAppController>) =>
  controller.commands.all().find((item) => item.name === "chat.clear")

describe("the optional Wiki summary on chat.clear", () => {
  test("every door offers the option, and it writes the note", async () => {
    const { store, controller, sweeps } = await readyToArchive()
    expect(clearEntry(controller)?.summary).toBe("Archive this conversation and start fresh; optionally summarize into Wiki notes")
    expect(clearEntry(controller)?.args).toBe("[--summarize]")
    const catalog = agentVisibleCatalog(controller.commands.callable())
    expect(JSON.stringify(catalog.find((row) => row.name === "chat.clear"))).toMatch(/summarize/i)
    const prompt = smithersInstructions(catalog, {
      host: "web", github: { connected: false, login: null, repositories: null },
      localRepositories: [], localRepositoriesAvailable: false
    }, [], { budgetBytes: 1_000_000 })
    expect(prompt).toContain("--summarize")

    const outcome = await controller.commands.run("chat.clear", "--summarize")
    expect(outcome.status).toBe("executed")
    expect(sweeps).toEqual(["/api/model/stream"])
    expect([...store.collections.worldDocuments.values()].filter((row) => row.sources.includes("chat-sweep")).map((row) => row.title))
      .toEqual([SWEEP_NOTE.title])
  })
})
