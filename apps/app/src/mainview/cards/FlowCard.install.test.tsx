import { createRoot, nativeHttp } from "./views/testDom"
import { expect, test } from "bun:test"
import { act } from "react"
import type { FlowCard } from "@smthrs/rpc/FlowCard"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import { memoryStorage, silentAgent, waitFor } from "../state/TestFixtures"
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
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    reads.push(path)
    if (path === "/api/flows") return Response.json(catalog)
    if (path === "/api/install") return Response.json(installFixture())
    if (path === "/api/user") return Response.json({ id: 1, username: "will", is_admin: false })
    return Response.json({}, { status: 404 })
  } })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  let controller: ReturnType<typeof createController> | undefined
  try {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
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
    expect([...host.querySelectorAll('[data-flow]')].map(node => node.textContent)).toEqual(["Edit"])
    await act(async () => host.querySelector<HTMLButtonElement>('.flow-version[data-state="proposed"]')!.click())
    expect(host.querySelector('[data-added="true"]')?.textContent).toContain("Write the changelog")
    expect(host.querySelectorAll('[data-added="true"]')).toHaveLength(1)
    await act(async () => host.querySelector<HTMLButtonElement>('.flow-version[data-state="merged-failed"]')!.click())
    expect(host.querySelector('.flow-failure pre')?.textContent).toBe("Unknown agent: reviewer")
    await act(async () => host.querySelector<HTMLButtonElement>('.flow-version[data-state="active"]')!.click())
    expect(host.querySelector('.flow-failure')).toBeNull()
    catalog[0]!.versions[0]!.steps = [{ id: "build", label: "Build after sync", agent: "builder" }]
    await act(async () => { await controller!.flowCards() })
    await waitFor(() => host.textContent?.includes("Build after sync") === true)
    expect(host.querySelector('.flow-steps')?.textContent).toContain("Build after sync")
  } finally {
    await act(async () => root.unmount())
    await controller?.dispose()
    server.stop(true)
    host.remove()
    Object.assign(globalThis, domHttp)
  }
})
