import { describe, expect, test } from "bun:test"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { DraftCardSchema } from "@smthrs/rpc/DraftCard"
import { createAppStore } from "../../AppStore"
import { memoryStorage, waitFor } from "../../TestFixtures"
import type { SeamContext } from "../SeamContext"
import { createTodoSeam, type DraftEntry, type TodoEntry } from "../TodoSeam"
import { createDesignWorld, MAYA, type DesignTimers } from "./index"
import { designAudience, designTodoCard, todoSourceProbe, withDesignTodos, type TodoSource } from "./todo"

/** Timers that never fire: the seed's script stays where the mutation left it. */
const stillTimers: DesignTimers = { set: () => 0, clear: () => {} }

/** The controller's wiring, signed out: no identity row, no topics, no HTTP. */
const harness = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const context: SeamContext = {
    http: () => Promise.reject(new Error("no backend")), store, dispatch: store.dispatch, baseUrl: "http://localhost:5174",
    actor: () => "user", nextOrdinal: store.nextOrdinal, isDisposed: () => false
  }
  const design = createDesignWorld({ timers: stillTimers, viewer: MAYA })
  const seam = withDesignTodos(createTodoSeam(context, { debounceMs: 1, onDispose: () => {} }), context, design)
  const todo = (n: number) => store.collections.cards.get(`todo:${n}`) as TodoEntry | undefined
  const drafts = (): DraftEntry[] => [...store.collections.cards.values()].flatMap(row => row.kind === "draft" ? [row as DraftEntry] : [])
  const seeded = (ref: string) => design.world().todos.find(each => each.ref === ref)!
  return { store, design, seam, todo, drafts, seeded }
}

describe("withDesignTodos (mock seam): todo.* and draft.* land on the seed, signed out", () => {
  test("every seeded TODO projects to a TodoCard the wire accepts", async () => {
    const { design } = await harness()
    const world = design.world()
    for (const item of world.todos) expect(() => TodoCardSchema.parse(designTodoCard(world, item))).not.toThrow()
    const asking = designTodoCard(world, world.todos.find(each => each.ref === "T9")!)
    expect(asking.state).toBe("needs_you")
    expect(asking.waits.map(wait => wait.actions.map(action => action.tag))).toEqual([["todo.answer"]])
  })

  test("todo opens the Tn card without a session; an unknown number refuses by name", async () => {
    const h = await harness()
    expect(h.store.collections.identitySessions.get("identity")?.state).not.toBe("signed-in")
    expect(await h.seam.showTodo(9)).toEqual({ value: "Opened T9" })
    expect(h.todo(9)?.payload).toEqual({ n: 9, requests: [] })
    const ordinal = h.todo(9)!.ordinal
    expect(await h.seam.showTodo(9)).toEqual({ value: "Opened T9" })
    expect(h.todo(9)!.ordinal).toBe(ordinal)
    expect(await h.seam.showTodo(99)).toBe("No TODO T99")
    expect(h.todo(99)).toBeUndefined()
  })

  test("todo.answer and todo.steer reach the seed as the viewer", async () => {
    const h = await harness()
    expect(await h.seam.answerTodo(9, "Use the Stripe test clock")).toEqual({ value: "Answered T9" })
    expect(h.seeded("T9").question?.answer).toEqual({ by: MAYA, text: "Use the Stripe test clock" })
    expect(h.seeded("T9").state).not.toBe("needs-you")
    expect(typeof await h.seam.answerTodo(9, "again")).toBe("string")
    expect(await h.seam.steerTodo(10, "Keep the old route")).toEqual({ value: "Steered T10" })
    expect(h.seeded("T10").steers).toEqual([{ by: MAYA, text: "Keep the old route" }])
    expect(await h.seam.steerTodo(99, "nobody")).toBe("No TODO T99")
    expect(await h.seam.answerTodo(99, "nobody")).toBe("No TODO T99")
  })

  test("todo.stop, resume, retry and drop follow the seed's state rules", async () => {
    const h = await harness()
    expect(await h.seam.controlTodo(10, "retry")).toBe("Only failed TODOs retry")
    expect(await h.seam.controlTodo(10, "stop")).toEqual({ value: "Stopped T10" })
    expect(h.seeded("T10").state).toBe("paused")
    expect(await h.seam.controlTodo(10, "resume")).toEqual({ value: "Resumed T10" })
    expect(h.seeded("T10").state).toBe("queued")
    expect(await h.seam.controlTodo(11, "drop")).toEqual({ value: "Dropped T11" })
    expect(h.seeded("T11").state).toBe("dropped")
    expect(await h.seam.controlTodo(11, "drop")).toBe("Only unmerged TODOs drop")
    expect(await h.seam.controlTodo(99, "stop")).toBe("No TODO T99")
  })

  test("todo.new drafts privately, edits land on the seed, and Commit opens the new TODO", async () => {
    const h = await harness()
    expect(await h.seam.newTodo({})).toEqual({ value: "Drafted" })
    const draft = h.drafts()[0]!
    expect(draft.audience_member_id).toBe(designAudience(MAYA))
    expect(draft.title).toBe("New TODO")
    expect(draft.payload.private).toBe(true)
    expect(await h.seam.setTodoFormField(draft.id, "title", "Retry webhooks")).toBeUndefined()
    expect(await h.seam.setTodoFormField(draft.id, "prompt", "Retry failed webhooks three times.")).toBeUndefined()
    expect(await h.seam.setTodoFormField(draft.id, "acceptance", "Backoff doubles\nStops after three")).toBeUndefined()
    expect(await h.seam.setTodoFormField(draft.id, "place", JSON.stringify({ mode: "before", n: 11 }))).toBeUndefined()
    expect(await h.seam.setTodoFormField(draft.id, "colour", "red")).toBe("Unknown draft field.")
    const edited = DraftCardSchema.parse(h.drafts()[0]!.payload)
    expect([edited.title, edited.prompt, edited.acceptance, edited.place.mode]).toEqual(
      ["Retry webhooks", "Retry failed webhooks three times.", ["Backoff doubles", "Stops after three"], "before"])
    expect(await h.seam.newTodo({ text: "stale", cardId: draft.id })).toEqual({ value: "Committed as T12" })
    expect(h.todo(12)?.payload).toEqual({ n: 12, requests: [] })
    expect(h.drafts()[0]!.audience_member_id).toBeNull()
    expect(h.drafts()[0]!.payload.committed).toEqual({ n: 12, rev: 1 })
    const stack = h.design.world().repo.stack
    expect(stack.indexOf("t-t12")).toBe(stack.indexOf(h.seeded("T11").id) - 1)
    expect(await h.seam.newTodo({ text: "again", cardId: draft.id })).toBe("Already committed")
    expect(await h.seam.newTodo({ text: "x", cardId: "draft:nope" })).toBe("No such draft")
  })

  test("an amend-placed draft commits through todo.amend; discard removes the card", async () => {
    const h = await harness()
    expect(await h.seam.newTodo({ text: "Also log the retry count" })).toEqual({ value: "Drafted" })
    const draft = h.drafts()[0]!
    expect(draft.title).toBe("Also log the retry count")
    expect(await h.seam.setTodoFormField(draft.id, "place", JSON.stringify({ mode: "amend", n: 10 }))).toBeUndefined()
    expect(await h.seam.amendTodo({ n: 10, text: "stale", cardId: draft.id })).toEqual({ value: "Amended T10" })
    expect(h.seeded("T10").amendments).toEqual([{ by: MAYA, text: "Also log the retry count" }])
    expect(await h.seam.amendTodo({ n: 11, text: "Add a flag" })).toEqual({ value: "Amended T11" })
    expect(await h.seam.amendTodo({ n: 99, text: "Add a flag" })).toBe("No TODO T99")
    expect(await h.seam.newTodo({ text: "throwaway" })).toEqual({ value: "Drafted" })
    const second = h.drafts().find(row => row.id !== draft.id)!
    expect(h.seam.dismissTodoDraft(second.id)).toBeUndefined()
    expect(h.drafts().map(row => row.id)).toEqual([draft.id])
    expect(h.seam.dismissTodoDraft(second.id)).toBe("No such draft")
  })
})

/** A context whose HTTP answers every route with `answer` and records each request. */
const probeContext = (answer: (url: string, init?: RequestInit) => Promise<Response>) => {
  const calls: { url: string; method: string }[] = []
  const context = { baseUrl: "https://install.test",
    http: (url: string, init?: RequestInit) => { calls.push({ url, method: init?.method ?? "GET" }); return answer(url, init) } } as unknown as SeamContext
  return { context, calls }
}
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))

describe("todoSourceProbe: the seed stands in only where this host has no TODO provider", () => {
  test("no bootstrap is the seed without a request", async () => {
    const h = probeContext(() => json([]))
    expect(await todoSourceProbe(h.context, false)()).toBe("seed")
    expect(h.calls).toEqual([])
  })

  test("a 404 or a page that is not JSON is the seed; JSON, a refusal or an error is the provider", async () => {
    const cases: ReadonlyArray<readonly [() => Promise<Response>, TodoSource]> = [
      [() => json({}, 404), "seed"],
      [() => Promise.resolve(new Response("<!doctype html><title>Smithers</title>", { status: 200 })), "seed"],
      [() => json([]), "real"],
      [() => json({ code: "unauthenticated", message: "Sign in" }, 401), "real"],
      [() => json({ code: "forbidden", class: "permission", message: "No access" }, 403), "real"],
      [() => json({ code: "internal", class: "infra", message: "Down" }, 500), "real"]
    ]
    for (const [answer, expected] of cases) {
      const h = probeContext(answer)
      expect(await todoSourceProbe(h.context, true)()).toBe(expected)
      expect(h.calls).toEqual([{ url: "https://install.test/api/todos", method: "GET" }])
    }
  })

  test("the answer is read once; an unreachable provider is real and asked again", async () => {
    const answered = probeContext(() => json({}, 404))
    const source = todoSourceProbe(answered.context, true)
    expect([await source(), await source(), await source()]).toEqual(["seed", "seed", "seed"])
    expect(answered.calls).toHaveLength(1)
    let reachable = false
    const flaky = probeContext(() => reachable ? json({}, 404) : Promise.reject(new TypeError("Failed to fetch")))
    const retried = todoSourceProbe(flaky.context, true)
    expect(await retried()).toBe("real")
    reachable = true
    expect(await retried()).toBe("seed")
    expect(await retried()).toBe("seed")
    expect(flaky.calls).toHaveLength(2)
  })
})

/** The controller's wiring on a configured host, signed in as ben: the real seam beside the seed, `source` deciding. */
const hostHarness = async (source: () => TodoSource, answer: (url: string, init?: RequestInit) => Promise<Response>) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  const calls: { url: string; method: string; body?: unknown }[] = []
  const subscribed: string[] = []
  const context: SeamContext = {
    http: (url, init) => { calls.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) }); return answer(url, init) },
    store, dispatch: store.dispatch, baseUrl: "https://install.test", actor: () => "user", nextOrdinal: store.nextOrdinal, isDisposed: () => false
  }
  const finalizers: (() => void)[] = []
  const design = createDesignWorld({ timers: stillTimers, viewer: MAYA })
  const real = createTodoSeam(context, { debounceMs: 1, onDispose: stop => finalizers.push(stop),
    topics: { subscribe: topic => { subscribed.push(topic); return () => {} } } })
  const seam = withDesignTodos(real, context, design, () => Promise.resolve(source()))
  const drafts = (): DraftEntry[] => [...store.collections.cards.values()].flatMap(row => row.kind === "draft" ? [row as DraftEntry] : [])
  return { store, design, seam, calls, subscribed, drafts, close: () => { for (const stop of finalizers) stop() },
    todo: (n: number) => store.collections.cards.get(`todo:${n}`) as TodoEntry | undefined,
    seeded: (ref: string) => design.world().todos.find(each => each.ref === ref)! }
}

describe("withDesignTodos beside the provider: the source picks the seed or the install routes", () => {
  test("signed in on a host with no provider, every flow lands on the seed and no TODO route is called", async () => {
    const h = await hostHarness(() => "seed", () => json({}, 404))
    try {
      expect(await h.seam.showTodo(9)).toEqual({ value: "Opened T9" })
      expect(h.todo(9)?.payload).toEqual({ n: 9, requests: [] })
      expect(await h.seam.answerTodo(9, "Use exponential backoff")).toEqual({ value: "Answered T9" })
      expect(h.seeded("T9").state).toBe("working")
      expect(await h.seam.steerTodo(10, "Keep the old route")).toEqual({ value: "Steered T10" })
      expect(await h.seam.controlTodo(10, "stop")).toEqual({ value: "Stopped T10" })
      expect(await h.seam.controlTodo(10, "resume")).toEqual({ value: "Resumed T10" })
      expect(await h.seam.newTodo({ text: "Add a health endpoint" })).toEqual({ value: "Drafted" })
      const draft = h.drafts()[0]!
      expect(draft.audience_member_id).toBe(designAudience(MAYA))
      expect(await h.seam.newTodo({ cardId: draft.id })).toEqual({ value: "Committed as T12" })
      expect(h.seeded("T12").title).toBe("Add a health endpoint")
      // The real seam's resume follows only rows it fetched or requested, so seeded rows never poll /api/todos/{n}.
      h.seam.resumeTodos()
      expect(h.subscribed).toEqual([])
      expect(h.calls).toEqual([])
    } finally { h.close() }
  })

  test("a seed Merge bound to the reviewed head merges the seeded TODO; a moved head refuses", async () => {
    const h = await hostHarness(() => "seed", () => json({}, 404))
    try {
      const pr = designTodoCard(h.design.world(), h.seeded("T8")).pr!
      expect(await h.seam.mergeTodo(8, "0000000")).toBe("The PR changed since you reviewed it")
      expect(h.seeded("T8").state).toBe("in-review")
      expect(await h.seam.mergeTodo(8, pr.head)).toEqual({ value: `Merged #${pr.number}` })
      expect(h.seeded("T8").state).toBe("merged")
      expect(await h.seam.mergeTodo(99, pr.head)).toBe("No TODO T99")
      expect(h.calls).toEqual([])
    } finally { h.close() }
  })

  test("a provider that fails shows its failure: no seeded TODO is opened or changed", async () => {
    const h = await hostHarness(() => "real", () => json({ code: "internal", class: "infra", message: "Stack unavailable" }, 500))
    try {
      const before = JSON.stringify(h.design.world().todos)
      expect(await h.seam.showTodo(9)).toBe("Could not open the TODO.")
      expect(h.todo(9)).toBeUndefined()
      expect(await h.seam.answerTodo(9, "Use exponential backoff")).toBe("Choose an open wait.")
      expect(await h.seam.steerTodo(10, "Keep the old route")).toEqual({ value: "Requested" })
      expect(await h.seam.controlTodo(10, "stop")).toEqual({ value: "Requested" })
      expect(await h.seam.mergeTodo(8, "abc1234")).toEqual({ value: "Requested" })
      await waitFor(() => (h.todo(8)?.payload.requests[0]?.state === "failed") && h.todo(10)?.payload.requests.every(request => request.state === "failed") === true)
      expect(h.todo(10)?.payload.requests.map(request => [request.operation, request.state, request.error]).sort())
        .toEqual([["steer", "failed", "Stack unavailable Not your fault."], ["stop", "failed", "Stack unavailable Not your fault."]])
      expect(h.todo(8)?.payload.requests.map(request => [request.operation, request.state, request.error]))
        .toEqual([["merge", "failed", "Stack unavailable Not your fault."]])
      expect(h.calls.filter(call => call.method !== "GET")).toEqual([
        { url: "https://install.test/api/todos/10", method: "POST", body: { op: "steer", text: "Keep the old route" } },
        { url: "https://install.test/api/todos/10", method: "POST", body: { op: "stop" } },
        { url: "https://install.test/api/todos/8/merge", method: "POST", body: { reviewed_head_sha: "abc1234" } }
      ])
      expect(await h.seam.newTodo({ text: "Real prompt" })).toEqual({ value: "Drafted" })
      expect(h.drafts()[0]!.audience_member_id).toBe("ben")
      expect(JSON.stringify(h.design.world().todos)).toBe(before)
    } finally { h.close() }
  })

  test("a seeded Draft stays on the seed after the provider appears; a provider Draft never reaches the seed", async () => {
    let source: TodoSource = "seed"
    const h = await hostHarness(() => source, (_url, init) => init?.method ? json({ state: "accepted", n: 13 }, 202) : json({ code: "internal", class: "infra", message: "Down" }, 500))
    try {
      expect(await h.seam.newTodo({ text: "Seeded draft" })).toEqual({ value: "Drafted" })
      const seeded = h.drafts()[0]!
      source = "real"
      expect(await h.seam.setTodoFormField(seeded.id, "title", "Seeded title")).toBeUndefined()
      expect(h.design.world().drafts.find(each => `draft:${each.id}` === seeded.id)?.title).toBe("Seeded title")
      expect(await h.seam.newTodo({ cardId: seeded.id })).toEqual({ value: "Committed as T12" })
      expect(await h.seam.newTodo({ text: "Provider draft" })).toEqual({ value: "Drafted" })
      const provider = h.drafts().find(row => row.id !== seeded.id)!
      expect(provider.audience_member_id).toBe("ben")
      await waitFor(() => (h.store.collections.cards.get(provider.id) as DraftEntry).payload.optionsFailure === "Could not load TODO placement.")
      expect(await h.seam.setTodoFormField(provider.id, "title", "Provider title")).toBeUndefined()
      expect((h.store.collections.cards.get(provider.id) as DraftEntry).payload.title).toBe("Provider title")
      expect(h.seam.dismissTodoDraft(provider.id)).toBeUndefined()
      expect(h.store.collections.cards.has(provider.id)).toBe(false)
      expect(h.seam.dismissTodoDraft(provider.id)).toBe("No such draft")
      expect(h.design.world().drafts.filter(each => each.by === MAYA).map(each => each.title)).toEqual(["Seeded title"])
      expect(h.calls).toEqual([{ url: "https://install.test/api/todos", method: "GET" }])
    } finally { h.close() }
  })
})
