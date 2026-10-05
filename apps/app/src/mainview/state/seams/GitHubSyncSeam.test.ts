import { expect, test } from "bun:test"
import { waitFor } from "../TestFixtures"
import { createGitHubSyncSeam } from "./GitHubSyncSeam"

const FRESH = { state: "fresh", last_success_at: "2026-10-05T08:00:00Z" } as const
const STALE = { state: "stale", last_success_at: "2026-10-05T07:50:00Z" } as const
const host = (answers: Array<Response | Error>) => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const http = async (path: string, init?: RequestInit) => {
    calls.push({ path, ...(init ? { init } : {}) })
    const next = answers.length > 1 ? answers.shift()! : answers[0]!
    if (next instanceof Error) throw next
    return next.clone()
  }
  return { http, calls, answers }
}

test("reads only while subscribed, every pollMs, and stops with the last subscriber", async () => {
  const h = host([Response.json(STALE), Response.json(FRESH)])
  const seam = createGitHubSyncSeam({ http: h.http, pollMs: 20 })
  try {
    expect(h.calls).toEqual([])
    const seen: unknown[] = []
    const stop = seam.snapshots.subscribe(() => { seen.push(seam.snapshots.get()) })
    await waitFor(() => seam.snapshots.get()?.state === "fresh")
    expect(seen.slice(0, 2)).toEqual([STALE, FRESH])
    expect(h.calls.every(call => call.path === "/api/github/sync" && call.init?.method === undefined)).toBe(true)
    stop()
    const reads = h.calls.length
    await new Promise(done => setTimeout(done, 60))
    expect(h.calls).toHaveLength(reads)
  } finally { seam.dispose() }
})

test("a host that serves no sync has no health; an unreachable one keeps the last", async () => {
  const h = host([Response.json(FRESH), new Error("offline"), Response.json({ code: "github_sync_unavailable", class: "infra", message: "GitHub sync is unavailable" }, { status: 503 })])
  const seam = createGitHubSyncSeam({ http: h.http, pollMs: 60_000 })
  const stop = seam.snapshots.subscribe(() => {})
  try {
    await waitFor(() => seam.snapshots.get() !== undefined)
    await seam.read()
    expect(seam.snapshots.get()).toEqual(FRESH)
    await seam.read()
    expect(seam.snapshots.get()).toBeUndefined()
    h.answers.splice(0, h.answers.length, new Response("not found", { status: 404 }))
    await seam.read()
    expect(seam.snapshots.get()).toBeUndefined()
  } finally { stop(); seam.dispose() }
  const none = createGitHubSyncSeam({})
  expect(none.snapshots.subscribe(() => {})).toBeFunction()
  expect(none.snapshots.get()).toBeUndefined()
  expect(await none.retry()).toBeUndefined()
})

test("Retry asks the sync once per press, keyed, then re-reads; it answers undefined where no sync is served", async () => {
  const h = host([Response.json(STALE)])
  const seam = createGitHubSyncSeam({ http: h.http, pollMs: 60_000 })
  try {
    expect(await seam.retry()).toBeUndefined()
    expect(h.calls).toEqual([])
    const stop = seam.snapshots.subscribe(() => {})
    await waitFor(() => seam.snapshots.get() !== undefined)
    h.answers.splice(0, h.answers.length, Response.json({ state: "accepted" }, { status: 202 }), Response.json(FRESH))
    expect(await seam.retry()).toEqual({ value: "Sync requested" })
    await waitFor(() => seam.snapshots.get()?.state === "fresh")
    const posts = h.calls.filter(call => call.init?.method === "POST")
    expect(posts).toHaveLength(1)
    const key = new Headers(posts[0]!.init?.headers).get("Idempotency-Key")
    expect(key).toBeTruthy()
    h.answers.splice(0, h.answers.length, Response.json({ code: "github_sync_unavailable" }, { status: 503 }))
    expect(await seam.retry()).toBe("Sync retry failed")
    stop()
  } finally { seam.dispose() }
})

test("an answer from before dispose or a newer read never publishes", async () => {
  let release!: (response: Response) => void
  const pending = new Promise<Response>(done => { release = done })
  const seam = createGitHubSyncSeam({ http: () => pending, pollMs: 60_000 })
  const stop = seam.snapshots.subscribe(() => {})
  seam.dispose()
  release(Response.json(FRESH))
  await new Promise(done => setTimeout(done, 5))
  expect(seam.snapshots.get()).toBeUndefined()
  stop()
})
