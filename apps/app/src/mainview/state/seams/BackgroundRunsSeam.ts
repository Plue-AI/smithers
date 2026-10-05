import { HomeCardSchema, type HomeCard } from "@smthrs/rpc/HomeCard"
import { captureCloudOwner, type SeamContext } from "./SeamContext"
import { randomUuid } from "../../runtime/RandomUuid"

type Rows = HomeCard["background_runs"]
export interface BackgroundRunSnapshots {
  readonly get: () => Rows | undefined
  readonly subscribe: (listener: () => void) => () => void
}
/** Home's failed runs share one read loop; source ids deduplicate retries on the server after reload. */
export const createBackgroundRunsSeam = (ctx: SeamContext, options: { readonly ready: boolean; readonly pollMs?: number }) => {
  let rows: Rows | undefined
  let disposed = false, reading = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>(), pending = new Set<string>(), aborts = new Set<AbortController>()
  const publish = (next: Rows | undefined) => { rows = next; for (const listener of listeners) listener() }
  const read = async () => {
    if (disposed || reading || !options.ready) return
    const current = captureCloudOwner(ctx, false), abort = new AbortController()
    reading = true; aborts.add(abort)
    try {
      const response = await ctx.http(`${ctx.baseUrl}/api/runs`, { credentials: "include", signal: abort.signal })
      if (disposed || !current()) return
      if (response.status === 401 || response.status === 403) { publish(undefined); return }
      if (!response.ok) return
      const body: unknown = await response.json()
      // Actions are derived from state, never trusted from an API response.
      const parsed = HomeCardSchema.shape.background_runs.parse(Array.isArray(body) ? body.map(row => ({ ...row, actions: [] })) : body)
      if (!disposed && current()) publish(parsed.map(row => ({ ...row, actions: row.state === "failed" ? [
        { tag: "background.retry", label: "Retry", args: { id: row.id } }, { tag: "background.dismiss", label: "Dismiss", args: { id: row.id } }
      ] : [] })))
    } catch (error) { if (!disposed && !abort.signal.aborted) ctx.report?.("background.read", error) }
    finally { reading = false; aborts.delete(abort) }
  }
  const poll = () => {
    if (disposed || !listeners.size || !options.ready || timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; void read().finally(poll) }, options.pollMs ?? 2000)
  }
  const snapshots: BackgroundRunSnapshots = {
    get: () => rows,
    subscribe: listener => {
      listeners.add(listener)
      if (listeners.size === 1) { void read().finally(poll) }
      return () => { listeners.delete(listener); if (!listeners.size && timer !== undefined) { clearTimeout(timer); timer = undefined } }
    }
  }
  /** Return immediately: HTTP persistence and the subsequent source read run in the shared toast stack. */
  const control = (id: string, op: "retry" | "dismiss"): string | { readonly value: string } => {
    if (!options.ready || disposed) return "Background runs unavailable"
    const key = `${op}:${id}`, title = op === "retry" ? "Retry background run" : "Dismiss background run"
    if (pending.has(key)) return { value: "Requested" }
    pending.add(key)
    const current = captureCloudOwner(ctx, false), abort = new AbortController(); aborts.add(abort)
    const run = async () => {
      const response = await ctx.http(`${ctx.baseUrl}/api/runs/${encodeURIComponent(id)}`, { method: "POST", credentials: "include", signal: abort.signal,
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUuid() }, body: JSON.stringify({ op }) })
      if (!response.ok) throw new Error(op === "retry" ? "Retry failed" : "Dismiss failed")
      if (disposed || !current()) return
      await read()
      if (op === "retry") {
        while (!disposed && current()) {
          const observed = await ctx.http(`${ctx.baseUrl}/api/runs/${encodeURIComponent(id)}`, { credentials: "include", signal: abort.signal })
          if (!observed.ok) throw new Error("Run unavailable")
          const status = await observed.json() as { state?: string; detail?: string }
          if (status.state === "succeeded") return
          if (status.state === "failed" || status.state === "cancelled") throw new Error(status.detail || "Run failed")
          await new Promise<void>((resolve, reject) => {
            const done = () => { clearTimeout(wait); abort.signal.removeEventListener("abort", cancel); resolve() }
            const cancel = () => { clearTimeout(wait); abort.signal.removeEventListener("abort", cancel); reject(new Error("Cancelled")) }
            const wait = setTimeout(done, options.pollMs ?? 2000)
            abort.signal.addEventListener("abort", cancel, { once: true })
          })
        }
      }
    }
    const work = ctx.withToast ? ctx.withToast(`background.${key}`, title, op === "retry" ? "Background run finished" : "Dismissed", run, false, current) : run()
    void work.catch(error => { if (!disposed && !abort.signal.aborted) ctx.report?.("background.control", error) })
      .finally(() => { pending.delete(key); aborts.delete(abort) })
    return { value: "Requested" }
  }
  const dispose = () => { disposed = true; if (timer !== undefined) clearTimeout(timer); timer = undefined; for (const abort of aborts) abort.abort(); aborts.clear(); listeners.clear(); rows = undefined }
  // A retry toast is durable app state. After reload, repeat its source-id
  // request to recover an ambiguous admission, then observe the same child.
  // The server's receipt makes this safe even if the old POST committed.
  queueMicrotask(() => {
    if (!options.ready || disposed) return
    for (const toast of ctx.store.collections.toasts.values()) {
      if (toast.status === "running" && toast.key.startsWith("background.retry:")) control(toast.key.slice("background.retry:".length), "retry")
    }
  })
  return { snapshots, read, control, dispose }
}
export type BackgroundRunsSeam = ReturnType<typeof createBackgroundRunsSeam>
