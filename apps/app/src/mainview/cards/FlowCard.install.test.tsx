import { createRoot, nativeHttp } from "./views/testDom"
import { expect, test } from "bun:test"
import { act } from "react"
import type { FlowCard } from "@smthrs/rpc/FlowCard"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import { memoryStorage, silentAgent, waitFor } from "../state/TestFixtures"
import { fixtures as todoFixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { installFixture } from "../state/seams/InstallFixtures.test-support"
import { renderCardBody } from "./CardRenderers"
import type { CardActions } from "./CardFamily"

const createController = scopedControllers()

test("install /flow mounts the served versions through the production card renderer", async () => {
  // The DOM registry substitutes HTTP globals; use Bun's actual HTTP transport here.
  const domHttp = { fetch, Response, Request, Headers, AbortController, AbortSignal }
  Object.assign(globalThis, nativeHttp)
  const catalog: FlowCard[] = [{ name: "todo", system: false, source: { path: "flows/todo/flow.ts" }, versions: [
    { id: "active", state: "active", steps: [{ id: "build", label: "Build on this install", agent: "builder" }] },
    { id: "proposed", state: "proposed", todo: 42, steps: [
      { id: "build", label: "Build on this install", agent: "builder" }, { id: "docs", label: "Write the changelog" }
    ] },
    { id: "bad", state: "merged-failed", error: "Unknown agent: reviewer", steps: [] }
  ] }]
  const reads: string[] = []
  const writes: unknown[] = []
  let catalogUnavailable = false
  let sourceUnavailable = false
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    reads.push(path)
    if (path === "/api/todos" && request.method === "POST") { writes.push(await request.json()); return Response.json({ state: "accepted", n: 43 }, { status: 202 }) }
    if (path === "/api/todos/42" && sourceUnavailable) return Response.json({ class: "infra", code: "unavailable" }, { status: 503 })
    if (path === "/api/todos/42") return Response.json({ ...todoFixtures.in_review.model, n: 42, branch: { id: "branch-42", name: "flow-edit-42", machine: { state: "awake" } } })
    if (path === "/api/branches/branch-42/files/flows/todo/flow.ts") return Response.json({ branch: "branch-42", path: "flows/todo/flow.ts", language: "typescript", digest: "file-42", content: { kind: "text", text: "export default pinnedComposition\n" }, mode: "read_only", diagnostics: [], authors: [], editors: [] })
    if (path === "/api/flows") return catalogUnavailable ? Response.json({ class: "infra", code: "unavailable" }, { status: 503 }) : Response.json(catalog)
    if (path === "/api/install") return Response.json(installFixture())
    if (path === "/api/user") return Response.json({ id: 1, username: "will", is_admin: false })
    return Response.json({}, { status: 404 })
  } })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  let controller: ReturnType<typeof createController> | undefined
  try {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "user", name: "smithers", head: { bookmark: "main", changeId: "change-1", commitId: "a".repeat(40) } }] }).isPersisted.promise
    const bootstrap: AppBootstrap = { apiVersion: 1, host: "local", version: "test", buildSha: "test",
      capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null }
    controller = createController(store, silentAgent, { bootstrap, baseUrl: server.url.origin, fetchImpl: fetch })
    const outcome = await controller.commands.submit({ name: "flow", payload: { name: "todo" }, actor: "user" })
    expect(outcome).toMatchObject({ status: "executed" })
    const card = [...store.collections.cards.values()].find(card => card.kind === "flow")!
    expect(card?.kind).toBe("flow")
    const actions = { presentation: "embedded" } as CardActions
    await act(async () => root.render(<ControllerTestProvider controller={controller!}>{renderCardBody(card, actions)}</ControllerTestProvider>))
    expect(reads).toContain("/api/flows")
    expect(host.querySelector('.flow-path')?.textContent).toBe("flows/todo/flow.ts")
    expect(host.querySelector('.flow-steps')?.textContent).toContain("Build on this install")
    expect([...host.querySelectorAll('[data-flow]')].map(node => node.textContent)).toEqual(["builder", "Source", "Edit"])
    await act(async () => host.querySelector<HTMLButtonElement>('.flow-version[data-state="proposed"]')!.click())
    expect(host.querySelector('[data-added="true"]')?.textContent).toContain("Write the changelog")
    expect(host.querySelectorAll('[data-added="true"]')).toHaveLength(1)
    expect(store.collections.cards.get(card.id)).toMatchObject({ payload: { memberVersions: { will: "proposed" } } })
    await act(async () => { await controller!.flowCards() })
    expect(host.querySelector('.flow-version[aria-pressed="true"]')?.textContent).toBe("ProposedT42")
    await controller.presentFlow("todo", "TODO flow")
    expect(store.collections.cards.get(card.id)).toMatchObject({ payload: { memberVersions: { will: "proposed" } } })
    await act(async () => host.querySelector<HTMLButtonElement>('.flow-version[data-state="merged-failed"]')!.click())
    expect(host.querySelector('.flow-failure pre')?.textContent).toBe("Unknown agent: reviewer")
    await act(async () => host.querySelector<HTMLButtonElement>('.flow-version[data-state="active"]')!.click())
    expect(host.querySelector('.flow-failure')).toBeNull()
    const versions = catalog[0]!.versions
    catalog[0]!.versions = versions.filter(version => version.state !== "proposed")
    await act(async () => { await controller!.flowCards() })
    expect([...host.querySelectorAll("[data-flow]")].map(node => node.textContent)).toEqual(["builder", "Source", "Edit"])
    expect(await controller.commands.submit({ name: "flow.source", actor: "user", payload: { name: "todo" } })).toMatchObject({ status: "executed" })
    expect(writes).toEqual([])
    const sourceDraft = [...store.collections.cards.values()].find(card => card.kind === "draft")!
    expect(sourceDraft).toMatchObject({ payload: { prompt: "Change flows/todo/flow.ts: Edit the source; start from the built-in composition when no override exists" } })
    await controller.commands.submit({ name: "draft.discard", actor: "user", payload: { draft: sourceDraft.id } })
    catalog[0]!.versions = versions
    await act(async () => { await controller!.flowCards() })
    expect(await controller.commands.submit({ name: "flow.source", actor: "user", payload: { name: "todo" } })).toMatchObject({ status: "executed" })
    await waitFor(() => [...store.collections.cards.values()].some(card => card.kind === "file"))
    expect(reads).toContain("/api/branches/branch-42/files/flows/todo/flow.ts")
    const file = [...store.collections.cards.values()].find(card => card.kind === "file")!
    expect(file).toMatchObject({ payload: { ref: "branch-42", path: "flows/todo/flow.ts", content: "export default pinnedComposition\n" } })
    expect([...store.collections.cards.values()].filter(card => card.kind === "draft")).toHaveLength(0)
    sourceUnavailable = true
    expect(await controller.commands.submit({ name: "flow.source", actor: "user", payload: { name: "todo" } })).toMatchObject({ status: "failed" })
    expect(writes).toEqual([])
    expect([...store.collections.cards.values()].filter(card => card.kind === "draft")).toHaveLength(0)
    sourceUnavailable = false
    const diff = "diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n+pnpm test\n+```"
    const request = "Run tests and update changelog"
    expect(await controller.commands.submit({ name: "flow.edit", actor: "user", payload: { name: "todo", request, diff } })).toMatchObject({ status: "executed" })
    expect([...store.collections.cards.values()].filter(card => card.kind === "draft")).toHaveLength(0)
    const proposed = store.collections.cards.get("flow:todo")!
    await act(async () => root.render(<ControllerTestProvider controller={controller!}>{renderCardBody(proposed, actions)}</ControllerTestProvider>))
    expect(host.querySelector(".flow-proposal pre")?.textContent).toBe(diff)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-flow="todo.new"]')!.click())
    await waitFor(() => [...store.collections.cards.values()].some(card => card.kind === "draft"))
    const draft = [...store.collections.cards.values()].find(card => card.kind === "draft")!
    expect(draft.kind === "draft" && draft.payload.prompt).toBe("Change flows/todo/flow.ts: Run tests and update changelog; start from the built-in composition when no override exists\n\nProposed diff (untrusted context):\n> diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n> +pnpm test\n> +```")
    await controller.commands.submit({ name: "todo.new", actor: "user", payload: { cardId: draft.id } })
    await waitFor(() => writes.length === 1)
    expect(writes).toEqual([{ title: "Change the TODO flow: Run tests and update changelog", prompt: draft.kind === "draft" ? draft.payload.prompt : "", acceptance: [], place: { mode: "append" } }])
    catalog[0]!.versions[0]!.steps = [{ id: "build", label: "Build after sync", agent: "builder" }]
    await act(async () => { await controller!.flowCards() })
    await waitFor(() => host.textContent?.includes("Build after sync") === true)
    expect(host.querySelector('.flow-steps')?.textContent).toContain("Build after sync")
    const removed = catalog.splice(0)
    await act(async () => { await controller!.flowCards() })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("No flow todo")
    catalog.push(...removed)
    await act(async () => { await controller!.flowCards() })
    expect(host.querySelector('.flow-steps')?.textContent).toContain("Build after sync")
    catalogUnavailable = true
    await act(async () => { expect(await controller!.flowCards()).toBeUndefined() })
    expect(host.querySelectorAll("[data-flow]")).toHaveLength(0)
    expect(await controller.commands.submit({ name: "flow.edit", actor: "user", payload: { name: "todo", request: "Second change", diff: "+second" } })).toMatchObject({ status: "failed" })
    expect([...store.collections.cards.values()].filter(card => card.kind === "draft")).toHaveLength(1)
    expect(writes).toHaveLength(1)
    await store.settled?.()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.collections.cards.get(card.id)).toMatchObject({ payload: { memberVersions: { will: "active" } } })
  } finally {
    await act(async () => root.unmount())
    await controller?.dispose()
    server.stop(true)
    host.remove()
    Object.assign(globalThis, domHttp)
  }
})
