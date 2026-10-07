import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, waitFor } from "../TestFixtures"
import { createOrderAttentionSeam } from "./OrderAttentionSeam"
import type { SeamContext } from "./SeamContext"
const boot = async (http: SeamContext["http"], storage = memoryStorage()) => {
 const store = await createAppStore({ kind: "localStorage", storage })
 await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
 const ctx: SeamContext = { http, store, dispatch: store.dispatch, baseUrl: "https://install.test/", actor: () => "user", nextOrdinal: store.nextOrdinal }
 return { store, storage, ctx, seam: createOrderAttentionSeam(ctx) }
}
test("OK persists the displayed revision and acknowledges before an unresolved HTTP request; duplicates send once", async () => {
 let resolve!: (response: Response) => void
 const calls: unknown[] = []
 const h = await boot(async (url, init) => { calls.push([url, init?.body]); return new Promise(done => { resolve = done }) })
 expect(await h.seam.orderOK("order-3", 2)).toEqual({ value: "Requested" })
 expect(await h.seam.orderOK("order-3", 2)).toEqual({ value: "Requested" })
 expect(calls).toEqual([["https://install.test/api/stack/attention/order-3", '{"revision":2}']])
 expect(h.store.session().orderRequests?.[0]?.state).toBe("requested")
 resolve(new Response(null, { status: 204 }))
 await waitFor(() => h.store.session().orderRequests?.[0]?.state === "completed")
 expect(await h.seam.orderOK("order-3", 2)).toEqual({ value: "Acknowledged" })
 expect(calls).toHaveLength(1)
})
test("a stale revision remains a visible failure and a new revision is a distinct request", async () => {
 const h = await boot(async (_url, init) => JSON.parse(String(init?.body)).revision === 1
  ? Response.json({ class: "conflict", code: "stale_attention", message: "The attention changed; review it again" }, { status: 409 })
  : new Response(null, { status: 204 }))
 await h.seam.orderOK("order-3", 1)
 await waitFor(() => h.store.session().orderRequests?.[0]?.state === "failed")
 expect(h.store.session().orderRequests?.[0]?.error).toContain("attention changed")
 await h.seam.orderOK("order-3", 2)
 await waitFor(() => h.store.session().orderRequests?.[1]?.state === "completed")
})
test("reload resumes only the current person's durable request and a stale response cannot settle it", async () => {
 let resolve!: (response: Response) => void
 const h = await boot(async () => new Promise(done => { resolve = done }))
 await h.seam.orderOK("order-3", 1)
 await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
 resolve(new Response(null, { status: 204 }))
 await new Promise(done => setTimeout(done, 5))
 expect(h.store.session().orderRequests?.[0]?.state).toBe("requested")
 let calls = 0
 const restored = createOrderAttentionSeam({ ...h.ctx, http: async () => { calls++; return new Response(null, { status: 204 }) } })
 restored.resume()
 expect(calls).toBe(0)
 await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
 restored.resume()
 await waitFor(() => h.store.session().orderRequests?.[0]?.state === "completed")
 expect(calls).toBe(1)
})
