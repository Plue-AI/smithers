import { act } from "react"
import { expect, test } from "bun:test"
import { createRoot } from "./views/testDom"
import { ControllerTestProvider } from "../ControllerContext"
import { CARD_RENDERERS } from "./CardRenderers"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, signupProfileFetch, unavailableAgent, waitFor } from "../state/TestFixtures"
import type { BranchControl } from "../state/seams/BranchControlsSeam"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { fixtures as todos } from "../../../../../packages/rpc/test/fixtures/Todo"

const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
const cases = [
  ["sleep", "box.suspend", "awake"], ["wake", "box.resume", "asleep"],
  ["rebase", "branch.rebase-now", "awake"],
  ["wake", "box.resume", "failed"], ["rebase", "branch.rebase", "awake"]
] as const

for (const [flow, operation] of [["todo.return-to-item", "return-to-item"], ["todo.keep-moved", "keep-moved"]] as const)
for (const ready of [false, true]) test(`mounted ${flow} uses the served wait's control and identity (${ready})`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const writes: Array<{ path: string; body: unknown }> = []
  const todo = { ...todos.working.model, n: 2, state: "needs_you", waits: [{ id: "moved-original", kind: "moved_off", prompt: "Ben moved this branch off T2", since: "2026-10-07T00:00:00Z", actions: ready ? [{ tag: flow, label: operation === "keep-moved" ? "Keep for now" : "Return to T2" }] : [] }] }
  let resolve!: (response: Response) => void
  const launch = new Promise<Response>(done => { resolve = done })
  const profile = signupProfileFetch(async (input, init) => {
    const path = new URL(String(input), "https://install.test").pathname
    if (init?.method === "POST") { writes.push({ path, body: JSON.parse(String(init.body)) }); return launch }
    if (path === "/api/todos") return Response.json([todo])
    if (path === "/api/todos/2") return Response.json(todo)
    if (path === "/api/branches/scratch%2Fben%2Ftry") return Response.json({ name: "scratch/ben/try", machine: { id: "b-contract" } })
    return new Response("{}", { status: 404 })
  })
  const actor = { kind: "person", login: "ben", name: "Ben", avatar_url: "https://example.test/ben.png", color_index: 1 }
  const movedSnapshots = new Map([
    ["branch:b-contract", { topic: "branch:b-contract", data: { id: "b-contract", name: "scratch/ben/try", machine: { state: "awake" }, item: { n: 2, title: "Item", state: "needs_you", place: 1 }, moved_off: { by: actor, item: 2 }, presence: [], terminals: [], ssh_line: "ssh branch@localhost" } }],
    ["branch:b-contract:activity", { topic: "branch:b-contract:activity", data: [] }], ["branch:b-contract:files", { topic: "branch:b-contract:files", data: [] }]
  ])
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    live: { subscribe: () => () => {}, getSnapshot: topic => movedSnapshots.get(topic) } })
  const host = document.createElement("div"), root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    await controller.runCommandForResult("branch", "scratch/ben/try")
    const card = store.collections.cards.get("branch:b-contract")!
    if (card.kind !== "branch") throw new Error("Expected branch")
    await act(async () => { root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>); await new Promise(done => setTimeout(done, 30)) })
    await act(async () => { await waitFor(() => controller.todoList.get().todos?.length === 1) })
    expect(controller.todoList.get().todos).toHaveLength(1)
    const button = host.querySelector<HTMLButtonElement>(`[data-flow="${flow}"]`)
    if (!ready) { expect(button).toBeNull(); expect(writes).toEqual([]); return }
    expect(button).not.toBeNull()
    await act(async () => { button!.click(); await new Promise(done => setTimeout(done, 30)) })
    expect(writes).toEqual([{ path: "/api/todos/2", body: { op: operation, id: "moved-original" } }])
    expect(store.collections.cards.get("todo:2")?.kind).toBe("todo")
    resolve(Response.json({ state: "accepted", n: 2 }, { status: 202 }))
  } finally { resolve(Response.json({ state: "accepted", n: 2 }, { status: 202 })); await act(async () => root.unmount()); await controller.dispose() }
})

// Contract fakes qualify dark bindings only; they are not install acceptance receipts.
for (const [operation, flow, state] of cases) for (const ready of [false, true]) test(`mounted ${flow} binds only its ${operation} provider (${ready})`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<{ path: string; method: string; body?: unknown; key?: string }> = []
  const profile = signupProfileFetch(async (input, init) => {
    const path = new URL(String(input), "https://install.test").pathname
    if (path === "/api/todos/2") return Response.json({ branch: { name: "scratch/ben/try" } })
    if (path === "/api/branches/scratch%2Fben%2Ftry") {
      requests.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), key: new Headers(init?.headers).get("Idempotency-Key") ?? undefined })
      return init?.method === "POST" ? Response.json({ state: "accepted" }, { status: 202 }) : Response.json({ name: "scratch/ben/try", machine: { id: "b-contract" } })
    }
    return new Response("{}", { status: 404 })
  })
  const actor = { kind: "person", login: "ben", name: "Ben", avatar_url: "https://example.test/ben.png", color_index: 1 }
  const model = { id: "b-contract", name: "scratch/ben/try", machine: state === "failed" ? { state, error: { code: "machine_unreachable", class: "infra", message: "Machine unreachable" } } : { state }, presence: [], terminals: [], ssh_line: "ssh -p 2222 scratch/ben/try@localhost",
    scratch: { forked_from: { kind: "main" } }, moved_off: { by: actor, item: 2 }, rebase: flow === "branch.rebase" ? { state: "conflict", onto: "main", paths: ["src/retry.ts"], conflict_change: "retained-conflict-1", onto_revision: "main-revision-1" } : { state: "pending", onto: "main" } }
  const snapshots = new Map([["branch:b-contract", { topic: "branch:b-contract", data: model }], ["branch:b-contract:activity", { topic: "branch:b-contract:activity", data: [] }], ["branch:b-contract:files", { topic: "branch:b-contract:files", data: [] }]])
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    branchControlOptions: { ready: (candidate: BranchControl) => ready && candidate === operation },
    live: { subscribe: () => () => {}, getSnapshot: topic => snapshots.get(topic) } })
  const host = document.createElement("div"), root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    expect(await controller.runCommandForResult("branch", "scratch/ben/try")).toMatchObject({ status: "executed" })
    const card = store.collections.cards.get("branch:b-contract")!
    if (card.kind !== "branch") throw new Error("Expected branch")
    await act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
    const button = host.querySelector<HTMLButtonElement>(`[data-flow="${flow}"]`)
    if (!ready) {
      expect(button).toBeNull()
      expect(await controller.submitCommand({ name: flow, payload: { branch: "scratch/ben/try", n: 2 }, actor: "user" })).toMatchObject({ status: "failed" })
      expect(requests.filter(request => request.method === "POST")).toEqual([])
    } else {
      expect(button).not.toBeNull()
      if (state === "failed") expect(button!.textContent).toBe("Retry")
      if (flow === "branch.rebase") expect(button!.textContent).toBe("Done")
      await act(async () => {
        button!.click()
        for (let i = 0; i < 50 && !requests.some(request => request.method === "POST"); i++) await new Promise(resolve => setTimeout(resolve, 2))
      })
      const writes = requests.filter(request => request.method === "POST")
      expect(writes).toHaveLength(1)
      expect(writes[0]!.path).toBe("/api/branches/scratch%2Fben%2Ftry")
      expect(writes[0]!.body).toEqual(flow === "branch.rebase" ? { conflict_change: "retained-conflict-1", onto_revision: "main-revision-1" } : operation === "rebase" ? { rebase: true } : { op: operation })
      expect(writes[0]!.key).toMatch(/^[0-9a-f-]{36}$/)
      for (const [, other] of cases) if (other !== flow) expect(host.querySelector(`[data-flow="${other}"]`)).toBeNull()
    }
  } finally { await act(async () => root.unmount()); await controller.dispose() }
})

for (const ready of [false, true]) test(`scratch Resolve opens only its bound branch file (${ready})`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: string[] = []
  const profile = signupProfileFetch(async (input, init) => {
    const path = new URL(String(input), "https://install.test").pathname
    if (path === "/api/branches/scratch%2Fben%2Ftry") return Response.json({ name: "scratch/ben/try", machine: { id: "b-contract" } })
    if (path.startsWith("/api/branches/")) requests.push(`${init?.method ?? "GET"} ${path}`)
    if (path === "/api/branches/scratch%2Fben%2Ftry/files/src/retry.ts") return Response.json({ path: "src/retry.ts", branch: "scratch/ben/try", language: "typescript", digest: "conflicted-bytes", content: { kind: "text", text: "<<<<<<< local\nlocal\n=======\nmain\n>>>>>>> main\n" }, mode: "read_only", diagnostics: [], authors: [], editors: [] })
    return new Response("{}", { status: 404 })
  })
  const snapshots = new Map([
    ["branch:b-contract", { topic: "branch:b-contract", data: { id: "b-contract", name: "scratch/ben/try", machine: { state: "awake" }, scratch: { forked_from: { kind: "main" } }, rebase: { state: "conflict", onto: "main", paths: ["src/retry.ts"] }, presence: [], terminals: [], ssh_line: "ssh -p 2222 scratch/ben/try@localhost" } }],
    ["branch:b-contract:activity", { topic: "branch:b-contract:activity", data: [] }], ["branch:b-contract:files", { topic: "branch:b-contract:files", data: [] }]
  ])
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    branchOptions: { ready: () => ready, scope: () => ({ branch: "scratch/ben/try", member: "ben", revision: 1, sleeping: false }) },
    live: { subscribe: () => () => {}, getSnapshot: topic => snapshots.get(topic) } })
  const host = document.createElement("div"), root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    expect(await controller.runCommandForResult("branch", "scratch/ben/try")).toMatchObject({ status: "executed" })
    const card = store.collections.cards.get("branch:b-contract")!
    if (card.kind !== "branch") throw new Error("Expected branch")
    await act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
    const button = host.querySelector<HTMLButtonElement>('.branch-actions [data-flow="file"]')
    if (!ready) expect(button).toBeNull()
    else {
      expect(button?.textContent).toBe("Resolve")
      await act(async () => {
        button!.click()
        for (let i = 0; i < 50 && !requests.length; i++) await new Promise(resolve => setTimeout(resolve, 2))
      })
      expect(requests).toEqual(["GET /api/branches/scratch%2Fben%2Ftry/files/src/retry.ts"])
      const file = [...store.collections.cards.values()].find(card => card.kind === "file")
      expect(file?.payload).toMatchObject({ path: "src/retry.ts", file: { branch: "scratch/ben/try" } })
      expect(host.querySelector('[data-flow="branch.rebase"]')).toBeNull()
    }
  } finally { await act(async () => root.unmount()); await controller.dispose() }
})

// The production boot passes no override: an install binds Sleep and Wake to its own route; another host binds none.
for (const capabilities of [["install"], []] as Array<AppBootstrap["capabilities"]>) for (const [operation, state, label] of [["sleep", "awake", "Sleep"], ["wake", "asleep", "Wake"]] as const)
test(`${capabilities.length ? "an install" : "a host without install"} ${capabilities.length ? "binds" : "does not bind"} ${label} without an override`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const writes: Array<{ path: string; body: unknown }> = []
  const profile = signupProfileFetch(async (input, init) => {
    const path = new URL(String(input), "https://install.test").pathname
    if (init?.method === "POST") { writes.push({ path, body: JSON.parse(String(init.body)) }); return Response.json({ state: "accepted" }, { status: 202 }) }
    if (path === "/api/branches/smithers%2Fretries") return Response.json({ name: "smithers/retries", machine: { id: "b-install" } })
    return new Response("{}", { status: 404 })
  })
  const snapshots = new Map([
    ["branch:b-install", { topic: "branch:b-install", data: { id: "b-install", name: "smithers/retries", machine: { state }, item: { n: 2, title: "Retries", state: "working", place: 1 }, presence: [], terminals: [], ssh_line: "ssh -p 2222 retries@localhost" } }],
    ["branch:b-install:activity", { topic: "branch:b-install:activity", data: [] }], ["branch:b-install:files", { topic: "branch:b-install:files", data: [] }]
  ])
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities, authFlow: "redirect", sandbox: null },
    live: { subscribe: () => () => {}, getSnapshot: topic => snapshots.get(topic) } })
  const host = document.createElement("div"), root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    await controller.runCommandForResult("branch", "smithers/retries")
    const card = store.collections.cards.get("branch:b-install")
    if (!capabilities.length) {
      expect(controller.branchControls).toBeUndefined()
      expect(await controller.submitCommand({ name: operation === "sleep" ? "box.suspend" : "box.resume", payload: { branch: "smithers/retries" }, actor: "user" })).toMatchObject({ status: "failed" })
      expect(writes).toEqual([])
      return
    }
    if (card?.kind !== "branch") throw new Error("Expected branch")
    await act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
    const button = host.querySelector<HTMLButtonElement>(`[data-flow="${operation === "sleep" ? "box.suspend" : "box.resume"}"]`)
    expect(button?.textContent).toBe(label)
    await act(async () => {
      button!.click()
      for (let i = 0; i < 50 && !writes.length; i++) await new Promise(resolve => setTimeout(resolve, 2))
    })
    expect(writes).toEqual([{ path: "/api/branches/smithers%2Fretries", body: { op: operation } }])
  } finally { await act(async () => root.unmount()); await controller.dispose() }
})
