import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, waitFor } from "../TestFixtures"
import { createBackgroundRunsSeam } from "./BackgroundRunsSeam"
import type { SeamContext } from "./SeamContext"

const failed = [{ id: "flow-load:3", title: "flow-load", state: "failed", detail: "import failed" }]
const harness = async (http: SeamContext["http"], ready = true) => {
 const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
 await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
 const completed: unknown[] = [], errors: unknown[] = []
 const ctx: SeamContext = { http, store, dispatch: store.dispatch, baseUrl: "https://install.test", actor: () => "user", nextOrdinal: store.nextOrdinal,
  report: (_subject, error) => { errors.push(error) },
  withToast: async (_key, _title, _done, work, _quiet, current) => { try { const value = await work(); if (current?.() !== false) completed.push("ok"); return value } catch (error) { completed.push("failed"); throw error } }
 }
 const seam = createBackgroundRunsSeam(ctx, { ready, pollMs: 10 })
 return { store, seam, completed, errors, ctx }
}

test("Home reads live failed rows, derives actions, removes dismissal after a refresh", async () => {
 let rows = failed
 const h = await harness(async (_url, init) => init?.method === "POST" ? (rows = [], Response.json({ state: "accepted" }, { status: 202 })) : Response.json(rows))
 const stop = h.seam.snapshots.subscribe(() => {})
 try {
  await waitFor(() => h.seam.snapshots.get()?.length === 1)
  expect(h.seam.snapshots.get()?.[0]?.actions.map(action => action.tag)).toEqual(["background.retry", "background.dismiss"])
  expect(h.seam.control("flow-load:3", "dismiss")).toEqual({ value: "Requested" })
  await waitFor(() => h.completed.length === 1)
  expect(h.seam.snapshots.get()).toEqual([])
 } finally { stop(); h.seam.dispose() }
})

test("Retry acknowledges unresolved admission, deduplicates presses, and settles only with execution", async () => {
 let release!: (response: Response) => void
 const admission = new Promise<Response>(done => { release = done })
 let phase = "running", posts = 0
 const h = await harness(async (url, init) => {
  if (init?.method === "POST") { posts++; expect(JSON.parse(String(init.body))).toEqual({ op: "retry" }); return admission }
  return url.endsWith("/api/runs") ? Response.json(failed) : Response.json({ state: phase })
 })
 try {
  expect(h.seam.control("flow-load:3", "retry")).toEqual({ value: "Requested" })
  expect(h.seam.control("flow-load:3", "retry")).toEqual({ value: "Requested" })
  expect(posts).toBe(1); expect(h.completed).toEqual([])
  release(Response.json({ state: "accepted" }, { status: 202 }))
  await new Promise(done => setTimeout(done, 30))
  expect(h.completed).toEqual([])
  phase = "succeeded"
  await waitFor(() => h.completed.length === 1)
  expect(h.completed).toEqual(["ok"])
 } finally { h.seam.dispose() }
})

test("HTTP refusal and a failed or cancelled retry remain failures", async () => {
 for (const state of ["refused", "failed", "cancelled"]) {
  const h = await harness(async (url, init) => init?.method === "POST"
   ? Response.json({}, { status: state === "refused" ? 403 : 202 }) : url.endsWith("/api/runs") ? Response.json([]) : Response.json({ state, detail: "import failed" }))
  try { h.seam.control("1", "retry"); await waitFor(() => h.completed.length === 1); expect(h.completed).toEqual(["failed"]) } finally { h.seam.dispose() }
 }
})

test("a malformed read keeps the last rows, but authorization refusal clears them", async () => {
 let response = Response.json(failed)
 const h = await harness(async () => response.clone())
 try {
  await h.seam.read(); expect(h.seam.snapshots.get()).toHaveLength(1)
  response = Response.json([{ id: "1", title: "wrong", state: "succeeded" }]); await h.seam.read(); expect(h.seam.snapshots.get()).toHaveLength(1)
  response = Response.json({}, { status: 403 }); await h.seam.read(); expect(h.seam.snapshots.get()).toBeUndefined()
 } finally { h.seam.dispose() }
})

test("dispose cancels pending reads and never publishes an old identity's rows", async () => {
 let release!: (response: Response) => void
 const pending = new Promise<Response>(done => { release = done })
 const h = await harness(async () => pending)
 const read = h.seam.read(); h.seam.dispose(); release(Response.json(failed)); await read
 expect(h.seam.snapshots.get()).toBeUndefined()
 const other = await harness(async () => Response.json(failed))
 const oldRead = other.seam.read()
 await other.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
 await oldRead; expect(other.seam.snapshots.get()).toBeUndefined(); other.seam.dispose()
})

test("a non-install host makes no API call and keeps the design fallback", async () => {
 let calls = 0
 const h = await harness(async () => { calls++; return Response.json([]) }, false)
 const stop = h.seam.snapshots.subscribe(() => {})
 await h.seam.read(); expect(h.seam.control("1", "retry")).toBe("Background runs unavailable"); expect(calls).toBe(0)
 stop(); h.seam.dispose()
})


test("reload reconnects a durable retry toast using the source id's server receipt", async () => {
 let posts = 0
 const h = await harness(async (url, init) => {
  if (init?.method === "POST") { posts++; return Response.json({ state: "accepted", retry_id: "2" }, { status: 202 }) }
  return url.endsWith("/api/runs") ? Response.json([]) : Response.json({ state: "succeeded" })
 })
 h.seam.dispose()
 await h.store.dispatch({ type: "toast.shown", actor: "system", key: "background.retry:1", title: "Retry background run" }).isPersisted.promise
 const recovered = createBackgroundRunsSeam(h.ctx, { ready: true, pollMs: 10 })
 try { await waitFor(() => h.completed.length === 1); expect(posts).toBe(1); expect(h.completed).toEqual(["ok"]) } finally { recovered.dispose() }
})
