import { describe, expect, test } from "bun:test"

import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { addWorldNote, memoryStorage, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The vault kit's three flows (Librarian L5) through the one run path, each
 * by both actors. Opening notes, backlinks and graphs embeds the same card
 * without replacing the conversation or composer. Selection and view state
 * are durable card payload, changed through the shared dispatcher.
 * A path no note answers refuses with the note's name in the reason, from
 * every door.
 */


const setup = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, {
    fetchImpl: async () => new Response("{}", { status: 200 })
  })
  await addWorldNote(store)
  await store.dispatch({
    type: "world.document.upserted",
    actor: "user",
    select: false,
    document: {
      id: "plans",
      path: "Plans.md",
      title: "Plans",
      body: "# Plans\n\nSee [[World]] and [[Ghost]].\n\n## Next\n\nShip.",
      links: ["World", "Ghost"],
      tags: [],
      sources: [],
      confidence: 0.8
    }
  }).isPersisted.promise
  return { store, controller }
}

describe("wiki.open", () => {
  test("the user's act embeds the selected note and keeps the composer surface", async () => {
    const { store, controller } = await setup()
    expect(store.session().surface).toBe("chat")
    expect((await controller.commands.run("wiki.open", "plans")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.get("wiki-open-plans")).toMatchObject({ kind: "world", payload: { selectedDocumentId: "plans" } })
    controller.dispose()
  })

  test("the agent's act embeds the one note as a world card, leaves the surface alone, and reads the note's links back", async () => {
    const { store, controller } = await setup()
    // The model answers "what links to Plans?" from the tool result beside the card, never from a bare "executed".
    expect(await controller.commands.runForAgent("wiki.open", "Plans.md")).toEqual({
      status: "executed",
      value: "Embedded Plans.md. Backlinks: none. Links out: World. Unresolved: Ghost."
    })
    expect(await controller.commands.runForAgent("wiki.open", "World")).toEqual({
      status: "executed",
      value: "Embedded World.md. Backlinks: Plans. Links out: none. Unresolved: none."
    })
    expect(store.session().surface).toBe("chat")
    const card = store.collections.cards.get("wiki-open-plans")
    expect(card?.kind).toBe("world")
    expect(card?.kind === "world" ? card.payload.documents.map((row) => row.path) : []).toEqual(["Plans.md"])
    controller.dispose()
  })

  test("a path no note answers refuses with the reason, from either door", async () => {
    const { store, controller } = await setup()
    const user = await controller.commands.run("wiki.open", "Nowhere.md")
    expect(user.status).toBe("failed")
    expect(user.status === "failed" ? user.error : "").toContain("There is no Wiki note at Nowhere.md")
    const agent = await controller.commands.runForAgent("wiki.open", "Nowhere.md")
    expect(agent.status).toBe("failed")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.size).toBe(0)
    controller.dispose()
  })
})

describe("wiki.backlinks", () => {
  test("cloud Wiki inputs and Markdown edits use the same schema forms and actor bindings", async () => {
    const { store, controller } = await setup()
    expect(await controller.commands.runForAgent("wiki.cloud")).toMatchObject({ status: "form", fields: ["repo"] })
    expect(await controller.commands.runForAgent("wiki.cloud.open", "architecture")).toMatchObject({ status: "form", fields: ["repo"] })
    expect(await controller.commands.runForAgent("wiki.edit", "plans")).toMatchObject({ status: "form", fields: ["body"] })
    const body = "# Agent plan\n\nUse Effect everywhere."
    expect((await controller.commands.runForAgent("wiki.edit", `plans ${JSON.stringify(body)}`)).status).toBe("executed")
    expect(store.collections.worldDocuments.get("plans")).toMatchObject({ body, updatedBy: "smithers" })
    expect(store.session().surface).toBe("chat")
    controller.dispose()
  })

  test("either actor gets the rail card: who links here, where it links out, and the targets no note answers", async () => {
    const { store, controller } = await setup()
    expect((await controller.commands.run("wiki.backlinks", "World.md")).status).toBe("executed")
    const home = store.collections.cards.get("wiki-links-world-home")
    expect(home?.kind).toBe("wiki-links")
    if (home?.kind !== "wiki-links") throw new Error("no rail card")
    expect(home.payload.backlinks).toEqual([{ path: "Plans.md", title: "Plans" }])
    expect(home.payload.linksOut).toEqual([])
    expect(await controller.commands.runForAgent("wiki.backlinks", "Plans")).toEqual({
      status: "executed",
      value: "Embedded the links of Plans.md. Backlinks: none. Links out: World. Unresolved: Ghost."
    })
    const plans = store.collections.cards.get("wiki-links-plans")
    if (plans?.kind !== "wiki-links") throw new Error("no rail card")
    expect(plans.payload.linksOut).toEqual([{ path: "World.md", title: "World" }])
    expect(plans.payload.unresolved).toEqual(["Ghost"])
    expect(store.session().surface).toBe("chat")
    controller.dispose()
  })

  test("without a path the door renders the form, never a usage sentence", async () => {
    const { controller } = await setup()
    expect(await controller.commands.run("wiki.backlinks")).toMatchObject({ status: "form", flow: "wiki.backlinks", fields: ["path"] })
    controller.dispose()
  })
})

describe("wiki.graph", () => {
  test("both the whole graph and a focused graph embed for the human", async () => {
    const { store, controller } = await setup()
    expect((await controller.commands.run("wiki.graph")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.get("wiki-graph")).toMatchObject({ kind: "wiki-graph", payload: { path: null } })
    expect((await controller.commands.run("wiki.graph", "Plans")).status).toBe("executed")
    expect(store.collections.cards.get("wiki-graph-plans")).toMatchObject({ kind: "wiki-graph", payload: { path: "Plans.md" } })
    controller.dispose()
  })

  test("Wiki card selection and view are actor-tagged, durable and shared between doors", async () => {
    const { store, controller } = await setup()
    await controller.commands.run("wiki")
    expect(store.session().surface).toBe("chat")
    await controller.commands.runForAgent("wiki.card.select", "world-embedded plans")
    await controller.commands.run("wiki.card.view", "world-embedded document")
    expect(store.collections.cards.get("world-embedded")).toMatchObject({ payload: { selectedDocumentId: "plans", view: "document" } })
    expect([...store.collections.transitions.values()].some((row) => row.actor === "smithers" && row.type === "card.updated")).toBe(true)
    controller.dispose()
  })

  test("the agent's act embeds the graph card, whole or around one note, with the dangling target as a missing node, and reads the counts back", async () => {
    const { store, controller } = await setup()
    expect(await controller.commands.runForAgent("wiki.graph")).toEqual({
      status: "executed",
      value: "Embedded the Wiki graph: 2 notes, 2 links, 1 unresolved target (Ghost)."
    })
    expect(store.session().surface).toBe("chat")
    const whole = store.collections.cards.get("wiki-graph")
    if (whole?.kind !== "wiki-graph") throw new Error("no graph card")
    expect(whole.payload.path).toBeNull()
    expect(whole.payload.notes.map((note) => [note.path, note.missing])).toEqual([
      ["Plans.md", false],
      ["World.md", false],
      ["Ghost.md", true]
    ])
    expect(whole.payload.links).toEqual([
      { source: "Plans.md", target: "World.md" },
      { source: "Plans.md", target: "Ghost.md" }
    ])
    expect(await controller.commands.runForAgent("wiki.graph", "World")).toEqual({
      status: "executed",
      value: "Embedded the Wiki graph around World.md: 2 notes, 1 link, 0 unresolved targets."
    })
    const around = store.collections.cards.get("wiki-graph-world-home")
    if (around?.kind !== "wiki-graph") throw new Error("no focused graph card")
    expect(around.payload.path).toBe("World.md")
    expect(around.payload.notes.map((note) => note.path)).toEqual(["Plans.md", "World.md"])
    expect(around.payload.links).toEqual([{ source: "Plans.md", target: "World.md" }])
    const missing = await controller.commands.runForAgent("wiki.graph", "Nowhere")
    expect(missing.status).toBe("failed")
    controller.dispose()
  })
})

describe("wiki.heading", () => {
  test("scrolls the open note's editor to the heading's line through the registered handle, and names what it cannot do", async () => {
    const { store, controller } = await setup()
    const scrolled: number[] = []
    // Nothing is open: the pane is closed.
    const closed = await controller.commands.run("wiki.heading", "5")
    expect(closed).toMatchObject({ status: "failed", error: "No Wiki note is open in the editor." })
    expect((await controller.commands.run("wiki.open", "Plans")).status).toBe("executed")
    // Legacy explicit pane navigation remains supported; wiki.open itself now embeds.
    await store.dispatch({ type: "world.document.selected", actor: "user", id: "plans" }).isPersisted.promise
    await store.dispatch({ type: "surface.changed", actor: "user", surface: "world" }).isPersisted.promise
    const loading = await controller.commands.run("wiki.heading", "5")
    expect(loading).toMatchObject({ status: "failed", error: "The editor for Plans is still loading; try again in a moment." })
    controller.attachWikiEditor({ scrollToLine: (line) => (scrolled.push(line), line <= 7) })
    expect((await controller.commands.run("wiki.heading", "5")).status).toBe("executed")
    expect(scrolled).toEqual([5])
    expect(await controller.commands.run("wiki.heading", "9")).toMatchObject({ status: "failed", error: "Plans.md has no line 9." })
    expect(await controller.commands.run("wiki.heading", "five")).toMatchObject({ status: "failed", error: "five is not a line number." })
    // The explicitly opened legacy graph pane has no editor to scroll.
    await store.dispatch({ type: "wiki.pane.changed", actor: "user", pane: "graph", path: null }).isPersisted.promise
    expect((await controller.commands.run("wiki.heading", "5")).status).toBe("failed")
    // The mount's release: the handle is gone.
    await store.dispatch({ type: "wiki.pane.changed", actor: "user", pane: "document", path: null }).isPersisted.promise
    controller.attachWikiEditor(null)
    expect((await controller.commands.run("wiki.heading", "5")).status).toBe("failed")
    // The handle saw the two in-range calls only; graph mode and the released mount never reached it.
    expect(scrolled).toEqual([5, 9])
    expect(store.session().wikiPane).toBe("document")
    controller.dispose()
  })

  test("the human's alone: the agent's door refuses and names the read it has instead", async () => {
    const { controller } = await setup()
    expect((await controller.commands.run("wiki.open", "Plans")).status).toBe("executed")
    const agent = await controller.commands.runForAgent("wiki.heading", "5")
    expect(agent.status).toBe("failed")
    expect(agent.status === "failed" ? agent.error : "").toContain("wiki.open")
    controller.dispose()
  })
})


test("embedded Wiki headings wait for their own editor and persist Document view", async () => {
  const { store, controller } = await setup()
  await controller.commands.run("wiki.open", "plans")
  const scrolled: number[] = []
  let ready = false
  controller.attachWorldEditor("plans", "wiki-open-plans:test", {
    getMarkdown: () => store.collections.worldDocuments.get("plans")!.body,
    setMarkdown: () => {},
    scrollToLine: line => { if (!ready) return false; scrolled.push(line); return true }
  })
  setTimeout(() => { ready = true }, 40)
  expect((await controller.commands.run("wiki.heading", "5 wiki-open-plans")).status).toBe("executed")
  expect(scrolled).toEqual([5])
  expect(store.collections.cards.get("wiki-open-plans")).toMatchObject({ payload: { view: "document" } })
  expect(store.session().surface).toBe("chat")
  expect((await controller.commands.run("wiki.heading", "99 wiki-open-plans")).status).toBe("failed")
  expect(scrolled).toEqual([5])
  controller.attachWorldEditor("plans", "wiki-open-plans:test", null)
  controller.dispose()
})
