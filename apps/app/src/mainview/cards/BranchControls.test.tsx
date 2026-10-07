import { act } from "react"
import { expect, test } from "bun:test"
import { createRoot } from "./views/testDom"
import { ControllerTestProvider } from "../ControllerContext"
import { CARD_RENDERERS } from "./CardRenderers"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, signupProfileFetch, unavailableAgent } from "../state/TestFixtures"
import type { BranchControl } from "../state/seams/BranchControlsSeam"

const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
const cases = [
  ["sleep", "box.suspend", "awake"], ["wake", "box.resume", "asleep"],
  ["rebase", "branch.rebase-now", "awake"],
  ["return-to-item", "todo.return-to-item", "awake"], ["keep-moved", "todo.keep-moved", "awake"],
  ["wake", "box.resume", "failed"], ["rebase", "branch.rebase", "awake"]
] as const

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
      expect(writes[0]).toMatchObject({ path: "/api/branches/scratch%2Fben%2Ftry", body: flow === "branch.rebase" ? { op: "rebase", conflict_change: "retained-conflict-1", onto_revision: "main-revision-1" } : { op: operation } })
      expect(writes[0]!.key).toMatch(/^[0-9a-f-]{36}$/)
      for (const [, other] of cases) if (other !== flow) expect(host.querySelector(`[data-flow="${other}"]`)).toBeNull()
    }
  } finally { await act(async () => root.unmount()); await controller.dispose() }
})
