import { expect, test } from "bun:test"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import { json, memoryStorage, silentAgent } from "../TestFixtures"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const identity = (store: Awaited<ReturnType<typeof createAppStore>>, login: string) => store.dispatch({
  type: "identity.session.loaded", actor: "system", state: "signed-in", login,
  admin: false, scopesPlain: null
}).isPersisted.promise

const fixture = async (answer: () => Promise<Response>, services: Pick<AppServices, "baseUrl"> = {}, storage = memoryStorage(), refuseCleanup = false) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await identity(store, "alice")
  let requests = 0
  const outcomes: unknown[] = []
  const guarded = refuseCleanup ? new Proxy(store, { get: (target, key, receiver) => key === "dispatch"
    ? (transition: Parameters<typeof store.dispatch>[0]) => {
      if (transition.type === "identity.session.cleared") throw new Error("privacy cleanup refused")
      return store.dispatch(transition)
    } : Reflect.get(target, key, receiver) }) : store
  const controller = createAppController(guarded, silentAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    // Tests invoke the flow explicitly; material notifications cannot race the gates.
    recommender: { enabled: true, debounceMs: 60_000 },
    ...services,
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/api/recommend/outcome")) {
        outcomes.push(JSON.parse(String(init?.body)))
        return new Response(null, { status: 204 })
      }
      if (String(input).endsWith("/api/auth/logout")) return json(200, { ok: true })
      if (!String(input).endsWith("/api/recommend")) return json(404, {})
      requests++
      return answer()
    }
  })
  return {
    store, controller, outcomes, requests: () => requests,
    row: () => store.collections.recommendations.get("current"),
    close: async () => { await controller.dispose(); await store.dispose?.() }
  }
}

const heldBody = (status: number, body: unknown) => {
  const entered = deferred<void>()
  const release = deferred<void>()
  const response = new Response(null, { status })
  Object.defineProperty(response, "json", { value: async () => {
    entered.resolve(); await release.promise; return body
  } })
  return { response, entered: entered.promise, release: () => release.resolve() }
}

for (const status of [200, 429]) {
  test(`an account replacement during a ${status} body read cannot publish the old account's answer`, async () => {
    const held = heldBody(status, status === 429
      ? { retryAt: new Date(Date.now() + 3_600_000).toISOString() }
      : { id: "alice-answer", commands: ["wiki"], model: "fixture" })
    let first = true
    const h = await fixture(async () => {
      if (first) { first = false; return held.response }
      return json(200, { id: "bob-answer", commands: ["wiki"], model: "fixture" })
    })
    try {
      const reading = h.controller.recommend()
      await held.entered
      await identity(h.store, "bob")
      // No new recommendation sequence: ownership must fence this by itself.
      held.release()
      await reading
      expect(h.row()?.retry).toBeUndefined()
      expect(h.row()?.source).not.toBe("agent")
      await h.controller.recommend()
      expect(h.requests()).toBe(2)
      expect(h.row()?.source).toBe("agent")
    } finally { held.release(); await h.close() }
  })
}

test("same-owner regeneration updates rules while sharing an unresolved request, and a refusal releases it", async () => {
  const started = deferred<void>()
  const response = deferred<Response>()
  let first = true
  const h = await fixture(async () => {
    if (first) { first = false; started.resolve(); return response.promise }
    return json(200, { id: "after-refusal", commands: ["wiki"], model: "fixture" })
  })
  try {
    const reading = h.controller.recommend()
    await started.promise
    for (let n = 0; n < 3; n++) {
      await h.store.dispatch({ type: "tab.opened", actor: "user", tab: {
        id: `tab-${n}`, kind: "card", title: "Pinned", cardId: `card-${n}`
      } }).isPersisted.promise
      const revision = h.store.session().revision
      await h.controller.recommend()
      expect(h.row()?.source).toBe("rule")
      expect(h.row()?.revision).toBe(revision)
    }
    expect(h.requests()).toBe(1)
    response.resolve(json(503, {}))
    await reading
    await h.controller.recommend()
    expect(h.requests()).toBe(2)
    expect(h.row()?.source).toBe("agent")
  } finally { response.resolve(json(503, {})); await h.close() }
})

test("a same-owner quota response still closes the bucket after a newer rule-only revision", async () => {
  const retryAt = Date.now() + 3_600_000
  const held = heldBody(429, { retryAt: new Date(retryAt).toISOString() })
  const h = await fixture(async () => held.response)
  try {
    const reading = h.controller.recommend()
    await held.entered
    await h.controller.recommend()
    expect(h.requests()).toBe(1)
    held.release()
    await reading
    expect(h.row()?.retry).toEqual({ owner: "alice", at: retryAt, origin: "same-origin" })
    await h.controller.recommend()
    expect(h.requests()).toBe(1)
    expect(h.row()?.source).toBe("rule")
  } finally { held.release(); await h.close() }
})

test("an old owner's settlement cannot release the new owner's unresolved request", async () => {
  const firstStarted = deferred<void>(), secondStarted = deferred<void>()
  const first = deferred<Response>(), second = deferred<Response>()
  let calls = 0
  const h = await fixture(async () => {
    calls++
    if (calls === 1) { firstStarted.resolve(); return first.promise }
    if (calls === 2) { secondStarted.resolve(); return second.promise }
    return json(503, {})
  })
  try {
    const alice = h.controller.recommend()
    await firstStarted.promise
    await identity(h.store, "bob")
    const bob = h.controller.recommend()
    await secondStarted.promise
    first.resolve(json(503, {}))
    await alice
    await h.controller.recommend()
    expect(h.requests()).toBe(2)
    second.resolve(json(503, {}))
    await bob
    await h.controller.recommend()
    expect(h.requests()).toBe(3)
  } finally { first.resolve(json(503, {})); second.resolve(json(503, {})); await h.close() }
})

test("a persisted cooldown matches normalized service origin and does not close a different host", async () => {
  const storage = memoryStorage()
  const retryAt = Date.now() + 3_600_000
  const first = await fixture(async () => json(429, { retryAt: new Date(retryAt).toISOString() }), { baseUrl: "https://ALPHA.example:443" }, storage)
  try {
    await first.controller.recommend()
    await first.store.settled?.()
    expect(first.row()?.retry).toEqual({ at: retryAt, owner: "alice", origin: "https://alpha.example" })
  } finally { await first.close() }
  const same = await fixture(async () => json(503, {}), { baseUrl: "https://alpha.example" }, storage)
  try {
    await same.controller.recommend()
    expect(same.requests()).toBe(0)
    expect(same.row()?.source).toBe("rule")
  } finally { await same.close() }
  const different = await fixture(async () => json(503, {}), { baseUrl: "https://beta.example" }, storage)
  try {
    await different.controller.recommend()
    expect(different.requests()).toBe(1)
  } finally { await different.close() }
})

for (const change of ["replacement", "failed-cleanup"] as const) {
  test(`a recommendation outcome cannot cross account ${change}`, async () => {
    let answers = 0
    const h = await fixture(async () => json(200, { id: `answer-${++answers}`, commands: ["wiki"], model: "fixture" }), {}, memoryStorage(), change === "failed-cleanup")
    try {
      await h.controller.recommend()
      expect(h.row()?.source).toBe("agent")
      if (change === "replacement") await identity(h.store, "bob")
      else {
        expect(await h.controller.signOut()).toContain("Signed out. Smithers could not finish clearing this browser's data.")
        expect(h.store.collections.identitySessions.get("identity")?.login).toBe("alice")
      }
      await h.controller.commands.run("chat.commands")
      expect(h.outcomes).toEqual([])
      // The new owner/epoch may still report its own later answer exactly once.
      await h.controller.recommend()
      await h.controller.commands.run("chat.commands")
      await h.controller.commands.run("chat.commands")
      expect(h.outcomes).toEqual([{ id: "answer-2", command: "chat.commands" }])
    } finally { await h.close() }
  })
}

/** The recommend seat: every /api/recommend body this controller posts. */
const seatFixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await identity(store, "alice")
  const bodies: Array<Record<string, unknown>> = []
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    recommender: { enabled: true, debounceMs: 60_000 },
    fetchImpl: async (input, init) => {
      if (!String(input).endsWith("/api/recommend")) return json(404, {})
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return json(200, { id: `answer-${bodies.length}`, commands: ["wiki"], model: "fixture" })
    }
  })
  const assign = async (recordId: string | null) => {
    await store.dispatch({ type: "model.saved", actor: "user", model: { id: "jev", protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" } }).isPersisted.promise
    await store.dispatch({ type: "seat.assigned", actor: "user", seat: "recommend", recordId }).isPersisted.promise
  }
  return { controller, bodies, assign, close: async () => { await controller.dispose(); await store.dispose?.() } }
}

test("an unassigned recommend seat posts the body it always posted; an assigned one adds the decision model and nothing else", async () => {
  const h = await seatFixture()
  try {
    await h.controller.recommend()
    await h.assign("jev")
    await h.controller.recommend()
    await h.assign(null)
    await h.controller.recommend()
    expect(h.bodies).toHaveLength(3)
    const [bare, bound, again] = h.bodies
    expect(Object.keys(bare!).sort()).toEqual(["commands", "repo", "tail"])
    expect(bound!.model).toEqual({ protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" })
    const { model: _model, ...rest } = bound!
    expect(rest).toEqual(bare!)
    expect(again).toEqual(bare!)
  } finally { await h.close() }
})
