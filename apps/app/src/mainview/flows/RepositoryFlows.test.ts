/*
 * The repository's own flows as slash leaves (Factory design session
 * 2026-09-07 §4; owner rule: flows are slash commands, and the featured ones
 * are the repository's to declare in .smithers/FACTORY.ts).
 *
 * Live defect this pins: the homepage of smithersai/smithers said "Try
 * first /review" while typing /review answered "There is no /review flow",
 * because the projection's flows were never leaves of the registry. Every
 * expectation below runs the real controller over a stub of the public
 * contents route that serves `.smithers/factory.json`; nothing here names a
 * flow the app declares itself.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, setDefaultTimeout, test } from "bun:test"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppServices } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { executeAgentToolCall } from "./agentTools"
import { visibleItems } from "./Commands"
import { namespaceOf, parseSubmit, SURFACE_FLOWS } from "./registry"
import { readRepositoryHome } from "../state/seams/RepositoryFlowsSeam"
import { loadBox } from "../state/TestFixtures"
import { firstRunGroups, FIRST_RUN_JOBS } from "../cards/FirstRunActions"

setDefaultTimeout(30_000)

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

interface Seen {
  readonly path: string
  readonly method: string
  readonly body: unknown
}

const backend = (routes: Record<string, Response>, seen: Array<Seen> = []): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    seen.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
    const answer = routes[path]
    return answer === undefined ? json(404, { status: "error", message: `no stub for ${path}` }) : answer.clone()
  }
})

const settled = async (ticks = 3): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

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
const projectionPath = (repo: string): string => `/api/repos/${repo}/contents/.smithers/factory.json`
const PROJECTION = projectionPath(REPO)

test("repository homepage read decodes blocks and makes failures visible", async () => {
  const baseUrl = "https://app.test"
  const http = async () => json(200, { kind: "blocks", blocks: [{ type: "markdown", path: "README.md", markdown: "# Hello" }] })
  expect(await readRepositoryHome({ baseUrl, http }, REPO)).toEqual({ kind: "blocks", blocks: [{ type: "markdown", path: "README.md", markdown: "# Hello" }] })
  expect(await readRepositoryHome({ baseUrl, http: async () => json(200, { kind: "blocks", blocks: [{ type: "markdown", path: "../secret", markdown: "x" }] }) }, REPO))
    .toEqual({ kind: "error", message: "Homepage is invalid" })
  // A block kind this build does not know is left out; the rest of the homepage still renders.
  expect(await readRepositoryHome({ baseUrl, http: async () => json(200, { kind: "blocks", blocks: [{ type: "future" }, { type: "stack" }, { type: "text", text: "Hi" }] }) }, REPO))
    .toEqual({ kind: "blocks", blocks: [{ type: "stack" }, { type: "text", text: "Hi" }] })
  expect(await readRepositoryHome({ baseUrl, http: async () => json(404, {}) }, REPO)).toEqual({ kind: "none" })
  expect(await readRepositoryHome({ baseUrl, http: async () => json(503, {}) }, REPO))
    .toEqual({ kind: "error", message: "Homepage unavailable" })
})

/** The mirror's contents document for a committed projection: base64, as the route serves it. */
const projectionDocument = (projection: unknown): Response =>
  json(200, {
    path: ".smithers/factory.json",
    encoding: "base64",
    content: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(projection))))
  })

const row = (
  id: string,
  extra: { summary?: string | null; featured?: boolean; modelInvocable?: boolean; description?: string } = {}
) => ({
  id,
  description: extra.description ?? `Runs ${id}.\nA second line the leaf never shows.`,
  summary: extra.summary === undefined ? `${id} summary.` : extra.summary,
  featured: extra.featured ?? false,
  kind: "mdx",
  path: `flows/${id}/flow.mdx`,
  capabilities: [],
  model: null,
  modelInvocable: extra.modelInvocable ?? true
})

/*
 * The fixture's catalog order is deliberately not featured-first (lint lands
 * after release-notes), one summary is null, one id carries a `/`, one row is
 * not for a model, and one id (`chat`) is a flow the app declares itself.
 */
const CATALOG = {
  summary: "How will/flows develops itself.",
  flows: [
    row("review", { summary: "Review the change.", featured: true }),
    row("release-notes"),
    row("lint", { summary: null, featured: true }),
    row("create-flow/clarify", { modelInvocable: false }),
    row("chat", { summary: "A projection row that collides with the app's own chat flow." })
  ],
  on: []
}

const ready = async (services: AppServices, state: "signed-in" | "signed-out" = "signed-in") => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, services)
  await identity(store, state)
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: REPO, org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await loadBox(store, REPO)
  await settled(6)
  return { store, controller }
}

/*
 * The listed bare leaves that are neither the app's surface switches nor its
 * own tutorial replay door: exactly the repository's.
 */
const APP_BARE_FLOWS: string[] = []
const repositoryLeaves = (controller: Awaited<ReturnType<typeof ready>>["controller"]): Array<string> =>
  visibleItems(controller.commands)
    .map((command) => command.name)
    .filter((name) => namespaceOf(name) === undefined && !SURFACE_FLOWS.includes(name) && !APP_BARE_FLOWS.includes(name))

const treeNames = (rows: ReturnType<Awaited<ReturnType<typeof ready>>["controller"]["slashTree"]>): Array<string> =>
  rows.map((entry) => (entry.kind === "flow" ? entry.flow.name : entry.kind === "namespace" ? `${entry.namespace.id}/` : `note:${entry.text}`))

describe("the repository's flows are slash leaves", () => {
  test("the first-run choices match only the registered featured leaves", async () => {
    const { controller, store } = await ready(backend({ [PROJECTION]: projectionDocument(CATALOG) }))
    try {
      const state = { surface: "chat" as const, typing: false, signedOut: false, hasConnectors: true, admin: false }
      expect(firstRunGroups(controller.commands.all(), state, controller.repositoryFlows()?.flows ?? [])
        .flatMap(group => group.flows.map(flow => flow.name)))
        .toEqual([...FIRST_RUN_JOBS, "review", "lint"])
    } finally {
      await controller.dispose()
      await store.dispose?.()
    }
  })

  test("every projection row is a leaf, featured first, with the projection's summary; a `/` in an id is a namespace dot; a declared name keeps its flow", async () => {
    const { controller } = await ready(backend({ [PROJECTION]: projectionDocument(CATALOG) }))
    expect(repositoryLeaves(controller)).toEqual(["review", "lint", "release-notes"])
    expect(controller.commands.find("review")?.metadata.summary).toBe("Review the change.")
    expect(controller.commands.find("review")?.metadata.workflow).toBe("review")
    // A null summary falls back to the description's first line, never the whole description.
    expect(controller.commands.find("lint")?.metadata.summary).toBe("Runs lint.")
    // `create-flow/clarify` lists under the synthesized create-flow namespace.
    expect(controller.commands.find("create-flow.clarify")).toBeDefined()
    expect(treeNames(controller.slashTree("create-flow."))).toEqual(["create-flow.clarify"])
    // The app's own `chat` flow is untouched by a projection row of the same name.
    expect(controller.commands.find("chat")?.metadata.summary).not.toContain("collides")
    expect(controller.commands.all().filter((command) => command.name === "chat")).toHaveLength(1)
  })

  test("a bare / lists the repository's leaves after the surfaces and before the namespace rows", async () => {
    const { controller } = await ready(backend({ [PROJECTION]: projectionDocument(CATALOG) }))
    const names = treeNames(controller.slashTree(""))
    const firstNamespace = names.findIndex((name) => name.endsWith("/"))
    expect(firstNamespace).toBeGreaterThan(0)
    for (const leaf of ["review", "lint", "release-notes"]) {
      const at = names.indexOf(leaf)
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(firstNamespace)
    }
    expect(names.indexOf("review")).toBeLessThan(names.indexOf("lint"))
    expect(names.indexOf("lint")).toBeLessThan(names.indexOf("release-notes"))
    for (const surface of SURFACE_FLOWS) expect(names.indexOf(surface)).toBeLessThan(names.indexOf("review"))
  })

  test("the collision rule: bare /review runs the repository flow and /review. opens the review namespace, with one note saying so", async () => {
    const { controller } = await ready(backend({ [PROJECTION]: projectionDocument(CATALOG) }))
    const bare = controller.slashTree("review")
    expect(bare[0]).toEqual({
      kind: "note",
      text: "Enter runs /review, this repository's flow. Type /review. to open the review flows instead."
    })
    expect(bare[1]).toMatchObject({ kind: "flow", flow: { name: "review" } })
    expect(bare.some((entry) => entry.kind === "namespace")).toBe(false)
    expect(parseSubmit("/review", controller.commands.all())).toEqual({ kind: "command", name: "review" })

    const branch = controller.slashTree("review.")
    expect(branch.length).toBeGreaterThan(0)
    expect(branch.every((entry) => entry.kind === "flow" && entry.flow.name.startsWith("review."))).toBe(true)
    // The note is only for the colliding name: a leaf that is no namespace lists plainly.
    expect(controller.slashTree("lint").some((entry) => entry.kind === "note")).toBe(false)
  })

  test("/review dispatches exactly what /flow.run review does: the same doors, the same wire, this repository as the target", async () => {
    const seen: Array<Seen> = []
    const { store, controller } = await ready(backend({ [PROJECTION]: projectionDocument(CATALOG) }, seen))
    const walked = (): Array<Seen> => seen.filter((call) => call.path !== PROJECTION && call.path !== `/api/repos/${REPO}/home` && !(call.method === "GET" && call.path.split("?")[0] === "/api/repository-setup/state"))
    const viaLeaf = await controller.commands.run("review")
    const leafCalls = walked()
    seen.length = 0
    const viaRun = await controller.commands.run("flow.run", `review ${REPO}`)
    const runCalls = walked()
    expect(leafCalls.length).toBeGreaterThan(0)
    expect(leafCalls.map((call) => call.path)).toContain("/api/workflow/provision")
    expect(leafCalls).toEqual(runCalls)
    expect(viaLeaf).toEqual(viaRun)
    // A trailing owner/repo retargets the leaf exactly as flow.run's does.
    seen.length = 0
    await loadBox(store, "will/other", "0b0c0d0e-0000-4000-8000-000000000002")
    await controller.commands.run("review", "will/other")
    const provision = walked().find((call) => call.path === "/api/workflow/provision")
    expect(provision?.body).toMatchObject({ repo: "will/other" })
  })

  test("search.flows and the palette's / mode find the leaf", async () => {
    const { controller } = await ready(backend({ [PROJECTION]: projectionDocument(CATALOG) }))
    const outcome = await controller.commands.run("search.flows", "review")
    expect(outcome.status).toBe("executed")
    if (outcome.status !== "executed") return
    const value = JSON.parse(outcome.value ?? "{}") as { items: Array<{ ref: string; subtitle?: string }> }
    expect(value.items.map((item) => item.ref)).toContain("review")
    expect(value.items.find((item) => item.ref === "review")?.subtitle).toBe("Review the change.")
    expect(controller.searchPalette("/rev")).toMatchObject({ flow: "search.flows" })
    expect(treeNames(controller.slashTree("rev"))).toContain("review")
  })

  test("the leaf is an agent tool door like every listed flow; a row the repository keeps from models is the human's alone", async () => {
    const { controller } = await ready(backend({ [PROJECTION]: projectionDocument(CATALOG) }))
    const disclosed = controller.commands.disclosed().map((descriptor) => descriptor.name)
    expect(disclosed).toContain("review")
    expect(disclosed).toContain("lint")
    expect(disclosed).not.toContain("create-flow.clarify")
    const refused = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "create-flow.clarify" })
    })
    expect(refused).toContain("will/flows declares create-flow/clarify is not for a model to start")
    const listed = await executeAgentToolCall(controller.commands, { name: "commands", arguments: JSON.stringify({ action: "list" }) })
    expect(listed).toContain("review")
  })

  test("signed out, /review renders flow.run's sign-in door, never the no-such-flow refusal", async () => {
    const { store, controller } = await ready(backend({ [PROJECTION]: projectionDocument(CATALOG) }), "signed-out")
    // The leaf is offered when the user names it outright, so Enter on the menu is the deferral, not a review.* flow.
    const listed = treeNames(controller.slashTree("review"))
    expect(listed[1]).toBe("review")
    controller.send("/review")
    await settled()
    expect(store.session().pendingCommand).toMatchObject({ name: "review", requirement: "signed-in" })
    const toasts = [...store.collections.toasts.values()]
    expect(toasts).toEqual([])
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in")).toHaveLength(1)
    const outcome = await controller.commands.run("flow.run", "review")
    expect(outcome.status).not.toBe("unknown-command")
  })

  test("without a projection there are no leaves, and /review is refused with the old wording", async () => {
    const { store, controller } = await ready(backend({}))
    expect(repositoryLeaves(controller)).toEqual([])
    expect((await controller.commands.run("review")).status).toBe("unknown-command")
    controller.send("/review")
    await settled()
    expect([...store.collections.toasts.values()].map((toast) => toast.detail)).toEqual([
      "There is no /review flow. Type / to see everything Smithers can do."
    ])
  })

  test("the leaves follow the target repository: they appear when its projection lands and go with it", async () => {
    const other = "will/other"
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(CATALOG), [projectionPath(other)]: projectionDocument({ flows: [row("triage")], on: [] }) })
    )
    expect(repositoryLeaves(controller)).toEqual(["review", "lint", "release-notes"])
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        { id: REPO, org: "will", ownerKind: "user", name: "flows", head: null },
        { id: other, org: "will", ownerKind: "user", name: "other", head: null }
      ]
    })
    await settled(6)
    // Two repositories and no selection: no target, so no repository leaves at all.
    expect(repositoryLeaves(controller)).toEqual([])
    store.dispatch({ type: "repo.selected", actor: "user", id: other })
    await settled(6)
    expect(repositoryLeaves(controller)).toEqual(["triage"])
    expect(controller.commands.find("review")).toBeUndefined()
    store.dispatch({ type: "repo.selected", actor: "user", id: REPO })
    await settled(6)
    expect(repositoryLeaves(controller)).toEqual(["review", "lint", "release-notes"])
  })


})
