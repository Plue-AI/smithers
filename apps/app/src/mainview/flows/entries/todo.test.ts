import { expect, test } from "bun:test"
import { Schema } from "effect"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch, waitFor } from "../../state/TestFixtures"
import type { DraftEntry } from "../../state/seams/TodoSeam"
import { fixtures } from "../../../../../../packages/rpc/test/fixtures/Todo"
import { modelInvocable, nameOf } from "../registry"
import { TodoNewInput, todoGrammar } from "./todo"
import { answerActions } from "../AnswerActions"

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
    expect(entries.map(nameOf).sort()).toEqual(["todo", "todo.amend", "todo.answer", "todo.drop", "todo.new", "todo.resume", "todo.retry", "todo.steer", "todo.stop"])
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
    await h.controller.runCommandForResult("todo.new")
    expect([...h.store.collections.cards.values()].filter(row => row.kind === "flow-form")).toHaveLength(2)
  } finally { h.controller.dispose() }
})
test("slash and typed button use the same TODO command; form.set persists the Draft", async () => {
  const h = await boot()
  try {
    await h.controller.runCommandForResult("todo.steer", "T12 Keep whitespace")
    await h.controller.submitCommand({ name: "todo.steer", actor: "user", payload: { n: 12, text: "A second steer" }, display: JSON.stringify({ n: 12, text: "A second steer" }) })
    await waitFor(() => h.mutations.length === 2)
    expect(h.mutations).toEqual([{ path: "/api/todos/12/steer", body: { text: "Keep whitespace" } }, { path: "/api/todos/12/steer", body: { text: "A second steer" } }])
    await h.controller.runCommandForResult("todo.new", "A prompt")
    const draft = [...h.store.collections.cards.values()].find(row => row.kind === "draft") as DraftEntry
    await h.controller.submitCommand({ name: "form.set", actor: "user", payload: { cardId: draft.id, field: "prompt", value: "Changed\nverbatim" }, display: `${draft.id} prompt Changed\nverbatim` })
    expect((h.store.collections.cards.get(draft.id) as DraftEntry).payload.prompt).toBe("Changed\nverbatim")
  } finally { h.controller.dispose() }
})
test("TODO grammar and schema retain JSON whitespace, reject invalid numbers and keep missing fields", () => {
  const parse = todoGrammar("answer")
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
