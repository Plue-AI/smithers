import { describe, expect, test } from "bun:test"

import { diskPageFiles } from "../../docs/DiskPages"
import { loadDocs } from "../../docs/Docs"
import { disclosedToAgent, modelInvocable, visible } from "../flows/registry"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The in-app docs (M-35) through the one run path, by both actors. `docs`
 * embeds a page as a read-only Markdown card in the conversation; `docs.read`
 * hands the agent the same page as data, so it answers "how do I" from the
 * source the card renders. The pages are the shipped files, read from disk
 * because Bun has no import.meta.glob (src/docs/bundled.ts).
 */

const DOCS = loadDocs(diskPageFiles())
const first = DOCS.pages[0]!
const last = DOCS.pages.at(-1)!
const slugs = DOCS.pages.map((page) => page.slug).join(", ")

const setup = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, {
    fetchImpl: async () => new Response("{}", { status: 200 }),
    docs: () => DOCS
  })
  return { store, controller }
}

describe("docs", () => {
  test("a bare /docs embeds the toc's first page as a read-only docs card and keeps the conversation", async () => {
    const { store, controller } = await setup()
    expect((await controller.commands.run("docs")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.get(`docs-${first.slug}`)).toMatchObject({
      kind: "docs",
      title: first.title,
      status: "active",
      payload: { page: first.slug, markdown: first.markdown }
    })
  })

  test("/docs <page> embeds that page; the agent's door embeds the same card and reads back what it embedded", async () => {
    const { store, controller } = await setup()
    expect((await controller.commands.run("docs", last.slug)).status).toBe("executed")
    const human = store.collections.cards.get(`docs-${last.slug}`)
    expect(human).toMatchObject({ kind: "docs", title: last.title, payload: { page: last.slug, markdown: last.markdown } })
    expect(await controller.commands.runForAgent("docs", last.slug)).toEqual({
      status: "executed",
      value: `Embedded the ${last.title} docs page.`
    })
    // One card per page: opening it again brings the same card forward rather than stacking a copy.
    expect([...store.collections.cards.values()].filter((card) => card.kind === "docs")).toHaveLength(1)
    expect(store.collections.cards.get(`docs-${last.slug}`)!.ordinal).toBeGreaterThan(human!.ordinal)
    expect(store.session().surface).toBe("chat")
  })

  test("unknown pages embed the fallback without a failure", async () => {
    const { store, controller } = await setup()
    expect((await controller.commands.run("docs", "nowhere")).status).toBe("executed")
    expect(store.collections.cards.get("docs-quickstart")?.payload).toMatchObject({ page: "quickstart", not_found: "nowhere" })
  })

  test("an anchor survives slash and typed button dispatch", async () => {
    const { store, controller } = await setup()
    await controller.runCommandForResult("docs", "#open-the-command-list")
    expect(store.collections.cards.get("docs-quickstart")?.payload).toMatchObject({ anchor: "open-the-command-list" })
    await controller.commands.submit({ name: "docs", payload: { page: "flows#find-a-command" }, actor: "user" })
    expect(store.collections.cards.get("docs-flows")?.payload).toMatchObject({ anchor: "find-a-command" })
  })

  test("the absent catalog hides and refuses every door", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, { docs: () => DOCS, docsCatalogAvailable: () => false })
    expect(visible(controller.commands.all()).map(row => row.name)).not.toContain("docs")
    expect((await controller.runCommandForResult("docs")).status).toBe("failed")
    expect((await controller.commands.runForAgent("docs.read", "quickstart")).status).toBe("failed")
    expect(store.collections.cards.size).toBe(0)
  })

})

describe("docs.read", () => {
  test("the agent reads a page's title, summary and Markdown from the source the card renders, and nothing embeds", async () => {
    const { store, controller } = await setup()
    const read = await controller.commands.runForAgent("docs.read", last.slug)
    expect(read.status).toBe("executed")
    expect(JSON.parse(read.status === "executed" ? read.value ?? "" : "")).toEqual({
      title: last.title,
      summary: last.summary,
      markdown: last.markdown
    })
    expect(store.collections.cards.size).toBe(0)
  })

  test("slash and typed button reads return the same Markdown as the agent", async () => {
    const { store, controller } = await setup()
    const slash = await controller.commands.run("docs.read", first.slug)
    const button = await controller.commands.submit({ name: "docs.read", payload: { page: first.slug }, actor: "user" })
    const agent = await controller.commands.runForAgent("docs.read", first.slug)
    for (const result of [slash, button, agent]) {
      expect(result).toMatchObject({ status: "executed", value: JSON.stringify({ title: first.title, summary: first.summary, markdown: first.markdown }) })
    }
    expect(store.collections.cards.size).toBe(0)
  })

  test("an unknown page is a typed failure listing the valid pages, not a throw", async () => {
    const { controller } = await setup()
    const read = await controller.commands.runForAgent("docs.read", "nowhere")
    expect(read).toEqual({ status: "failed", error: expect.stringContaining(`There is no docs page named nowhere. Pages: ${slugs}.`) })
  })

  test("without a page the door renders the form, never a usage sentence", async () => {
    const { controller } = await setup()
    expect(await controller.commands.run("docs.read")).toMatchObject({ status: "form", flow: "docs.read", fields: ["page"] })
  })
})

describe("the docs doors", () => {
  test("/docs is listed and callable by the agent; docs.read is the agent's read, disclosed to it and kept out of the slash listing", async () => {
    const { controller } = await setup()
    const listed = visible(controller.commands.all()).map((command) => command.name)
    expect(listed).toContain("docs")
    expect(listed).not.toContain("docs.read")
    for (const name of ["docs", "docs.read"]) {
      const entry = controller.commands.entries().find((candidate) => candidate.declaredName === name)!
      expect(entry.metadata).toMatchObject({ visibility: name === "docs" ? "core" : "hidden", minimumRole: "member", agent: "run" })
      expect({ name, invocable: modelInvocable(entry), disclosed: disclosedToAgent(entry.metadata) })
        .toEqual({ name, invocable: true, disclosed: true })
    }
    expect(controller.slashItems("docs")[0]?.flow.name).toBe("docs")
  })
})

test("HTTPS docs target resolves the shipped heading and refuses missing pages", async () => {
  const { controller } = await setup()
  expect(controller.docsTargetAvailable("quickstart#put-https-in-front")).toBe(true)
  expect(controller.docsTargetAvailable("quickstart#missing-heading")).toBe(false)
  expect(controller.docsTargetAvailable("quickstart#open-the-command-list")).toBe(true)
  expect(controller.docsTargetAvailable("missing")).toBe(false)
})


test("the bundled docs are reachable without a test-only availability override", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { docs: () => DOCS })
  expect((await controller.commands.run("docs")).status).toBe("executed")
  expect(store.collections.cards.get("docs-quickstart")).toMatchObject({ kind: "docs", payload: { markdown: expect.stringContaining("## Put HTTPS in front") } })
  expect((await controller.commands.run("docs", "flows")).status).toBe("executed")
  expect(store.collections.cards.get("docs-flows")).toMatchObject({ kind: "docs", payload: { markdown: expect.stringContaining("Flow.make") } })
})
