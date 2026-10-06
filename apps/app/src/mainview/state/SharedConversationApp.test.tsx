import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppStore } from "./AppStore"
import { createAppController } from "./AppController"
import { memoryStorage, silentAgent, waitFor } from "./TestFixtures"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 20)); await GlobalRegistrator.unregister() })
const ben = { id: "turn-ben", author: 1, authorLogin: "ben", runId: "run-ben", prompt: "List changed tests", state: "completed", frames: [
  { runId: "run-ben", type: "delta", kind: "text", text: "One changed test" }, { runId: "run-ben", type: "done", reason: "stop" }
] }

test("install shell reads shared authors and clears stale output across branch and account changes", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: string[] = []
  let finish!: (value: Response) => void
  let starts = 0
  const controller = createAppController(store, { ...silentAgent, startTurn: async () => { starts++; return { status: "started" } } }, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    fetchImpl: async input => {
      const path = String(input); requests.push(path)
      if (path === "/api/conversations/main") return Response.json({ id: "main", entries: [ben] })
      if (path === "/api/conversations/feature") return new Promise(resolve => { finish = resolve })
      return new Response("{}", { status: 404 })
    }
  })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "message.appended", actor: "system", text: "PRIVATE LEGACY HISTORY" }).isPersisted.promise
    flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
    await waitFor(() => host.querySelector("[data-shared-turn]") !== null)
    expect(host.textContent).toContain("Smithers for ben")
    expect(host.textContent).toContain("One changed test")
    expect(host.textContent).not.toContain("PRIVATE LEGACY HISTORY")
    await controller.selectConversationBranch("feature")
    await waitFor(() => requests.includes("/api/conversations/feature"))
    expect(host.querySelector("[data-shared-turn]")).toBeNull()
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    finish(Response.json({ id: "feature", entries: [ben] }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(host.querySelector("[data-shared-turn]")).toBeNull()
    expect(starts).toBe(0)
    expect(requests.some(path => /\/api\/(agent|chat)\/turn$/.test(path))).toBe(false)
  } finally { flushSync(() => root.unmount()); host.remove(); await controller.dispose() }
})

test("composer persists before unresolved admission, deduplicates, and waits for host completion", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let release!: (value: Response) => void
  let completed = false, starts = 0
  const writes: Array<{ path: string; method: string; body: unknown }> = []
  const controller = createAppController(store, { ...silentAgent, startTurn: async () => { starts++; return { status: "started" } } }, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    toastDebounceMs: 1,
    fetchImpl: async (input, init) => {
      const path = String(input)
      if (init?.method === "POST") {
        writes.push({ path, method: init.method, body: JSON.parse(String(init.body)) })
        if (path === "/api/conversations/main/prompt") return new Promise(resolve => { release = resolve })
      }
      if (path === "/api/conversations/main") return Response.json({ id: "main", entries: store.session().sharedPrompts?.some(row => row.turnId) ? [{ ...ben, state: completed ? "completed" : "running", frames: completed ? ben.frames : [] }] : [] })
      if (path.endsWith("/view-state")) return Response.json({})
      return new Response("{}", { status: 404 })
    }
  })
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
    controller.changeDraft("List changed tests")
    expect(await controller.send("List changed tests")).toBe(true)
    expect(await controller.send("List changed tests")).toBe(true)
    await waitFor(() => writes.length === 1)
    const saved = store.session().sharedPrompts![0]!
    expect(saved.state).toBe("requested")
    expect(store.session().draft).toBe("")
    expect(writes).toEqual([{ path: "/api/conversations/main/prompt", method: "POST", body: { prompt: "List changed tests", idempotencyKey: saved.id } }])
    controller.changeDraft("Chat remains usable")
    await waitFor(() => store.collections.toasts.get(`toast-prompt-${saved.id}`)?.status === "running")
    release(Response.json({ status: "accepted", turnId: "turn-ben", terminal: false }, { status: 202 }))
    await waitFor(() => host.querySelector('[data-shared-turn="turn-ben"][data-state="running"]') !== null)
    expect(store.collections.toasts.get(`toast-prompt-${saved.id}`)?.status).toBe("running")
    expect(store.session().draft).toBe("Chat remains usable")
    completed = true
    await waitFor(() => store.session().sharedPrompts?.[0]?.state === "completed")
    await waitFor(() => store.collections.toasts.get(`toast-prompt-${saved.id}`)?.status === "ok")
    expect(host.textContent).toContain("One changed test")
    expect(starts).toBe(0)
  } finally { flushSync(() => root.unmount()); host.remove(); await controller.dispose() }
})

test("private queue Edit patches its server turn and Remove deletes only that turn", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let queue = [{ id: "queued-turn", prompt: "Old prompt" }]
  const writes: Array<{ path: string; method: string; body: unknown }> = []
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = String(input), method = init?.method ?? "GET"
      if (method !== "GET") {
        writes.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null })
        if (method === "PATCH") queue = [{ id: "queued-turn", prompt: "List changed tests" }]
        if (method === "DELETE") queue = []
        return Response.json({ status: "ok" })
      }
      if (path === "/api/conversations/main") return Response.json({ id: "main", entries: [] })
      if (path.endsWith("/view-state")) return Response.json({ queue })
      return new Response("{}", { status: 404 })
    }
  })
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
    await waitFor(() => host.querySelector('[aria-label="Edit queued prompt: Old prompt"]') !== null)
    flushSync(() => host.querySelector<HTMLButtonElement>('[aria-label="Edit queued prompt: Old prompt"]')!.click())
    await waitFor(() => store.session().draft === "Old prompt")
    expect(writes).toEqual([])
    controller.changeDraft("List changed tests")
    await controller.send("List changed tests")
    await waitFor(() => host.querySelector('[aria-label="Remove queued prompt: List changed tests"]') !== null)
    expect(writes).toEqual([{ path: "/api/conversations/main/turns/queued-turn", method: "PATCH", body: { prompt: "List changed tests" } }])
    flushSync(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove queued prompt: List changed tests"]')!.click())
    await waitFor(() => host.querySelector('[aria-label="Queued prompts"]') === null)
    expect(writes[1]).toEqual({ path: "/api/conversations/main/turns/queued-turn", method: "DELETE", body: null })
    expect(writes).toHaveLength(2)
  } finally { flushSync(() => root.unmount()); host.remove(); await controller.dispose() }
})

test("failed admission stays private and retry reuses its durable idempotency key", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let allowed = false
  const bodies: unknown[] = []
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = String(input)
      if (path.endsWith("/prompt")) {
        bodies.push(JSON.parse(String(init?.body)))
        return allowed ? Response.json({ turnId: "turn-ben", terminal: true }, { status: 202 }) : Response.json({ class: "infra", code: "unavailable", message: "Prompt unavailable" }, { status: 503 })
      }
      if (path === "/api/conversations/main") return Response.json({ id: "main", entries: allowed ? [ben] : [] })
      if (path.endsWith("/view-state")) return Response.json({})
      return new Response("{}", { status: 404 })
    }
  })
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
    await controller.send("List changed tests")
    await waitFor(() => store.session().sharedPrompts?.[0]?.state === "failed")
    await waitFor(() => host.querySelector('[data-private="true"]')?.textContent?.includes("Prompt unavailable") === true)
    expect(host.querySelectorAll("[data-shared-turn]")).toHaveLength(0)
    allowed = true
    await controller.submitCommand({ name: "chat.retry", payload: {}, actor: "user" })
    await waitFor(() => store.session().sharedPrompts?.[0]?.state === "completed")
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toEqual(bodies[1])
  } finally { flushSync(() => root.unmount()); host.remove(); await controller.dispose() }
})

test("Stop targets the author's running turn and queue restore preserves FIFO draft text", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let queue = [{ id: "first", prompt: "First" }, { id: "second", prompt: "Second" }]
  const writes: Array<{ path: string; method: string }> = []
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = String(input), method = init?.method ?? "GET"
      if (method !== "GET") {
        writes.push({ path, method })
        if (method === "DELETE") queue = queue.filter(row => !path.endsWith(`/${row.id}`))
        return Response.json({ status: "ok" })
      }
      if (path === "/api/conversations/main") return Response.json({ id: "main", entries: [{ ...ben, state: "running", frames: [] }] })
      if (path.endsWith("/view-state")) return Response.json({ queue })
      return new Response("{}", { status: 404 })
    }
  })
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
    await waitFor(() => controller.sharedConversation?.get().conversation !== undefined)
    controller.stop()
    expect(writes).toEqual([])
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    await waitFor(() => controller.sharedConversation?.get().queue?.length === 2)
    controller.stop()
    await waitFor(() => writes.length === 1)
    expect(writes[0]).toEqual({ path: "/api/conversations/main/turns/turn-ben/stop", method: "POST" })
    controller.changeDraft("Draft")
    await controller.submitCommand({ name: "chat.queue.restore", payload: {}, actor: "user" })
    await waitFor(() => store.session().draft === "First\nSecond\nDraft")
    expect(writes.slice(1)).toEqual([{ path: "/api/conversations/main/turns/second", method: "DELETE" }, { path: "/api/conversations/main/turns/first", method: "DELETE" }])
    await waitFor(() => controller.sharedConversation?.get().queue?.length === 0)
  } finally { await controller.dispose() }
})

test("shared card maximization persists only in its member view and restores on return", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const views: Record<string, Record<string, unknown>> = { ben: { scroll_anchor: "turn-ben:prompt", home: { filter: "working" }, toasts_hidden: true }, alice: { scroll_anchor: "turn-ben:answer" } }
  const writes: unknown[] = []
  const card = { id: "shared-file", kind: "file", title: "README.md", status: "active", ordinal: 1, createdAt: 1, payload: { repo: "owner/repo", path: "README.md", content: "Shared file bytes", truncated: false } }
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = String(input), login = store.collections.identitySessions.get("identity")?.login ?? "ben"
      if (path === "/api/conversations/main") return Response.json({ id: "main", entries: [{ ...ben, frames: [...ben.frames, { type: "card", runId: "run-ben", card }] }] })
      if (path.endsWith("/view-state")) {
        if (init?.method === "PUT") { views[login] = JSON.parse(String(init.body)); writes.push(views[login]) }
        return Response.json({ ...views[login], queue: [{ id: "private", prompt: "Private queue" }] })
      }
      return new Response("{}", { status: 404 })
    }
  })
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  const identity = async (login: string) => store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, admin: false, scopesPlain: null }).isPersisted.promise
  try {
    await identity("ben")
    flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
    await waitFor(() => host.querySelector('[data-testid="card-shared-file"]') !== null)
    const button = host.querySelector<HTMLButtonElement>('[data-testid="card-shared-file"] [data-flow="card.maximize"]')!
    expect(button).not.toBeNull()
    flushSync(() => button.click())
    await waitFor(() => host.querySelector('[data-testid="card-shared-file"]')?.getAttribute("data-maximized") === "true")
    expect(writes).toEqual([{ scroll_anchor: "turn-ben:prompt", home: { filter: "working" }, toasts_hidden: true, card_view: { "shared-file": "maximized" } }])
    await identity("alice")
    await waitFor(() => controller.sharedConversation?.get().view?.scroll_anchor === "turn-ben:answer")
    expect(host.querySelector('[data-testid="card-shared-file"]')?.getAttribute("data-maximized")).toBe("false")
    expect(views.alice).toEqual({ scroll_anchor: "turn-ben:answer" })
    await identity("ben")
    await waitFor(() => host.querySelector('[data-testid="card-shared-file"]')?.getAttribute("data-maximized") === "true")
    expect(writes).toHaveLength(1)
  } finally { flushSync(() => root.unmount()); host.remove(); await controller.dispose() }
})

test("private host theme instructions use the typed flow once and never cross members", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const writes: string[] = []
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = String(input)
      if (init?.method && init.method !== "GET") writes.push(path)
      if (path === "/api/conversations/main") return Response.json({ id: "main", entries: [ben] })
      if (path.endsWith("/view-state")) return Response.json({ instructions: store.collections.identitySessions.get("identity")?.login === "ben" ? [{ id: "turn-ben:1:4", command: "theme", mode: "dark" }] : [] })
      return new Response("{}", { status: 404 })
    }
  })
  try {
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "light" }).isPersisted.promise
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
    await controller.sharedConversation!.read()
    expect(store.session().theme).toBe("light")
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    await waitFor(() => store.session().uiInstructionsSeen?.length === 1)
    expect(store.session().theme).toBe("dark")
    await controller.submitCommand({ name: "theme", payload: { mode: "light" }, actor: "user" })
    await controller.sharedConversation!.read()
    expect(store.session().theme).toBe("light")
    expect(writes).toEqual([])
  } finally { await controller.dispose() }
})
