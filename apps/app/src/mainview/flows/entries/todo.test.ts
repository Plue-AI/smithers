import { expect, test } from "bun:test"
import { Schema } from "effect"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch, waitFor } from "../../state/TestFixtures"
import type { DraftEntry, TodoEntry } from "../../state/seams/TodoSeam"
import { fixtures } from "../../../../../../packages/rpc/test/fixtures/Todo"
import { modelInvocable, nameOf } from "../registry"
import { parseTodoArgs } from "@smthrs/rpc/TodoCommands"
import { TodoNewInput } from "./todo"
import { answerActions } from "../AnswerActions"
import { designTodoCard } from "../../state/seams/DesignWorld/todo"

const unavailable: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const mutations: { path: string; body: unknown }[] = []
  const profile = signupProfileFetch(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://install.test").pathname
    if (path === "/api/todos" && !init?.method) return new Response(JSON.stringify([fixtures.queued.model]), { headers: { "Content-Type": "application/json" } })
    if (path.startsWith("/api/todos")) {
      if (init?.method && init.method !== "GET") mutations.push({ path, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify(init?.method ? { state: "accepted", n: 12 } : fixtures.queued.model), { status: init?.method ? 202 : 200, headers: { "Content-Type": "application/json" } })
    }
    return new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailable, { fetchImpl: profile.fetchImpl })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  return { store, controller, mutations }
}
const agent = (controller: Awaited<ReturnType<typeof boot>>["controller"], name: string, args?: string) => controller.commands.executeForAgent({
  name: "commands", arguments: JSON.stringify({ action: "execute", name, args })
})
test("all TODO commands register slash, button and agent doors; amend/drop and commit confirm", async () => {
  const h = await boot()
  try {
    const entries = h.controller.commands.entries().filter(entry => nameOf(entry) === "todo" || nameOf(entry).startsWith("todo."))
    expect(entries.map(nameOf).sort()).toEqual(["todo", "todo.amend", "todo.answer", "todo.drop", "todo.from-issue", "todo.new", "todo.resume", "todo.retry", "todo.retry-current-flow", "todo.steer", "todo.stop"])
    for (const entry of entries) {
      expect(modelInvocable(entry)).toBe(true)
      expect(entry.metadata.grammar).toBeDefined()
      expect(entry.metadata.form).toBeDefined()
    }
    await agent(h.controller, "todo.drop", "T12")
    await agent(h.controller, "todo.amend", "T12 Amend the prompt")
    expect(h.mutations).toEqual([])
    expect([...h.store.collections.messages.values()].filter(message => message.action?.flow === "todo.drop" || message.action?.flow === "todo.amend")).toHaveLength(2)
    await h.controller.runCommandForResult("todo.new", "A draft")
    const draft = [...h.store.collections.cards.values()].find(row => row.kind === "draft") as DraftEntry
    await agent(h.controller, "todo.new", JSON.stringify({ text: "A draft", cardId: draft.id }))
    expect(h.mutations).toEqual([])
    expect([...h.store.collections.messages.values()].some(message => message.action?.flow === "todo.new")).toBe(true)
  } finally { h.controller.dispose() }
})
test("missing input opens a form for just the missing fields, preserving Tn", async () => {
  const h = await boot()
  try {
    await h.controller.runCommandForResult("todo.answer", "T12")
    const form = [...h.store.collections.cards.values()].find(row => row.kind === "flow-form")!
    expect(form.kind).toBe("flow-form")
    if (form.kind !== "flow-form") throw new Error("Expected form")
    expect(form.payload.given.n).toBe(12)
    expect(form.payload.fields.map(field => field.name)).toEqual(["answer"])
    expect(h.mutations).toEqual([])
    /* New TODO needs no text: the slash door and the Home button open the same empty private Draft. */
    await h.controller.runCommandForResult("todo.new")
    expect([...h.store.collections.cards.values()].filter(row => row.kind === "flow-form")).toHaveLength(1)
    const draft = [...h.store.collections.cards.values()].find(row => row.kind === "draft") as DraftEntry
    expect([draft.payload.title, draft.payload.prompt, draft.payload.private]).toEqual(["", "", true])
  } finally { h.controller.dispose() }
})
test("slash and typed button use the same TODO command; form.set persists the Draft", async () => {
  const h = await boot()
  try {
    /* MOCK SEAM: while the design seed is mounted both doors land on its T10, not on /api/todos. */
    const steers = () => h.controller.design.world().todos.find(each => each.ref === "T10")!.steers?.map(each => each.text)
    await h.controller.runCommandForResult("todo.steer", "T10 Keep whitespace")
    await h.controller.submitCommand({ name: "todo.steer", actor: "user", payload: { n: 10, text: "A second steer" }, display: JSON.stringify({ n: 10, text: "A second steer" }) })
    await waitFor(() => steers()?.length === 2)
    expect(steers()).toEqual(["Keep whitespace", "A second steer"])
    expect(h.mutations).toEqual([])
    await h.controller.runCommandForResult("todo.new", "A prompt")
    const draft = [...h.store.collections.cards.values()].find(row => row.kind === "draft") as DraftEntry
    await h.controller.submitCommand({ name: "form.set", actor: "user", payload: { cardId: draft.id, field: "prompt", value: "Changed\nverbatim" }, display: `${draft.id} prompt Changed\nverbatim` })
    expect((h.store.collections.cards.get(draft.id) as DraftEntry).payload.prompt).toBe("Changed\nverbatim")
  } finally { h.controller.dispose() }
})
test("signed out, the Draft's Commit input commits through todo.new {cardId} and opens the new TODO (mock seam)", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailable, { fetchImpl: async () => new Response("{}", { status: 404 }) })
  try {
    expect(store.collections.identitySessions.get("identity")?.state).not.toBe("signed-in")
    expect((await controller.runCommandForResult("todo.new")).status).toBe("executed")
    const draft = [...store.collections.cards.values()].find(row => row.kind === "draft") as DraftEntry
    for (const [field, value] of [["title", "Log retry counts"], ["prompt", "Count retries per webhook."]] as const)
      await controller.submitCommand({ name: "form.set", actor: "user", payload: { cardId: draft.id, field, value }, display: `${field} ${value}` })
    /* The Commit button's input (DraftContainer): optional keys absent, never `undefined`. */
    const result = await controller.submitCommand({ name: "todo.new", actor: "user", display: "Commit",
      payload: { cardId: draft.id, idempotencyKey: draft.payload.idempotencyKey, text: "Count retries per webhook.", title: "Log retry counts", acceptance: [] } })
    expect(result).toMatchObject({ status: "executed", value: "Committed as T12" })
    expect(controller.design.world().todos.find(each => each.ref === "T12")?.title).toBe("Log retry counts")
    expect(store.collections.cards.get("todo:12")?.payload).toEqual({ n: 12, requests: [] })
    expect((store.collections.cards.get(draft.id) as DraftEntry).payload.committed).toEqual({ n: 12, rev: 1 })
    expect(await controller.submitCommand({ name: "todo.new", actor: "user", display: "Commit", payload: { cardId: draft.id, text: "x", before: undefined } }))
      .toMatchObject({ status: "failed" })
  } finally { controller.dispose() }
})
test("TODO grammar and schema retain JSON whitespace, reject invalid numbers and keep missing fields", () => {
  const parse = parseTodoArgs("answer")
  expect(parse("T12 yes\nsecond line")).toEqual({ payload: { n: 12, answer: "yes\nsecond line" } })
  expect(parse("T12")).toEqual({ payload: { n: 12 } })
  expect(parse('{"n":12,"answer":" yes\\n "}')).toEqual({ payload: { n: 12, answer: " yes\n " } })
  expect(parse("{broken")).toEqual({ error: "Invalid TODO input" })
  expect(() => Schema.decodeUnknownSync(TodoNewInput)({ text: "x", before: -1 })).toThrow()
})
test("J9 answer actions dispatch its exact text and expose a page-name form", () => {
  const calls: unknown[] = []
  const text = "# Answer\n\nKeep the source"
  const bindings = answerActions((tag, input) => { calls.push({ tag, input }) }, text)
  bindings.onAction("todo.new")
  bindings.onAction("wiki.save", { name: "Findings" })
  expect(bindings.actions.map(action => action.label)).toEqual(["Make TODO", "Save to wiki"])
  expect(calls).toEqual([{ tag: "todo.new", input: { text } }, { tag: "wiki.save", input: { name: "Findings", text } }])
})

test("wiki.save reports the absent page-write operation without refreshing the wiki", async () => {
  const h = await boot()
  try {
    const result = await h.controller.runCommandForResult("wiki.save", "Findings")
    expect(result.status).toBe("failed")
    expect(h.mutations).toEqual([])
  } finally { h.controller.dispose() }
})

test("draft.discard uses the author-scoped Draft removal command", async () => {
  const h = await boot()
  try {
    await h.controller.runCommandForResult("todo.new", "A private draft")
    const draft = [...h.store.collections.cards.values()].find(row => row.kind === "draft") as DraftEntry
    await h.controller.submitCommand({ name: "card.dismiss", actor: "user", payload: { cardId: draft.id }, display: draft.id })
    expect(h.store.collections.cards.has(draft.id)).toBe(true)
    await h.controller.submitCommand({ name: "draft.discard", actor: "user", payload: { draft: draft.id }, display: draft.id })
    expect(h.store.collections.cards.has(draft.id)).toBe(false)
    expect(h.mutations).toEqual([])
  } finally { h.controller.dispose() }
})

test("Retry with the current flow is an agent-invocable card control with its steer first", async () => {
  const h = await boot()
  try {
    const entry = h.controller.commands.entries().find(row => nameOf(row) === "todo.retry-current-flow")!
    expect(entry.metadata.hidden).toBe(true)
    expect(entry.metadata.discloseToAgent).toBe(true)
    expect(modelInvocable(entry)).toBe(true)
    /* MOCK SEAM: while the design seed is mounted the control lands on its T10, stopped first, not on /api/todos. */
    await h.controller.runCommandForResult("todo.stop", "T10")
    expect(await h.controller.runCommandForResult("todo.retry-current-flow", JSON.stringify({ n: 10, text: " First\nmessage " })))
      .toMatchObject({ status: "executed", value: "Retrying T10 · attempt 2" })
    expect(h.mutations).toEqual([])
  } finally { h.controller.dispose() }
})

test("a configured host dispatches Draft, TODO and reviewed Merge to real routes without seed mutations", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const calls: { path: string; body?: unknown; key?: string | null }[] = []
  const topics = new Map<string, (model: unknown) => void>()
  const controller = createAppController(store, unavailable, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: [], authFlow: "none", sandbox: null },
    todoTopics: { subscribe: (topic, receive) => { topics.set(topic, receive); return () => { topics.delete(topic) } } },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "https://install.test").pathname
      if (!path.startsWith("/api/todos")) return new Response("{}", { status: 404 })
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("Idempotency-Key") } : {}) })
      return Response.json(init?.method === "POST" ? { state: "accepted", n: 12 }
        : path === "/api/todos" ? [fixtures.queued.model] : fixtures.in_review.model, { status: init?.method === "POST" ? 202 : 200 })
    }
  })
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    const seedBefore = JSON.stringify(controller.design.world().todos)
    await controller.runCommandForResult("todo.new", "Real prompt")
    await waitFor(() => [...store.collections.cards.values()].some(row => row.kind === "draft"))
    const draft = [...store.collections.cards.values()].find(row => row.kind === "draft") as DraftEntry
    expect(draft.audience_member_id).toBe("ben")
    await controller.submitCommand({ name: "form.set", actor: "user", payload: { cardId: draft.id, field: "acceptance", value: '["Real acceptance"]' } })
    const commit = { name: "todo.new", actor: "user" as const, payload: { cardId: draft.id } }
    expect(await controller.submitCommand(commit)).toMatchObject({ status: "executed", value: "Requested" })
    expect(await controller.submitCommand(commit)).toMatchObject({ status: "executed", value: "Requested" })
    await waitFor(() => calls.filter(call => call.body).length === 1)
    expect(calls.find(call => call.body)).toEqual({ path: "/api/todos", key: draft.payload.idempotencyKey,
      body: { title: "Real prompt", prompt: "Real prompt", acceptance: ["Real acceptance"], place: { mode: "append" } } })
    await controller.runCommandForResult("todo", "T12")
    expect(store.collections.cards.get("todo:12")).toMatchObject({ kind: "todo", payload: { model: { title: fixtures.in_review.model.title } } })
    await controller.submitCommand({ name: "merge", actor: "user", payload: { n: 12, reviewed_head_sha: fixtures.in_review.model.pr!.head } })
    await waitFor(() => calls.some(call => call.path === "/api/todos/12/merge"))
    expect(calls.find(call => call.path.endsWith("/merge"))?.body).toEqual({ reviewed_head_sha: fixtures.in_review.model.pr!.head })
    expect(JSON.stringify(controller.design.world().todos)).toBe(seedBefore)
  } finally { await controller.dispose() }
})

/* The hosted site and local dev (#3466 regression): /api/bootstrap answers, every other route is a 404. */
const noProviderHost = async (status = 404) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const calls: { path: string; method: string }[] = []
  const controller = createAppController(store, unavailable, {
    bootstrap: { apiVersion: 1, host: "local", version: "design", buildSha: "0".repeat(40), capabilities: [], authFlow: "none", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "https://install.test").pathname
      if (path.startsWith("/api/todos")) calls.push({ path, method: init?.method ?? "GET" })
      return new Response(JSON.stringify(status === 404 ? {} : { code: "internal", class: "infra", message: "Stack unavailable" }), { status, headers: { "Content-Type": "application/json" } })
    }
  })
  return { store, controller, calls }
}

test("signed out on a configured host with no TODO provider, every TODO, Draft and Merge flow runs on the seed", async () => {
  const h = await noProviderHost()
  const { controller, store } = h
  const seeded = (ref: string) => controller.design.world().todos.find(each => each.ref === ref)!
  try {
    expect(store.collections.identitySessions.get("identity")?.state).not.toBe("signed-in")
    // The first flow asks the host and is acknowledged at once; it runs on the seed when the host answers.
    expect(await controller.runCommandForResult("todo", "T9")).toMatchObject({ status: "executed", value: "Requested" })
    await waitFor(() => store.collections.cards.has("todo:9"))
    expect(store.collections.cards.get("todo:9")?.payload).toEqual({ n: 9, requests: [] })
    expect(await controller.runCommandForResult("todo", "T9")).toMatchObject({ status: "executed", value: "Opened T9" })
    expect(await controller.runCommandForResult("todo.answer", "T9 Switch to exponential backoff")).toMatchObject({ status: "executed", value: "Answered T9" })
    expect(seeded("T9").state).toBe("working")
    expect(await controller.runCommandForResult("todo.steer", "T10 Keep the old route")).toMatchObject({ status: "executed", value: "Steered T10" })
    expect(await controller.runCommandForResult("todo.stop", "T10")).toMatchObject({ status: "executed", value: "Stopped T10" })
    expect(await controller.runCommandForResult("todo.resume", "T10")).toMatchObject({ status: "executed", value: "Resumed T10" })
    expect(await controller.runCommandForResult("todo.retry", "T10")).toMatchObject({ status: "failed" })
    expect(seeded("T10").state).toBe("queued")
    await controller.runCommandForResult("todo.new")
    const draft = [...store.collections.cards.values()].find(row => row.kind === "draft") as DraftEntry
    for (const [field, value] of [["title", "Add a health endpoint"], ["prompt", "Serve GET /health."], ["acceptance", '["curl /health returns 200"]']] as const)
      expect(await controller.submitCommand({ name: "form.set", actor: "user", payload: { cardId: draft.id, field, value } })).toMatchObject({ status: "executed" })
    expect(await controller.submitCommand({ name: "todo.new", actor: "user", payload: { cardId: draft.id } })).toMatchObject({ status: "executed", value: "Committed as T12" })
    expect(seeded("T12").title).toBe("Add a health endpoint")
    expect(store.collections.cards.get("todo:12")?.payload).toEqual({ n: 12, requests: [] })
    const pr = designTodoCard(controller.design.world(), seeded("T8")).pr!
    expect(await controller.submitCommand({ name: "merge", actor: "user", payload: { n: 8, reviewed_head_sha: pr.head } })).toMatchObject({ status: "executed", value: `Merged #${pr.number}` })
    expect(seeded("T8").state).toBe("merged")
    expect(await controller.runCommandForResult("todo.drop", "T11")).toMatchObject({ status: "executed", value: "Dropped T11" })
    expect(h.calls).toEqual([{ path: "/api/todos", method: "GET" }])
  } finally { await controller.dispose() }
})

test("a configured host whose TODO provider fails shows the failure and never opens the seeded TODO", async () => {
  const h = await noProviderHost(500)
  try {
    await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    const before = JSON.stringify(h.controller.design.world().todos)
    // The first flow asks the host and is acknowledged at once; the provider's failure then shows on the toast stack.
    expect(await h.controller.runCommandForResult("todo", "T9")).toMatchObject({ status: "executed", value: "Requested" })
    const routed = () => [...h.store.collections.toasts.values()].filter(toast => toast.key.startsWith("todo.route:"))
    await waitFor(() => routed().some(toast => toast.status === "failed"))
    expect(routed().map(toast => [toast.status, toast.detail])).toEqual([["failed", "Could not open the TODO."]])
    expect(await h.controller.runCommandForResult("todo", "T9")).toMatchObject({ status: "failed" })
    expect(h.store.collections.cards.get("todo:9")).toBeUndefined()
    expect(await h.controller.runCommandForResult("todo.answer", "T9 Switch to exponential backoff")).toMatchObject({ status: "failed" })
    expect(JSON.stringify(h.controller.design.world().todos)).toBe(before)
    // A failing provider is asked again by the next flow; the only other requests are the TODO reads.
    expect(h.calls.filter(call => call.path !== "/api/todos")).toEqual([{ path: "/api/todos/9", method: "GET" }, { path: "/api/todos/9", method: "GET" }])
    expect(h.calls.filter(call => call.path === "/api/todos").length).toBeGreaterThan(1)
  } finally { await h.controller.dispose() }
})

/* A configured host whose GET /api/todos has not answered yet (#3466): `answer` settles it. */
const unansweredHost = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let answer!: (response: Response) => void
  const listed = new Promise<Response>(resolve => { answer = resolve })
  const calls: { path: string; method: string; body?: unknown }[] = []
  const controller = createAppController(store, unavailable, {
    bootstrap: { apiVersion: 1, host: "local", version: "design", buildSha: "0".repeat(40), capabilities: [], authFlow: "none", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "https://install.test").pathname
      if (!path.startsWith("/api/todos")) return new Response("{}", { status: 404 })
      calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
      if (path === "/api/todos" && !init?.method) return listed
      return Response.json(init?.method === "POST" ? { state: "accepted", n: 12 } : fixtures.in_review.model, { status: init?.method === "POST" ? 202 : 200 })
    }
  })
  const press = (name: string, payload: Record<string, unknown>) => controller.submitCommand({ name, payload, actor: "user" })
  return { store, controller, calls, answer, press }
}

test("before the host answers, TODO presses acknowledge at once, Chat keeps working, and each runs once, in order, on the seed when there is no provider", async () => {
  const h = await unansweredHost()
  const seeded = (ref: string) => h.controller.design.world().todos.find(each => each.ref === ref)!
  try {
    const before = JSON.stringify(h.controller.design.world().todos)
    const requested = { status: "executed", value: "Requested" }
    expect(await h.press("todo.steer", { n: 10, text: "Keep the old route" })).toMatchObject(requested)
    expect(await h.press("todo.steer", { n: 10, text: "Keep the old route" })).toMatchObject(requested)
    expect(await h.press("todo.stop", { n: 10 })).toMatchObject(requested)
    expect(await h.press("todo.resume", { n: 10 })).toMatchObject(requested)
    expect(await h.press("merge", { n: 8 })).toMatchObject(requested)
    h.controller.send("switch to dark mode")
    await waitFor(() => h.store.session().theme === "dark")
    expect(JSON.stringify(h.controller.design.world().todos)).toBe(before)
    expect(h.store.collections.cards.has("design:confirm:merge:t-stripe")).toBe(false)
    h.answer(Response.json({}, { status: 404 }))
    await waitFor(() => h.store.collections.cards.has("design:confirm:merge:t-stripe"))
    // One steer for two presses; stop ran before resume.
    expect(seeded("T10").steers).toEqual([{ by: "maya", text: "Keep the old route" }])
    expect(seeded("T10").state).toBe("queued")
    expect(seeded("T8").state).toBe("in-review")
    expect(h.calls).toEqual([{ path: "/api/todos", method: "GET" }])
  } finally { await h.controller.dispose() }
})

test("before the host answers, a press and a bare Merge acknowledge at once and reach the provider once; the bare Merge opens the TODO, never a seeded Review & merge", async () => {
  const h = await unansweredHost()
  try {
    await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    const before = JSON.stringify(h.controller.design.world().todos)
    const requested = { status: "executed", value: "Requested" }
    expect(await h.press("todo.steer", { n: 12, text: "Keep the old route" })).toMatchObject(requested)
    expect(await h.press("todo.steer", { n: 12, text: "Keep the old route" })).toMatchObject(requested)
    expect(await h.press("merge", { n: 12 })).toMatchObject(requested)
    expect(h.calls).toEqual([{ path: "/api/todos", method: "GET" }])
    h.answer(Response.json([fixtures.queued.model]))
    const todo = () => h.store.collections.cards.get("todo:12") as TodoEntry | undefined
    await waitFor(() => todo()?.payload.model?.state === "in_review" && h.calls.some(call => call.method === "POST"))
    expect(h.calls.filter(call => call.method === "POST")).toEqual([{ path: "/api/todos/12", method: "POST", body: { op: "steer", text: "Keep the old route" } }])
    expect(h.calls.some(call => call.path.endsWith("/merge"))).toBe(false)
    expect([...h.store.collections.cards.values()].some(card => card.kind === "confirm")).toBe(false)
    expect(JSON.stringify(h.controller.design.world().todos)).toBe(before)
  } finally { await h.controller.dispose() }
})
