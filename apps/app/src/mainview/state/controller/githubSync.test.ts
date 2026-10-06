import { expect, test } from "bun:test"
import { createGitHubSyncRetry } from "./githubSync"
import { createGitHubSyncSeam } from "../seams/GitHubSyncSeam"
import type { ControllerContext } from "./context"
import type { Session } from "../AppState"
import { waitFor } from "../TestFixtures"

for (const settlement of ["fresh", "permission", "not_installed", "admission"] as const) {
  test(`Retry acknowledges before admission and settles only on ${settlement}`, async () => {
    let health: Record<string, unknown> = { state: "stale", last_success_at: "2026-10-06T00:00:00Z" }
    let release!: (response: Response) => void
    let posts = 0
    const seam = createGitHubSyncSeam({ pollMs: 60_000, http: async (_path, init) => {
      if (init?.method !== "POST") return Response.json(health)
      posts++
      return new Promise<Response>(resolve => { release = resolve })
    } })
    const receipts: unknown[] = []
    const finalizers: Array<() => void> = []
    let request: Session["githubSyncRequest"]
    const ctx = { disposed: false, accountOwner: () => "owner",
      store: { session: () => ({ githubSyncRequest: request }), dispatch: (transition: { request: Session["githubSyncRequest"] }) => { request = transition.request; return { isPersisted: { promise: Promise.resolve() } } } }, onDispose: (finalizer: () => void) => { finalizers.push(finalizer) },
      withToast: async (_key: string, _title: string, _done: string, work: () => Promise<unknown>) => {
        const result = await work(); receipts.push(result); return result
      }
    } as unknown as ControllerContext
    const { retry } = createGitHubSyncRetry(ctx, seam)
    try {
      await seam.read()
      expect(await retry()).toEqual({ value: "Sync requested" })
      expect(await retry()).toEqual({ value: "Sync requested" })
      expect(posts).toBe(1)
      expect(receipts).toEqual([])
      release(new Response(null, { status: settlement === "admission" ? 503 : 202 }))
      if (settlement === "admission") {
        await waitFor(() => receipts.length === 1)
        expect(receipts).toEqual(["Sync retry failed"])
      } else {
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(receipts).toEqual([]) // Launch acknowledgement is not sync completion.
        health = settlement === "fresh"
          ? { state: "fresh", last_success_at: "2026-10-06T00:01:00Z" }
          : { ...health, state: "refused", cause: settlement }
        await seam.read()
        await waitFor(() => receipts.length === 1)
        expect(receipts).toEqual([settlement === "fresh" ? true : settlement === "permission" ? "GitHub App permission missing" : "GitHub App not installed"])
      }
      expect(await retry()).toEqual({ value: "Sync requested" })
      expect(posts).toBe(2)
      release(new Response(null, { status: 503 }))
      await waitFor(() => receipts.length === 2)
    } finally { for (const close of finalizers) close(); seam.dispose() }
  })
}

for (const phase of ["requested", "running"] as const) {
  test(`reload reconnects a ${phase} Retry without replacing its admission key`, async () => {
    let request: Session["githubSyncRequest"] = { id: "saved-key", owner: "owner", phase, lastSuccessAt: "2026-10-06T00:00:00Z" }
    let health = { state: "stale", last_success_at: "2026-10-06T00:00:00Z" }
    const keys: string[] = [], receipts: unknown[] = [], finalizers: Array<() => void> = []
    const seam = createGitHubSyncSeam({ pollMs: 60_000, http: async (_path, init) => {
      if (init?.method === "POST") { keys.push(new Headers(init.headers).get("Idempotency-Key")!); return new Response(null, { status: 202 }) }
      return Response.json(health)
    } })
    const ctx = { disposed: false, accountOwner: () => "owner",
      store: { session: () => ({ githubSyncRequest: request }), dispatch: (transition: { request: Session["githubSyncRequest"] }) => {
        request = transition.request; return { isPersisted: { promise: Promise.resolve() } }
      } }, onDispose: (close: () => void) => { finalizers.push(close) },
      withToast: async (_key: string, _title: string, _done: string, work: () => Promise<unknown>) => { const result = await work(); receipts.push(result); return result }
    } as unknown as ControllerContext
    try {
      const retry = createGitHubSyncRetry(ctx, seam)
      retry.resume()
      await waitFor(() => seam.snapshots.get() !== undefined && request?.phase === "running")
      expect(keys).toEqual(phase === "requested" ? ["saved-key"] : [])
      expect(receipts).toEqual([])
      health = { state: "fresh", last_success_at: "2026-10-06T00:01:00Z" }
      await seam.read()
      await waitFor(() => receipts.length === 1)
      expect(receipts).toEqual([true])
      expect(request).toBeUndefined()
    } finally { for (const close of finalizers) close(); seam.dispose() }
  })
}

test("loss of the sync provider during persistence remains a visible retryable failure", async () => {
  let reads = 0, posts = 0
  const seam = createGitHubSyncSeam({ http: async (_path, init) => {
    if (init?.method === "POST") posts++
    return ++reads === 1 ? Response.json({ state: "stale", last_success_at: null }) : new Response(null, { status: 503 })
  } })
  let request: Session["githubSyncRequest"]
  const receipts: unknown[] = []
  const ctx = { disposed: false, accountOwner: () => "owner", onDispose: () => {},
    store: { session: () => ({ githubSyncRequest: request }), dispatch: (transition: { request: Session["githubSyncRequest"] }) => {
      request = transition.request
      return { isPersisted: { promise: request?.phase === "requested" ? seam.read() : Promise.resolve() } }
    } },
    withToast: async (_key: string, _title: string, _done: string, work: () => Promise<unknown>) => { receipts.push(await work()) }
  } as unknown as ControllerContext
  try {
    await seam.read()
    expect(await createGitHubSyncRetry(ctx, seam).retry()).toEqual({ value: "Sync requested" })
    await waitFor(() => receipts.length === 1)
    expect(receipts).toEqual(["GitHub sync is unavailable"])
    expect(request?.phase).toBe("failed")
    expect(posts).toBe(0)
  } finally { seam.dispose() }
})
