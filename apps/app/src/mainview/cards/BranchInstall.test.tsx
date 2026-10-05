/*
 * Open branch on an install (J1 7): pressing a TODO card's Open branch reads
 * the branch the install serves and opens its Branch card, which shows the
 * branch's commits, its changed files and its TODO's checks; a branch the
 * install does not serve opens nothing and says why. The bodies are what
 * GET /api/branches/{b}, its /diff and GET /api/todos/{n} serve
 * (docs/api/openapi/branches.yaml).
 */
import { act } from "react"
import { expect, test } from "bun:test"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { createRoot } from "./views/testDom"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, signupProfileFetch, unavailableAgent } from "../state/TestFixtures"
import { CARD_RENDERERS } from "./CardRenderers"
import { todoCardFamily } from "./TodoCard"

const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {},
  onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
const head = "c".repeat(40)

const install = async (branchName: string) => {
  const todo: TodoCard = { ...fixtures.in_review.model, n: 1, title: "Add greeting", place: 1,
    owner: { login: "rehearsal-owner", name: "Rehearsal owner", avatar_url: PlaceholderAvatarUrl },
    branch: { id: "lane-1", name: branchName, machine: { state: "asleep" } },
    evidence: [{ attempt: 1, revision: head, items: [{ kind: "check", name: "node --test", state: "passed" }] }] }
  const profile = signupProfileFetch(async input => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://install.test").pathname
    switch (path) {
      case "/api/branches/smithers%2Fadd-greeting": return Response.json({ name: "smithers/add-greeting", kind: "item", state: "asleep", head,
        item: { n: 1, title: "Add greeting", state: "in_review", place: 1 }, machine: { id: "lane-1", status: "stopped" } })
      case "/api/branches/smithers%2Fadd-greeting/diff": return Response.json({
        files: [{ path: "greet.mjs", branch: "smithers/add-greeting", against: { kind: "item_base", rev: "b".repeat(40) }, change: "added", hunks: [] },
          { path: "test/smoke.test.mjs", branch: "smithers/add-greeting", against: { kind: "item_base", rev: "b".repeat(40) }, change: "modified", hunks: [] }],
        commits: [{ sha: head, subject: "feat: add greet", author: "Smithers", at: "2026-10-05T09:00:00-07:00" }] })
      case "/api/todos/1": return Response.json(todo)
      case "/api/branches/smithers%2Fgone": return Response.json({ code: "not_found", class: "user", message: "branch not found" }, { status: 404 })
    }
    return new Response("{}", { status: 404 })
  })
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl, live: { subscribe: () => () => {}, getSnapshot: () => undefined },
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  const card = { id: "todo:1", kind: "todo", title: "T1", status: "active", createdAt: 1, ordinal: 1, payload: { n: 1, model: todo, requests: [] } } as unknown as Parameters<typeof todoCardFamily.todo.render>[0]
  const host = document.body.appendChild(document.createElement("div"))
  const root = createRoot(host)
  await act(async () => root.render(<ControllerTestProvider controller={controller}>{todoCardFamily.todo.render(card, { presentation: "embedded" } as never)}</ControllerTestProvider>))
  const press = async () => {
    const button = host.querySelector<HTMLElement>(`button[data-flow="branch"]`)
    expect(button?.textContent).toBe("Open branch")
    await act(async () => { button!.click() })
    for (let tries = 0; tries < 100 && !store.collections.cards.get(`branch:${branchName}`) && ![...store.collections.toasts.values()].some(each => each.status === "failed"); tries++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    }
  }
  const close = async () => { await act(async () => root.unmount()); host.remove(); await controller.dispose() }
  return { store, controller, press, close }
}

test("Open branch on an install's TODO card opens the branch the install serves: its commits, changed files and checks", async () => {
  const h = await install("smithers/add-greeting")
  try {
    await h.press()
    const opened = h.store.collections.cards.get("branch:smithers/add-greeting")
    expect(opened).toMatchObject({ kind: "branch", title: "smithers/add-greeting", payload: { id: "smithers/add-greeting" } })
    const host = document.body.appendChild(document.createElement("div"))
    const root = createRoot(host)
    try {
      await act(async () => root.render(<ControllerTestProvider controller={h.controller}>{CARD_RENDERERS.branch.render(opened as Parameters<typeof CARD_RENDERERS.branch.render>[0], actions)}</ControllerTestProvider>))
      const text = host.textContent ?? ""
      for (const shown of ["smithers/add-greeting", "Asleep", "T1", "Add greeting", "feat: add greet", "ccccccc", "node --test passed"]) expect(text).toContain(shown)
      expect(text).not.toContain("Retry failed webhooks")
      expect(host.querySelector("[aria-label='Copy SSH line']")).toBeNull()
      expect([...host.querySelectorAll("button[data-flow]")].map(each => each.getAttribute("data-flow"))).toContain("branch.fork")
      const files = [...host.querySelectorAll<HTMLElement>("[role='tab']")].find(each => each.textContent?.startsWith("Files"))!
      expect(files.textContent).toBe("Files2")
      await act(async () => files.click())
      expect(host.textContent).toContain("greet.mjs")
      expect(host.textContent).toContain("test/smoke.test.mjs")
    } finally { await act(async () => root.unmount()); host.remove() }
  } finally { await h.close() }
})

test("Open branch on an install says why when the install serves no such branch, and opens nothing", async () => {
  const h = await install("smithers/gone")
  try {
    await h.press()
    expect([...h.store.collections.cards.keys()].filter(id => id.startsWith("branch:"))).toEqual([])
    expect([...h.store.collections.toasts.values()].map(each => [each.status, each.detail])).toEqual([["failed", "branch not found"]])
  } finally { await h.close() }
})
